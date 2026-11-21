'use strict';
/*
 * DRL Colour: the app's screen, drawn by the head unit's renderer (gpu.js) over the HMI page. Pure: draw(rec, model)
 * records a frame (renderd draw ops) and returns what a tap or the controller can press. The recorder and glyph
 * atlases are Light Logger's (packages/lightlog/app/src/ui.js), as Seat Lights uses them. Tested and previewed on a
 * desktop.
 *
 *   DRL Colour                                   DRL COLOUR
 *     ______________________                     WHITE
 *    /  ==================   \  <- the DRL,      Flashed 3 times in 1.9 s
 *   |                         |    its colour    [        Switch to yellow         ]
 *    \_______________________/
 *                                   [Auto white: OFF] [It's yellow] [Learn] [Logs]
 *
 * Logs shows the app's log in place of it: newest first, Older / Newer / Close.
 * The buttons have the keys of the HMI list's rows under the drawn screen, so the controller's focus there lights
 * them here.
 */
const FONT = require('./ui_font.js');

const W = 2880, H = 764;
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
    const key = 'ida_drlcolor/' + style + '@' + f.px;
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


const C = {
    bg: [9, 11, 16, 255], card: [17, 20, 28, 255], line: [36, 41, 54, 255], tile: [25, 29, 40, 255],
    text: [242, 244, 248, 255], dim: [138, 147, 166, 255], faint: [86, 93, 110, 255], track: [44, 48, 58, 255],
    green: [60, 192, 122, 255], orange: [240, 160, 48, 255], accent: [30, 123, 224, 255], red: [229, 67, 46, 255],
    housing: [22, 25, 33, 255], lens: [30, 34, 44, 255], beam: [120, 170, 255, 255],
};
/* the DRL's colour as drawn: white, yellow, or not known */
const DRL = { white: [236, 244, 255], yellow: [255, 178, 36], none: [96, 102, 118] };

/* s cut to fit maxW (with an ellipsis) */
function fit(rec, style, s, maxW) {
    s = String(s);
    if (rec.width(style, s) <= maxW) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rec.width(style, s.slice(0, mid) + '...') <= maxW) lo = mid; else hi = mid - 1; }
    return s.slice(0, lo) + '...';
}

