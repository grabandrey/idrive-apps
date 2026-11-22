'use strict';
/*
 * Remote Play: play your PlayStation on the car's screen, parked. An iDrive 8 app:
 *
 *   Sign in      a QR code for a page on the car's hotspot: sign in at PlayStation on the phone (login.js); the car
 *                keeps the account id the console asks for when pairing
 *   Find, Wake   the console on the car's network (discovery.js): the car's hotspot, or the phone's with the car on it;
 *                and, signed in, the account's consoles through PSN, for play over the internet when the console is home
 *   Pair         the console's 8-digit PIN (Settings > System > Remote Play > Pair Device), through the stream engine
 *   Video test   a moving picture at 1280x720, 60 fps, through the same decoder and display the game will use: the
 *                frame rate the car really shows
 *   Play         on the same network when the console answers there (paired with its PIN); else over the internet
 *                through PSN (no PIN: the console pairs itself for each session). The stream engine runs the console's session and writes the video into the video tool, which decodes
 *                it in hardware and shows it in the middle of the screen at the stream's rate; the touch controls (pad.js)
 *                or a USB gamepad (the video tool reads it) go back to the console
 *
 * Only while parked: the speed (Vehicle2.statusCarSpeed2) must read 0 (within the last 5 s) to start, and anything
 * over 3 km/h stops the game and the video at once.
 *
 * The parts (links.js): the video tool (ida-remoteplay-video, root: GStreamer, the gamepad) and the stream engine
 * (ida-remoteplay-engine, root: chiaki-ng's library, the console's encrypted session). The screen is drawn by MGU Store's Renderer (gpu.js, ui.js); the
 * plain HMI list underneath has the status, Sign in (the address as text), Find, Wake, Video test and the log.
 * Built on the head unit by MGU Store against the car's own oap-sdk (mgu-app.json).
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { SomeipLink } = require('./someip_link.js');
const { Gpu } = require('./gpu.js');
const ui = require('./ui.js');
const qr = require('./qr.js');
const { Pad, layout } = require('./pad.js');
const { SignIn, refresh } = require('./login.js');
const { Discovery } = require('./discovery.js');
const { JsonLink, VIDEO_SOCKET, ENGINE_SOCKET, STREAM_SOCKET } = require('./links.js');
const { LogRing } = require('./log_ring.js');
const { Gate } = require('./gate.js');

const SETTINGS = settingsFile('remoteplay.json');
const logger = new LogRing(logging.getSDKLogger(), SETTINGS ? path.join(path.dirname(SETTINGS), 'remoteplay.log') : null);

const STATE = 'ST_OnlineApps_RemotePlay';
const STATUS = 'rpStatus';
const LIST_BUTTONS = ['rpSignIn', 'rpFind', 'rpWake', 'rpTest', 'rpLogs', 'rpOlder', 'rpNewer'];
const LINE_ROWS = 30;
const RENDER_MS = 1000;
const FRAME_MS = 100;
const PLAY_FRAME_MS = 50;           // the touch controls answer within a frame
const INPUT_KEEP_MS = 500;          // the controller state again, unchanged, so a lost line can't leave a button held
const ID8_AREA = { x: 0, y: 76, w: 2880, h: 764 };
const STREAM = { width: 1280, height: 720, fps: 60, bitrateKbps: 10000, remoteBitrateKbps: 6000 };   // over the internet: less, for mobile data
const TOKEN_MARGIN_MS = 120000;     // an access token is refreshed this long before it runs out
const FOREGROUND_REASONS = ['ENTRY_POINT', 'LUM', 'BOOKMARK', 'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
const isTrue = (v) => v === true || v === 1 || v === 'true' || v === '1';

function within(p, ms, what) {
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => { logger.warn(what + ': no answer after ' + ms + ' ms, going on'); resolve(); }, ms); });
    return Promise.race([Promise.resolve(p), late])
        .catch((err) => logger.warn(what + ' failed: ' + (err && err.message)))
        .then((v) => { clearTimeout(timer); return v; });
}

function settingsFile(name) {
    const dirs = [process.env.HOME, process.cwd(), os.tmpdir()];
    for (let i = 0; i < dirs.length; i++) {
        if (!dirs[i]) continue;
        const p = path.join(dirs[i], name);
        try { fs.appendFileSync(p, ''); return p; } catch (e) { /* next */ }
    }
    return null;
}

