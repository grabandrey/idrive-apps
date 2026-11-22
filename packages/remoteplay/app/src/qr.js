'use strict';
/*
 * Remote Play: a QR code for the sign-in page's address, drawn on the car's screen so a phone can open it.
 * Byte mode, error correction level M, versions 1 to 10 (up to 213 bytes: a local address with a token fits in 2-4).
 *
 *   const q = qr.encode('http://192.168.2.1:8890/s/abcd');   // { size, get(x, y) -> true for dark }
 *
 * Written from ISO/IEC 18004 (the block table, the masks, the format and version bits). Node 8.
 */

/* version -> [ec codewords per block, [blocks, data codewords]...] at level M */
const BLOCKS_M = [null,
    [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]],
    [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const EC_M_BITS = 0;              // the format's two error correction bits: L 01, M 00, Q 11, H 10
const MAX_VERSION = 10;

/* ---- GF(256), polynomial 0x11d ---- */
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(function () {
    let v = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = v; LOG[v] = i; v <<= 1; if (v & 0x100) v ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/* the generator polynomial of degree n, highest term first (its leading 1 left out) */
function generator(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
        const next = new Array(g.length + 1).fill(0);
        for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); }
        g = next;
    }
    return g.slice(1);
}
/* the error correction codewords of one block */
function ecFor(data, n) {
    const g = generator(n), rem = new Array(n).fill(0);
    data.forEach((d) => {
        const f = d ^ rem.shift();
        rem.push(0);
        for (let i = 0; i < n; i++) rem[i] ^= mul(g[i], f);
    });
    return rem;
}

function dataCapacity(v) { const b = BLOCKS_M[v]; return b.slice(1).reduce((s, g) => s + g[0] * g[1], 0); }
function byteCapacity(v) { return Math.floor((dataCapacity(v) * 8 - 4 - (v < 10 ? 8 : 16)) / 8); }

/* the data codewords: mode 0100, the count, the bytes, the terminator, padding */
function codewords(bytes, v) {
    const bits = [];
    const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4);
    put(bytes.length, v < 10 ? 8 : 16);
    for (let i = 0; i < bytes.length; i++) put(bytes[i], 8);
    const cap = dataCapacity(v) * 8;
    put(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; out.push(b); }
    for (let p = 0; out.length < cap / 8; p++) out.push(p % 2 ? 0x11 : 0xec);
    return out;
}

/* split into blocks, add each block's error correction, interleave */
function finalCodewords(data, v) {
    const spec = BLOCKS_M[v], n = spec[0], blocks = [];
    let at = 0;
    spec.slice(1).forEach((g) => {
        for (let i = 0; i < g[0]; i++) { const d = data.slice(at, at + g[1]); at += g[1]; blocks.push({ d: d, e: ecFor(d, n) }); }
    });
    const out = [], longest = Math.max.apply(null, blocks.map((b) => b.d.length));
    for (let i = 0; i < longest; i++) blocks.forEach((b) => { if (i < b.d.length) out.push(b.d[i]); });
    for (let i = 0; i < n; i++) blocks.forEach((b) => out.push(b.e[i]));
    return out;
}

/* BCH remainder of value (already shifted) by poly */
function bch(value, poly) {
    const top = 31 - Math.clz32(poly);
    while (value && 31 - Math.clz32(value) >= top) value ^= poly << (31 - Math.clz32(value) - top);
    return value;
}

const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
    constructor(size) { this.size = size; this.dark = new Uint8Array(size * size); this.fixed = new Uint8Array(size * size); }
    set(x, y, d) { const i = y * this.size + x; this.dark[i] = d ? 1 : 0; this.fixed[i] = 1; }
    get(x, y) { return this.dark[y * this.size + x] === 1; }
    isFixed(x, y) { return this.fixed[y * this.size + x] === 1; }
}

