'use strict';
/*
 * AirPlay: the app's screens, drawn by the head unit's renderer (gpu.js) over the HMI page. Pure: draw(rec, model)
 * records a frame (renderd draw ops) and returns what a tap can press. The recorder and glyph atlases are Light
 * Logger's (as Remote Play's). Tested and previewed on a desktop.
 *
 *   home     the receiver, the phone, the video path, parked or not; the picture's shape; the buttons; the PIN to type
 *   mirror   the phone's screen: the video tool draws it on the head unit's display, in the area right of the band; the
 *            band on the left has the picture's shape (Fit, Stretch, 16:9, ...) and Disconnect
 *   logs     the app's log, newest first
 */
const FONT = require('./ui_font.js');

const OP = { CLEAR: 1, RECT: 2, RRECT: 4, RSTROKE: 5, GLYPHS: 11, QUAD: 15, IMAGE: 18 };


function pack(c) { return (((c[0] & 255) << 24) | ((c[1] & 255) << 16) | ((c[2] & 255) << 8) | (c[3] & 255)) >>> 0; }

/* ---- glyph atlases: one per style, packed in rows, built once ---- */
const atlases = {};
function atlas(style) {
    if (atlases[style]) return atlases[style];
    const f = FONT[style], AW = 1024, pad = 2;
    const glyphs = {};
    let x = pad, y = pad, rowH = 0;
    const place = [];
    Object.keys(f.glyphs).forEach((ch) => {
        const g = f.glyphs[ch], w = g[3], h = g[4];
        if (x + w + pad > AW) { x = pad; y += rowH + pad; rowH = 0; }
        place.push([ch, x, y]);
        glyphs[ch] = { adv: g[0], ox: g[1], oy: g[2], w: w, h: h, x: x, y: y };
        x += w + pad;
        rowH = Math.max(rowH, h);
    });
    let AH = 64;
    while (AH < y + rowH + pad) AH *= 2;
    const alpha = Buffer.alloc(AW * AH);
    place.forEach((p) => {
        const g = f.glyphs[p[0]], w = g[3], h = g[4];
        if (!w || !h) return;
        const src = Buffer.from(g[5], 'base64');
        for (let r = 0; r < h; r++) src.copy(alpha, (p[2] + r) * AW + p[1], r * w, r * w + w);
    });
    let id = 0;
    const key = 'ida_airplay/' + style + '@' + f.px;
    for (let i = 0; i < key.length; i++) id = (Math.imul(id, 31) + key.charCodeAt(i)) >>> 0;
    atlases[style] = { id: (id | 1) >>> 0, w: AW, h: AH, alpha: alpha, glyphs: glyphs, px: f.px, ascent: f.ascent };
    return atlases[style];
}

