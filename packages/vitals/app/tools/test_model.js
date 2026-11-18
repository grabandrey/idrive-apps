'use strict';
/* node packages/vitals/app/tools/test_model.js: settings rows, the service's checks, the car-data decoding, the view */
const assert = require('assert');
const path = require('path');
const m = require('../src/settings_model.js');
const decode = require('../src/decode.js');
const svc = require(path.join(__dirname, '../../tool/vitals.js'));
const view = require(path.join(__dirname, '../../tool/view.js'));
const layout = require(path.join(__dirname, '../../tool/layout.js'));

/* ---- settings rows, through the service's own checks ---- */
const row = (name) => m.ROWS.find((r) => r.name === name);
let s = svc.normalize({});
function press(name) {
    const change = row(name).press(s);
    s = change === 'reset' ? svc.normalize({}) : svc.normalize(Object.assign({}, s, change));
    return s;
}
assert.strictEqual(row('vtTempUnit').value(s), 'Car setting');
assert.strictEqual(press('vtTempUnit').tempUnit, 'C');
assert.strictEqual(press('vtTempUnit').tempUnit, 'F');
assert.strictEqual(row('vtCoolantWarn').value(s), '239 °F');
assert.strictEqual(press('vtTempUnit').tempUnit, 'auto');
assert.strictEqual(press('vtPressUnit').pressUnit, 'bar');
assert.strictEqual(press('vtPressUnit').pressUnit, 'psi');
assert.strictEqual(press('vtPressUnit').pressUnit, 'kPa');
assert.strictEqual(press('vtCoolantWarn').coolantWarn, 120);
for (let i = 0; i < 20; i++) press('vtCoolantWarn');
assert.ok(s.coolantWarn >= 95 && s.coolantWarn <= 130);
assert.strictEqual(press('vtOilWarn').oilWarn, 140);
assert.strictEqual(press('vtGearboxWarn').gearboxWarn, 125);
assert.strictEqual(press('vtAccent').accent, 'lightblue');
assert.strictEqual(row('vtAccent').value(s), 'Light blue');
assert.strictEqual(press('vtPressures').pressures, false);
assert.strictEqual(row('vtPressures').value(s), 'Hidden');
assert.strictEqual(press('vtDemo').demo, true);
press('vtReset');
assert.deepStrictEqual([s.tempUnit, s.pressUnit, s.coolantWarn, s.oilWarn, s.gearboxWarn, s.accent, s.pressures, s.demo],
    ['auto', 'auto', 115, 135, 120, 'blue', true, false]);


/* the service refuses nonsense */
const bad = svc.normalize({ gearboxWarn: 200, tempUnit: 'K', pressUnit: 'atm', coolantWarn: 300, oilWarn: 'hot', accent: 'pink', pressures: 'yes', demo: 1, target: '../x' });
assert.strictEqual(bad.gearboxWarn, 120);
assert.deepStrictEqual([bad.tempUnit, bad.pressUnit, bad.coolantWarn, bad.oilWarn, bad.accent, bad.pressures, bad.demo, bad.target],
    ['auto', 'auto', 115, 135, 'blue', true, false, 'vitals']);
const cd = svc.cleanData({ coolant: 91, oil: 999, tyreT: { FL: 40, FR: 'x' }, tyreP: { FL: 2.4, RR: 50 }, carTemp: 'K', carPress: 'PSI', evil: 1 }, 1000);
assert.deepStrictEqual(cd, { coolant: 91, oil: null, engineAt: 1000, tyreT: { FL: 40, FR: null, RL: null, RR: null },
    tyreP: { FL: 2.4, FR: null, RL: null, RR: null }, tyresAt: 1000, carPress: 'PSI' });

/* ---- decoding the car's raw values ---- */
assert.deepStrictEqual(decode.engine({ temperatureEngineDrive: 138, temperatureEngineOilDrive: 152 }), { coolant: 90, oil: 104 });
assert.deepStrictEqual(decode.engine({ temperatureEngineDrive: 255 }), { coolant: null, oil: null });
assert.strictEqual(decode.gearbox({ valueTemperatureTransmissionOil: 130 }), 82);
assert.strictEqual(decode.gearbox({ valueTemperatureTransmissionOil: 255 }), null);
assert.strictEqual(decode.gearbox({}), null);
assert.deepStrictEqual(svc.cleanData({ gearbox: 82 }, 5), { gearbox: 82, gearboxAt: 5 });
assert.deepStrictEqual(svc.cleanData({ gearbox: 900 }, 5), { gearbox: null, gearboxAt: 5 });
assert.deepStrictEqual(decode.units({ unitOfMeasurementTemperature: 2, unitOfMeasurementAirPressure: 3 }), { carTemp: 'F', carPress: 'PSI' });
assert.deepStrictEqual(decode.units({ unitOfMeasurementTemperature: 'CELSIUS', unitOfMeasurementAirPressure: 'BAR' }), { carTemp: 'C', carPress: 'BAR' });
const tt = decode.tyreTemps({ actualValueTemperatureTyreFLH: 80, actualValueTemperatureTyreFRH: 65535, actualValueTemperatureTyreRLH: 140 }, 'F');
assert.ok(Math.abs(tt.FL - 4.44) < 0.01 && tt.FR === null && Math.abs(tt.RL - 37.78) < 0.01 && tt.RR === null, JSON.stringify(tt));
assert.strictEqual(decode.tyreTemps({ actualValueTemperatureTyreFLH: 80 }, 'C').FL, 40);
const tp = decode.tyrePressures({ actualValuePressureTyreFLH: 24, actualValuePressureTyreFRH: 350, actualValuePressureTyreRLH: 2400, actualValuePressureTyreRRH: 65535 }, null);
assert.ok(Math.abs(tp.FL - 2.4) < 1e-9 && Math.abs(tp.FR - 2.413) < 0.001 && Math.abs(tp.RL - 2.4) < 1e-9 && tp.RR === null, JSON.stringify(tp));
assert.ok(Math.abs(decode.tyrePressures({ actualValuePressureTyreFLH: 2400 }, 'KPA').FL - 2.4) < 1e-9);

