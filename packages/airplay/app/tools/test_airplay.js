'use strict';
/* node packages/airplay/app/tools/test_airplay.js: the screens and their buttons, the picture's shapes, the links, the
 * package's car-side rules (Node 8, the manifest, the files shared with the other apps), and the engine (its component,
 * both programs, and the real x86_64 one answering the app, announcing itself and answering an iPhone's first request) */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const dgram = require('dgram');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, '..', 'engine');
const TOOL = path.join(ROOT, '..', '..', 'remoteplay', 'tool');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const log = { info: () => {}, warn: () => {}, error: () => {} };
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (f, ms, what) => { const t0 = Date.now(); const go = () => (f() ? Promise.resolve() : Date.now() - t0 > ms ? Promise.reject(new Error('no ' + what)) : wait(50).then(go)); return go(); };

/* ---- the screens ---- */
const ui = require('../src/ui.js');
const keys = (m) => ui.draw(new ui.Recorder(), Object.assign({ aspect: 'fit' }, m)).targets.map((t) => t.key);
test('screens: home, the PIN, mirror, logs', () => {
    const ready = { engine: { name: 'AirPlay Engine' }, receiver: { on: true, name: 'iDrive' }, enabled: true, parked: true, video: { tool: true } };
    const home = keys(Object.assign({ view: 'home' }, ready));
    ui.ASPECTS.forEach((a) => ok(home.indexOf('apA_' + a) >= 0, 'home: the shape ' + a));
    ['apToggle', 'apAccess', 'apForget', 'apLogs'].forEach((k) => ok(home.indexOf(k) >= 0, 'home: ' + k));
    ok(keys({ view: 'home' }).indexOf('apForget') < 0, 'no engine: nothing to forget');
    const pin = keys(Object.assign({ view: 'home', pin: '4817' }, ready));
    eq(pin, ['apPinDone'], 'the PIN takes the buttons\' place');
    const mir = ui.draw(new ui.Recorder(), { view: 'mirror', aspect: 'stretch', mirror: { state: 'playing' } });
    eq(mir.rec.u[0], ui.OP.CLEAR); eq(mir.rec.u[1], 0, 'Mirror clears to transparent: the phone shows through');
    eq(mir.targets.map((t) => t.key), ui.ASPECTS.map((a) => 'apA_' + a).concat(['apDisconnect']), 'Mirror: the shapes and Disconnect');
    mir.targets.forEach((t) => ok(t.x >= ui.BAND.x && t.x + t.w <= ui.BAND.x + ui.BAND.w && t.y >= 0 && t.y + t.h <= ui.H, t.key + ' is in the band'));
    ok(ui.VIDEO.x >= ui.BAND.x + ui.BAND.w && ui.VIDEO.x + ui.VIDEO.w === ui.W && ui.VIDEO.h === ui.H, 'the picture has the rest of the screen');
    ok(keys({ view: 'logs', logs: [{ t: 0, level: 'warn', text: 'x' }] }).indexOf('apClose') >= 0, 'logs');
    eq(ui.toScreen(ui.placement({ x: 0, y: 76, w: 2880, h: 764 }), ui.VIDEO), { x: 320, y: 76, w: 2560, h: 764 }, 'where the picture goes on an iDrive 8 screen');
});
test('shapes: the button goes through them all, the video tool knows each', () => {
    eq(ui.ASPECTS, ['fit', 'stretch', '16:9', '16:10', '4:3', '21:9', '1:1']);
    let a = 'fit';
    const seen = [];
    for (let i = 0; i < ui.ASPECTS.length; i++) { seen.push(a); a = ui.nextAspect(a); }
    eq(seen, ui.ASPECTS); eq(a, 'fit', 'and round again');
    eq(ui.aspectLabel('stretch'), 'Stretch');
    const video = require(path.join(TOOL, 'video.js'));
    eq(video.ASPECTS, ui.ASPECTS, 'the same shapes as the video tool');
    const area = ui.toScreen(ui.placement({ x: 0, y: 76, w: 2880, h: 764 }), ui.VIDEO);
    ui.ASPECTS.forEach((x) => {
        const v = video.viewFor(area, { width: 886, height: 1920 }, x);
        ok(v.rect.x >= area.x && v.rect.y >= area.y && v.rect.x + v.rect.w <= area.x + area.w && v.rect.y + v.rect.h <= area.y + area.h, x + ': inside the area');
    });
    eq(video.viewFor(area, { width: 886, height: 1920 }, 'stretch').rect, area, 'stretch: all of it');
});

