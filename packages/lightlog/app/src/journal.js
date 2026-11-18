'use strict';
/*
 * Light Logger: what happened, in order. Pure (the clock is passed in), tested on a desktop by tools/test_lightlog.js.
 *
 *   const j = new Journal({ now: Date.now });
 *   j.lights(bus, modules | null)   a read of one LIN bus (lin.parseStatus), or null when the BDC didn't answer:
 *                                   each module that appears, goes, switches on or off, or changes brightness or
 *                                   colour becomes an event
 *   j.rpm(raw) / j.speed(raw)       CDS.statusEngineSpeed2 / Vehicle2.statusCarSpeed2: engine started or stopped,
 *                                   car moving or standing
 *   j.mark()                        the driver's own mark ("the logo just went off")
 *   j.events                        newest last: [{ t, kind, text, seat }]   j.on('event', fn)
 *   j.modules()                     every module of the latest reads, by bus and place
 *
 * Kinds: light, seat (a light in or on a seat), car, mark, link.
 */
const EventEmitter = require('events');
const lin = require('./lin.js');

const MAX = 400;
const BRIGHT_STEP = 5;          // % of brightness that counts as a change
const COLOUR_STEP = 8;          // of 255 in any channel
const RPM = { factor: 0.25, invalid: 65535, on: 400, off: 50 };
const SPEED = { factor: 0.015625, invalid: 65535, moving: 3, standing: 0.5 };

const pad = (n) => (n < 10 ? '0' : '') + n;
function clock(t) { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }

function scaled(raw, c) { return typeof raw === 'number' && isFinite(raw) && raw !== c.invalid ? raw * c.factor : null; }

class Journal extends EventEmitter {
    constructor(o) {
        super();
        this.now = (o && o.now) || Date.now;
        this.events = [];
        this._buses = [null, null];         // per bus: Map(nad -> module), null before its first answer
        this._silent = [0, 0];              // reads without an answer in a row
        this.engine = null;                 // true running / false off / null unknown
        this.moving = null;
        this.rpmValue = null; this.kmh = null;
        this.marks = 0;
    }

    _add(kind, text, seat) {
        const e = { t: this.now(), kind: kind, text: text, seat: !!seat };
        this.events.push(e);
        if (this.events.length > MAX) this.events.splice(0, this.events.length - MAX);
        this.emit('event', e);
        return e;
    }

    lights(bus, modules) {
        const name = lin.BUSES[bus].name;
        if (!modules) {
            this._silent[bus]++;
            if (this._silent[bus] === 3) this._add('link', name + ': the body controller stopped answering');
            return;
        }
        if (this._silent[bus] >= 3) this._add('link', name + ': the body controller answers again');
        this._silent[bus] = 0;
        const before = this._buses[bus];
        const now = new Map();
        modules.forEach((m) => now.set(m.nad, m));
        this._buses[bus] = now;
        if (!before) {
            this._add('link', name + ': ' + modules.length + ' light modules, ' + modules.filter((m) => m.on).length + ' on');
            modules.forEach((m) => this._add(m.seat ? 'seat' : 'light', 'found ' + lin.describe(m), m.seat));
            return;
        }
        now.forEach((m, nad) => {
            const old = before.get(nad);
            if (!old || old.loc !== m.loc) { this._add(m.seat ? 'seat' : 'light', 'new ' + lin.describe(m), m.seat); return; }
            const what = change(old, m);
            if (what) this._add(m.seat ? 'seat' : 'light', what + ': ' + lin.describe(m), m.seat);
        });
        before.forEach((m, nad) => {
            if (!now.has(nad)) this._add(m.seat ? 'seat' : 'light', 'gone ' + m.name + ' (' + name + ' #' + nad + ')', m.seat);
        });
    }

    rpm(v) {
        const r = scaled(v && v.actualValueRPMEngineCrankshaft, RPM);
        if (r === null) return;
        this.rpmValue = r;
        if (r >= RPM.on && this.engine !== true) { this.engine = true; this._add('car', 'engine running (' + Math.round(r) + ' rpm)'); }
        else if (r <= RPM.off && this.engine !== false) { this.engine = false; this._add('car', 'engine off'); }
    }

    speed(v) {
        const k = scaled(v && v.speedVehicleCentreOfGravity, SPEED);
        if (k === null) return;
        this.kmh = k;
        if (k >= SPEED.moving && this.moving !== true) { this.moving = true; this._add('car', 'moving (' + Math.round(k) + ' km/h)'); }
        else if (k <= SPEED.standing && this.moving !== false) { this.moving = false; this._add('car', 'standing still'); }
    }

    mark() { this.marks++; return this._add('mark', 'MARK ' + this.marks + ' (pressed on the screen)'); }

    note(text) { return this._add('link', text); }

    clear() { this.events = []; this.marks = 0; }

    modules() {
        const out = [];
        this._buses.forEach((m) => { if (m) m.forEach((x) => out.push(x)); });
        return out;
    }

    answered(bus) { return !!this._buses[bus]; }
}

/* what changed between two reads of one module, or '' */
function change(a, b) {
    if (a.on !== b.on) return b.on ? 'ON' : 'OFF';
    if (a.fault !== b.fault) return b.fault ? 'fault' : 'fault cleared';
    if (Math.abs(a.bright - b.bright) >= BRIGHT_STEP) return 'brightness ' + a.bright + '% -> ' + b.bright + '%';
    if (b.on && (Math.abs(a.r - b.r) >= COLOUR_STEP || Math.abs(a.g - b.g) >= COLOUR_STEP || Math.abs(a.b - b.b) >= COLOUR_STEP ||
        Math.abs(a.white - b.white) >= COLOUR_STEP)) return 'colour';
    return '';
}

/* one event as a line: "14:02:31  SEAT  OFF: Driver seat back (...)" */
function line(e) {
    const tag = { light: 'light', seat: 'SEAT ', car: 'car  ', mark: 'MARK ', link: 'link ' }[e.kind] || e.kind;
    return clock(e.t) + '  ' + tag + '  ' + e.text;
}

module.exports = { Journal, change, line, clock, RPM, SPEED };
