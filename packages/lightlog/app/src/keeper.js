'use strict';
/*
 * Light Logger: keeps the seat logos on, through the one body controller lamp output the driver pinned as them.
 * Off until the driver switches it on. Tested on a desktop by tools/test_lightlog.js (against a fake body controller).
 *
 * How (the way the MIT-licensed idrive7-apps kit drives the BDC's lamp outputs, apps/ambient_config/strobe.js):
 *   10 03                     the body controller's extended diagnostic session
 *   2F <ctl> 03 <el> 01       hold the output on (shortTermAdjustment)
 *   3E 00 every KEEPALIVE_MS  keeps the session; without it the BDC drops it after a few seconds and takes the
 *                             output back by itself, so a stopped or crashed app leaves nothing switched on
 *   2F <ctl> 00 <el> 00       hand the output back (returnControlToECU), then 10 01
 * <ctl> is E3B5 when the lamp outputs were read with E3B9 (BDC_G05), 4501 with 4500 (older BDC). The element is
 * the output number minus one (the app numbers outputs from 1, the BDC from 0): output 45 is element 44 (0x2C).
 * uds.js lets through these requests and nothing else, and only for that element.
 *
 * When:
 *   test()       on for TEST_MS whatever the car does, then back: does the BDC take it at all?
 *   enabled      held while the car is on: from the engine's first start until the engine has been off for
 *                OFF_GRACE_MS (auto start-stop stops it for a while at lights). Released at once when switched
 *                off, when the app stops, or after MAX_FAILS refusals in a row.
 * While held, each lamp output read (observe()) checks the output: off twice in a row, or a refused tester
 * present, and it is asserted again (session, then 2F), at most every REASSERT_MS.
 *
 *   const k = new Keeper({ uds, log, now });
 *   k.target({ output: 45, statusDid: [0xE3, 0xB9] })   k.setEnabled(true)   k.test()
 *   k.update({ engine })     each round        k.observe(value)   the output's byte from each lamp read
 *   k.release(why)           k.state -> { mode, holding, enabled, output, note, fails }      k.on('change'), k.on('note', text)
 */
const EventEmitter = require('events');

const BDC = 0x40;
const KEEPALIVE_MS = 2000;
const TEST_MS = 10000;
const OFF_GRACE_MS = 120000;
const REASSERT_MS = 10000;
const MAX_FAILS = 5;
const CONTROL = { 'E3B9': [0xe3, 0xb5], '4500': [0x45, 0x01] };
const NRC = {
    0x10: 'general reject', 0x11: 'service not supported', 0x12: 'sub-function not supported', 0x13: 'bad length',
    0x21: 'busy', 0x22: 'conditions not correct', 0x31: 'out of range', 0x33: 'security access denied',
    0x7e: 'not supported in this session', 0x7f: 'not supported in this session',
};
const hex = (b) => (b || []).map((x) => (x < 16 ? '0' : '') + x.toString(16).toUpperCase()).join(' ');
const why = (r) => (!r ? 'no answer' : r[0] === 0x7f ? 'refused: ' + (NRC[r[2]] || 'NRC 0x' + hex([r[2]])) : 'answer ' + hex(r.slice(0, 4)));

class Keeper extends EventEmitter {
    constructor(o) {
        super();
        this.uds = o.uds; this.log = o.log; this.now = o.now || Date.now;
        this.keepaliveMs = o.keepaliveMs || KEEPALIVE_MS;
        this.testMs = o.testMs || TEST_MS;
        this.graceMs = o.graceMs === undefined ? OFF_GRACE_MS : o.graceMs;
        this.output = null; this.element = null; this.ctl = null;
        this.enabled = false;
        this.mode = 'off';                  // off | test | keep
        this.holding = false;               // the BDC took the 2F and we keep its session
        this.fails = 0;
        this.note = 'Off';
        this._offSince = null; this._engineSeen = false;
        this._offReads = 0; this._lastAssert = 0;
        this._timer = null; this._testTimer = null; this._busy = null;
    }

    get state() {
        return { mode: this.mode, holding: this.holding, enabled: this.enabled, output: this.output, note: this.note, fails: this.fails,
            ready: this.element !== null && !!this.ctl };
    }

    _say(text, warn) {
        this.note = text;
        (warn ? this.log.warn : this.log.info).call(this.log, 'keeper: ' + text);
        this.emit('note', text);
        this.emit('change');
    }

    /* which output: the pinned lamp output's number, and the identifier its status came from */
    target(t) {
        const out = t && Number.isInteger(t.output) && t.output >= 1 && t.output <= 256 ? t.output : null;
        const key = t && t.statusDid ? hex(t.statusDid).replace(' ', '') : null;
        const ctl = key ? CONTROL[key] || null : null;
        if (out === this.output && ctl === this.ctl) return;
        if (this.holding || this.mode !== 'off') this.release('the pinned output changed');
        this.output = out; this.element = out === null ? null : out - 1; this.ctl = ctl;
        this.uds.allowControl(this.element);
        this.emit('change');
    }

