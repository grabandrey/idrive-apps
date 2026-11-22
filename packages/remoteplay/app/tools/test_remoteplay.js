'use strict';
/* node packages/remoteplay/app/tools/test_remoteplay.js: the QR code, the sign-in page and the account id, finding and
 * waking a console, the links, the touch controller, parked or not, the screens, the video tool and the gamepad, and
 * the package's car-side rules (Node 8, the manifest) */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, '..', 'tool');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const log = { info: () => {}, warn: () => {}, error: () => {} };
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ---- qr.js ---- */
const qr = require('../src/qr.js');
test('qr: Reed-Solomon codewords of the standard\'s example', () => {
    // ISO 18004 annex: "01234567" at 1-M: data 10 20 0C 56 61 80 EC 11 EC 11 EC 11 EC 11 EC 11 -> EC A5 24 D4 C1 ED 36 C7 87 2C 55
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
    eq(qr.ecFor(data, 10), [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55], 'error correction codewords');
});
test('qr: sizes, finders, the dark module, capacity', () => {
    [['a', 1], ['http://192.168.2.1:8890/s/0123456789ab', 3], ['x'.repeat(213), 10]].forEach(([t, v]) => {
        const q = qr.encode(t);
        eq(q.version, v, t.length + ' bytes -> version ' + v);
        eq(q.size, 17 + 4 * v, 'size');
        // finder corners: dark ring, light ring, dark centre
        [[0, 0], [q.size - 7, 0], [0, q.size - 7]].forEach(([x, y]) => {
            ok(q.get(x, y) && q.get(x + 6, y + 6) && !q.get(x + 1, y + 1) && q.get(x + 3, y + 3), 'finder at ' + x + ',' + y);
        });
        ok(q.get(8, q.size - 8), 'the dark module');
    });
    let threw = false;
    try { qr.encode('x'.repeat(214)); } catch (e) { threw = true; }
    ok(threw, 'too long is refused');
    eq(qr.byteCapacity(1), 14, 'v1-M takes 14 bytes');
});

