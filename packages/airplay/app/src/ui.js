'use strict';
/*
 * AirPlay: the app's screens, drawn by the head unit's renderer (gpu.js) over the HMI page. Pure: draw(rec, model)
 * records a frame (renderd draw ops) and returns what a tap can press. The recorder and glyph atlases are Light
 * Logger's (as Remote Play's). Tested and previewed on a desktop.
 *
 *   home     the receiver, the phone, the video path, parked or not; the picture's shape; the buttons; the PIN to type
 *   mirror   the phone's screen: the video tool draws it on the head unit's display, in the area right of the band; the
 *            band on the left has the picture's shape (Fit, Stretch, 16:9, ...) and Disconnect
 *   wifi     the head unit's Wi-Fi: each interface (the car's access point and the devices on it, or the network the
 *            car is on), the networks around (Scan), Connect and Disconnect
 *   wifipass a network's password, typed on a keyboard (letters, digits, symbols)
 *   logs     the app's log, newest first
 *
 * Without GStreamer (m.soft) the phone's picture is drawn here, from the engine's decoded pictures (PIC_ID).
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
const PIC_ID = 0x41500001;      // the decoded picture (no GStreamer), uploaded again for each one

/* where a picture of size src goes in area in a shape (as the video tool's viewFor): the asked shape, centred and as
 * large as the area allows; stretch: all of it */
function shapeRect(area, src, aspect) {
    const sw = src && src.w > 0 ? src.w : area.w, sh = src && src.h > 0 ? src.h : area.h;
    const m = /^(\d+):(\d+)$/.exec(aspect || '');
    if (aspect === 'stretch') return { x: area.x, y: area.y, w: area.w, h: area.h };
    const r = m ? +m[1] / +m[2] : sw / sh;
    let w = area.w, h = area.h;
    if (area.w / area.h > r) w = Math.round(h * r); else h = Math.round(w / r);
    return { x: Math.round(area.x + (area.w - w) / 2), y: Math.round(area.y + (area.h - h) / 2), w: w, h: h };
}

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
    const vtext = m.soft ? 'Decoded by the engine, drawn here (no GStreamer: fewer frames a second)' : !v.tool ? 'Remote Play Video not installed' :
        !v.probe ? 'Checking the decoders (up to a minute)...' : v.probe.why ? v.probe.why :
        v.probe.decoder + (v.probe.auto ? ' (the head unit\'s choice)' : v.probe.hardware ? ' (hardware)' : ' (software)') + '  ·  ' + (v.probe.sink || 'no display');
    row(rec, col(0), line(1), 760, 'Video', vtext, m.soft ? 'warn' : !v.tool ? 'bad' : !v.probe ? 'warn' : v.probe.decoder && v.probe.hardware ? 'ok' : v.probe.decoder ? 'warn' : 'bad');
    row(rec, col(1), line(1), 760, 'Access', m.access === 'open' ? 'Open: any phone on the network' : 'A PIN the first time a phone connects', m.access === 'open' ? 'warn' : 'ok');
    const wf = m.wifi || {};
    row(rec, col(0), line(2), 760, 'Wi-Fi', !wf.tool ? 'AirPlay Wi-Fi not installed' : wifiSummary(wf.status), !wf.tool ? 'none' : wf.status && wf.status.ifaces.length ? 'ok' : 'warn');
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
        const w3 = (bw * 2 + gap - 2 * gap) / 3;
        const b = (i, j, key, label, o) => pill(rec, m, targets, key, label, bx + j * (w3 + gap), 384 + i * (92 + gap), w3, 92, o);
        b(0, 0, 'apToggle', m.enabled ? 'Receiver off' : 'Receiver on', { fill: m.enabled ? null : C.accent });
        b(0, 1, 'apAccess', m.access === 'open' ? 'Ask for a PIN' : 'No PIN');
        b(0, 2, 'apForget', 'Forget phones', { disabled: !e });
        b(1, 0, 'apWifi', 'Wi-Fi');
        b(1, 1, 'apLogs', 'Logs');
    }
    rec.text('small', 'Not affiliated with Apple. AirPlay, iPhone and iPad are Apple\'s trademarks. Mirroring only while parked.', 90, 700, C.faint);
}

/* Mirror: transparent where the phone's screen is (the video tool draws it there), the band on the left. Without
 * GStreamer (m.soft): black, and the engine's newest decoded picture drawn in the shape asked for */
