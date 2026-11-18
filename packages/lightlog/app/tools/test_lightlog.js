'use strict';
/* node packages/lightlog/app/tools/test_lightlog.js: the LIN records, the read-only diagnostic link (against a fake
 * transport), the journal, the screen, and the package's car-side rules (Node 8, read only, the manifest) */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const lin = require('../src/lin.js');
const uds = require('../src/uds.js');
const { Journal, change, line } = require('../src/journal.js');
const screen = require('../src/screen_model.js');
const { LogFile } = require('../src/log_file.js');

const ROOT = path.join(__dirname, '..');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

/* ---- LIN records ---- */
const rec = (loc, b, g, r, bright, white, faults) => [loc, b, g, r, bright, white || 0].concat(faults || [0, 0, 0, 0]);
const empty = () => [0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0];
function reply(bus, records) {
    const out = [0x62].concat(lin.BUSES[bus].did);
    for (let i = 0; i < 26; i++) out.push.apply(out, records[i] || empty());
    return out;
}
let mods = lin.parseStatus(0, reply(0, [rec(0x05, 254, 0, 0, 80), empty(), rec(0x1b, 255, 255, 255, 100), rec(0x77, 0, 0, 0, 0)]));
ok(mods.length === 3, 'empty records skipped');
ok(mods[0].name === 'Driver front door line' && mods[0].on && mods[0].b === 254 && mods[0].r === 0, 'record decoded (b g r order)');
ok(mods[1].nad === 3 && mods[1].seat && mods[1].name === 'Driver seat back', 'seat light flagged, nad = place');
ok(mods[2].name === 'Light 0x77' && !mods[2].known && !mods[2].on, 'unknown location named by its code');
ok(lin.parseStatus(1, reply(0, [])) === null, 'another bus\'s reply is not this bus\'s');
ok(lin.parseStatus(0, [0x7f, 0x22, 0x31]) === null, 'a refusal is no status');
ok(/FAULT/.test(lin.describe(lin.parseStatus(0, reply(0, [rec(1, 1, 1, 1, 10, 0, [0, 1, 0, 0])]))[0])), 'fault shown');
ok(/Driver seat back \(LIN 1 #3, 0x1B\): on 100% rgb 255,255,255/.test(lin.describe(mods[1])), 'describe');

/* ---- the diagnostic link: read only ---- */
assert.throws(() => uds.check(0x40, 0x2e, [0xda, 0x5e]), /read-only/); n++;
assert.throws(() => uds.check(0x40, 0x31, [1, 2]), /read-only/); n++;
assert.throws(() => uds.check(0xdf, 0x22, [0xf1, 0x50]), /one ECU/); n++;
assert.throws(() => uds.check(0x40, 0x22, [0xda, 0x5f, 0x01]), /one identifier/); n++;
uds.check(0x40, 0x22, [0xda, 0x5f]); n++;
ok(uds.parseFrame({ udsResponse: [0, 0, 0x7f, 0, 0x21] }).reject === 0x21, 'transport rejection');
ok(uds.parseFrame({ errorCode: 'TIMEOUT' }).error === 'TIMEOUT', 'transport error');
const fr = uds.parseFrame({ udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0x62, 0xda, 0x5f]) });
ok(fr.ecu === 0x40 && fr.uds.join() === [0x62, 0xda, 0x5f].join(), 'frame header stripped');
ok(uds.verdictOf(undefined) === 'NO_ERROR' && uds.verdictOf({ TasuErrorEnum: 'APP_REQUEST_TEMPORARILY_NOT_ACCEPTED' }) === 'APP_REQUEST_TEMPORARILY_NOT_ACCEPTED', 'verdicts');

const log = { info: () => {}, warn: () => {}, error: () => {} };
function fakeLink(answer) {
    const l = { sent: [], onFrame: null };
    l.open = (iface, inst, o) => { l.onFrame = o.broadcasts.sendTasuResponse; return Promise.resolve(); };
    l.call = (iface, method, req) => {
        l.sent.push(req);
        const frames = answer(req);
        frames.forEach((f, i) => setTimeout(() => l.onFrame({ udsResponse: [0, 0, 0, 0, 0, 0, f.ecu, 0, 0].concat(f.uds) }), 5 * (i + 1)));
        return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
    };
    return l;
}

