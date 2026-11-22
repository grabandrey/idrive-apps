'use strict';
/*
 * Remote Play Video: a root tool that puts the console's video on the car's screen at the stream's full frame rate,
 * through the head unit's own GStreamer and hardware decoder (an app can't: it has no decoder and draws pictures only
 * through the renderer, a few a second). It also reads a USB gamepad plugged into the car (gamepad.js).
 *
 * Control socket /run/ida-remoteplay-video/ctl.sock (0666; the app runs as its own user), JSON lines, one reply per
 * request ("id" echoed), events ("ev") at any time; see the app's links.js for the messages.
 *
 * Stream socket /run/ida-remoteplay-video/stream.sock: a stream engine (Remote Play's, AirPlay's) connects, writes one
 * JSON line
 *   {"codec":"h264"|"h265","width":1280,"height":720,"fps":60,"rect":{x,y,w,h},"aspect":"fit"}
 * then the video as an Annex B elementary stream. Each connection is one pipeline:
 *   fdsrc ! <parser> ! [capssetter !] <decoder> ! [videoconvert !] <sink> sync=false
 * sync=false: frames show as they arrive (a game stream has no clock to keep), so the rate is the source's.
 *
 * The picture's shape ("aspect"; without it the picture goes in rect as before): fit (its own shape, as large as rect
 * allows), stretch (all of rect), or a ratio "16:9", "4:3", ... (that shape, as large as rect allows). The picture
 * goes in a rectangle of that shape inside rect (render-rectangle), and its pixel aspect ratio is set to match
 * (capssetter, where GStreamer has it), so a display that keeps the picture's shape fills that rectangle too.
 * {"op":"view","aspect":"4:3"} on the control socket changes it while the stream plays: the pipeline starts again and
 * is given the stream from its last keyframe (StreamKeeper), so the picture comes back at once. A stream whose size
 * changes (a phone turned on its side) starts again the same way, in its new shape.
 *
 * Which decoder and display: probed at start (gst-inspect-1.0), hardware first; settings.json can name them:
 *   /var/opt/ida-remoteplay-video/settings.json  {"decoder":{"h264":"v4l2h264dec"},"sink":"waylandsink","sinkProps":"fullscreen=true"}
 * Without sinkProps the video goes where the app asks (render-rectangle: the middle of the Play screen).
 *
 * Node 8 compatible (the head unit's /usr/bin/node).
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { Gamepads } = require('./gamepad.js');

const VERSION = '1.3.0';
const RUN = process.env.RPV_RUN || '/run/ida-remoteplay-video';
const CTL = path.join(RUN, 'ctl.sock');
const STREAM = path.join(RUN, 'stream.sock');
const DATA = process.env.RPV_DATA || '/var/opt/ida-remoteplay-video';
const SETTINGS = path.join(DATA, 'settings.json');

/* well-known decoder names, hardware first; the head unit's own may have any name, so decoders are also found by what
 * GStreamer says they are (klass "Codec/Decoder/Video[/Hardware]") and the codec in their name */
const DECODERS = {
    h264: ['v4l2h264dec', 'v4l2slh264dec', 'omxh264dec', 'vaapih264dec', 'vah264dec', 'msdkh264dec', 'qsvh264dec', 'nvh264dec', 'nvv4l2decoder',
        'imxvpudec_h264', 'mfxh264dec', 'vulkanh264dec', 'avdec_h264', 'openh264dec'],
    h265: ['v4l2h265dec', 'v4l2slh265dec', 'omxh265dec', 'vaapih265dec', 'vah265dec', 'msdkh265dec', 'qsvh265dec', 'nvh265dec', 'nvv4l2decoder',
        'imxvpudec_h265', 'mfxh265dec', 'vulkanh265dec', 'avdec_h265', 'libde265dec'],
};
/* decoders that take any of several codecs: a head unit's vendor plugin is often one of these */
const GENERIC = ['vaapidecode', 'imxvpudec', 'vpudec', 'mfxdecode', 'omxdec', 'qtivdec', 'qcvideodec', 'nvv4l2decoder', 'v4l2video0dec'];
const SOFTWARE = /^(avdec_|openh264dec|libde265dec|ffdec_|dav1d)/;
const CODEC = { h264: /264|avc/i, h265: /265|hevc/i };
const PARSERS = { h264: 'h264parse', h265: 'h265parse' };
const ENCODERS = ['v4l2h264enc', 'omxh264enc', 'vaapih264enc', 'vah264enc', 'msdkh264enc', 'qsvh264enc', 'imxvpuenc_h264', 'vpuenc_h264', 'x264enc', 'openh264enc'];
/* the shapes a stream can be shown in ("W:H" works for any ratio) */
const ASPECTS = ['fit', 'stretch', '16:9', '16:10', '4:3', '21:9', '1:1'];
const KEEP_BYTES = 24 * 1024 * 1024;   // the stream kept from its last keyframe, at most (past that: from its SPS/PPS)
const SINKS = ['waylandsink', 'glimagesink', 'kmssink', 'ximagesink', 'fbdevsink', 'autovideosink'];
/* the launcher shipped with the tool (ida-gst.c): the head unit's GStreamer libraries, without gst-launch-1.0 */
const ARCH = { x64: 'x86_64', arm64: 'aarch64' }[process.arch] || process.arch;
const LAUNCHER = process.env.RPV_LAUNCHER || path.join(__dirname, 'bin', ARCH, 'ida-gst');
/* short clips (make_samples.py): each decoder is checked on one before it's used; the video test decodes the 720p one */
const SAMPLES = { h264: path.join(__dirname, 'samples', 'check.h264'), h265: path.join(__dirname, 'samples', 'check.h265'),
    test: path.join(__dirname, 'samples', 'test720p60.h264'), testFrames: 480 };
const CHECK_MS = 15000;

function log(level, text) { process.stdout.write('[' + level + '] ' + text + '\n'); }

function readSettings() { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) || {}; } catch (e) { return {}; } }

