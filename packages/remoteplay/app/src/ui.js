'use strict';
/*
 * Remote Play: the app's screens, drawn by the head unit's renderer (gpu.js) over the HMI page. Pure: draw(rec, model)
 * records a frame (renderd draw ops) and returns what a tap or the controller can press. The recorder and glyph
 * atlases are Light Logger's (packages/lightlog/app/src/ui.js). Tested and previewed on a desktop.
 *
 *   home     the account, the console, pairing, the engine, the video path, the controller, parked or not; the buttons
 *   signin   a QR code for Sony's sign-in page (the phone on any network), and the steps
 *   code     the code from Sony's last page, typed on a keyboard
 *   pin      the console's 8-digit pairing PIN, on a keypad
 *   play     the touch controller (pad.js) in the bands beside the game; the middle is left clear for the video,
 *            which the video tool draws on the head unit's display at its own frame rate
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
    const key = 'ida_remoteplay/' + style + '@' + f.px;
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

function home(rec, m, targets) {
    rec.text('title', 'Remote Play', 90, 86, C.text);
    if (m.note) rec.text('body', fit(rec, 'body', m.note, 1500), 560, 84, m.warn ? C.orange : C.dim);

    const S = { x: 90, y: 120, w: 1640, h: 520 };
    rec.rrect(S.x, S.y, S.w, S.h, 28, C.card);
    const col = (i) => S.x + 50 + i * 800, line = (j) => S.y + 60 + j * 120;
    const acc = m.account;
    row(rec, col(0), line(0), 760, 'PlayStation account', acc ? (acc.onlineId || 'Signed in') + (m.internet ? '  ·  internet play on' : '  ·  at home only') : 'Not signed in', acc ? 'ok' : 'none');
    const c = m.console, r = m.remote, here = c && c.state === 'ready';
    const ctext = m.searching ? 'Looking for it...'
        : m.route === 'local' ? c.name + '  ·  here, ' + c.host
        : c && c.state === 'standby' && m.paired ? c.name + '  ·  here, resting (Wake)'
        : m.route === 'internet' ? r.name + '  ·  at home, over the internet'
        : c ? c.name + '  ·  not answering' : r ? r.name + '  ·  sign in again for the internet' : 'None found yet';
    row(rec, col(1), line(0), 760, 'Console', ctext, m.searching ? 'warn' : m.route ? 'ok' : c || r ? 'warn' : 'none');
    const ptext = m.route === 'internet' ? 'Not needed over the internet' : m.paired ? 'Paired with ' + (m.paired.nickname || (c && c.name) || 'the console') : 'Not paired';
    row(rec, col(0), line(1), 760, 'Paired', ptext, m.route === 'internet' || m.paired ? 'ok' : 'none');
    const e = m.engine;
    row(rec, col(1), line(1), 760, 'Stream engine', e ? (e.name || 'Engine') + (e.version ? ' ' + e.version : '') : 'Not installed', e ? 'ok' : 'bad');
    const v = m.video || {};
    const vtext = !v.tool ? 'Video tool not installed' : !v.probe ? 'Checking the decoders (up to a minute)...' : v.probe.why ? v.probe.why :
        v.probe.decoder + (v.probe.auto ? ' (the head unit\'s choice)' : v.probe.hardware ? ' (hardware)' : ' (software)') + '  ·  ' + (v.probe.sink || 'no display');
    row(rec, col(0), line(2), 760, 'Video', vtext, !v.tool ? 'bad' : !v.probe ? 'warn' : v.probe.decoder && v.probe.hardware ? 'ok' : v.probe.decoder ? 'warn' : 'bad');
    const last = v.testing ? 'Running the test...' : v.fps ? (v.fps > v.target ? 'up to ' : '') + Math.round(v.fps) + ' fps at 1280x720' + (v.fps < v.target * 0.95 ? ' (under ' + v.target + ')' : '') : 'Not tested';
    row(rec, col(1), line(2), 760, 'Video test', last, v.testing ? 'warn' : v.fps ? (v.fps >= v.target * 0.95 ? 'ok' : 'warn') : 'none');
    row(rec, col(0), line(3), 760, 'Controller', m.pad ? m.pad + ' (USB)' : 'Touch controls', m.pad ? 'ok' : 'none');
    row(rec, col(1), line(3), 760, 'Car', m.parked === true ? 'Parked: play allowed' : m.parked === false ? 'Moving: play only while parked' : 'Waiting for the speed', m.parked === true ? 'ok' : m.parked === false ? 'bad' : 'warn');

    // the buttons: two columns on the right, Play the big one
    const bx = 1800, bw = 470, bh = 92, gap = 22;
    const b = (i, j, key, label, o) => pill(rec, m, targets, key, label, bx + j * (bw + gap), 120 + i * (bh + gap), bw, bh, o);
    b(0, 0, 'rpSignIn', acc ? 'Account' : 'Sign in');
    b(0, 1, 'rpFind', 'Find console');
    b(1, 0, 'rpWake', 'Wake', { disabled: !(c && m.paired && c.state === 'standby') });
    b(1, 1, 'rpPair', m.paired ? 'Pair again' : 'Pair', { disabled: !(here && acc && e) });
    b(2, 0, 'rpTest', 'Video test', { disabled: !(v.tool && m.parked) });
    b(2, 1, 'rpLogs', 'Logs');
    const can = !!(m.route && e && v.tool && m.parked);
    pill(rec, m, targets, 'rpPlay', m.route === 'internet' ? 'Play over the internet' : 'Play', bx, 120 + 3 * (bh + gap), bw * 2 + gap, 520 - 3 * (bh + gap), { disabled: !can, style: 'title', fill: can ? C.accent : C.tile });
    rec.text('small', 'Not affiliated with Sony Interactive Entertainment. Play only while parked.', 90, 700, C.faint);
}

/* the QR code, in dark runs on a white square */
function qrCode(rec, q, x, y, size) {
    const quiet = 4, n = q.size + quiet * 2, cell = Math.floor(size / n), s = cell * n;
    rec.rrect(x, y, s, s, 16, C.white);
    for (let r = 0; r < q.size; r++) {
        let start = -1;
        for (let col = 0; col <= q.size; col++) {
            const dark = col < q.size && q.get(col, r);
            if (dark && start < 0) start = col;
            if (!dark && start >= 0) { rec.rect(x + (quiet + start) * cell, y + (quiet + r) * cell, (col - start) * cell, cell, C.black); start = -1; }
        }
    }
    return s;
}

