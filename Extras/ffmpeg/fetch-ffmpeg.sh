#!/usr/bin/env bash
# Downloads the static ffmpeg build used by the SFU snapshot subsystem.
#
# Fetches the LGPL static Linux x64 build from BtbN/FFmpeg-Builds and places
# ffmpeg and its licence text in linux-x64/. The LGPL variant is used on
# purpose: a GPL build would put the whole distribution under the GPL.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
destination="${1:-$here/linux-x64}"
asset_name="ffmpeg-master-latest-linux64-lgpl.tar.xz"
url="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$asset_name"

if [ -x "$destination/ffmpeg" ] && [ "${FORCE:-0}" != "1" ]; then
    echo "ffmpeg already present at $destination/ffmpeg. Set FORCE=1 to replace it."
    exit 0
fi

case "$(uname -m)" in
    x86_64 | amd64) ;;
    *)
        echo "This script only fetches the x64 build. Download an arm64 build from" >&2
        echo "https://github.com/BtbN/FFmpeg-Builds/releases and place it at $destination/ffmpeg." >&2
        exit 1
        ;;
esac

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

echo "Downloading $url"
if command -v curl >/dev/null 2>&1; then
    curl -L --fail --output "$work_dir/$asset_name" "$url"
else
    wget -O "$work_dir/$asset_name" "$url"
fi

echo "Extracting"
tar -xJf "$work_dir/$asset_name" -C "$work_dir"

root="$(find "$work_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [ -z "$root" ]; then
    echo "The archive did not contain the expected folder." >&2
    exit 1
fi

mkdir -p "$destination"
install -m 0755 "$root/bin/ffmpeg" "$destination/ffmpeg"
cp "$root/LICENSE.txt" "$destination/LICENSE.txt"

echo "Installed $destination/ffmpeg"
"$destination/ffmpeg" -hide_banner -version | head -n 1
