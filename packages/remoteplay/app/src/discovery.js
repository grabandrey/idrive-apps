'use strict';
/*
 * Remote Play: find PlayStations on the car's network, and wake one from rest mode.
 *
 * Consoles answer a short text request on UDP (the PS5 on 9302, the PS4 on 987) with their name, type, id and whether
 * they are on (200) or resting (620). Waking needs the console's registration key from pairing (the engine's), sent
 * as a decimal "user-credential".
 *
 *   const d = new Discovery({ log });
 *   d.search({ timeoutMs: 2000, host: '192.168.1.20' }) -> Promise<[{ host, name, type, id, state, version, port, app }]>
 *   d.wake(console, registKeyHex)  -> Promise
 *
 * Node 8: no BigInt (hexToDecimal).
 */
const dgram = require('dgram');
const os = require('os');

const PORT = { PS5: 9302, PS4: 987 };
const PROTOCOL = { PS5: '00030010', PS4: '00020020' };

function searchPacket(kind) { return Buffer.from('SRCH * HTTP/1.1\ndevice-discovery-protocol-version:' + PROTOCOL[kind] + '\n'); }

function wakePacket(kind, credential) {
    return Buffer.from('WAKEUP * HTTP/1.1\nclient-type:vr\nauth-type:R\nmodel:w\napp-type:r\nuser-credential:' + credential +
        '\ndevice-discovery-protocol-version:' + PROTOCOL[kind] + '\n');
}

/* "HTTP/1.1 200 Ok\nhost-id:..\n.." -> { host, name, type, id, state, version, port, app } */
function parseReply(text, host) {
    const lines = String(text).split(/\r?\n/);
    const m = /^HTTP\/1\.\d\s+(\d+)/.exec(lines[0] || '');
    if (!m) return null;
    const h = {};
    lines.slice(1).forEach((l) => { const i = l.indexOf(':'); if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); });
    const code = Number(m[1]);
    const type = h['host-type'] || (h['device-discovery-protocol-version'] === PROTOCOL.PS5 ? 'PS5' : 'PS4');
    return {
        host: host, name: h['host-name'] || type, type: type, id: h['host-id'] || '',
        state: code === 200 ? 'ready' : code === 620 ? 'standby' : 'unknown',
        version: h['system-version'] || '', port: Number(h['host-request-port']) || 0,
        app: h['running-app-name'] || '',
    };
}

/* a hex string (up to 16 digits) -> its decimal digits */
function hexToDecimal(hex) {
    hex = String(hex || '').replace(/^0x/i, '');
    if (!/^[0-9a-f]{1,16}$/i.test(hex)) throw new Error('not a registration key: ' + hex);
    let dec = [0];
    hex.split('').forEach((c) => {
        let carry = parseInt(c, 16);
        for (let i = dec.length - 1; i >= 0; i--) { const v = dec[i] * 16 + carry; dec[i] = v % 10; carry = Math.floor(v / 10); }
        while (carry) { dec.unshift(carry % 10); carry = Math.floor(carry / 10); }
    });
    return dec.join('');
}

/* the broadcast addresses of the car's own networks, and the general one */
function broadcasts(ifaces) {
    ifaces = ifaces || os.networkInterfaces();
    const out = ['255.255.255.255'];
    Object.keys(ifaces).forEach((n) => (ifaces[n] || []).forEach((a) => {
        if ((a.family !== 'IPv4' && a.family !== 4) || a.internal || !a.netmask) return;
        const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
        const b = ip.map((x, i) => (x | (~mask[i] & 255)) & 255).join('.');
        if (out.indexOf(b) < 0) out.push(b);
    }));
    return out;
}

class Discovery {
    constructor(o) { this.log = (o && o.log) || { info() {}, warn() {} }; this.dgram = (o && o.dgram) || dgram; }

    search(o) {
        o = o || {};
        const timeoutMs = o.timeoutMs || 2000;
        const found = {};
        return new Promise((resolve) => {
            const sock = this.dgram.createSocket({ type: 'udp4', reuseAddr: true });
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                try { sock.close(); } catch (e) { /* closed */ }
                resolve(Object.keys(found).map((k) => found[k]));
            };
            sock.on('error', (e) => { this.log.warn('console search: ' + e.message); finish(); });
            sock.on('message', (msg, rinfo) => {
                const c = parseReply(msg.toString('utf8'), rinfo.address);
                if (c) found[c.host] = c;
            });
            sock.bind(0, () => {
                try { sock.setBroadcast(true); } catch (e) { /* unicast only */ }
                const targets = o.host ? [o.host] : broadcasts();
                const send = () => targets.forEach((t) => ['PS5', 'PS4'].forEach((k) => {
                    sock.send(searchPacket(k), PORT[k], t, (err) => { if (err && !done) this.log.warn('console search to ' + t + ': ' + err.message); });
                }));
                send();
                const again = setInterval(send, 500);
                setTimeout(() => { clearInterval(again); finish(); }, timeoutMs);
            });
        });
    }

    wake(c, registKeyHex) {
        const kind = c.type === 'PS4' ? 'PS4' : 'PS5';
        const packet = wakePacket(kind, hexToDecimal(registKeyHex));
        return new Promise((resolve, reject) => {
            const sock = this.dgram.createSocket('udp4');
            sock.on('error', (e) => { try { sock.close(); } catch (x) { /* closed */ } reject(e); });
            sock.bind(0, () => {
                try { sock.setBroadcast(true); } catch (e) { /* unicast */ }
                sock.send(packet, PORT[kind], c.host, (err) => {
                    try { sock.close(); } catch (e) { /* closed */ }
                    if (err) reject(err); else { this.log.info('wake sent to ' + c.name + ' (' + c.host + ')'); resolve(); }
                });
            });
        });
    }
}

module.exports = { Discovery, parseReply, hexToDecimal, searchPacket, wakePacket, broadcasts, PORT };
