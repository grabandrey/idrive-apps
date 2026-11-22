'use strict';
/*
 * AirPlay: an iPhone's or iPad's screen on the car's screen, parked. An iDrive 8 app:
 *
 *   Receiver     while the app is open and the car parked, the car is an AirPlay receiver ("iDrive") on the car's
 *                networks: the car's hotspot, or a phone's hotspot the car is on. On the phone: Control Center >
 *                Screen Mirroring > iDrive. A new phone types a 4-digit PIN the car shows, once (or no PIN: "open")
 *   Mirror       the phone's screen, decoded in hardware by the video tool, right of a band with the picture's shape:
 *                Fit (the phone's own shape), Stretch (the whole area), 16:9, 16:10, 4:3, 21:9, 1:1. The shape changes
 *                at once while the phone mirrors; it's kept for next time. Disconnect drops the phone.
 *
 * Only while parked: the speed (Vehicle2.statusCarSpeed2) must read 0 (within the last 5 s) for the receiver to be on,
 * and anything over 3 km/h drops the phone and the picture at once.
 *
 * The parts (links.js): the video tool (ida-remoteplay-video, Remote Play's, root: GStreamer) and the AirPlay engine
 * (ida-airplay-engine, root: UxPlay's library). The screen is drawn by MGU Store's Renderer (gpu.js, ui.js); the plain
 * HMI list underneath has the status, the receiver on/off, the picture's shape (each press the next one), the access
 * and the log. Built on the head unit by MGU Store against the car's own oap-sdk (mgu-app.json).
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { SomeipLink } = require('./someip_link.js');
const { Gpu } = require('./gpu.js');
const ui = require('./ui.js');
const { JsonLink, VIDEO_SOCKET, ENGINE_SOCKET, STREAM_SOCKET } = require('./links.js');
const { LogRing } = require('./log_ring.js');
const { Gate } = require('./gate.js');

const SETTINGS = settingsFile('airplay.json');
const logger = new LogRing(logging.getSDKLogger(), SETTINGS ? path.join(path.dirname(SETTINGS), 'airplay.log') : null);

const STATE = 'ST_OnlineApps_AirPlay';
const STATUS = 'apStatus';
const LIST_BUTTONS = ['apToggle', 'apAspect', 'apAccess', 'apForget', 'apLogs', 'apOlder', 'apNewer'];
const LINE_ROWS = 30;
const RENDER_MS = 1000;
const FRAME_MS = 100;
const PIN_MS = 120000;              // the PIN stays on the screen this long (or until the phone mirrors)
const ID8_AREA = { x: 0, y: 76, w: 2880, h: 764 };
const DEFAULTS = { name: 'iDrive', access: 'pin', aspect: 'fit', enabled: true };
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

/* a receiver name the phone can show: letters, digits, spaces and - _ ' only, at most 40 */
function cleanName(n) {
    const s = String(n || '').replace(/[^A-Za-z0-9 _'-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    return s || DEFAULTS.name;
}

/* the car's addresses a phone can reach: private IPv4, as the engine announces on */
function addresses() {
    const out = [], all = os.networkInterfaces();
    Object.keys(all).forEach((name) => (all[name] || []).forEach((a) => {
        if (a.family !== 'IPv4' && a.family !== 4) return;
        if (a.internal || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return;
        out.push(a.address);
    }));
    return out;
}

class AirPlayApp extends OnlineApp {
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
        this._saved = Object.assign({}, DEFAULTS, saved);
        this._saved.name = cleanName(this._saved.name);
        if (ui.ASPECTS.indexOf(this._saved.aspect) < 0) this._saved.aspect = DEFAULTS.aspect;
        if (this._saved.access !== 'open') this._saved.access = 'pin';

        this._view = 'home';
        this._logPage = 0;
        this._note = null;
        this._warn = false;
        this._engineInfo = null;
        this._receiver = { on: false, name: null, error: null, busy: false };
        this._phone = null;                  // { name, model, state }
        this._pin = null;                    // { pin, at }
        this._mirror = null;                 // { state: 'waiting'|'playing'|'paused', reason }
        this._video = { tool: false, probe: null, fps: null };
        this._videoLink = new JsonLink('video tool', VIDEO_SOCKET, logger);
        this._engine = new JsonLink('AirPlay engine', ENGINE_SOCKET, logger);
        this._link = new SomeipLink(logger);
        this._gate = new Gate({ log: logger });
        this._gate.on('change', (parked) => { this._dirty = true; if (!parked) this._moving(); this._sync(); });
        logger.on('line', () => { if (this._view === 'logs') this._dirty = true; });

        this.on('initialized', () => { this._init().catch((err) => logger.error('init failed: ' + (err && err.message))); });
        this.on('shutdown', (reason) => this._stop(reason));
        this.on('error', (err) => logger.warn('OnlineApp error: ' + (err && err.message)));
        this.on('entryPointExecute', (uuid) => this._open(uuid));
        this.on('changeVisibility', (data) => { if (data && data.visible === false) this._setVisible(false); });
    }

    _save() {
        try { if (SETTINGS) fs.writeFileSync(SETTINGS, JSON.stringify(this._saved, null, 1)); } catch (e) { logger.warn('not saved: ' + e.message); }
    }

    _init() {
        logger.info('AirPlay ' + this.getAppId() + ' starting; settings ' + (SETTINGS || 'not kept'));
        this._startLinks();
        this._watchSpeed();
        this._timers.push(setInterval(() => { if (this._dirty) this._render(); }, RENDER_MS));
        this._timers.push(setInterval(() => {
            if (this._pin && Date.now() - this._pin.at > PIN_MS) { this._pin = null; this._dirty = true; }
            this._sync();
        }, 2000));
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
                logger.info('video: ' + (p.gst ? 'GStreamer ' + p.gst + ' (' + p.via + '), decoder ' + (p.decoder || 'none') + (p.hardware ? ' (hardware)' : '') +
                    ', display ' + (p.sink || 'none') + (p.capssetter === false ? ', no capssetter (shapes by the rectangle alone)' : '') : p.error));
                if (p.why) logger.warn('video: ' + p.why);
                this._dirty = true;
                this._sync();
            }, (err) => logger.warn('video probe: ' + err.message));
        });
        v.on('lost', () => { this._video.tool = false; this._video.probe = null; this._dirty = true; });
        v.on('video', (m) => this._videoEvent(m));
        e.on('ready', () => {
            e.ask({ op: 'hello' }).then((h) => {
                this._engineInfo = { name: h.name, version: h.version };
                logger.info('AirPlay engine: ' + h.name + ' ' + (h.version || '') + ', id ' + h.deviceId);
                this._dirty = true;
                this._sync();
            }, (err) => logger.warn('AirPlay engine hello: ' + err.message));
        });
        e.on('lost', () => {
            this._engineInfo = null;
            this._receiver.on = false; this._receiver.busy = false; this._receiver.net = null;
            this._phone = null; this._pin = null;
            if (this._view === 'mirror') this._endMirror('the AirPlay engine went away');
            this._dirty = true;
        });
        e.on('client', (m) => {
            this._phone = { name: m.name || 'A phone', model: m.model || null, state: 'connecting' };
            logger.info('phone: ' + this._phone.name + (m.model ? ' (' + m.model + ')' : ''));
            this._dirty = true;
        });
        e.on('pin', (m) => {
            this._pin = { pin: m.pin, at: Date.now() };
            logger.info('PIN shown for the phone');
            if (this._view !== 'home') { this._view = 'home'; this._written = {}; }
            this._dirty = true;
        });
        e.on('mirror', (m) => this._mirrorEvent(m));
        e.on('net', (m) => {
            this._receiver.net = m.how || null;
            if (m.how) logger.info('the phone finds the car ' + (/Bonjour/.test(m.how) ? m.how : 'on ' + m.how));
            this._dirty = true;
        });
        e.on('conn', (m) => { if (!m.open && this._phone && this._view !== 'mirror') { this._phone.state = 'disconnected'; this._dirty = true; } });
        v.connect();
        e.connect();
    }

    _mirrorEvent(m) {
        if (m.state === 'started') {
            if (!this._gate.parked || !this._visible) { this._engine.ask({ op: 'stop' }).catch(() => null); this._receiver.on = false; return; }
            this._pin = null;
            if (this._phone) this._phone.state = 'mirroring';
            else this._phone = { name: 'A phone', state: 'mirroring' };
            this._mirror = { state: 'waiting', reason: m.width ? m.width + 'x' + m.height + ' ' + (m.codec || '').toUpperCase() : null };
            logger.info('mirroring: ' + (m.width ? m.width + 'x' + m.height : '') + ' ' + (m.codec || ''));
            this._view = 'mirror';
            this._written = {};
        } else if (m.state === 'paused' && this._mirror) {
            this._mirror.state = 'paused';
        } else if (m.state === 'resumed' && this._mirror) {
            this._mirror.state = 'playing';
        } else if (m.state === 'stopped') {
            if (this._phone) this._phone.state = 'disconnected';
            if (this._view === 'mirror') this._endMirror(m.reason || 'the phone stopped mirroring');
        }
        this._dirty = true;
        this._frame();
    }

    _videoEvent(m) {
        if (m.what !== 'stream') return;
        if (m.state === 'playing' && this._mirror && this._mirror.state === 'waiting' && m.frames) this._mirror.state = 'playing';
        if (m.state === 'playing') this._video.fps = m.fps;
        if (m.state === 'view') logger.info('picture: ' + ui.aspectLabel(m.aspect || 'fit') + (m.size ? ', ' + m.size.width + 'x' + m.size.height : '') + ' in ' + JSON.stringify(m.rect) +
            (m.exact === false ? ' (this display keeps the picture\'s own shape: no capssetter)' : ''));
        if (m.state === 'failed') { logger.warn('video failed: ' + (m.reason || '')); this._note = 'The picture failed: ' + (m.reason || 'see the logs'); this._warn = true; }
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
            .catch(() => logger.warn('speed not available: the receiver stays off (it needs to know the car is parked)'));
        this._timers.push(setInterval(() => this._gate.tick(), 1000));
    }

    /* moving: the phone dropped and the picture gone at once */
    _moving() {
        if (this._view === 'mirror') this._endMirror('the car is moving');
        this._note = 'AirPlay works only while parked.';
        this._warn = true;
    }

    /* where the phone's screen goes: the area right of the band, in screen px */
    _videoArea() {
        const pl = this._placement || ui.placement(ID8_AREA);
        return ui.toScreen(pl, ui.VIDEO);
    }

    _videoSpec() {
        return { socket: STREAM_SOCKET, rect: this._videoArea(), aspect: this._saved.aspect, fps: 60 };
    }

    /* the receiver on exactly while it should be: the app on the screen, parked, switched on, both parts there */
    _sync() {
        const r = this._receiver;
        if (r.busy || this._shutdown) return;
        const want = !!(this._visible && this._gate.parked === true && this._saved.enabled && this._engine.ready && this._video.tool);
        if (want && !r.on) {
            r.busy = true;
            this._engine.ask({ op: 'start', name: this._saved.name, access: this._saved.access, video: this._videoSpec() }, 15000).then((res) => {
                r.on = true; r.name = res.name; r.error = null;
                logger.info('receiver on: "' + res.name + '" (' + (this._saved.access === 'open' ? 'open' : 'PIN') + ') on ' + (addresses().join(', ') || 'no private network yet'));
            }, (err) => {
                if (r.error !== err.message) logger.warn('receiver: ' + err.message);
                r.on = false; r.error = err.message;
            }).then(() => { r.busy = false; this._dirty = true; });
        } else if (!want && r.on) {
            r.busy = true;
            this._engine.ask({ op: 'stop' }, 8000).catch((err) => logger.warn('receiver stop: ' + err.message)).then(() => {
                r.on = false; r.busy = false; r.net = null; this._pin = null;
                logger.info('receiver off');
                this._dirty = true;
            });
        }
    }

    /* the picture's shape: kept, and given to the playing stream and the engine (for the next one) at once */
    _setAspect(a) {
        if (ui.ASPECTS.indexOf(a) < 0 || a === this._saved.aspect) return;
        this._saved.aspect = a;
        this._save();
        logger.info('picture shape: ' + ui.aspectLabel(a));
        if (this._engine.ready) this._engine.ask({ op: 'view', video: { aspect: a, rect: this._videoArea() } }).catch(() => null);
        if (this._videoLink.ready) this._videoLink.ask({ op: 'view', aspect: a }).catch((err) => logger.warn('picture shape: ' + err.message));
    }

    _endMirror(why) {
        if (this._view !== 'mirror') return;
        logger.info('mirroring ended: ' + why);
        this._view = 'home';
        this._mirror = null;
        this._note = 'Mirroring ended: ' + why; this._warn = why !== 'Disconnect';
        this._written = {};
        this._dirty = true;
        // the phone dropped (Disconnect, moving, the app closed): the receiver starts again if it should
        if (this._receiver.on) {
            this._receiver.busy = true;
            this._engine.ask({ op: 'stop' }, 8000).catch(() => null).then(() => { this._receiver.on = false; this._receiver.busy = false; this._sync(); });
        }
        this._videoLink.ask({ op: 'stop' }, 5000).catch(() => null);
    }

    /* ---- what the buttons do ---- */
    _press(name) {
        const now = Date.now();
        this._pressedAt = this._pressedAt || {};
        if (now - (this._pressedAt[name] || 0) < 400) return;        // the same press by both paths
        this._pressedAt[name] = now;
        const shape = /^apA_(.+)$/.exec(name);
        if (shape) this._setAspect(shape[1]);
        else if (name === 'apAspect') this._setAspect(ui.nextAspect(this._saved.aspect));
        else if (name === 'apToggle') { this._saved.enabled = !this._saved.enabled; this._save(); logger.info('receiver switched ' + (this._saved.enabled ? 'on' : 'off')); this._sync(); }
        else if (name === 'apAccess') {
            this._saved.access = this._saved.access === 'open' ? 'pin' : 'open';
            this._save();
            logger.info('access: ' + (this._saved.access === 'open' ? 'open (no PIN)' : 'a PIN the first time'));
            if (this._receiver.on && !this._receiver.busy) { this._receiver.on = false; this._sync(); }    // start again with it (the engine restarts itself)
        } else if (name === 'apForget') {
            this._engine.ask({ op: 'forget' }).then(() => { this._note = 'Phones forgotten: each asks for a PIN again.'; this._warn = false; logger.info('paired phones forgotten'); },
                (err) => { this._note = 'Forget: ' + err.message; this._warn = true; }).then(() => { this._dirty = true; });
        } else if (name === 'apPinDone') this._pin = null;
        else if (name === 'apDisconnect') this._endMirror('Disconnect');
        else if (name === 'apLogs') { this._view = this._view === 'logs' ? 'home' : 'logs'; this._logPage = 0; this._written = {}; }
        else if (name === 'apOlder' && this._view === 'logs') this._logPage = Math.min(this._logPage + 1, ui.logPages(logger.lines.length, this._perPage()) - 1);
        else if (name === 'apNewer' && this._view === 'logs') this._logPage = Math.max(0, this._logPage - 1);
        else if (name === 'apClose') { this._view = 'home'; this._note = null; this._warn = false; this._written = {}; }
        this._dirty = true;
        this._render();
        this._frame();
    }

    _perPage() { return this._gpu && this._gpu.ready ? ui.LOG_PER_PAGE : LINE_ROWS; }

    _model() {
        return {
            view: this._view, focus: this._ui.focus, pressed: this._ui.pressed, note: this._note, warn: this._warn,
            engine: this._engineInfo, receiver: this._receiver, enabled: this._saved.enabled, access: this._saved.access, name: this._saved.name,
            aspect: this._saved.aspect, phone: this._phone, pin: this._pin && this._pin.pin, mirror: this._mirror,
            video: this._video, parked: this._gate.parked, addresses: this._view === 'home' ? addresses() : null,
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
        for (let i = 0; i < LINE_ROWS; i++) this._comps['apLine' + i] = rhmi.getByName('apLine' + i);
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

    /* the plain list's rows: during Mirror the drawn band has the controls; the shape still works from the list */
    _listPress(name) {
        if (this._view === 'mirror' && name !== 'apAspect') return;
        if (name === 'apLogs' && this._view !== 'logs' && this._view !== 'home') this._view = 'home';
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
        if (!visible && this._view === 'mirror') this._endMirror('the app was closed');
        this._syncGpu();
        if (visible) { this._written = {}; this._render(); }
        this._sync();
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
        const m = this._model(), logs = this._view === 'logs', r = m.receiver;
        const status = m.pin ? 'Type ' + m.pin + ' on the phone' : m.note || [
            !m.engine ? 'no AirPlay engine' : r.on ? 'Receiver "' + r.name + '" on' : m.enabled ? 'Receiver waiting' : 'Receiver off',
            m.phone ? m.phone.name + ' ' + (m.phone.state || '') : 'no phone', m.parked ? 'parked' : 'not parked'].join(' · ');
        this._set(STATUS, 'Text', status);
        this._set('apToggle', 'PrimaryText', logs ? '' : m.enabled ? 'Receiver: on (switch off)' : 'Receiver: off (switch on)');
        this._set('apAspect', 'PrimaryText', logs ? '' : 'Picture shape: ' + ui.aspectLabel(m.aspect) + ' (next)');
        this._set('apAccess', 'PrimaryText', logs ? '' : m.access === 'open' ? 'Access: open (ask for a PIN)' : 'Access: PIN the first time (make it open)');
        this._set('apForget', 'PrimaryText', logs ? '' : 'Forget paired phones');
        this._set('apLogs', 'PrimaryText', logs ? 'Close the logs' : 'Logs');
        this._set('apOlder', 'PrimaryText', logs ? 'Older' : '');
        this._set('apNewer', 'PrimaryText', logs ? 'Newer' : '');
        const lines = logs ? ui.logLines(logger.lines, this._logPage, LINE_ROWS) : [];
        for (let i = 0; i < LINE_ROWS; i++) this._set('apLine' + i, 'PrimaryText', lines[i] ? ui.logText(lines[i]) : '');
        Promise.resolve(this.rhmiApplication.flush && this.rhmiApplication.flush()).catch(() => { /* next render */ });
    }

    /* ---- the drawn screen ---- */
    _startGpu() {
        if (this._gpu) return;
        const gpu = new Gpu('ida_airplay', logger);
        this._gpu = gpu;
        gpu.on('ready', (scr, area) => {
            const a = area && area.w >= 1000 && area.h >= 400 ? area : scr.w === 2880 ? ID8_AREA : { x: 0, y: 0, w: scr.w, h: scr.h };
            const was = JSON.stringify(this._placement);
            this._placement = ui.placement(a);
            gpu.place(this._placement);
            this._ui.key = '';
            this._syncGpu();
            // the video's place follows the screen's
            if (was !== JSON.stringify(this._placement) && this._receiver.on) {
                const rect = this._videoArea();
                this._engine.ask({ op: 'view', video: { rect: rect } }).catch(() => null);
                this._videoLink.ask({ op: 'view', rect: rect }).catch(() => null);
            }
        });
        gpu.on('touch', (phase, x, y) => this._touch(phase, x, y));
        gpu.on('closed', () => setTimeout(() => this._syncGpu(true), 700));
        gpu.on('lost', () => { this._ui.key = ''; });
        gpu.connect();
        this._ui.timer = setInterval(() => this._frame(), FRAME_MS);
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
        const key = JSON.stringify(Object.assign({}, m, { logs: m.logs ? m.logs.length + ':' + (last && last.t + last.text) : null }));
        const now = Date.now();
        if (gpu.waiting && now - gpu.sentAt < 1000) return;
        if (key === u.key && now - gpu.sentAt < 1000) return;
        u.key = key;
        u.targets = ui.draw(u.rec, m).targets;
        // in Mirror, only the band takes touches: the phone's picture is left alone
        gpu.claim(this._view === 'mirror' ? [{ x: ui.BAND.x, y: ui.BAND.y, w: ui.BAND.w, h: ui.BAND.h }] : [{ x: 0, y: 0, w: ui.W, h: ui.H }]);
        gpu.frame(u.rec);
    }

    _focus(name, on) {
        if (on) this._ui.focus = name;
        else if (this._ui.focus === name) this._ui.focus = null;
    }

    _touch(phase, x, y) {
        const u = this._ui, t = ui.hit(u.targets, x, y);
        if (phase === 1) { u.down = t ? t.key : null; u.pressed = u.down; this._frame(); return; }
        if (phase === 2) { if (!t || t.key !== u.down) u.pressed = null; return; }
        if (phase !== 3) return;
        const key = u.down;
        u.down = null;
        setTimeout(() => { if (!u.down) { u.pressed = null; this._frame(); } }, 150);
        if (t && t.key === key) this._press(key);
    }

    _stop(reason) {
        if (this._shutdown) return this._shutdown;
        logger.info('shutting down (' + reason + ')');
        if (this._view === 'mirror') this._endMirror('the app stopped');
        this._timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
        clearInterval(this._ui.timer);
        if (this._gpu) this._gpu.close();
        this._shutdown = within(Promise.all([this._engine.ask({ op: 'stop' }, 1500).catch(() => null), this._videoLink.ask({ op: 'stop' }, 1500).catch(() => null)]), 2000, 'stop')
            .then(() => { this._videoLink.close(); this._engine.close(); return this._link.stop(); })
            .then(() => this.destroyBundles().catch((err) => logger.info('destroyBundles: ' + (err && err.message))))
            .then(() => process.exit(0));
        return this._shutdown;
    }
}

const app = new AirPlayApp();
app.start().catch((err) => { logger.error('failed to start: ' + (err && err.message)); });