class RemotePlayApp extends OnlineApp {
    constructor() {
        super();
        this._state = null;
        this._comps = {};
        this._byId = {};
        this._written = {};
        this._visible = false;
        this._shutdown = null;
        this._opening = null;
        this._dirty = true;
        this._timers = [];
        this._gpu = null;
        this._placement = null;
        this._ui = { rec: new ui.Recorder(), targets: [], focus: null, pressed: null, down: null, key: '', timer: null };

        let saved = {};
        try { saved = JSON.parse(fs.readFileSync(SETTINGS, 'utf8') || '{}') || {}; } catch (e) { /* first start */ }
        this._saved = {
            account: saved.account || null,            // { accountId, onlineId }
            console: saved.console || null,            // discovery.js: { host, name, type, id, state }
            registered: saved.registered || null,      // the engine's, kept as it gave it
            remote: saved.remote || null,              // the account's console through PSN: { name, consoleId, type, remotePlay }
            duid: saved.duid || null,                  // this car's PSN device id (the engine makes it once)
            stream: Object.assign({}, STREAM, saved.stream || {}),
        };
        this._view = 'home';
        this._logPage = 0;
        this._note = null;
        this._warn = false;
        this._pin = '';
        this._pairing = false;
        this._searching = false;
        this._session = null;
        this._video = { tool: false, probe: null, testing: false, fps: null, size: null, target: 0, dropped: 0 };
        this._engineInfo = null;
        this._usbPad = null;                           // { name, state } while a USB gamepad is plugged in
        this._pad = new Pad(ui.W, ui.H);
        this._lay = layout(ui.W, ui.H);
        this._inputAt = 0;

        this._access = null;                           // { token, expiresAt }: in memory only
        this._signIn = new SignIn({ log: logger, duid: () => this._saved.duid });
        this._signIn.on('account', (acc) => {
            this._saved.account = { accountId: acc.accountId, onlineId: acc.onlineId, refreshToken: acc.refreshToken || null, duid: acc.duid || null };
            this._access = acc.accessToken ? { token: acc.accessToken, expiresAt: acc.expiresAt } : null;
            this._save();
            this._note = null; this._dirty = true;
            if (this._canInternet()) this._findRemote(false);
        });
        this._discovery = new Discovery({ log: logger });
        this._videoLink = new JsonLink('video tool', VIDEO_SOCKET, logger);
        this._engine = new JsonLink('stream engine', ENGINE_SOCKET, logger);
        this._link = new SomeipLink(logger);
        this._gate = new Gate({ log: logger });
        this._gate.on('change', (parked) => { this._dirty = true; if (!parked) this._moving(); });
        logger.on('line', () => { if (this._view === 'logs') this._dirty = true; });

        this.on('initialized', () => { this._init().catch((err) => logger.error('init failed: ' + (err && err.message))); });
        this.on('shutdown', (reason) => this._stop(reason));
        this.on('error', (err) => logger.warn('OnlineApp error: ' + (err && err.message)));
        this.on('entryPointExecute', (uuid) => this._open(uuid));
        this.on('changeVisibility', (data) => { if (data && data.visible === false) this._setVisible(false); });
    }

    _save() {
        // it holds the PSN refresh token: readable by the app alone
        try { if (SETTINGS) { fs.writeFileSync(SETTINGS, JSON.stringify(this._saved, null, 1), { mode: 0o600 }); fs.chmodSync(SETTINGS, 0o600); } } catch (e) { logger.warn('not saved: ' + e.message); }
    }

    _init() {
        logger.info('Remote Play ' + this.getAppId() + ' starting; settings ' + (SETTINGS || 'not kept'));
        this._startLinks();
        this._watchSpeed();
        this._timers.push(setInterval(() => { if (this._dirty) this._render(); }, RENDER_MS));
        this._timers.push(setInterval(() => this._sendInput(false), INPUT_KEEP_MS));
        if (!this.rhmiApplication) { logger.info('no RhmiApplication for this start reason; running without a screen'); return this.initialized(); }
        const data = this.getVisibilityData && this.getVisibilityData();
        const reason = (data && data.reason) || this.startReason;
        const foreground = FOREGROUND_REASONS.indexOf(reason) >= 0;
        return this._setupRhmi()
            .then(() => this._startGpu())
            .then(() => this._pushRows())
            .then(() => this._registerEntryPoint().catch((err) => logger.warn('entry point: ' + (err && err.message) + '; starting without it')))
            .then(() => { if (foreground) this.registerActive(); return this.initialized(); })
            .then(() => {
                if (foreground) this._setVisible(true);
                const last = this.getLastExecutedEntryPointUuid && this.getLastExecutedEntryPointUuid();
                return last ? this._open(last) : undefined;
            });
    }