function functionPatterns(g, v) {
    const s = g.size;
    const finder = (cx, cy) => {
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x < 0 || y < 0 || x >= s || y >= s) continue;
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            g.set(x, y, d !== 2 && d !== 4);
        }
    };
    finder(3, 3); finder(s - 4, 3); finder(3, s - 4);
    for (let i = 8; i < s - 8; i++) { g.set(i, 6, i % 2 === 0); g.set(6, i, i % 2 === 0); }
    const a = ALIGN[v];
    a.forEach((cy) => a.forEach((cx) => {
        if ((cx === 6 && cy === 6) || (cx === 6 && cy === a[a.length - 1]) || (cx === a[a.length - 1] && cy === 6)) return;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) g.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    formatBits(g, 0);           // reserve the format areas (written again once the mask is chosen)
    if (v >= 7) {
        const bits = (v << 12) | bch(v << 12, 0x1f25);
        for (let i = 0; i < 18; i++) {
            const d = ((bits >>> i) & 1) === 1, a1 = s - 11 + (i % 3), b1 = Math.floor(i / 3);
            g.set(a1, b1, d); g.set(b1, a1, d);
        }
    }
}

function formatBits(g, mask) {
    const s = g.size, data = (EC_M_BITS << 3) | mask;
    const bits = ((data << 10) | bch(data << 10, 0x537)) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) g.set(8, i, bit(i));
    g.set(8, 7, bit(6)); g.set(8, 8, bit(7)); g.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) g.set(s - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) g.set(8, s - 15 + i, bit(i));
    g.set(8, s - 8, true);
}

/* the codewords' bits up and down two columns at a time, from the right, around the fixed modules */
function placeData(g, cw) {
    const s = g.size;
    let i = 0;
    const total = cw.length * 8;
    for (let right = s - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < s; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? s - 1 - vert : vert;
                if (g.isFixed(x, y)) continue;
                const d = i < total && ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
                g.dark[y * s + x] = d ? 1 : 0;
                i++;
            }
        }
    }
}

function applyMask(g, mask) {
    const s = g.size, f = MASKS[mask];
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) if (!g.isFixed(x, y) && f(x, y)) g.dark[y * s + x] ^= 1;
}

/* the standard's four penalties: runs, 2x2 blocks, finder-like patterns, the dark share */
function penalty(g) {
    const s = g.size;
    let p = 0;
    const lineScore = (get) => {
        let score = 0;
        for (let a = 0; a < s; a++) {
            let run = 1;
            const line = [];
            for (let b = 0; b < s; b++) line.push(get(a, b) ? 1 : 0);
            for (let b = 1; b <= s; b++) {
                if (b < s && line[b] === line[b - 1]) run++;
                else { if (run >= 5) score += run - 2; run = 1; }
            }
            const str = line.join('');
            const patt = /(?=(10111010000|00001011101))/g;
            let m;
            while ((m = patt.exec(str))) { score += 40; patt.lastIndex++; }
        }
        return score;
    };
    p += lineScore((a, b) => g.get(b, a));
    p += lineScore((a, b) => g.get(a, b));
    for (let y = 0; y < s - 1; y++) for (let x = 0; x < s - 1; x++) {
        const c = g.get(x, y);
        if (c === g.get(x + 1, y) && c === g.get(x, y + 1) && c === g.get(x + 1, y + 1)) p += 3;
    }
    let dark = 0;
    for (let i = 0; i < s * s; i++) dark += g.dark[i];
    p += Math.floor(Math.abs(dark * 20 - s * s * 10) / (s * s)) * 10;
    return p;
}

function encode(text) {
    const bytes = Buffer.from(String(text), 'utf8');
    let v = 1;
    while (v <= MAX_VERSION && byteCapacity(v) < bytes.length) v++;
    if (v > MAX_VERSION) throw new Error('too long for a QR code here: ' + bytes.length + ' bytes');
    const cw = finalCodewords(codewords(bytes, v), v);
    const size = 17 + 4 * v;
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
        const g = new Grid(size);
        functionPatterns(g, v);
        placeData(g, cw);
        applyMask(g, mask);
        formatBits(g, mask);
        const p = penalty(g);
        if (!best || p < best.p) best = { p: p, g: g, mask: mask };
    }
    const g = best.g;
    return { version: v, mask: best.mask, size: size, get: (x, y) => x >= 0 && y >= 0 && x < size && y < size && g.get(x, y) };
}

module.exports = { encode, byteCapacity, ecFor, generator };