/* ---- the links ---- */
const links = require('../src/links.js');
test('links: the sockets, a request and an event', () => {
    eq([links.VIDEO_SOCKET, links.ENGINE_SOCKET, links.STREAM_SOCKET], ['/run/ida-remoteplay-video/ctl.sock', '/run/ida-airplay-engine/engine.sock', '/run/ida-remoteplay-video/stream.sock']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-link-'));
    const sock = path.join(dir, 's.sock');
    const srv = net.createServer((s) => {
        s.on('data', (d) => {
            const m = JSON.parse(String(d).split('\n')[0]);
            s.write(JSON.stringify({ ev: 'pin', pin: '1234' }) + '\n' + JSON.stringify({ id: m.id, ok: m.op === 'hello', error: 'no' }) + '\n');
        });
    }).listen(sock);
    const l = new links.JsonLink('engine', sock, log, { retryMs: 50 });
    let pin = null;
    l.on('pin', (m) => { pin = m.pin; });
    return until(() => l.connect().ready, 3000, 'connection')
        .then(() => l.ask({ op: 'hello' }))
        .then(() => { eq(pin, '1234', 'events'); return l.ask({ op: 'nope' }).then(() => ok(false), (e) => eq(e.message, 'no', 'refusals')); })
        .then(() => { l.close(); srv.close(); });
});

/* ---- the package ---- */
test('package: modules, requires, Node 8, the manifest, the screen\'s rows, shared files', () => {
    const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-app.json'), 'utf8'));
    const builtins = ['events', 'fs', 'path', 'os', 'net', 'zlib', 'http', 'https', 'crypto', 'dgram', 'querystring'];
    const files = fs.readdirSync(path.join(ROOT, 'src')).map((f) => 'src/' + f);
    eq(files.slice().sort(), app.modules.slice().sort(), 'mgu-app.json lists every module');
    app.modules.forEach((m) => {
        const src = fs.readFileSync(path.join(ROOT, m), 'utf8');
        (src.match(/require\('([^']+)'\)/g) || []).map((r) => r.slice(9, -2)).forEach((r) => {
            ok(r[0] === '.' || app.sdk.indexOf(r) >= 0 || builtins.indexOf(r) >= 0, m + ': may require ' + r);
        });
        ok(!/\?\.|\?\?|Object\.fromEntries|\bBigInt\b|\d+n\b(?![a-z])/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''")), m + ': Node 8 syntax only');
    });
    ['someip_link.js', 'gpu.js', 'ui_font.js', 'log_ring.js'].forEach((f) => {
        ok(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8') === fs.readFileSync(path.join(ROOT, '..', '..', 'seatlights', 'app', 'src', f), 'utf8'), f + ' is the same as Seat Lights\' (copy it again)');
    });
    ok(fs.readFileSync(path.join(ROOT, 'src', 'gate.js'), 'utf8') === fs.readFileSync(path.join(ROOT, '..', '..', 'remoteplay', 'app', 'src', 'gate.js'), 'utf8'), 'gate.js is Remote Play\'s');
    const mine = fs.readFileSync(path.join(ROOT, 'src', 'links.js'), 'utf8'), theirs = fs.readFileSync(path.join(ROOT, '..', '..', 'remoteplay', 'app', 'src', 'links.js'), 'utf8');
    const cls = (s) => s.slice(s.indexOf('class JsonLink'), s.indexOf('module.exports'));
    ok(cls(mine) === cls(theirs), 'JsonLink is Remote Play\'s');
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'package', 'manifest.json'), 'utf8')).proxies;
    eq(man['de.bmw.infotainment.vehicle.Vehicle2'], { instances: ['1'], attributes: { statusCarSpeed2: 'rs' } }, 'the speed is declared');
    const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'package', 'package.json'), 'utf8'));
    eq([pj.name, pj.version, pj.oapAppSettings.loggingId], [app.id, app.version, 'ARPL']);
    const comps = JSON.parse(fs.readFileSync(path.join(ROOT, 'package/rhmiData/uiDescriptions/ID8/uiDescription.json'), 'utf8')).containers[1].components;
    const names = Object.keys(comps).map((k) => comps[k].name);
    ['apStatus', 'apToggle', 'apAspect', 'apAccess', 'apForget', 'apLogs', 'apOlder', 'apNewer', 'apLine0', 'apLine29'].forEach((x) => ok(names.indexOf(x) >= 0, 'row ' + x));
    const main = fs.readFileSync(path.join(ROOT, 'src', 'ida_airplay.js'), 'utf8');
    ok(main.indexOf("'ST_OnlineApps_AirPlay'") >= 0, 'the state name matches');
    ['apToggle', 'apAspect', 'apAccess', 'apForget', 'apLogs', 'apOlder', 'apNewer'].forEach((x) => ok(main.indexOf("'" + x + "'") >= 0, 'the app handles ' + x));
    const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package/rhmiData/application.json'), 'utf8')).application;
    const rp = JSON.parse(fs.readFileSync(path.join(ROOT, '..', '..', 'remoteplay', 'app', 'package/rhmiData/application.json'), 'utf8')).application;
    ok(appJson.entryPoints[0].uuid !== rp.entryPoints[0].uuid && appJson.uuid !== rp.uuid, 'its own uuids');
    const repo = JSON.parse(fs.readFileSync(path.join(ROOT, '..', '..', '..', 'mgu-repo.json'), 'utf8')).components.filter((c) => c.id === 'ida_airplay')[0];
    const tool = JSON.parse(fs.readFileSync(path.join(TOOL, 'component.json'), 'utf8'));
    ok(repo && repo.requires['ida-remoteplay-video'] === tool.version && repo.requires['ida-airplay-engine'], 'it needs the video tool with shapes, and the engine');
});

