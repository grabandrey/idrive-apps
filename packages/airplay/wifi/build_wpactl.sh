#!/usr/bin/env bash
# AirPlay Wi-Fi: builds bin/<arch>/ida-wpactl (ida-wpactl.c), static, for x86_64 and aarch64. Needs python3 with zig
# (pip install ziglang).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ZIG="$(python3 -c 'import ziglang, os; print(os.path.join(os.path.dirname(ziglang.__file__), "zig"))')"
for ARCH in x86_64 aarch64; do
    mkdir -p "$HERE/bin/$ARCH"
    "$ZIG" cc -target "$ARCH-linux-musl" -O2 -Wall -static -s -o "$HERE/bin/$ARCH/ida-wpactl" "$HERE/ida-wpactl.c"
    echo "built bin/$ARCH/ida-wpactl"
done
