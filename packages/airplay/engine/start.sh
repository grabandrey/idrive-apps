#!/bin/sh
# AirPlay Engine: the program for this head unit's processor (both are static: no libraries needed).
# Settings (optional): /var/opt/ida-airplay-engine/env, lines like IDA_MDNS_IFACES=wlan0,ap0 (the interfaces to
# announce on; default: every private network) or IDA_MDNS_ALL=1.
HERE="$(dirname "$0")"
DATA=/var/opt/ida-airplay-engine
case "$(uname -m)" in
    x86_64|amd64) ARCH=x86_64 ;;
    aarch64|arm64) ARCH=aarch64 ;;
    *) echo "[error] no engine for $(uname -m)"; exit 1 ;;
esac
if [ -f "$DATA/env" ]; then set -a; . "$DATA/env"; set +a; fi
exec "$HERE/bin/$ARCH/ida-airplay-engine" /run/ida-airplay-engine "$DATA"