/* the Logs screen: log lines, newest first, a page at a time */
const LOG_PER_PAGE = 11;
const pad2 = (n) => (n < 10 ? '0' : '') + n;
function clock(t) { const d = new Date(t); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
function logPages(n, per) { return Math.max(1, Math.ceil(n / (per || LOG_PER_PAGE))); }
/* page 0 is the newest: [{ t, level, text }], newest first */
function logLines(lines, page, per) {
    per = per || LOG_PER_PAGE;
    const newest = (lines || []).slice().reverse();
    return newest.slice(page * per, page * per + per);
}
function logText(l) { return clock(l.t) + '  ' + (l.level === 'info' ? '' : l.level.toUpperCase() + '  ') + l.text.replace(/^drl: /, ''); }

function pill(rec, m, targets, key, label, x, y, w, h, fill, color) {
    rec.rrect(x, y, w, h, h / 2, m.focus === key ? [33, 43, 64, 255] : fill || C.tile);
    rec.text('body', fit(rec, 'body', label, w - 30), x + w / 2, y + h / 2 + 12, color || C.dim, 'center');
    if (m.pressed === key) rec.rrect(x, y, w, h, h / 2, [255, 255, 255, 30]);
    if (m.focus === key) rec.stroke(x, y, w, h, h / 2, 4, C.accent);
    targets.push({ key: key, x: x, y: y, w: w, h: h });
}

const rgba = (c, a) => [c[0], c[1], c[2], a];
const other = (c) => (c === 'white' ? 'yellow' : c === 'yellow' ? 'white' : null);
const NAME = { white: 'WHITE', yellow: 'YELLOW' };

/* the main button's label */
function action(m) {
    if (m.busy === 'learn') return m.learnLeft ? 'Learning... ' + m.learnLeft + ' s' : 'Learning...';
    if (m.busy === 'flash') return 'Flashing...';
    if (!m.ready) return 'Learn the high beams first';
    const to = other(m.colour);
    return to ? 'Switch to ' + to : 'Flash the high beams 3 times';
}
/* the correction button: the colour the DRLs really show, when the app counted wrong */
function fixLabel(m) { return 'It\'s ' + (m.colour === 'yellow' ? 'white' : 'yellow'); }

/* a headlight, its DRL bar in the colour it is (glowing), the high beam lit while flashing */
function headlight(rec, m, x, y, w, h) {
    const col = DRL[m.colour] || DRL.none;
    rec.rrect(x, y, w, h, h * 0.45, C.housing);
    rec.stroke(x, y, w, h, h * 0.45, 4, C.line);
    // the lenses: low and high beam
    const lr = h * 0.24, ly = y + h * 0.58;
    [0.36, 0.64].forEach((fx, i) => {
        const cx = x + w * fx;
        if (i === 1 && m.busy === 'flash') {
            for (let k = 0; k < 10; k++) { const r = lr * (2.2 - k * 0.12); rec.rrect(cx - r, ly - r, r * 2, r * 2, r, rgba(C.beam, 10)); }
        }
        rec.rrect(cx - lr, ly - lr, lr * 2, lr * 2, lr, i === 1 && m.busy === 'flash' ? [210, 228, 255, 255] : C.lens);
        rec.stroke(cx - lr, ly - lr, lr * 2, lr * 2, lr, 3, C.line);
    });
    // the DRL: a bar along the top, its glow
    const bx = x + w * 0.1, bw = w * 0.8, by = y + h * 0.2, bh = 34;
    if (m.colour) for (let k = 0; k < 14; k++) { const g = 60 - k * 4; rec.rrect(bx - g, by - g, bw + g * 2, bh + g * 2, bh / 2 + g, rgba(col, 7)); }
    rec.rrect(bx, by, bw, bh, bh / 2, rgba(col, 255));
}

/*
 * model: { view: 'main' | 'logs', colour ('white' | 'yellow' | null), ready (learned), busy ('learn' | 'flash' | null),
 *          learnLeft (s), auto, note, warn, logs: [{ t, level, text }], logPage, focus, pressed }
 * Returns { rec, targets: [{ key, x, y, w, h }] }.
 */
function draw(rec, m) {
    rec.reset();
    const targets = [];
    rec.clear(C.bg);

    if (m.view === 'logs') {
        rec.text('title', 'DRL Colour', 90, 86, C.text);
        rec.text('head', 'LOGS', 420, 84, C.faint, 'left', 6);
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
            rec.text('small', fit(rec, 'small', l.text.replace(/^drl: /, ''), L.w - 260), L.x + 190, y, col);
            if (i < lines.length - 1) rec.rect(L.x + 44, y + 15, L.w - 88, 1, C.line);
        });
        rec.text('small', 'Page ' + (page + 1) + ' of ' + pages + '  ·  newest first  ·  also in drlcolor.log', L.x, 700, C.faint);
        pill(rec, m, targets, 'dcOlder', 'Older', W - 120 - 200 - 20 - 200 - 20 - 220, 664, 200, 64);
        pill(rec, m, targets, 'dcNewer', 'Newer', W - 120 - 200 - 20 - 220, 664, 200, 64);
        pill(rec, m, targets, 'dcLogs', 'Close', W - 120 - 220, 664, 220, 64);
        return { rec: rec, targets: targets };
    }

    rec.text('title', 'DRL Colour', 90, 86, C.text);
    headlight(rec, m, 170, 190, 1050, 400);

    // the right: the colour, what happened last, the button
    const tx = 1400, tw = W - 120 - tx;
    rec.text('head', 'DRL COLOUR', tx, 200, C.faint, 'left', 6);
    rec.text('title', NAME[m.colour] || 'NOT KNOWN', tx, 290, m.colour ? rgba(DRL[m.colour], 255) : C.dim);
    if (m.note) rec.text('body', fit(rec, 'body', m.note, tw), tx, 370, m.warn ? C.orange : C.dim);

    const busy = !!m.busy, by = 420, bh = 140;
    const fill = busy || !m.ready ? C.tile : C.accent;
    rec.rrect(tx, by, tw, bh, bh / 2, m.focus === 'dcFlash' && (busy || !m.ready) ? [33, 43, 64, 255] : fill);
    rec.text('strong', fit(rec, 'strong', action(m), tw - 80), tx + tw / 2, by + bh / 2 + 14, busy || !m.ready ? C.dim : C.text, 'center');
    if (m.pressed === 'dcFlash') rec.rrect(tx, by, tw, bh, bh / 2, [255, 255, 255, 40]);
    if (m.focus === 'dcFlash') rec.stroke(tx - 10, by - 10, tw + 20, bh + 20, bh / 2 + 10, 5, C.text);
    targets.push({ key: 'dcFlash', x: tx, y: by, w: tw, h: bh });

    // the row below: Auto, the correction, Learn, Logs (right to left)
    const y = 664, h = 64;
    let x = W - 120;
    const row = [['dcLogs', 'Logs', 180], ['dcLearn', m.ready ? 'Learn again' : 'Learn', 260], ['dcFix', fixLabel(m), 240],
        ['dcAuto', 'Auto white: ' + (m.auto ? 'ON' : 'OFF'), 340]];
    row.forEach((b) => {
        x -= b[2];
        pill(rec, m, targets, b[0], b[1], x, y, b[2], h, C.card, b[0] === 'dcAuto' && m.auto ? C.green : null);
        x -= 20;
    });
    return { rec: rec, targets: targets };
}

/* which target a point is on (logical px), or null */
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

module.exports = { W, H, OP, DRL, LOG_PER_PAGE, Recorder, draw, hit, placement, atlas, pack, fit, logPages, logLines, logText, action, fixLabel };