function which(name) {
    const dirs = (process.env.PATH || '/usr/bin:/bin').split(':').concat(['/usr/bin', '/usr/local/bin', '/opt/bin']);
    for (let i = 0; i < dirs.length; i++) { const p = path.join(dirs[i], name); try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { /* next */ } }
    return null;
}

/* where the head unit's GStreamer is, when it isn't where a library is normally looked for (findGst): its folder in
 * LD_LIBRARY_PATH, its plugins, and the library itself for ida-gst (IDA_GST_LIB) */
const GST_ENV = {};

/* the head unit's GStreamer, wherever it is: a vendor's own folder (/opt/..., /usr/lib/<vendor>/...) is common.
 * -> { libs: [libgstreamer-1.0.so*], old: [0.10 libraries], launch: [gst-launch-1.0], inspect: [..], loaders: [ld-linux*.so*] } */
const SEARCH_ROOTS = ['/usr/lib', '/usr/lib64', '/lib', '/lib64', '/usr/local', '/opt', '/usr/bin', '/usr/sbin', '/bin', '/apps', '/system', '/vendor', '/usr/share/gstreamer-1.0', '/var/opt', '/mnt'];
function findGst(roots, o) {
    o = o || {};
    const maxDepth = o.maxDepth || 6, budget = { left: o.maxEntries || 60000 };
    const out = { libs: [], old: [], launch: [], inspect: [], loaders: [] };
    const seen = new Set();
    const walk = (dir, depth) => {
        if (depth > maxDepth || budget.left <= 0) return;
        let real;
        try { real = fs.realpathSync(dir); } catch (e) { return; }
        if (seen.has(real) || /^\/(proc|sys|dev|run)(\/|$)/.test(real) || /\/(ida-remoteplay-video|ida-airplay-engine|ida-remoteplay-engine)(\/|$)/.test(real)) return;
        seen.add(real);
        let list;
        try { list = fs.readdirSync(dir); } catch (e) { return; }
        budget.left -= list.length;
        list.forEach((f) => {
            const p = path.join(dir, f);
            if (/^libgstreamer-1\.0\.so/.test(f)) out.libs.push(p);
            else if (/^libgstreamer-0\.10\.so/.test(f)) out.old.push(p);
            else if (f === 'gst-launch-1.0') out.launch.push(p);
            else if (f === 'gst-inspect-1.0') out.inspect.push(p);
            else if (/^ld-linux.*\.so/.test(f)) out.loaders.push(p);
            else if (!/\.(so|a|la|py|pyc|h|png|jpg|ttf|mo|qm)(\.|$)/.test(f)) {
                let st;
                try { st = fs.lstatSync(p); } catch (e) { return; }
                if (st.isDirectory()) walk(p, depth + 1);
                else if (st.isSymbolicLink() && depth < 3) { try { if (fs.statSync(p).isDirectory()) walk(p, depth + 1); } catch (e) { /* dangling */ } }
            }
        });
    };
    (roots || (process.env.RPV_SEARCH ? process.env.RPV_SEARCH.split(':') : SEARCH_ROOTS)).forEach((r) => walk(r, 0));
    // the real library first (libgstreamer-1.0.so.0 before .so.0.1800.0 before the bare .so)
    const rank = (p) => (/\.so\.0$/.test(p) ? 0 : /\.so\.\d/.test(p) ? 1 : 2);
    out.libs.sort((a, b) => rank(a) - rank(b));
    return out;
}

/* the environment that makes a found library (and its plugins next to it) the one used */
function gstEnvFor(lib) {
    const dir = path.dirname(lib), env = { IDA_GST_LIB: lib, LD_LIBRARY_PATH: dir + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '') };
    const plugins = [path.join(dir, 'gstreamer-1.0'), path.join(dir, '..', 'gstreamer-1.0'), path.join(dir, '..', 'lib', 'gstreamer-1.0')].filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } });
    const uniq = plugins.map((d) => { try { return fs.realpathSync(d); } catch (e) { return d; } }).filter((d, i, all) => all.indexOf(d) === i);
    if (uniq.length) env.GST_PLUGIN_SYSTEM_PATH_1_0 = uniq.join(':');
    const scanner = [path.join(dir, 'gstreamer-1.0', 'gst-plugin-scanner'), path.join(dir, '..', 'libexec', 'gstreamer-1.0', 'gst-plugin-scanner')].filter(fileExists)[0];
    if (scanner) env.GST_PLUGIN_SCANNER_1_0 = scanner;
    return env;
}

/* the display's session for a wayland sink: the compositor's socket, wherever the head unit keeps it */
function displayEnv() {
    const env = Object.assign({}, process.env, GST_ENV);
    if (env.WAYLAND_DISPLAY && env.XDG_RUNTIME_DIR) return env;
    const dirs = ['/run/wayland', '/run/user/0', '/run'];
    try { fs.readdirSync('/run/user').forEach((u) => dirs.push('/run/user/' + u)); } catch (e) { /* none */ }
    for (let i = 0; i < dirs.length; i++) {
        let list = [];
        try { list = fs.readdirSync(dirs[i]); } catch (e) { continue; }
        const sock = list.filter((f) => /^wayland-\d+$/.test(f))[0];
        if (sock) { env.XDG_RUNTIME_DIR = dirs[i]; env.WAYLAND_DISPLAY = sock; return env; }
    }
    return env;
}

/* gst-inspect-1.0 with no arguments: "plugin:  element: description" lines -> { name: { rank: 0, klass: '' } } */
function parseInspect(text) {
    const out = {};
    String(text).split('\n').forEach((l) => { const m = /^\s*[\w.-]+:\s+([\w.-]+):\s/.exec(l); if (m) out[m[1]] = { rank: 0, klass: '' }; });
    return out;
}
/* ida-gst probe: "version x.y.z", then "element<TAB>name<TAB>rank<TAB>klass" -> { version, elements } */
function parseProbe(text) {
    const out = { version: null, elements: {} };
    String(text).split('\n').forEach((l) => {
        const v = /^version (\S+)/.exec(l);
        if (v) out.version = v[1];
        const f = l.split('\t');
        if (f[0] === 'element' && f[1]) out.elements[f[1]] = { rank: Number(f[2]) || 0, klass: f[3] || '' };
    });
    return out;
}