    /* ---- the parts ---- */
    _startLinks() {
        const v = this._videoLink, e = this._engine;
        v.on('ready', () => {
            this._video.tool = true;
            v.ask({ op: 'probe' }).then((p) => {
                this._video.probe = p;
                logger.info('video: ' + (p.gst ? 'GStreamer ' + p.gst + ', decoder ' + (p.decoder || 'none') + (p.hardware ? ' (hardware)' : '') + ', display ' + (p.sink || 'none') : p.error));
                this._dirty = true;
            }, (err) => logger.warn('video probe: ' + err.message));
        });
        v.on('lost', () => { this._video.tool = false; this._video.probe = null; this._usbPad = null; this._dirty = true; });
        v.on('video', (m) => this._videoEvent(m));
        v.on('pad', (m) => {
            const was = this._usbPad && this._usbPad.name;
            this._usbPad = m.name ? { name: m.name, state: m.state } : null;
            if (was !== (m.name || undefined)) { logger.info(m.name ? 'USB gamepad: ' + m.name : 'USB gamepad unplugged'); this._dirty = true; }
            if (m.name && this._view === 'play') this._sendInput(true);
        });
        e.on('ready', () => {
            e.ask({ op: 'hello', proto: 1, app: 'ida_remoteplay' }).then((h) => {
                this._engineInfo = { name: h.name, version: h.version, targets: h.targets || [] };
                logger.info('stream engine: ' + h.name + ' ' + (h.version || ''));
                this._dirty = true;
                if (!this._saved.duid) {
                    return e.ask({ op: 'duid' }).then((d) => { this._saved.duid = d.duid; this._save(); logger.info('this car\'s PSN device id made'); },
                        (err) => logger.warn('PSN device id: ' + err.message));
                }
                return undefined;
            }, (err) => logger.warn('stream engine hello: ' + err.message));
        });
        e.on('lost', () => { this._engineInfo = null; if (this._view === 'play') this._endPlay('the stream engine went away'); this._dirty = true; });
        e.on('session', (m) => {
            this._session = { state: m.state, reason: m.reason || null, fps: m.fps, kbps: m.kbps };
            if (m.state === 'ended') logger.info('stream ended' + (m.reason ? ': ' + m.reason : ''));
            else if (m.state === 'streaming' && (!this._sessionLogged)) { this._sessionLogged = true; logger.info('streaming'); }
            this._dirty = true;
        });
        v.connect();
        e.connect();
        if (this._saved.console) setTimeout(() => this._find(true), 3000);
    }

    _videoEvent(m) {
        const vid = this._video;
        if (m.what === 'test') {
            if (m.state === 'playing') vid.testing = true;
            if (m.state === 'stopped' || m.state === 'failed') {
                vid.testing = false;
                if (m.fps) { vid.fps = m.fps; vid.target = m.target || vid.target; }
                logger.info('video test: ' + (m.state === 'failed' ? 'failed: ' + (m.reason || '') : (m.fps ? m.fps.toFixed(1) + ' fps of ' + m.target : 'stopped')));
                if (m.state === 'failed') { this._note = 'Video test failed: ' + (m.reason || 'see the logs'); this._warn = true; }
                else this._note = null;
            }
        } else if (m.what === 'stream' && m.fps !== undefined && m.fps !== null) {
            this._streamFps = m.fps;
        }
        this._dirty = true;
    }

    /* the speed (Vehicle2.statusCarSpeed2: 1/64 km/h, 65535 none; as Seat Lights reads it) */
    _watchSpeed() {
        const speed = (v) => {
            const raw = v && v.speedVehicleCentreOfGravity;
            if (typeof raw !== 'number' || raw === 65535) return;
            this._gate.speed(raw * 0.015625);
        };
        this._link.open('de.bmw.infotainment.vehicle.Vehicle2', '1', { fields: { statusCarSpeed2: speed } })
            .catch(() => logger.warn('speed not available: play stays off (it needs to know the car is parked)'));
        this._timers.push(setInterval(() => this._gate.tick(), 1000));
    }

    /* moving: stop everything on the screen at once */
    _moving() {
        if (this._view === 'play') this._endPlay('the car is moving');
        if (this._video.testing) { this._videoLink.ask({ op: 'stop' }).catch(() => null); this._video.testing = false; }
        this._note = 'Remote Play works only while parked.';
        this._warn = true;
    }

