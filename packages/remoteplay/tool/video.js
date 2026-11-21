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

const VERSION = '1.0.0';
const RUN = process.env.RPV_RUN || '/run/ida-remoteplay-video';
const CTL = path.join(RUN, 'ctl.sock');
const STREAM = path.join(RUN, 'stream.sock');
const DATA = process.env.RPV_DATA || '/var/opt/ida-remoteplay-video';
const SETTINGS = path.join(DATA, 'settings.json');

/* decoders by codec, hardware first; the last of each is software (works everywhere, rarely at 60 fps) */
const DECODERS = {
    h264: ['v4l2h264dec', 'v4l2slh264dec', 'omxh264dec', 'vaapih264dec', 'nvv4l2decoder', 'imxvpudec_h264', 'vpudec', 'mfxh264dec', 'avdec_h264'],
    h265: ['v4l2h265dec', 'v4l2slh265dec', 'omxh265dec', 'vaapih265dec', 'nvv4l2decoder', 'imxvpudec_h265', 'vpudec', 'mfxh265dec', 'avdec_h265'],
};
const SOFTWARE = ['avdec_h264', 'avdec_h265'];
const PARSERS = { h264: 'h264parse', h265: 'h265parse' };
const ENCODERS = ['v4l2h264enc', 'omxh264enc', 'vaapih264enc', 'imxvpuenc_h264', 'vpuenc_h264', 'x264enc', 'openh264enc'];
const SINKS = ['waylandsink', 'glimagesink', 'kmssink', 'ximagesink', 'fbdevsink', 'autovideosink'];

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

/* gst-inspect-1.0 with no arguments: "plugin:  element: description" lines -> the element names */
function parseInspect(text) {
    const out = {};
    String(text).split('\n').forEach((l) => { const m = /^\s*[\w.-]+:\s+([\w.-]+):\s/.exec(l); if (m) out[m[1]] = true; });
    return out;
}

/* what to use, from what is installed and the settings */
function choose(elements, settings) {
    settings = settings || {};
    const pick = (list, forced) => (forced && elements[forced] ? forced : list.filter((e) => elements[e])[0] || null);
    const dec = { h264: pick(DECODERS.h264, settings.decoder && settings.decoder.h264), h265: pick(DECODERS.h265, settings.decoder && settings.decoder.h265) };
    const sink = pick(SINKS, settings.sink);
    return {
        decoders: dec,
        decoder: dec.h264 || dec.h265,
        hardware: !!(dec.h264 && SOFTWARE.indexOf(dec.h264) < 0),
        hardwareH265: !!(dec.h265 && SOFTWARE.indexOf(dec.h265) < 0),
        encoder: pick(ENCODERS, settings.encoder),
        sink: sink,
        sinkProps: settings.sinkProps || '',
        converter: elements.videoconvert ? 'videoconvert' : null,
    };
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
    const conv = SOFTWARE.indexOf(dec) >= 0 && c.converter ? ' ! ' + c.converter : '';
    return 'fdsrc fd=0 ! ' + PARSERS[codec] + ' ! ' + dec + conv + ' ! ' + sinkPart(c, rect);
}
/* the test: a moving picture, encoded and decoded the way a stream is when there is an encoder, else shown directly.
 * The source is live at the asked rate; when decoding or the display can't keep up it is held back, so frames over the
 * time from PLAYING to the end is the rate the car really shows. */
function testPipeline(c, o) {
    const src = 'videotestsrc is-live=true pattern=ball num-buffers=' + Math.round(o.fps * o.seconds) +
        ' ! video/x-raw,width=' + o.width + ',height=' + o.height + ',framerate=' + o.fps + '/1';
    const through = c.encoder && c.decoders.h264 ? ' ! ' + c.encoder + ' ! h264parse ! ' + c.decoders.h264 : '';
    const conv = c.converter ? ' ! ' + c.converter : '';
    return src + through + conv + ' ! ' + sinkPart(c, o.rect);
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
        this.gst = { launch: which('gst-launch-1.0'), inspect: which('gst-inspect-1.0'), version: null };
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

    _probe() {
        if (!this.gst.launch || !this.gst.inspect) {
            this.probe = { gst: null, error: 'GStreamer (gst-launch-1.0) is not on this head unit' };
            log('warn', this.probe.error);
            return Promise.resolve(this.probe);
        }
        return new Promise((resolve) => {
            execFile(this.gst.inspect, [], { maxBuffer: 8 * 1024 * 1024, env: displayEnv() }, (err, out) => {
                const elements = parseInspect(out || '');
                execFile(this.gst.inspect, ['--version'], (e2, ver) => {
                    const v = /GStreamer\s+([\d.]+)/.exec(ver || '');
                    const c = choose(elements, readSettings());
                    this.probe = Object.assign({ gst: v ? v[1] : 'unknown', elements: Object.keys(elements).length,
                        devices: this._devices(), display: displayEnv().WAYLAND_DISPLAY || null }, c);
                    log('info', 'probe: ' + JSON.stringify(this.probe));
                    resolve(this.probe);
                });
            });
        });
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
            if (!p || !p.gst) return Promise.reject(new Error(p && p.error || 'not probed'));
            if (!p.sink) return Promise.reject(new Error('no video display element on this head unit'));
            const o = { width: clamp(m.width, 320, 3840, 1280), height: clamp(m.height, 240, 2160, 720), fps: clamp(m.fps, 10, 120, 60),
                seconds: clamp(m.seconds, 2, 30, 8), rect: m.rect };
            this._run('test', testPipeline(p, o), { fps: o.fps, frames: Math.round(o.fps * o.seconds) });
            return Promise.resolve({ pipeline: testPipeline(p, o), throughDecoder: !!(p.encoder && p.decoders.h264) });
        }
        return Promise.reject(new Error('unknown op ' + m.op));
    }

    /* one pipeline at a time: a new one replaces the old. Its rate: a test's frames over the time from PLAYING to the
     * end; a stream's pictures counted on the way in (FrameCounter), reported every second */
    _run(what, pipeline, o) {
        this._stop('replaced');
        log('info', what + ': gst-launch-1.0 ' + pipeline);
        const proc = spawn(this.gst.launch, ['-e'].concat(args(pipeline)), { env: displayEnv(), stdio: [o.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
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

function clamp(v, lo, hi, def) { v = Number(v); return isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : def; }

if (require.main === module) {
    log('info', 'Remote Play Video ' + VERSION + ' starting');
    new VideoTool().start();
}

module.exports = { VideoTool, FrameCounter, parseInspect, choose, streamPipeline, testPipeline, args, DECODERS, SINKS };