const tests = [];
tests.push(() => {
    // pending first, then another ECU's and another DID's answers (skipped), then ours
    const link = fakeLink((req) => [
        { ecu: 0x40, uds: [0x7f, 0x22, 0x78] },
        { ecu: 0x12, uds: [0x62, 0xda, 0x5f, 1] },
        { ecu: 0x40, uds: [0x62, 0xe3, 0xd1, 1] },
        { ecu: 0x40, uds: reply(0, [rec(0x1b, 0, 0, 0, 0)]) },
    ]);
    const u = new uds.Uds(link, log);
    return u.init().then(() => u.read(lin.BDC, lin.readRequest(0), 200)).then((r) => {
        ok(r && lin.parseStatus(0, r)[0].loc === 0x1b, 'read waits through pending and skips others\' frames');
        const req = link.sent[0];
        ok(req.serviceID === 0x22 && req.targetAddress === 0x40 && req.sourceAddress === 0xf2 && Buffer.from(req.udsData).join() === '218,95', 'request bytes');
        ok(u.answered === 1, 'counted');
    });
});
tests.push(() => {
    const u = new uds.Uds(fakeLink(() => [{ ecu: 0x40, uds: [0x7f, 0x22, 0x31] }]), log);
    return u.init().then(() => u.read(0x40, [0xda, 0x5f], 200)).then((r) => ok(r.join() === '127,34,49', 'a refusal is returned'));
});
tests.push(() => {
    const u = new uds.Uds(fakeLink(() => []), log);
    return u.init().then(() => u.read(0x40, [0xda, 0x5f], 30)).then((r) => ok(r === null && u.missed === 1, 'no answer: null'));
});
tests.push(() => {
    const u = new uds.Uds(fakeLink(() => []), log);
    return u.init().then(() => u.read(0xdf, [0xf1, 0x50])).then(() => ok(false, 'never'), () => ok(true, 'bad requests never reach the link'));
});
tests.push(() => {
    const link = fakeLink(() => []);
    link.call = () => Promise.resolve({ TasuErrorEnum: 'APP_REQUEST_NOT_ACCEPTED' });
    const u = new uds.Uds(link, log);
    return u.init().then(() => u.read(0x40, [0xda, 0x5f], 30)).then(() => ok(false, 'never'), (e) => ok(/refused/.test(e.message), 'transport refusal rejects'));
});

/* ---- the journal ---- */
let t = Date.UTC(2026, 10, 18, 12, 0, 0);
const j = new Journal({ now: () => t });
j.lights(0, lin.parseStatus(0, reply(0, [rec(0x05, 254, 0, 0, 80), rec(0x1b, 255, 255, 255, 100)])));
ok(j.events.length === 3 && /2 light modules, 2 on/.test(j.events[0].text), 'first read: a summary and every module');
ok(j.events[2].seat && j.events[2].kind === 'seat', 'seat event');
t += 4000;
j.rpm({ actualValueRPMEngineCrankshaft: 3200 });             // 800 rpm
ok(j.engine === true && /engine running \(800 rpm\)/.test(j.events[3].text), 'engine start');
j.rpm({ actualValueRPMEngineCrankshaft: 65535 });
ok(j.events.length === 4, 'invalid rpm ignored');
j.lights(0, lin.parseStatus(0, reply(0, [rec(0x05, 254, 0, 0, 80), rec(0x1b, 0, 0, 0, 0)])));
const off = j.events[j.events.length - 1];
ok(off.seat && /^OFF: Driver seat back/.test(off.text), 'seat logo off logged');
j.lights(0, lin.parseStatus(0, reply(0, [rec(0x05, 254, 0, 0, 80), rec(0x1b, 0, 0, 0, 0)])));
ok(j.events[j.events.length - 1] === off, 'no change, no event');
j.speed({ speedVehicleCentreOfGravity: 640 });               // 10 km/h
ok(j.moving && /moving \(10 km\/h\)/.test(j.events[j.events.length - 1].text), 'moving');
j.speed({ speedVehicleCentreOfGravity: 0 });
ok(j.moving === false, 'standing');
j.lights(0, null); j.lights(0, null);
const before = j.events.length;
j.lights(0, null);
ok(j.events.length === before + 1 && /stopped answering/.test(j.events[before].text), 'silent BDC after 3 misses');
j.lights(0, lin.parseStatus(0, reply(0, [rec(0x05, 254, 0, 0, 80)])));
ok(j.events.some((e) => /answers again/.test(e.text)) && j.events.some((e) => /^gone Driver seat back/.test(e.text)), 'back, and a module gone');
ok(/^MARK 1/.test(j.mark().text) && j.marks === 1, 'mark');
const a = { on: true, fault: false, bright: 50, r: 10, g: 10, b: 10, white: 0 };
ok(change(a, Object.assign({}, a, { bright: 52 })) === '', 'small brightness wobble ignored');
ok(/^brightness/.test(change(a, Object.assign({}, a, { bright: 60 }))), 'brightness change');
ok(change(a, Object.assign({}, a, { r: 200 })) === 'colour', 'colour change');
ok(/^\d\d:\d\d:\d\d {2}MARK {3}MARK 1/.test(line(j.events[j.events.length - 1])), 'line format');