/* ---- the engine (packages/airplay/engine) ---- */
test('engine: the component, its programs, the licences', () => {
    const comp = JSON.parse(fs.readFileSync(path.join(ENGINE, 'component.json'), 'utf8'));
    eq(comp.id, 'ida-airplay-engine');
    comp.files.forEach((f) => ok(fs.existsSync(path.join(ENGINE, f.from)), 'engine file ' + f.from));
    comp.units.forEach((u) => ok(fs.existsSync(path.join(ENGINE, u.from)), 'engine unit ' + u.from));
    [['x86_64', 62], ['aarch64', 183]].forEach(([arch, machine]) => {
        const rel = 'bin/' + arch + '/ida-airplay-engine', b = fs.readFileSync(path.join(ENGINE, rel));
        ok(b.slice(0, 4).toString('latin1') === '\x7fELF' && b[4] === 2, rel + ' is a 64-bit ELF');
        eq(b.readUInt16LE(18), machine, rel + ' is for ' + arch);
        eq(comp.files.filter((f) => f.from === rel)[0].mode, '0755', rel + ' is executable');
    });
    ok(/GNU GENERAL PUBLIC LICENSE\s+Version 3/.test(fs.readFileSync(path.join(ENGINE, 'LICENSE'), 'utf8')), 'the GPL text');
    ['engine.c', 'mdns_ifaces.c', 'build.sh'].forEach((f) => ok(comp.files.some((x) => x.from === f), f + ' goes with it'));
    const start = fs.readFileSync(path.join(ENGINE, 'start.sh'), 'utf8');
    ok(/x86_64\|amd64\) ARCH=x86_64/.test(start) && /aarch64\|arm64\) ARCH=aarch64/.test(start), 'start.sh picks the processor');
});

/* an mDNS question for a service type, on the loopback-free way the phone asks: multicast, answered on the same network */
function mdnsAsk(type, iface) {
    const q = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0])].concat(type.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])))
        .concat([Buffer.from([0, 0, 12, 0, 1])]));
    return new Promise((resolve) => {
        const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        const got = [];
        s.on('message', (m) => { if (m.readUInt16BE(2) & 0x8000) got.push(m); });
        s.bind(5353, () => {
            try { s.addMembership('224.0.0.251', iface); s.setMulticastInterface(iface); } catch (e) { /* answered anyway, or not: the test says */ }
            s.send(q, 5353, '224.0.0.251');
            setTimeout(() => { s.close(); resolve(got); }, 1500);
        });
    });
}

test('engine: the real program answers the app, announces itself, answers a phone\'s first request (x86_64 here)', () => {
    if (process.arch !== 'x64' || process.platform !== 'linux') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-engine-'));
    // this machine's first IPv4 interface stands in for the car's hotspot (IDA_MDNS_IFACES: whatever its address)
    const all = os.networkInterfaces(), name = Object.keys(all).filter((k) => all[k].some((a) => (a.family === 'IPv4' || a.family === 4) && !a.internal))[0];
    const addr = name ? all[name].filter((a) => a.family === 'IPv4' || a.family === 4)[0].address : null;
    const proc = cp.spawn(path.join(ENGINE, 'bin/x86_64/ida-airplay-engine'), [path.join(dir, 'run'), path.join(dir, 'data')],
        { stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { IDA_MDNS_IFACES: name || 'none' }) });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    const sock = path.join(dir, 'run', 'engine.sock');
    const l = new links.JsonLink('AirPlay engine', sock, log, { retryMs: 50, timeoutMs: 10000 });
    let port = 0;
    return until(() => links.isSocket(sock), 5000, 'socket')
        .then(() => { l.connect(); return until(() => l.ready, 5000, 'connection'); })
        .then(() => l.ask({ op: 'hello' }))
        .then((h) => {
            ok(h.name === 'AirPlay Engine' && /^\d+\.\d+\.\d+$/.test(h.version), 'hello');
            ok(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(h.deviceId) && (parseInt(h.deviceId.slice(0, 2), 16) & 2), 'its id: a locally administered MAC');
            ok(fs.existsSync(path.join(dir, 'data', 'id')), 'kept');
            ok(h.soft === true && links.isSocket(path.join(dir, 'run', 'frames.sock')), 'no GStreamer: it decodes, and hands the pictures over on frames.sock');
            return l.ask({ op: 'start', name: 'iDrive.test@x', access: 'pin', video: { socket: path.join(dir, 'none.sock'), aspect: 'fit' } });
        })
        .then((r) => {
            eq(r.name, 'iDrive test x', 'a name the announcement can carry');
            port = r.port;
            ok(port > 0, 'listening');
            ok(fs.existsSync(path.join(dir, 'data', 'airplay.pem')), 'its pairing key, kept');
            return l.ask({ op: 'status' });
        })
        .then((s) => {
            eq([s.advertising, s.mirroring], [true, false]);
            // an iPhone's first request: GET /info, a binary plist with the screen it may send
            return new Promise((resolve, reject) => {
                const c = net.createConnection(port, '127.0.0.1', () => c.write('GET /info RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: AirPlay/690.7.1\r\n\r\n'));
                let buf = Buffer.alloc(0);
                c.on('data', (d) => { buf = Buffer.concat([buf, d]); const i = buf.indexOf('\r\n\r\n'); const len = /Content-Length: (\d+)/i.exec(buf.toString('latin1')); if (i > 0 && len && buf.length >= i + 4 + +len[1]) { c.destroy(); resolve(buf); } });
                c.on('error', reject);
                setTimeout(() => { c.destroy(); reject(new Error('no /info answer')); }, 5000);
            });
        })
        .then((res) => {
            const t = res.toString('latin1');
            ok(/^RTSP\/1\.0 200 OK/.test(t), '/info: 200');
            ok(t.indexOf('bplist00') > 0 && t.indexOf('iDrive test x') > 0 && t.indexOf('widthPixels') > 0, '/info: its name and screen, as a binary plist');
            if (!addr) return null;
            return mdnsAsk('_airplay._tcp.local', addr).then((answers) => {
                if (!answers.length) { console.log('(mDNS not checked: no multicast on this machine)'); return; }
                const all2 = Buffer.concat(answers).toString('latin1');
                ok(all2.indexOf('iDrive test x') >= 0 && all2.indexOf('_airplay') >= 0, 'mDNS: found as an AirPlay receiver on ' + name);
                ok(answers.some((a) => a.indexOf(Buffer.from(addr.split('.').map(Number))) > 0), 'mDNS: with the address of that network (' + addr + ')');
                ok(all2.indexOf('pw=true') >= 0 && /features=0x[0-9A-F]+,0x0/.test(all2), 'mDNS: a PIN is asked, the features');
            });
        })
        .then(() => l.ask({ op: 'view', video: { aspect: '4:3' } }))
        .then(() => l.ask({ op: 'forget' }))
        .then(() => l.ask({ op: 'stop' }))
        .then(() => l.ask({ op: 'status' }))
        .then((s) => { eq(s.advertising, false, 'stopped'); return l.ask({ op: 'nope' }).then(() => ok(false), (e) => eq(e.message, 'unknown op')); })
        .then(() => { l.close(); proc.kill(); }, (e) => { l.close(); proc.kill(); e.message += '\nengine log:\n' + out; throw e; });
});

