'use strict';
/* node packages/seatlights/app/tools/test_seatlights.js: the switch against a fake body controller, the copies of
 * Light Logger's modules, the screen, and the package's car-side rules (Node 8, the manifest) */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const uds = require('../src/uds.js');
const { SeatLight } = require('../src/seat_light.js');
const ui = require('../src/ui.js');

const ROOT = path.join(__dirname, '..');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const log = { info: () => {}, warn: () => {}, error: () => {} };

/* ---- the copies stay Light Logger's ---- */
['uds.js', 'someip_link.js', 'lamps.js', 'gpu.js', 'ui_font.js'].forEach((f) => {
    const mine = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    const theirs = fs.readFileSync(path.join(ROOT, '..', '..', 'lightlog', 'app', 'src', f), 'utf8');
    ok(mine === theirs, f + ' is the same as Light Logger\'s (copy it again: cp packages/lightlog/app/src/' + f + ' packages/seatlights/app/src/)');
});

/* ---- a fake G87 body controller: lamp output 45 (element 44) on layout 2 (a 2-byte element), 13 to other lengths ---- */
function fakeLink(answer) {
    const l = { onFrame: null };
    l.open = (iface, inst, o) => { l.onFrame = o.broadcasts.sendTasuResponse; return Promise.resolve(); };
    l.call = (iface, method, req) => {
        answer(req).forEach((f, i) => setTimeout(() => l.onFrame({ udsResponse: [0, 0, 0, 0, 0, 0, f.ecu, 0, 0].concat(f.uds) }), 2 * (i + 1)));
        return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
    };
    return l;
}
function fakeBdc(layoutIndex) {
    // expireMs: like the car, a hold that isn't asked for again within that time lets go
    const b = { session: 1, held: null, carLogo: false, log: [], refuse: null, dropSession: false, letGo: false, expireMs: 0, heldAt: 0, offSeen: 0 };
    const expired = () => b.expireMs && b.held === 44 && Date.now() - b.heldAt > b.expireMs;
    const want = uds.FORMATS[layoutIndex];
    b.answer = (req) => {
        const d = Array.from(Buffer.from(req.udsData)), sid = req.serviceID;
        b.log.push([sid].concat(d).map((x) => (x < 16 ? '0' : '') + x.toString(16).toUpperCase()).join(' '));
        const out = (u) => [{ ecu: 0x40, uds: u }];
        if (sid === 0x22) {
            if (d[0] !== 0xe3 || d[1] !== 0xb9) return out([0x7f, 0x22, 0x31]);
            const o = [0x62, 0xe3, 0xb9];
            const lit = (b.held === 44 && !b.letGo && !expired()) || b.carLogo;
            if (b.held === 44 && !lit) b.offSeen++;
            for (let i = 0; i < 50; i++) o.push(i === 44 ? (lit ? 1 : 0) : i === 6 ? 1 : 0);
            return out(o);
        }
        if (b.refuse && b.refuse.sid === sid) return out([0x7f, sid, b.refuse.nrc]);
        if (sid === 0x10) { b.session = d[0]; if (d[0] === 1) b.held = null; return out([0x50, d[0]]); }
        if (sid === 0x3e) return b.dropSession || b.session !== 3 ? out([0x7f, 0x3e, 0x7f]) : out([0x7e, 0x00]);
        if (sid === 0x2f) {
            if (b.dropSession) b.session = 1;
            if (b.session !== 3) return out([0x7f, 0x2f, 0x7f]);
            const rest = d.slice(2);
            if (rest.length !== want.on(44).length) return out([0x7f, 0x2f, 0x13]);
            if (rest.join() === want.on(44).join()) { b.held = 44; b.letGo = false; b.heldAt = Date.now(); } else if (rest.join() === want.back(44).join()) b.held = null;
            else return out([0x7f, 0x2f, 0x31]);
            return out([0x6f, d[0], d[1]].concat(rest.slice(0, 2)));
        }
        return out([0x7f, sid, 0x11]);
    };
    return b;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function lightFor(bdc, opts) {
    const u = new uds.Uds(fakeLink(bdc.answer), log);
    const s = new SeatLight(Object.assign({ uds: u, log, refreshMs: 15, checkMs: 25, settleMs: 5 }, opts || {}));
    const saves = [];
    s.on('save', (x) => saves.push(JSON.parse(JSON.stringify(x))));
    if (!opts || !opts.carOff) s.car({ engine: true });            // the engine running, unless the test says otherwise
    return u.init().then(() => ({ s: s, u: u, saves: saves }));
}

const tests = [];
tests.push(() => {
    const bdc = fakeBdc(1);
    let s, u, saves;
    return lightFor(bdc).then((x) => {
        s = x.s; u = x.u; saves = x.saves;
        ok(s.element === 44 && s.layout === null, 'output 45 is element 44, no layout yet');
        return u.control(0x40, 0x2f, [0xe3, 0xb5, 0x03, 0x00, 0x2d, 0x01]).then(() => ok(false, 'never'), () => ok(true, 'the link allows output 45 only'));
    }).then(() => s.setOn(true)).then(() => {
        const ctl = bdc.log.filter((x) => /^2F/.test(x));
        ok(s.state.on && s.holding && bdc.held === 44 && s.layout === 1, 'ON: layout 2 found, output 45 held');
        ok(ctl.join('|') === '2F E3 B5 03 2C 01|2F E3 B5 03 00 2C 01', 'the kit\'s layout (13), then the 2-byte element');
        const last = saves[saves.length - 1];
        ok(last.on === true && last.layout === 1 && last.statusDid.join() === '227,185', 'switch, layout and identifier saved');
        return wait(60);
    }).then(() => {
        ok(bdc.log.filter((x) => x === '2F E3 B5 03 00 2C 01').length >= 3 && s.holding, 'kept: the hold renewed, no timer');
        // the car lets go of it (output reads off twice): asked again
        bdc.letGo = true; bdc.log = [];
        return wait(90);
    }).then(() => {
        ok(!bdc.letGo && s.holding && bdc.log.indexOf('2F E3 B5 03 00 2C 01') >= 0, 'the car lets go: taken back (the renewal, or the check)');
        // the session lost: asked again
        bdc.dropSession = true; bdc.log = [];
        return wait(20).then(() => { bdc.dropSession = false; return wait(80); });
    }).then(() => {
        ok(bdc.log.indexOf('10 03') >= 0 && s.holding && bdc.held === 44, 'session lost: asked again');
        return s.setOn(false);
    }).then(() => {
        ok(!s.state.on && !s.holding && bdc.held === null && bdc.session === 1, 'OFF: handed back, default session');
        ok(bdc.log.slice(-2).join('|') === '2F E3 B5 00 00 2C 00|10 01', 'handed back with its layout');
        ok(saves[saves.length - 1].on === false && saves[saves.length - 1].layout === 1, 'OFF saved, layout kept');
        bdc.log = [];
        return wait(80);
    }).then(() => {
        ok(!bdc.log.some((x) => /^(2F|10|3E)/.test(x)), 'OFF: nothing sent any more');
        return s.setOn(true);
    }).then(() => {
        ok(s.holding && bdc.log.filter((x) => /^2F/.test(x)).join() === '2F E3 B5 03 00 2C 01', 'ON again: the saved layout, no search');
        return s.stop();
    }).then(() => {
        ok(bdc.held === null && bdc.session === 1 && s.state.on === true, 'the app stopping: handed back, the switch stays ON for next time');
    });
});
tests.push(() => {
    // the car's ~10 s limit on a hold (60 ms here): renewed in time, it never reads off
    const bdc = fakeBdc(1);
    bdc.expireMs = 60;
    return lightFor(bdc, { layout: 1, statusDid: [0xe3, 0xb9] }).then(({ s }) => s.setOn(true).then(() => wait(400)).then(() => {
        ok(s.holding && bdc.offSeen === 0 && !s.warn, 'a hold the car ends after a while: renewed before it does, never off');
        return s.stop();
    }));
});
tests.push(() => {
    // renewing too slowly for the car's limit: each lapse is caught and logged with how long it held
    const bdc = fakeBdc(1);
    bdc.expireMs = 40;
    const notes = [];
    return lightFor(bdc, { layout: 1, statusDid: [0xe3, 0xb9], refreshMs: 500 }).then(({ s }) => {
        s.on('change', () => notes.push(s.note));
        return s.setOn(true).then(() => wait(200)).then(() => {
            ok(/Went off after \d+(\.\d)? s held: asking again/.test(notes.join('|')) && bdc.log.filter((x) => /^2F E3 B5 03/.test(x)).length >= 2,
                'a lapse: logged with how long it held, asked again');
            return s.stop();
        });
    });
});
tests.push(() => {
    // the car off and locked: handed back; held again at the next start
    const bdc = fakeBdc(1);
    let clock = 1e6;
    return lightFor(bdc, { layout: 1, statusDid: [0xe3, 0xb9], carOff: true, engineOffMs: 1000, now: () => clock }).then(({ s, saves }) => s.setOn(true).then(() => {
        ok(s.state.on && !s.holding && !bdc.log.some((x) => /^(2F|10)/.test(x)) && /waiting for the car/.test(s.note), 'ON before the engine starts: nothing held (the car lights them itself)');
        s.car({ engine: false });                                       // the first reading: off (the car parked)
        return wait(60);
    }).then(() => {
        ok(!s.holding && !bdc.log.some((x) => /^(2F|10)/.test(x)), 'the engine off from the start: nothing held (no start-stop grace)');
        s.car({ engine: true });
        return wait(40);
    }).then(() => {
        ok(s.holding && bdc.held === 44, 'engine running: held');
        // auto start-stop: a short stop keeps it
        s.car({ engine: false }); clock += 500; s.car({ engine: false });
        return wait(40);
    }).then(() => {
        ok(s.holding && bdc.held === 44, 'a short engine stop (start-stop): still held');
        clock += 600;                                                   // off for longer than engineOffMs
        return wait(60);
    }).then(() => {
        ok(!s.holding && bdc.held === null && bdc.session === 1 && s.state.on, 'engine off a while: handed back, the switch stays ON');
        ok(/back on when you start the car/.test(s.note) && saves[saves.length - 1].on === true, 'says so, ON kept');
        bdc.log = [];
        return wait(60);
    }).then(() => {
        ok(!bdc.log.length, 'the car off: nothing sent, not even reads');
        s.car({ engine: true });
        return wait(40);
    }).then(() => {
        ok(s.holding && bdc.held === 44, 'the next start: held again');
        // the head unit powering down with the engine off: let go at once
        s.car({ engine: false }); s.car({ power: 'STANDBY' });
        return wait(40);
    }).then(() => {
        ok(!s.holding && bdc.held === null && bdc.session === 1, 'head unit powering down, engine off: handed back at once');
        s.car({ power: 'ON' }); s.car({ engine: true });
        return wait(40);
    }).then(() => {
        ok(s.holding, 'on again');
        s.car({ power: 'STANDBY' });
        return wait(40);
    }).then(() => {
        ok(s.holding, 'a power state with the engine running never lets go');
        return s.stop();
    }));
});
tests.push(() => {
    // the saved layout and identifier from an earlier start: held at once
    const bdc = fakeBdc(1);
    return lightFor(bdc, { layout: 1, statusDid: [0xe3, 0xb9] }).then(({ s }) => s.setOn(true).then(() => {
        ok(s.holding && bdc.log.filter((x) => /^2F/.test(x)).length === 1, 'saved layout: one request');
        return s.stop();
    }));
});
tests.push(() => {
    // the first time with the logos lit (engine not started): waits, then finds the layout once they are dark
    const bdc = fakeBdc(1);
    bdc.carLogo = true;
    return lightFor(bdc).then(({ s }) => s.setOn(true).then(() => {
        ok(!s.holding && /waiting for the logos to go dark/.test(s.note) && !bdc.log.some((x) => /^2F/.test(x)), 'first time, logos lit: waits');
        bdc.carLogo = false;
        return wait(100);
    }).then(() => {
        ok(s.holding && s.layout === 1, 'logos dark: layout found, held');
        return s.stop();
    }));
});
tests.push(() => {
    // refusals: gives up after 5, the switch goes OFF and says why
    const bdc = fakeBdc(1);
    return lightFor(bdc, { layout: 1, statusDid: [0xe3, 0xb9] }).then(({ s, saves }) => {
        bdc.refuse = { sid: 0x2f, nrc: 0x22 };
        return s.setOn(true).then(() => wait(250)).then(() => {
            ok(!s.state.on && !s.holding && /Gave up after 5/.test(s.note) && /conditions not correct/.test(s.note), 'gives up after 5, says why');
            ok(saves[saves.length - 1].on === false, 'the switch saved OFF');
            ok(bdc.log.filter((x) => /^2F E3 B5 03/.test(x)).length === 5, 'exactly 5 tries');
        });
    });
});
tests.push(() => {
    // none of the layouts: the switch goes OFF, nothing held
    const bdc = fakeBdc(0);
    bdc.refuse = { sid: 0x2f, nrc: 0x13 };
    return lightFor(bdc).then(({ s }) => s.setOn(true).then(() => {
        ok(!s.state.on && /none of the 4 layouts/.test(s.note) && bdc.session === 1, 'no layout: OFF, session ended');
    }));
});

/* ---- the screen ---- */
const on = ui.draw(new ui.Recorder(), { on: true, holding: true, note: 'On', output: 45, layout: 1, focus: 'slSwitch' });
ok(on.targets.length === 1 && on.targets[0].key === 'slSwitch', 'the switch is the one target');
const t0 = on.targets[0];
ok(ui.hit(on.targets, t0.x + t0.w / 2, t0.y + t0.h / 2).key === 'slSwitch' && ui.hit(on.targets, 10, 10) === null, 'hit');
ok(t0.x >= 0 && t0.y >= 0 && t0.x + t0.w <= ui.W && t0.y + t0.h <= ui.H && on.rec.n > 50, 'drawn on screen');
ok(ui.draw(new ui.Recorder(), { on: false, holding: false, note: 'Off', output: 45, layout: null }).rec.n > 50, 'off draws too');

/* ---- the package's car-side rules ---- */
const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-app.json'), 'utf8'));
app.modules.forEach((m) => {
    const src = fs.readFileSync(path.join(ROOT, m), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    ok(!/\?\.|\?\?|Object\.fromEntries|recursive:\s*true|\basync\s|\bawait\s|\.\.\.[a-zA-Z]/.test(code), m + ': Node 8 only');
    (src.match(/require\('([^']+)'\)/g) || []).map((r) => r.slice(9, -2)).forEach((r) => {
        ok(r[0] === '.' || app.sdk.indexOf(r) >= 0 || ['events', 'fs', 'path', 'os', 'net'].indexOf(r) >= 0, m + ': may require ' + r);
    });
    if (m !== 'src/uds.js') ok(code.indexOf('serviceID') < 0 && code.indexOf('_request(') < 0, m + ': requests only through uds.js');
});
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'package', 'manifest.json'), 'utf8')).proxies;
const tasu = man['com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu'];
ok(tasu && tasu.methods.join() === 'sendTasuRequest' && tasu.broadcasts.join() === 'sendTasuResponse', 'manifest: the diagnostic link');
ok(man['de.bmw.infotainment.vehicle.CDS'].attributes.statusEngineSpeed2 === 'rs' && man['de.bmw.infotainment.lifecycle.lifecycle.Lifecycle'].attributes.powerStateDetailed === 'rs'
    && !man['de.bmw.infotainment.vehicle.Vehicle2'], 'manifest: the engine and the power state, nothing else of the car');
const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'package', 'package.json'), 'utf8'));
ok(pj.mguAppStartType === 'autostart' && pj.name === 'ida_seatlights', 'starts with the head unit');
const uiDesc = JSON.parse(fs.readFileSync(path.join(ROOT, 'package/rhmiData/uiDescriptions/ID8/uiDescription.json'), 'utf8'));
const comps = uiDesc.containers[1].components;
const names = Object.keys(comps).map((k) => comps[k].name);
ok(uiDesc.containers[1].name === 'ST_OnlineApps_SeatLights' && names.indexOf('slStatus') >= 0 && names.indexOf('slSwitch') >= 0, 'screen: state, status, switch');

tests.reduce((p, fn) => p.then(fn), Promise.resolve()).then(() => {
    console.log('ok (' + n + ' checks)');
    process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