/* Sign in: the QR code is Sony's own sign-in page, so the phone can be on any network (mobile data is fine). The code
 * Sony's last page carries in its address is then typed here (Type the code: the keyboard below). */
function signIn(rec, m, targets) {
    rec.text('title', 'Sign in', 90, 86, C.text);
    const size = 640, s = m.qr ? qrCode(rec, m.qr, 90, 112, size) : 0;
    if (!m.qr) { rec.rrect(90, 112, size, size, 16, C.card); rec.text('body', 'Preparing...', 90 + size / 2, 112 + size / 2, C.dim, 'center'); }
    const x = 90 + Math.max(s, size) + 80;
    const steps = [
        ['1', 'Scan this code with your phone (any network: mobile data is fine).'],
        ['2', 'Sign in with your PlayStation account on Sony\'s page.'],
        ['3', 'The last page says "redirect". In its address, find code=... :'],
        ['', 'the letters and digits after code=, up to the next &.'],
        ['4', 'Tap Type the code, and type them here.'],
    ];
    steps.forEach((st, i) => {
        const y = 140 + i * 78;
        if (st[0]) { rec.rrect(x, y, 52, 52, 26, C.accent); rec.text('strong', st[0], x + 26, y + 40, C.white, 'center'); }
        rec.text('body', st[1], x + 80, y + 38, st[0] ? C.text : C.dim);
    });
    if (m.account) rec.text('body', 'Signed in' + (m.account.onlineId ? ' as ' + m.account.onlineId : '') + (m.internet ? ': at home and over the internet.' : '.'), x, 580, C.green);
    else if (m.note) rec.text('body', fit(rec, 'body', m.note, W - x - 120), x, 580, m.warn ? C.orange : C.dim);
    if (m.url) rec.text('small', fit(rec, 'small', 'Or, with the phone on the car\'s hotspot: ' + m.url, W - x - 900), x, 640, C.faint);
    let bx = W - 120 - 260;
    pill(rec, m, targets, 'rpClose', 'Close', bx, 664, 260, 64);
    if (m.account) { bx -= 280; pill(rec, m, targets, 'rpSignOut', 'Sign out', bx, 664, 260, 64); }
    bx -= 380;
    pill(rec, m, targets, 'rpCode', 'Type the code', bx, 664, 360, 64, { fill: C.accent, disabled: !m.qr });
}

