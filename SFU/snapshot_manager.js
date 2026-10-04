// Snapshot subsystem.
//
// Gives every hosted stream a low frame-rate JPEG preview so the stream grid
// can render a live thumbnail per tile.
//
// For each tenant we open a mediasoup PlainTransport on the shared router,
// consume the video producer, and point that transport at a local UDP port
// where a vendored ffmpeg is listening. ffmpeg decodes the stream, a select
// filter keeps one frame every `refreshSeconds` starting with the first one it
// can decode, and each of those overwrites a single JPEG. The JPEGs are then
// served over HTTP at /snapshots/<sfuId>.jpg.
//
// Decoding is the expensive part, so the number of concurrently running ffmpeg
// processes is capped. Streams beyond the cap wait in a queue ("pending") and
// are served a 404 until a slot frees, which the grid renders as a placeholder.
//
// A simulcast producer forwards a spatial layer only once one has been
// selected. mediasoup leaves that choice to the transport's bitrate allocator
// whenever it decided to manage the consumer's bitrate, and that allocator
// needs receiver feedback to have anything to hand out. So the snapshot
// consumer is negotiated with capabilities that keep the bitrate under
// mediasoup's own control (see UNMANAGED_HEADER_EXTENSIONS), names the lowest
// layer explicitly, and asks the streamer for a key frame, which is the other
// thing a decoder needs before it can emit anything. Both are re-issued while
// a worker is producing nothing, and a worker that still produces nothing is
// recycled.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// How often a running worker is checked on, and how many consecutive checks may
// find no frame at all before the worker is recycled. The window in which the
// last frame is considered current is derived from the configured refresh
// interval instead of being fixed: it has to exceed one full interval, and stay
// short enough that a worker which quietly stopped decoding is nudged rather
// than left sitting on a stale frame.
const HEALTH_CHECK_MS = 5000;

// A worker that has never written a frame is allowed a much longer run-up than
// one that has: ffmpeg writes nothing at all until it has probed enough of the
// stream to recognise it and has decoded a key frame, and the consumer only
// forwards the producer's lowest layer, which can be slow to supply one. A
// worker that has written a frame and then goes quiet is never recycled at all
// -- the last frame stays on disk as the preview, and the filter keeps looking
// for a new one until the stream returns.
const FIRST_FRAME_CHECK_LIMIT = 12;

// Consecutive failed workers before the preview is reported as broken rather
// than as still waiting for video.
const MAX_EMPTY_CHECKS = 3;

// ffmpeg is chatty about RTP: every gap in the sequence numbers is reported at
// warning level, which drowns out the SFU's own logging for no benefit. Raise
// this through the snapshots config when a stream's preview is not appearing.
const DEFAULT_FFMPEG_LOG_LEVEL = 'error';

// A JPEG starts with SOI and ends with EOI. ffmpeg writes the frame with a
// single write(), so a partial file is identifiable by its missing trailer.
function isCompleteJpeg(data) {
    return data.length >= 4
        && data[0] === 0xff && data[1] === 0xd8
        && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9;
}

const RTPMAP_BY_MIME = {
    'video/H264': 'H264',
    'video/H265': 'H265',
    'video/VP8': 'VP8',
    'video/VP9': 'VP9',
    'video/AV1': 'AV1'
};

// mediasoup decides, per consumer, whether to manage the consumer's bitrate
// itself, and it decides that from the capabilities the consumer is negotiated
// with. Offering transport-wide-cc (or abs-send-time alongside goog-remb)
// makes it build a congestion control client on the transport and take over
// spatial layer selection. That allocator's available bitrate comes from
// receiver feedback, and ffmpeg is a receive-only sink that never sends any, so
// it stays at zero: no layer is ever selected and a simulcast stream forwards
// nothing at all. A snapshot consumer always wants one fixed layer, so it is
// negotiated without those extensions and keeps layer selection local, where
// setPreferredLayers() is enough.
const UNMANAGED_HEADER_EXTENSIONS = [
    'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
    'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time'
];

function snapshotRtpCapabilities(routerCapabilities) {
    return {
        ...routerCapabilities,
        headerExtensions: (routerCapabilities.headerExtensions || []).filter(
            extension => !UNMANAGED_HEADER_EXTENSIONS.includes(extension.uri))
    };
}