/* the decoders for a codec, best first: hardware, then GStreamer's rank, then the well-known order */
function decodersFor(elements, codec) {
    const names = Object.keys(elements).filter((n) => {
        const k = elements[n].klass;
        if (/parse|pay|enc|mux|sink|src$/i.test(n) && !/dec/i.test(n)) return false;
        if (k) {
            if (!/decoder/i.test(k) || !/video/i.test(k)) return false;
            return CODEC[codec].test(n) || GENERIC.indexOf(n) >= 0;
        }
        return DECODERS[codec].indexOf(n) >= 0 || GENERIC.indexOf(n) >= 0;
    });
    const hw = (n) => (/hardware/i.test(elements[n].klass) || !SOFTWARE.test(n) ? 1 : 0);
    const known = (n) => { const i = DECODERS[codec].indexOf(n); return i < 0 ? 99 : i; };
    return names.sort((a, b) => hw(b) - hw(a) || elements[b].rank - elements[a].rank || known(a) - known(b));
}

/* what to use, from what is installed (gst-inspect names, or ida-gst's names with their klass) and the settings */
function choose(elements, settings) {
    settings = settings || {};
    // a plain list of names (older callers, tests): no klass known
    if (Array.isArray(elements) || Object.keys(elements).some((k) => elements[k] === true)) {
        const o = {};
        Object.keys(elements).forEach((k) => { o[k] = { rank: 0, klass: '' }; });
        elements = o;
    }
    const has = (n) => !!elements[n];
    const forced = (n) => (n && has(n) ? n : null);
    const dec = {}, all = {};
    ['h264', 'h265'].forEach((codec) => {
        all[codec] = decodersFor(elements, codec);
        dec[codec] = forced(settings.decoder && settings.decoder[codec]) || all[codec][0] || null;
    });
    // nothing by name: decodebin picks whatever the head unit has registered for the codec (its player does the same)
    const auto = !dec.h264 && has('decodebin');
    if (auto) dec.h264 = 'decodebin';
    const isHw = (n) => !!n && n !== 'decodebin' && (/hardware/i.test((elements[n] || {}).klass) || !SOFTWARE.test(n));
    const sinks = SINKS.filter(has).concat(Object.keys(elements).filter((n) => /sink/i.test(elements[n].klass) && /video/i.test(elements[n].klass) && SINKS.indexOf(n) < 0)
        .sort((a, b) => elements[b].rank - elements[a].rank));
    const encs = ENCODERS.filter(has);
    return {
        decoders: dec,
        decoder: dec.h264 || dec.h265,
        auto: auto,
        hardware: isHw(dec.h264),
        hardwareH265: isHw(dec.h265),
        candidates: { h264: all.h264.slice(0, 8), h265: all.h265.slice(0, 8) },
        encoder: forced(settings.encoder) || encs.filter((n) => !SOFTWARE.test(n))[0] || encs[0] || null,
        sink: forced(settings.sink) || sinks[0] || null,
        sinkProps: settings.sinkProps || '',
        converter: has('videoconvert') ? 'videoconvert' : null,
        capssetter: has('capssetter'),
    };
}

/* why there's nothing to play with, in words for the screen */
function whyNot(p) {
    if (!p.gst) return p.error || 'GStreamer is not on this head unit';
    if (!p.decoder) return 'GStreamer ' + p.gst + ' has no H.264 decoder (' + p.elements + ' elements; see probe.txt)';
    if (!p.sink) return 'GStreamer ' + p.gst + ' has no video display element';
    return null;
}

/* the display element and its settings (no measuring element in between: fpsdisplaysink can't pass a sink its own
 * settings from the command line, and a game stream needs them: fullscreen, or where on the screen) */
function sinkPart(c, rect) {
    let sink = c.sink + (c.sinkProps ? ' ' + c.sinkProps : '');
    if (rect && /^(kmssink|waylandsink|glimagesink)$/.test(c.sink) && !/fullscreen=true/.test(c.sinkProps)) {
        sink += ' render-rectangle=<' + [rect.x | 0, rect.y | 0, rect.w | 0, rect.h | 0].join(',') + '>';
    }
    return sink + ' sync=false';
}
/* par: [n, d], the pixel aspect ratio the picture is given (capssetter, before the decoder: decoders pass it on) */
function streamPipeline(c, codec, rect, par) {
    const dec = c.decoders[codec];
    if (!dec) return null;
    const conv = (SOFTWARE.test(dec) || dec === 'decodebin') && c.converter ? ' ! ' + c.converter : '';
    const shape = par && c.capssetter ? ' ! capssetter caps=video/x-' + codec + ',pixel-aspect-ratio=' + par[0] + '/' + par[1] : '';
    return 'fdsrc fd=0 ! ' + PARSERS[codec] + shape + ' ! ' + dec + conv + ' ! ' + sinkPart(c, rect);
}

function gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }

/* the aspect a stream asks for: one of ASPECTS or "W:H", else null (the old behaviour: rect as given) */
function aspectOf(a) {
    if (typeof a !== 'string') return null;
    a = a.trim().toLowerCase();
    if (a === 'fit' || a === 'stretch') return a;
    const m = /^(\d{1,4})[:/x](\d{1,4})$/.exec(a);
    return m && +m[1] > 0 && +m[2] > 0 ? (+m[1]) + ':' + (+m[2]) : null;
}

/* where the picture goes and the pixel aspect ratio it's given, for an area (screen px), the picture's size and an
 * aspect: { rect, par: [n, d] | null, ratio }. The rectangle has the asked shape, centred and as large as the area
 * allows; par makes the picture that shape (null: its own) */
