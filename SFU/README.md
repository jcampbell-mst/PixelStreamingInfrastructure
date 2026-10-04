# Pixel Streaming Selective Forwarding Unit

The SFU (Selective Forwarding Unit) is a mechanism to allow distributing a single stream out to a large number of peers. This is useful because when peers connect directly to the streamer, resources must be allocated per peer to allow encoding of the stream. This means the resources can be quickly drained after only a handful of peers. The SFU can receive multiple streams using simulcast and selectively forward out streams to remote peers based on their available resources, without requiring to actually re-encode the stream.

## Configuration

Configuration is handled through the single config.js file.

| Name | Type | Default | Description |
|-|-|-|-|
| signallingURL | String | 'http://localhost:8889' | The URL pointing to the signalling server we want to connect to. |
| streams | Array&lt;Object&gt; | `[]` | Multi-tenant mode. A list of `{ sfuId, subscribeStreamerId }` entries, one per stream this process should host. When non-empty, `SFUId` and `subscribeStreamerId` below are ignored. See [Multi-tenant mode](#multi-tenant-mode). |
| autoHost | Object | | Optional auto-host mode, where this SFU discovers streamers and hosts them without any config change. See [Auto-host mode](#auto-host-mode). |
| SFUId | String | 'SFU' | The name this peer will be given that will then be displayed in the streamer list. Peers wishing to receive from this SFU should subscribe to this ID. Only used when `streams` is empty and `autoHost` is disabled. |
| subscribeStreamerId | String | 'DefaultStreamer' | This is the name of the streamer that this SFU should subscribe to and re-stream. Only used when `streams` is empty and `autoHost` is disabled. |
| retrySubscribeDelaySecs | Number | 10 | If subscribing to the given streamer fails, wait this many seconds before trying again. |
| controlApi | Object | | Optional HTTP control API for adding and removing streams at runtime. See [Control API](#control-api). |
| snapshots | Object | | Optional JPEG preview of each hosted stream, for stream pickers and grids. See [Stream snapshots](#stream-snapshots). |
| blockPlayerToStreamerData | Boolean | false | When true, data channel messages sent by players are not relayed to the streamer. Enable this for a broadcast-only service where streamers are send-only. |
| mediasoup | Object | | Mediasoup-related configuration options. See below. |

### Mediasoup related configuration options.

| Name | Type | Default | Description |
|-|-|-|-|
| worker | Object | | Worker-related configuration options. See below. |
| router | Object | | Router-related configuration options. See below. |
| webRtcTransport | Object | | WebRTC transport-related configuration options. See below. |

### Worker-related configuration options.

| Name | Type | Default | Description |
|-|-|-|-|
| rtcMinPort | Number | 40000 | Minimun RTC port for ICE, DTLS, RTP, etc. |
| rtcMaxPort | Number | 49999 | Maximum RTC port for ICE, DTLS, RTP, etc. |
| logLevel | String | 'debug' | The log level for the worker. See Mediasoup [docs](https://mediasoup.org/documentation/v3/mediasoup/api/#WorkerLogLevel) |
| logTags | Array&lt;WorkerLogTag&gt; | | The log tags to include in logs. See Mediasoup [docs](https://mediasoup.org/documentation/v3/mediasoup/api/#WorkerLogTag) |

### Router-related configuration options.

| Name | Type | Default | Description |
|-|-|-|-|
| mediaCodecs | Array&lt;RtpCodecCapability&gt; | | Codecs to support. See Mediasoup [docs](https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/#RtpCodecCapability) |

### WebRTC transport-related configuration options.

| Name | Type | Default | Description |
|-|-|-|-|
| listenIps | Array&lt;TransportListenIp|String&gt; | | Listening IP address or addresses in order of preference (first one is the preferred one). See Mediasoup [docs](https://mediasoup.org/documentation/v3/mediasoup/api/#TransportListenIp) |
| initialAvailableOutgoingBitrate | Number | Initial available outgoing bitrate (in bps/bits per second). |

## Running

Several scripts are supplied for Windows and Linux in the [platform_scripts](platform_scripts/) folder. These are the easiest way to get the server running under common situations. They can also be used as a reference for new situations.

## Multi-tenant mode

A single signalling connection can only ever represent **one** streamer: the signalling server gives each SFU connection one streamer id and one upstream subscription. Hosting N streams therefore requires N signalling connections.

This SFU hosts all of them from **one process**, sharing a single mediasoup worker, a single router, and a single RTC port range. List the streams in `config.js`:

```js
streams: [
    { sfuId: "SFU-Feed1", subscribeStreamerId: "Feed1" },
    { sfuId: "SFU-Feed2", subscribeStreamerId: "Feed2" }
],
```

Each entry opens its own connection to the signalling server and appears in the streamer list under its own `sfuId`. Players subscribe to the `sfuId` of the stream they want, never to the underlying streamer.

Notes:

- `sfuId` values must be unique, and must not collide with any streamer id on the signalling server.
- The SFU never subscribes to another SFU hosted by the same process, so tenants cannot chain into each other.
- If `streams` is empty or absent, the legacy single-stream `SFUId` / `subscribeStreamerId` settings are used instead, so existing configs keep working unchanged. This fallback is skipped when auto-host mode is enabled, so an auto-host-only deployment has no phantom tenant.
- Because one process shares one worker, all streams share one CPU core. Mediasoup workers are single-threaded, so for a large number of streams run several processes and split the streams between them.

## Auto-host mode

Auto-host mode makes the SFU discover streamers on the signalling server and host them automatically, so a new streamer needs no config change and no restart. It is disabled by default.

```js
autoHost: {
    enabled: true,
    include: "",              // only host streamer IDs matching this regex; empty means all
    exclude: "^SFU",          // never host IDs matching this regex
    sfuIdPrefix: "SFU-",      // generated sfuId is this prefix + the streamer ID
    discoveryId: "SFU-Discovery",
    discoveryIntervalSecs: 10,
    maxSubscribeFailures: 6,  // 0 disables reaping
    maxStreams: 0             // 0 means unlimited
},
```

A streamer called `Feed1` is hosted as `SFU-Feed1`, and players subscribe to `SFU-Feed1`.

How it works:

- The SFU opens one extra signalling connection that only ever asks for the streamer list. This is needed because with an empty `streams` array there would otherwise be no connection to ask on. It registers under `discoveryId` and appears in the streamer list like any other peer, but it is not a tenant: it never appears in the control API and cannot be removed with `DELETE /streams/{sfuId}`.
- Every `discoveryIntervalSecs` it re-lists streamers and creates a tenant for each new one that passes the filters.
- A tenant whose streamer disappears is reaped after `maxSubscribeFailures` consecutive list cycles without it. Explicitly configured tenants are never reaped; they retry forever.

Notes:

- **`exclude` matters.** The streamer list carries only IDs, with no type information, so an SFU cannot tell a real streamer from another SFU. The default `^SFU` covers `sfuIdPrefix`, the legacy `SFUId`, and `discoveryId`, which stops SFUs chaining into each other. Widen it if you use different SFU IDs.
- **There is no allocation.** Every SFU with auto-host enabled hosts every matching streamer, so with more than one SFU you must shard with `include` / `exclude` (for example `include: "^eu-"` on the European SFU). If you need real allocation, drive the [Control API](#control-api) from a control plane instead.
- Auto-hosted tenants live in memory only and are rediscovered on restart, so nothing needs persisting.
- The discovery connection appears in the streamer list under `discoveryId`, and because the list carries no type information a player cannot tell it apart from a real stream. Any UI built on the list must filter it out; the bundled stream grid does this by dropping `discoveryId`. If you change `discoveryId`, update that filter to match.
- Auto-host and the control API can be used together: `POST /streams` adds a fixed tenant alongside the discovered ones.

## Control API

The control API lets streams be added and removed at runtime, so a streamer can be allocated to an SFU without editing `config.js` and restarting. It is disabled by default.

```js
controlApi: {
    enabled: true,
    host: "127.0.0.1",
    port: 8890,
    token: "" // when set, requests must send `Authorization: Bearer <token>`
}
```

| Method | Route | Description |
|-|-|-|
| GET | `/streams` | Lists the hosted streams with `sfuId`, `subscribeStreamerId`, `connected`, `streaming`, `players` and `autoHosted`. |
| POST | `/streams` | Adds a stream. Body: `{ "sfuId": "...", "subscribeStreamerId": "..." }`. Returns 201, or 409 if the `sfuId` is already hosted. |
| DELETE | `/streams/{sfuId}` | Removes a stream, disconnecting its players and closing its signalling connection. Returns 404 if not hosted. |

Bind the API to `127.0.0.1` (the default) unless it is behind a proxy, and always set a `token` if it is reachable from anywhere else.

## Stream snapshots

The snapshot subsystem decodes video from every hosted stream and writes a single frame to a JPEG, so a stream picker can show a live preview of each stream without a player connected. It is off unless enabled.

```js
snapshots: {
    enabled: true,          // spawn snapshot workers for hosted streams
    outputDir: null,        // null = <SFU>/snapshots
    httpHost: "0.0.0.0",    // host the snapshot HTTP API binds to
    httpPort: 8891,
    maxConcurrent: 8,       // streams decoded at once; the rest queue
    width: 320,             // output width in pixels, height follows the aspect ratio
    quality: 5,             // mjpeg quality, 2 (best) to 31 (worst)
    refreshSeconds: 60,     // how often each preview is decoded afresh
    portRangeStart: 51000,  // first of 200 UDP ports used to feed ffmpeg
    ffmpegPath: null        // null = bundled ffmpeg, then PATH
}
```

| Method | Route | Description |
|-|-|-|
| GET | `/snapshots` | Lists every hosted stream with `sfuId`, `state` (`pending`, `running`, `error`), `hasImage` and `ageMs`, plus the `refreshSeconds` currently in force. |
| GET | `/snapshots/{sfuId}.jpg` | The most recent frame. Returns 404 until the first frame has been decoded. |

Responses carry `Cache-Control: no-store` and `X-Snapshot-Age-Ms`, the age of the frame in milliseconds. `/snapshots` is CORS-open so a picker on another origin can poll it.

There is exactly **one JPEG per stream**, and each new frame overwrites it in place: nothing is versioned, rotated or backed up, and no history is kept. That is why `/snapshots` reports the age of the frame it holds — a picker that reloads on that age rather than on a fixed timer fetches each frame exactly once, however slow the refresh rate is. Because a frame can be read while ffmpeg is rewriting it, the API only ever serves a whole JPEG: the last complete frame is cached per stream in memory (a few KB) and handed out if the file on disk is caught mid-write.

How it works: each stream gets a mediasoup `PlainTransport` with `comedia: false` and a paused consumer, so no RTP flows until the destination is known. The SFU then writes an SDP describing exactly what will arrive, launches ffmpeg against it, and only once ffmpeg is listening calls `transport.connect()` and resumes the consumer. ffmpeg decodes the stream, a rate filter (`fps=1/refreshSeconds`) keeps one frame per interval, and each of those overwrites the same JPEG in place.

Notes:

- The SDP must be generated from the **consumer's** RTP parameters, not the producer's. Mediasoup assigns its own SSRC to the outgoing stream, and ffmpeg discards every packet whose SSRC does not match the `a=ssrc` line it was given.
- Snapshots are decoded out of process, so a stream with an unusual or corrupt bitstream cannot take the SFU down with it. A worker that exits is restarted with exponential backoff up to 30 seconds.
- A stream only gets snapshots once its SFU connection has completed and its video producer exists, so a streamer that is connected but not yet sending simply has no snapshot. A stream with no video producer, or with a codec ffmpeg cannot decode, is logged and skipped rather than retried.
- The consumer is negotiated with **restricted RTP capabilities**: the transport-wide-cc and abs-send-time header extensions are removed, so mediasoup does not build a congestion control client and does not take over the consumer's bitrate. On a receive-only transport that allocator has no receiver feedback to work from, so it never selects a spatial layer and a **simulcast** producer forwards nothing at all. Keeping the bitrate unmanaged leaves layer selection to `setPreferredLayers()`, which the worker calls explicitly along with a key frame request. Both are re-issued while a worker produces nothing, and a worker that has decoded nothing after several attempts is recycled and reported as `error`.
- Frames are thinned with the `fps` filter rather than with `-skip_frame nokey`. Skipping everything but key frames costs less CPU, but a stream with a long GOP then refreshes its preview once a minute, or never; the consumer only forwards the producer's lowest temporal layer, so a full decode of a live stream stays affordable.
- The `-analyzeduration` / `-probesize` window must stay well inside `MAX_EMPTY_CHECKS * HEALTH_CHECK_MS` (3 × 5 s in `snapshot_manager.js`). ffmpeg writes nothing at all until probing finishes, so a window longer than the worker's own patience means a low bitrate stream is recycled while it is still reading, every cycle, and never produces a frame. Lowering either constant without lowering the other reintroduces that failure.
- The window in which a worker's last frame counts as current is derived from `refreshSeconds` (`refreshSeconds * 1000 + 2 × HEALTH_CHECK_MS`). Fixing it at a constant instead would make a healthy worker with a slow refresh look stalled and be sent a key frame request every 5 seconds, which asks the streamer's encoder for key frames no consumer needs. A worker that has produced *nothing at all* is a different case and is still recycled after `MAX_EMPTY_CHECKS` checks, whatever the refresh interval is.
- `maxConcurrent` bounds the total decode cost. Streams over the limit wait in a queue and are started when a slot frees.
- Snapshot output must **not** live under the signalling server's web root: rebuilding the frontend wipes that directory. Serve the frames through the signalling server's [`snapshot_proxy`](../SignallingWebServer/README.md#snapshot-proxy) instead, which is what the bundled stream grid does.
- ffmpeg is only needed for snapshots. If it is missing the SFU logs a warning and starts without them.

## Streaming from UE

The best way to fully utilize the SFU is to have a single streamer streaming simulcast to the SFU and then have peers subscribe to the SFU stream.

Launch the streaming app with the following arguments
`-SimulcastParameters="1.0,5000000,20000000,2.0,1000000,5000000,4.0,50000,1000000"`
This tells the Pixel Streaming plugin to stream simulcast with 3 streams, each one scaling video resolution by half. The sequence of values is as follows, `scale_down_factor,min_bitrate,max_bitrate,...repeating for each stream`

When this streams to the SFU, the SFU will detect these 3 streams and then selectively stream these out to connected peers based on their connection quality.

## Running the Docker image

The Docker image needs to know where the signalling server to connect to is. You will need to set the `SIGNALLING_URL` environment variable to the URL for your signalling server. This URL needs to point to the configured SFU port (default 8889).
You will also need to use the `host` network driver on docker because of the way the SFU collects and reports its available ports.
An example for running might be as follows.

```docker run -e SIGNALLING_URL=ws://192.168.1.10:8889 --network="host" ghcr.io/epicgames/pixel-streaming-sfu:5.4```

### Snapshots in Docker

The image copies only the `SFU` directory, so the bundled ffmpeg under `Extras/ffmpeg` is not in it and the SFU starts with snapshots disabled. To enable them, install an ffmpeg in the image and publish the snapshot port, for example:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg
EXPOSE 8891
COPY /Extras/ffmpeg /Extras/ffmpeg
```

A binary under `/Extras/ffmpeg/linux-x64/ffmpeg` is picked up automatically. Note that the distribution's ffmpeg package is a GPL build, unlike the LGPL static builds the SFU ships with; if that matters to you, copy a static LGPL build in and skip the `apt-get` line. Also add the snapshot port range to the published ports if the signalling server proxies previews from outside the container.