/* ---- the view ---- */
const now = 100000;
const data = { coolant: 120, oil: 100, gearbox: 125, gearboxAt: now, tyreT: { FL: 10, FR: 50, RL: 80, RR: 99 }, tyreP: { FL: 2.4, FR: 2.4, RL: 2.6, RR: 2.6 },
    carTemp: 'C', carPress: 'BAR', engineAt: now, tyresAt: now };
let v = view.compose(svc.normalize({}), data, now);
const field = (id) => v.fields.find((f) => f.id === id).text;
assert.strictEqual(field('coolant.value'), '120');
assert.deepStrictEqual(v.uniforms.u_cool.slice(1), [1, 1], 'coolant over 115: warned');
assert.deepStrictEqual(v.uniforms.u_oil.slice(1), [1, 0]);
assert.deepStrictEqual(v.uniforms.u_gbox.slice(1), [1, 1], 'gearbox over 120: warned');
assert.strictEqual(field('gearbox.value'), '125');
const fieldOf = (id) => v.fields.find((f) => f.id === id);
assert.deepStrictEqual([fieldOf('tyre.FL.t').text, fieldOf('tyre.FL.t').suffix.text], ['10', '°C'], 'the unit next to the tyre');
assert.deepStrictEqual([fieldOf('tyre.RR.p').text, fieldOf('tyre.RR.p').suffix.text], ['2.6', 'bar']);
assert.strictEqual(fieldOf('tyre.FL.t').align, 'right'); assert.strictEqual(fieldOf('tyre.FR.t').align, 'left');
assert.strictEqual(v.uniforms.u_tFL[2], 0.96, 'cold tyre blue');
assert.strictEqual(v.uniforms.u_tRR[0], 0.95, 'hot tyre red');
assert.strictEqual(field('tyre.FL.p'), '2.4');
v = view.compose(svc.normalize({ tempUnit: 'F', pressUnit: 'psi' }), data, now);
assert.strictEqual(field('coolant.value'), '248');
assert.strictEqual(field('tyre.FL.p'), '35');
assert.strictEqual(v.fields.find((f) => f.id === 'tyre.FL.p').suffix.text, 'psi');
assert.strictEqual(v.fields.find((f) => f.id === 'tyre.FL.t').suffix.text, '°F');
v = view.compose(svc.normalize({}), data, now + 20000);
assert.strictEqual(field('coolant.value'), '– –', 'stale engine data shows dashes');
assert.strictEqual(field('tyre.FL.t'), '10', 'tyre data lasts longer');
assert.strictEqual(field('gearbox.value'), '125', 'gearbox data lasts a minute');
v = view.compose(svc.normalize({}), data, now + 70000);
assert.strictEqual(field('gearbox.value'), '– –');

/* the text: a unit drawn right after its number, in one box */
const { TextCanvas } = require(path.join(__dirname, '../../tool/text.js'));
const FONT = require(path.join(__dirname, '../../tool/font.js'));
const tc = new TextCanvas(layout.W, layout.H, FONT);
const plain = tc.draw('value', 300, 400, '41', 'right', 0);
tc.px.fill(0);
const withUnit = tc.draw('value', 300, 400, '41', 'right', 0, { style: 'unit', text: '°C', gap: 4, dim: 0.6 });
assert.ok(withUnit.x < plain.x && withUnit.x + withUnit.w <= 300 + 1, 'right-aligned as one: the number moves left for its unit');
const peak = (x0, x1) => { let m = 0; for (let y = 360; y < 410; y++) for (let x = x0; x < x1; x++) m = Math.max(m, tc.px[y * layout.W + x]); return m; };
const split = withUnit.x + plain.w + 2;          // the number on the left of it, the unit on the right
assert.strictEqual(peak(withUnit.x, split), 255, 'the number at full strength');
assert.ok(peak(split, 302) > 0 && peak(split, 302) <= 153, 'the unit fainter (dim 0.6)');

console.log('vitals model, decoding and view: ok');