/* ---- login.js ---- */
const login = require('../src/login.js');
test('login: user id -> account id (64-bit, no BigInt)', () => {
    eq(login.accountIdFromUserId('1'), Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]).toString('base64'));
    eq(login.accountIdFromUserId('18446744073709551615'), Buffer.alloc(8, 255).toString('base64'));
    // 0x0123456789abcdef = 81985529216486895
    eq(Buffer.from(login.accountIdFromUserId('81985529216486895'), 'base64').toString('hex'), 'efcdab8967452301');
    let threw = false;
    try { login.accountIdFromUserId('18446744073709551616'); } catch (e) { threw = true; }
    ok(threw, 'more than 64 bits is refused');
});
test('login: the code from what is pasted', () => {
    eq(login.codeFrom('https://remoteplay.dl.playstation.net/remoteplay/redirect?code=AbC123&cid=x'), 'AbC123');
    eq(login.codeFrom('  v3.XyZ  '), 'v3.XyZ');
    eq(login.codeFrom('https://example.com/no'), null);
    eq(login.validAccountId('AQAAAAAAAAA='), 'AQAAAAAAAAA=');
    eq(login.validAccountId('nope'), null);
    ok(/client_id=ba495a24-818c-472b-b12d-ff231c1b5745/.test(login.LOGIN_URL) && /redirect_uri=https%3A%2F%2Fremoteplay/.test(login.LOGIN_URL), 'the sign-in address');
});
test('login: the car\'s address prefers its wireless private network', () => {
    const ifs = { lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], eth0: [{ family: 'IPv4', address: '160.48.1.2', internal: false }],
        wlan0: [{ family: 'IPv4', address: '192.168.43.1', internal: false }], usb0: [{ family: 'IPv4', address: '169.254.2.2', internal: false }] };
    eq(login.localAddress(ifs), '192.168.43.1');
    eq(login.localAddress({ lo: ifs.lo }), null);
});
test('login: the exchange with Sony (faked)', () => {
    const calls = [];
    const fake = (opts, body) => {
        calls.push([opts.method, opts.path, body]);
        if (opts.method === 'POST') return Promise.resolve({ status: 200, json: { access_token: 'tok/1' } });
        return Promise.resolve({ status: 200, json: { user_id: '81985529216486895', online_id: 'Driver' } });
    };
    return login.exchange('the-code', fake).then((acc) => {
        eq([acc.accountId, acc.onlineId, acc.accessToken], [Buffer.from('efcdab8967452301', 'hex').toString('base64'), 'Driver', 'tok/1']);
        ok(/grant_type=authorization_code&code=the-code&scope=psn%3Aclientapp.*&redirect_uri=/.test(calls[0][2]), "token request body");
        eq(calls[1][1], '/2.0/oauth/token/tok%2F1', 'account request path');
        return login.exchange('x', () => Promise.resolve({ status: 400, json: { error: 'invalid_grant' } })).then(() => ok(false, 'should fail'), (e) => ok(/invalid_grant/.test(e.message), 'refusal said'));
    });
});
test('login: the page on the hotspot, its token, the account sent from the phone', () => {
    const s = new login.SignIn({ log: log, port: 0, exchange: (code) => Promise.resolve({ accountId: 'AQAAAAAAAAA=', onlineId: 'P-' + code }) });
    let got = null;
    s.on('account', (a) => { got = a; });
    const srv = http.createServer((q, r) => s._serve(q, r));
    return new Promise((res) => srv.listen(0, '127.0.0.1', res)).then(() => {
        const port = srv.address().port;
        const req = (method, p, body) => new Promise((resolve, reject) => {
            const r = http.request({ host: '127.0.0.1', port: port, path: p, method: method, headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {} }, (rs) => {
                let t = ''; rs.on('data', (c) => { t += c; }); rs.on('end', () => resolve({ status: rs.statusCode, text: t, location: rs.headers.location }));
            });
            r.on('error', reject);
            if (body) r.write(body);
            r.end();
        });
        return req('GET', '/s/wrong')
            .then((r) => { eq(r.status, 404, 'a wrong token is turned away'); return req('GET', '/s/' + s.token); })
            .then((r) => { ok(r.status === 200 && /Sign in with PlayStation/.test(r.text), 'the page'); return req('POST', '/s/' + s.token + '/code', 'url=' + encodeURIComponent('https://x/redirect?code=K9')); })
            .then((r) => { eq(r.status, 303); eq([got.accountId, got.onlineId, got.duid], ['AQAAAAAAAAA=', 'P-K9', null], 'no refresh token: no device id kept'); return req('GET', '/s/' + s.token); })
            .then((r) => { ok(/Signed in as P-K9/.test(r.text), 'the page says so'); return req('POST', '/s/' + s.token + '/id', 'accountId=' + encodeURIComponent('AgAAAAAAAAA=')); })
            .then(() => { eq(got.accountId, 'AgAAAAAAAAA=', 'an account id pasted directly'); return req('POST', '/s/' + s.token + '/code', 'url=' + encodeURIComponent('https://example.com/not-it')); })
            .then(() => ok(/no code/.test(s.result.text), 'no code said'))
            .then(() => srv.close());
    });
});

test('login: play over the internet: scopes, the device id, tokens refreshed', () => {
    ok(login.SCOPES.split(' ').length === 4 && /sessionManager:remotePlaySession\.system\.update/.test(login.SCOPES), 'the four scopes');
    ok(login.loginUrl('0000000700410080' + 'ab'.repeat(16)).endsWith('&duid=0000000700410080' + 'ab'.repeat(16) + '&'), 'the device id goes in the address');
    eq(login.loginUrl(null), login.LOGIN_URL, 'no device id: none');
    eq(login.loginUrl('nope'), login.LOGIN_URL, 'a bad device id is left out');
    const calls = [];
    const fake = (opts, body) => {
        calls.push(body);
        return Promise.resolve(/refresh_token=old/.test(body) ? { status: 200, json: { access_token: 'acc2', refresh_token: 'new', expires_in: 3600 } }
            : /refresh_token=keep/.test(body) ? { status: 200, json: { access_token: 'acc3', expires_in: 10 } }
                : { status: 400, json: { error: 'invalid_grant' } });
    };
    return login.refresh('old', fake, 1000).then((t) => {
        eq(t, { accessToken: 'acc2', refreshToken: 'new', expiresAt: 1000 + 3600 * 1000 });
        ok(/grant_type=refresh_token/.test(calls[0]) && /scope=psn%3Aclientapp/.test(calls[0]), 'refresh with the scopes');
        return login.refresh('keep', fake, 0);
    }).then((t) => {
        eq([t.refreshToken, t.expiresAt], ['keep', 60000], 'no new refresh token: the old kept; at least a minute');
        return login.refresh('gone', fake).then(() => ok(false, 'refused'), (e) => ok(/sign in again/.test(e.message), 'refused: sign in again'));
    }).then(() => login.refresh(null).then(() => ok(false, 'none'), (e) => ok(/not signed in/.test(e.message), 'no token')));
});