function viewFor(area, src, aspect) {
    if (!area || !(area.w > 0 && area.h > 0)) return { rect: area || null, par: null, ratio: null };
    const sw = src && src.width > 0 ? src.width : area.w, sh = src && src.height > 0 ? src.height : area.h;
    const a = aspectOf(aspect) || 'fit';
    const m = /^(\d+):(\d+)$/.exec(a);
    const r = a === 'stretch' ? area.w / area.h : m ? +m[1] / +m[2] : sw / sh;
    let w = area.w, h = area.h;
    if (a !== 'stretch') { if (area.w / area.h > r) w = Math.round(h * r); else h = Math.round(w / r); }
    const rect = { x: Math.round(area.x + (area.w - w) / 2), y: Math.round(area.y + (area.h - h) / 2), w: w, h: h };
    let n = w * sh, d = h * sw;
    const g = gcd(n, d) || 1;
    n /= g; d /= g;
    // the picture's own shape (within a pixel): leave it be
    const par = a === 'fit' || Math.abs(n / d - 1) < 0.002 ? null : [n, d];
    return { rect: rect, par: par, ratio: a };
}

/* ---- H.264 sequence parameter set: the picture's size ---- */
function unescape(b) {
    const out = [];
    for (let i = 0; i < b.length; i++) {
        if (i >= 2 && b[i] === 3 && b[i - 1] === 0 && b[i - 2] === 0 && out.length >= 2 && out[out.length - 1] === 0 && out[out.length - 2] === 0) continue;
        out.push(b[i]);
    }
    return out;
}
class Bits {
    constructor(b) { this.b = b; this.p = 0; }
    u(n) { let v = 0; for (let i = 0; i < n; i++) { const byte = this.b[this.p >> 3]; if (byte === undefined) throw new Error('short'); v = v * 2 + ((byte >> (7 - (this.p & 7))) & 1); this.p++; } return v; }
    ue() { let z = 0; while (this.u(1) === 0) { if (++z > 31) throw new Error('bad'); } return z ? Math.pow(2, z) - 1 + this.u(z) : 0; }
    se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -k / 2; }
}
/* nal: the NAL unit without its start code (header byte first) -> { width, height } | null */
function spsSize(nal) {
    try {
        const r = new Bits(unescape(nal.slice(1)));
        const profile = r.u(8);
        r.u(16); r.ue();
        let chroma = 1;
        if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].indexOf(profile) >= 0) {
            chroma = r.ue();
            if (chroma === 3) r.u(1);
            r.ue(); r.ue(); r.u(1);
            if (r.u(1)) {
                for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
                    if (!r.u(1)) continue;
                    let last = 8, next = 8;
                    for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + r.se() + 256) % 256; last = next || last; }
                }
            }
        }
        r.ue();
        const poc = r.ue();
        if (poc === 0) r.ue();
        else if (poc === 1) { r.u(1); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
        r.ue(); r.u(1);
        const wMbs = r.ue() + 1, hMap = r.ue() + 1, frameOnly = r.u(1);
        if (!frameOnly) r.u(1);
        r.u(1);
        let cl = 0, cr = 0, ct = 0, cb = 0;
        if (r.u(1)) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
        const cx = chroma === 1 || chroma === 2 ? 2 : 1, cy = (chroma === 1 ? 2 : 1) * (2 - frameOnly);
        const width = wMbs * 16 - (cl + cr) * cx, height = (2 - frameOnly) * hMap * 16 - (ct + cb) * cy;
        return width > 0 && height > 0 ? { width: width, height: height } : null;
    } catch (e) { return null; }
}

/* the stream as it goes by, kept from its last keyframe (with the SPS/PPS before it), so a pipeline started again
 * mid-stream (a new aspect, a new size) is given a whole picture at once; and the picture's size from each SPS.
 *   push(chunk) -> { size: {width,height} | null when it changed }      replay() -> Buffer */
class StreamKeeper {
    constructor(codec, o) {
        this.h265 = codec === 'h265';
        this.max = (o && o.maxBytes) || KEEP_BYTES;
        this.pending = Buffer.alloc(0);     // from the last start code on: the NAL still arriving
        this.sps = null; this.pps = null; this.vps = null;
        this.gop = null; this.bytes = 0; this.idr = false;
        this.size = null;
    }
    _type(n) { return this.h265 ? (n[0] >> 1) & 63 : n[0] & 31; }
    _keep(nal) {
        if (!this.gop) return;
        this.gop.push(nal); this.bytes += nal.length;
        if (this.bytes > this.max) { this.gop = null; this.bytes = 0; }
    }
    _nal(withCode) {
        let i = 0;
        while (withCode[i] === 0) i++;
        const n = withCode.slice(i + 1);
        if (!n.length) return null;
        const t = this._type(n);
        let changed = null;
        const param = this.h265 ? (t === 32 || t === 33 || t === 34) : (t === 7 || t === 8);
        const sps = this.h265 ? t === 33 : t === 7, pps = this.h265 ? t === 34 : t === 8;
        const idr = this.h265 ? (t >= 16 && t <= 21) : t === 5;
        if (this.h265 && t === 32) { this.vps = withCode; this.gop = [withCode]; this.bytes = withCode.length; this.idr = false; return null; }
        if (sps) {
            this.sps = withCode;
            if (!this.h265 || !this.gop || this.idr) { this.gop = [withCode]; this.bytes = withCode.length; this.idr = false; }
            else this._keep(withCode);
            const s = this.h265 ? null : spsSize(n);
            if (s && (!this.size || s.width !== this.size.width || s.height !== this.size.height)) { this.size = s; changed = s; }
            return changed;
        }
        if (pps) { this.pps = withCode; if (this.gop && !this.idr) this._keep(withCode); return null; }
        if (idr) {
            const first = this.h265 ? (n[2] & 0x80) : (n[1] & 0x80);
            if (first && (this.idr || !this.gop)) {
                this.gop = [this.vps, this.sps, this.pps].filter(Boolean);
                this.bytes = this.gop.reduce((a, b) => a + b.length, 0);
            }
            this.idr = true;
            this._keep(withCode);
            return null;
        }
        if (!param) this._keep(withCode);
        return null;
    }
    push(chunk) {
        const b = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
        let start = -1, size = null;
        for (let i = 0; i + 2 < b.length; i++) {
            if (b[i] !== 0 || b[i + 1] !== 0 || b[i + 2] !== 1) continue;
            const at = i > 0 && b[i - 1] === 0 ? i - 1 : i;
            if (start >= 0 && at > start) { const s = this._nal(b.slice(start, at)); if (s) size = s; }
            start = at;
            i += 2;
        }
        // no start code yet: keep everything (a stream starts with one); a NAL far too long is not kept
        this.pending = start >= 0 ? b.slice(start) : b;
        if (this.pending.length > this.max) this.pending = Buffer.alloc(0);
        return { size: size };
    }
    replay() {
        const head = this.gop || [this.vps, this.sps, this.pps].filter(Boolean);
        return Buffer.concat(head.concat([this.pending]));
    }
}
/* the test: the 720p, 60 fps clip decoded and shown as fast as the head unit can (sync=false), through the decoder the
 * stream will use: frames over the time from PLAYING to the end is the rate the car can really show (it may be over 60).
 * With no working decoder, a moving picture shown directly (the display alone). */
