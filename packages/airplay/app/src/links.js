'use strict';
/*
 * AirPlay: the app's two local connections, both JSON lines over a unix socket, one reply per request ("id" echoed
 * back) plus events ("ev") at any time. JsonLink is Remote Play's.
 *
 *   video  /run/ida-remoteplay-video/ctl.sock     the video tool (packages/remoteplay/tool, root): the head unit's
 *          hardware decoder and display
 *     -> {"op":"probe"}                                  <- {"ok":true,"gst":"1.x","decoders":{"h264":".."},"sink":"waylandsink",..}
 *     -> {"op":"view","aspect":"fit"|"stretch"|"16:9"|..}  the playing stream in a new shape (from its last keyframe)
 *     -> {"op":"stop"}
 *     <- {"ev":"video","what":"stream","state":"playing"|"view"|"stopped"|"failed","fps":59.9,"rect":{..},"exact":true}
 *
 *   engine /run/ida-airplay-engine/engine.sock     the AirPlay receiver (packages/airplay/engine, root: UxPlay's library).
 *          It writes the phone's screen into the video tool's stream socket.
 *     -> {"op":"hello"}                                  <- {"ok":true,"name","version","deviceId"}
 *     -> {"op":"start","name":"iDrive","access":"pin"|"open","video":{"socket":STREAM_SOCKET,"rect":{x,y,w,h},"aspect":"fit"}}
 *     -> {"op":"view","video":{"aspect":"4:3"}}          (for the next stream)
 *     -> {"op":"stop"}  {"op":"status"}  {"op":"forget"}
 *     <- {"ev":"client","name","model","deviceId"}  {"ev":"pin","pin":"1234"}  {"ev":"conn","open":1}
 *     <- {"ev":"mirror","state":"started"|"paused"|"resumed"|"stopped","width","height","codec","reason"}
 *     <- {"ev":"net","how":"..."}                         where the phone finds the car
 *     (no GStreamer: "video":{"mode":"soft"}, and the pictures on FRAMES_SOCKET: frames.js)
 *
 *   wifi   /run/ida-airplay-wifi/ctl.sock           the Wi-Fi tool (packages/airplay/wifi, root)
 *     -> {"op":"status"}  {"op":"scan","iface"}  {"op":"connect","iface","ssid","psk"}  {"op":"disconnect","iface"}
 */
const net = require('net');
const fs = require('fs');
const EventEmitter = require('events');

const VIDEO_SOCKET = '/run/ida-remoteplay-video/ctl.sock';
const ENGINE_SOCKET = '/run/ida-airplay-engine/engine.sock';
const STREAM_SOCKET = '/run/ida-remoteplay-video/stream.sock';
const FRAMES_SOCKET = '/run/ida-airplay-engine/frames.sock';
const WIFI_SOCKET = '/run/ida-airplay-wifi/ctl.sock';

function isSocket(p) { try { return fs.statSync(p).isSocket(); } catch (e) { return false; } }

class JsonLink extends EventEmitter {
    constructor(name, socketPath, log, o) {
        super();
        this.name = name;
        this.path = socketPath;
        this.log = log;
        this.retryMs = (o && o.retryMs) || 5000;
        this.timeoutMs = (o && o.timeoutMs) || 15000;
        this.sock = null;
        this.ready = false;
        this.closed = false;
        this.buf = '';
        this.next = 1;
        this.pending = {};
        this.retry = null;
        this.missingLogged = false;
    }

    available() { return isSocket(this.path); }

    connect() {
        if (this.closed || this.sock) return this;
        if (!this.available()) {
            if (!this.missingLogged) { this.missingLogged = true; this.log.info(this.name + ': not installed (' + this.path + ')'); }
            this._again();
            return this;
        }
        const s = net.createConnection(this.path);
        this.sock = s;
        s.setEncoding('utf8');
        s.on('connect', () => { this.ready = true; this.missingLogged = false; this.log.info(this.name + ': connected'); this.emit('ready'); });
        s.on('data', (d) => this._data(d));
        s.on('error', (e) => { if (this.ready) this.log.warn(this.name + ': ' + e.message); });
        s.on('close', () => {
            const was = this.ready;
            this.sock = null; this.ready = false; this.buf = '';
            Object.keys(this.pending).forEach((id) => { const p = this.pending[id]; clearTimeout(p.t); p.reject(new Error(this.name + ' went away')); });
            this.pending = {};
            if (was) { this.log.info(this.name + ': connection closed'); this.emit('lost'); }
            this._again();
        });
        return this;
    }

    _again() {
        if (this.closed || this.retry) return;
        this.retry = setTimeout(() => { this.retry = null; this.connect(); }, this.retryMs);
    }

    close() { this.closed = true; clearTimeout(this.retry); if (this.sock) this.sock.destroy(); }

    _data(d) {
        this.buf += d;
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, i).trim();
            this.buf = this.buf.slice(i + 1);
            if (!line) continue;
            let m;
            try { m = JSON.parse(line); } catch (e) { this.log.warn(this.name + ': not JSON: ' + line.slice(0, 80)); continue; }
            if (m.id && this.pending[m.id]) {
                const p = this.pending[m.id];
                delete this.pending[m.id];
                clearTimeout(p.t);
                if (m.ok === false) p.reject(new Error(m.error || 'refused')); else p.resolve(m);
            } else if (m.ev) this.emit(m.ev, m);
        }
    }

    /* a request and its reply */
    ask(msg, timeoutMs) {
        if (!this.ready) return Promise.reject(new Error(this.name + ' is not connected'));
        const id = this.next++;
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => { delete this.pending[id]; reject(new Error(this.name + ': no answer')); }, timeoutMs || this.timeoutMs);
            this.pending[id] = { resolve: resolve, reject: reject, t: t };
            this.sock.write(JSON.stringify(Object.assign({ id: id }, msg)) + '\n');
        });
    }

    /* a message with no reply (input, many times a second) */
    tell(msg) { if (this.ready) this.sock.write(JSON.stringify(msg) + '\n'); }
}

module.exports = { JsonLink, VIDEO_SOCKET, ENGINE_SOCKET, STREAM_SOCKET, FRAMES_SOCKET, WIFI_SOCKET, isSocket };
