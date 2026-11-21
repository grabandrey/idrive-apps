'use strict';
/*
 * Seat Lights: the app's log, for its Logs screen. Every line goes to the head unit's log (STLT) as before, to the
 * last MAX lines kept here (newest last), and to a text file (seatlights.log next to the settings, the old one kept
 * as .1 past MAX_BYTES), so a drive's log can be read on the screen or copied off afterwards.
 *
 *   const log = new LogRing(sdkLogger, '/path/seatlights.log');
 *   log.info(text) / log.warn(text) / log.error(text)        log.lines -> [{ t, level, text }]      log.on('line', fn)
 */
const EventEmitter = require('events');
const fs = require('fs');

const MAX = 300;
const MAX_BYTES = 512 * 1024;
const pad = (n) => (n < 10 ? '0' : '') + n;
function stamp(t) {
    const d = new Date(t);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

class LogRing extends EventEmitter {
    constructor(base, file, o) {
        super();
        this.base = base; this.file = file || null;
        this.max = (o && o.max) || MAX;
        this.maxBytes = (o && o.maxBytes) || MAX_BYTES;
        this.now = (o && o.now) || Date.now;
        this.lines = [];
    }

    _add(level, text) {
        text = String(text);
        const line = { t: this.now(), level: level, text: text };
        this.lines.push(line);
        if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
        if (this.base && this.base[level]) { try { this.base[level](text); } catch (e) { /* the SDK's log, not ours */ } }
        if (this.file) {
            try {
                let size = 0;
                try { size = fs.statSync(this.file).size; } catch (e) { /* new */ }
                if (size > this.maxBytes) fs.renameSync(this.file, this.file + '.1');
                fs.appendFileSync(this.file, stamp(line.t) + ' ' + level.toUpperCase() + ' ' + text + '\n');
            } catch (e) { this.file = null; }          // not writable: the screen and STLT still have it
        }
        this.emit('line', line);
    }

    info(text) { this._add('info', text); }
    warn(text) { this._add('warn', text); }
    error(text) { this._add('error', text); }

    clear() { this.lines = []; this.emit('line', null); }
}

module.exports = { LogRing, stamp };