/* ---- discovery.js ---- */
const disc = require('../src/discovery.js');
test('discovery: the requests and the replies', () => {
    eq(disc.searchPacket('PS5').toString(), 'SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00030010\n');
    const reply = 'HTTP/1.1 620 Server Standby\nhost-id:AABBCCDDEEFF\nhost-type:PS5\nhost-name:Living room\nhost-request-port:997\n' +
        'device-discovery-protocol-version:00030010\nsystem-version:07020001\n';
    eq(disc.parseReply(reply, '192.168.43.20'), { host: '192.168.43.20', name: 'Living room', type: 'PS5', id: 'AABBCCDDEEFF', state: 'standby', version: '07020001', port: 997, app: '' });
    eq(disc.parseReply('HTTP/1.1 200 Ok\nhost-type:PS4\nrunning-app-name:A Game\n', '10.0.0.2').state, 'ready');
    eq(disc.parseReply('garbage', 'x'), null);
    eq(disc.hexToDecimal('ff'), '255');
    eq(disc.hexToDecimal('ffffffffffffffff'), '18446744073709551615');
    eq(disc.hexToDecimal('0123456789abcdef'), '81985529216486895');
    ok(/user-credential:255\n/.test(disc.wakePacket('PS5', '255').toString()), 'wake carries the credential');
    eq(disc.broadcasts({ wlan0: [{ family: 'IPv4', address: '192.168.43.1', netmask: '255.255.255.0', internal: false }] }), ['255.255.255.255', '192.168.43.255']);
});
test('discovery: a search over a fake network', () => {
    const sent = [];
    const fakeDgram = { createSocket: () => {
        const ee = new (require('events'))();
        ee.bind = (p, cb) => setImmediate(cb);
        ee.setBroadcast = () => {};
        ee.close = () => {};
        ee.send = (buf, port, host, cb) => {
            sent.push([port, host]);
            if (port === 9302 && sent.length === 1) setImmediate(() => ee.emit('message', Buffer.from('HTTP/1.1 200 Ok\nhost-type:PS5\nhost-name:Car PS5\nhost-id:01\n'), { address: '192.168.43.20' }));
            cb && cb();
        };
        return ee;
    } };
    return new disc.Discovery({ log: log, dgram: fakeDgram }).search({ timeoutMs: 120, host: '192.168.43.20' }).then((list) => {
        eq(list.length, 1);
        eq(list[0].name, 'Car PS5');
        ok(sent.some((s) => s[0] === 987) && sent.some((s) => s[0] === 9302), 'asked on both ports');
    });
});

/* ---- links.js: a fake video tool ---- */
const links = require('../src/links.js');
test('links: requests, replies, events, a refusal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
    const sock = path.join(dir, 'ctl.sock');
    const srv = net.createServer((c) => {
        let buf = '';
        c.on('data', (d) => {
            buf += d;
            const lines = buf.split('\n'); buf = lines.pop();
            lines.forEach((l) => {
                const m = JSON.parse(l);
                if (m.op === 'probe') { c.write(JSON.stringify({ ev: 'pad', name: 'Pad' }) + '\n'); c.write(JSON.stringify({ id: m.id, ok: true, decoder: 'v4l2h264dec' }) + '\n'); }
                else c.write(JSON.stringify({ id: m.id, ok: false, error: 'no' }) + '\n');
            });
        });
    });
    return new Promise((res) => srv.listen(sock, res)).then(() => new Promise((resolve, reject) => {
        const l = new links.JsonLink('video tool', sock, log, { retryMs: 50 });
        let pad = null;
        l.on('pad', (m) => { pad = m.name; });
        l.on('ready', () => {
            l.ask({ op: 'probe' }).then((r) => {
                eq(r.decoder, 'v4l2h264dec'); eq(pad, 'Pad', 'the event came first');
                return l.ask({ op: 'x' }).then(() => reject(new Error('should refuse')), (e) => eq(e.message, 'no'));
            }).then(() => { l.close(); srv.close(); resolve(); }, reject);
        });
        l.connect();
    }));
});