    /* ---- what the buttons do ---- */
    _press(name) {
        const now = Date.now();
        this._pressedAt = this._pressedAt || {};
        if (now - (this._pressedAt[name] || 0) < 400) return;        // the same press by both paths
        this._pressedAt[name] = now;
        const keypad = /^rpK(\d)$/.exec(name);
        if (keypad && this._view === 'pin') { if (this._pin.length < 8) this._pin += keypad[1]; }
        else if (name === 'rpKDel' && this._view === 'pin') this._pin = this._pin.slice(0, -1);
        else if (name === 'rpKPair' && this._view === 'pin') this._pair();
        else if (name === 'rpSignIn') this._openSignIn();
        else if (name === 'rpSignOut') { this._saved.account = null; this._saved.remote = null; this._access = null; this._save(); logger.info('signed out (the PSN token deleted)'); }
        else if (name === 'rpFind') this._find(false);
        else if (name === 'rpWake') this._wake();
        else if (name === 'rpPair') { this._pin = ''; this._note = null; this._warn = false; this._view = 'pin'; }
        else if (name === 'rpTest') this._test();
        else if (name === 'rpPlay') this._play();
        else if (name === 'rpLogs') { this._view = this._view === 'logs' ? 'home' : 'logs'; this._logPage = 0; this._written = {}; }
        else if (name === 'rpOlder' && this._view === 'logs') this._logPage = Math.min(this._logPage + 1, ui.logPages(logger.lines.length, this._perPage()) - 1);
        else if (name === 'rpNewer' && this._view === 'logs') this._logPage = Math.max(0, this._logPage - 1);
        else if (name === 'rpClose') this._close();
        this._dirty = true;
        this._render();
    }

    _close() {
        if (this._view === 'signin') this._signIn.stop();
        if (this._view === 'pin' && this._pairing) return;
        this._view = 'home';
        this._note = null; this._warn = false;
        this._written = {};
    }

    _openSignIn() {
        this._view = 'signin';
        this._signIn.start().then((url) => {
            this._signUrl = url;
            this._qr = null;
            try { if (url) this._qr = qr.encode(url); } catch (e) { logger.warn('QR: ' + e.message); }
            if (!url) { this._note = 'The car has no network address: switch on its Wi-Fi hotspot.'; this._warn = true; }
            else logger.info('sign-in page: ' + url.replace(/\/s\/.*/, '/s/...'));
            this._dirty = true;
        });
    }

    /* signed in with a PSN token made for this car's device id: play over the internet is possible */
    _canInternet() { const a = this._saved.account; return !!(a && a.refreshToken && a.duid); }

    /* a fresh enough access token: kept in memory, refreshed from the saved refresh token (which Sony may rotate) */
    _token() {
        const a = this._saved.account;
        if (this._access && this._access.expiresAt - Date.now() > TOKEN_MARGIN_MS) return Promise.resolve(this._access.token);
        if (!a || !a.refreshToken) return Promise.reject(new Error('not signed in for play over the internet: sign in again'));
        return refresh(a.refreshToken).then((t) => {
            this._access = { token: t.accessToken, expiresAt: t.expiresAt };
            if (t.refreshToken !== a.refreshToken) { a.refreshToken = t.refreshToken; this._save(); }
            return t.accessToken;
        }, (err) => {
            if (/refused the sign-in/.test(err.message)) { a.refreshToken = null; this._save(); }
            throw err;
        });
    }

    /* the account's consoles through PSN: the one with the local console's name, or the first with Remote Play on */
    _findRemote(quiet) {
        if (!this._canInternet() || !this._engine.ready || this._remoteSearching) return;
        this._remoteSearching = true;
        this._dirty = true;
        this._token()
            .then((token) => this._engine.ask({ op: 'devices', token: token }, 30000))
            .then((r) => {
                const list = r.devices || [];
                const local = this._saved.console;
                const pick = list.filter((d) => local && d.name === local.name)[0] || list.filter((d) => d.type === 'PS5' && d.remotePlay)[0] ||
                    list.filter((d) => d.remotePlay)[0] || list[0] || null;
                this._saved.remote = pick;
                this._save();
                logger.info('PSN: ' + (list.length ? list.map((d) => d.name + ' (' + d.type + (d.remotePlay ? '' : ', Remote Play off') + ')').join('; ') : 'no consoles on the account'));
                if (!quiet && !pick) { this._note = 'No console on your PlayStation account. Has it been used with this account, with Remote Play on?'; this._warn = true; }
            }, (err) => {
                logger.warn('PSN consoles: ' + err.message);
                if (!quiet) { this._note = 'Over the internet: ' + err.message; this._warn = true; }
            })
            .then(() => { this._remoteSearching = false; this._dirty = true; });
    }