/* ---- the screen ---- */
const ev = screen.lines('events', j);
ok(ev.length === screen.LINES && /MARK 1/.test(ev[0]), 'newest first, LINES rows');
j.lights(1, lin.parseStatus(1, reply(1, [rec(0x01, 1, 1, 1, 10), rec(0x1c, 255, 255, 255, 90)])));
const li = screen.lines('lights', j);
ok(/^\[SEAT\] Passenger seat back/.test(li[0]) && li[3] === '', 'seat lights first');
ok(screen.nextView('events') === 'lights' && screen.nextView('lights') === 'events', 'view toggles');
const st = screen.status({ linkReady: true, buses: [{ modules: 2, on: 1 }, { modules: null, reads: 3 }], engine: true, kmh: 0, file: '/x/l.txt' });
ok(/diagnostic link ready.*LIN 1: 2 modules, 1 on.*LIN 2: no answer yet.*engine running.*0 km\/h.*file \/x\/l.txt/.test(st), 'status line');
j.clear();
ok(screen.lines('events', j)[0] === 'Nothing logged yet.', 'cleared');

/* ---- the log file ---- */
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lightlog-'));
const f = new LogFile([path.join(tmp, 'nope', 'deeper'), tmp], 'l.txt', 40);
ok(f.path === path.join(tmp, 'l.txt'), 'first writable folder');
f.write('0123456789012345678901234567890123456789'); f.write('next');
ok(fs.readFileSync(f.path, 'utf8') === 'next\n' && fs.existsSync(f.path + '.1'), 'rotated past maxBytes');

/* ---- the package's car-side rules ---- */
const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-app.json'), 'utf8'));
app.modules.forEach((m) => {
    const src = fs.readFileSync(path.join(ROOT, m), 'utf8');
    ok(!/\?\.|\?\?|Object\.fromEntries|recursive:\s*true|\basync\s|\bawait\s|\.\.\.[a-zA-Z]/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), m + ': Node 8 only');
    (src.match(/require\('([^']+)'\)/g) || []).map((r) => r.slice(9, -2)).forEach((r) => {
        ok(r[0] === '.' || app.sdk.indexOf(r) >= 0 || ['events', 'fs', 'path', 'os', 'net'].indexOf(r) >= 0, m + ': may require ' + r);
    });
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    if (m === 'src/uds.js') ok((code.match(/serviceID:\s*\w+/g) || []).join() === 'serviceID: READ', 'uds.js sends ReadDataByIdentifier only');
    else ok(code.indexOf('serviceID') < 0, m + ': requests only through uds.js');
});
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'package', 'manifest.json'), 'utf8')).proxies;
const tasu = man['com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu'];
ok(tasu && tasu.methods.join() === 'sendTasuRequest' && tasu.broadcasts.join() === 'sendTasuResponse', 'manifest: the diagnostic link');
ok(man['de.bmw.infotainment.vehicle.CDS'].attributes.statusEngineSpeed2 === 'rs' && man['de.bmw.infotainment.vehicle.Vehicle2'].attributes.statusCarSpeed2 === 'rs', 'manifest: engine and speed');
const ui = JSON.parse(fs.readFileSync(path.join(ROOT, 'package/rhmiData/uiDescriptions/ID8/uiDescription.json'), 'utf8'));
const names = Object.keys(ui.containers[1].components).map((k) => ui.containers[1].components[k].name);
['llStatus', 'llMark', 'llRead', 'llView', 'llClear', 'llLine0', 'llLine' + (screen.LINES - 1)].forEach((x) => ok(names.indexOf(x) >= 0, 'screen has ' + x));
ok(ui.containers[1].name === 'ST_OnlineApps_LightLog', 'state name the app looks for');

tests.reduce((p, fn) => p.then(fn), Promise.resolve()).then(() => {
    console.log('ok (' + n + ' checks)');
}).catch((e) => { console.error(e); process.exit(1); });