/* ---- pad.js ---- */
const pad = require('../src/pad.js');
const ui = require('../src/ui.js');
test('pad: the layout keeps the controls beside the video', () => {
    const lay = pad.layout(ui.W, ui.H);
    eq(lay.video, { x: 761, y: 0, w: 1358, h: 764 });
    lay.controls.forEach((c) => {
        ok(c.x + c.w <= lay.video.x || c.x >= lay.video.x + lay.video.w, c.key + ' is beside the video');
        ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= ui.W && c.y + c.h <= ui.H, c.key + ' is on the screen');
    });
    const keys = lay.controls.map((c) => c.key);
    ['cross', 'circle', 'square', 'triangle', 'l1', 'r1', 'l2', 'r2', 'up', 'down', 'left', 'right', 'options', 'create', 'ps', 'lstick', 'rstick', 'exit'].forEach((k) => ok(keys.indexOf(k) >= 0, k));
});
test('pad: touches -> the controller state', () => {
    const p = new pad.Pad(ui.W, ui.H);
    const at = (k) => p.lay.controls.filter((c) => c.key === k)[0];
    const mid = (c) => [c.x + c.w / 2, c.y + c.h / 2];
    const x = at('cross');
    p.touch(1, mid(x)[0], mid(x)[1]);
    eq(p.take().buttons, ['cross']);
    eq(p.take(), null, 'nothing new');
    p.touch(3, mid(x)[0], mid(x)[1]);
    eq(p.take().buttons, []);
    const l2 = at('l2');
    p.touch(1, mid(l2)[0], mid(l2)[1]);
    eq(p.state.l2, 255);
    p.touch(3, mid(l2)[0], mid(l2)[1]);
    const s = at('lstick');
    p.touch(1, s.x + s.r, s.y + s.r);
    p.touch(2, s.x + s.r * 3, s.y + s.r);             // far right: clamped
    eq([p.state.lx, p.state.ly], [32767, 0]);
    p.touch(2, s.x + s.r, s.y);                        // straight up
    eq([p.state.lx, p.state.ly], [0, -32767]);
    p.touch(3, s.x + s.r, s.y);
    eq([p.state.lx, p.state.ly], [0, 0], 'let go: centred');
    const e = at('exit');
    p.touch(1, mid(e)[0], mid(e)[1]);
    eq(p.touch(3, mid(e)[0], mid(e)[1]), 'exit');
    p.touch(1, mid(e)[0], mid(e)[1]);
    eq(p.touch(3, 1400, 400), null, 'slid off Exit: not taken');
    p.take();
    p.touch(1, 1400, 400);
    eq(p.take(), null, 'the video does nothing');
});

/* ---- gate.js ---- */
const { Gate } = require('../src/gate.js');
test('gate: parked, moving, no speed', () => {
    let t = 0;
    const changes = [];
    const g = new Gate({ log: log, now: () => t });
    g.on('change', (p) => changes.push(p));
    eq(g.parked, null);
    g.speed(0); eq(g.parked, true);
    g.speed(2); eq(g.parked, true, 'creeping: still parked');
    g.speed(10); eq(g.parked, false);
    g.speed(0); eq(g.parked, true);
    t = 6000; g.tick(); eq(g.parked, null, 'the speed stopped coming');
    eq(changes, [true, false, true, false]);
    const g2 = new Gate({ log: log });
    g2.speed(2); eq(g2.parked, false, 'never parked until 0');
});