    /* where Play goes: the console answering on this network (paired), else through PSN */
    _route() {
        const c = this._saved.console, reg = this._saved.registered;
        if (c && c.state === 'ready' && reg) return 'local';
        if (this._saved.remote && this._canInternet()) return 'internet';
        return null;
    }

    _find(quiet) {
        this._findRemote(true);
        if (this._searching) return;
        this._searching = true;
        this._dirty = true;
        const saved = this._saved.console;
        this._discovery.search({ timeoutMs: 2500 })
            .then((list) => (list.length || !saved ? list : this._discovery.search({ host: saved.host, timeoutMs: 1500 })))
            .then((list) => {
                this._searching = false;
                if (!list.length) {
                    if (saved) this._saved.console = Object.assign({}, saved, { state: 'gone' });
                    if (!quiet && !this._saved.remote) { this._note = 'No PlayStation found on the car\'s network. Sign in to play your PS5 at home over the internet.'; this._warn = true; }
                    logger.info('no console found');
                } else {
                    const same = saved && list.filter((c) => c.id === saved.id || c.host === saved.host)[0];
                    const c = same || list[0];
                    this._saved.console = c;
                    this._save();
                    this._note = null; this._warn = false;
                    logger.info('console: ' + list.map((x) => x.name + ' (' + x.type + ', ' + x.host + ', ' + x.state + ')').join('; '));
                }
                this._dirty = true;
            });
    }

    _wake() {
        const c = this._saved.console, reg = this._saved.registered;
        if (!c || !reg || !reg.registKey) return;
        this._discovery.wake(c, reg.registKey).then(() => {
            this._note = 'Waking ' + c.name + '...'; this._warn = false;
            setTimeout(() => this._find(true), 8000);
            setTimeout(() => this._find(true), 20000);
        }, (err) => { this._note = 'Wake failed: ' + err.message; this._warn = true; }).then(() => { this._dirty = true; });
    }

    _pair() {
        const c = this._saved.console, acc = this._saved.account;
        if (this._pairing || this._pin.length !== 8 || !c || !acc) return;
        this._pairing = true;
        this._note = 'Pairing with ' + c.name + '...'; this._warn = false;
        logger.info('pairing with ' + c.name + ' (' + c.host + ')');
        this._engine.ask({ op: 'register', host: c.host, type: c.type, accountId: acc.accountId, pin: this._pin }, 30000)
            .then((r) => {
                this._saved.registered = Object.assign({ nickname: c.name, consoleId: c.id }, r.registered || {});
                this._save();
                logger.info('paired with ' + c.name);
                this._note = 'Paired with ' + c.name + '.'; this._warn = false;
                this._view = 'home';
            }, (err) => {
                logger.warn('pairing failed: ' + err.message);
                this._note = 'Pairing failed: ' + err.message + '. Check the PIN (it changes every few minutes) and that you signed in with the console\'s account.';
                this._warn = true;
                this._pin = '';
            })
            .then(() => { this._pairing = false; this._dirty = true; });
    }

    _videoRect() { return this._placement ? ui.toScreen(this._placement, this._lay.video) : null; }

    _test() {
        if (!this._gate.parked) { this._moving(); return; }
        const s = this._saved.stream;
        this._video.testing = true;
        this._video.size = s.width + 'x' + s.height;
        this._video.target = s.fps;
        this._note = 'Video test: a moving picture for 8 seconds, ' + s.width + 'x' + s.height + ' at ' + s.fps + ' fps.'; this._warn = false;
        this._videoLink.ask({ op: 'test', width: s.width, height: s.height, fps: s.fps, seconds: 8, rect: this._videoRect() })
            .then((r) => logger.info('video test' + (r.throughDecoder ? ' (encoded and decoded, as a stream is)' : ' (no encoder here: the display only)')),
                (err) => { this._video.testing = false; this._note = 'Video test: ' + err.message; this._warn = true; this._dirty = true; });
    }

