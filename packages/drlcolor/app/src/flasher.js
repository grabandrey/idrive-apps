'use strict';
/*
 * DRL Colour: flashes the high beams three times through the body controller, the signal an aftermarket DRL module
 * takes to change colour (yellow <-> white). Tested on a desktop by tools/test_drlcolor.js, against a fake body
 * controller.
 *
 * Which lamp outputs are the high beams isn't in any public table, so the app learns them once (learn()):
 *   22 E3B9 (or 22 4500)        the body controller's lamp outputs (lamps.js), read once with nothing flashing,
 *                               then every SAMPLE_MS for LEARN_MS while the driver flashes the high beams with the
 *                               stalk. The outputs that were off, went on, and are off again at the end, as often
 *                               as the most-flashed one, are the high beams (left and right, usually two)
 *   10 03, 2F <ctl> <layout>    the record layout the body controller takes (uds.js FORMATS, as Seat Lights finds
 *                               it): one short flash of the first high beam output, read back: lit, with nothing
 *                               else switching on. Then 2F <ctl> <back>, 10 01
 * Outputs, layout and identifier are saved, and used directly from then on.
 *
 * A flash (flash()), only with the car standing (or its speed not known):
 *   10 03                                   the extended diagnostic session
 *   COUNT x: 2F <ctl> <on> per output, ON_MS, 2F <ctl> <back> per output, OFF_MS
 *   10 01                                   back to the default session
 * Anything refused on the way: every output handed back at once, the session ended, the colour left as it was.
 * The output is only ever held for ON_MS; if the app dies mid-flash the body controller ends the session after a
 * few seconds and takes the output back by itself.
 *
 * The colour can't be read from the module, so the app counts: each complete flash swaps yellow and white
 * (setColour() corrects it). Auto (setAuto(true)): at each engine start, once the car stands, it flashes once
 * (for modules that come back yellow every time the car is off).
 *
 *   const f = new Flasher({ uds, log, outputs, layout, statusDid, colour, auto });
 *   f.learn()  f.flash()  f.setColour('white' | 'yellow' | null)  f.setAuto(bool)  f.car({ engine, kmh })  f.stop()
 *   f.state -> { outputs, layout, colour, auto, busy, ready, note, warn, learnLeft }
 *   f.on('change'), f.on('save', { outputs, layout, statusDid, colour, auto })
 */
const EventEmitter = require('events');
const { FORMATS } = require('./uds.js');
const lamps = require('./lamps.js');