/* a stand-in for the head unit's Bonjour daemon (Apple's mDNSResponder): reads a request the way its uds_daemon.c
 * does (the 28-byte header in network order, then flags, interface, name, type, domain, host, port, TXT) and answers
 * with a 4-byte error code on the same socket */
function fakeDaemon(sockPath, error) {
    const got = [];
    const srv = net.createServer((c) => {
        let buf = Buffer.alloc(0);
        c.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (buf.length < 28 || buf.length < 28 + buf.readUInt32BE(4)) return;
            const h = { version: buf.readUInt32BE(0), datalen: buf.readUInt32BE(4), flags: buf.readUInt32BE(8), op: buf.readUInt32BE(12) };
            let o = 28;
            const u32 = () => { const v = buf.readUInt32BE(o); o += 4; return v; };
            const str = () => { const e = buf.indexOf(0, o); const v = buf.slice(o, e).toString(); o = e + 1; return v; };
            const r = Object.assign(h, { svcFlags: u32(), iface: u32(), name: str(), type: str(), domain: str(), host: str() });
            r.port = buf.readUInt16BE(o); o += 2;
            const tl = buf.readUInt16BE(o); o += 2;
            r.txt = buf.slice(o, o + tl).toString('latin1'); o += tl;
            r.rest = buf.length - o;
            got.push(r);
            const e = Buffer.alloc(4); e.writeInt32BE(error || 0, 0); c.write(e);
            buf = Buffer.alloc(0);
            c.on('close', () => { r.closed = true; });
        });
    }).listen(sockPath);
    return { srv: srv, got: got };
}

