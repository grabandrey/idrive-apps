#!/usr/bin/env bash
# Remote Play Video: builds bin/<arch>/ida-gst (ida-gst.c) for x86_64 and aarch64, against glibc 2.17 so it runs on
# any head unit's glibc from 2013 on. Needs python3 with zig (pip install ziglang).
#   packages/remoteplay/tool/build_gst.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ZIG="$(python3 -c 'import ziglang, os; print(os.path.join(os.path.dirname(ziglang.__file__), "zig"))')"
for ARCH in x86_64 aarch64; do
    mkdir -p "$HERE/bin/$ARCH"
    "$ZIG" cc -target "$ARCH-linux-gnu.2.17" -O2 -Wall -s -o "$HERE/bin/$ARCH/ida-gst" "$HERE/ida-gst.c" -ldl
    echo "built bin/$ARCH/ida-gst"
done
