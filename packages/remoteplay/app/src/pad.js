'use strict';
/*
 * Remote Play: the touch controller on the Play screen, and the controller state the engine gets (links.js "input").
 *
 * The game's picture fills the middle of the screen at 16:9; the controls sit in the bands left and right of it:
 *
 *    [L2][L1]                                          [R1][R2]
 *      ( left stick )     +-------------------+      (  /\  )
 *         [^]             |                   |    ([])    (O)
 *      [<]   [>]          |   the game        |      (  X  )
 *         [v]             |                   |    ( right stick )
 *    [Create] [Exit]      +-------------------+    [PS] [Options]
 *
 * The renderer reports one touch at a time (gpu.js), so a stick held is let go before a button is pressed. A USB
 * gamepad on the car (the video tool reads it) does everything at once, and takes over while it is plugged in.
 *
 * Pure: layout(W, H) and Pad (touch -> state). Tested on a desktop.
 */
const BUTTONS = ['cross', 'circle', 'square', 'triangle', 'left', 'right', 'up', 'down', 'l1', 'r1', 'l2', 'r2', 'l3', 'r3',
    'options', 'create', 'ps', 'touchpad'];
const STICK_MAX = 32767;

/* the controls in the logical screen (ui.W x ui.H): video rect, and each control's rect */
function layout(W, H) {
    const vh = H, vw = Math.round(vh * 16 / 9), vx = Math.round((W - vw) / 2);
    const band = vx, L = 0, R = vx + vw, mid = (x0) => x0 + band / 2;
    const c = [];
    const btn = (key, x, y, w, h, label, shape) => c.push({ key: key, x: Math.round(x), y: Math.round(y), w: w, h: h, label: label, shape: shape || 'pill' });
    const stick = (key, cx, cy, r) => c.push({ key: key, x: Math.round(cx - r), y: Math.round(cy - r), w: r * 2, h: r * 2, r: r, shape: 'stick' });
    const sh = 70, sw = Math.min(150, (band - 60) / 2);
    // shoulders
    btn('l2', mid(L) - sw - 10, 18, sw, sh, 'L2'); btn('l1', mid(L) + 10, 18, sw, sh, 'L1');
    btn('r1', mid(R) - sw - 10, 18, sw, sh, 'R1'); btn('r2', mid(R) + 10, 18, sw, sh, 'R2');
    // left: stick, d-pad
    const sr = Math.min(130, band / 2 - 40);
    stick('lstick', mid(L), 250, sr);
    const d = 96, dc = { x: mid(L), y: 520 };
    btn('up', dc.x - d / 2, dc.y - d * 1.5, d, d, '', 'up'); btn('down', dc.x - d / 2, dc.y + d / 2, d, d, '', 'down');
    btn('left', dc.x - d * 1.5, dc.y - d / 2, d, d, '', 'left'); btn('right', dc.x + d / 2, dc.y - d / 2, d, d, '', 'right');
    // right: face buttons, stick
    const f = 104, fc = { x: mid(R), y: 260 };
    btn('triangle', fc.x - f / 2, fc.y - f * 1.45, f, f, '', 'triangle'); btn('cross', fc.x - f / 2, fc.y + f * 0.45, f, f, '', 'cross');
    btn('square', fc.x - f * 1.45, fc.y - f / 2, f, f, '', 'square'); btn('circle', fc.x + f * 0.45, fc.y - f / 2, f, f, '', 'circle');
    stick('rstick', mid(R), 540, Math.min(110, sr));
    // system
    const bw = Math.min(150, (band - 60) / 2), by = H - 80;
    btn('create', mid(L) - bw - 10, by, bw, 60, 'Create'); btn('exit', mid(L) + 10, by, bw, 60, 'Exit');
    btn('ps', mid(R) - bw - 10, by, bw, 60, 'PS'); btn('options', mid(R) + 10, by, bw, 60, 'Options');
    return { video: { x: vx, y: 0, w: vw, h: vh }, controls: c };
}

function neutral() { return { buttons: [], lx: 0, ly: 0, rx: 0, ry: 0, l2: 0, r2: 0 }; }

class Pad {
    constructor(W, H) { this.lay = layout(W, H); this.state = neutral(); this.down = null; this.changed = false; }

    control(x, y) {
        const cs = this.lay.controls;
        for (let i = cs.length - 1; i >= 0; i--) {
            const t = cs[i];
            const pad = t.shape === 'stick' ? t.r * 0.4 : 12;          // a little slack around each
            if (x >= t.x - pad && x < t.x + t.w + pad && y >= t.y - pad && y < t.y + t.h + pad) return t;
        }
        return null;
    }

    /* phase 1 down, 2 move, 3 up (gpu.js); returns 'exit' when Exit was tapped */
    touch(phase, x, y) {
        if (phase === 1) {
            const t = this.control(x, y);
            this.down = t;
            if (!t) return null;
            if (t.shape === 'stick') this._stick(t, x, y);
            else if (t.key !== 'exit') this._press(t.key, true);
            return null;
        }
        const t = this.down;
        if (!t) return null;
        if (phase === 2) { if (t.shape === 'stick') this._stick(t, x, y); return null; }
        if (phase === 3) {
            this.down = null;
            if (t.shape === 'stick') this._center(t.key);
            else if (t.key === 'exit') return this.control(x, y) === t ? 'exit' : null;
            else this._press(t.key, false);
        }
        return null;
    }

    _press(key, on) {
        if (BUTTONS.indexOf(key) < 0) return;
        const b = this.state.buttons, i = b.indexOf(key);
        if (on && i < 0) b.push(key);
        if (!on && i >= 0) b.splice(i, 1);
        if (key === 'l2') this.state.l2 = on ? 255 : 0;
        if (key === 'r2') this.state.r2 = on ? 255 : 0;
        this.changed = true;
    }

    _stick(t, x, y) {
        const cx = t.x + t.r, cy = t.y + t.r;
        let dx = (x - cx) / t.r, dy = (y - cy) / t.r;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 1) { dx /= len; dy /= len; }
        const ax = Math.round(dx * STICK_MAX), ay = Math.round(dy * STICK_MAX);
        if (t.key === 'lstick') { this.state.lx = ax; this.state.ly = ay; } else { this.state.rx = ax; this.state.ry = ay; }
        this.changed = true;
    }

    _center(key) {
        if (key === 'lstick') { this.state.lx = 0; this.state.ly = 0; } else { this.state.rx = 0; this.state.ry = 0; }
        this.changed = true;
    }

    release() { this.state = neutral(); this.down = null; this.changed = true; }

    /* the state once per change (null when nothing changed) */
    take() { if (!this.changed) return null; this.changed = false; return JSON.parse(JSON.stringify(this.state)); }
}

module.exports = { Pad, layout, neutral, BUTTONS, STICK_MAX };
