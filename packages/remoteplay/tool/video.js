'use strict';
/*
 * Remote Play Video: a root tool that puts the console's video on the car's screen at the stream's full frame rate,
 * through the head unit's own GStreamer and hardware decoder (an app can't: it has no decoder and draws pictures only
 * through the renderer, a few a second). It also reads a USB gamepad plugged into the car (gamepad.js).
 *
 * Control socket /run/ida-remoteplay-video/ctl.sock (0666; the app runs as its own user), JSON lines, one reply per
 * request ("id" echoed), events ("ev") at any time; see the app's links.js for the messages.
 *
 * Stream socket /run/ida-remoteplay-video/stream.sock: the stream engine connects, writes one JSON line
 *   {"codec":"h264"|"h265","width":1280,"height":720,"fps":60,"rect":{x,y,w,h}}
 * then the video as an Annex B elementary stream. Each connection is one pipeline:
 *   fdsrc ! <parser> ! <decoder> ! [videoconvert !] <sink> sync=false
 * sync=false: frames show as they arrive (a game stream has no clock to keep), so the rate is the console's.
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

const VERSION = '1.1.0';
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

/* the display's session for a wayland sink: the compositor's socket, wherever the head unit keeps it */
function displayEnv() {
    const env = Object.assign({}, process.env);
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
function streamPipeline(c, codec, rect) {
    const dec = c.decoders[codec];
    if (!dec) return null;
    const conv = (SOFTWARE.test(dec) || dec === 'decodebin') && c.converter ? ' ! ' + c.converter : '';
    return 'fdsrc fd=0 ! ' + PARSERS[codec] + ' ! ' + dec + conv + ' ! ' + sinkPart(c, rect);
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
        return this._probeLauncher().then((r) => r || this._probeInspect()).then((r) => {
            const base = { devices: this._devices(), display: displayEnv().WAYLAND_DISPLAY || null };
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
        const cmd = this.gst.launcher || this.gst.launch;
        const argv = this.gst.launcher ? ['launch'].concat(args(pl)) : ['-e'].concat(args(pl));
        return new Promise((resolve) => {
            execFile(cmd, argv, { timeout: CHECK_MS, env: displayEnv(), maxBuffer: 1024 * 1024 }, (err, out, errOut) => {
                if (!err) { resolve(null); return; }
                const m = /ERROR:?\s*(.*)/.exec(String(out) + '\n' + String(errOut));
                resolve(err.killed ? 'no end within ' + CHECK_MS / 1000 + ' s' : (m ? m[1] : 'exit ' + err.code).slice(0, 160));
            });
        });
    }

    _probeLauncher() {
        return new Promise((resolve) => {
            try { fs.accessSync(LAUNCHER, fs.constants.X_OK); } catch (e) { resolve(null); return; }
            execFile(LAUNCHER, ['probe'], { maxBuffer: 16 * 1024 * 1024, timeout: 30000, env: displayEnv() }, (err, out) => {
                const p = parseProbe(out || '');
                if (p.version && Object.keys(p.elements).length) { this.gst.launcher = LAUNCHER; resolve({ version: p.version, elements: p.elements, via: 'ida-gst' }); return; }
                const why = /ERROR: (.*)/.exec(out || '');
                log('warn', 'ida-gst probe: ' + (why ? why[1] : err ? err.message : 'nothing'));
                resolve(why ? { error: why[1] } : null);
            });
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
        const cmd = this.gst.launcher || this.gst.launch;
        const argv = this.gst.launcher ? ['launch'].concat(args(pipeline)) : ['-e'].concat(args(pipeline));
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
        let head = Buffer.alloc(0), proc = null;
        s.on('data', (d) => {
            if (proc) return;
            head = Buffer.concat([head, d]);
            const nl = head.indexOf(10);
            if (nl < 0) { if (head.length > 4096) s.destroy(); return; }
            let h;
            try { h = JSON.parse(head.slice(0, nl).toString('utf8')); } catch (e) { log('warn', 'stream: bad header'); s.destroy(); return; }
            const rest = head.slice(nl + 1);
            const codec = h.codec === 'h265' ? 'h265' : 'h264';
            const pl = this.probe && this.probe.gst ? streamPipeline(this.probe, codec, h.rect) : null;
            if (!pl) { log('warn', 'stream: no ' + codec + ' decoder'); s.destroy(); return; }
            const fps = clamp(h.fps, 10, 120, 60);
            proc = this._run('stream', pl, { input: true, fps: fps });
            const st = this.stats, count = new FrameCounter(codec);
            let last = 0, lastAt = Date.now();
            st.timer = setInterval(() => {
                const now = Date.now(), n = count.frames - last;
                st.fps = n / ((now - lastAt) / 1000); st.frames = count.frames;
                last = count.frames; lastAt = now;
                this._broadcast({ ev: 'video', what: 'stream', state: 'playing', fps: st.fps, frames: st.frames, target: fps });
            }, 1000);
            s.removeAllListeners('data');
            const feed = (chunk) => { count.push(chunk); if (!proc.stdin.write(chunk)) { s.pause(); proc.stdin.once('drain', () => s.resume()); } };
            if (rest.length) feed(rest);
            s.on('data', feed);
            proc.stdin.on('error', () => s.destroy());
        });
        s.on('error', () => { /* gone */ });
        s.on('close', () => { if (proc && this.proc === proc) this._stop('stream closed'); });
    }
}

function fileExists(p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }

function clamp(v, lo, hi, def) { v = Number(v); return isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : def; }

if (require.main === module) {
    log('info', 'Remote Play Video ' + VERSION + ' starting');
    new VideoTool().start();
}

module.exports = { VideoTool, FrameCounter, parseInspect, parseProbe, decodersFor, choose, whyNot, streamPipeline, testPipeline, args, DECODERS, SINKS, LAUNCHER, SAMPLES };
