'use strict';
/*
 * node scripts/test_all.js: checks mgu-repo.json against the packages, then runs every
 * package's tests (any test_*.js in a tools folder under packages). CI runs this on every push.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PREFIX = /^ida[-_][a-z0-9]+([-_][a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
let failed = 0;
const fail = (msg) => { failed++; console.error('FAIL ' + msg); };

/* ---- mgu-repo.json ---- */
const repo = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-repo.json'), 'utf8'));
const ids = {};
(repo.components || []).forEach((c) => {
    const where = 'mgu-repo.json ' + c.id;
    if (!PREFIX.test(c.id || '')) fail(where + ': ids start with "ida-" (tools) or "ida_" (apps), lowercase');
    if (ids[c.id]) fail(where + ': listed twice');
    ids[c.id] = c;
    if (!Array.isArray(c.mguHmi) || !c.mguHmi.length) fail(where + ': no mguHmi');
    const dir = path.join(ROOT, c.path || '');
    if (!c.path || !fs.existsSync(dir)) { fail(where + ': no folder ' + c.path); return; }
    if (c.kind === 'tool') {
        const comp = JSON.parse(fs.readFileSync(path.join(dir, 'component.json'), 'utf8'));
        if (comp.id !== c.id) fail(where + ': component.json id is ' + comp.id);
        if (!SEMVER.test(comp.version)) fail(where + ': component.json version ' + comp.version);
        (comp.files || []).forEach((f) => { if (!fs.existsSync(path.join(dir, f.from))) fail(where + ': missing file ' + f.from); });
        (comp.units || []).forEach((u) => { if (!fs.existsSync(path.join(dir, u.from))) fail(where + ': missing unit ' + u.from); });
        c.version = comp.version;
    } else if (c.kind === 'app') {
        const app = JSON.parse(fs.readFileSync(path.join(dir, 'mgu-app.json'), 'utf8'));
        if (app.id !== c.id) fail(where + ': mgu-app.json id is ' + app.id);
        if (!SEMVER.test(app.version)) fail(where + ': mgu-app.json version ' + app.version);
        (app.modules || []).forEach((m) => { if (!fs.existsSync(path.join(dir, m))) fail(where + ': missing module ' + m); });
        const pkg = path.join(dir, app.tree || 'package');
        const pj = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
        if (pj.name !== app.id || pj.version !== app.version) fail(where + ': package.json says ' + pj.name + '@' + pj.version + ' (run its gen_package.js)');
        c.version = app.version;
    } else fail(where + ': kind is ' + c.kind);
});
Object.keys(ids).forEach((id) => {
    const req = ids[id].requires || {};
    Object.keys(req).forEach((r) => {
        if (/^ida[-_]/.test(r) && !ids[r]) fail('mgu-repo.json ' + id + ': requires ' + r + ', which is not in this repo');
    });
});
console.log('mgu-repo.json: ' + Object.keys(ids).length + ' components checked');

/* ---- every package's tests ---- */
const tests = [];
(function walk(d) {
    fs.readdirSync(d).forEach((f) => {
        const p = path.join(d, f);
        if (f === 'node_modules' || f === 'package') return;
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (/^test_.*\.js$/.test(f) && path.basename(d) === 'tools') tests.push(p);
    });
})(path.join(ROOT, 'packages'));
tests.forEach((t) => {
    const rel = path.relative(ROOT, t);
    try { process.stdout.write(rel + ': ' + execFileSync(process.execPath, [t], { encoding: 'utf8' })); } catch (e) { fail(rel + '\n' + (e.stdout || '') + (e.stderr || '')); }
});

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('all ok (' + tests.length + ' test files)');
