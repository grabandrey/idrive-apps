'use strict';
/* node packages/drlcolor/app/tools/test_drlcolor.js: learning and flashing against a fake body controller, the copies
 * of Light Logger's modules, the screen, and the package's car-side rules (Node 8, the manifest) */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const uds = require('../src/uds.js');
const { Flasher } = require('../src/flasher.js');
const ui = require('../src/ui.js');

const ROOT = path.join(__dirname, '..');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const log = { info: () => {}, warn: () => {}, error: () => {} };

/* ---- the copies stay Light Logger's ---- */
['uds.js', 'someip_link.js', 'lamps.js', 'gpu.js', 'ui_font.js'].forEach((f) => {
    const mine = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    const theirs = fs.readFileSync(path.join(ROOT, '..', '..', 'lightlog', 'app', 'src', f), 'utf8');
    ok(mine === theirs, f + ' is the same as Light Logger\'s (copy it again: cp packages/lightlog/app/src/' + f + ' packages/drlcolor/app/src/)');
});

/* ---- a fake body controller: the high beams on lamp outputs 12 and 13, layout 2 (a 2-byte element), 13 to other lengths ---- */
function fakeLink(answer) {
    const l = { onFrame: null };
    l.open = (iface, inst, o) => { l.onFrame = o.broadcasts.sendTasuResponse; return Promise.resolve(); };
    l.call = (iface, method, req) => {
        answer(req).forEach((f, i) => setTimeout(() => l.onFrame({ udsResponse: [0, 0, 0, 0, 0, 0, f.ecu, 0, 0].concat(f.uds) }), 1 + i));
        return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
    };
    return l;
}
const HIGH = [11, 12];      // elements: outputs 12 and 13
function fakeBdc(layoutIndex) {
    const b = { session: 1, held: {}, log: [], refuse: null, refuseAfter: 0, stalk: false, other: {}, flashes: 0, pattern: [] };
    const want = uds.FORMATS[layoutIndex];
    b.lit = (i) => !!(b.held[i] || (b.stalk && HIGH.indexOf(i) >= 0) || b.other[i] || i === 6);
    b.answer = (req) => {
        const d = Array.from(Buffer.from(req.udsData)), sid = req.serviceID;
        b.log.push([sid].concat(d).map((x) => (x < 16 ? '0' : '') + x.toString(16).toUpperCase()).join(' '));
        const out = (u) => [{ ecu: 0x40, uds: u }];
        if (sid === 0x22) {
            if (d[0] !== 0xe3 || d[1] !== 0xb9) return out([0x7f, 0x22, 0x31]);
            const o = [0x62, 0xe3, 0xb9];
            for (let i = 0; i < 50; i++) o.push(b.lit(i) ? 1 : 0);
            return out(o);
        }
        if (b.refuse && b.refuse.sid === sid && b.log.filter((x) => x.indexOf(sid.toString(16).toUpperCase()) === 0).length > b.refuseAfter) {
            return out([0x7f, sid, b.refuse.nrc]);
        }
        if (sid === 0x10) { b.session = d[0]; if (d[0] === 1) b.held = {}; return out([0x50, d[0]]); }
        if (sid === 0x2f) {
            if (b.session !== 3) return out([0x7f, 0x2f, 0x7f]);
            const rest = d.slice(2);
            const el = HIGH.concat([20]).find((e) => rest.join() === want.on(e).join() || rest.join() === want.back(e).join());
            if (rest.length !== want.on(0).length) return out([0x7f, 0x2f, 0x13]);
            if (el === undefined) return out([0x7f, 0x2f, 0x31]);
            const on = rest.join() === want.on(el).join();
            const was = HIGH.every((e) => b.held[e]);
            b.held[el] = on;
            const now = HIGH.every((e) => b.held[e]);
            if (now && !was) { b.flashes++; b.pattern.push(Date.now()); }
            return out([0x6f, d[0], d[1]].concat(rest.slice(0, 2)));
        }
        return out([0x7f, sid, 0x11]);
    };
    return b;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function flasherFor(bdc, opts) {
    const u = new uds.Uds(fakeLink(bdc.answer), log);
    const f = new Flasher(Object.assign({ uds: u, log, learnMs: 400, sampleMs: 10, settleMs: 5, onMs: 20, offMs: 20, autoDelayMs: 30 }, opts || {}));
    const saves = [];
    f.on('save', (x) => saves.push(JSON.parse(JSON.stringify(x))));
    return u.init().then(() => ({ f: f, u: u, saves: saves }));
}
/* the driver pulls the stalk: high beams on for 60 ms, off for 60 ms, times times, starting after 50 ms */
function stalk(bdc, times) {
    let p = wait(50);
    for (let i = 0; i < times; i++) p = p.then(() => { bdc.stalk = true; return wait(60); }).then(() => { bdc.stalk = false; return wait(60); });
    return p;
}

const tests = [];
tests.push(() => {
    // the whole thing: not learned, learn (the stalk flashed 3 times, something else switched on and stays on), flash
    const bdc = fakeBdc(1);
    let f, saves;
    return flasherFor(bdc).then((x) => {
        f = x.f; saves = x.saves;
        ok(!f.state.ready && f.state.colour === null, 'nothing learned, colour not known');
        return f.flash();
    }).then((done) => {
        ok(done === false && /Learn the high beams first/.test(f.note) && !bdc.log.length, 'flash before learning: nothing sent, says learn first');
        const learning = f.learn();
        ok(f.state.busy === 'learn', 'learning');
        setTimeout(() => { bdc.other[29] = true; }, 120);           // output 30 comes on and stays on: not a high beam
        stalk(bdc, 3);
        return learning;
    }).then((done) => {
        ok(done === true && f.state.ready && f.state.outputs.join() === '12,13' && f.layout === 1, 'learned: outputs 12 and 13, layout 2');
        ok(bdc.log.filter((x) => /^2F/.test(x)).slice(0, 3).join('|') === '2F E3 B5 03 0B 01|2F E3 B5 03 00 0B 01|2F E3 B5 00 00 0B 00',
            'layout: the kit\'s (13), then the 2-byte element, handed back');
        ok(bdc.log[bdc.log.length - 1] === '10 01' && bdc.session === 1 && !bdc.held[11], 'learned: back to the default session, nothing held');
        const last = saves[saves.length - 1];
        ok(last.outputs.join() === '12,13' && last.layout === 1 && last.statusDid.join() === '227,185', 'outputs, layout and identifier saved');
        f.setColour('yellow');
        bdc.log = []; bdc.flashes = 0; bdc.pattern = [];
        return f.flash();
    }).then((done) => {
        ok(done === true && bdc.flashes === 3, 'flashed: both high beams on together, 3 times');
        const ctl = bdc.log.filter((x) => /^2F/.test(x));
        ok(ctl.length === 12 && ctl.slice(0, 4).join('|') === '2F E3 B5 03 00 0B 01|2F E3 B5 03 00 0C 01|2F E3 B5 00 00 0B 00|2F E3 B5 00 00 0C 00', 'on, on, back, back, 3 times');
        ok(bdc.log[0] === '10 03' && bdc.log[bdc.log.length - 1] === '10 01' && !bdc.log.some((x) => /^22/.test(x)), 'in one session, no reads');
        ok(!HIGH.some((e) => bdc.held[e]) && bdc.session === 1, 'nothing left held');
        ok(f.state.colour === 'white' && saves[saves.length - 1].colour === 'white' && /should be white/.test(f.note), 'yellow -> white, saved');
        const gaps = bdc.pattern.slice(1).map((t, i) => t - bdc.pattern[i]);
        ok(gaps.every((g) => g >= 35 && g < 200), 'flashes paced by onMs + offMs (' + gaps.join(', ') + ' ms)');
        return f.flash();
    }).then(() => {
        ok(f.state.colour === 'yellow', 'again: white -> yellow');
        f.setColour(null);
        return f.flash();
    }).then(() => {
        ok(f.state.colour === null && bdc.flashes === 9, 'colour not known: flashed, still not known');
    });
});
tests.push(() => {
    // learning with nothing flashed: says so, nothing saved, nothing controlled
    const bdc = fakeBdc(1);
    return flasherFor(bdc, { learnMs: 150 }).then(({ f, saves }) => f.learn().then((done) => {
        ok(done === false && !f.state.ready && /Not learned: nothing went on and off again/.test(f.note) && f.warn, 'nothing flashed: not learned, says why');
        ok(!saves.length && !bdc.log.some((x) => /^(2F|10)/.test(x)), 'nothing saved or controlled');
    }));
});
tests.push(() => {
    // the saved learning: flashes at once; a refusal mid-way hands everything back, the colour unchanged
    const bdc = fakeBdc(1);
    return flasherFor(bdc, { outputs: [12, 13], layout: 1, statusDid: [0xe3, 0xb9], colour: 'yellow' }).then(({ f }) => {
        ok(f.state.ready, 'saved: ready');
        bdc.refuse = { sid: 0x2f, nrc: 0x22 }; bdc.refuseAfter = 5;        // the 6th control request refused
        return f.flash().then((done) => {
            ok(done === false && f.state.colour === 'yellow' && /Not flashed: output 13 on: refused: conditions not correct/.test(f.note), 'refused mid-way: not flashed, colour kept, says why');
            ok(bdc.session === 1 && bdc.log[bdc.log.length - 1] === '10 01' && !f.state.busy, 'session ended, not busy');
            ok(bdc.log.filter((x) => x === '2F E3 B5 00 00 0B 00').length >= 2, 'the output that was on handed back');
        });
    });
});
tests.push(() => {
    // only standing: refused while moving
    const bdc = fakeBdc(1);
    return flasherFor(bdc, { outputs: [12, 13], layout: 1, statusDid: [0xe3, 0xb9], colour: 'yellow' }).then(({ f }) => {
        f.car({ kmh: 40 });
        return f.flash().then((done) => {
            ok(done === false && /standing \(40 km\/h\)/.test(f.note) && !bdc.log.length, 'moving: not flashed, nothing sent');
            return f.learn();
        }).then((done) => ok(done === false && !bdc.log.length, 'moving: no learning either'));
    });
});
tests.push(() => {
    // Auto white: at each engine start, once standing, one flash; not again until the engine has been off
    const bdc = fakeBdc(1);
    return flasherFor(bdc, { outputs: [12, 13], layout: 1, statusDid: [0xe3, 0xb9], colour: 'white', auto: true }).then(({ f }) => {
        f.car({ kmh: 10 });
        f.car({ engine: true });
        ok(f.state.colour === 'yellow', 'engine start with Auto: the module is yellow again');
        return wait(120).then(() => {
            ok(bdc.flashes === 0, 'moving: waits');
            f.car({ kmh: 0 });
            return wait(1500);
        }).then(() => {
            ok(bdc.flashes === 3 && f.state.colour === 'white', 'standing: flashed once, white');
            f.car({ engine: true });
            return wait(100);
        }).then(() => {
            ok(bdc.flashes === 3, 'the engine still running: not again');
            f.car({ engine: false });
            f.car({ engine: true });
            return wait(1300);
        }).then(() => {
            ok(bdc.flashes === 6 && f.state.colour === 'white', 'the next engine start: once more');
            f.setAuto(false);
            f.car({ engine: false }); f.car({ engine: true });
            return wait(150);
        }).then(() => {
            ok(bdc.flashes === 6 && f.state.colour === 'white', 'Auto off: nothing at the engine start, colour as it was');
            return f.stop();
        });
    });
});
tests.push(() => {
    // the app stopping mid-flash: the flash ends, outputs handed back
    const bdc = fakeBdc(1);
    return flasherFor(bdc, { outputs: [12, 13], layout: 1, statusDid: [0xe3, 0xb9], colour: 'yellow', onMs: 40, offMs: 40 }).then(({ f }) => {
        const p = f.flash();
        return wait(60).then(() => f.stop()).then(() => p).then((done) => {
            ok(done === false && !f.state.busy && f.state.colour === 'yellow', 'stopped: not flashed, colour kept');
            ok(!HIGH.some((e) => bdc.held[e]) && bdc.session === 1, 'stopped: nothing held, default session');
        });
    });
});
tests.push(() => {
    // the link refuses any output it wasn't named, and anything but on/back
    const bdc = fakeBdc(1);
    return flasherFor(bdc).then(({ u }) => {
        u.allowControl(11);
        return u.control(0x40, 0x2f, [0xe3, 0xb5, 0x03, 0x00, 0x0c, 0x01]).then(() => ok(false, 'never'), () => ok(true, 'the link allows the named output only'))
            .then(() => u.control(0x40, 0x31, [0x01, 0x00, 0x00])).then(() => ok(false, 'never'), () => ok(true, 'no routines'));
    });
});

/* ---- the screen ---- */
const base = { colour: 'yellow', ready: true, busy: null, auto: false, note: 'Ready', focus: 'dcFlash' };
const main = ui.draw(new ui.Recorder(), base);
ok(main.targets.map((t) => t.key).join() === 'dcFlash,dcLogs,dcLearn,dcFix,dcAuto', 'main screen: the button, Logs, Learn, the correction, Auto');
ok(main.targets.every((t) => t.x >= 0 && t.y >= 0 && t.x + t.w <= ui.W && t.y + t.h <= ui.H) && main.rec.n > 50, 'drawn on screen');
for (let i = 0; i < main.targets.length; i++) for (let j = i + 1; j < main.targets.length; j++) {
    const a = main.targets[i], b = main.targets[j];
    ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, a.key + ' and ' + b.key + ' don\'t overlap');
}
const t0 = main.targets[0];
ok(ui.hit(main.targets, t0.x + t0.w / 2, t0.y + t0.h / 2).key === 'dcFlash' && ui.hit(main.targets, 10, 10) === null, 'hit');
ok(ui.action(base) === 'Switch to white' && ui.action({ colour: 'white', ready: true }) === 'Switch to yellow' && ui.action({ ready: true }) === 'Flash the high beams 3 times'
    && ui.action({ ready: false }) === 'Learn the high beams first' && ui.action({ busy: 'learn', learnLeft: 6 }) === 'Learning... 6 s', 'the button says what it does');
