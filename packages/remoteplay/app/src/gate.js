'use strict';
/*
 * Remote Play: parked or not. The game and the video test start only with a speed of 0 read within the last 5 s, and
 * stop the moment the car goes faster than 3 km/h (or the speed stops coming).
 *
 *   const g = new Gate({ log }); g.speed(kmh); g.tick() (every second); g.parked -> true | false | null (no speed yet)
 *   g.on('change', (parked) => ..)
 */
const EventEmitter = require('events');

const STILL_KMH = 0.5;       // parked: at most this
const MOVING_KMH = 3;        // moving: more than this
const FRESH_MS = 5000;

class Gate extends EventEmitter {
    constructor(o) {
        super();
        this.log = (o && o.log) || { info() {} };
        this.now = (o && o.now) || Date.now;
        this.parked = null;
        this.kmh = null;
        this.at = 0;
    }

    speed(kmh) {
        this.kmh = kmh;
        this.at = this.now();
        if (kmh <= STILL_KMH) this._set(true);
        else if (kmh > MOVING_KMH) this._set(false);
        else if (this.parked === null) this._set(false);
    }

    /* no speed for a while: not known to be parked */
    tick() { if (this.parked !== null && this.now() - this.at > FRESH_MS) this._set(this.parked === true ? null : this.parked); }

    _set(p) {
        if (p === this.parked) return;
        const was = this.parked;
        this.parked = p;
        this.log.info('car: ' + (p === true ? 'parked' : p === false ? 'moving (' + (this.kmh || 0).toFixed(0) + ' km/h)' : 'speed not known'));
        if (was === true || p === true) this.emit('change', p === true);
    }
}

module.exports = { Gate, STILL_KMH, MOVING_KMH, FRESH_MS };