/* ---- ui.js ---- */
test('ui: every screen draws, and only enabled buttons take presses', () => {
    const rec = new ui.Recorder(), lay = pad.layout(ui.W, ui.H);
    const keys = (m) => ui.draw(rec, m, lay).targets.map((t) => t.key);
    const nothing = keys({ view: 'home' });
    ok(nothing.indexOf('rpPlay') < 0 && nothing.indexOf('rpPair') < 0 && nothing.indexOf('rpSignIn') >= 0, 'not ready: no Play');
    const ready = { view: 'home', account: { onlineId: 'D' }, console: { name: 'PS5', host: '1.2.3.4', state: 'ready' }, paired: { registKey: 'ab' },
        engine: { name: 'e' }, video: { tool: true, probe: { decoder: 'v4l2h264dec', hardware: true, sink: 'waylandsink' }, fps: 60, size: '1280x720', target: 60 }, parked: true, route: 'local' };
    ok(keys(ready).indexOf('rpPlay') >= 0, 'ready: Play');
    ok(keys(Object.assign({}, ready, { parked: false })).indexOf('rpPlay') < 0, 'moving: no Play');
    ok(keys(Object.assign({}, ready, { parked: false })).indexOf('rpTest') < 0, 'moving: no video test');
    ok(keys(Object.assign({}, ready, { route: null })).indexOf('rpPlay') < 0, 'nowhere to play: no Play');
    const away = Object.assign({}, ready, { console: null, paired: null, route: 'internet', internet: true, remote: { name: 'PS5-Home', consoleId: 'ab', type: 'PS5' } });
    ok(keys(away).indexOf('rpPlay') >= 0 && keys(away).indexOf('rpPair') < 0, 'away from home: Play over the internet, no pairing');
    const si = ui.draw(rec, { view: 'signin', qr: qr.encode('http://192.168.43.1:8890/s/0123456789ab'), url: 'http://192.168.43.1:8890/s/0123456789ab' }, lay);
    ok(si.rec.n > 500, 'the QR code is drawn');
    eq(keys({ view: 'pin', pin: '1234' }).filter((k) => /^rpK\d$/.test(k)).length, 10, 'ten digits');
    ok(keys({ view: 'pin', pin: '12345678' }).indexOf('rpKPair') >= 0 && keys({ view: 'pin', pin: '123' }).indexOf('rpKPair') < 0, 'Pair once 8 digits');
    const play = ui.draw(rec, { view: 'play', session: { state: 'streaming' } }, lay);
    eq(play.rec.u[0], ui.OP.CLEAR); eq(play.rec.u[1], 0, 'Play clears to transparent: the video shows through');
    eq(keys({ view: 'play', pad: 'Wireless Controller' }), ['exit'], 'a USB gamepad: only Exit on screen');
    ok(keys({ view: 'logs', logs: [{ t: 0, level: 'warn', text: 'x' }] }).indexOf('rpClose') >= 0, 'logs');
    eq(ui.toScreen({ x: 0, y: 76, w: 2880, h: 764, scale: 1, ox: 0, oy: 0 }, { x: 761, y: 0, w: 1358, h: 764 }), { x: 761, y: 76, w: 1358, h: 764 });
});