function resolveFfmpegPath(configured) {
    if (configured) {
        return configured;
    }

    const candidates = process.platform === 'win32'
        ? ['win64-x64/ffmpeg.exe', 'win64/ffmpeg.exe']
        : ['linux-x64/ffmpeg', 'linux/ffmpeg'];

    for (const candidate of candidates) {
        const full = path.join(__dirname, '..', 'Extras', 'ffmpeg', candidate);
        if (fs.existsSync(full)) {
            return full;
        }
    }

    // Nothing vendored: fall back to whatever is on PATH.
    return 'ffmpeg';
}

function formatFmtp(parameters) {
    if (!parameters) {
        return null;
    }
    const parts = [];
    for (const [key, value] of Object.entries(parameters)) {
        parts.push(`${key}=${value}`);
    }
    return parts.length > 0 ? parts.join(';') : null;
}

// Minimal SDP describing the consumer's RTP stream. ffmpeg reads this to learn
// which UDP port to listen on and how to depacketise what arrives.
function buildSdp(rtpParameters, listenPort) {
    const codec = rtpParameters.codecs.find(entry => RTPMAP_BY_MIME[entry.mimeType]);
    if (!codec) {
        return null;
    }

    const encoding = rtpParameters.encodings && rtpParameters.encodings[0];
    if (!encoding || !encoding.ssrc) {
        return null;
    }

    const lines = [
        'v=0',
        'o=- 0 0 IN IP4 127.0.0.1',
        's=sfu-snapshot',
        'c=IN IP4 127.0.0.1',
        't=0 0',
        `m=video ${listenPort} RTP/AVP ${codec.payloadType}`,
        `a=rtpmap:${codec.payloadType} ${RTPMAP_BY_MIME[codec.mimeType]}/${codec.clockRate}`
    ];

    const fmtp = formatFmtp(codec.parameters);
    if (fmtp) {
        lines.push(`a=fmtp:${codec.payloadType} ${fmtp}`);
    }
    lines.push(`a=ssrc:${encoding.ssrc} cname:${rtpParameters.rtcp.cname}`);
    lines.push('a=rtcp-mux');

    return lines.join('\n') + '\n';
}

class SnapshotManager {
    constructor(router, options) {
        this.router = router;
        // Guard the values that get interpolated into ffmpeg's command line, so
        // a hand-built options object cannot produce an invalid one.
        this.options = {
            ...options,
            refreshSeconds: Number(options.refreshSeconds) > 0 ? Number(options.refreshSeconds) : 60,
            ffmpegLogLevel: options.ffmpegLogLevel || DEFAULT_FFMPEG_LOG_LEVEL
        };
        this.outputDir = options.outputDir;
        this.ffmpegPath = resolveFfmpegPath(options.ffmpegPath);
        this.rtpCapabilities = snapshotRtpCapabilities(router.rtpCapabilities);
        this.staleMs = this.options.refreshSeconds * 1000 + HEALTH_CHECK_MS * 2;

        // sfuId -> record. A record exists as soon as a stream is registered,
        // but `child` is only set once it has been given a decode slot.
        this.records = new Map();
        this.pending = [];
        this.usedPorts = new Set();
        this.httpServer = null;
        this.stopped = false;
        this.streamInfoProvider = null;

        fs.mkdirSync(this.outputDir, { recursive: true });
    }

    // The server hands over the per-stream facts the snapshot subsystem cannot
    // know for itself, currently the player count and how long the feed has
    // been coming in.
    setStreamInfoProvider(provider) {
        this.streamInfoProvider = provider;
    }

    describeState(record) {
        if (record.child) {
            return 'running';
        }
        // Queued behind the decode cap, or waiting to be restarted. Only a
        // stream whose workers have repeatedly produced nothing is an error.
        return record.failures >= MAX_EMPTY_CHECKS ? 'error' : 'pending';
    }