/* the code from Sony's address, typed on a keyboard: letters both cases (Shift), digits, . - _ */
const KEY_ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
function codeScreen(rec, m, targets) {
    rec.text('title', 'Type the code', 90, 86, C.text);
    rec.text('body', 'From the address of Sony\'s "redirect" page: what comes after code= (letters are case-sensitive).', 640, 84, C.dim);
    const code = m.code || '';
    rec.rrect(90, 116, W - 180, 110, 20, C.card);
    rec.text('title', code ? fit(rec, 'title', code, W - 300) : ' ', 130, 190, C.text);
    if (!m.signing) rec.rect(130 + Math.min(rec.width('title', code), W - 300) + 6, 140, 4, 64, C.accent);
    if (m.note) rec.text('body', fit(rec, 'body', m.note, W - 1400), 90, 270, m.warn ? C.orange : C.dim);
    const kw = 150, kh = 92, g = 14, top = 300;
    KEY_ROWS.forEach((row, r) => {
        const rowW = row.length * kw + (row.length - 1) * g, x0 = 90 + (10 * kw + 9 * g - rowW) / 2;
        row.split('').forEach((ch, i) => {
            const c = m.shift ? ch.toUpperCase() : ch;
            pill(rec, m, targets, 'rpKc_' + c, c, x0 + i * (kw + g), top + r * (kh + g), kw, kh, { style: 'title', disabled: m.signing });
        });
    });
    const sx = 90 + 10 * kw + 9 * g + 60, sw = W - 120 - sx, half = (sw - g) / 2;
    pill(rec, m, targets, 'rpKShift', m.shift ? 'ABC' : 'abc', sx, top, half, kh, { style: 'strong', fill: m.shift ? [33, 43, 64, 255] : null, disabled: m.signing });
    pill(rec, m, targets, 'rpKDel', 'Delete', sx + half + g, top, half, kh, { style: 'strong', disabled: m.signing });
    ['.', '-', '_'].forEach((ch, i) => pill(rec, m, targets, 'rpKc_' + ch, ch, sx + i * ((sw - 2 * g) / 3 + g), top + kh + g, (sw - 2 * g) / 3, kh, { style: 'title', disabled: m.signing }));
    pill(rec, m, targets, 'rpKClear', 'Clear', sx, top + 2 * (kh + g), half, kh, { style: 'strong', disabled: m.signing });
    pill(rec, m, targets, 'rpClose', 'Back', sx + half + g, top + 2 * (kh + g), half, kh, { style: 'strong', disabled: m.signing });
    const ready = code.length >= 4 && !m.signing;
    pill(rec, m, targets, 'rpKSend', m.signing ? 'Signing in...' : 'Sign in', sx, top + 3 * (kh + g), sw, kh, { style: 'strong', fill: ready ? C.accent : null, disabled: !ready });
}