/* ---- the video tool ---- */
const video = require(path.join(TOOL, 'video.js'));
test('video tool: what it picks, the pipelines', () => {
    const els = video.parseInspect('video4linux2:  v4l2h264dec: V4L2 H264 Decoder\nlibav:  avdec_h264: libav H.264 decoder\nlibav:  avdec_h265: libav HEVC\n' +
        'waylandsink:  waylandsink: wayland video sink\nvideoparsersbad:  h264parse: H.264 parser\nvideotestsrc:  videotestsrc: test\nvideoconvert:  videoconvert: conv\n\nTotal count: 9 plugins');
    ok(els.v4l2h264dec && els.waylandsink && !els['Total'], 'elements read');
    const c = video.choose(els, {});
    eq([c.decoders.h264, c.decoders.h265, c.hardware, c.hardwareH265, c.sink, c.encoder], ['v4l2h264dec', 'avdec_h265', true, false, 'waylandsink', null]);
    eq(video.streamPipeline(c, 'h264', { x: 761, y: 76, w: 1358, h: 764 }), 'fdsrc fd=0 ! h264parse ! v4l2h264dec ! waylandsink render-rectangle=<761,76,1358,764> sync=false');
    eq(video.streamPipeline(c, 'h265', null), 'fdsrc fd=0 ! h265parse ! avdec_h265 ! videoconvert ! waylandsink sync=false', 'software: converted');
    eq(video.choose(els, { decoder: { h264: 'avdec_h264' }, sink: 'nope' }).decoders.h264, 'avdec_h264', 'the settings pick');
    eq(video.choose(els, { sinkProps: 'fullscreen=true' }).sinkProps, 'fullscreen=true');
    ok(/num-buffers=480 .*,framerate=60\/1 ! videoconvert ! waylandsink sync=false$/.test(video.testPipeline(c, { width: 1280, height: 720, fps: 60, seconds: 8 })), 'no encoder: shown directly');
    const withEnc = video.choose(Object.assign({ v4l2h264enc: true }, els), {});
    ok(/ ! v4l2h264enc ! h264parse ! v4l2h264dec ! /.test(video.testPipeline(withEnc, { width: 1280, height: 720, fps: 60, seconds: 8 })), 'an encoder: through the decoder');
    eq(video.args('a ! b c=<1,2,3,4>  d'), ['a', '!', 'b', 'c=<1,2,3,4>', 'd']);
});
test('video tool: pictures counted in a stream, across chunks', () => {
    const h264 = new video.FrameCounter('h264');
    // SPS, IDR (first slice), a second slice of the same picture (first_mb != 0), a P picture split across chunks
    h264.push(Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0, 0, 1, 0x65, 0x88, 0x84, 0, 0, 1, 0x65, 0x40, 0, 0, 0]));
    h264.push(Buffer.from([1, 0x41]));
    h264.push(Buffer.from([0x9a, 0, 0, 0, 0, 0]));
    eq(h264.frames, 2);
    const h265 = new video.FrameCounter('h265');
    h265.push(Buffer.from([0, 0, 1, 0x40, 0x01, 0x0c, 0, 0, 1, 0x26, 0x01, 0xaf, 0, 0, 1, 0x02, 0x01, 0xd0, 0, 0, 0, 0]));
    eq(h265.frames, 2, 'VPS skipped, IDR and TRAIL counted');
});