    _play() {
        const route = this._route(), p = this._video.probe;
        if (!this._gate.parked) { this._moving(); return; }
        if (!route || !this._engine.ready || !this._video.tool) return;
        const internet = route === 'internet';
        const c = internet ? this._saved.remote : this._saved.console;
        const s = this._saved.stream;
        const codec = p && p.hardwareH265 ? 'h265' : 'h264';
        const video = { socket: STREAM_SOCKET, codec: codec, width: s.width, height: s.height, fps: s.fps,
            bitrateKbps: internet ? s.remoteBitrateKbps : s.bitrateKbps, rect: this._videoRect() };
        const accountId = this._saved.account && this._saved.account.accountId;
        this._view = 'play';
        this._session = { state: 'connecting', reason: internet ? 'over the internet' : null };
        this._sessionLogged = false;
        this._pad.release();
        this._written = {};
        logger.info('play: ' + c.name + (internet ? ' over the internet' : ' on this network') + ', ' + s.width + 'x' + s.height + ' ' + s.fps + ' fps ' + codec + ', ' + video.bitrateKbps + ' kbps');
        const start = internet
            ? this._token().then((token) => this._engine.ask({ op: 'start', type: c.type, accountId: accountId,
                remote: { token: token, consoleId: c.consoleId, portGuessing: 1 }, video: video }, 30000))
            : this._engine.ask({ op: 'start', host: c.host, type: c.type, registered: this._saved.registered, accountId: accountId, video: video }, 30000);
        start.catch((err) => this._endPlay('could not start: ' + err.message));
    }

    _endPlay(why) {
        if (this._view !== 'play') return;
        logger.info('play ended: ' + why);
        this._pad.release();
        this._sendInput(true);
        this._engine.ask({ op: 'stop' }, 5000).catch(() => null);
        this._videoLink.ask({ op: 'stop' }, 5000).catch(() => null);
        this._view = 'home';
        this._session = null;
        this._note = 'Stream ended: ' + why; this._warn = why !== 'Exit';
        this._written = {};
        this._dirty = true;
    }

    /* the controller to the engine: on each change, and unchanged every INPUT_KEEP_MS while playing */
    _sendInput(force) {
        if (this._view !== 'play' || !this._engine.ready) return;
        const now = Date.now();
        let st = this._usbPad ? this._usbPad.state : this._pad.take();
        if (!st && !force && now - this._inputAt < INPUT_KEEP_MS) return;
        if (!st) st = this._usbPad ? this._usbPad.state : this._pad.state;
        this._inputAt = now;
        this._engine.tell({ op: 'input', state: st });
    }

    _perPage() { return this._gpu && this._gpu.ready ? ui.LOG_PER_PAGE : LINE_ROWS; }

    _model() {
        const c = this._saved.console;
        return {
            view: this._view, focus: this._ui.focus, pressed: this._ui.pressed, note: this._note, warn: this._warn,
            account: this._saved.account, console: c, consoleName: this._route() === 'internet' ? this._saved.remote.name : c && c.name,
            searching: this._searching || !!this._remoteSearching, paired: this._saved.registered,
            remote: this._saved.remote, internet: this._canInternet(), route: this._route(),
            engine: this._engineInfo, video: this._video, pad: this._usbPad && this._usbPad.name, parked: this._gate.parked,
            url: this._signUrl, qr: this._view === 'signin' ? this._qr : null, pin: this._pin, pairing: this._pairing,
            session: this._session, input: this._view === 'play' ? (this._usbPad ? this._usbPad.state : this._pad.state) : null,
            logs: this._view === 'logs' ? logger.lines : null, logPage: this._logPage,
        };
    }

    /* ---- the HMI ---- */
    _setupRhmi() {
        const rhmi = this.rhmiApplication;
        this._state = rhmi.getByName(STATE);
        if (!this._state) return Promise.reject(new Error('uiDescription has no ' + STATE));
        this._comps[STATUS] = rhmi.getByName(STATUS);
        LIST_BUTTONS.forEach((name) => {
            const comp = rhmi.getByName(name);
            if (!comp) { logger.warn('uiDescription has no ' + name); return; }
            this._comps[name] = comp;
            try { this._byId[Number(comp.getId())] = name; } catch (e) { /* events from the component only */ }
            comp.on('action', () => this._listPress(name));
            comp.on('focus', (ev) => this._focus(name, isTrue(ev && ev.value)));
        });
        for (let i = 0; i < LINE_ROWS; i++) this._comps['rpLine' + i] = rhmi.getByName('rpLine' + i);
        rhmi.on('userEvent', (ev) => {
            const name = ev && this._byId[Number(ev.sourceId)];
            if (!name) return;
            if (ev.eventType === 'ACTION') this._listPress(name);
            if (ev.eventType === 'FOCUS') this._focus(name, isTrue((ev.parameterMap || {})[0]));
        });
        rhmi.on('applicationStackChanged', (stack) => {
            const keys = stack && typeof stack === 'object' ? Object.keys(stack) : [];
            if (keys.length) this._setVisible(Object.prototype.hasOwnProperty.call(stack, 'ROOT_APP'));
        });
        rhmi.on('restoreHmi', () => { this._written = {}; this._render(); });
        this._state.on('visible', (ev) => { if (ev && isTrue(ev.value)) this._setVisible(true); });
        return Promise.resolve();
    }

