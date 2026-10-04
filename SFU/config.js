// Parse passed arguments
let passedPublicIP = null;
for(let arg of process.argv){
  if(arg && arg.startsWith("--PublicIP=")){
    let splitArr = arg.split("=");
    if(splitArr.length == 2){
      passedPublicIP = splitArr[1];
      console.log("--PublicIP=" + passedPublicIP);
    }
  }
}

const config = {
  // The URL of the signalling server to connect to
  signallingURL: "ws://localhost:8889",

  // ---------------------------------------------------------------------------
  // Multi-tenant mode
  // ---------------------------------------------------------------------------
  // This SFU can host many streams at once. Each entry below becomes one
  // signalling connection, one streamer ID on the signalling server, and one
  // subscribable stream. All of them share this single process, a single
  // mediasoup worker, a single router and a single RTP port range.
  //
  //   sfuId               - the ID this stream is advertised under. Players
  //                         subscribe to this, never to the real streamer.
  //   subscribeStreamerId - the ID of the upstream streamer to pull from.
  //                         Leave blank/null to subscribe to the first streamer
  //                         the signalling server reports.
  //
  // When this array is empty or absent, the legacy single-stream settings
  // (SFUId / subscribeStreamerId below) are used instead, so existing configs
  // keep working unchanged.
  streams: [
    // { sfuId: "SFU-Feed1", subscribeStreamerId: "Feed1" },
    // { sfuId: "SFU-Feed2", subscribeStreamerId: "Feed2" },
  ],

  // ---------------------------------------------------------------------------
  // Auto-host mode
  // ---------------------------------------------------------------------------
  // When enabled, this SFU discovers streamers on the signalling server and
  // hosts them automatically, so a new streamer needs no config change and no
  // restart. It works by opening one extra signalling connection that only ever
  // asks for the streamer list, then creating a tenant for every streamer it
  // sees that passes the filters below.
  //
  //   include              - only auto-host streamer IDs matching this regex.
  //                          Empty means all.
  //   exclude              - never auto-host IDs matching this regex. The
  //                          streamer list carries no type information, so an
  //                          SFU cannot tell a real streamer from another SFU.
  //                          The default keeps SFUs from chaining into each
  //                          other; widen it if you use different SFU IDs.
  //   sfuIdPrefix          - generated sfuId is this prefix + the streamer ID.
  //                          This is the ID players subscribe to.
  //   discoveryId          - the ID the discovery connection registers under.
  //                          It appears in the streamer list like any other.
  //   discoveryIntervalSecs- how often to re-list streamers to find new ones.
  //   maxSubscribeFailures - remove an auto-hosted stream after this many
  //                          consecutive list cycles without its streamer.
  //                          0 disables reaping.
  //   maxStreams           - cap on auto-hosted streams. 0 means unlimited.
  //
  // Note there is no allocation: every SFU with auto-host enabled hosts every
  // matching streamer. With more than one SFU, shard with include/exclude.
  //
  // When auto-host is enabled and `streams` above is empty, the legacy
  // single-stream tenant below is not created, so an auto-host-only deployment
  // has no phantom tenant. List a stream in `streams` if you want a fixed
  // tenant as well.
  autoHost: {
    enabled: true,
    include: "",
    exclude: "^SFU",
    sfuIdPrefix: "SFU-",
    discoveryId: "SFU-Discovery",
    discoveryIntervalSecs: 10,
    maxSubscribeFailures: 6,
    maxStreams: 0,
  },

  // ---------------------------------------------------------------------------
  // Legacy single-stream settings (used only when `streams` above is empty and
  // auto-host mode below is disabled)
  // ---------------------------------------------------------------------------

  // The ID for this SFU to use. This will show up as a streamer ID on the signalling server
  SFUId: "SFU",

  // The ID of the streamer to subscribe to. If you leave this blank it will subscribe to the first streamer it sees.
  subscribeStreamerId: "DefaultStreamer",

  // Delay between list requests when looking for a specifc streamer.
  retrySubscribeDelaySecs: 10,

  // Enable SVC support
  enableSVC: true,

  // ---------------------------------------------------------------------------
  // Control API
  // ---------------------------------------------------------------------------
  // Optional HTTP API for adding and removing streams at runtime, so a control
  // plane can allocate streams without editing this file and restarting.
  //
  //   GET    /streams            - list hosted streams
  //   POST   /streams            - { "sfuId": "...", "subscribeStreamerId": "..." }
  //   DELETE /streams/{sfuId}    - stop hosting a stream
  //
  // Set `token` to require an `Authorization: Bearer <token>` header.
  // Disabled by default. Bind to 127.0.0.1 unless you put auth in front of it.
  controlApi: {
    enabled: false,
    host: "127.0.0.1",
    port: 8890,
    token: "",
  },

  // ---------------------------------------------------------------------------
  // Stream snapshots
  // ---------------------------------------------------------------------------
  // Builds a low frame-rate JPEG preview for every hosted stream so the stream
  // grid can show a live thumbnail per tile.
  //
  // Each stream gets a mediasoup PlainTransport that consumes the video
  // producer, and a vendored ffmpeg that listens on a local UDP port. ffmpeg
  // decodes the stream and keeps one frame every `refreshSeconds`, each
  // overwriting the same JPEG. Frames are served over HTTP:
  //
  //   GET /snapshots/<sfuId>.jpg   - latest JPEG, 404 until the first frame
  //   GET /snapshots               - JSON index of streams and their state
  //
  // Decoding is the expensive part, so `maxConcurrent` caps how many ffmpeg
  // processes run at once. Streams over the cap wait in a queue and serve 404
  // until a slot frees; the grid renders its placeholder for those.
  //
  //   outputDir     - where the SDP and JPEG files are written
  //   httpHost/port - where the snapshot HTTP API listens. Bind to 0.0.0.0 to
  //                   let the signalling server proxy to it, or to expose it
  //                   directly to browsers.
  //   maxConcurrent - decode slot cap; set `enabled` to false to turn snapshots
  //                   off entirely. Streams over the cap queue and 404.
  //   width         - thumbnail width in pixels, height follows the source
  //                   aspect ratio. Keep this small; it is a thumbnail.
  //   quality       - JPEG quality passed to ffmpeg as -q:v (2 best, 31 worst)
  //   refreshSeconds- how often a worker decodes a fresh frame. Every frame it
  //                   decodes is overwritten onto the same JPEG, so this is
  //                   also how often the thumbnail updates. The staleness
  //                   watchdog is derived from this value.
  //
  //                   Raising it lowers the CPU cost of a preview roughly in
  //                   proportion, at the price of a staler thumbnail. Note that
  //                   ffmpeg still has to decode every frame it receives and
  //                   throw most of them away, so the saving is modest beyond
  //                   ~30s; the real lever for cost is `maxConcurrent`.
  //   ffmpegLogLevel- ffmpeg's -loglevel. 'error' keeps the SFU's own log
  //                   readable; raise it to 'info' or 'verbose' to see why a
  //                   particular stream's preview is not appearing.
  //   portRangeStart- first local UDP port offered to a snapshot worker
  //   ffmpegPath    - explicit ffmpeg binary. When null, a vendored build under
  //                   Extras/ffmpeg is used, falling back to ffmpeg on PATH.
  snapshots: {
    enabled: true,
    outputDir: null,
    httpHost: "0.0.0.0",
    httpPort: 8891,
    maxConcurrent: 8,
    width: 320,
    quality: 5,
    refreshSeconds: 60,
    ffmpegLogLevel: "error",
    portRangeStart: 51000,
    ffmpegPath: null,
  },

  // When true, data channel messages sent by players are NOT relayed to the
  // streamer. Use this for a broadcast-only service where streamers are
  // send-only and must not receive anything from viewers.
  blockPlayerToStreamerData: false,

  mediasoup: {
    worker: {
      rtcMinPort: 40000,
      rtcMaxPort: 49999,
      logLevel: "debug",
      logTags: [
        "info",
        "ice",
        "dtls",
        "rtp",
        "srtp",
        "rtcp",
        "sctp"
        // 'rtx',
        // 'bwe',
        // 'score',
        // 'simulcast',
        // 'svc'
      ],
    },
    router: {
      mediaCodecs: [
        {
          kind: "audio",
          mimeType: "audio/opus",
          clockRate: 48000,
          channels: 2,
        },
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: {}
        },
        {
          kind: "video",
          mimeType: "video/h264",
          clockRate: 90000,
          parameters: {
            "packetization-mode": 1,
            "profile-level-id": "42e01f",
            "level-asymmetry-allowed": 1
          },
        },
        
      ],
    },

    // here you must specify ip addresses to listen on
    // some browsers have issues with connecting to ICE on
    // localhost so you might have to specify a proper
    // private or public ip here.
    webRtcTransport: {
      listenIps: passedPublicIP != null ? [{ ip: "0.0.0.0", announcedIp: passedPublicIP}] : getLocalListenIps(), 
      // 100 megabits
      initialAvailableOutgoingBitrate: 100_000_000,
    },
  },
}

if(config.enableSVC)
{
  config.mediasoup.router.mediaCodecs.push(
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: {
      "profile-id": 0
    }
  });
  config.mediasoup.router.mediaCodecs.push(
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: {
      "profile-id": 2
    }
  });
}

function getLocalListenIps() {
  const listenIps = []
  if (typeof window === 'undefined') {
    const os = require('os')
    const networkInterfaces = os.networkInterfaces()
    const ips = []
    if (networkInterfaces) {
      for (const [key, addresses] of Object.entries(networkInterfaces)) {
        addresses.forEach(address => {
          if (address.family === 'IPv4') {
            listenIps.push({ ip: address.address, announcedIp: null })
          }
          /* ignore link-local and other special ipv6 addresses.
           * https://www.iana.org/assignments/ipv6-address-space/ipv6-address-space.xhtml
           */
          else if (address.family === 'IPv6' && address.address[0] !== 'f') {
            listenIps.push({ ip: address.address, announcedIp: null })
          }
        })
      }
    }
  }
  if (listenIps.length === 0) {
    listenIps.push({ ip: '127.0.0.1', announcedIp: null })
  }
  return listenIps
}

module.exports = config;
