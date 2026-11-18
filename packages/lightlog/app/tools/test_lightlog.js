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
const ui = require('../src/ui.js');
const lamps = require('../src/lamps.js');
const { Finder } = require('../src/finder.js');

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
assert.throws(() => uds.check(0x40, 0x22, [0xda, 0x5f, 0x01]), /identifiers/); n++;
assert.throws(() => uds.check(0x40, 0x22, new Array(18).fill(1)), /identifiers/); n++;
uds.check(0x40, 0x22, new Array(16).fill(1)); n++;
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

/* ---- the screen: only what may be the seat logos ---- */
const ev = screen.lines('log', j);
ok(ev.length === screen.LINES && /MARK 1/.test(ev[0]), 'log: newest first, LINES rows');
ok(ev.some((x) => /OFF: Driver seat back/.test(x)) && !ev.some((x) => /Driver front door line/.test(x)), 'log: seat lights, not the door line');
j.lights(1, lin.parseStatus(1, reply(1, [rec(0x01, 1, 1, 1, 10), rec(0x1c, 255, 255, 255, 90), rec(0x5a, 255, 255, 255, 100)])));
const li = screen.lines('seat', j);
ok(/^\[SEAT\] Passenger seat back/.test(li[0]) && /^\[UNKNOWN CODE\] Light 0x5A/.test(li[1]) && li[2] === '', 'seat view: seat and unknown lights only');
ok(screen.lines('all', j).filter((x) => x).length === 4, 'all view: every module');
ok(screen.nextView('seat') === 'log' && screen.nextView('log') === 'all' && screen.nextView('all') === 'find' && screen.nextView('find') === 'seat' && screen.nextDrawnView('all') === 'find' && screen.nextDrawnView('find') === 'seat', 'views cycle');
const st = screen.status({ linkReady: true, buses: [{ modules: 2, on: 1 }, { modules: null, reads: 3 }], engine: true, kmh: 0, file: '/x/l.txt' });
ok(/diagnostic link ready.*LIN 1: 2 lights, 1 on.*LIN 2: no answer yet.*engine running.*0 km\/h.*file \/x\/l.txt/.test(st), 'status line');
j.clear();
ok(screen.lines('log', j)[0] === 'Nothing logged yet.', 'cleared');

/* ---- relevance: changed at a mark, pinned, none ---- */
t = Date.UTC(2026, 10, 18, 13, 0, 0);
const k = new Journal({ now: () => t });
const door = (bright, logo) => lin.parseStatus(0, reply(0, [rec(0x05, 0, 120, 254, bright), rec(0x0d, 255, 255, 255, logo)]));
k.lights(0, door(70, 100));
ok(k.relevant().length === 0 && /No seat light so far/.test(screen.lines('seat', k)[0]), 'known non-seat lights: nothing relevant, and it says why');
t += 30000; k.lights(0, door(70, 0));                 // the "logo" behind a known code goes off ...
t += 40000; k.mark();                                 // ... long before the mark: not it
ok(k.relevant().length === 0, 'a change 40 s before the mark is not at the mark');
t += 5000; k.lights(0, door(70, 100));                // on again 5 s after a mark
ok(k.relevant().length === 1 && k.relevant()[0].loc === 0x0d && k.relevant()[0].reasons.join() === 'mark', 'changed at a mark');
ok(k.isRelevant(k.events[k.events.length - 1]) && !k.isRelevant({ key: '0:5', seat: false }), 'log filter follows relevance');
ok(k.togglePin('0:5') && k.relevant()[0].key === '0:5' && k.relevant()[0].reasons[0] === 'pinned', 'pinned first');
ok(/pinned Driver front door line \(LIN 1, 0x05\)/.test(k.events[k.events.length - 1].text), 'pin logged by name');
let saved = null; k.on('pins', (x) => { saved = x; });
ok(!k.togglePin('0:5') && saved && saved.length === 0, 'unpin, saved');
k.setPins(['1:27', 'junk', '0:90']);
ok(Array.from(k.pins).join() === '1:27,0:90', 'pins checked when loaded');

