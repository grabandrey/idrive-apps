#!/bin/sh
# Remote Play Engine: the program for this head unit's processor (both are static: no libraries needed).
HERE="$(dirname "$0")"
case "$(uname -m)" in
    x86_64|amd64) ARCH=x86_64 ;;
    aarch64|arm64) ARCH=aarch64 ;;
    *) echo "[error] no engine for $(uname -m)"; exit 1 ;;
esac
# the CAs PSN's HTTPS is checked against (play over the internet): Mozilla's list, shipped with it, unless set already
[ -z "$SSL_CERT_FILE" ] && export SSL_CERT_FILE="$HERE/cacert.pem"
exec "$HERE/bin/$ARCH/ida-rp-engine" /run/ida-remoteplay-engine