/* ---- a frame's draw ops ---- */
class Recorder {
    constructor() { this.u = new Uint32Array(16384); this.f = new Float32Array(this.u.buffer); this.n = 0; this.atlases = []; this.images = []; }
    reset() { this.n = 0; this.atlases = []; this.images = []; return this; }
    /* an uploaded picture over x, y, w, h, corner radius r (op 18: x y w h r as floats, then the id) */
    image(id, x, y, w, h, r) {
        this._grow(7); const i = this.n, f = this.f;
        this.u[i] = OP.IMAGE; f[i + 1] = x; f[i + 2] = y; f[i + 3] = w; f[i + 4] = h; f[i + 5] = r || 0; this.u[i + 6] = id >>> 0;
        this.n += 7;
        if (this.images.indexOf(id) < 0) this.images.push(id);
        return this;
    }
    words() { return this.u.subarray(0, this.n); }
    _grow(k) {
        if (this.n + k <= this.u.length) return;
        const u = new Uint32Array(Math.max(this.u.length * 2, this.n + k));
        u.set(this.u.subarray(0, this.n));
        this.u = u; this.f = new Float32Array(u.buffer);
    }
    clear(c) { this._grow(2); this.u[this.n++] = OP.CLEAR; this.u[this.n++] = pack(c); return this; }
    rect(x, y, w, h, c) {
        if (!(w > 0 && h > 0)) return this;
        this._grow(6); const i = this.n, f = this.f;
        this.u[i] = OP.RECT; f[i + 1] = x; f[i + 2] = y; f[i + 3] = w; f[i + 4] = h; this.u[i + 5] = pack(c);
        this.n += 6; return this;
    }
    rrect(x, y, w, h, r, c) {
        if (!(w > 0 && h > 0)) return this;
        this._grow(7); const i = this.n, f = this.f;
        this.u[i] = OP.RRECT; f[i + 1] = x; f[i + 2] = y; f[i + 3] = w; f[i + 4] = h; f[i + 5] = r; this.u[i + 6] = pack(c);
        this.n += 7; return this;
    }
    stroke(x, y, w, h, r, width, c) {
        this._grow(8); const i = this.n, f = this.f;
        this.u[i] = OP.RSTROKE; f[i + 1] = x; f[i + 2] = y; f[i + 3] = w; f[i + 4] = h; f[i + 5] = r; f[i + 6] = width; this.u[i + 7] = pack(c);
        this.n += 8; return this;
    }
    /* a filled convex quad, points in order (a triangle: one point twice) */
    quad(pts, c) {
        this._grow(10); let i = this.n; const f = this.f;
        this.u[i++] = OP.QUAD;
        pts.forEach((p) => { f[i++] = p[0]; f[i++] = p[1]; });
        this.u[i++] = pack(c);
        this.n = i; return this;
    }
    width(style, s, spacing) {
        const a = atlas(style);
        let w = 0;
        for (const ch of String(s)) { const g = a.glyphs[ch] || a.glyphs['?']; if (g) w += g.adv; }
        return w + (spacing || 0) * Math.max(0, String(s).length - 1);
    }
    /* text, y the baseline; align 'left' | 'right' | 'center'; returns its width */
    text(style, s, x, y, c, align, spacing) {
        s = String(s);
        const a = atlas(style), sp = spacing || 0, w = this.width(style, s, sp);
        let pen = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
        const head = this.n;
        this._grow(4 + s.length * 8);
        let i = head + 4, cnt = 0;
        const f = this.f;
        for (const ch of s) {
            const g = a.glyphs[ch] || a.glyphs['?'];
            if (!g) continue;
            if (g.w && g.h) {
                f[i++] = Math.round(pen + g.ox); f[i++] = y + g.oy; f[i++] = g.w; f[i++] = g.h;
                f[i++] = g.x; f[i++] = g.y; f[i++] = g.x + g.w; f[i++] = g.y + g.h;
                cnt++;
            }
            pen += g.adv + sp;
        }
        if (cnt) {
            this.u[head] = OP.GLYPHS; this.u[head + 1] = a.id; this.u[head + 2] = pack(c); this.u[head + 3] = cnt;
            this.n = i;
            if (this.atlases.indexOf(a) < 0) this.atlases.push(a);
        }
        return w;
    }
}



const W = 2880, H = 764;
const C = {
    bg: [9, 11, 16, 255], card: [17, 20, 28, 255], line: [36, 41, 54, 255], tile: [25, 29, 40, 255],
    text: [242, 244, 248, 255], dim: [138, 147, 166, 255], faint: [86, 93, 110, 255],
    green: [60, 192, 122, 255], orange: [240, 160, 48, 255], red: [229, 67, 46, 255], accent: [30, 123, 224, 255],
    white: [255, 255, 255, 255], black: [0, 0, 0, 255], clear: [0, 0, 0, 0], control: [20, 24, 34, 200], controlOn: [30, 123, 224, 230],
};

/* s cut to fit maxW (with an ellipsis) */
function fit(rec, style, s, maxW) {
    s = String(s);
    if (rec.width(style, s) <= maxW) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rec.width(style, s.slice(0, mid) + '...') <= maxW) lo = mid; else hi = mid - 1; }
    return s.slice(0, lo) + '...';
}

