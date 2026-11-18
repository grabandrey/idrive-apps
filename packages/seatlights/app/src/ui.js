'use strict';
/*
 * Seat Lights: the app's screen, drawn by the head unit's renderer (gpu.js) over the HMI page. Pure: draw(rec, model)
 * records a frame (renderd draw ops) and returns what a tap or the controller can press. The recorder and glyph
 * atlases are Light Logger's (packages/lightlog/app/src/ui.js). Tested and previewed on a desktop.
 *
 *   Seat Lights
 *          +-----------------------------------------------------------+
 *          |   ( seat, its logo lit )    SEAT LIGHTS                    |
 *          |                             ON            [====( )]       |
 *          |                             On                            |
 *          +-----------------------------------------------------------+
 *                    lamp output 45 · held through the body controller
 *
 * The switch has the key of the HMI list's row under the drawn screen (slSwitch), so the controller's focus there
 * lights it here.
 */
const FONT = require('./ui_font.js');

const W = 2880, H = 764;
const OP = { CLEAR: 1, RECT: 2, RRECT: 4, RSTROKE: 5, GLYPHS: 11, QUAD: 15 };


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
    const key = 'ida_seatlights/' + style + '@' + f.px;
    for (let i = 0; i < key.length; i++) id = (Math.imul(id, 31) + key.charCodeAt(i)) >>> 0;
    atlases[style] = { id: (id | 1) >>> 0, w: AW, h: AH, alpha: alpha, glyphs: glyphs, px: f.px, ascent: f.ascent };
    return atlases[style];
}

/* ---- a frame's draw ops ---- */
class Recorder {
    constructor() { this.u = new Uint32Array(16384); this.f = new Float32Array(this.u.buffer); this.n = 0; this.atlases = []; }
    reset() { this.n = 0; this.atlases = []; return this; }
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
    green: [60, 192, 122, 255], orange: [240, 160, 48, 255], accent: [30, 123, 224, 255], seat: [52, 57, 68, 255],
    seatEdge: [72, 78, 92, 255], logo: [236, 242, 255, 255],
};

/* s cut to fit maxW (with an ellipsis) */
function fit(rec, style, s, maxW) {
    s = String(s);
    if (rec.width(style, s) <= maxW) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rec.width(style, s.slice(0, mid) + '...') <= maxW) lo = mid; else hi = mid - 1; }
    return s.slice(0, lo) + '...';
}

/* a sport seat from the front: headrest with its logo, the backrest, the bolsters */
function seat(rec, cx, top, lit) {
    const hw = 150, hh = 120, bw = 300, bh = 330;
    rec.rrect(cx - bw / 2 - 26, top + hh + 34, 60, bh - 40, 30, C.seatEdge);       // bolsters
    rec.rrect(cx + bw / 2 - 34, top + hh + 34, 60, bh - 40, 30, C.seatEdge);
    rec.rrect(cx - bw / 2, top + hh + 20, bw, bh, 48, C.seat);                     // backrest
    for (let i = 0; i < 4; i++) rec.rect(cx - 60, top + hh + 90 + i * 60, 120, 6, C.line);
    rec.rrect(cx - 26, top + hh - 4, 52, 34, 10, C.seatEdge);                       // the headrest's neck
    rec.rrect(cx - hw / 2, top, hw, hh, 44, C.seat);                                // headrest
    const lx = cx - 46, ly = top + hh / 2 - 18, lw = 92, lh = 36;
    if (lit) [[60, 22], [40, 44], [22, 80]].forEach((g) => rec.rrect(lx - g[0], ly - g[0], lw + 2 * g[0], lh + 2 * g[0], lh / 2 + g[0], [200, 220, 255, g[1]]));
    rec.rrect(lx, ly, lw, lh, 10, lit ? C.logo : C.track);
    rec.rrect(lx + 16, ly + 14, lw - 32, 8, 4, lit ? [190, 205, 235, 255] : C.line);
}

/*
 * model: { on (the switch), holding (the BDC took it), note, warn, output, layout, focus, pressed }
 * Returns { rec, targets: [{ key, x, y, w, h }] }.
 */
function draw(rec, m) {
    rec.reset();
    const targets = [];
    rec.clear(C.bg);
    rec.text('title', 'Seat Lights', 90, 86, C.text);

    const K = { x: 520, y: 130, w: 1840, h: 520 };
    rec.rrect(K.x, K.y, K.w, K.h, 36, C.card);
    seat(rec, K.x + 330, K.y + 24, !!m.holding);

    const tx = K.x + 720;
    rec.text('head', 'SEAT LIGHTS', tx, K.y + 120, C.faint, 'left', 4);
    rec.text('title', m.on ? (m.holding ? 'ON' : 'ON ...') : 'OFF', tx, K.y + 230, m.on ? C.text : C.dim);
    const note = m.note === 'On' || m.note === 'Off' ? (m.holding ? 'The logos are held on' : '') : m.note || '';
    rec.text('body', fit(rec, 'body', note, 1000), tx, K.y + 330, m.warn ? C.orange : m.holding ? C.green : C.dim);
    rec.text('small', 'Keeps the headrest logos lit with the car on, until you switch it off.', tx, K.y + 400, C.faint);

    // the switch
    const sw = 300, sh = 140, sx = K.x + K.w - 90 - sw, sy = K.y + 110, r = sh / 2;
    const onC = m.holding ? C.green : m.on ? C.orange : C.track;
    rec.rrect(sx, sy, sw, sh, r, onC);
    const kx = m.on ? sx + sw - r : sx + r;
    rec.rrect(kx - r + 12, sy + 12, sh - 24, sh - 24, r - 12, C.text);
    if (m.pressed === 'slSwitch') rec.rrect(sx, sy, sw, sh, r, [255, 255, 255, 40]);
    if (m.focus === 'slSwitch') rec.stroke(sx - 10, sy - 10, sw + 20, sh + 20, r + 10, 5, C.accent);
    targets.push({ key: 'slSwitch', x: sx - 20, y: sy - 20, w: sw + 40, h: sh + 40 });

    const info = 'Lamp output ' + (m.output || 45) + (m.layout !== null && m.layout !== undefined ? '  ·  layout ' + (m.layout + 1) : '  ·  layout found the first time it goes on')
        + '  ·  held through the body controller';
    rec.text('small', info, W / 2, K.y + K.h + 70, C.faint, 'center');
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

module.exports = { W, H, OP, Recorder, draw, hit, placement, atlas, pack, fit };