function testPipeline(c, o) {
    const conv = c.converter ? ' ! ' + c.converter : '';
    if (c.decoders.h264 && o.sample) {
        return 'filesrc location=' + o.sample + ' ! h264parse ! ' + c.decoders.h264 + conv + ' ! ' + sinkPart(c, o.rect);
    }
    const src = 'videotestsrc is-live=true pattern=ball num-buffers=' + Math.round(o.fps * o.seconds) +
        ' ! video/x-raw,width=' + o.width + ',height=' + o.height + ',framerate=' + o.fps + '/1';
    return src + conv + ' ! ' + sinkPart(c, o.rect);
}

/* gst-launch-1.0's arguments: one word each (no value here has a space) */
function args(pipeline) { return pipeline.split(/\s+/).filter(Boolean); }

/* pictures in an Annex B stream as it goes by: a slice NAL whose first slice of a picture flag (H.264: first_mb_in_slice
 * = 0, a single 1 bit; H.265: first_slice_segment_in_pic_flag) is set. Keeps 4 bytes between chunks for start codes. */
class FrameCounter {
    constructor(codec) { this.h265 = codec === 'h265'; this.frames = 0; this.tail = Buffer.alloc(0); }
    push(d) {
        const b = this.tail.length ? Buffer.concat([this.tail, d]) : d;
        const last = b.length - 6;
        for (let i = 0; i <= last; i++) {
            if (b[i] !== 0 || b[i + 1] !== 0 || b[i + 2] !== 1) continue;
            if (this.h265) {
                const type = (b[i + 3] >> 1) & 63;
                if (type <= 21 && (b[i + 5] & 0x80)) this.frames++;
            } else {
                const type = b[i + 3] & 31;
                if ((type === 1 || type === 5) && (b[i + 4] & 0x80)) this.frames++;
            }
            i += 2;
        }
        this.tail = b.slice(Math.max(0, b.length - 5));
    }
}

class VideoTool {
    constructor() {
        this.clients = new Set();
        this.gst = { launch: which('gst-launch-1.0'), inspect: which('gst-inspect-1.0'), launcher: null, version: null };
        this.probe = null;
        this.proc = null;          // the running pipeline
        this.what = null;          // 'test' | 'stream'
        this.stats = null;
        this.pads = new Gamepads({ log: log });
    }

    start() {
        try { fs.mkdirSync(RUN); } catch (e) { /* there */ }
        [CTL, STREAM].forEach((p) => { try { fs.unlinkSync(p); } catch (e) { /* none */ } });
        net.createServer((s) => this._client(s)).listen(CTL, () => { fs.chmodSync(CTL, 0o666); log('info', 'control on ' + CTL); });
        net.createServer((s) => this._stream(s)).listen(STREAM, () => { fs.chmodSync(STREAM, 0o666); log('info', 'stream on ' + STREAM); });
        this.pads.on('state', (name, state) => this._broadcast({ ev: 'pad', name: name, state: state }));
        this.pads.on('gone', () => this._broadcast({ ev: 'pad', name: null }));
        this.pads.start();
        return this._probe();
    }

    /* what GStreamer has: through the shipped launcher (the head unit's libraries, no tools needed), else gst-inspect-1.0 */
    _probe() {
        return this._probeLauncher().then((r) => (r && r.elements ? r : this._probeInspect().then((x) => (x && x.elements && Object.keys(x.elements).length ? x : r || x)))).then((r) => {
            const base = { devices: this._devices(), display: displayEnv().WAYLAND_DISPLAY || null, search: this.search || null };
            if (!r.elements) {
                this.probe = Object.assign(base, { gst: null, error: r.error || 'GStreamer is not on this head unit (no libgstreamer-1.0, no gst-launch-1.0)' });
            } else {
                const c = choose(r.elements, readSettings());
                this.probe = Object.assign(base, { gst: r.version || 'unknown', via: r.via, elements: Object.keys(r.elements).length }, c);
            }
            return this.probe.gst ? this._verify(this.probe, r.elements, readSettings()) : this.probe;
        }).then(() => {
            this.probe.why = whyNot(this.probe);
            log(this.probe.why ? 'warn' : 'info', 'probe: ' + JSON.stringify(this.probe));
            this._report(this._elements || {});
            return this.probe;
        });
    }