test('engine: through the head unit\'s Bonjour when it has one (as wireless CarPlay does), its own otherwise', () => {
    if (process.arch !== 'x64' || process.platform !== 'linux') return;
    const run = (env, daemonError) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-bonjour-'));
        const d = fakeDaemon(path.join(dir, 'mdnsd'), daemonError);
        const proc = cp.spawn(path.join(ENGINE, 'bin/x86_64/ida-airplay-engine'), [path.join(dir, 'run'), path.join(dir, 'data')],
            { stdio: 'ignore', env: Object.assign({}, process.env, { IDA_MDNS_SOCKET: path.join(dir, 'mdnsd') }, env) });
        const sock = path.join(dir, 'run', 'engine.sock');
        const l = new links.JsonLink('AirPlay engine', sock, log, { retryMs: 50, timeoutMs: 10000 });
        const nets = [];
        l.on('net', (m) => nets.push(m.how));
        const done = (v) => { l.close(); proc.kill(); d.srv.close(); return v; };
        return until(() => links.isSocket(sock), 5000, 'socket')
            .then(() => { l.connect(); return until(() => l.ready, 5000, 'connection'); })
            .then(() => l.ask({ op: 'start', name: 'iDrive', access: 'pin', video: {} }))
            .then(() => wait(300))
            .then(() => l.ask({ op: 'status' }))
            .then((st) => ({ got: d.got, nets: nets, status: st }))
            .then(done, (e) => { done(); throw e; });
    };
    return run({}, 0).then((r) => {
        eq(r.got.length, 2, 'both services registered with the daemon');
        const air = r.got.filter((g) => g.type === '_airplay._tcp')[0], raop = r.got.filter((g) => g.type === '_raop._tcp')[0];
        ok(air && raop, 'as _airplay._tcp and _raop._tcp');
        eq([air.version, air.op, air.flags, air.datalen + 28 - air.rest > 0], [1, 5, 0, true], 'version 1, reg_service_request, no flags');
        eq([air.name, air.domain, air.host, air.iface, air.rest], ['iDrive', '', '', 0, 0], 'its name, every interface, the daemon\'s host, nothing left over');
        ok(/^[0-9A-F]{12}@iDrive$/.test(raop.name), 'the raop name: the id @ the name');
        ok(air.port === r.status.port || air.port > 0, 'its port');
        ok(/deviceid=/.test(air.txt) && /features=0x/.test(air.txt) && /pw=true/.test(air.txt), 'its TXT record');
        ok(/head unit's Bonjour/.test(r.status.network) && r.nets.some((n) => /head unit's Bonjour/.test(n)), 'the app hears how');
        return run({}, -65548);
    }).then((r) => {
        ok(r.got.length >= 1, 'asked the daemon');
        ok(!/Bonjour/.test(r.status.network) && r.status.advertising, 'refused: its own responder instead (' + r.status.network + ')');
        return run({ IDA_MDNS_SYSTEM: '0' }, 0);
    }).then((r) => eq(r.got.length, 0, 'IDA_MDNS_SYSTEM=0: the daemon left alone'));
});

/* ---- no GStreamer: the engine's pictures (frames.js), drawn here ---- */
const { Frames, MAGIC } = require('../src/frames.js');
test('frames: pictures read across chunks, asked for one at a time', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-frames-'));
    const sock = path.join(dir, 'frames.sock');
    const pic = (w, h, v) => { const b = Buffer.alloc(16 + w * h * 4, v); b.writeUInt32LE(MAGIC, 0); b.writeUInt32LE(w, 4); b.writeUInt32LE(h, 8); b.writeUInt32LE(w * h * 4, 12); return b; };
    let asked = 0;
    const srv = net.createServer((c) => {
        c.on('data', (d) => {
            asked += String(d).split('').filter((x) => x === 'r').length;
            const b = Buffer.concat([pic(4, 2, asked), pic(2, 2, 9)]);
            // in awkward pieces
            [3, 17, 20].reduce((at, n) => { c.write(b.slice(at, at + n)); return at + n; }, 0);
            c.write(b.slice(40));
        });
    }).listen(sock);
    const f = new Frames(sock, log, { retryMs: 50 });
    const got = [];
    f.on('frame', (w, h, rgba) => got.push([w, h, rgba.length, rgba[0]]));
    f.on('ready', () => f.want());
    f.connect();
    return until(() => got.length === 2, 3000, 'pictures').then(() => {
        eq(got, [[4, 2, 32, 1], [2, 2, 16, 9]], 'both, whole');
        eq(asked, 1, 'asked once');
        f.close(); srv.close();
    });
});
test('screens: no GStreamer: the picture drawn here, in the shape asked; Wi-Fi; the keyboard', () => {
    const rec = new ui.Recorder();
    const r = ui.draw(rec, { view: 'mirror', aspect: '4:3', soft: true, pic: { w: 1024, h: 472 }, mirror: { state: 'playing' } });
    eq(r.rec.u[1], ui.pack(ui.C.black), 'black behind it, not transparent');
    eq(r.rec.images, [ui.PIC_ID], 'the picture is drawn');
    const i = Array.from(r.rec.u.subarray(0, r.rec.n)).indexOf(ui.OP.IMAGE);
    const at = [r.rec.f[i + 1], r.rec.f[i + 2], r.rec.f[i + 3], r.rec.f[i + 4]];
    eq(at, (function (x) { return [x.x, x.y, x.w, x.h]; })(ui.shapeRect(ui.VIDEO, { w: 1024, h: 472 }, '4:3')), 'where shapeRect puts it');
    eq(ui.shapeRect(ui.VIDEO, { w: 1024, h: 472 }, 'stretch'), ui.VIDEO);
    eq(ui.shapeRect({ x: 0, y: 0, w: 1000, h: 500 }, { w: 100, h: 100 }, 'fit'), { x: 250, y: 0, w: 500, h: 500 });
    const st = { ifaces: [{ name: 'wlan0', kind: 'ap', ssid: 'MyBMW', up: 'up', state: 'ENABLED', v4: ['192.168.43.1'], v6: [], mac: 'm', clients: [{ mac: 'a', ip: '192.168.43.20', name: 'iPhone' }] },
        { name: 'wlan1', kind: 'station', ssid: 'Home', state: 'COMPLETED', up: 'up', v4: ['192.168.1.5'], v6: [], mac: 'n', clients: [] }], others: [] };
    eq(ui.wifiSummary(st), 'wlan0: access point "MyBMW" (1 device)  ·  wlan1: connected "Home" 192.168.1.5');
    ok(ui.wifiLines(st).some((l) => /iPhone\s+192\.168\.43\.20/.test(l.text)), 'the devices on the car\'s access point');
    const wk = keys({ view: 'wifi', wifi: { tool: true, status: st, tab: 'status' } });
    ['apWStatus', 'apWScan', 'apWDisc', 'apClose'].forEach((k) => ok(wk.indexOf(k) >= 0, 'Wi-Fi: ' + k));
    const nets = keys({ view: 'wifi', wifi: { tool: true, status: st, tab: 'networks', networks: [{ ssid: 'A', signal: -40, freq: 2412, secure: true }, { ssid: 'B', signal: -70, freq: 5180, secure: false }] } });
    ok(nets.indexOf('apWn_0') >= 0 && nets.indexOf('apWn_1') >= 0, 'the networks, to tap');
    ok(keys({ view: 'home', engine: {}, receiver: {}, wifi: { tool: true, status: st } }).indexOf('apWifi') >= 0, 'Home: Wi-Fi');
    const kb = keys({ view: 'wifipass', wifi: { target: 'A', pass: 'secret12' } });
    ['apKc_q', 'apKc_0', 'apKShift', 'apKSym', 'apKSpace', 'apKDel', 'apKClear', 'apWBack', 'apKConnect'].forEach((k) => ok(kb.indexOf(k) >= 0, 'keyboard: ' + k));
    ok(keys({ view: 'wifipass', wifi: { target: 'A', pass: 'secret12', shift: true } }).indexOf('apKc_Q') >= 0, 'Shift: capitals');
    const sym = keys({ view: 'wifipass', wifi: { target: 'A', pass: '', sym: true } });
    ['!', '@', '#', '"', '\\', '~', '{'].forEach((c) => ok(sym.indexOf('apKc_' + c) >= 0, 'symbols: ' + c));
    ok(keys({ view: 'wifipass', wifi: { target: 'A', pass: 'short' } }).indexOf('apKConnect') < 0, 'under 8 characters: no Connect');
    ok(keys({ view: 'wifipass', wifi: { target: 'A', pass: 'secret12', connecting: 'A' } }).indexOf('apKConnect') < 0, 'not twice');
});

