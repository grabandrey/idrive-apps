#!/usr/bin/env bash
# Remote Play Engine: builds bin/<arch>/ida-rp-engine, one static program per head-unit architecture (x86_64 and
# aarch64, musl, no shared libraries: it runs whatever the head unit's own libc is).
#
#   packages/remoteplay/engine/build.sh [x86_64|aarch64 ...]        (default: both)
#
# What it builds, all from upstream source at pinned versions:
#   chiaki-ng's protocol library (lib/, AGPL-3.0, unmodified) and the dependencies it links: OpenSSL, libevent,
#   json-c, miniupnpc, curl, nanopb, jerasure / gf-complete
#   engine.c, this package's own program around it, and musl_compat.c (glibc functions the library uses, for musl)
#   (AGPL-3.0, as they link the library)
#
# Needs: git, cmake, ninja, python3 with zig (pip install ziglang) and the protobuf generator (pip install protobuf
# grpcio-tools). The compiler is zig cc, so one machine builds both architectures.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${RPE_WORK:-$HERE/.build}"
JOBS="${JOBS:-$(nproc)}"
CHIAKI_REPO=https://github.com/streetpea/chiaki-ng.git
CHIAKI_REV=43728af2e639fecb8a7af1cd68c29820a40de973
# git tags (clones, so only github.com is needed); json-c and miniupnpc are the versions chiaki-ng's own build fetches
OPENSSL=(https://github.com/openssl/openssl.git openssl-3.0.15)
LIBEVENT=(https://github.com/libevent/libevent.git release-2.1.12-stable)
JSONC=(https://github.com/json-c/json-c.git json-c-0.17-20230812)
MINIUPNPC=(https://github.com/miniupnp/miniupnp.git miniupnpc_2_2_8)
ZIG="$(python3 -c 'import ziglang, os; print(os.path.join(os.path.dirname(ziglang.__file__), "zig"))')"
TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(x86_64 aarch64)

mkdir -p "$WORK/src"
fetch() {   # repo tag dir
    [ -d "$WORK/src/$3" ] && return
    git -c advice.detachedHead=false clone -q --depth 1 --branch "$2" "$1" "$WORK/src/$3"
}

# ---- sources ----
if [ ! -d "$WORK/src/chiaki-ng/.git" ]; then
    git clone --filter=blob:none "$CHIAKI_REPO" "$WORK/src/chiaki-ng"
fi
git -C "$WORK/src/chiaki-ng" checkout -q "$CHIAKI_REV"
git -C "$WORK/src/chiaki-ng" submodule update --init --depth 1 third-party/nanopb third-party/jerasure third-party/gf-complete third-party/curl
fetch "${OPENSSL[@]}" openssl
fetch "${LIBEVENT[@]}" libevent
fetch "${JSONC[@]}" json-c
fetch "${MINIUPNPC[@]}" miniupnpc

for ARCH in "${TARGETS[@]}"; do
    TRIPLE="$ARCH-linux-musl"
    T="$WORK/$ARCH"
    P="$T/prefix"
    mkdir -p "$T/bin" "$P"
    # zig cc behind plain names: cmake wants a compiler path without arguments
    for tool in cc c++ ar ranlib; do
        case $tool in
            cc) cmd="cc -target $TRIPLE";; c++) cmd="c++ -target $TRIPLE";; *) cmd="$tool";;
        esac
        printf '#!/bin/sh\nexec "%s" %s "$@"\n' "$ZIG" "$cmd" > "$T/bin/$tool"
        chmod +x "$T/bin/$tool"
    done
    cat > "$T/toolchain.cmake" <<EOF
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR $ARCH)
set(CMAKE_C_COMPILER $T/bin/cc)
set(CMAKE_CXX_COMPILER $T/bin/c++)
set(CMAKE_AR $T/bin/ar CACHE FILEPATH "")
set(CMAKE_RANLIB $T/bin/ranlib CACHE FILEPATH "")
set(CMAKE_FIND_ROOT_PATH $P)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
EOF
    # loaded right after the library's project(): pkg-config set up before its first pkg_search_module (libevent)
    echo 'find_package(PkgConfig REQUIRED)' > "$T/early.cmake"
    COMMON=(-G Ninja -DCMAKE_TOOLCHAIN_FILE="$T/toolchain.cmake" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$P"
        -DBUILD_SHARED_LIBS=OFF -DCMAKE_PREFIX_PATH="$P")
    export PKG_CONFIG_LIBDIR="$P/lib/pkgconfig" PKG_CONFIG_PATH=""

    # OpenSSL: the library's crypto (its default; its Mbed TLS path overruns an HMAC buffer), and curl's TLS (PSN)
    if [ ! -f "$P/lib/libcrypto.a" ]; then
        rm -rf "$T/openssl" && cp -r "$WORK/src/openssl" "$T/openssl"
        (cd "$T/openssl" && ./Configure "linux-$ARCH" no-shared no-tests no-dso no-engine no-async \
            --prefix="$P" --libdir=lib CC="$T/bin/cc" AR="$T/bin/ar" RANLIB="$T/bin/ranlib" >/dev/null \
            && make -j "$JOBS" build_libs >/dev/null && make install_dev >/dev/null)
    fi
    # libevent
    if [ ! -f "$P/lib/libevent.a" ]; then
        cmake -S "$WORK/src/libevent" -B "$T/libevent" "${COMMON[@]}" -DEVENT__LIBRARY_TYPE=STATIC -DEVENT__DISABLE_OPENSSL=ON \
            -DEVENT__DISABLE_MBEDTLS=ON -DEVENT__DISABLE_TESTS=ON -DEVENT__DISABLE_SAMPLES=ON -DEVENT__DISABLE_BENCHMARK=ON \
            -DEVENT__DISABLE_REGRESS=ON
        cmake --build "$T/libevent" -j "$JOBS" && cmake --install "$T/libevent"
    fi
    # the library, its own third-party code (curl over Mbed TLS), json-c and miniupnpc fetched by its build
    cmake -S "$WORK/src/chiaki-ng" -B "$T/chiaki" "${COMMON[@]}" -DCMAKE_PROJECT_INCLUDE="$T/early.cmake" \
        -DCMAKE_C_FLAGS="-include $HERE/musl_compat.h" \
        -DCHIAKI_ENABLE_GUI=OFF -DCHIAKI_ENABLE_CLI=OFF -DCHIAKI_ENABLE_TESTS=OFF -DCHIAKI_ENABLE_STEAM_SHORTCUT=OFF \
        -DCHIAKI_ENABLE_SETSU=OFF -DCHIAKI_ENABLE_STEAMDECK_NATIVE=OFF -DCHIAKI_ENABLE_FFMPEG_DECODER=OFF \
        -DCHIAKI_ENABLE_PI_DECODER=OFF -DCHIAKI_LIB_ENABLE_OPUS=OFF -DCHIAKI_ENABLE_SPEEX=OFF \
        -DCHIAKI_LIB_ENABLE_MBEDTLS=OFF -DOPENSSL_ROOT_DIR="$P" -DOPENSSL_USE_STATIC_LIBS=ON -DCHIAKI_USE_SYSTEM_JERASURE=OFF -DCHIAKI_USE_SYSTEM_NANOPB=OFF -DCHIAKI_USE_SYSTEM_CURL=OFF \
        -DCHIAKI_LIB_JSONC_EXTERNAL_PROJECT=ON -DCHIAKI_LIB_MINIUPNPC_EXTERNAL_PROJECT=ON \
        -DFETCHCONTENT_SOURCE_DIR_JSON-C="$WORK/src/json-c" -DFETCHCONTENT_SOURCE_DIR_MINIUPNPC="$WORK/src/miniupnpc" \
        -DCURL_USE_OPENSSL=ON -DCURL_USE_MBEDTLS=OFF -DCURL_USE_LIBPSL=OFF -DCURL_USE_LIBSSH2=OFF -DUSE_LIBIDN2=OFF \
        -DCURL_ZLIB=OFF -DCURL_BROTLI=OFF -DCURL_ZSTD=OFF -DUSE_NGHTTP2=OFF -DCURL_CA_FALLBACK=ON
    cmake --build "$T/chiaki" -j "$JOBS" --target chiaki-lib

    # the engine: engine.c against the library and everything it links, all static
    LIBS=$(find "$T/chiaki" -name '*.a' | grep -v '/CMakeFiles/' | sort)
    INC=(-I"$WORK/src/chiaki-ng/lib/include" -I"$T/chiaki/lib/include" -I"$P/include" -I"$T/chiaki/_deps/json-c-prefix-include" -I"$T/chiaki/_deps/json-c-build")
    "$T/bin/cc" -O2 -static -o "$T/ida-rp-engine" "$HERE/engine.c" "$HERE/musl_compat.c" "${INC[@]}" \
        -Wl,--start-group $LIBS "$P/lib/libevent.a" "$P/lib/libssl.a" "$P/lib/libcrypto.a" -Wl,--end-group \
        -Wl,-z,stack-size=1048576 -Wl,--strip-all -lpthread -lm
    mkdir -p "$HERE/bin/$ARCH"
    cp "$T/ida-rp-engine" "$HERE/bin/$ARCH/ida-rp-engine"
    echo "built $HERE/bin/$ARCH/ida-rp-engine ($(du -h "$HERE/bin/$ARCH/ida-rp-engine" | cut -f1))"
done