    setEnabled(on) {
        this.enabled = !!on;
        this.fails = 0;
        if (!this.enabled) { if (this.mode === 'keep') this.release('switched off'); else this._say('Off'); }
        else this._say('On: holds lamp output ' + this.output + ' on while the car is on');
        this.emit('change');
    }

    /* each round: start or end the hold */
    update(car) {
        const t = this.now();
        if (car && car.engine === true) { this._engineSeen = true; this._offSince = null; }
        else if (car && car.engine === false && this._offSince === null) this._offSince = t;
        if (!this.enabled || this.mode === 'test' || !this.state.ready) return;
        const carOn = this._engineSeen && (this._offSince === null || t - this._offSince < this.graceMs);
        if (carOn && this.mode === 'off' && this.fails < MAX_FAILS) this._hold('keep');
        else if (!carOn && this.mode === 'keep') { this._engineSeen = false; this.release('the car is off'); }
    }

    /* the output's byte from the latest lamp output read */
    observe(value) {
        if (!this.holding || typeof value !== 'number') return;
        if (value > 0) { this._offReads = 0; return; }
        this._offReads++;
        if (this._offReads >= 2 && this.now() - this._lastAssert >= REASSERT_MS) {
            this._offReads = 0;
            this._say('lamp output ' + this.output + ' read OFF while held: asking again', true);
            this._assert();
        }
    }

    test() {
        if (!this.state.ready) { this._say('Pin the logos\' lamp output first (and let the app read the lamp outputs once)', true); return Promise.resolve(false); }
        if (this.mode !== 'off') { this._say('Already ' + (this.mode === 'test' ? 'testing' : 'holding')); return Promise.resolve(false); }
        return this._hold('test').then((ok) => {
            if (ok) this._testTimer = setTimeout(() => this.release('test over'), this.testMs);
            return ok;
        });
    }

    _hold(mode) {
        if (this._busy) return this._busy;
        this.mode = mode;
        this._say((mode === 'test' ? 'Test: ' : '') + 'asking the body controller to hold lamp output ' + this.output + ' on');
        this._busy = this._assert().then((ok) => {
            this._busy = null;
            if (!ok) {
                this.mode = 'off'; this.holding = false; this._stopKeepalive();
                if (this.fails >= MAX_FAILS) { this._say('Gave up after ' + this.fails + ' refusals in a row; switch it off and on to try again', true); }
                this.uds.control(BDC, 0x10, [0x01]).catch(() => null);
                return false;
            }
            this._startKeepalive();
            return true;
        });
        return this._busy;
    }

    /* session, then the 2F; resolves true when the BDC took it */
    _assert() {
        this._lastAssert = this.now();
        return this.uds.control(BDC, 0x10, [0x03]).then((r) => {
            if (!r || r[0] !== 0x50) throw new Error('session ' + why(r));
            return this.uds.control(BDC, 0x2f, this.ctl.concat([0x03, this.element, 0x01]));
        }).then((r) => {
            if (!r || r[0] !== 0x6f) throw new Error('hold ' + why(r));
            this.holding = true; this.fails = 0;
            this._say((this.mode === 'test' ? 'Test: ' : '') + 'holding lamp output ' + this.output + ' on (the body controller took it)');
            return true;
        }).catch((e) => {
            this.fails++;
            this._say('The body controller didn\'t take it: ' + ((e && e.message) || e) + ' (' + this.fails + ' in a row)', true);
            return false;
        });
    }

    _startKeepalive() {
        this._stopKeepalive();
        this._timer = setInterval(() => {
            if (!this.holding) return;
            this.uds.control(BDC, 0x3e, [0x00]).then((r) => {
                if (r && r[0] === 0x7e) return;
                // the session is gone (or the BDC refuses it): the output is the car's again; ask again
                if (this.now() - this._lastAssert >= REASSERT_MS) {
                    this._say('the session was lost (' + why(r) + '): asking again', true);
                    this._assert().then((ok) => { if (!ok && this.fails >= MAX_FAILS) this.release('too many refusals'); });
                }
            }, () => null);
        }, this.keepaliveMs);
    }

    _stopKeepalive() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

    /* hands the output back to the car and leaves the session; safe to call any time */
    release(reason) {
        clearTimeout(this._testTimer); this._testTimer = null;
        this._stopKeepalive();
        const was = this.holding || this.mode !== 'off';
        this.holding = false; this.mode = 'off';
        if (!was || this.element === null || !this.ctl) { this.emit('change'); return Promise.resolve(); }
        this._say('handing lamp output ' + this.output + ' back to the car (' + reason + ')');
        return this.uds.control(BDC, 0x2f, this.ctl.concat([0x00, this.element, 0x00])).catch(() => null)
            .then((r) => { if (!r || r[0] !== 0x6f) this.log.warn('keeper: hand back: ' + why(r) + ' (the session ends anyway)'); })
            .then(() => this.uds.control(BDC, 0x10, [0x01]).catch(() => null))
            .then(() => { this._say(this.enabled ? 'On: waiting for the car (' + reason + ')' : 'Off (' + reason + ')'); });
    }
}

module.exports = { Keeper, CONTROL, KEEPALIVE_MS, TEST_MS, OFF_GRACE_MS, MAX_FAILS };
