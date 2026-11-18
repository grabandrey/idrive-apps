'use strict';
/*
 * Seat Lights: the app's screen, drawn by the head unit's renderer (gpu.js) over the HMI page. Pure: draw(rec, model)
 * records a frame (renderd draw ops) and returns what a tap or the controller can press. The recorder and glyph
 * atlases are Light Logger's (packages/lightlog/app/src/ui.js). Tested and previewed on a desktop.
 *
 *   Seat Lights
 *          +-----------------------------------------------------------+
 *          |   ( the headrest badge )    SEAT LIGHTS                    |
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

/* the headrest's badge, as on the G87 M2: dark leather with a curved stitched seam, a chrome-rimmed glass window,
 * the three stripes and the model's name in slanted strokes; lit, the lettering glows. Drawn with rrects and quads. */
const STRIPES = [[43, 162, 224], [36, 62, 148], [226, 34, 40]];
function shade(c, k, a) { return [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k), a === undefined ? 255 : a]; }

function badge(rec, cx, cy, lit) {
    // the leather: the headrest's face, a lighter top, the seam below the badge (dashes along a curve)
    const LW = 600, LH = 470, lx = cx - LW / 2, ly = cy - LH / 2;
    rec.rrect(lx, ly, LW, LH, 70, [22, 23, 26, 255]);
    rec.rrect(lx + 18, ly + 14, LW - 36, LH * 0.42, 60, [30, 31, 35, 255]);
    rec.rrect(lx + LW - 54, ly + 50, 30, LH - 100, 15, [19, 20, 23, 255]);            // the headrest's edge, right
    rec.rrect(lx + 24, ly + 50, 26, LH - 100, 13, [25, 26, 30, 255]);                 // and left
    const seam = (y0, dy, col) => {
        for (let i = 0; i < 26; i++) {
            const t0 = i / 26, t1 = (i + 0.55) / 26;
            const p = (t) => [lx + 70 + t * (LW - 140), y0 + dy * Math.sin(Math.PI * t)];
            const a = p(t0), b = p(t1);
            rec.quad([[a[0], a[1] - 1.5], [b[0], b[1] - 1.5], [b[0], b[1] + 1.5], [a[0], a[1] + 1.5]], col);
        }
    };
    seam(cy + 150, 40, [92, 95, 102, 255]);
    seam(cy + 172, 40, [60, 62, 68, 255]);
    rec.quad([[lx + 60, cy + 196], [lx + LW - 60, cy + 196], [lx + LW - 60, cy + 200], [lx + 60, cy + 200]], [12, 13, 15, 255]);

    // the badge: chrome rim (dark edge, bright face, inner shadow), the glass
    const BW = 440, BH = 180, bx = cx - BW / 2, by = cy - BH / 2 - 30;
    rec.rrect(bx - 6, by - 6, BW + 12, BH + 12, 52, [70, 72, 78, 255]);
    rec.rrect(bx, by, BW, BH, 46, [196, 199, 205, 255]);
    rec.rrect(bx + 4, by + 3, BW - 8, BH * 0.45, 42, [226, 229, 234, 255]);         // the rim's highlight, top
    rec.rrect(bx + 12, by + 12, BW - 24, BH - 24, 36, [110, 113, 120, 255]);
    const gx = bx + 16, gy = by + 16, gw = BW - 32, gh = BH - 32;
    rec.rrect(gx, gy, gw, gh, 32, lit ? [26, 28, 34, 255] : [14, 15, 18, 255]);
    rec.rrect(gx + 14, gy + 6, gw - 28, gh * 0.3, 22, [255, 255, 255, lit ? 9 : 5]);  // the glass's sheen

    // the lettering, slanted forward: three stripes, then M and 2 in strokes
    const H = 70, base = gy + gh / 2 + H / 2, slant = 0.27;
    const P = (x, y) => [x + (base - y) * slant, y];
    const Q = (pts, c) => rec.quad(pts.map((p) => P(p[0], p[1])), c);
    const x0 = gx + 70, top = base - H;
    const glyphs = [];                               // the M2 strokes, in local coordinates, for the glow too
    const st = 15;                                   // stroke width
    const mx = x0 + 112, mw = 92;
    glyphs.push([[mx, base], [mx + st, base], [mx + st, top], [mx, top]]);                                  // M: left stem
    glyphs.push([[mx + mw - st, base], [mx + mw, base], [mx + mw, top], [mx + mw - st, top]]);                // right stem
    glyphs.push([[mx, top], [mx + st + 2, top], [mx + mw / 2 + st / 2, base - H * 0.38], [mx + mw / 2 - st / 2, base - H * 0.38]]);
    glyphs.push([[mx + mw - st - 2, top], [mx + mw, top], [mx + mw / 2 + st / 2, base - H * 0.38], [mx + mw / 2 - st / 2, base - H * 0.38]]);
    const tx = mx + mw + 26, tw = 70;
    glyphs.push([[tx + 4, top], [tx + tw - 10, top], [tx + tw - 10, top + st], [tx + 4, top + st]]);         // 2: the top
    glyphs.push([[tx + tw - 10, top], [tx + tw, top + 10], [tx + tw, base - H * 0.5], [tx + tw - st, base - H * 0.5]]);   // the right
    glyphs.push([[tx + tw - st, base - H * 0.5 - 6], [tx + tw, base - H * 0.5], [tx + st, base - st + 2], [tx, base - st]]);  // the diagonal
    glyphs.push([[tx, base - st], [tx + tw, base - st], [tx + tw, base], [tx, base]]);                      // the bottom
    glyphs.push([[tx, top + st], [tx + st, top + st], [tx + st, top + 26], [tx, top + 26]]);                 // the top's turn-down

    if (lit) {
        // the glow: a halo traced around each stroke (the stroke repeated, shifted all around, fainter further out)
        [[14, 6], [10, 9], [6.5, 16], [3.5, 30], [1.8, 55]].forEach((ring) => {
            const d = ring[0];
            [[d, 0], [-d, 0], [0, d], [0, -d], [d * 0.7, d * 0.7], [-d * 0.7, d * 0.7], [d * 0.7, -d * 0.7], [-d * 0.7, -d * 0.7]].forEach((o) => {
                glyphs.forEach((q) => Q(q.map((pt) => [pt[0] + o[0], pt[1] + o[1]]), [225, 235, 255, ring[1]]));
            });
        });
    }
    STRIPES.forEach((c, i) => {
        const sx = x0 + i * 30;
        Q([[sx, base - 6], [sx + 22, base - 6], [sx + 22, top + 14], [sx, top + 14]], lit ? c.concat(255) : shade(c, 0.32));
    });
    glyphs.forEach((q) => Q(q, lit ? [248, 250, 253, 255] : [64, 67, 74, 255]));
}