/* ---- the drawn screen ---- */
const st2 = { linkReady: true, buses: [{ modules: 2, on: 1 }, { modules: 1, on: 1 }], engine: true, kmh: 12 };
const drawn = ui.draw(new ui.Recorder(), screen.drawModel(k, st2, 'seat', 'llMark', null));
const keys = drawn.targets.map((x) => x.key);
['llMark', 'llRead', 'view:seat', 'view:all', 'view:find', 'llClear', 'pin:0:13'].forEach((x) => ok(keys.indexOf(x) >= 0, 'drawn: ' + x));
ok(drawn.targets.every((x) => x.x >= 0 && x.y >= 0 && x.x + x.w <= ui.W && x.y + x.h <= ui.H), 'drawn: targets on screen');
ok(drawn.rec.n > 100 && drawn.rec.atlases.length >= 2, 'drawn: ops and glyphs');
ok(ui.hit(drawn.targets, drawn.targets[0].x + 2, drawn.targets[0].y + 2).key === drawn.targets[0].key, 'hit');
const allDrawn = ui.draw(new ui.Recorder(), screen.drawModel(k, st2, 'all', null, null));
ok(allDrawn.targets.filter((x) => /^pin:/.test(x.key)).length === 2, 'drawn all: a pin per light');
const r0 = new ui.Recorder();
ok(ui.fit(r0, 'small', 'x'.repeat(400), 300).slice(-3) === '...' && r0.width('small', ui.fit(r0, 'small', 'x'.repeat(400), 300)) <= 300, 'fit');
ok(ui.glow({ on: false }).join() === '44,48,58,255' && ui.glow({ on: true, bright: 100, r: 255, g: 0, b: 0, white: 0 })[0] === 255, 'glow');
const emptyDrawn = ui.draw(new ui.Recorder(), screen.drawModel(new Journal(), { buses: [{}, {}] }, 'seat', null, null));
ok(emptyDrawn.targets.length === 6, 'drawn before any answer: just the buttons');

/* ---- the BDC's lamp outputs ---- */
const lampReply = [0x62, 0xe3, 0xb9, 0x00, 0x01, 0x64, 0x00];
const lo = lamps.parse(lampReply, [0xe3, 0xb9]);
ok(lo.length === 4 && !lo[0].on && lo[1].on && lo[2].raw === '64' && lo[3].bus === lamps.LAMPS, 'lamp outputs: a byte each');
ok(lamps.parse(lampReply, [0x45, 0x00]) === null && lamps.parse([0x62, 0xe3, 0xb9], [0xe3, 0xb9]) === null, 'lamp outputs: only its own reply');
t = Date.UTC(2026, 10, 18, 15, 0, 0);
const jl = new Journal({ now: () => t });
jl.lights(2, lo);
ok(/BDC lamp outputs: 4 outputs, 2 on/.test(jl.events[0].text) && jl.relevant().length === 0, 'lamp outputs logged, none relevant by themselves');
t += 10000; jl.lights(2, lamps.parse([0x62, 0xe3, 0xb9, 0x00, 0x00, 0x64, 0x00], [0xe3, 0xb9]));
t += 3000; jl.mark();
ok(jl.relevant().length === 1 && jl.relevant()[0].name === 'BDC lamp output 2' && jl.relevant()[0].reasons.join() === 'mark', 'lamp output off at the mark: relevant');
ok(/^OFF: BDC lamp output 2: off \(00\)/.test(jl.events.filter((e) => e.kind === 'light').pop().text), 'lamp output event');
jl.lights(2, lamps.parse([0x62, 0xe3, 0xb9, 0x00, 0x00, 0x32, 0x00], [0xe3, 0xb9]));
ok(/^value 64 -> 32: BDC lamp output 3/.test(jl.events.filter((e) => e.kind === 'light').pop().text), 'lamp output value change');
const vm = lamps.valueModule(0x6d, 0xd123, [0, 1], null, 1);
ok(vm.key === 'd:6D:D123' && vm.on && vm.name === 'Seat module 0x6D 0xD123', 'a pinned value as a module');
jl.setPins(['d:6D:D123', 'd:6d:d123']);
ok(jl.pinnedValues().join() === 'd:6D:D123', 'value pins');
jl.lights(3, [vm]);
ok(jl.relevant()[0].key === 'd:6D:D123' && jl.relevant()[0].reasons[0] === 'pinned', 'pinned value first');
ok(screen.lines('all', jl).some((x) => /BDC lamp output 3: on \(32\)/.test(x)), 'all view: lamp outputs');