/* ---- the gamepad ---- */
const gp = require(path.join(TOOL, 'gamepad.js'));
test('gamepad: found in the input devices, read from its events', () => {
    const devs = 'I: Bus=0003 Vendor=054c Product=0ce6\nN: Name="Sony Interactive Entertainment Wireless Controller"\nH: Handlers=event5 js0\n\n' +
        'I: Bus=0019\nN: Name="gpio-keys"\nH: Handlers=kbd event0\n';
    eq(gp.joysticks(devs), [{ name: 'Sony Interactive Entertainment Wireless Controller', event: 'event5' }]);
    const s = gp.scaler(true);
    eq([s('lx', 0), s('lx', 255), s('l2', 255), s('l2', 0)], [-32768, 32767, 255, 0]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-pad-'));
    fs.writeFileSync(path.join(dir, 'devices'), devs);
    const ev = (type, code, value) => { const b = Buffer.alloc(24); b.writeUInt16LE(type, 16); b.writeUInt16LE(code, 18); b.writeInt32LE(value, 20); return b; };
    fs.writeFileSync(path.join(dir, 'event5'), Buffer.concat([ev(1, 0x130, 1), ev(3, 0x00, 255), ev(3, 0x11, -1), ev(0, 0, 0), ev(1, 0x130, 0), ev(0, 0, 0)]));
    const g = new gp.Gamepads({ dir: dir, devices: path.join(dir, 'devices'), eventSize: 24 });
    const states = [];
    return new Promise((resolve) => {
        g.on('state', (name, st) => states.push(JSON.parse(JSON.stringify(st))));
        g.on('gone', () => {
            eq(states.length, 2);
            eq(states[0].buttons.sort(), ['cross', 'up']); eq(states[0].lx, 32767);
            eq(states[1].buttons, ['up']);
            g.stop();
            resolve();
        });
        g._look();
    });
});

/* ---- the package ---- */
test('package: modules, requires, Node 8, the manifest, the screen\'s rows', () => {
    const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-app.json'), 'utf8'));
    const builtins = ['events', 'fs', 'path', 'os', 'net', 'zlib', 'http', 'https', 'crypto', 'dgram', 'querystring'];
    const files = fs.readdirSync(path.join(ROOT, 'src')).map((f) => 'src/' + f);
    eq(files.slice().sort(), app.modules.slice().sort(), 'mgu-app.json lists every module');
    app.modules.concat(['../tool/video.js', '../tool/gamepad.js']).forEach((m) => {
        const src = fs.readFileSync(path.join(ROOT, m), 'utf8');
        (src.match(/require\('([^']+)'\)/g) || []).map((r) => r.slice(9, -2)).forEach((r) => {
            ok(r[0] === '.' || app.sdk.indexOf(r) >= 0 || builtins.concat(['child_process']).indexOf(r) >= 0, m + ': may require ' + r);
        });
        ok(!/\?\.|\?\?|Object\.fromEntries|\bBigInt\b|\d+n\b(?![a-z])/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''")), m + ': Node 8 syntax only');
    });
    ['someip_link.js', 'gpu.js', 'ui_font.js', 'log_ring.js'].forEach((f) => {
        const mine = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
        const theirs = fs.readFileSync(path.join(ROOT, '..', '..', 'seatlights', 'app', 'src', f), 'utf8');
        ok(mine === theirs, f + ' is the same as Seat Lights\' (copy it again)');
    });
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'package', 'manifest.json'), 'utf8')).proxies;
    eq(man['de.bmw.infotainment.vehicle.Vehicle2'], { instances: ['1'], attributes: { statusCarSpeed2: 'rs' } }, 'the speed is declared');
    ok(!man['com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu'], 'no diagnostic link');
    const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'package', 'package.json'), 'utf8'));
    eq([pj.name, pj.version, pj.oapAppSettings.loggingId], [app.id, app.version, 'RMPL']);
    ok(!pj.mguAppStartType, 'starts when opened, not with the head unit');
    const comps = JSON.parse(fs.readFileSync(path.join(ROOT, 'package/rhmiData/uiDescriptions/ID8/uiDescription.json'), 'utf8')).containers[1].components;
    const names = Object.keys(comps).map((k) => comps[k].name);
    ['rpStatus', 'rpSignIn', 'rpFind', 'rpWake', 'rpTest', 'rpLogs', 'rpOlder', 'rpNewer', 'rpLine0', 'rpLine29'].forEach((x) => ok(names.indexOf(x) >= 0, 'row ' + x));
    const main = fs.readFileSync(path.join(ROOT, 'src', 'ida_remoteplay.js'), 'utf8');
    ok(main.indexOf("'ST_OnlineApps_RemotePlay'") >= 0, 'the state name matches');
    const comp = JSON.parse(fs.readFileSync(path.join(TOOL, 'component.json'), 'utf8'));
    comp.files.forEach((f) => ok(fs.existsSync(path.join(TOOL, f.from)), 'tool file ' + f.from));
});

