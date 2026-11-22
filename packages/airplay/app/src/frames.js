'use strict';
/*
 * AirPlay: the phone's picture decoded by the engine (head units without GStreamer: soft_video.c), on
 * /run/ida-airplay-engine/frames.sock. want() asks for one picture (a byte, 'r'); each arrives as "APF1", width,
 * height, byte count (u32, little endian), then RGBA rows, and is handed on as 'frame' (w, h, rgba).
 *
 *   const f = new Frames(path, log); f.on('frame', (w, h, rgba) => ..); f.connect(); f.want();
 */
const net = require('net');
const fs = require('fs');
const EventEmitter = require('events');

const MAGIC = 0x31465041;
const MAX_BYTES = 1024 * 1024 * 4 + 16;

class Frames extends EventEmitter {
    constructor(socketPath, log, o) {
        super();
        this.path = socketPath;
        this.log = log;
        this.retryMs = (o && o.retryMs) || 3000;
        this.sock = null;
        this.ready = false;
        this.closed = false;
        this.chunks = [];
        this.have = 0;
        this.need = 16;
        this.head = null;
        this.count = 0;
        this.retry = null;
    }

    connect() {
        if (this.closed || this.sock) return this;
        let ok = false;
        try { ok = fs.statSync(this.path).isSocket(); } catch (e) { /* not there */ }
        if (!ok) { this._again(); return this; }
        const s = net.createConnection(this.path);
        this.sock = s;
        s.on('connect', () => { this.ready = true; this.emit('ready'); });
        s.on('data', (d) => this._data(d));
        s.on('error', () => { /* closes */ });
        s.on('close', () => {
            this.sock = null; this.ready = false; this.chunks = []; this.have = 0; this.need = 16; this.head = null;
            this._again();
        });
        return this;
    }
    _again() { if (!this.closed && !this.retry) this.retry = setTimeout(() => { this.retry = null; this.connect(); }, this.retryMs); }
    close() { this.closed = true; clearTimeout(this.retry); if (this.sock) this.sock.destroy(); }

    /* the next picture, please */
    want() { if (this.ready) this.sock.write('r'); }

    _data(d) {
        this.chunks.push(d);
        this.have += d.length;
        while (this.have >= this.need) {
            const b = Buffer.concat(this.chunks, this.have);
            if (!this.head) {
                if (b.readUInt32LE(0) !== MAGIC || b.readUInt32LE(12) > MAX_BYTES) { this.log.warn('frames: not a picture: dropped the connection'); this.sock.destroy(); return; }
                this.head = { w: b.readUInt32LE(4), h: b.readUInt32LE(8), n: b.readUInt32LE(12) };
                this.need = 16 + this.head.n;
                this.chunks = [b]; this.have = b.length;
                continue;
            }
            const h = this.head, rgba = b.slice(16, 16 + h.n);
            const rest = b.slice(16 + h.n);
            this.chunks = rest.length ? [rest] : []; this.have = rest.length;
            this.head = null; this.need = 16;
            this.count++;
            this.emit('frame', h.w, h.h, rgba);
        }
    }
}

module.exports = { Frames, MAGIC };