ok(ui.fixLabel({ colour: 'yellow' }) === 'It\'s white' && ui.fixLabel({ colour: 'white' }) === 'It\'s yellow', 'the correction');
ok(ui.draw(new ui.Recorder(), Object.assign({}, base, { colour: 'white' })).rec.words().join() !== main.rec.words().join(), 'the colour drawn');
const logs = [];
for (let i = 0; i < 25; i++) logs.push({ t: Date.UTC(2026, 10, 20, 12, 0, i), level: i === 24 ? 'warn' : 'info', text: 'drl: line ' + i });
const lv = ui.draw(new ui.Recorder(), { view: 'logs', logs: logs, logPage: 0 });
ok(lv.targets.map((t) => t.key).join() === 'dcOlder,dcNewer,dcLogs', 'logs screen: Older, Newer, Close');
ok(/^\d\d:\d\d:\d\d {2}WARN {2}line 24$/.test(ui.logText(logs[24])), 'a log line in the plain list');

/* ---- the package's car-side rules ---- */
const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-app.json'), 'utf8'));
app.modules.forEach((m) => {
    const src = fs.readFileSync(path.join(ROOT, m), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    ok(!/\?\.|\?\?|Object\.fromEntries|recursive:\s*true|\basync\s|\bawait\s|\.\.\.[a-zA-Z]/.test(code), m + ': Node 8 only');
    (src.match(/require\('([^']+)'\)/g) || []).map((r) => r.slice(9, -2)).forEach((r) => {
        ok(r[0] === '.' || app.sdk.indexOf(r) >= 0 || ['events', 'fs', 'path', 'os', 'net', 'zlib'].indexOf(r) >= 0, m + ': may require ' + r);
    });
    if (m !== 'src/uds.js') ok(code.indexOf('serviceID') < 0 && code.indexOf('_request(') < 0, m + ': requests only through uds.js');
});
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'package', 'manifest.json'), 'utf8')).proxies;
const tasu = man['com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu'];
ok(tasu && tasu.methods.join() === 'sendTasuRequest' && tasu.broadcasts.join() === 'sendTasuResponse', 'manifest: the diagnostic link');
ok(man['de.bmw.infotainment.vehicle.CDS'].attributes.statusEngineSpeed2 === 'rs' && man['de.bmw.infotainment.vehicle.Vehicle2'].attributes.statusCarSpeed2 === 'rs'
    && !man['de.bmw.infrastructure.VehicleCondition'], 'manifest: the engine and the speed, nothing else of the car');
