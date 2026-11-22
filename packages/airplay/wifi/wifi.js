'use strict';
/*
 * AirPlay Wi-Fi: a root tool that shows the AirPlay app what the head unit's Wi-Fi is doing, and connects it to a
 * network when you ask (an app can't: it runs as its own user, without the Wi-Fi's control sockets).
 *
 *   each Wi-Fi interface: an access point (the car's Wi-Fi, CarPlay's, the hotspot) with its name, channel and the
 *   devices on it (their address and name, from the ARP table and DHCP leases), or a station (the car on another
 *   network) with that network, its signal and address; and every other interface's addresses
 *
 * It talks to the head unit's own wpa_supplicant and hostapd through their control sockets (found under /run, /tmp,
 * ...), with ida-wpactl (shipped, static) when there's no wpa_cli; `iw` and sysfs fill in what they can't say.
 *
 * Control socket /run/ida-airplay-wifi/ctl.sock (0666), JSON lines, one reply per request ("id" echoed):
 *   {"op":"status"}                          -> {"ok":true,"ifaces":[..],"others":[..],"tools":{..}}
 *   {"op":"scan","iface":"wlan0"}            -> {"ok":true,"networks":[{"ssid","bssid","signal","freq","secure"}]}
 *   {"op":"connect","iface","ssid","psk"}    -> {"ok":true,"state":"COMPLETED","ip":"192.168.1.20"}
 *   {"op":"disconnect","iface"}              -> {"ok":true}
 *
 * Node 8 compatible (the head unit's /usr/bin/node).
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const VERSION = '1.0.0';
const RUN = process.env.APW_RUN || '/run/ida-airplay-wifi';
const CTL = path.join(RUN, 'ctl.sock');
const SYS = process.env.APW_SYS || '/sys/class/net';
const PROC = process.env.APW_PROC || '/proc';
const ARCH = { x64: 'x86_64', arm64: 'aarch64' }[process.arch] || process.arch;
const WPACTL = process.env.APW_WPACTL || path.join(__dirname, 'bin', ARCH, 'ida-wpactl');
const SOCKET_DIRS = (process.env.APW_SOCKET_DIRS || '/var/run/wpa_supplicant:/run/wpa_supplicant:/var/run/hostapd:/run/hostapd:/tmp/wpa_supplicant:/tmp/hostapd:/var/run:/run:/tmp:/data/misc/wifi').split(':');
const ADDR_MS = +process.env.APW_ADDR_MS || 6000;   // an address from the system's DHCP within this, else ours
const LEASES = ['/var/lib/misc/dnsmasq.leases', '/var/run/dnsmasq.leases', '/run/dnsmasq.leases', '/tmp/dnsmasq.leases', '/var/lib/dhcp/dhcpd.leases', '/var/run/udhcpd.leases', '/tmp/udhcpd.leases'];

function log(level, text) { process.stdout.write('[' + level + '] ' + text + '\n'); }
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function which(name) {
    const dirs = (process.env.PATH || '').split(':').concat(['/usr/bin', '/usr/sbin', '/bin', '/sbin', '/usr/local/bin', '/usr/local/sbin']);
    for (let i = 0; i < dirs.length; i++) { const p = path.join(dirs[i], name); try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { /* next */ } }
    return null;
}
function run(cmd, argv, ms) {
    return new Promise((resolve) => {
        if (!cmd) { resolve({ ok: false, out: '' }); return; }
        execFile(cmd, argv, { timeout: ms || 10000, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => resolve({ ok: !err, out: String(out || ''), err: String(errOut || '') + (err ? ' ' + err.message : '') }));
    });
}

/* ---- parsing (pure, tested) ---- */

/* "key=value" lines -> {} (wpa STATUS, hostapd STATUS) */
function kv(text) {
    const o = {};
    String(text || '').split('\n').forEach((l) => { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
    return o;
}

/* wpa SCAN_RESULTS: a header, then bssid<TAB>freq<TAB>signal<TAB>flags<TAB>ssid; strongest first, one per name */
function parseScan(text) {
    const best = {};
    String(text || '').split('\n').slice(1).forEach((l) => {
        const f = l.split('\t');
        if (f.length < 5 || !/^[0-9a-f:]{17}$/i.test(f[0])) return;
        const n = { ssid: unescapeSsid(f.slice(4).join('\t')), bssid: f[0], freq: +f[1], signal: +f[2], secure: /WPA|WEP|RSN|SAE/.test(f[3]), flags: f[3] };
        if (!n.ssid) return;
        if (!best[n.ssid] || best[n.ssid].signal < n.signal) best[n.ssid] = n;
    });
    return Object.keys(best).map((k) => best[k]).sort((a, b) => b.signal - a.signal);
}
/* `iw dev X scan`: BSS blocks */
function parseIwScan(text) {
    const out = [];
    let cur = null;
    String(text || '').split('\n').forEach((l) => {
        const b = /^BSS ([0-9a-f:]{17})/i.exec(l);
        if (b) { cur = { ssid: '', bssid: b[1], freq: 0, signal: 0, secure: false }; out.push(cur); return; }
        if (!cur) return;
        let m;
        if ((m = /^\s+freq: (\d+)/.exec(l))) cur.freq = +m[1];
        else if ((m = /^\s+signal: (-?[\d.]+)/.exec(l))) cur.signal = Math.round(+m[1]);
        else if ((m = /^\s+SSID: (.*)$/.exec(l))) cur.ssid = unescapeSsid(m[1]);
        else if (/^\s+(RSN|WPA):/.test(l) || /capability:.*Privacy/.test(l)) cur.secure = true;
    });
    return parseScan('h\n' + out.map((n) => [n.bssid, n.freq, n.signal, n.secure ? '[WPA2]' : '', n.ssid].join('\t')).join('\n'));
}
/* wpa/iw write every byte that isn't printable ASCII as \xNN: the bytes back, read as UTF-8 ("Caf\xc3\xa9" -> Café) */
function unescapeSsid(s) {
    const t = String(s);
    if (!/\\x[0-9a-f]{2}/i.test(t)) return t;
    return Buffer.from(t.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
}

/* hostapd ALL_STA: each station's MAC on a line of its own, then key=value lines */
function parseAllSta(text) {
    const out = [];
    String(text || '').split('\n').forEach((l) => {
        if (/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(l.trim())) out.push({ mac: l.trim().toLowerCase() });
        else if (out.length) {
            const m = /^signal=(-?\d+)/.exec(l.trim());
            if (m) out[out.length - 1].signal = +m[1];
        }
    });
    return out;
}
/* `iw dev X station dump` */
function parseStationDump(text) {
    const out = [];
    String(text || '').split('\n').forEach((l) => {
        const s = /^Station ([0-9a-f:]{17})/i.exec(l);
        if (s) { out.push({ mac: s[1].toLowerCase() }); return; }
        const g = /^\s+signal:\s+(-?\d+)/.exec(l);
        if (g && out.length) out[out.length - 1].signal = +g[1];
    });
    return out;
}
/* `iw dev X info`: type and ssid */
function parseIwInfo(text) {
    const t = /\btype (\S+)/.exec(text || ''), s = /\bssid (.*)$/m.exec(text || ''), c = /\bchannel (\d+) \((\d+) MHz\)/.exec(text || '');
    return { type: t ? t[1] : null, ssid: s ? unescapeSsid(s[1].trim()) : null, channel: c ? +c[1] : null, freq: c ? +c[2] : null };
}
/* /proc/net/arp -> [{ ip, mac, dev }] */
function parseArp(text) {
    return String(text || '').split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 6 && f[3] !== '00:00:00:00:00:00')
        .map((f) => ({ ip: f[0], mac: f[3].toLowerCase(), dev: f[5] }));
}
/* dnsmasq leases ("expiry mac ip name id") and udhcpd/dhcpd text: mac -> name */
function parseLeases(text) {
    const out = {};
    String(text || '').split('\n').forEach((l) => {
        const f = l.trim().split(/\s+/);
        if (f.length >= 4 && /^[0-9a-f:]{17}$/i.test(f[1]) && f[3] !== '*') out[f[1].toLowerCase()] = f[3];
    });
    return out;
}
/* /proc/net/wireless -> { iface: dBm } */
function parseWireless(text) {
    const out = {};
    String(text || '').split('\n').slice(2).forEach((l) => {
        const m = /^\s*([^:\s]+):\s+\S+\s+[\d.]+\s+(-?[\d.]+)/.exec(l);
        if (m) out[m[1]] = Math.round(+m[2]);
    });
    return out;
}

/* wpa_supplicant wants an SSID in hex (any byte), a passphrase in quotes */
function hex(s) { return Buffer.from(String(s), 'utf8').toString('hex'); }
function quoted(s) { return '"' + String(s) + '"'; }

/* ---- the tool ---- */
class Wifi {
    constructor() {
        this.tools = { iw: which('iw'), wpa_cli: which('wpa_cli'), hostapd_cli: which('hostapd_cli'), udhcpc: which('udhcpc'), dhclient: which('dhclient'), dhcpcd: which('dhcpcd'),
            wpactl: fs.existsSync(WPACTL) ? WPACTL : null };
        this.sockets = {};        // iface -> control socket path
        this.kinds = {};          // control socket -> 'wpa' | 'hostapd'
        this.busy = null;
    }

    /* the Wi-Fi interfaces: those with wireless or phy80211 in sysfs */
    wireless() {
        let list = [];
        try { list = fs.readdirSync(SYS); } catch (e) { return []; }
        return list.filter((n) => fs.existsSync(path.join(SYS, n, 'wireless')) || fs.existsSync(path.join(SYS, n, 'phy80211'))).sort();
    }

    /* control sockets named after an interface, in the usual folders (and one level below) */
    findSockets(ifaces) {
        const found = {};
        const look = (dir, depth) => {
            let names;
            try { names = fs.readdirSync(dir); } catch (e) { return; }
            names.forEach((n) => {
                const p = path.join(dir, n);
                let st;
                try { st = fs.lstatSync(p); } catch (e) { return; }
                if (st.isSocket() && ifaces.indexOf(n) >= 0 && !found[n]) found[n] = p;
                else if (st.isDirectory() && depth < 1 && /wpa|hostap|wifi|wlan/i.test(n)) look(p, depth + 1);
            });
        };
        SOCKET_DIRS.forEach((d) => look(d, 0));
        this.sockets = found;
        return found;
    }

    /* one control request, through wpa_cli / hostapd_cli or ida-wpactl */
    ctl(sock, cmd) {
        if (this.tools.wpactl) return run(this.tools.wpactl, [sock].concat(cmd), 15000).then((r) => (r.ok && !/^ERROR: /.test(r.out) ? r.out : null));
        const cli = this.kinds[sock] === 'hostapd' ? this.tools.hostapd_cli : this.tools.wpa_cli;
        if (!cli) return Promise.resolve(null);
        return run(cli, ['-p', path.dirname(sock), '-i', path.basename(sock)].concat(cmd), 15000).then((r) => (r.ok ? r.out : null));
    }

    addresses(name) {
        const all = os.networkInterfaces()[name] || [];
        return { v4: all.filter((a) => a.family === 'IPv4' || a.family === 4).map((a) => a.address), v6: all.filter((a) => a.family === 'IPv6' || a.family === 6).map((a) => a.address) };
    }

    status() {
        const ifaces = this.wireless();
        this.findSockets(ifaces);
        const arp = parseArp(read(path.join(PROC, 'net/arp')));
        const names = LEASES.map(read).filter(Boolean).reduce((o, t) => Object.assign(o, parseLeases(t)), {});
        const quality = parseWireless(read(path.join(PROC, 'net/wireless')));
        return Promise.all(ifaces.map((name) => this._one(name, arp, names, quality))).then((list) => {
            const others = Object.keys(os.networkInterfaces()).filter((n) => ifaces.indexOf(n) < 0 && n !== 'lo')
                .map((n) => Object.assign({ name: n }, this.addresses(n))).filter((o) => o.v4.length || o.v6.length);
            return { version: VERSION, ifaces: list, others: others, tools: Object.keys(this.tools).filter((k) => this.tools[k]) };
        });
    }

    _one(name, arp, names, quality) {
        const sock = this.sockets[name] || null;
        const o = Object.assign({ name: name, mac: (read(path.join(SYS, name, 'address')) || '').trim(), up: (read(path.join(SYS, name, 'operstate')) || '').trim(),
            kind: 'unknown', ssid: null, freq: null, channel: null, signal: quality[name] !== undefined ? quality[name] : null, state: null, clients: [], control: sock }, this.addresses(name));
        const iw = this.tools.iw ? run(this.tools.iw, ['dev', name, 'info'], 5000).then((r) => parseIwInfo(r.out)) : Promise.resolve({});
        const ctl = sock ? this.ctl(sock, ['STATUS']).then(kv) : Promise.resolve({});
        return Promise.all([iw, ctl]).then((r) => {
            const info = r[0], st = r[1];
            if (st.wpa_state) { this.kinds[sock] = 'wpa'; o.kind = st.mode === 'AP' ? 'ap' : 'station'; o.state = st.wpa_state; o.ssid = st.ssid || null; o.freq = +st.freq || null; }
            else if (st.state && (st['ssid[0]'] || st.bss || st.num_sta_non_erp !== undefined)) { this.kinds[sock] = 'hostapd'; o.kind = 'ap'; o.state = st.state; o.ssid = st['ssid[0]'] || null; o.freq = +st.freq || null; o.channel = +st.channel || null; }
            if (info.type === 'AP') o.kind = 'ap';
            else if (info.type === 'managed' && o.kind === 'unknown') o.kind = 'station';
            o.ssid = o.ssid || info.ssid || null; o.freq = o.freq || info.freq || null; o.channel = o.channel || info.channel || null;
            if (o.kind !== 'ap') return o;
            // who's on it: hostapd's list, else iw's, else the ARP table for this interface
            const sta = sock && this.kinds[sock] === 'hostapd' ? this.ctl(sock, ['ALL_STA']).then(parseAllSta)
                : this.tools.iw ? run(this.tools.iw, ['dev', name, 'station', 'dump'], 5000).then((x) => parseStationDump(x.out)) : Promise.resolve([]);
            return sta.then((list) => {
                const seen = {};
                list.forEach((c) => { seen[c.mac] = c; });
                arp.filter((a) => a.dev === name).forEach((a) => { seen[a.mac] = Object.assign(seen[a.mac] || { mac: a.mac }, { ip: a.ip }); });
                o.clients = Object.keys(seen).map((mac) => Object.assign(seen[mac], { name: names[mac] || null }));
                return o;
            });
        });
    }

    scan(name) {
        const sock = this.sockets[name] || this.findSockets(this.wireless())[name];
        if (sock && this.kinds[sock] !== 'hostapd') {
            return this.ctl(sock, ['SCAN']).then(() => new Promise((r) => setTimeout(r, 4500)))
                .then(() => this.ctl(sock, ['SCAN_RESULTS'])).then((t) => {
                    if (t === null) throw new Error('the Wi-Fi did not answer the scan');
                    return { networks: parseScan(t) };
                });
        }
        if (this.tools.iw) return run(this.tools.iw, ['dev', name, 'scan'], 20000).then((r) => {
            if (!r.ok) throw new Error('scan: ' + (r.err.trim().split('\n').pop() || 'refused') + (sock ? ' (it is the car\'s access point)' : ''));
            return { networks: parseIwScan(r.out) };
        });
        throw new Error(name + ' has no Wi-Fi control here (no wpa_supplicant socket, no iw)');
    }

    /* the car on another network: a new network in wpa_supplicant, selected, then an address (the system's DHCP, or
     * udhcpc / dhclient / dhcpcd when none comes) */
    connect(name, ssid, psk) {
        const sock = this.sockets[name] || this.findSockets(this.wireless())[name];
        if (!sock || this.kinds[sock] === 'hostapd') return Promise.reject(new Error(name + ' is not a Wi-Fi client here (no wpa_supplicant for it)'));
        if (!ssid) return Promise.reject(new Error('no network name'));
        if (psk && (psk.length < 8 || psk.length > 63)) return Promise.reject(new Error('a Wi-Fi password has 8 to 63 characters'));
        let id;
        const c = (cmd) => this.ctl(sock, cmd).then((t) => { if (t === null || /^FAIL/.test(t)) throw new Error(cmd[0] + ' refused'); return t.trim(); });
        log('info', 'connecting ' + name + ' to "' + ssid + '"');
        return c(['ADD_NETWORK']).then((t) => { id = t; })
            .then(() => c(['SET_NETWORK', id, 'ssid', hex(ssid)]))
            .then(() => (psk ? c(['SET_NETWORK', id, 'psk', quoted(psk)]) : c(['SET_NETWORK', id, 'key_mgmt', 'NONE'])))
            .then(() => c(['SELECT_NETWORK', id]))
            .then(() => this._wait(sock, 25000))
            .then((st) => {
                if (st.wpa_state !== 'COMPLETED') throw new Error('not connected (' + (st.wpa_state || 'no answer') + '): check the password');
                return this._address(name).then((ip) => ({ state: st.wpa_state, ssid: st.ssid, ip: ip }));
            })
            .catch((e) => (id === undefined ? Promise.reject(e) : this.ctl(sock, ['REMOVE_NETWORK', id]).then(() => { throw e; }, () => { throw e; })));
    }

    _wait(sock, ms) {
        const t0 = Date.now();
        const go = () => this.ctl(sock, ['STATUS']).then(kv).then((st) => (st.wpa_state === 'COMPLETED' || Date.now() - t0 > ms ? st : new Promise((r) => setTimeout(r, 1000)).then(go)));
        return go();
    }

    _address(name) {
        const has = () => this.addresses(name).v4[0] || null;
        const t0 = Date.now();
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const poll = (until) => (has() || Date.now() - t0 > until ? Promise.resolve(has()) : wait(1000).then(() => poll(until)));
        return poll(ADDR_MS).then((ip) => {
            if (ip) return ip;
            const t = this.tools;
            const dhcp = t.udhcpc ? [t.udhcpc, ['-i', name, '-n', '-q', '-t', '5']] : t.dhclient ? [t.dhclient, ['-1', name]] : t.dhcpcd ? [t.dhcpcd, ['-1', name]] : null;
            if (!dhcp) return null;
            log('info', name + ': no address yet, asking with ' + path.basename(dhcp[0]));
            return run(dhcp[0], dhcp[1], 30000).then(() => poll(Date.now() - t0 + 3000));
        });
    }

    disconnect(name) {
        const sock = this.sockets[name] || this.findSockets(this.wireless())[name];
        if (!sock || this.kinds[sock] === 'hostapd') return Promise.reject(new Error(name + ' is not a Wi-Fi client here'));
        return this.ctl(sock, ['DISCONNECT']).then(() => ({}));
    }

    handle(m) {
        if (m.op === 'status') return this.status();
        if (m.op === 'scan') return this.scan(String(m.iface || ''));
        if (m.op === 'connect' || m.op === 'disconnect') {
            if (this.busy) return Promise.reject(new Error('busy: ' + this.busy));
            this.busy = m.op + ' ' + m.iface;
            const p = m.op === 'connect' ? this.connect(String(m.iface || ''), m.ssid ? String(m.ssid) : '', m.psk ? String(m.psk) : '') : this.disconnect(String(m.iface || ''));
            return p.then((r) => { this.busy = null; return r; }, (e) => { this.busy = null; throw e; });
        }
        return Promise.reject(new Error('unknown op ' + m.op));
    }

    start() {
        try { fs.mkdirSync(RUN); } catch (e) { /* there */ }
        try { fs.unlinkSync(CTL); } catch (e) { /* none */ }
        net.createServer((s) => {
            s.setEncoding('utf8');
            let buf = '';
            s.on('data', (d) => {
                buf += d;
                let i;
                while ((i = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, i).trim();
                    buf = buf.slice(i + 1);
                    if (!line) continue;
                    let m;
                    try { m = JSON.parse(line); } catch (e) { continue; }
                    Promise.resolve().then(() => this.handle(m)).then((r) => send(Object.assign({ id: m.id, ok: true }, r)), (e) => send({ id: m.id, ok: false, error: e.message }));
                }
            });
            const send = (o) => { if (!s.destroyed) s.write(JSON.stringify(o) + '\n'); };
            s.on('error', () => { /* gone */ });
        }).listen(CTL, () => { fs.chmodSync(CTL, 0o666); log('info', 'control on ' + CTL); });
        this.status().then((st) => log('info', 'Wi-Fi: ' + JSON.stringify(st)));
    }
}

if (require.main === module) {
    log('info', 'AirPlay Wi-Fi ' + VERSION + ' starting');
    new Wifi().start();
}

module.exports = { Wifi, kv, parseScan, parseIwScan, parseAllSta, parseStationDump, parseIwInfo, parseArp, parseLeases, parseWireless, hex, quoted, unescapeSsid };