    /* a decoder GStreamer lists may still not work here (no such hardware, no driver): each candidate decodes the
     * check clip, best first, and the first that gets to the end is used. A decoder named in settings.json is tried first. */
    _verify(p, elements, settings) {
        this._elements = elements;
        p.tried = {};
        const isHw = (n) => n !== 'decodebin' && (/hardware/i.test((elements[n] || {}).klass) || !SOFTWARE.test(n));
        const pickFor = (codec) => {
            const forced = settings.decoder && settings.decoder[codec];
            const list = (forced && elements[forced] ? [forced] : []).concat(p.candidates[codec].filter((n) => n !== forced));
            if (elements.decodebin) list.push('decodebin');
            p.tried[codec] = [];
            const next = (k) => {
                if (k >= list.length) return Promise.resolve(null);
                return this._check(list[k], codec).then((err) => {
                    p.tried[codec].push(list[k] + (err ? ': ' + err : ': works'));
                    return err ? next(k + 1) : list[k];
                });
            };
            return fileExists(SAMPLES[codec]) ? next(0) : Promise.resolve(p.decoders[codec]);
        };
        return pickFor('h264').then((d264) => pickFor('h265').then((d265) => {
            p.decoders = { h264: d264, h265: d265 };
            p.decoder = d264 || d265;
            p.auto = d264 === 'decodebin';
            p.hardware = !!d264 && isHw(d264);
            p.hardwareH265 = !!d265 && isHw(d265);
            log('info', 'decoders checked: ' + JSON.stringify(p.tried));
            return p;
        }));
    }

    /* the check clip through one decoder: null when it decodes to the end, else why not */
    _check(dec, codec) {
        const conv = this.probe && this.probe.converter && (SOFTWARE.test(dec) || dec === 'decodebin') ? ' ! videoconvert' : '';
        const pl = 'filesrc location=' + SAMPLES[codec] + ' ! ' + PARSERS[codec] + ' ! ' + dec + conv + ' ! fakesink sync=false';
        const run = this._cmd(pl);
        const cmd = run[0], argv = run[1];
        return new Promise((resolve) => {
            execFile(cmd, argv, { timeout: CHECK_MS, env: displayEnv(), maxBuffer: 1024 * 1024 }, (err, out, errOut) => {
                if (!err) { resolve(null); return; }
                const m = /ERROR:?\s*(.*)/.exec(String(out) + '\n' + String(errOut));
                resolve(err.killed ? 'no end within ' + CHECK_MS / 1000 + ' s' : (m ? m[1] : 'exit ' + err.code).slice(0, 160));
            });
        });
    }

    /* the command for a pipeline: ida-gst (through the head unit's loader when it must be), else gst-launch-1.0 */
    _cmd(pipeline) {
        const l = this.gst.launcher;
        if (l) return [l.cmd, l.pre.concat(['launch']).concat(args(pipeline))];
        return [this.gst.launch, ['-e'].concat(args(pipeline))];
    }

    /* ida-gst probe: as it is; then, when that finds no GStreamer, with each libgstreamer-1.0 found on the head unit
     * (its folder in LD_LIBRARY_PATH) and, when ida-gst can't start at all, through the head unit's own loader */
    _probeLauncher() {
        const tries = [];
        const attempt = (cmd, pre, env, what) => new Promise((resolve) => {
            execFile(cmd, pre.concat(['probe']), { maxBuffer: 16 * 1024 * 1024, timeout: 30000, env: Object.assign(displayEnv(), env) }, (err, out) => {
                const p = parseProbe(out || '');
                if (p.version && Object.keys(p.elements).length) { resolve({ version: p.version, elements: p.elements, via: 'ida-gst' + (what ? ' (' + what + ')' : '') }); return; }
                const why = /ERROR: (.*)/.exec(out || '');
                tries.push((what || 'as installed') + ': ' + (why ? why[1] : err ? (err.code === 'ENOENT' ? 'cannot start (no loader for it)' : err.message) : 'nothing'));
                resolve(null);
            });
        });
        try { fs.accessSync(LAUNCHER, fs.constants.X_OK); } catch (e) { return Promise.resolve(null); }
        let found = null;
        const ok = (r, cmd, pre, env) => { this.gst.launcher = { cmd: cmd, pre: pre }; Object.keys(GST_ENV).forEach((k) => delete GST_ENV[k]); Object.assign(GST_ENV, env); return r; };
        return attempt(LAUNCHER, [], {}, null).then((r) => {
            if (r) return ok(r, LAUNCHER, [], {});
            found = this.search = findGst();
            log('info', 'GStreamer search: ' + JSON.stringify(found));
            const ways = [];
            found.libs.forEach((lib) => {
                ways.push([LAUNCHER, [], gstEnvFor(lib), lib]);
                found.loaders.forEach((ld) => ways.push([ld, [LAUNCHER], gstEnvFor(lib), lib + ' through ' + ld]));
            });
            if (!found.libs.length) found.loaders.forEach((ld) => ways.push([ld, [LAUNCHER], {}, 'through ' + ld]));
            const next = (k) => (k >= ways.length ? Promise.resolve(null) : attempt(ways[k][0], ways[k][1], ways[k][2], ways[k][3])
                .then((res) => (res ? ok(res, ways[k][0], ways[k][1], ways[k][2]) : next(k + 1))));
            return next(0);
        }).then((r) => {
            if (r) return r;
            tries.forEach((t) => log('warn', 'ida-gst probe ' + t));
            // gst-launch-1.0 found outside PATH
            if (!this.gst.launch && found && found.launch[0]) { this.gst.launch = found.launch[0]; this.gst.inspect = found.inspect[0] || null; }
            const s = found || { libs: [], old: [] };
            const error = s.libs.length ? 'GStreamer found (' + s.libs[0] + ') but it doesn\'t start: ' + (tries[tries.length - 1] || '').replace(/^[^:]*: /, '')
                : s.old.length ? 'only GStreamer 0.10 here (' + s.old[0] + '): too old'
                : 'GStreamer is not on this head unit: no libgstreamer-1.0 anywhere (see probe.txt)';
            return { error: error };
        });
    }

    _probeInspect() {
        if (!this.gst.launch || !this.gst.inspect) return Promise.resolve({});
        return new Promise((resolve) => {
            execFile(this.gst.inspect, [], { maxBuffer: 16 * 1024 * 1024, timeout: 30000, env: displayEnv() }, (err, out) => {
                execFile(this.gst.inspect, ['--version'], (e2, ver) => {
                    const v = /GStreamer\s+([\d.]+)/.exec(ver || '');
                    resolve({ version: v ? v[1] : null, elements: parseInspect(out || ''), via: 'gst-inspect-1.0' });
                });
            });
        });
    }

