#!/usr/bin/env bash
# AirPlay Engine: builds bin/<arch>/ida-airplay-engine, one static program per head-unit architecture (x86_64 and
# aarch64, musl, no shared libraries: it runs whatever the head unit's own libc is).
#
#   packages/airplay/engine/build.sh [x86_64|aarch64|native ...]        (default: x86_64 aarch64)
#
# What it builds, all from upstream source at pinned versions:
#   UxPlay's AirPlay library (lib/, GPL-3.0 with LGPL-2.1 parts, unmodified; its mdnsd.c replaced by mdns_ifaces.c,
#   which answers on every private interface), libplist (LGPL-2.1, also the engine's JSON) and OpenSSL's libcrypto
#   engine.c and mdns_ifaces.c, this package's own code around it
#
# Needs: git, make, perl, python3 with zig (pip install ziglang). "native" builds with the host's cc and OpenSSL
# (for a quick test on a desktop). The compiler is zig cc, so one machine builds both architectures.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${APE_WORK:-$HERE/.build}"
JOBS="${JOBS:-$(nproc)}"
UXPLAY=(https://github.com/FDH2/UxPlay.git 48f5ce47c9ef694afccfac907c9e8828329657fe)
LIBPLIST=(https://github.com/libimobiledevice/libplist.git 2.7.0)
OPENSSL=(https://github.com/openssl/openssl.git openssl-3.0.15)
TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(x86_64 aarch64)

mkdir -p "$WORK/src"
if [ ! -d "$WORK/src/uxplay/.git" ]; then git clone -q --filter=blob:none "${UXPLAY[0]}" "$WORK/src/uxplay"; fi
git -C "$WORK/src/uxplay" -c advice.detachedHead=false checkout -q "${UXPLAY[1]}"
[ -d "$WORK/src/libplist" ] || git -c advice.detachedHead=false clone -q --depth 1 --branch "${LIBPLIST[1]}" "${LIBPLIST[0]}" "$WORK/src/libplist"

UX="$WORK/src/uxplay/lib"
PL="$WORK/src/libplist"
# libplist without its autotools: what its configure would find on any Linux libc
mkdir -p "$WORK/plist-config"
cat > "$WORK/plist-config/config.h" <<'EOF'
#define HAVE_STRNDUP 1
#define HAVE_GMTIME_R 1
#define HAVE_LOCALTIME_R 1
#define HAVE_TM_TM_GMTOFF 1
#define HAVE_TM_TM_ZONE 1
#define HAVE_STRPTIME 1
#define PACKAGE_STRING "libplist 2.7.0"
#define PACKAGE_VERSION "2.7.0"
EOF

for ARCH in "${TARGETS[@]}"; do
    T="$WORK/$ARCH"
    mkdir -p "$T/obj" "$T/bin"
    if [ "$ARCH" = native ]; then
        CC=cc; AR=ar; CRYPTO_INC=(); CRYPTO_LIB=(-lcrypto); STATIC=()
    else
        ZIG="$(python3 -c 'import ziglang, os; print(os.path.join(os.path.dirname(ziglang.__file__), "zig"))')"
        TRIPLE="$ARCH-linux-musl"
        printf '#!/bin/sh\nexec "%s" cc -target %s "$@"\n' "$ZIG" "$TRIPLE" > "$T/bin/cc"
        printf '#!/bin/sh\nexec "%s" ar "$@"\n' "$ZIG" > "$T/bin/ar"
        printf '#!/bin/sh\nexec "%s" ranlib "$@"\n' "$ZIG" > "$T/bin/ranlib"
        chmod +x "$T/bin/"*
        CC="$T/bin/cc"; AR="$T/bin/ar"; P="$T/prefix"
        if [ ! -f "$P/lib/libcrypto.a" ]; then
            [ -d "$WORK/src/openssl" ] || git -c advice.detachedHead=false clone -q --depth 1 --branch "${OPENSSL[1]}" "${OPENSSL[0]}" "$WORK/src/openssl"
            rm -rf "$T/openssl" && cp -r "$WORK/src/openssl" "$T/openssl"
            (cd "$T/openssl" && ./Configure "linux-$ARCH" no-shared no-tests no-dso no-engine no-async \
                --prefix="$P" --libdir=lib CC="$CC" AR="$AR" RANLIB="$T/bin/ranlib" >/dev/null \
                && make -j "$JOBS" build_libs >/dev/null && make install_dev >/dev/null)
        fi
        CRYPTO_INC=(-I"$P/include"); CRYPTO_LIB=("$P/lib/libcrypto.a"); STATIC=(-static)
    fi

    DEFS=(-DSTANDALONE -D__STDC_CONSTANT_MACROS -D__STDC_LIMIT_MACROS -DTARGET_POSIX -D_LINUX -D_REENTRANT
        -D_LARGEFILE64_SOURCE -D_FILE_OFFSET_BITS=64 -DNOHOLD -DPLIST_210 -DPLIST_230 -DOPENSSL_API_COMPAT=0x10101000L -DHAVE_CONFIG_H)
    INC=(-I"$UX" -I"$UX/playfair" -I"$UX/fairplay_v2" -I"$UX/llhttp" -I"$UX/mdnsd" -I"$PL/include" -I"$PL/src"
        -I"$PL/libcnary/include" -I"$WORK/plist-config" "${CRYPTO_INC[@]}")
    SRCS=("$UX"/*.c "$UX"/llhttp/*.c "$UX"/playfair/*.c "$UX"/fairplay_v2/*.c "$UX/mdnsd/dnssd_mdnsd.c" "$HERE/mdns_ifaces.c"
        "$PL"/src/*.c "$PL/libcnary/node.c" "$PL/libcnary/node_list.c")
    OBJS=()
    pids=()
    for s in "${SRCS[@]}"; do
        o="$T/obj/$(echo "${s#$WORK/src/}" | tr '/' '_' | sed 's/\.c$/.o/')"
        OBJS+=("$o")
        if [ ! -f "$o" ] || [ "$s" -nt "$o" ]; then
            "$CC" -O2 -fPIC -w -std=gnu99 "${DEFS[@]}" "${INC[@]}" -c "$s" -o "$o" &
            pids+=($!)
            if [ ${#pids[@]} -ge "$JOBS" ]; then wait "${pids[0]}"; pids=("${pids[@]:1}"); fi
        fi
    done
    for p in "${pids[@]}"; do wait "$p"; done
    "$CC" -O2 -Wall "${STATIC[@]}" -o "$T/ida-airplay-engine" "$HERE/engine.c" "${DEFS[@]}" "${INC[@]}" "${OBJS[@]}" "${CRYPTO_LIB[@]}" \
        -Wl,--strip-all -lpthread -lm
    if [ "$ARCH" != native ]; then
        mkdir -p "$HERE/bin/$ARCH"
        cp "$T/ida-airplay-engine" "$HERE/bin/$ARCH/ida-airplay-engine"
        echo "built $HERE/bin/$ARCH/ida-airplay-engine ($(du -h "$HERE/bin/$ARCH/ida-airplay-engine" | cut -f1))"
    else
        echo "built $T/ida-airplay-engine"
    fi
done
