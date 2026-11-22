'use strict';
/*
 * Remote Play Video: a USB gamepad plugged into the car (a DualSense, a DualShock 4, or another standard pad), read
 * straight from the kernel's input events (/dev/input/eventN, which only root may read; the app can't).
 *
 * Every 2 s it looks in /proc/bus/input/devices for a device with a joystick handler (jsN) and opens its eventN.
 * Events are struct input_event: a time (2 longs), type u16, code u16, value s32 -> 24 bytes on 64-bit, 16 on 32-bit.
 *
 *   const g = new Gamepads({ log }); g.on('state', (name, state) => ..); g.on('gone', () => ..); g.start();
 *   state: { buttons: ['cross', ..], lx, ly, rx, ry (-32768..32767), l2, r2 (0..255) }
 *
 * Axis ranges aren't read (that needs an ioctl Node can't make): Sony pads send 0..255 (sticks, triggers, centre
 * 128); other pads are learnt from the values seen, so a stick is right after it has been moved to its ends once.
 */
const fs = require('fs');
const os = require('os');
const EventEmitter = require('events');

const EV_KEY = 1, EV_ABS = 3, EV_SYN = 0;
const KEYS = {
    0x130: 'cross', 0x131: 'circle', 0x133: 'triangle', 0x134: 'square', 0x136: 'l1', 0x137: 'r1', 0x138: 'l2', 0x139: 'r2',
    0x13a: 'create', 0x13b: 'options', 0x13c: 'ps', 0x13d: 'l3', 0x13e: 'r3',
    0x220: 'up', 0x221: 'down', 0x222: 'left', 0x223: 'right', 0x110: 'touchpad',
};
const ABS = { 0x00: 'lx', 0x01: 'ly', 0x03: 'rx', 0x04: 'ry', 0x02: 'l2', 0x05: 'r2', 0x10: 'hatx', 0x11: 'haty' };

/* /proc/bus/input/devices -> [{ name, event: 'event5' }] for the joysticks */
function joysticks(text) {
    return String(text).split(/\n\s*\n/).map((block) => {
        const name = /N: Name="([^"]*)"/.exec(block), h = /H: Handlers=([^\n]*)/.exec(block);
        if (!h || !/\bjs\d+/.test(h[1])) return null;
        const ev = /\b(event\d+)\b/.exec(h[1]);
        return ev ? { name: name ? name[1] : 'Gamepad', event: ev[1] } : null;
    }).filter(Boolean);
}

/* an axis value -> -32768..32767 (sticks) or 0..255 (triggers), with the range learnt as it goes */
function scaler(sony) {
    const r = {};
    return (axis, v) => {
        let lo, hi;
        if (sony) { lo = 0; hi = 255; } else {
            const a = r[axis] || (r[axis] = { lo: Math.min(v, 0), hi: Math.max(v, 255) });
            if (v < a.lo) a.lo = v;
            if (v > a.hi) a.hi = v;
            lo = a.lo; hi = a.hi;
        }
        const t = hi > lo ? (v - lo) / (hi - lo) : 0;
        if (axis === 'l2' || axis === 'r2') return Math.round(t * 255);
        return Math.max(-32768, Math.min(32767, Math.round(t * 65535 - 32768)));
    };
}

class Gamepads extends EventEmitter {
    constructor(o) {
        super();
        this.log = (o && o.log) || (() => {});
        this.dir = (o && o.dir) || '/dev/input';
        this.devices = (o && o.devices) || '/proc/bus/input/devices';
        this.size = (o && o.eventSize) || (/64/.test(os.arch()) ? 24 : 16);
        this.current = null;       // { name, path, state }
        this.stream = null;
        this.timer = null;
    }

    start() { this._look(); this.timer = setInterval(() => this._look(), 2000); }
    stop() { clearInterval(this.timer); this._close(); }

    _look() {
        if (this.stream) return;
        let list = [];
        try { list = joysticks(fs.readFileSync(this.devices, 'utf8')); } catch (e) { return; }
        if (!list.length) return;
        this._open(list[0]);
    }

    _open(dev) {
        const p = this.dir + '/' + dev.event;
        const sony = /sony|playstation|wireless controller|dualsense|dualshock/i.test(dev.name);
        const scale = scaler(sony);
        const st = { buttons: [], lx: 0, ly: 0, rx: 0, ry: 0, l2: 0, r2: 0 };
        this.current = { name: dev.name, path: p, state: st };
        this.log('info', 'gamepad: ' + dev.name + ' on ' + p);
        const s = fs.createReadStream(p, { highWaterMark: this.size * 64 });
        this.stream = s;
        let rest = Buffer.alloc(0), dirty = false;
        const off = this.size - 8;
        const press = (b, on) => { const i = st.buttons.indexOf(b); if (on && i < 0) st.buttons.push(b); if (!on && i >= 0) st.buttons.splice(i, 1); };
        s.on('data', (d) => {
            const buf = rest.length ? Buffer.concat([rest, d]) : d;
            let at = 0;
            for (; at + this.size <= buf.length; at += this.size) {
                const type = buf.readUInt16LE(at + off), code = buf.readUInt16LE(at + off + 2), value = buf.readInt32LE(at + off + 4);
                if (type === EV_KEY && KEYS[code]) { press(KEYS[code], value !== 0); if (code === 0x138) st.l2 = value ? 255 : st.l2; if (code === 0x139) st.r2 = value ? 255 : st.r2; dirty = true; }
                else if (type === EV_ABS && ABS[code]) {
                    const a = ABS[code];
                    if (a === 'hatx') { press('left', value < 0); press('right', value > 0); }
                    else if (a === 'haty') { press('up', value < 0); press('down', value > 0); }
                    else st[a] = scale(a, value);
                    dirty = true;
                } else if (type === EV_SYN && dirty) { dirty = false; this.emit('state', dev.name, st); }
            }
            rest = buf.slice(at);
        });
        const gone = (why) => {
            if (this.stream !== s) return;
            this.log('info', 'gamepad: ' + dev.name + ' gone (' + why + ')');
            this._close();
            this.emit('gone');
        };
        s.on('error', (e) => gone(e.message));
        s.on('close', () => gone('closed'));
    }

    _close() { const s = this.stream; this.stream = null; this.current = null; if (s) try { s.destroy(); } catch (e) { /* closed */ } }
}

module.exports = { Gamepads, joysticks, scaler, KEYS, ABS };