    /* probe.txt: the video elements found, to read or send when nothing works */
    _report(r) {
        try {
            const els = r.elements || {};
            const lines = Object.keys(els).filter((n) => /video|264|265|hevc|avc|dec|sink/i.test(n + ' ' + els[n].klass)).sort()
                .map((n) => n + '\t' + els[n].rank + '\t' + els[n].klass);
            fs.mkdirSync(DATA, { recursive: true });
            fs.writeFileSync(path.join(DATA, 'probe.txt'), JSON.stringify(this.probe, null, 1) + '\n\n' + lines.join('\n') + '\n');
        } catch (e) { /* only a report */ }
    }

    /* the decoder and display devices there are (a hint when nothing is found) */
    _devices() {
        const out = [];
        ['/dev', '/dev/dri'].forEach((d) => {
            try { fs.readdirSync(d).forEach((f) => { if (/^(video\d+|card\d+|renderD\d+|mxc_vpu|vpu.*|fb\d+)$/.test(f)) out.push(path.join(d, f)); }); } catch (e) { /* none */ }
        });
        return out;
    }

    _client(s) {
        this.clients.add(s);
        s.setEncoding('utf8');
        let buf = '';
        s.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (!line) continue;
                let m;
                try { m = JSON.parse(line); } catch (e) { continue; }
                this._handle(m).then((r) => this._send(s, Object.assign({ id: m.id, ok: true }, r)),
                    (err) => this._send(s, { id: m.id, ok: false, error: err.message }));
            }
        });
        s.on('error', () => { /* gone */ });
        s.on('close', () => this.clients.delete(s));
        if (this.pads.current) this._send(s, { ev: 'pad', name: this.pads.current.name, state: this.pads.current.state });
    }
    _send(s, m) { if (!s.destroyed) s.write(JSON.stringify(m) + '\n'); }
    _broadcast(m) { this.clients.forEach((s) => this._send(s, m)); }

    _handle(m) {
        if (m.op === 'probe') return (m.again || !this.probe ? this._probe() : Promise.resolve(this.probe)).then((p) => Object.assign({ version: VERSION }, p));
        if (m.op === 'stop') { this._stop('asked'); return Promise.resolve({}); }
        if (m.op === 'view') return this._view(m);
        if (m.op === 'status') return Promise.resolve({ running: this.what, stats: this.stats });
        if (m.op === 'test') {
            const p = this.probe;
            if (!p || !p.gst || !p.sink) return Promise.reject(new Error(p ? p.why : 'not probed'));
            const o = { width: clamp(m.width, 320, 3840, 1280), height: clamp(m.height, 240, 2160, 720), fps: clamp(m.fps, 10, 120, 60),
                seconds: clamp(m.seconds, 2, 30, 8), rect: m.rect };
            const sample = p.decoders.h264 && fileExists(SAMPLES.test) ? SAMPLES.test : null;
            o.sample = sample;
            const proc = this._run('test', testPipeline(p, o), { fps: o.fps, frames: sample ? SAMPLES.testFrames : Math.round(o.fps * o.seconds) });
            // a test that never ends (a decoder or display that stalls) is stopped, so the next one can run
            const dog = setTimeout(() => { if (this.proc === proc) { log('warn', 'test: no end after ' + (o.seconds * 3 + 15) + ' s, stopping it'); this._stop('stalled'); } }, (o.seconds * 3 + 15) * 1000);
            proc.on('exit', () => clearTimeout(dog));
            return Promise.resolve({ pipeline: testPipeline(p, o), throughDecoder: !!sample });
        }
        return Promise.reject(new Error('unknown op ' + m.op));
    }

    /* one pipeline at a time: a new one replaces the old. Its rate: a test's frames over the time from PLAYING to the
     * end; a stream's pictures counted on the way in (FrameCounter), reported every second */
    _run(what, pipeline, o) {
        this._stop('replaced');
        log('info', what + ': ' + (this.gst.launcher ? 'ida-gst launch ' : 'gst-launch-1.0 ') + pipeline);
        const run = this._cmd(pipeline);
        const cmd = run[0], argv = run[1];
        const proc = spawn(cmd, argv, { env: displayEnv(), stdio: [o.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
        this.proc = proc; this.what = what;
        const st = this.stats = { what: what, target: o.fps, frames: o.frames || 0, fps: null, playingAt: 0, started: Date.now() };
        let tail = '';
        const read = (d) => String(d).split('\n').forEach((l) => {
            if (/Setting pipeline to PLAYING/.test(l) && !st.playingAt) { st.playingAt = Date.now(); this._broadcast({ ev: 'video', what: what, state: 'playing', target: o.fps }); }
            else if (/ERROR|WARNING|not-negotiated|Could not/.test(l)) { tail = l.trim(); log('warn', l.trim()); }
        });
        proc.stdout.on('data', read);
        proc.stderr.on('data', read);
        proc.on('error', (e) => { tail = e.message; });
        proc.on('exit', (code) => {
            clearInterval(st.timer);
            if (what === 'test' && st.playingAt && code === 0) st.fps = st.frames / ((Date.now() - st.playingAt) / 1000);
            if (this.proc !== proc) return;
            this.proc = null; this.what = null;
            const ok = code === 0;
            log(ok ? 'info' : 'warn', what + ' ended (' + code + ')' + (st.fps ? ': ' + st.fps.toFixed(1) + ' fps' : '') + (tail ? ': ' + tail : ''));
            this._broadcast({ ev: 'video', what: what, state: ok ? 'stopped' : 'failed', fps: st.fps, target: o.fps, frames: st.frames, reason: ok ? null : tail || 'exit ' + code });
        });
        return proc;
    }

    _stop(why) {
        if (!this.proc) return;
        const p = this.proc, st = this.stats;
        this.proc = null;
        clearInterval(st && st.timer);
        log('info', 'stopping ' + this.what + ' (' + why + ')');
        try { if (p.stdin) p.stdin.end(); } catch (e) { /* closed */ }
        try { p.kill('SIGINT'); } catch (e) { /* gone */ }
        setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } }, 1500);
        this._broadcast({ ev: 'video', what: this.what, state: 'stopped', fps: st && st.fps });
        this.what = null;
    }

    /* the engine's video: a header line, then the elementary stream straight into the decoder */
    _stream(s) {
        let head = Buffer.alloc(0), live = null;
        s.on('data', (d) => {
            if (live) return;
            head = Buffer.concat([head, d]);
            const nl = head.indexOf(10);
            if (nl < 0) { if (head.length > 4096) s.destroy(); return; }
            let h;
            try { h = JSON.parse(head.slice(0, nl).toString('utf8')); } catch (e) { log('warn', 'stream: bad header'); s.destroy(); return; }
            const rest = head.slice(nl + 1);
            const codec = h.codec === 'h265' ? 'h265' : 'h264';
            if (!(this.probe && this.probe.gst && streamPipeline(this.probe, codec, null))) { log('warn', 'stream: no ' + codec + ' decoder'); s.destroy(); return; }
            live = this.live = {
                sock: s, codec: codec, fps: clamp(h.fps, 10, 120, 60), area: h.rect || null, aspect: aspectOf(h.aspect),
                size: h.width > 0 && h.height > 0 ? { width: h.width | 0, height: h.height | 0 } : null,
                keeper: new StreamKeeper(codec), count: new FrameCounter(codec), proc: null, view: null,
            };
            s.removeAllListeners('data');
            this._launch(live, null);
            const feed = (chunk) => {
                live.count.push(chunk);
                const ev = live.keeper.push(chunk);
                if (ev.size && live.aspect && (!live.size || ev.size.width !== live.size.width || ev.size.height !== live.size.height)) {
                    live.size = ev.size;
                    this._launch(live, 'the picture is now ' + ev.size.width + 'x' + ev.size.height);   // it's given the replay, this chunk included
                    return;
                }
                if (ev.size) live.size = ev.size;
                this._write(live, chunk);
            };
            if (rest.length) feed(rest);
            s.on('data', feed);
        });
        s.on('error', () => { /* gone */ });
        s.on('close', () => {
            if (!live) return;
            if (this.live === live) this.live = null;
            if (live.proc && this.proc === live.proc) this._stop('stream closed');
        });
    }

    _write(live, buf) {
        const proc = live.proc;
        if (!proc || !buf.length) return;
        if (!proc.stdin.write(buf)) { live.sock.pause(); proc.stdin.once('drain', () => live.sock.resume()); }
    }

    /* the stream's pipeline, (again) in the shape asked for: a pipeline started again mid-stream is given the stream
     * from its last keyframe, so the picture comes back at once */
    _launch(live, why) {
        const v = live.aspect ? viewFor(live.area, live.size, live.aspect) : { rect: live.area, par: null, ratio: null };
        const pl = streamPipeline(this.probe, live.codec, v.rect, v.par);
        const old = live.proc;
        if (old) {
            log('info', 'stream: again (' + why + ')');
            clearInterval(this.stats && this.stats.timer);
            this.proc = null;                // its end is not the stream's end
            try { old.stdin.end(); } catch (e) { /* closed */ }
            try { old.kill('SIGINT'); } catch (e) { /* gone */ }
            setTimeout(() => { try { old.kill('SIGKILL'); } catch (e) { /* gone */ } }, 1500);
        }
        if (v.par && !this.probe.capssetter) log('warn', 'stream: no capssetter here: a display that keeps the picture\'s own shape shows it ' + (live.aspect === 'fit' ? '' : 'in its own shape ') + 'inside ' + JSON.stringify(v.rect));
        const proc = this._run('stream', pl, { input: true, fps: live.fps });
        live.proc = proc;
        live.view = v;
        proc.stdin.on('error', () => { if (live.proc === proc) live.sock.destroy(); });
        if (old) this._write(live, live.keeper.replay());
        const st = this.stats, count = live.count;
        let last = count.frames, lastAt = Date.now();
        st.timer = setInterval(() => {
            const now = Date.now(), n = count.frames - last;
            st.fps = n / ((now - lastAt) / 1000); st.frames = count.frames;
            last = count.frames; lastAt = now;
            this._broadcast({ ev: 'video', what: 'stream', state: 'playing', fps: st.fps, frames: st.frames, target: live.fps });
        }, 1000);
        this._broadcast({ ev: 'video', what: 'stream', state: 'view', aspect: live.aspect, rect: v.rect, par: v.par, size: live.size, exact: !v.par || !!this.probe.capssetter });
    }

    /* {"op":"view","aspect","rect"}: the playing stream in a new shape (or place) */
    _view(m) {
        const live = this.live;
        if (m.aspect !== undefined && m.aspect !== null && !aspectOf(m.aspect)) return Promise.reject(new Error('unknown aspect ' + m.aspect));
        if (!live || !live.proc) return Promise.resolve({ playing: false });
        const aspect = m.aspect ? aspectOf(m.aspect) : live.aspect, area = m.rect || live.area;
        if (aspect !== live.aspect || JSON.stringify(area) !== JSON.stringify(live.area)) {
            live.aspect = aspect; live.area = area;
            this._launch(live, 'shown ' + (aspect || 'as given'));
        }
        return Promise.resolve({ playing: true, aspect: live.aspect, view: live.view, size: live.size });
    }
}

function fileExists(p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }

function clamp(v, lo, hi, def) { v = Number(v); return isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : def; }

if (require.main === module) {
    log('info', 'Remote Play Video ' + VERSION + ' starting');
    new VideoTool().start();
}

module.exports = { VideoTool, FrameCounter, StreamKeeper, findGst, gstEnvFor, parseInspect, parseProbe, decodersFor, choose, whyNot, streamPipeline, testPipeline, args,
    viewFor, aspectOf, spsSize, ASPECTS, DECODERS, SINKS, LAUNCHER, SAMPLES };
