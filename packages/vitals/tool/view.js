/*
 * Vitals: what the widget shows for given settings and car data. Pure, no I/O:
 * compose() returns the shader's uniforms and the text fields (view -> pixels is text.js).
 *
 * Car data, as the Vitals app sends it (all metric, null = not known):
 *   { coolant: C, oil: C, tyreT: { FL, FR, RL, RR } C, tyreP: { FL, ... } bar,
 *     carTemp: 'C' | 'F', carPress: 'BAR' | 'KPA' | 'PSI', engineAt: ms, tyresAt: ms }
 *
 * Works in Node (module.exports) and in a browser (window.VITALS_VIEW).
 */
(function (root) {
    var L = typeof module !== 'undefined' && module.exports ? require('./layout.js') : root.VITALS_LAYOUT;

    var ENGINE_STALE_MS = 15000;     // CDS sends often; a quiet one means the car is off
    var TYRES_STALE_MS = 180000;     // TPMS answers every few seconds at best, and only while rolling on some cars

    var ACCENTS = {
        blue:      { a: [0.02, 0.36, 0.80], b: [0.33, 0.67, 0.96] },
        lightblue: { a: [0.16, 0.55, 0.92], b: [0.62, 0.84, 1.00] },
        white:     { a: [0.55, 0.57, 0.62], b: [0.96, 0.96, 0.98] },
    };
    var RED = [0.90, 0.17, 0.12];

    /* tyre temperature bands, C: cold, normal, warm, hot */
    function tyreColour(c) {
        if (c === null || c === undefined) return [0.24, 0.25, 0.28, 0];
        if (c < 20) return [0.30, 0.58, 0.96, 1];
        if (c < 75) return [0.24, 0.80, 0.50, 1];
        if (c < 95) return [1.00, 0.62, 0.16, 1];
        return [0.95, 0.20, 0.14, 1];
    }

    function num(v) { return typeof v === 'number' && isFinite(v); }
    function tempUnit(s, d) { return s.tempUnit === 'C' || s.tempUnit === 'F' ? s.tempUnit : (d && d.carTemp === 'F' ? 'F' : 'C'); }
    function pressUnit(s, d) {
        if (s.pressUnit === 'bar' || s.pressUnit === 'psi' || s.pressUnit === 'kPa') return s.pressUnit;
        var c = d && d.carPress;
        return c === 'PSI' ? 'psi' : c === 'KPA' ? 'kPa' : 'bar';
    }
    function temp(c, u) { return u === 'F' ? c * 9 / 5 + 32 : c; }
    function fmtTemp(c, u) { return num(c) ? String(Math.round(temp(c, u))) : '– –'; }
    function fmtPress(bar, u) {
        if (!num(bar)) return '–';
        if (u === 'psi') return String(Math.round(bar * 14.5038));
        if (u === 'kPa') return String(Math.round(bar * 100));
        return bar.toFixed(1);
    }
    function frac(c) {
        if (!num(c)) return 0;
        return Math.max(0, Math.min(1, (c - L.arc.min) / (L.arc.max - L.arc.min)));
    }

    /* demo data: a warm-up and a drive, so every colour shows */
    function demoData(now) {
        var t = (now / 1000) % 60;
        var warm = Math.min(1, t / 25);
        var tyre = function (k, o) { return 18 + 70 * warm + 8 * Math.sin(now / 3000 + o) + k; };
        return {
            coolant: 40 + 68 * warm + 3 * Math.sin(now / 4000),
            oil: 35 + 82 * warm + (t > 40 ? 22 * (t - 40) / 20 : 0),
            tyreT: { FL: tyre(4, 0), FR: tyre(9, 1), RL: tyre(-2, 2), RR: tyre(1, 3) },
            tyreP: { FL: 2.3 + 0.3 * warm, FR: 2.3 + 0.32 * warm, RL: 2.5 + 0.3 * warm, RR: 2.5 + 0.28 * warm },
            carTemp: 'C', carPress: 'BAR', engineAt: now, tyresAt: now,
        };
    }

    /* settings + data -> { uniforms: { name: [numbers] }, fields: [text fields] } */
    function compose(s, data, now) {
        var d = s.demo ? demoData(now) : (data || {});
        var engineOk = num(d.engineAt) && now - d.engineAt < ENGINE_STALE_MS;
        var tyresOk = num(d.tyresAt) && now - d.tyresAt < TYRES_STALE_MS;
        var cool = engineOk && num(d.coolant) ? d.coolant : null;
        var oil = engineOk && num(d.oil) ? d.oil : null;
        var tu = tempUnit(s, d), pu = pressUnit(s, d);
        var acc = ACCENTS[s.accent] || ACCENTS.blue;
        var warnC = cool !== null && cool >= s.coolantWarn, warnO = oil !== null && oil >= s.oilWarn;

        var u = {
            u_size: [L.W, L.H],
            u_bg: [s.backdrop ? 1 : 0],
            u_accA: acc.a, u_accB: acc.b,
            u_cool: [frac(cool), cool === null ? 0 : 1, warnC ? 1 : 0],
            u_oil: [frac(oil), oil === null ? 0 : 1, warnO ? 1 : 0],
            u_warnAt: [frac(s.coolantWarn), frac(s.oilWarn)],
        };
        L.corners.forEach(function (c) {
            var t = tyresOk && d.tyreT && num(d.tyreT[c.key]) ? d.tyreT[c.key] : null;
            u['u_t' + c.key] = tyreColour(t);
        });

        var f = [];
        var field = function (id, tex, style, x, y, align, text, spacing) {
            f.push({ id: id, tex: tex, style: style, x: x, y: y, align: align, text: text, spacing: spacing || 0 });
        };
        L.gauges.forEach(function (g) {
            var v = g.key === 'coolant' ? cool : oil;
            field(g.key + '.value', 'V', 'value', g.cx, g.cy + 22, 'center', fmtTemp(v, tu));
            field(g.key + '.unit', 'L', 'unit', g.cx, g.cy + 52, 'center', '°' + tu);
            field(g.key + '.label', 'L', 'label', g.cx, g.cy + 96, 'center', g.label, 2.2);
            var lo = L.arc.min, hi = L.arc.max;
            field(g.key + '.min', 'L', 'scale', g.cx - 84, g.cy + 80, 'center', String(Math.round(temp(lo, tu))));
            field(g.key + '.max', 'L', 'scale', g.cx + 84, g.cy + 80, 'center', String(Math.round(temp(hi, tu))));
        });
        field('tyres.head', 'L', 'label', L.divider.x0, L.tyreHead.y, 'left', 'TYRES', 2.2);
        field('tyres.units', 'L', 'label', L.divider.x1, L.tyreHead.y, 'right',
            (s.pressures ? '°' + tu + '  ·  ' + pu.toUpperCase() : '°' + tu), 1.2);
        L.corners.forEach(function (c) {
            var left = c.side === 'left';
            var x = left ? L.tyreText.left : L.tyreText.right, al = left ? 'right' : 'left';
            var t = tyresOk && d.tyreT ? d.tyreT[c.key] : null;
            var p = tyresOk && d.tyreP ? d.tyreP[c.key] : null;
            field('tyre.' + c.key + '.t', 'V', 'tyre', x, c.y + (s.pressures ? 6 : 14), al, fmtTemp(t, tu));
            field('tyre.' + c.key + '.p', 'V', 'unit', x, c.y + 34, al, s.pressures ? fmtPress(p, pu) : '');
        });
        return { uniforms: u, fields: f, demo: !!s.demo, engineOk: engineOk, tyresOk: tyresOk };
    }

    var API = { compose: compose, demoData: demoData, tyreColour: tyreColour, fmtTemp: fmtTemp, fmtPress: fmtPress,
        frac: frac, ACCENTS: ACCENTS, RED: RED, ENGINE_STALE_MS: ENGINE_STALE_MS, TYRES_STALE_MS: TYRES_STALE_MS };
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
    else root.VITALS_VIEW = API;
})(this);