    // Called once the streamer's ICE is up, so media is actually flowing.
    async addStream(sfuId, producers) {
        if (this.stopped || this.records.has(sfuId)) {
            return;
        }

        const names = producers.map(producer => `${producer.kind}/${producer.type}`).join(', ');

        const videoProducer = producers.find(producer => producer.kind === 'video');
        if (!videoProducer) {
            // Worth saying out loud: an audio-only stream is served no snapshot
            // and would otherwise just 404 with no explanation.
            console.warn('[%s] No snapshot: the stream has no video producer (has: %s)', sfuId, names || 'none');
            return;
        }

        if (!buildSdp(videoProducer.rtpParameters, 0)) {
            const mimeTypes = videoProducer.rtpParameters.codecs.map(codec => codec.mimeType).join(', ');
            console.warn('[%s] No snapshot: unsupported video codec (%s)', sfuId, mimeTypes || 'none');
            return;
        }

        const record = {
            sfuId,
            producers,
            producerId: videoProducer.id,
            transport: null,
            consumer: null,
            child: null,
            sdpPath: path.join(this.outputDir, `${this.safeName(sfuId)}.sdp`),
            imagePath: path.join(this.outputDir, `${this.safeName(sfuId)}.jpg`),
            port: null,
            watchdog: null,
            emptyChecks: 0,
            failures: 0,
            statsLogged: false,
            lastStderr: null,
            // Last whole JPEG read back off disk, served in place of a partial
            // write. Cleared implicitly when the worker is recycled.
            cachedImage: null,
            cachedImageAt: 0,
            cachedImageMtimeMs: -1,
            restartTimer: null,
            restartDelayMs: 1000,
            shuttingDown: false
        };
        this.records.set(sfuId, record);

        await this.startRecord(record);
    }

    safeName(sfuId) {
        return sfuId.replace(/[^A-Za-z0-9._-]/g, '_');
    }

    async startRecord(record) {
        if (this.stopped || record.shuttingDown) {
            return;
        }

        if (this.activeCount() >= this.options.maxConcurrent) {
            this.pending.push(record.sfuId);
            return;
        }

        try {
            await this.spawnWorker(record);
        } catch (err) {
            console.error('[%s] Snapshot setup failed: %s', record.sfuId, err);
            await this.releaseRecord(record);
            this.scheduleRestart(record);
        }
    }

    activeCount() {
        let count = 0;
        for (const record of this.records.values()) {
            if (record.child) {
                count++;
            }
        }
        return count;
    }