/* ---- the engine (packages/remoteplay/engine) ---- */
const ENGINE = path.join(ROOT, '..', 'engine');
test('engine: the component, its programs, the licences', () => {
    const comp = JSON.parse(fs.readFileSync(path.join(ENGINE, 'component.json'), 'utf8'));
    eq(comp.id, 'ida-remoteplay-engine');
    comp.files.forEach((f) => ok(fs.existsSync(path.join(ENGINE, f.from)), 'engine file ' + f.from));
    comp.units.forEach((u) => ok(fs.existsSync(path.join(ENGINE, u.from)), 'engine unit ' + u.from));
    // ELF, static, for the right processor (e_machine: 62 x86-64, 183 AArch64), and installed executable
    [['x86_64', 62], ['aarch64', 183]].forEach(([arch, machine]) => {
        const rel = 'bin/' + arch + '/ida-rp-engine', b = fs.readFileSync(path.join(ENGINE, rel));
        ok(b.slice(0, 4).toString('latin1') === '\x7fELF' && b[4] === 2, rel + ' is a 64-bit ELF');
        eq(b.readUInt16LE(18), machine, rel + ' is for ' + arch);
        eq(comp.files.filter((f) => f.from === rel)[0].mode, '0755', rel + ' is executable');
    });
    ok(/GNU AFFERO GENERAL PUBLIC LICENSE/.test(fs.readFileSync(path.join(ENGINE, 'LICENSE'), 'utf8')), 'the AGPL text');
    ok(comp.files.some((f) => f.from === 'engine.c') && comp.files.some((f) => f.from === 'build.sh'), 'its source goes with it');
    const start = fs.readFileSync(path.join(ENGINE, 'start.sh'), 'utf8');
    ok(/x86_64\|amd64\) ARCH=x86_64/.test(start) && /aarch64\|arm64\) ARCH=aarch64/.test(start), 'start.sh picks the processor');
});
test('engine: the real program answers the app (x86_64 here)', () => {
    if (process.arch !== 'x64' || process.platform !== 'linux') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-engine-'));
    const proc = require('child_process').spawn(path.join(ENGINE, 'bin/x86_64/ida-rp-engine'), [dir], { stdio: 'ignore' });
    const sock = path.join(dir, 'engine.sock');
    const until = (cond, ms) => new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => (cond() ? resolve() : Date.now() - t0 > ms ? reject(new Error('timed out')) : setTimeout(tick, 50));
        tick();
    });
    const l = new links.JsonLink('stream engine', sock, log, { retryMs: 50, timeoutMs: 20000 });
    const events = [];
    l.on('session', (m) => events.push(m.state));
    return until(() => links.isSocket(sock), 5000)
        .then(() => { l.connect(); return until(() => l.ready, 5000); })
        .then(() => l.ask({ op: 'hello', proto: 1 }))
        .then((h) => {
            ok(/chiaki-ng/.test(h.name) && h.targets.indexOf('ps5') >= 0, 'hello');
            return l.ask({ op: 'register', host: '127.0.0.1', type: 'PS5', accountId: 'AQAAAAAAAAA=', pin: '1234' }).then(() => ok(false, 'a short pin'), (e) => ok(/8-digit/.test(e.message), 'a short pin is refused'));
        })
        .then(() => l.ask({ op: 'register', host: '127.0.0.1', type: 'PS5', accountId: 'AQAAAAAAAAA=', pin: '12345678' }).then(() => ok(false, 'no console here'), (e) => ok(/refused the pairing/.test(e.message), 'no console: refused')))
        .then(() => l.ask({ op: 'duid' }))
        .then((d) => {
            ok(/^0000000700410080[0-9a-f]{32}$/.test(d.duid), 'this car\'s PSN device id');
            return l.ask({ op: 'start', type: 'PS5', remote: { token: 't' }, video: {} }).then(() => ok(false, 'no console id'), (e) => ok(/64-digit/.test(e.message), 'over the internet: the console id is needed'));
        })
        .then(() => l.ask({ op: 'start', type: 'PS5', remote: { token: 't', consoleId: 'ab'.repeat(32) }, video: {} }).then(() => ok(false, 'no account'), (e) => ok(/account id/.test(e.message), 'over the internet: the account id is needed')))
        .then(() => l.ask({ op: 'start', host: '127.0.0.1', type: 'PS5', registered: { rpRegistKey: 'AAAAAAAAAAAAAAAAAAAAAA==', rpKey: 'AAAAAAAAAAAAAAAAAAAAAA==' },
            video: { socket: path.join(dir, 'none.sock'), codec: 'h264', width: 1280, height: 720, fps: 60 } }))
        .then(() => until(() => events.indexOf('ended') >= 0, 15000))
        .then(() => { eq(events[0], 'connecting'); l.tell({ op: 'input', state: { buttons: ['cross'] } }); return l.ask({ op: 'stop' }); })
        .then(() => { l.close(); proc.kill(); }, (e) => { l.close(); proc.kill(); throw e; });
});

/* run them in order */
tests.reduce((p, t) => p.then(() => Promise.resolve().then(t[1]).catch((e) => { e.message = t[0] + ': ' + e.message; throw e; })), Promise.resolve())
    .then(() => { console.log(n + ' checks passed'); process.exit(0); },
        (e) => { console.error('FAIL ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