function pinScreen(rec, m, targets) {
    rec.text('title', 'Pair with ' + (m.console ? m.console.name : 'the console'), 90, 86, C.text);
    rec.text('body', 'On the console: Settings > System > Remote Play > Pair Device. Type the 8 digits it shows.', 90, 160, C.dim);
    const pin = m.pin || '';
    for (let i = 0; i < 8; i++) {
        const x = 90 + i * 130 + (i >= 4 ? 40 : 0);
        rec.rrect(x, 230, 110, 140, 18, C.card);
        if (i === pin.length && !m.pairing) rec.stroke(x, 230, 110, 140, 18, 4, C.accent);
        if (pin[i]) rec.text('title', pin[i], x + 55, 322, C.text, 'center');
    }
    if (m.note) rec.text('body', fit(rec, 'body', m.note, 1100), 90, 470, m.warn ? C.orange : C.dim);
    // the keypad
    const kx = 1500, kw = 260, kh = 120, g = 20;
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];
    keys.forEach((k, i) => {
        const x = kx + (i % 3) * (kw + g), y = 40 + Math.floor(i / 3) * (kh + g);
        const key = k === 'del' ? 'rpKDel' : k === 'ok' ? 'rpKPair' : 'rpK' + k;
        const ok = k === 'ok';
        pill(rec, m, targets, key, k === 'del' ? 'Delete' : ok ? (m.pairing ? 'Pairing...' : 'Pair') : k, x, y, kw, kh,
            { style: ok || k === 'del' ? 'strong' : 'title', fill: ok && pin.length === 8 && !m.pairing ? C.accent : null, disabled: m.pairing || (ok && pin.length !== 8) });
    });
    pill(rec, m, targets, 'rpClose', 'Cancel', 90, 664, 260, 64);
}

/* the face buttons' marks: plain shapes */
function mark(rec, shape, cx, cy, s, c) {
    const t = Math.max(6, s * 0.14);
    if (shape === 'circle') { rec.stroke(cx - s / 2, cy - s / 2, s, s, s / 2, t, c); return; }
    if (shape === 'square') { rec.stroke(cx - s / 2, cy - s / 2, s, s, 4, t, c); return; }
    if (shape === 'cross') {
        const a = s / 2, d = t / 1.41;
        rec.quad([[cx - a, cy - a + d], [cx - a + d, cy - a], [cx + a, cy + a - d], [cx + a - d, cy + a]], c);
        rec.quad([[cx + a - d, cy - a], [cx + a, cy - a + d], [cx - a + d, cy + a], [cx - a, cy + a - d]], c);
        return;
    }
    const pts = { triangle: [[cx, cy - s / 2], [cx + s / 2, cy + s / 2.4], [cx - s / 2, cy + s / 2.4]],
        up: [[cx, cy - s / 2], [cx + s / 2, cy + s / 3], [cx - s / 2, cy + s / 3]], down: [[cx, cy + s / 2], [cx - s / 2, cy - s / 3], [cx + s / 2, cy - s / 3]],
        left: [[cx - s / 2, cy], [cx + s / 3, cy - s / 2], [cx + s / 3, cy + s / 2]], right: [[cx + s / 2, cy], [cx - s / 3, cy + s / 2], [cx - s / 3, cy - s / 2]] }[shape];
    if (!pts) return;
    if (shape === 'triangle') {
        // an outline: three thin quads along the edges
        for (let i = 0; i < 3; i++) {
            const a = pts[i], b = pts[(i + 1) % 3], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.sqrt(dx * dx + dy * dy);
            const nx = -dy / l * t / 2, ny = dx / l * t / 2;
            rec.quad([[a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny]], c);
        }
        return;
    }
    rec.quad([pts[0], pts[1], pts[2], pts[2]], c);
}