    async spawnWorker(record) {
        // Drop any transport left over from a previous attempt so mediasoup
        // stops feeding the dead UDP port.
        await this.teardownMedia(record);

        const port = this.allocatePort();
        if (port === null) {
            throw new Error('no free UDP port available for snapshot worker');
        }

        const producer = record.producers.find(entry => entry.id === record.producerId);
        if (!producer) {
            this.releasePort(port);
            throw new Error('video producer is gone');
        }

        // The consumer must exist before the SDP is written: mediasoup assigns
        // its own SSRC to the outgoing stream, and ffmpeg drops every packet
        // whose SSRC does not match the a=ssrc line it was given.
        let consumer;
        try {
            const created = await this.createConsumer(record, producer);
            record.transport = created.transport;
            record.consumer = created.consumer;
            consumer = created.consumer;

            const sdp = buildSdp(consumer.rtpParameters, port);
            if (!sdp) {
                throw new Error('producer codec is not supported for snapshots');
            }
            fs.writeFileSync(record.sdpPath, sdp, 'utf8');
        } catch (err) {
            this.releasePort(port);
            throw err;
        }

        // Start ffmpeg first so its socket is bound before the consumer is
        // resumed. Otherwise the first packets are dropped. ffmpeg parses the
        // SDP before any RTP arrives and simply blocks on the socket until it
        // does, so the probe window only needs to be long enough to see the
        // stream.
        //
        // The refresh interval is applied with select rather than with the fps
        // filter. `fps=1/60` lays its output timestamps out on a grid starting
        // at the first input timestamp, so its very first frame is not due
        // until the stream has run for a whole interval -- a minute of nothing
        // before the preview appears at all. `select` takes the first frame as
        // soon as one is decodable and then one per interval, which puts a
        // preview on screen within seconds of a stream going live.
        //
        // Skipping everything but key frames with -skip_frame nokey would be
        // cheaper still, but a stream with a long GOP would then refresh its
        // preview once a minute, or never. The consumer only forwards the
        // producer's lowest temporal layer, so a full decode stays affordable.
        const child = spawn(this.ffmpegPath, [
            '-hide_banner', '-nostdin', '-loglevel', this.options.ffmpegLogLevel,
            '-protocol_whitelist', 'file,udp,rtp',
            '-fflags', '+genpts',
            '-analyzeduration', '5M', '-probesize', '5M',
            '-i', record.sdpPath,
            '-an',
            '-vf', `select='isnan(prev_selected_t)+gte(t-prev_selected_t,${this.options.refreshSeconds})',`
                + `scale=${this.options.width}:-2`,
            '-fps_mode', 'vfr',
            '-q:v', String(this.options.quality),
            '-threads', '1',
            '-f', 'image2', '-update', '1', '-y',
            record.imagePath
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        record.child = child;
        record.port = port;

        child.stderr.on('data', chunk => {
            for (const line of chunk.toString().split('\n')) {
                // Addresses vary per message, so a complaint repeated once per
                // frame never compares equal as-is. ffmpeg prints them both as
                // `0x...` and as a bare hex address after an `@`. Blanking those
                // out is what makes the repeat suppression actually suppress.
                const text = line.trim()
                    .replace(/0x[0-9a-f]+/gi, '0x...')
                    .replace(/@ [0-9a-f]{6,}/gi, '@ ...');
                // Repeated identical errors say nothing new, and RTP trouble
                // tends to repeat once per frame.
                if (!text || text === record.lastStderr) {
                    continue;
                }
                record.lastStderr = text;
                console.error('[%s] ffmpeg: %s', record.sfuId, text);
            }
        });

        // A spawn failure emits 'error' without a following 'exit', so both
        // handlers funnel through one guard to keep the slot accounting honest.
        let finished = false;
        const finish = (reason, code, signal) => {
            if (finished) {
                return;
            }
            finished = true;
            record.child = null;
            record.port = null;
            this.releasePort(port);
            this.pumpQueue();
            if (this.stopped || record.shuttingDown) {
                return;
            }
            console.log('[%s] Snapshot worker %s (code=%s signal=%s), restarting', record.sfuId, reason, code, signal);
            this.scheduleRestart(record);
        };

        child.on('exit', (code, signal) => finish('exited', code, signal));

        child.on('error', err => {
            console.error('[%s] Failed to launch ffmpeg (%s): %s', record.sfuId, this.ffmpegPath, err.message);
            finish('failed to launch', null, null);
        });

        // Give ffmpeg a moment to bind its UDP socket.
        await new Promise(resolve => setTimeout(resolve, 500));
        if (this.stopped || record.shuttingDown || record.child !== child) {
            return;
        }

        const { transport } = record;
        await transport.connect({ ip: '127.0.0.1', port });
        await consumer.resume();

        // Order matters: mediasoup ignores a preferred-layer change while the
        // consumer is paused. See this.nudge() for why a simulcast stream needs
        // one at all.
        if (consumer.type === 'simulcast' || consumer.type === 'svc') {
            try {
                await consumer.setPreferredLayers({ spatialLayer: 0, temporalLayer: 0 });
            } catch (err) {
                console.error('[%s] Could not select the snapshot layer: %s', record.sfuId, err.message);
            }
        }

        await this.nudge(record);
        record.emptyChecks = 0;
        record.statsLogged = false;
        record.watchdog = setTimeout(() => this.checkHealth(record, child), HEALTH_CHECK_MS);

        console.log('[%s] Snapshot worker running (udp %s -> %s)', record.sfuId, port, record.imagePath);
    }

    // Asks the streamer for a key frame. A worker decoding only key frames
    // cannot emit anything until one arrives, which can be a whole GOP away,
    // and the request is simply lost if the streamer is not encoding yet.
    async nudge(record) {
        try {
            await record.consumer.requestKeyFrame();
        } catch (err) {
            // The consumer is gone if the stream disconnected mid-flight.
        }
    }

    // Keeps the preview honest once a worker is up: a stream that goes quiet
    // leaves a stale frame behind, and a worker that never decoded anything at
    // all is better recycled than left running.
    async checkHealth(record, child) {
        if (this.stopped || record.shuttingDown || record.child !== child) {
            return;
        }

        record.watchdog = null;

        let ageMs = null;
        try {
            ageMs = Date.now() - fs.statSync(record.imagePath).mtimeMs;
        } catch (err) {
            ageMs = null;
        }

        // Pick up the frame this tick for the index and for any HTTP read that
        // lands before the next tick.
        this.refreshCachedImage(record);

        if (ageMs !== null && ageMs < this.staleMs) {
            // The worker works. Start over, so the next hiccup gets a quick
            // restart rather than inheriting an old backoff.
            record.emptyChecks = 0;
            record.failures = 0;
            record.restartDelayMs = 1000;
        } else if (ageMs === null && ++record.emptyChecks >= FIRST_FRAME_CHECK_LIMIT) {
            // Nothing has ever come out of this worker. Recycling it is the only
            // remaining lever, and `failures` backs the restarts off so a stream
            // that simply has no video does not get hammered.
            record.failures++;
            if (record.failures <= MAX_EMPTY_CHECKS) {
                console.warn('[%s] Snapshot worker decoded no frame in %s attempts, restarting it',
                    record.sfuId, record.emptyChecks);
                await this.reportStats(record);
            }
            child.kill();
            return;
        } else {
            await this.nudge(record);
        }

        record.watchdog = setTimeout(() => this.checkHealth(record, child), HEALTH_CHECK_MS);
    }

    // How many packets mediasoup actually handed to this consumer. Zero rules
    // out the decoder and points at layer selection; non-zero points at ffmpeg.
    // Reported once per worker, because the answer rarely changes.
    async reportStats(record) {
        if (record.statsLogged) {
            return;
        }
        record.statsLogged = true;

        try {
            const stats = await record.consumer.getStats();
            const packets = stats.reduce((total, entry) => total + (entry.packetCount || 0), 0);
            const bytes = stats.reduce((total, entry) => total + (entry.byteCount || 0), 0);
            console.warn('[%s] Consumer was forwarded %s packets / %s bytes', record.sfuId, packets, bytes);
        } catch (err) {
            console.error('[%s] Could not read consumer stats: %s', record.sfuId, err.message);
        }
    }

    async createConsumer(record, producer) {
        // ffmpeg only ever receives from this transport, so mediasoup is told
        // the destination explicitly and never has to guess it from inbound
        // traffic.
        const transport = await this.router.createPlainTransport({
            listenIp: { ip: '127.0.0.1', announcedIp: null },
            rtcpMux: true,
            comedia: false,
            enableSctp: false
        });

        const consumer = await transport.consume({
            producerId: producer.id,
            rtpCapabilities: this.rtpCapabilities,
            paused: true
        });

        return { transport, consumer };
    }

    scheduleRestart(record) {
        if (this.stopped || record.shuttingDown || record.restartTimer) {
            return;
        }

        const delay = record.restartDelayMs;
        record.restartDelayMs = Math.min(delay * 2, 30000);
        record.restartTimer = setTimeout(() => {
            record.restartTimer = null;
            this.startRecord(record).catch(err => {
                console.error('[%s] Snapshot restart failed: %s', record.sfuId, err);
            });
        }, delay);
    }

    // Frees the decode slot, leaving the record in place so a queued stream can
    // take the slot. The mediasoup side is torn down because it is cheap to
    // rebuild and would otherwise keep feeding a dead port.
    async releaseRecord(record) {
        if (record.watchdog) {
            clearTimeout(record.watchdog);
            record.watchdog = null;
        }
        if (record.restartTimer) {
            clearTimeout(record.restartTimer);
            record.restartTimer = null;
        }
        await this.teardownMedia(record);
        if (record.child) {
            const child = record.child;
            record.child = null;
            const exited = new Promise(resolve => {
                child.once('exit', resolve);
                setTimeout(resolve, 2000);
            });
            child.kill();
            // ffmpeg holds the SDP open on Windows, so the caller can only
            // unlink it once the process is really gone.
            await exited;
        }
        if (record.port !== null) {
            this.releasePort(record.port);
            record.port = null;
        }
    }

    async teardownMedia(record) {
        if (record.consumer) {
            try {
                record.consumer.close();
            } catch (err) {
                console.error('[%s] Error closing snapshot consumer: %s', record.sfuId, err);
            }
            record.consumer = null;
        }
        if (record.transport) {
            try {
                record.transport.close();
            } catch (err) {
                console.error('[%s] Error closing snapshot transport: %s', record.sfuId, err);
            }
            record.transport = null;
        }
    }

    pumpQueue() {
        while (!this.stopped && this.pending.length > 0 && this.activeCount() < this.options.maxConcurrent) {
            const sfuId = this.pending.shift();
            const record = this.records.get(sfuId);
            if (!record || record.child) {
                continue;
            }
            this.startRecord(record).catch(err => {
                console.error('[%s] Queued snapshot start failed: %s', sfuId, err);
            });
        }
    }

    removeStream(sfuId) {
        const record = this.records.get(sfuId);
        if (!record) {
            return;
        }

        record.shuttingDown = true;
        this.records.delete(sfuId);
        this.pending = this.pending.filter(entry => entry !== sfuId);

        void this.releaseRecord(record).then(() => {
            this.removeFile(record.imagePath);
            this.removeFile(record.sdpPath);
            this.pumpQueue();
        });
    }

    removeFile(filePath) {
        try {
            fs.rmSync(filePath, { force: true });
        } catch (err) {
            console.error('Could not remove %s: %s', filePath, err.message);
        }
    }

    allocatePort() {
        for (let offset = 0; offset < 200; offset++) {
            const port = this.options.portRangeStart + offset;
            if (!this.usedPorts.has(port)) {
                this.usedPorts.add(port);
                return port;
            }
        }
        return null;
    }

    releasePort(port) {
        this.usedPorts.delete(port);
    }

    // --- HTTP -----------------------------------------------------------------

    // Reads the frame ffmpeg is writing, if it is a whole JPEG. ffmpeg rewrites
    // a single file in place, so a read landing mid-write comes back truncated;
    // the last whole frame is therefore kept per stream, and the age the index
    // reports is the mtime of that frame rather than of a partial write.
    refreshCachedImage(record) {
        let stat;
        try {
            stat = fs.statSync(record.imagePath);
        } catch (err) {
            return record.cachedImage;
        }

        if (stat.mtimeMs === record.cachedImageMtimeMs) {
            return record.cachedImage;
        }

        let data;
        try {
            data = fs.readFileSync(record.imagePath);
        } catch (err) {
            return record.cachedImage;
        }

        if (!isCompleteJpeg(data)) {
            return record.cachedImage;
        }

        record.cachedImage = data;
        record.cachedImageAt = stat.mtimeMs;
        record.cachedImageMtimeMs = stat.mtimeMs;
        return data;
    }

    serveImage(res, record) {
        if (!record) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('no such stream');
            return;
        }

        const data = this.refreshCachedImage(record);
        if (!data) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('no snapshot yet');
            return;
        }

        this.sendImage(res, data, Date.now() - record.cachedImageAt);
    }

