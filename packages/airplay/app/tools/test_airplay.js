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

/* run them in order */
tests.reduce((p, t) => p.then(() => Promise.resolve().then(t[1]).catch((e) => { e.message = t[0] + ': ' + e.message; throw e; })), Promise.resolve())
    .then(() => { console.log(n + ' checks passed'); process.exit(0); },
        (e) => { console.error('FAIL ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