/* ---- the Logs screen: newest first, a page at a time ---- */
const LOG_PER_PAGE = 11;
const pad2 = (n) => (n < 10 ? '0' : '') + n;
function clock(t) { const d = new Date(t); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
function logPages(n, per) { return Math.max(1, Math.ceil(n / (per || LOG_PER_PAGE))); }
function logLines(lines, page, per) {
    per = per || LOG_PER_PAGE;
    return (lines || []).slice().reverse().slice(page * per, page * per + per);
}
function logText(l) { return clock(l.t) + '  ' + (l.level === 'info' ? '' : l.level.toUpperCase() + '  ') + l.text; }

function pill(rec, m, targets, key, label, x, y, w, h, o) {
    o = o || {};
    const off = !!o.disabled;
    rec.rrect(x, y, w, h, Math.min(h / 2, 32), o.fill || (m.focus === key ? [33, 43, 64, 255] : C.tile));
    rec.text(o.style || 'body', label, x + w / 2, y + h / 2 + 12, off ? C.faint : (o.color || C.text), 'center');
    if (!off && m.pressed === key) rec.rrect(x, y, w, h, Math.min(h / 2, 32), [255, 255, 255, 30]);
    if (m.focus === key) rec.stroke(x, y, w, h, Math.min(h / 2, 32), 4, C.accent);
    if (!off) targets.push({ key: key, x: x, y: y, w: w, h: h });
}

function dot(rec, x, y, c) { rec.rrect(x - 9, y - 9, 18, 18, 9, c); }

/* one row of the home screen's status card */
function row(rec, x, y, w, label, value, state) {
    rec.text('small', label.toUpperCase(), x, y, C.faint, 'left', 3);
    dot(rec, x + 10, y + 42, state === 'ok' ? C.green : state === 'warn' ? C.orange : state === 'bad' ? C.red : C.faint);
    rec.text('body', fit(rec, 'body', value, w - 40), x + 34, y + 54, state === 'none' ? C.dim : C.text);
}

/* the picture's shapes, in the order the button goes through them, and their labels */
const ASPECTS = ['fit', 'stretch', '16:9', '16:10', '4:3', '21:9', '1:1'];
const ASPECT_LABEL = { fit: 'Fit', stretch: 'Stretch', '16:9': '16:9', '16:10': '16:10', '4:3': '4:3', '21:9': '21:9', '1:1': '1:1' };
function aspectLabel(a) { return ASPECT_LABEL[a] || a; }
function nextAspect(a) { return ASPECTS[(ASPECTS.indexOf(a) + 1) % ASPECTS.length]; }

/* the Mirror screen: the band on the left (the controls), the phone's screen in the rest */
const BAND = { x: 0, y: 0, w: 300, h: H };
const VIDEO = { x: 320, y: 0, w: W - 320, h: H };

/* the shape buttons: a grid of pills, the current one lit */
function shapes(rec, m, targets, x, y, cols, w, h, gap, style) {
    ASPECTS.forEach((a, i) => {
        const on = m.aspect === a;
        pill(rec, m, targets, 'apA_' + a, aspectLabel(a), x + (i % cols) * (w + gap), y + Math.floor(i / cols) * (h + gap), w, h,
            { style: style || 'strong', fill: on ? C.accent : null });
    });
}

function home(rec, m, targets) {
    rec.text('title', 'AirPlay', 90, 86, C.text);
    if (m.note) rec.text('body', fit(rec, 'body', m.note, 1400), 400, 84, m.warn ? C.orange : C.dim);

    const S = { x: 90, y: 120, w: 1640, h: 520 };
    rec.rrect(S.x, S.y, S.w, S.h, 28, C.card);
    const col = (i) => S.x + 50 + i * 800, line = (j) => S.y + 60 + j * 120;
    const e = m.engine, r = m.receiver || {};
    const rtext = !e ? 'AirPlay Engine not installed' : !m.enabled ? 'Off' : r.on ? '"' + r.name + '"  ·  ' + (r.net ? (/Bonjour/.test(r.net) ? 'through the car\'s Bonjour' : r.net) : m.addresses && m.addresses.length ? m.addresses.join(', ') : 'no network yet') :
        r.error ? r.error : m.parked !== true ? 'Waits until the car is parked' : 'Starting...';
    row(rec, col(0), line(0), 760, 'Receiver', rtext, !e || r.error ? 'bad' : r.on ? 'ok' : m.enabled ? 'warn' : 'none');
    const p = m.phone;
    row(rec, col(1), line(0), 760, 'Phone', p ? p.name + (p.state ? '  ·  ' + p.state : '') : 'None yet', p && p.state === 'mirroring' ? 'ok' : p ? 'warn' : 'none');
    const v = m.video || {};
    const vtext = !v.tool ? 'Remote Play Video not installed' : !v.probe ? 'Checking the decoders (up to a minute)...' : v.probe.why ? v.probe.why :
        v.probe.decoder + (v.probe.auto ? ' (the head unit\'s choice)' : v.probe.hardware ? ' (hardware)' : ' (software)') + '  ·  ' + (v.probe.sink || 'no display');
    row(rec, col(0), line(1), 760, 'Video', vtext, !v.tool ? 'bad' : !v.probe ? 'warn' : v.probe.decoder && v.probe.hardware ? 'ok' : v.probe.decoder ? 'warn' : 'bad');
    row(rec, col(1), line(1), 760, 'Access', m.access === 'open' ? 'Open: any phone on the network' : 'A PIN the first time a phone connects', m.access === 'open' ? 'warn' : 'ok');
    row(rec, col(0), line(2), 760, 'Picture shape', aspectLabel(m.aspect) + (m.aspect === 'fit' ? ': the phone\'s own shape' : m.aspect === 'stretch' ? ': the whole screen' : ''), 'ok');
    row(rec, col(1), line(2), 760, 'Car', m.parked === true ? 'Parked: mirroring allowed' : m.parked === false ? 'Moving: only while parked' : 'Waiting for the speed', m.parked === true ? 'ok' : m.parked === false ? 'bad' : 'warn');
    rec.text('small', 'ON THE IPHONE OR IPAD', col(0), line(3), C.faint, 'left', 3);
    rec.text('body', fit(rec, 'body', 'The phone on the car\'s Wi-Fi (or the car on the phone\'s hotspot): Control Center > Screen Mirroring > ' + (r.name || m.name || 'iDrive'), 1570), col(0), line(3) + 54, C.text);

    const bx = 1800, bw = 470, gap = 22;
    if (m.pin) {
        // the PIN to type on the phone: big, in place of the buttons
        rec.rrect(bx, 120, bw * 2 + gap, 520, 28, C.card);
        rec.text('small', 'TYPE THIS ON THE PHONE', bx + bw + gap / 2, 200, C.faint, 'center', 3);
        const digits = String(m.pin).split('');
        digits.forEach((d, i) => {
            const x = bx + (bw * 2 + gap) / 2 - (digits.length * 150 - 20) / 2 + i * 150;
            rec.rrect(x, 250, 130, 170, 20, C.tile);
            rec.text('title', d, x + 65, 357, C.text, 'center');
        });
        rec.text('body', fit(rec, 'body', (m.phone && m.phone.name ? m.phone.name : 'The phone') + ' is asking to mirror.', bw * 2 - 40), bx + bw + gap / 2, 500, C.dim, 'center');
        pill(rec, m, targets, 'apPinDone', 'Hide', bx + bw + gap / 2 - 150, 548, 300, 72);
    } else {
        rec.text('small', 'PICTURE SHAPE', bx, 150, C.faint, 'left', 3);
        shapes(rec, m, targets, bx, 172, 4, 227, 84, 20);
        const b = (i, j, key, label, o) => pill(rec, m, targets, key, label, bx + j * (bw + gap), 384 + i * (92 + gap), bw, 92, o);
        b(0, 0, 'apToggle', m.enabled ? 'Receiver off' : 'Receiver on', { fill: m.enabled ? null : C.accent });
        b(0, 1, 'apAccess', m.access === 'open' ? 'Ask for a PIN' : 'No PIN (open)');
        b(1, 0, 'apForget', 'Forget phones', { disabled: !e });
        b(1, 1, 'apLogs', 'Logs');
    }
    rec.text('small', 'Not affiliated with Apple. AirPlay, iPhone and iPad are Apple\'s trademarks. Mirroring only while parked.', 90, 700, C.faint);
}

/* Mirror: transparent where the phone's screen is (the video tool draws it there), the band on the left */
function mirror(rec, m, targets) {
    rec.clear(C.clear);
    rec.rect(BAND.x, BAND.y, BAND.w, BAND.h, C.bg);
    const x = 20, w = BAND.w - 40;
    ASPECTS.forEach((a, i) => {
        pill(rec, m, targets, 'apA_' + a, aspectLabel(a), x, 20 + i * 89, w, 80, { style: 'strong', fill: m.aspect === a ? C.accent : null });
    });
    pill(rec, m, targets, 'apDisconnect', 'Disconnect', x, H - 20 - 96, w, 96, { style: 'strong', fill: [120, 34, 28, 255] });
    // waiting for the picture (or paused: the phone locked), over the middle of the video area only then
    const s = m.mirror || {};
    if (s.state !== 'playing') {
        const v = VIDEO;
        rec.rrect(v.x + v.w / 2 - 450, v.y + v.h / 2 - 70, 900, 140, 24, [9, 11, 16, 230]);
        rec.text('strong', s.state === 'paused' ? 'Paused on the phone' : 'Waiting for ' + ((m.phone && m.phone.name) || 'the phone') + '...', v.x + v.w / 2, v.y + v.h / 2 - 8, C.text, 'center');
        if (s.reason) rec.text('small', fit(rec, 'small', s.reason, 840), v.x + v.w / 2, v.y + v.h / 2 + 40, C.dim, 'center');
    }
}

function logs(rec, m, targets) {
    rec.text('title', 'AirPlay', 90, 86, C.text);
    rec.text('head', 'LOGS', 350, 84, C.faint, 'left', 6);
    const L = { x: 90, y: 120, w: W - 180, h: 520 };
    rec.rrect(L.x, L.y, L.w, L.h, 28, C.card);
    const all = m.logs || [];
    const pages = logPages(all.length), page = Math.min(m.logPage || 0, pages - 1);
    const lines = logLines(all, page);
    if (!lines.length) rec.text('body', 'Nothing logged yet.', L.x + 44, L.y + 80, C.dim);
    lines.forEach((l, i) => {
        const y = L.y + 62 + i * 44;
        rec.text('small', clock(l.t), L.x + 44, y, C.faint);
        const col = l.level === 'error' ? C.red : l.level === 'warn' ? C.orange : C.dim;
        rec.text('small', fit(rec, 'small', l.text, L.w - 260), L.x + 190, y, col);
        if (i < lines.length - 1) rec.rect(L.x + 44, y + 15, L.w - 88, 1, C.line);
    });
    rec.text('small', 'Page ' + (page + 1) + ' of ' + pages + '  ·  newest first  ·  also in airplay.log', L.x, 700, C.faint);
    pill(rec, m, targets, 'apOlder', 'Older', W - 120 - 200 - 20 - 200 - 20 - 220, 664, 200, 64);
    pill(rec, m, targets, 'apNewer', 'Newer', W - 120 - 200 - 20 - 220, 664, 200, 64);
    pill(rec, m, targets, 'apClose', 'Close', W - 120 - 220, 664, 220, 64);
}

/*
 * model.view: 'home' | 'mirror' | 'logs'; focus, pressed for all. Returns { rec, targets: [{ key, x, y, w, h }] }.
 */
function draw(rec, m) {
    rec.reset();
    const targets = [];
    if (m.view === 'mirror') { mirror(rec, m, targets); return { rec: rec, targets: targets }; }
    rec.clear(C.bg);
    if (m.view === 'logs') logs(rec, m, targets);
    else home(rec, m, targets);
    return { rec: rec, targets: targets };
}

function hit(targets, x, y) {
    for (let i = targets.length - 1; i >= 0; i--) {
        const t = targets[i];
        if (x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h) return t;
    }
    return null;
}

/* the placement that fits the logical screen into the app area (screen px) */
function placement(area) {
    const scale = Math.min(area.w / W, area.h / H);
    return { x: area.x, y: area.y, w: area.w, h: area.h, scale: scale,
        ox: Math.round((area.w - W * scale) / 2), oy: Math.round((area.h - H * scale) / 2) };
}

/* a logical rect -> screen px under a placement (where the video goes) */
function toScreen(pl, r) {
    return { x: Math.round(pl.x + pl.ox + r.x * pl.scale), y: Math.round(pl.y + pl.oy + r.y * pl.scale),
        w: Math.round(r.w * pl.scale), h: Math.round(r.h * pl.scale) };
}

module.exports = { W, H, OP, C, LOG_PER_PAGE, BAND, VIDEO, ASPECTS, Recorder, draw, hit, placement, toScreen, atlas, pack, fit, logPages, logLines, logText,
    aspectLabel, nextAspect };