    sendImage(res, data, ageMs) {
        res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': data.length,
            'Cache-Control': 'no-store',
            'X-Snapshot-Age-Ms': String(ageMs)
        });
        res.end(data);
    }

    handleRequest(req, res) {
        const url = new URL(req.url, 'http://localhost');
        const segments = url.pathname.split('/').filter(segment => segment.length > 0);

        if (req.method !== 'GET') {
            res.writeHead(405, { 'Content-Type': 'text/plain' });
            res.end('method not allowed');
            return;
        }

        // Machine readable index of which streams currently have a snapshot, how
        // old that snapshot is, and how often snapshots are written. The grid uses
        // the ages to reload a tile exactly when a new frame has landed instead of
        // guessing at the cadence.
        if (url.pathname === '/snapshots') {
            const refreshSeconds = this.options.refreshSeconds;
            const snapshots = Array.from(this.records.values()).map(record => {
                this.refreshCachedImage(record);
                const info = this.streamInfoProvider ? this.streamInfoProvider(record.sfuId) : null;
                return {
                    sfuId: record.sfuId,
                    state: this.describeState(record),
                    hasImage: record.cachedImage !== null,
                    ageMs: record.cachedImage ? Date.now() - record.cachedImageAt : null,
                    players: info ? info.players : null,
                    sinceMs: info ? info.sinceMs : null
                };
            });
            const payload = JSON.stringify({ refreshSeconds, snapshots });
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Access-Control-Allow-Origin': '*'
            });
            res.end(payload);
            return;
        }

        if (segments.length === 2 && segments[0] === 'snapshots') {
            const sfuId = decodeURIComponent(segments[1]).replace(/\.jpg$/i, '');
            this.serveImage(res, this.records.get(sfuId));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
    }

    startHttp() {
        this.httpServer = http.createServer((req, res) => {
            try {
                this.handleRequest(req, res);
            } catch (err) {
                console.error('Snapshot API error:', err);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('error');
            }
        });

        this.httpServer.on('error', err => {
            console.error('Snapshot API server error:', err);
        });

        this.httpServer.listen(this.options.httpPort, this.options.httpHost, () => {
            console.log('Snapshot API listening on %s:%s (ffmpeg: %s)', this.options.httpHost, this.options.httpPort, this.ffmpegPath);
        });
    }

    stop() {
        this.stopped = true;
        for (const record of Array.from(this.records.values())) {
            record.shuttingDown = true;
            if (record.restartTimer) {
                clearTimeout(record.restartTimer);
                record.restartTimer = null;
            }
            void this.releaseRecord(record);
        }
        this.records.clear();
        this.pending = [];
        if (this.httpServer) {
            this.httpServer.close();
            this.httpServer = null;
        }
    }
}

module.exports = { SnapshotManager, resolveFfmpegPath };