/*
 * model: { on (the switch), holding (the BDC took it), bypassed (locked, engine off), note, warn, output, layout, focus, pressed }
 * Returns { rec, targets: [{ key, x, y, w, h }] }.
 */
function draw(rec, m) {
    rec.reset();
    const targets = [];
    rec.clear(C.bg);
    rec.text('title', 'Seat Lights', 90, 86, C.text);

    const K = { x: 520, y: 130, w: 1840, h: 520 };
    rec.rrect(K.x, K.y, K.w, K.h, 36, C.card);
    badge(rec, K.x + 330, K.y + K.h / 2 + 10, !!m.holding);

    const tx = K.x + 720;
    rec.text('head', 'SEAT LIGHTS', tx, K.y + 120, C.faint, 'left', 4);
    rec.text('title', !m.on ? 'OFF' : m.holding ? 'ON' : m.bypassed ? 'ON  ·  LOCKED' : 'ON ...', tx, K.y + 230, m.on ? C.text : C.dim);
    const note = m.note === 'On' || m.note === 'Off' ? (m.holding ? 'The logos are held on' : '') : m.note || '';
    rec.text('body', fit(rec, 'body', note, 1000), tx, K.y + 330, m.warn ? C.orange : m.holding ? C.green : C.dim);
    rec.text('small', 'Keeps the headrest logos lit until you switch it off. Off while the car is locked.', tx, K.y + 400, C.faint);

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
