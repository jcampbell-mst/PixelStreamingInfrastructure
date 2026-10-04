# Bundled ffmpeg

The SFU uses ffmpeg to decode one key frame per stream into a JPEG preview. It is the only part of the infrastructure that needs an external binary, so a static build is kept here and used automatically when it is present.

## Layout

```
ffmpeg/
  fetch-ffmpeg.ps1     Windows fetcher
  fetch-ffmpeg.sh      Linux/macOS fetcher
  win64-x64/ffmpeg.exe Windows x64 static build
  linux-x64/ffmpeg     Linux x64 static build
```

`SFU/snapshot_manager.js` looks for a binary in this order, taking the first one it finds:

1. `snapshots.ffmpegPath` from `SFU/config.js`, if set.
2. `win64-x64/ffmpeg.exe` on Windows, `linux-x64/ffmpeg` on Linux.
3. `ffmpeg` on `PATH`.

Snapshots are optional: if none of those exist the SFU logs a warning and runs without them, and the stream grid falls back to a placeholder image.

## Fetching a build

The binaries are not committed. Run the fetcher for your platform from this directory:

```
.\fetch-ffmpeg.ps1        # Windows
./fetch-ffmpeg.sh         # Linux/macOS
```

Or drop a static ffmpeg at the path above yourself. Any ffmpeg 5.1 or newer works, since the snapshot worker uses `-fps_mode`; an older build fails to start and the SFU reports the worker as `error`.

Both fetchers pull the `latest` LGPL asset, which moves as upstream releases. The build the vendored Windows binary was taken from is `N-127142-g12b7b9891b-20261003`; the fetcher run on that date reproduced it byte for byte (138,208,256 bytes).

## Licence

These are BtbN's FFmpeg-Builds static builds, taken from the `latest` release of <https://github.com/BtbN/FFmpeg-Builds>, in the `lgpl` variant with no external shared libraries.

FFmpeg is licensed under the LGPL v2.1 or later when built without GPL-only components, which is the case for these builds. The `lgpl` variant is deliberate: a GPL build would make the whole distribution subject to the GPL. The upstream licence text is included next to each binary as `LICENSE.txt`, and attribution is owed to the FFmpeg project (<https://ffmpeg.org>) and to BtbN for the builds.

If you rebuild or replace the binary, keep it LGPL-compatible and keep the licence text alongside it.