const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'package', 'package.json'), 'utf8'));
ok(pj.mguAppStartType === 'autostart' && pj.name === 'ida_drlcolor' && pj.oapAppSettings.loggingId === 'DRLC', 'starts with the head unit, its own log id');
const uiDesc = JSON.parse(fs.readFileSync(path.join(ROOT, 'package/rhmiData/uiDescriptions/ID8/uiDescription.json'), 'utf8'));
const comps = uiDesc.containers[1].components;
const names = Object.keys(comps).map((k) => comps[k].name);
ok(uiDesc.containers[1].name === 'ST_OnlineApps_DrlColour' && ['dcStatus', 'dcFlash', 'dcAuto', 'dcFix', 'dcLearn', 'dcLogs', 'dcOlder', 'dcNewer', 'dcLine0', 'dcLine29'].every((x) => names.indexOf(x) >= 0),
    'screen: status, the buttons, the log rows');
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'ida_drlcolor.js'), 'utf8');
ok(names.every((x) => /^dc(Status|Line\d+)$|_Title$/.test(x) || appSrc.indexOf('\'' + x + '\'') >= 0), 'every row the app knows by name');
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package/rhmiData/application.json'), 'utf8')).application;
const others = ['seatlights', 'lightlog', 'vitals'].map((p) => {
    try { return fs.readFileSync(path.join(ROOT, '..', '..', p, 'app', 'tools', 'gen_package.js'), 'utf8'); } catch (e) { return ''; }
}).join('');
ok([appJson.uuid, appJson.entryPoints[0].uuid, appJson.stringBundleUuid, appJson.resourceBundleUuid].every((u) => others.indexOf(u) < 0), 'its own uuids');

tests.reduce((p, fn) => p.then(fn), Promise.resolve()).then(() => {
    console.log('ok (' + n + ' checks)');
    process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