    /* the plain list's rows: during Play the drawn controls have the screen, so the list does nothing */
    _listPress(name) {
        if (this._view === 'play') return;
        if (name === 'rpLogs' && this._view !== 'logs' && this._view !== 'home') this._view = 'home';
        this._press(name);
    }

    _pushRows() {
        if (!this._state || !this._state.updateResources) return Promise.resolve();
        return within(this._state.updateResources(), 4000, 'screen resources').then(() => { this._written = {}; this._render(); });
    }

    _registerEntryPoint() {
        const descriptions = (this.appDescription && this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find((ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) return Promise.reject(new Error('no entry point handed over by the manager'));
        const description = ours.getDescription();
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(description.uuid, this._state))
            .then(() => ours.setAvailability('ENABLED'))
            .then(() => logger.info('entry point ' + description.name + ' ENABLED'));
    }

    _open(uuid, tries) {
        if (this._shutdown || !this.rhmiApplication || !uuid) return Promise.resolve();
        if (this._opening) return this._opening;
        if (tries === undefined) tries = 3;
        let again = false;
        this._opening = this._pushRows()
            .then(() => this.rhmiApplication.openEntryState(uuid))
            .then(() => { this._setVisible(true); this._written = {}; this._render(); })
            .catch((err) => {
                const text = String(err && err.message ? err.message : err) + ' ' + JSON.stringify(err || {});
                if (tries > 1 && /INVALID/.test(text)) again = true;
                else logger.warn('openEntryState failed: ' + text);
            })
            .then(() => { this._opening = null; if (again) setTimeout(() => this._open(uuid, tries - 1), 800); });
        return this._opening;
    }

    _setVisible(visible) {
        if (this._shutdown || this._visible === visible) return;
        this._visible = visible;
        if (!visible && this._view === 'play') this._endPlay('the app was closed');
        if (!visible && this._view === 'signin') { this._signIn.stop(); this._view = 'home'; }
        this._syncGpu();
        if (visible) { this._written = {}; this._render(); }
        const reports = visible ? [this.registerActive(), this.registerHmiVisible()] : [this.unregisterHmiVisible(), this.registerInactive()];
        reports.forEach((r) => Promise.resolve(r).catch((err) => logger.warn('app status report failed: ' + (err && err.message))));
    }

    _set(name, cell, value) {
        const comp = this._comps[name];
        const key = name + '.' + cell;
        if (!comp || this._written[key] === value) return;
        this._written[key] = value;
        Promise.resolve(comp.setValue(0, cell, value, typeof value === 'boolean' ? 'Bool' : 'Text'))
            .catch((err) => logger.warn('render ' + key + ' failed: ' + (err && err.message)));
    }

    /* the plain list: a status line, the buttons the list can do, and the log */
    _render() {
        this._dirty = false;
        if (!this.rhmiApplication || !this._state) return;
        const m = this._model(), logs = this._view === 'logs';
        const status = this._view === 'signin' && m.url ? 'Open ' + m.url + ' on a phone on the car\'s hotspot'
            : m.note || [m.account ? 'Signed in' : 'Not signed in', m.console ? m.console.name + ' ' + (m.console.state || '') : 'no console',
                m.paired ? 'paired' : 'not paired', m.engine ? 'engine ready' : 'no engine', m.parked ? 'parked' : 'not parked'].join(' · ');
        this._set(STATUS, 'Text', status);
        this._set('rpSignIn', 'PrimaryText', logs ? '' : m.account ? 'Signed in' + (m.account.onlineId ? ' as ' + m.account.onlineId : '') : 'Sign in (shows the address)');
        this._set('rpFind', 'PrimaryText', logs ? '' : 'Find the console');
        this._set('rpWake', 'PrimaryText', logs ? '' : 'Wake the console');
        this._set('rpTest', 'PrimaryText', logs ? '' : 'Video test' + (m.video.fps ? ': ' + m.video.fps.toFixed(1) + ' fps' : ''));
        this._set('rpLogs', 'PrimaryText', logs ? 'Close the logs' : 'Logs');
        this._set('rpOlder', 'PrimaryText', logs ? 'Older' : '');
        this._set('rpNewer', 'PrimaryText', logs ? 'Newer' : '');
        const lines = logs ? ui.logLines(logger.lines, this._logPage, LINE_ROWS) : [];
        for (let i = 0; i < LINE_ROWS; i++) this._set('rpLine' + i, 'PrimaryText', lines[i] ? ui.logText(lines[i]) : '');
        Promise.resolve(this.rhmiApplication.flush && this.rhmiApplication.flush()).catch(() => { /* next render */ });
    }

    /* ---- the drawn screen ---- */
    _startGpu() {
        if (this._gpu) return;
        const gpu = new Gpu('ida_remoteplay', logger);
        this._gpu = gpu;
        gpu.on('ready', (scr, area) => {
            const a = area && area.w >= 1000 && area.h >= 400 ? area : scr.w === 2880 ? ID8_AREA : { x: 0, y: 0, w: scr.w, h: scr.h };
            this._placement = ui.placement(a);
            gpu.place(this._placement);
            this._ui.key = '';
            this._syncGpu();
        });
        gpu.on('touch', (phase, x, y) => this._touch(phase, x, y));
        gpu.on('closed', () => setTimeout(() => this._syncGpu(true), 700));
        gpu.on('lost', () => { this._ui.key = ''; });
        gpu.connect();
        this._ui.timer = setInterval(() => this._frame(), FRAME_MS);
        this._ui.playTimer = setInterval(() => { if (this._view === 'play') { this._sendInput(false); this._frame(); } }, PLAY_FRAME_MS);
    }

    _syncGpu(again) {
        const gpu = this._gpu;
        if (!gpu) return;
        const on = this._visible && gpu.ready && !this._shutdown;
        if (again && on) gpu.visible = false;
        gpu.show(on);
        if (on) { this._ui.key = ''; this._frame(); }
    }

    _frame() {
        const gpu = this._gpu, u = this._ui;
        if (!gpu || !gpu.ready || !gpu.visible) return;
        const m = this._model();
        const last = logger.lines[logger.lines.length - 1];
        const key = JSON.stringify(Object.assign({}, m, { qr: m.qr ? m.url : null, logs: m.logs ? m.logs.length + ':' + (last && last.t + last.text) : null }));
        const now = Date.now();
        if (gpu.waiting && now - gpu.sentAt < 1000) return;
        if (key === u.key && now - gpu.sentAt < 1000) return;
        u.key = key;
        u.targets = ui.draw(u.rec, m, this._lay).targets;
        // in Play, only the controls take touches: the game's picture in the middle is left alone
        gpu.claim(this._view === 'play' ? u.targets.map((t) => ({ x: t.x, y: t.y, w: t.w, h: t.h })) : [{ x: 0, y: 0, w: ui.W, h: ui.H }]);
        gpu.frame(u.rec);
    }

    _focus(name, on) {
        if (on) this._ui.focus = name;
        else if (this._ui.focus === name) this._ui.focus = null;
    }

    _touch(phase, x, y) {
        if (this._view === 'play') {
            if (this._pad.touch(phase, x, y) === 'exit') this._endPlay('Exit');
            this._sendInput(false);
            this._frame();
            return;
        }
        const u = this._ui, t = ui.hit(u.targets, x, y);
        if (phase === 1) { u.down = t ? t.key : null; u.pressed = u.down; return; }
        if (phase === 2) { if (!t || t.key !== u.down) u.pressed = null; return; }
        if (phase !== 3) return;
        const key = u.down;
        u.down = null;
        setTimeout(() => { if (!u.down) u.pressed = null; }, 150);
        if (t && t.key === key) this._press(key);
    }

    _stop(reason) {
        if (this._shutdown) return this._shutdown;
        logger.info('shutting down (' + reason + ')');
        if (this._view === 'play') this._endPlay('the app stopped');
        this._timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
        clearInterval(this._ui.timer);
        clearInterval(this._ui.playTimer);
        this._signIn.stop();
        if (this._gpu) this._gpu.close();
        this._shutdown = within(Promise.all([this._videoLink.ask({ op: 'stop' }, 1500).catch(() => null)]), 2000, 'video stop')
            .then(() => { this._videoLink.close(); this._engine.close(); return this._link.stop(); })
            .then(() => this.destroyBundles().catch((err) => logger.info('destroyBundles: ' + (err && err.message))))
            .then(() => process.exit(0));
        return this._shutdown;
    }
}

const app = new RemotePlayApp();
app.start().catch((err) => { logger.error('failed to start: ' + (err && err.message)); });