/* Play: the middle left clear (the video is drawn under it), the controls in the bands */
function play(rec, m, targets, lay) {
    rec.clear(C.clear);
    const held = (m.input && m.input.buttons) || [];
    lay.controls.forEach((t) => {
        if (t.key === 'exit' || !m.pad) targets.push({ key: t.key, x: t.x, y: t.y, w: t.w, h: t.h });
        if (m.pad && t.key !== 'exit') return;        // a USB gamepad: only Exit on screen
        const on = held.indexOf(t.key) >= 0 || m.pressed === t.key;
        if (t.shape === 'stick') {
            rec.rrect(t.x, t.y, t.w, t.h, t.r, C.control);
            rec.stroke(t.x, t.y, t.w, t.h, t.r, 4, C.line);
            const i = m.input || {}, sx = t.key === 'lstick' ? i.lx || 0 : i.rx || 0, sy = t.key === 'lstick' ? i.ly || 0 : i.ry || 0;
            const k = t.r * 0.45, cx = t.x + t.r + sx / 32767 * (t.r - k), cy = t.y + t.r + sy / 32767 * (t.r - k);
            rec.rrect(cx - k, cy - k, k * 2, k * 2, k, (sx || sy) ? C.controlOn : [60, 66, 82, 230]);
            return;
        }
        const round = ['cross', 'circle', 'square', 'triangle'].indexOf(t.shape) >= 0;
        rec.rrect(t.x, t.y, t.w, t.h, round ? t.w / 2 : 18, on ? C.controlOn : C.control);
        if (t.label) rec.text(t.h >= 70 ? 'strong' : 'body', t.label, t.x + t.w / 2, t.y + t.h / 2 + 12, C.text, 'center');
        else mark(rec, t.shape, t.x + t.w / 2, t.y + t.h / 2, t.w * 0.42, C.text);
    });
    // what the stream is doing, over the video's top edge only when it isn't playing yet
    const s = m.session || {};
    if (s.state !== 'streaming') {
        const v = lay.video;
        rec.rrect(v.x + v.w / 2 - 450, v.y + v.h / 2 - 70, 900, 140, 24, [9, 11, 16, 230]);
        rec.text('strong', s.state === 'ended' ? 'Stream ended' : 'Connecting to ' + (m.consoleName || 'the console') + '...', v.x + v.w / 2, v.y + v.h / 2 - 8, C.text, 'center');
        if (s.reason || m.note) rec.text('small', fit(rec, 'small', s.reason || m.note, 840), v.x + v.w / 2, v.y + v.h / 2 + 40, C.dim, 'center');
    }
}

function logs(rec, m, targets) {
    rec.text('title', 'Remote Play', 90, 86, C.text);
    rec.text('head', 'LOGS', 470, 84, C.faint, 'left', 6);
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
    rec.text('small', 'Page ' + (page + 1) + ' of ' + pages + '  ·  newest first  ·  also in remoteplay.log', L.x, 700, C.faint);
    pill(rec, m, targets, 'rpOlder', 'Older', W - 120 - 200 - 20 - 200 - 20 - 220, 664, 200, 64);
    pill(rec, m, targets, 'rpNewer', 'Newer', W - 120 - 200 - 20 - 220, 664, 200, 64);
    pill(rec, m, targets, 'rpClose', 'Close', W - 120 - 220, 664, 220, 64);
}

/*
 * model.view: 'home' | 'signin' | 'pin' | 'play' | 'logs' (see each screen for its fields; focus, pressed for all).
 * play also takes lay (pad.js layout). Returns { rec, targets: [{ key, x, y, w, h }] }.
 */
function draw(rec, m, lay) {
    rec.reset();
    const targets = [];
    if (m.view === 'play') { play(rec, m, targets, lay); return { rec: rec, targets: targets }; }
    rec.clear(C.bg);
    if (m.view === 'signin') signIn(rec, m, targets);
    else if (m.view === 'code') codeScreen(rec, m, targets);
    else if (m.view === 'pin') pinScreen(rec, m, targets);
    else if (m.view === 'logs') logs(rec, m, targets);
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

module.exports = { W, H, OP, C, LOG_PER_PAGE, Recorder, draw, hit, placement, toScreen, atlas, pack, fit, logPages, logLines, logText };
