/*
 * Vitals: the fragment shader cluster-render runs for the widget (an `effect` layer,
 * GLSL ES 1.00, `varying vec2 v_uv` with its origin top-left). It draws every shape:
 * the two temperature arcs, the divider, the car and its tyres; the text comes from two
 * 8-bit textures text.js fills (u_texV: values in white, u_texL: labels in grey).
 * The geometry comes from layout.js, written into the source as constants.
 *
 * Uniforms (view.js): u_size, u_bg, u_accA/u_accB (the fill's two ends), u_cool/u_oil
 * (fraction, valid, warn), u_warnAt (the warn points as fractions), u_tFL..u_tRR (tyre
 * colour rgb + valid), samplers u_texV and u_texL.
 *
 * Works in Node (module.exports) and in a browser (window.VITALS_SHADER).
 */
(function (root) {
    var L = typeof module !== 'undefined' && module.exports ? require('./layout.js') : root.VITALS_LAYOUT;

    function f(n) { var s = String(n); return s.indexOf('.') < 0 && s.indexOf('e') < 0 ? s + '.0' : s; }
    function v2(x, y) { return 'vec2(' + f(x) + ', ' + f(y) + ')'; }

    function build() {
        var A = L.arc, C = L.car, T = L.tyre, D = L.divider;
        var a0 = A.a0 * Math.PI / 180, sw = A.sweep * Math.PI / 180;
        var gauge = function (g, u) {
            return '    gauge(p, ' + v2(g.cx, g.cy) + ', ' + u + ', u_warnAt.' + (g.key === 'coolant' ? 'x' : 'y') + ', col, a);';
        };
        var tyre = function (c) {
            return '    tyre(p, ' + v2(c.x, c.y) + ', u_t' + c.key + ', col, a);';
        };
        return [
            'precision mediump float;',
            'varying vec2 v_uv;',
            'uniform vec2 u_size;',
            'uniform float u_bg;',
            'uniform vec3 u_accA;',
            'uniform vec3 u_accB;',
            'uniform vec3 u_cool;',
            'uniform vec3 u_oil;',
            'uniform vec2 u_warnAt;',
            'uniform vec4 u_tFL;',
            'uniform vec4 u_tFR;',
            'uniform vec4 u_tRL;',
            'uniform vec4 u_tRR;',
            'uniform sampler2D u_texV;',
            'uniform sampler2D u_texL;',
            '',
            'const float PI = 3.14159265;',
            'const float R = ' + f(A.r) + ';',
            'const float HW = ' + f(A.width / 2) + ';',
            'const float A0 = ' + f(a0) + ';',
            'const float SW = ' + f(sw) + ';',
            'const vec3 TRACK = vec3(0.155, 0.165, 0.185);',
            'const vec3 RED = vec3(0.90, 0.17, 0.12);',
            '',
            'float aa(float d) { return 1.0 - smoothstep(-0.75, 0.75, d); }',
            'void over(inout vec3 col, inout float a, vec3 c, float m) { col = mix(col, c, m); a = max(a, m); }',
            '',
            '/* 0..1 along the arc, > 1 in its open part */',
            'float arcT(vec2 v) { return mod(atan(v.y, v.x) - A0 + 4.0 * PI, 2.0 * PI) / SW; }',
            '/* distance to the arc from 0 to f, with round ends */',
            'float sdArc(vec2 v, float t, float f, float r, float hw) {',
            '    if (t <= f) return abs(length(v) - r) - hw;',
            '    vec2 e0 = r * vec2(cos(A0), sin(A0));',
            '    vec2 e1 = r * vec2(cos(A0 + SW * f), sin(A0 + SW * f));',
            '    return min(length(v - e0), length(v - e1)) - hw;',
            '}',
            'float sdBox(vec2 p, vec2 b, float r) {',
            '    vec2 q = abs(p) - b + r;',
            '    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;',
            '}',
            '',
            '/* a temperature arc: track, fill (accent, red past the warn point when warned), warn tick */',
            'void gauge(vec2 p, vec2 c, vec3 g, float warnAt, inout vec3 col, inout float a) {',
            '    vec2 v = p - c;',
            '    if (abs(v.x) > R + 24.0 || abs(v.y) > R + 24.0) return;',
            '    float t = arcT(v);',
            '    over(col, a, TRACK, aa(sdArc(v, t, 1.0, R, HW)));',
            '    if (g.y > 0.5 && g.x > 0.004) {',
            '        float tt = clamp(t / max(g.x, 0.001), 0.0, 1.0);',
            '        vec3 fill = g.z > 0.5 ? RED : mix(u_accA, u_accB, tt);',
            '        float d = sdArc(v, t, g.x, R, HW);',
            '        over(col, a, fill, aa(d));',
            '        /* a soft glow round the fill end */',
            '        vec2 e = R * vec2(cos(A0 + SW * g.x), sin(A0 + SW * g.x));',
            '        float glow = exp(-max(length(v - e) - HW, 0.0) / 7.0) * 0.45 * (1.0 - aa(d));',
            '        over(col, a, fill, glow);',
            '    }',
            '    /* the warn zone: a thin line outside the track from the warn point to the end */',
            '    if (t >= warnAt && t <= 1.0) over(col, a, RED * 0.85, aa(abs(length(v) - (R + 12.0)) - 1.0));',
            '    /* the warn point: a short tick across the track */',
            '    vec2 w = vec2(cos(A0 + SW * warnAt), sin(A0 + SW * warnAt));',
            '    float along = dot(v, w), across = abs(v.x * w.y - v.y * w.x);',
            '    over(col, a, RED, aa(max(across - 1.0, abs(along - (R + 4.0)) - 10.0)) * 0.9);',
            '}',
            '',
            '/* a tyre seen from above, filled with its temperature colour */',
            'void tyre(vec2 p, vec2 c, vec4 t, inout vec3 col, inout float a) {',
            '    vec2 q = p - c;',
            '    float d = sdBox(q, ' + v2(T.hw, T.hh) + ', ' + f(T.r) + ');',
            '    vec3 fill = t.w > 0.5 ? t.rgb * (0.78 + 0.22 * smoothstep(' + f(T.hh) + ', -' + f(T.hh) + ', q.y)) : vec3(0.13, 0.135, 0.15);',
            '    over(col, a, fill, aa(d));',
            '    over(col, a, t.w > 0.5 ? t.rgb : vec3(0.32, 0.33, 0.36), aa(abs(d) - 0.9) * 0.9);',
            '    /* tread lines */',
            '    float tread = step(0.5, fract((q.y + 100.0) / 6.0)) * aa(d + 2.5) * 0.12;',
            '    over(col, a, vec3(0.0), tread);',
            '}',
            '',
            'void main() {',
            '    vec2 p = v_uv * u_size;',
            '    vec3 col = vec3(0.0);',
            '    float a = 0.0;',
            '',
            '    /* the backdrop: near black, fading out at the edges into the cluster */',
            '    if (u_bg > 0.5) {',
            '        vec2 e = min(p, u_size - p);',
            '        float edge = smoothstep(0.0, 36.0, min(e.x, e.y));',
            '        col = mix(vec3(0.035, 0.038, 0.045), vec3(0.012, 0.013, 0.016), v_uv.y);',
            '        a = 0.93 * edge;',
            '    }',
            '',
            gauge(L.gauges[0], 'u_cool'),
            gauge(L.gauges[1], 'u_oil'),
            '',
            '    /* the divider, fading at its ends */',
            '    float dx = clamp(min(p.x - ' + f(D.x0) + ', ' + f(D.x1) + ' - p.x) / 60.0, 0.0, 1.0);',
            '    over(col, a, vec3(0.30, 0.31, 0.34), aa(abs(p.y - ' + f(D.y) + ') - 0.5) * dx);',
            '',
            '    /* the car from above: body, windscreen and rear window */',
            '    vec2 cq = p - ' + v2(C.cx, C.cy) + ';',
            '    float body = sdBox(cq, ' + v2(C.hw, C.hh) + ', ' + f(C.r) + ');',
            '    over(col, a, mix(vec3(0.075, 0.08, 0.09), vec3(0.04, 0.042, 0.048), (cq.y + ' + f(C.hh) + ') / ' + f(2 * C.hh) + '), aa(body));',
            '    over(col, a, vec3(0.34, 0.35, 0.38), aa(abs(body) - 0.8));',
            '    float screen = sdBox(cq - vec2(0.0, -' + f(Math.round(C.hh * 0.42)) + '), vec2(' + f(C.hw - 10) + ', 15.0), 10.0);',
            '    over(col, a, vec3(0.20, 0.21, 0.24), aa(abs(screen) - 0.8));',
            '    float rear = sdBox(cq - vec2(0.0, ' + f(Math.round(C.hh * 0.62)) + '), vec2(' + f(C.hw - 14) + ', 10.0), 8.0);',
            '    over(col, a, vec3(0.20, 0.21, 0.24), aa(abs(rear) - 0.8));',
            L.corners.map(tyre).join('\n'),
            '',
            '    /* text: labels grey, values white */',
            '    float tl = texture2D(u_texL, v_uv).r;',
            '    over(col, a, vec3(0.56, 0.58, 0.62), tl);',
            '    float tv = texture2D(u_texV, v_uv).r;',
            '    vec3 vc = vec3(0.97);',
            L.gauges.map(function (g) {
                var u = g.key === 'coolant' ? 'u_cool' : 'u_oil';
                return '    if (' + u + '.z > 0.5 && length(p - ' + v2(g.cx, g.cy) + ') < R - 10.0) vc = vec3(1.0, 0.42, 0.36);';
            }).join('\n'),
            '    over(col, a, vc, tv);',
            '',
            '    gl_FragColor = vec4(col, a);',
            '}',
        ].join('\n');
    }

    var API = { build: build };
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
    else root.VITALS_SHADER = API;
})(this);