/* ---- the Wi-Fi tool (packages/airplay/wifi) ---- */
const WIFI = path.join(ROOT, '..', 'wifi');
const wifi = require(path.join(WIFI, 'wifi.js'));
test('Wi-Fi tool: what wpa_supplicant, hostapd, iw and /proc say', () => {
    eq(wifi.kv('wpa_state=COMPLETED\nssid=Home\nip_address=192.168.1.5\n'), { wpa_state: 'COMPLETED', ssid: 'Home', ip_address: '192.168.1.5' });
    const nets = wifi.parseScan('bssid / frequency / signal level / flags / ssid\naa:bb:cc:dd:ee:01\t2437\t-71\t[WPA2-PSK-CCMP][ESS]\tHome\n' +
        'aa:bb:cc:dd:ee:02\t5180\t-48\t[WPA2-PSK-CCMP][ESS]\tHome\n11:22:33:44:55:66\t2412\t-80\t[ESS]\tCaf\\xc3\\xa9\naa:bb:cc:dd:ee:03\t2412\t-60\t[ESS]\t\n');
    eq(nets.map((n) => [n.ssid, n.signal, n.secure]), [['Home', -48, true], ['Café', -80, false]], 'strongest first, one per name, hidden ones left out, UTF-8 names');
    eq(wifi.parseIwScan('BSS 00:11:22:33:44:55(on wlan1)\n\tfreq: 5200\n\tsignal: -55.00 dBm\n\tSSID: Phone\n\tRSN:\t * Version: 1\nBSS 00:11:22:33:44:66(on wlan1)\n\tfreq: 2412\n\tsignal: -66.00 dBm\n\tSSID: Open\n')
        .map((n) => [n.ssid, n.freq, n.signal, n.secure]), [['Phone', 5200, -55, true], ['Open', 2412, -66, false]]);
    eq(wifi.parseAllSta('AA:BB:CC:00:00:01\nflags=[AUTH][ASSOC]\nsignal=-45\n11:22:33:44:55:66\nflags=[AUTH]\n'), [{ mac: 'aa:bb:cc:00:00:01', signal: -45 }, { mac: '11:22:33:44:55:66' }]);
    eq(wifi.parseStationDump('Station aa:bb:cc:00:00:01 (on uap0)\n\tsignal:  \t-50 [-50] dBm\n'), [{ mac: 'aa:bb:cc:00:00:01', signal: -50 }]);
    eq(wifi.parseIwInfo('Interface uap0\n\tifindex 5\n\ttype AP\n\tssid MyBMW 1234\n\tchannel 36 (5180 MHz), width: 80 MHz\n'), { type: 'AP', ssid: 'MyBMW 1234', channel: 36, freq: 5180 });
    eq(wifi.parseArp('IP address       HW type     Flags       HW address            Mask     Device\n192.168.43.20    0x1         0x2         11:22:33:44:55:66     *        uap0\n192.168.43.21    0x1         0x0         00:00:00:00:00:00     *        uap0\n'),
        [{ ip: '192.168.43.20', mac: '11:22:33:44:55:66', dev: 'uap0' }], 'incomplete entries left out');
    eq(wifi.parseLeases('1700000000 11:22:33:44:55:66 192.168.43.20 Annas-iPhone 01:11\n1700000000 aa:aa:aa:aa:aa:aa 192.168.43.21 * *\n'), { '11:22:33:44:55:66': 'Annas-iPhone' });
    eq(wifi.parseWireless('Inter-| sta-|   Quality        |\n face | tus | link level noise |\n wlan1: 0000   54.  -56.  -256        0      0      0      0      0        0\n'), { wlan1: -56 });
    eq([wifi.hex('Café 1'), wifi.quoted('p"ss')], ['436166c3a92031', '"p"ss"'], 'the SSID in hex (any byte), the password quoted');
});
test('Wi-Fi tool: status, scan, connect, disconnect against a stand-in head unit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-wifi-'));
    const sys = path.join(dir, 'sys'), proc = path.join(dir, 'proc'), socks = path.join(dir, 'run'), runDir = path.join(dir, 'tool');
    [['uap0', 'aa:bb:cc:00:00:10'], ['wlan1', 'aa:bb:cc:00:00:11']].forEach(([n, mac]) => {
        fs.mkdirSync(path.join(sys, n, 'wireless'), { recursive: true });
        fs.writeFileSync(path.join(sys, n, 'address'), mac + '\n'); fs.writeFileSync(path.join(sys, n, 'operstate'), 'up\n');
    });
    fs.mkdirSync(path.join(sys, 'eth0'), { recursive: true });
    fs.mkdirSync(path.join(proc, 'net'), { recursive: true });
    fs.writeFileSync(path.join(proc, 'net/arp'), 'IP address HW type Flags HW address Mask Device\n192.168.43.20 0x1 0x2 11:22:33:44:55:66 * uap0\n');
    fs.mkdirSync(path.join(socks, 'hostapd'), { recursive: true }); fs.mkdirSync(path.join(socks, 'wpa_supplicant'), { recursive: true });
    // the control sockets only need to exist (the stand-in ida-wpactl answers); their names are the interfaces'
    const servers = [path.join(socks, 'hostapd', 'uap0'), path.join(socks, 'wpa_supplicant', 'wlan1')].map((p) => net.createServer(() => {}).listen(p));
    const state = path.join(dir, 'state');
    fs.writeFileSync(state, 'DISCONNECTED');
    const fake = path.join(dir, 'ida-wpactl');
    fs.writeFileSync(fake, '#!/bin/sh\nPATH=/usr/bin:/bin\nS="' + state + '"\nsock="$1"; shift\necho "$*" >> "' + dir + '/log"\ncase "$sock:$1" in\n' +
        '*uap0:STATUS) printf "state=ENABLED\\nchannel=36\\nfreq=5180\\nssid[0]=MyBMW 1234\\nnum_sta_non_erp=0\\n" ;;\n' +
        '*uap0:ALL_STA) printf "11:22:33:44:55:66\\nsignal=-47\\n" ;;\n' +
        '*wlan1:STATUS) if [ "$(cat $S)" = COMPLETED ]; then printf "wpa_state=COMPLETED\\nssid=Home\\nmode=station\\nfreq=2437\\n"; else printf "wpa_state=DISCONNECTED\\n"; fi ;;\n' +
        '*wlan1:SCAN) echo OK ;;\n*wlan1:SCAN_RESULTS) printf "bssid / frequency / signal level / flags / ssid\\naa:bb:cc:dd:ee:01\\t2437\\t-50\\t[WPA2-PSK-CCMP][ESS]\\tHome\\n" ;;\n' +
        '*wlan1:ADD_NETWORK) echo 3 ;;\n*wlan1:SET_NETWORK) case "$*" in *\'"wrongpass"\'*) echo COMPLETED > /dev/null ;; esac; echo OK ;;\n' +
        '*wlan1:SELECT_NETWORK) if grep -q "psk \\"right-password\\"" "' + dir + '/log"; then echo COMPLETED > $S; fi; echo OK ;;\n' +
        '*wlan1:REMOVE_NETWORK) echo OK ;;\n*wlan1:DISCONNECT) echo DISCONNECTED > $S; echo OK ;;\n*) echo FAIL ;;\nesac\n');
    fs.chmodSync(fake, 0o755);
    const tool = cp.spawn(process.execPath, [path.join(WIFI, 'wifi.js')], { stdio: 'ignore', env: Object.assign({}, process.env,
        { APW_RUN: runDir, APW_SYS: sys, APW_PROC: proc, APW_WPACTL: fake, APW_SOCKET_DIRS: socks, APW_ADDR_MS: '300', PATH: '/nonexistent' }) });
    const l = new links.JsonLink('Wi-Fi tool', path.join(runDir, 'ctl.sock'), log, { retryMs: 50, timeoutMs: 40000 });
    const done = () => { l.close(); tool.kill(); servers.forEach((s) => s.close()); };
    return until(() => links.isSocket(path.join(runDir, 'ctl.sock')), 5000, 'socket')
        .then(() => { l.connect(); return until(() => l.ready, 3000, 'connection'); })
        .then(() => l.ask({ op: 'status' }))
        .then((st) => {
            eq(st.ifaces.map((i) => [i.name, i.kind, i.ssid]), [['uap0', 'ap', 'MyBMW 1234'], ['wlan1', 'station', null]], 'the car\'s access point and the client');
            eq(st.ifaces[0].clients, [{ mac: '11:22:33:44:55:66', signal: -47, ip: '192.168.43.20', name: null }], 'who is on it: hostapd and the ARP table');
            eq([st.ifaces[0].channel, st.ifaces[0].mac, st.ifaces[0].control], [36, 'aa:bb:cc:00:00:10', path.join(socks, 'hostapd', 'uap0')]);
            return l.ask({ op: 'scan', iface: 'wlan1' });
        })
        .then((r) => {
            eq(r.networks.map((n) => n.ssid), ['Home']);
            return l.ask({ op: 'connect', iface: 'wlan1', ssid: 'Home', psk: 'wrongpass' }).then(() => ok(false, 'a wrong password'), (e) => ok(/not connected/.test(e.message), 'a wrong password: not connected'));
        })
        .then(() => {
            const lg = fs.readFileSync(path.join(dir, 'log'), 'utf8');
            ok(/SET_NETWORK 3 ssid 486f6d65/.test(lg) && /SET_NETWORK 3 psk "wrongpass"/.test(lg) && /REMOVE_NETWORK 3/.test(lg), 'the network added (SSID in hex), then removed again');
            return l.ask({ op: 'connect', iface: 'wlan1', ssid: 'Home', psk: 'short' }).then(() => ok(false), (e) => ok(/8 to 63/.test(e.message), 'a password too short is refused'));
        })
        .then(() => l.ask({ op: 'connect', iface: 'wlan1', ssid: 'Home', psk: 'right-password' }))
        .then((r) => { eq([r.state, r.ssid], ['COMPLETED', 'Home'], 'connected'); return l.ask({ op: 'connect', iface: 'uap0', ssid: 'X', psk: '' }).then(() => ok(false), (e) => ok(/not a Wi-Fi client/.test(e.message), 'the car\'s access point can\'t join a network')); })
        .then(() => l.ask({ op: 'disconnect', iface: 'wlan1' }))
        .then(() => l.ask({ op: 'status' }))
        .then((st) => { eq(st.ifaces[1].state, 'DISCONNECTED', 'disconnected'); done(); }, (e) => { done(); throw e; });
});
test('Wi-Fi tool: the component, ida-wpactl for both processors', () => {
    const comp = JSON.parse(fs.readFileSync(path.join(WIFI, 'component.json'), 'utf8'));
    eq(comp.id, 'ida-airplay-wifi');
    comp.files.forEach((f) => ok(fs.existsSync(path.join(WIFI, f.from)), 'wifi file ' + f.from));
    comp.units.forEach((u) => ok(fs.existsSync(path.join(WIFI, u.from)), 'wifi unit ' + u.from));
    [['x86_64', 62], ['aarch64', 183]].forEach(([arch, machine]) => {
        const rel = 'bin/' + arch + '/ida-wpactl', b = fs.readFileSync(path.join(WIFI, rel));
        ok(b.slice(0, 4).toString('latin1') === '\x7fELF' && b.readUInt16LE(18) === machine, rel + ' is for ' + arch);
        eq(comp.files.filter((f) => f.from === rel)[0].mode, '0755', rel + ' is executable');
    });
    const src = fs.readFileSync(path.join(WIFI, 'wifi.js'), 'utf8');
    ok(!/\?\.|\?\?|Object\.fromEntries/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''")), 'wifi.js: Node 8 syntax only');
    if (process.arch === 'x64' && process.platform === 'linux') {
        const r = cp.spawnSync(path.join(WIFI, 'bin/x86_64/ida-wpactl'), [path.join(os.tmpdir(), 'no-such-socket'), 'STATUS'], { encoding: 'utf8' });
        ok(r.status === 1 && /^ERROR: /.test(r.stdout), 'no socket: an error, exit 1');
    }
});

/* run them in order */
tests.reduce((p, t) => p.then(() => Promise.resolve().then(t[1]).catch((e) => { e.message = t[0] + ': ' + e.message; throw e; })), Promise.resolve())
    .then(() => { console.log(n + ' checks passed'); process.exit(0); },
        (e) => { console.error('FAIL ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