/* ---- the finder, against a fake car ---- */
// the BDC has D100 (1 byte, follows the logos), D101 (2 bytes, moves anyway), D108 (1 byte, constant); seat module 0x6D
// has 4001 (1 byte); 0x6E and 0x6F don't answer
const car = { logos: true, tick: 0 };
const values = { 0x40: { 0xd100: () => [car.logos ? 1 : 0], 0xd101: () => [car.tick++, 7], 0xd108: () => [9] }, 0x6d: { 0x4001: () => [3] } };
const fakeUds = { read: (ecu, data) => {
    const unit = values[ecu];
    if (!unit) return Promise.resolve(null);
    const out = [0x62];
    for (let i = 0; i < data.length; i += 2) {
        const d = (data[i] << 8) | data[i + 1];
        if (d === 0xf150) return Promise.resolve([0x62, 0xf1, 0x50, 1]);
        if (unit[d]) out.push(data[i], data[i + 1], ...unit[d]());
    }
    return Promise.resolve(out.length > 1 ? out : [0x7f, 0x22, 0x31]);
} };
let store = null;
const fd = new Finder({ uds: fakeUds, log, gapMs: 0, store: { load: () => store, save: (o) => { store = JSON.parse(JSON.stringify(o)); } } });
tests.push(() => fd.learn().then(() => {
    const st = fd.state;
    ok(st.units.map((u) => u.unit).join() === '64,109' && st.learnedAll, 'finder: BDC and seat module 0x6D answer');
    ok(JSON.stringify(fd.known[0x40].dids) === '{"53504":1,"53505":2,"53512":1}' && fd.known[0x6d].dids[0x4001] === 1, 'finder: identifiers and lengths learned');
    return fd.snapshot('on').then(() => fd.snapshot('on'));
}).then(() => { car.logos = false; return fd.snapshot('off'); }).then(() => fd.snapshot('off')).then(() => {
    const c = fd.candidates();
    ok(c.length === 1 && c[0].key === 'd:40:D100' && c[0].on === '01' && c[0].off === '00', 'finder: only the value that follows the logos');
    ok(new Finder({ uds: fakeUds, log, store: { load: () => store, save: () => {} } }).candidates().length === 1, 'finder: kept across restarts');
    ok(/1 values follow the logos/.test(screen.findText(fd).join('|')) && /BDC 0xD100 {3}ON 01 {3}OFF 00/.test(screen.findText(fd).join('|')), 'find view text');
    const dm = screen.drawModel(new Journal(), { buses: [{}, {}, {}, {}] }, 'find', null, null, fd);
    const dr = ui.draw(new ui.Recorder(), dm);
    ['llLearn', 'llSnapOn', 'llSnapOff', 'pin:d:40:D100'].forEach((x) => ok(dr.targets.some((tg) => tg.key === x), 'drawn find: ' + x));
}));
tests.push(() => {
    // a unit whose reply doesn't add up by the learned lengths is read one by one
    const odd = { read: (ecu, data) => Promise.resolve(data.length > 2 ? [0x62, 0xd1, 0x00, 1, 2, 3] : [0x62, data[0], data[1], 5]) };
    const f2 = new Finder({ uds: odd, log, gapMs: 0 });
    f2.units = [0x40]; f2.known = { 64: { dids: { 53504: 1, 53505: 1 }, next: 99999, done: true } };
    return f2.snapshot('on').then((sn) => ok(sn.values['d:40:D100'] === '05' && sn.values['d:40:D101'] === '05', 'finder: one by one when the lengths don\'t add up'));
});


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
const ui2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'package/rhmiData/uiDescriptions/ID8/uiDescription.json'), 'utf8'));
const names = Object.keys(ui2.containers[1].components).map((x) => ui2.containers[1].components[x].name);
['llStatus', 'llMark', 'llRead', 'llView', 'llClear', 'llLine0', 'llLine' + (screen.LINES - 1)].forEach((x) => ok(names.indexOf(x) >= 0, 'screen has ' + x));
ok(ui2.containers[1].name === 'ST_OnlineApps_LightLog', 'state name the app looks for');
const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'package', 'package.json'), 'utf8'));
ok(pj.mguAppStartType === 'autostart', 'starts with the head unit');

tests.reduce((p, fn) => p.then(fn), Promise.resolve()).then(() => {
    console.log('ok (' + n + ' checks)');
}).catch((e) => { console.error(e); process.exit(1); });