function mirror(rec, m, targets) {
    if (m.soft) {
        rec.clear(C.black);
        if (m.pic) { const r = shapeRect(VIDEO, m.pic, m.aspect); rec.image(PIC_ID, r.x, r.y, r.w, r.h, 0); }
    } else rec.clear(C.clear);
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

/* ---- Wi-Fi ---- */
function kindLabel(i) { return i.kind === 'ap' ? (i.mode && /P2P/i.test(i.mode) ? 'the car\'s Wi-Fi (P2P group, CarPlay)' : 'access point') : i.kind === 'station' ? (i.state === 'COMPLETED' || i.ssid ? 'connected' : 'not connected') : 'Wi-Fi'; }
function wifiSummary(st) {
    if (!st) return 'Looking...';
    if (!st.ifaces.length) return 'No Wi-Fi interface found';
    return st.ifaces.map((i) => i.name + ': ' + kindLabel(i) + (i.ssid ? ' "' + i.ssid + '"' : '') +
        (i.kind === 'ap' ? ' (' + i.clients.length + ' device' + (i.clients.length === 1 ? '' : 's') + ')' : i.v4 && i.v4[0] ? ' ' + i.v4[0] : '')).join('  ·  ');
}
function band(f) { return !f ? '' : f >= 5900 ? '6 GHz' : f >= 4900 ? '5 GHz' : '2.4 GHz'; }

/* the lines of the Status tab: each interface, then the devices on an access point */
function wifiLines(st) {
    const out = [];
    (st && st.ifaces || []).forEach((i) => {
        out.push({ head: true, text: i.name + '  ·  ' + kindLabel(i) + (i.ssid ? '  "' + i.ssid + '"' : '') + (i.channel ? '  ·  channel ' + i.channel : '') + (i.freq ? '  ·  ' + band(i.freq) : '') +
            (i.signal !== null && i.signal !== undefined && i.kind !== 'ap' ? '  ·  ' + i.signal + ' dBm' : ''), state: i.up === 'up' || i.state === 'COMPLETED' || i.state === 'ENABLED' ? 'ok' : 'warn' });
        out.push({ text: [(i.v4 || []).join(', '), (i.v6 || []).filter((a) => /^fe80/i.test(a)).join(', '), i.mac, i.control ? 'control ' + i.control : 'no control socket'].filter(Boolean).join('   ') });
        if (i.kind === 'ap') {
            if (!i.clients.length) out.push({ text: '    no devices on it' });
            i.clients.forEach((c) => out.push({ text: '    ' + (c.name || 'device') + '   ' + (c.ip || 'no address') + '   ' + c.mac + (c.signal ? '   ' + c.signal + ' dBm' : '') }));
        }
    });
    if (st && st.others && st.others.length) out.push({ text: 'Other networks: ' + st.others.map((o) => o.name + ' ' + o.v4.concat(o.v6.filter((a) => /^fe80/i.test(a))).join(' ')).join('  ·  ') });
    return out;
}

function wifi(rec, m, targets) {
    const wf = m.wifi || {};
    rec.text('title', 'Wi-Fi', 90, 86, C.text);
    if (wf.note) rec.text('body', fit(rec, 'body', wf.note, 1700), 300, 84, wf.warn ? C.orange : C.dim);
    const S = { x: 90, y: 120, w: 1900, h: 560 };
    rec.rrect(S.x, S.y, S.w, S.h, 28, C.card);
    if (!wf.tool) {
        rec.text('body', 'AirPlay Wi-Fi (ida-airplay-wifi) is not installed or not running.', S.x + 44, S.y + 80, C.dim);
    } else if (wf.tab === 'networks') {
        const nets = wf.networks;
        if (wf.scanning) rec.text('body', 'Scanning with ' + (wf.iface || 'the Wi-Fi') + '...', S.x + 44, S.y + 80, C.dim);
        else if (!nets) rec.text('body', 'Scan for the networks around the car.', S.x + 44, S.y + 80, C.dim);
        else if (!nets.length) rec.text('body', 'No networks found.', S.x + 44, S.y + 80, C.dim);
        else nets.slice(0, 8).forEach((n, i) => {
            const y = S.y + 24 + i * 66, label = n.ssid + '   ·   ' + n.signal + ' dBm   ·   ' + band(n.freq) + (n.secure ? '   ·   password' : '   ·   open');
            pill(rec, m, targets, 'apWn_' + i, fit(rec, 'body', label, S.w - 120), S.x + 24, y, S.w - 48, 56, { style: 'body', fill: wf.connecting === n.ssid ? C.accent : null });
        });
    } else {
        const lines = wifiLines(wf.status);
        if (!wf.status) rec.text('body', 'Asking the Wi-Fi tool...', S.x + 44, S.y + 80, C.dim);
        lines.slice(0, 11).forEach((l, i) => {
            const y = S.y + 56 + i * 46;
            if (l.head) { dot(rec, S.x + 54, y - 12, l.state === 'ok' ? C.green : C.orange); rec.text('body', fit(rec, 'body', l.text, S.w - 140), S.x + 80, y, C.text); }
            else rec.text('small', fit(rec, 'small', l.text, S.w - 140), S.x + 80, y, C.dim);
        });
    }
    const bx = 2050, bw = W - 90 - bx, bh = 86, g = 18;
    const st = wf.status, client = st && st.ifaces.filter((i) => i.joinable)[0];
    pill(rec, m, targets, 'apWStatus', 'Status', bx, 120, bw, bh, { fill: wf.tab !== 'networks' ? [33, 43, 64, 255] : null, disabled: !wf.tool });
    pill(rec, m, targets, 'apWScan', wf.scanning ? 'Scanning...' : 'Scan networks', bx, 120 + (bh + g), bw, bh, { fill: wf.tab === 'networks' ? [33, 43, 64, 255] : null, disabled: !wf.tool || wf.scanning || !client });
    pill(rec, m, targets, 'apWDisc', client && client.ssid ? 'Disconnect ' + fit(rec, 'body', client.ssid, bw - 240) : 'Disconnect', bx, 120 + 2 * (bh + g), bw, bh, { disabled: !(client && client.ssid) || !!wf.connecting });
    pill(rec, m, targets, 'apClose', 'Back', bx, 120 + 4 * (bh + g), bw, bh);
    const off = st && !client && st.ifaces.length ? st.ifaces.map((i) => i.name + ': ' + (i.why || 'left alone')).join('; ') : null;
    rec.text('small', fit(rec, 'small', off ? 'Scan and Connect are off' : 'Only a Wi-Fi client is used: never the car\'s own Wi-Fi.', bw), bx, 120 + 3 * (bh + g) + 36, off ? C.orange : C.faint);
    if (off) rec.text('small', fit(rec, 'small', off, bw), bx, 120 + 3 * (bh + g) + 72, C.faint);
}

/* the password keyboard: letters (Shift), digits, a page of symbols */
const KEYS = { abc: ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'], sym: ['1234567890', '!@#$%^&*()', '-_=+[]{};:', '\'",.<>/?\\|', '`~'] };
function wifiPass(rec, m, targets) {
    const wf = m.wifi || {};
    rec.text('title', 'Password', 90, 86, C.text);
    rec.text('body', fit(rec, 'body', 'for "' + (wf.target || '') + '"' + (wf.note ? '   ·   ' + wf.note : ''), 1900), 400, 84, wf.warn ? C.orange : C.dim);
    const pass = wf.pass || '';
    rec.rrect(90, 116, W - 180, 100, 20, C.card);
    rec.text('title', pass ? fit(rec, 'title', pass, W - 300) : ' ', 130, 186, C.text);
    if (!wf.connecting) rec.rect(130 + Math.min(rec.width('title', pass), W - 300) + 6, 136, 4, 60, C.accent);
    const rows = wf.sym ? KEYS.sym : KEYS.abc, top = 236, kh = 88, g = 12, span = 1700;
    rows.forEach((row, r) => {
        const kw = Math.min(150, (span - (row.length - 1) * g) / row.length), rowW = row.length * kw + (row.length - 1) * g, x0 = 90 + (span - rowW) / 2;
        row.split('').forEach((ch, i) => {
            const c = wf.shift && !wf.sym ? ch.toUpperCase() : ch;
            pill(rec, m, targets, 'apKc_' + c, c, x0 + i * (kw + g), top + r * (kh + g), kw, kh, { style: 'title', disabled: !!wf.connecting });
        });
    });
    const sx = 90 + span + 50, sw = W - 90 - sx, half = (sw - g) / 2, k = (i) => top + i * (kh + g);
    pill(rec, m, targets, 'apKShift', wf.shift ? 'ABC' : 'abc', sx, k(0), half, kh, { style: 'strong', fill: wf.shift ? [33, 43, 64, 255] : null, disabled: !!wf.connecting || !!wf.sym });
    pill(rec, m, targets, 'apKSym', wf.sym ? 'abc' : '#+=', sx + half + g, k(0), half, kh, { style: 'strong', disabled: !!wf.connecting });
    pill(rec, m, targets, 'apKSpace', 'Space', sx, k(1), half, kh, { style: 'strong', disabled: !!wf.connecting });
    pill(rec, m, targets, 'apKDel', 'Delete', sx + half + g, k(1), half, kh, { style: 'strong', disabled: !!wf.connecting });
    pill(rec, m, targets, 'apKClear', 'Clear', sx, k(2), half, kh, { style: 'strong', disabled: !!wf.connecting });
    pill(rec, m, targets, 'apWBack', 'Back', sx + half + g, k(2), half, kh, { style: 'strong', disabled: !!wf.connecting });
    const ready = pass.length >= 8 && !wf.connecting;
    pill(rec, m, targets, 'apKConnect', wf.connecting ? 'Connecting...' : 'Connect', sx, k(3), sw, kh, { style: 'strong', fill: ready ? C.accent : null, disabled: !ready });
}

/*
 * model.view: 'home' | 'mirror' | 'wifi' | 'wifipass' | 'logs'; focus, pressed for all. Returns { rec, targets: [{ key, x, y, w, h }] }.
 */
function draw(rec, m) {
    rec.reset();
    const targets = [];
    if (m.view === 'mirror') { mirror(rec, m, targets); return { rec: rec, targets: targets }; }
    rec.clear(C.bg);
    if (m.view === 'logs') logs(rec, m, targets);
    else if (m.view === 'wifi') wifi(rec, m, targets);
    else if (m.view === 'wifipass') wifiPass(rec, m, targets);
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

module.exports = { W, H, OP, C, LOG_PER_PAGE, BAND, VIDEO, PIC_ID, ASPECTS, KEYS, Recorder, shapeRect, wifiLines, wifiSummary, draw, hit, placement, toScreen, atlas, pack, fit, logPages, logLines, logText,
    aspectLabel, nextAspect };