const BDC = 0x40;
const COUNT = 3;
const ON_MS = 250;
const OFF_MS = 350;
const LEARN_MS = 8000;
const SAMPLE_MS = 150;
const SETTLE_MS = 500;
const MAX_KMH = 3;
const MAX_OUTPUTS = 4;
const AUTO_DELAY_MS = 4000;       // after the engine starts: the DRLs on, the module awake
const STATUS_DIDS = [[0xe3, 0xb9], [0x45, 0x00]];
const CONTROL = { 'E3B9': [0xe3, 0xb5], '4500': [0x45, 0x01] };
const NEXT_LAYOUT = [0x12, 0x13, 0x31];
const NRC = {
    0x10: 'general reject', 0x11: 'service not supported', 0x12: 'sub-function not supported', 0x13: 'bad length',
    0x21: 'busy', 0x22: 'conditions not correct', 0x31: 'out of range', 0x33: 'security access denied',
    0x7e: 'not supported in this session', 0x7f: 'not supported in this session',
};
const hex = (b) => (b || []).map((x) => (x < 16 ? '0' : '') + x.toString(16).toUpperCase()).join(' ');
const why = (r) => (!r ? 'no answer' : r[0] === 0x7f ? 'refused: ' + (NRC[r[2]] || 'NRC 0x' + hex([r[2]])) : 'answer ' + hex(r.slice(0, 4)));
const key = (did) => hex(did).replace(' ', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const other = (c) => (c === 'white' ? 'yellow' : c === 'yellow' ? 'white' : null);
const validOutputs = (o) => Array.isArray(o) && o.length > 0 && o.length <= MAX_OUTPUTS && o.every((x) => Number.isInteger(x) && x >= 1 && x <= 256);

class Flasher extends EventEmitter {
    constructor(o) {
        super();
        this.uds = o.uds; this.log = o.log; this.now = o.now || Date.now;
        this.count = o.count || COUNT;
        this.onMs = o.onMs || ON_MS;
        this.offMs = o.offMs || OFF_MS;
        this.learnMs = o.learnMs || LEARN_MS;
        this.sampleMs = o.sampleMs || SAMPLE_MS;
        this.settleMs = o.settleMs === undefined ? SETTLE_MS : o.settleMs;
        this.autoDelayMs = o.autoDelayMs === undefined ? AUTO_DELAY_MS : o.autoDelayMs;
        this.outputs = validOutputs(o.outputs) ? o.outputs.slice() : [];
        this.layout = Number.isInteger(o.layout) && FORMATS[o.layout] ? o.layout : null;
        this.statusDid = Array.isArray(o.statusDid) && CONTROL[key(o.statusDid)] ? o.statusDid : null;
        this.colour = o.colour === 'white' || o.colour === 'yellow' ? o.colour : null;
        this.auto = o.auto === true;
        this.engine = null; this.kmh = null;
        this.busy = null;                   // 'learn' | 'flash' | null
        this.note = this.ready ? 'Ready' : 'Learn the high beams first'; this.warn = false;
        this._learnEnd = 0;
        this._stopping = false;
        this._autoPending = false; this._autoAt = 0; this._autoTimer = null;
    }

    get ready() { return this.outputs.length > 0 && this.layout !== null && !!this.statusDid; }
    get ctl() { return this.statusDid ? CONTROL[key(this.statusDid)] : null; }

    get state() {
        return { outputs: this.outputs.slice(), layout: this.layout, colour: this.colour, auto: this.auto, busy: this.busy,
            ready: this.ready, note: this.note, warn: this.warn, engine: this.engine, kmh: this.kmh,
            learnLeft: this.busy === 'learn' && this._learnEnd ? Math.max(0, Math.ceil((this._learnEnd - this.now()) / 1000)) : 0 };
    }

    _say(text, warn) {
        this.note = text; this.warn = !!warn;
        (warn ? this.log.warn : this.log.info).call(this.log, 'drl: ' + text);
        this.emit('change');
    }
    _save() { this.emit('save', { outputs: this.outputs, layout: this.layout, statusDid: this.statusDid, colour: this.colour, auto: this.auto }); }

    setColour(c) {
        this.colour = c === 'white' || c === 'yellow' ? c : null;
        this.log.info('drl: colour set to ' + (this.colour || 'not known') + ' by hand');
        this._save(); this.emit('change');
    }

    setAuto(on) {
        this.auto = !!on;
        this.log.info('drl: auto white ' + (this.auto ? 'ON' : 'OFF'));
        this._save(); this.emit('change');
        if (this.auto && this.engine === true) { this._autoPending = true; this._autoAt = this.now(); this._autoCheck(); }
    }

    /* the car's state, from the app: { engine: true | false }, { kmh } */
    car(c) {
        if (c && typeof c.kmh === 'number') this.kmh = c.kmh;
        if (c && c.engine !== undefined && c.engine !== this.engine) {
            const started = c.engine === true;
            this.engine = c.engine;
            this.log.info('drl: engine ' + (started ? 'running' : 'off'));
            if (started && this.auto) {
                // the module came back yellow with the car off: flashed once the car stands, AUTO_DELAY_MS after the start
                this._autoPending = true; this._autoAt = this.now() + this.autoDelayMs;
                this.colour = 'yellow';
                this._save(); this.emit('change');
            }
            if (!started) this._autoPending = false;
        }
        this._autoCheck();
    }

    _autoCheck() {
        if (!this._autoPending || this._stopping) return;
        if (!this.auto || this.engine !== true) { this._autoPending = false; return; }
        const left = this._autoAt - this.now();
        if (left > 0 || this.busy || (this.kmh !== null && this.kmh > MAX_KMH)) {
            // asked again later (the delay, a learn or flash in progress, the car moving)
            if (!this._autoTimer) this._autoTimer = setTimeout(() => { this._autoTimer = null; this._autoCheck(); }, Math.max(left, 1000));
            return;
        }
        this._autoPending = false;
        if (!this.ready) { this._say('Auto white: learn the high beams first', true); return; }
        if (this.colour === 'white') return;
        this.log.info('drl: auto white: flashing');
        this.flash();
    }

    /* the lamp outputs, with whichever status identifier answers: [values] | null */
    _read(timeoutMs) {
        const order = this.statusDid ? [this.statusDid] : STATUS_DIDS;
        return order.reduce((p, did) => p.then((got) => {
            if (got) return got;
            return this.uds.read(BDC, did, timeoutMs || 3000).then((r) => {
                const mods = r ? lamps.parse(r, did) : null;
                if (!mods) return null;
                if (!this.statusDid) this.statusDid = did;
                return mods.map((m) => m.value);
            }, () => null);
        }), Promise.resolve(null));
    }

    /* one control request for one output (uds.js lets through one output at a time: the one named here) */
    _ctl(output, on) {
        const el = output - 1;
        this.uds.allowControl(el);
        return this.uds.control(BDC, 0x2f, this.ctl.concat(on ? FORMATS[this.layout].on(el) : FORMATS[this.layout].back(el)));
    }

    /* ---- learn: which outputs are the high beams, and the layout ---- */
    learn() {
        if (this.busy) return Promise.resolve(false);
        if (this.kmh !== null && this.kmh > MAX_KMH) { this._say('Learning only with the car standing', true); return Promise.resolve(false); }
        this.busy = 'learn';
        this._learnEnd = 0;
        this._say('Learning: reading the lamp outputs...');
        let base = null;
        return this._read(8000).then((v) => {
            if (!v) throw new Error('the body controller didn\'t report its lamp outputs');
            base = v;
            const seen = v.map(() => 0), edges = v.map(() => 0);
            let prev = v, last = v, samples = 0;
            this._learnEnd = this.now() + this.learnMs;
            this._say('Now flash the high beams 3 times with the stalk');
            const loop = () => {
                if (this._stopping) throw new Error('stopped');
                if (this.now() >= this._learnEnd) return { seen: seen, edges: edges, last: last, samples: samples };
                const t0 = this.now();
                return this._read().then((s) => {
                    if (s) {
                        samples++;
                        s.forEach((x, i) => {
                            if (!(base[i] > 0) && x > 0) seen[i]++;
                            if (x > 0 && !(prev[i] > 0)) edges[i]++;
                        });
                        prev = s; last = s;
                        this.emit('change');
                    }
                    return sleep(Math.max(0, this.sampleMs - (this.now() - t0)));
                }).then(loop);
            };
            return loop();
        }).then((r) => {
            this._learnEnd = 0;
            return this._read().then((end) => {
                const last = end || r.last;
                let cands = r.seen.map((n, i) => (n > 0 && !(last[i] > 0) && r.edges[i] > 0 ? i : -1)).filter((i) => i >= 0);
                const most = cands.reduce((m, i) => Math.max(m, r.edges[i]), 0);
                cands = cands.filter((i) => r.edges[i] === most);
                const stuck = r.seen.map((n, i) => (n > 0 && last[i] > 0 ? i + 1 : -1)).filter((x) => x > 0);
                this.log.info('drl: learn: ' + r.samples + ' reads; flashed: ' + (cands.map((i) => (i + 1) + ' (' + r.edges[i] + 'x)').join(', ') || 'none') +
                    (stuck.length ? '; went on and stayed on: ' + stuck.join(', ') : ''));
                if (!cands.length) {
                    throw new Error('nothing went on and off again' + (r.samples < 5 ? ' (only ' + r.samples + ' reads)' : '') +
                        '. Flash the high beams while it learns; if that was done, this car\'s high beams aren\'t body controller lamp outputs');
                }
                if (cands.length > MAX_OUTPUTS) throw new Error(cands.length + ' outputs flashed together (' + cands.map((i) => i + 1).join(', ') + '): too many to tell. Try again with only the high beams');
                const outputs = cands.map((i) => i + 1);
                return this.layout !== null ? outputs : this._probe(outputs, last).then(() => outputs);
            });
        }).then((outputs) => {
            this.outputs = outputs;
            this.busy = null;
            this._save();
            this._say('Learned: the high beams are lamp output' + (outputs.length > 1 ? 's ' : ' ') + outputs.join(' and ') +
                ' (layout ' + (this.layout + 1) + '). Ready');
            return true;
        }, (e) => {
            this._learnEnd = 0;
            this.busy = null;
            this._say('Not learned: ' + ((e && e.message) || e), true);
            return false;
        });
    }

    /* the first time: the record layout, with one short flash of the first output (see the top of this file) */
    _probe(outputs, before) {
        const out = outputs[0], idx = out - 1;
        this._say('Checking: the high beams flash once');
        const tryOne = (f) => {
            if (f >= FORMATS.length) return Promise.reject(new Error('the body controller took none of the ' + FORMATS.length + ' layouts'));
            this.layout = f;
            return this._ctl(out, true).then((a) => {
                this.log.info('drl: layout ' + (f + 1) + ' (output ' + out + '): ' + (a && a[0] === 0x6f ? 'taken' : why(a)));
                if (a && a[0] === 0x7f && NEXT_LAYOUT.indexOf(a[2]) >= 0) return tryOne(f + 1);
                if (!a || a[0] !== 0x6f) throw new Error('the body controller didn\'t take it: ' + why(a));
                return sleep(this.settleMs).then(() => this._read()).then((after) => {
                    return this._ctl(out, false).catch(() => null).then(() => {
                        if (!after) throw new Error('couldn\'t read the outputs back');
                        const others = after.map((v, i) => (i !== idx && v > 0 && !(before[i] > 0) && outputs.indexOf(i + 1) < 0 ? i + 1 : null)).filter((x) => x !== null);
                        if (others.length) throw new Error('layout ' + (f + 1) + ' also switched on lamp output ' + others.join(', ') + ': stopped');
                        if (!(after[idx] > 0)) return tryOne(f + 1);
                        return undefined;
                    });
                });
            });
        };
        return this.uds.control(BDC, 0x10, [0x03]).then((s) => {
            if (!s || s[0] !== 0x50) throw new Error('the body controller didn\'t open the session: ' + why(s));
            return tryOne(0);
        }).then(() => this._end(), (e) => { this.layout = null; return this._end().then(() => { throw e; }); });
    }

    _end() { return this.uds.control(BDC, 0x10, [0x01]).catch(() => null); }

    /* ---- the three flashes ---- */
    flash() {
        if (this.busy) return Promise.resolve(false);
        if (!this.ready) { this._say('Learn the high beams first', true); return Promise.resolve(false); }
        if (this.kmh !== null && this.kmh > MAX_KMH) { this._say('Only with the car standing (' + Math.round(this.kmh) + ' km/h)', true); return Promise.resolve(false); }
        this.busy = 'flash';
        const from = this.colour, t0 = this.now();
        let lit = false;
        this._say('Flashing the high beams ' + this.count + ' times...');
        const all = (on) => this.outputs.reduce((p, out) => p.then((bad) => {
            if (bad) return bad;
            return this._ctl(out, on).then((r) => (r && r[0] === 0x6f ? null : 'output ' + out + ' ' + (on ? 'on' : 'off') + ': ' + why(r)));
        }), Promise.resolve(null));
        const one = (k) => {
            if (k >= this.count) return Promise.resolve();
            if (this._stopping) return Promise.reject(new Error('the app is stopping'));
            lit = true;
            return all(true).then((bad) => {
                if (bad) throw new Error(bad);
                return sleep(this.onMs);
            }).then(() => all(false)).then((bad) => {
                if (bad) throw new Error(bad);
                lit = false;
                return k + 1 < this.count ? sleep(this.offMs) : undefined;
            }).then(() => one(k + 1));
        };
        return this.uds.control(BDC, 0x10, [0x03]).then((s) => {
            if (!s || s[0] !== 0x50) throw new Error('the body controller didn\'t open the session: ' + why(s));
            return one(0);
        }).then(() => this._end()).then(() => {
            this.colour = other(from);
            this.busy = null;
            this._save();
            this._say('Flashed ' + this.count + ' times in ' + Math.round((this.now() - t0) / 100) / 10 + ' s' +
                (this.colour ? ': the DRLs should be ' + this.colour + ' now' : ''));
            this.emit('flashed', this.colour);
            return true;
        }, (e) => {
            // hand every output back (whichever was on), end the session; the colour as it was
            const back = lit ? this.outputs.reduce((p, out) => p.then(() => this._ctl(out, false).catch(() => null)), Promise.resolve()) : Promise.resolve();
            return back.then(() => this._end()).then(() => {
                this.busy = null;
                this._say('Not flashed: ' + ((e && e.message) || e) + '. The colour may not have changed', true);
                return false;
            });
        });
    }

    /* the app is stopping: a flash in progress ends (outputs handed back) */
    stop() {
        this._stopping = true;
        if (this._autoTimer) { clearTimeout(this._autoTimer); this._autoTimer = null; }
        if (this.busy !== 'flash') return Promise.resolve();
        return new Promise((resolve) => {
            const done = () => { if (!this.busy) resolve(); else setTimeout(done, 20); };
            done();
        });
    }
}

module.exports = { Flasher, COUNT, ON_MS, OFF_MS, LEARN_MS, MAX_KMH, MAX_OUTPUTS };
