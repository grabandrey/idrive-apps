'use strict';
/*
 * DRL Colour: an iDrive 8 app that switches an aftermarket DRL module between yellow and white. The module changes
 * colour when the high beams flash three times; the app flashes them through the body controller (flasher.js),
 * after learning once which lamp outputs they are. Auto white (off until switched on) does it at each engine start.
 * The app starts with the head unit (package.json mguAppStartType autostart) so Auto white works without opening it.
 *
 * Its screen: drawn by the head unit's renderer (ui.js, gpu.js) when MGU Store's Renderer is installed (touch, or the
 * controller through the HMI list underneath), else the HMI's own list: a status line and the buttons' rows.
 * Built on the head unit by MGU Store against the car's own oap-sdk (mgu-app.json).
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { SomeipLink } = require('./someip_link.js');
const { Uds, IFACE: TASU } = require('./uds.js');
const { Flasher } = require('./flasher.js');
const { Gpu } = require('./gpu.js');
const ui = require('./ui.js');
const { LogRing } = require('./log_ring.js');

/* the app's log: the head unit's (DRLC), the Logs screen's lines, and drlcolor.log next to the settings */
const SETTINGS = settingsFile('drlcolor.json');
const logger = new LogRing(logging.getSDKLogger(), SETTINGS ? path.join(path.dirname(SETTINGS), 'drlcolor.log') : null);

const STATE = 'ST_OnlineApps_DrlColour';
const STATUS = 'dcStatus';
const FLASH = 'dcFlash', AUTO = 'dcAuto', FIX = 'dcFix', LEARN = 'dcLearn';
const LOGS = 'dcLogs', OLDER = 'dcOlder', NEWER = 'dcNewer';
const BUTTONS = [FLASH, AUTO, FIX, LEARN, LOGS, OLDER, NEWER];
const LINE_ROWS = 30;              // the plain list's log rows (dcLine0 ..)
const RENDER_MS = 1000;
const FRAME_MS = 100;
const ID8_AREA = { x: 0, y: 76, w: 2880, h: 764 };
const VALUE_KEY = 0;
const FOREGROUND_REASONS = ['ENTRY_POINT', 'LUM', 'BOOKMARK', 'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
const isTrue = (v) => v === true || v === 1 || v === 'true' || v === '1';

function within(p, ms, what) {
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => { logger.warn(what + ': no answer after ' + ms + ' ms, going on'); resolve(); }, ms); });
    return Promise.race([Promise.resolve(p), late])
        .catch((err) => logger.warn(what + ' failed: ' + (err && err.message)))
        .then((v) => { clearTimeout(timer); return v; });
}

/* the first folder of these that takes a write */
function settingsFile(name) {
    const dirs = [process.env.HOME, process.cwd(), os.tmpdir()];
    for (let i = 0; i < dirs.length; i++) {
        if (!dirs[i]) continue;
        const p = path.join(dirs[i], name);
        try { fs.appendFileSync(p, ''); return p; } catch (e) { /* next */ }
    }
    return null;
}

class DrlColourApp extends OnlineApp {
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
        this._ui = { rec: new ui.Recorder(), targets: [], focus: null, pressed: null, down: null, key: '', timer: null };

        this._file = SETTINGS;
        this._view = 'main';                // main | logs
        this._logPage = 0;
        logger.on('line', () => { this._dirty = true; });
        let saved = {};
        try { saved = JSON.parse(fs.readFileSync(this._file, 'utf8') || '{}') || {}; } catch (e) { /* first start */ }
        this._saved = saved;
        this._link = new SomeipLink(logger);
        this._uds = new Uds(this._link, logger);
        // the timing can be changed in drlcolor.json (count, onMs, offMs) for a module that wants it different
        this._flasher = new Flasher({ uds: this._uds, log: logger, outputs: saved.outputs, layout: saved.layout, statusDid: saved.statusDid,
            colour: saved.colour, auto: saved.auto, count: saved.count, onMs: saved.onMs, offMs: saved.offMs });
        this._watching = false;
        this._flasher.on('change', () => { this._dirty = true; });
        this._flasher.on('save', (st) => this._save(st));

        this.on('initialized', () => {
            this._init().catch((err) => logger.error('init failed: ' + (err && err.message)));
        });
        this.on('shutdown', (reason) => this._stop(reason));
        this.on('error', (err) => logger.warn('OnlineApp error: ' + (err && err.message)));
        this.on('entryPointExecute', (uuid) => this._open(uuid));
        this.on('changeVisibility', (data) => { if (data && data.visible === false) this._setVisible(false); });
    }

    /* the flasher's state, with the file's own settings (the timing) kept */
    _save(st) {
        this._saved = Object.assign({}, this._saved, st);
        try { if (this._file) fs.writeFileSync(this._file, JSON.stringify(this._saved)); } catch (e) { logger.warn('not saved: ' + e.message); }
    }

    _init() {
        const f = this._flasher.state;
        logger.info('DRL Colour ' + this.getAppId() + ' starting; ' + (f.ready ? 'high beams on lamp output ' + f.outputs.join(', ') : 'not learned yet') +
            ', colour ' + (f.colour || 'not known') + ', auto white ' + (f.auto ? 'ON' : 'OFF') + ', settings ' + (this._file || 'not kept'));
        this._startLink();
        this._timers.push(setInterval(() => { if (this._dirty) this._render(); }, RENDER_MS));
        if (!this.rhmiApplication) {
            logger.info('no RhmiApplication for this start reason; running without a screen');
            return this.initialized();
        }
        const data = this.getVisibilityData && this.getVisibilityData();
        const reason = (data && data.reason) || this.startReason;
        const foreground = FOREGROUND_REASONS.indexOf(reason) >= 0;
        return this._setupRhmi()
            .then(() => this._startGpu())
            .then(() => this._pushRows())
            .then(() => this._registerEntryPoint()
                .catch((err) => logger.warn('entry point: ' + (err && err.message) + '; starting without it')))
            .then(() => {
                if (foreground) this.registerActive();
                return this.initialized();
            })
            .then(() => {
                if (foreground) this._setVisible(true);
                const last = this.getLastExecutedEntryPointUuid && this.getLastExecutedEntryPointUuid();
                return last ? this._open(last) : undefined;
            });
    }

    /* the diagnostic link; then the car's engine and speed (Auto white, and no flashing on the move) */
    _startLink() {
        const ready = () => { this._dirty = true; this._watchCar(); };
        this._uds.init().then(ready, () => {
            logger.warn('diagnostic link unavailable: ' + this._uds.error + ' (trying again)');
            const t = setInterval(() => {
                if (this._shutdown) { clearInterval(t); return; }
                if (this._link.proxies[TASU]) { clearInterval(t); this._uds.ready = true; ready(); }
            }, 5000);
            this._timers.push(t);
        });
    }

    /* the engine (CDS.statusEngineSpeed2: rpm x 4, 65535 none) and the speed (Vehicle2.statusCarSpeed2: 1/64 km/h),
     * as Light Logger and Seat Lights read them on the G87 */
    _watchCar() {
        if (this._watching) return;
        this._watching = true;
        const engine = (v) => {
            const raw = v && v.actualValueRPMEngineCrankshaft;
            if (typeof raw !== 'number' || raw === 65535) return;
            const rpm = raw * 0.25;
            if (rpm >= 400) this._flasher.car({ engine: true });
            else if (rpm <= 50) this._flasher.car({ engine: false });
        };
        const speed = (v) => {
            const raw = v && v.speedVehicleCentreOfGravity;
            if (typeof raw !== 'number' || raw === 65535) return;
            this._flasher.car({ kmh: raw * 0.015625 });
        };
        this._link.open('de.bmw.infotainment.vehicle.CDS', '1', { fields: { statusEngineSpeed2: engine } })
            .catch(() => logger.info('engine speed not available: Auto white can\'t tell when the engine starts'))
            .then(() => this._link.open('de.bmw.infotainment.vehicle.Vehicle2', '1', { fields: { statusCarSpeed2: speed } }))
            .catch(() => logger.info('speed not available'));
    }

    /* a press, from the drawn screen or the HMI list */
    _press(name) {
        const now = Date.now();
        this._pressedAt = this._pressedAt || {};
        if (now - (this._pressedAt[name] || 0) < 400) return;     // the same press by both paths
        this._pressedAt[name] = now;
        const f = this._flasher;
        const linkReady = () => {
            if (this._uds.ready) return true;
            logger.warn('the diagnostic link isn\'t ready yet');
            return false;
        };
        if (name === FLASH && this._view === 'main') {
            if (!f.state.ready) { if (linkReady()) f.learn(); }
            else if (linkReady()) f.flash();
        } else if (name === LEARN && this._view === 'main') { if (linkReady()) f.learn(); }
        else if (name === AUTO && this._view === 'main') f.setAuto(!f.state.auto);
        else if (name === FIX && this._view === 'main' && !f.state.busy) f.setColour(f.state.colour === 'yellow' ? 'white' : 'yellow');
        else if (name === LOGS) { this._view = this._view === 'logs' ? 'main' : 'logs'; this._logPage = 0; this._written = {}; }
        else if (name === OLDER && this._view === 'logs') this._logPage = Math.min(this._logPage + 1, ui.logPages(logger.lines.length, this._perPage()) - 1);
        else if (name === NEWER && this._view === 'logs') this._logPage = Math.max(0, this._logPage - 1);
        this._dirty = true;
        this._render();
    }

    _perPage() { return this._gpu && this._gpu.ready ? ui.LOG_PER_PAGE : LINE_ROWS; }

    _model() {
        const st = this._flasher.state;
        return { view: this._view, logs: this._view === 'logs' ? logger.lines : null, logPage: this._logPage,
            colour: st.colour, ready: st.ready, busy: st.busy, learnLeft: st.learnLeft, auto: st.auto,
            note: this._uds.ready ? st.note : 'Waiting for the diagnostic link', warn: st.warn,
            focus: this._ui.focus, pressed: this._ui.pressed };
    }

    /* ---- the HMI ---- */
    _setupRhmi() {
        const rhmi = this.rhmiApplication;
        this._state = rhmi.getByName(STATE);
        if (!this._state) return Promise.reject(new Error('uiDescription has no ' + STATE));
        this._comps[STATUS] = rhmi.getByName(STATUS);
        BUTTONS.forEach((name) => {
            const comp = rhmi.getByName(name);
            if (!comp) { logger.warn('uiDescription has no ' + name); return; }
            this._comps[name] = comp;
            try { this._byId[Number(comp.getId())] = name; } catch (e) { /* events from the component only */ }
            comp.on('action', () => this._press(name));
            comp.on('focus', (ev) => this._focus(name, isTrue(ev && ev.value)));
        });
        for (let i = 0; i < LINE_ROWS; i++) this._comps['dcLine' + i] = rhmi.getByName('dcLine' + i);
        rhmi.on('userEvent', (ev) => {
            const name = ev && this._byId[Number(ev.sourceId)];
            if (!name) return;
            if (ev.eventType === 'ACTION') this._press(name);
            if (ev.eventType === 'FOCUS') this._focus(name, isTrue((ev.parameterMap || {})[VALUE_KEY]));
        });
        rhmi.on('applicationStackChanged', (stack) => {
            const keys = stack && typeof stack === 'object' ? Object.keys(stack) : [];
            if (keys.length) this._setVisible(Object.prototype.hasOwnProperty.call(stack, 'ROOT_APP'));
        });
        rhmi.on('restoreHmi', () => { this._written = {}; this._render(); });
        this._state.on('visible', (ev) => { if (ev && isTrue(ev.value)) this._setVisible(true); });
        return Promise.resolve();
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
            .then(() => {
                this._opening = null;
                if (again) setTimeout(() => this._open(uuid, tries - 1), 800);
            });
        return this._opening;
    }

    _setVisible(visible) {
        if (this._shutdown || this._visible === visible) return;
        this._visible = visible;
        this._syncGpu();
        if (visible) { this._written = {}; this._render(); }
        const reports = visible ? [this.registerActive(), this.registerHmiVisible()]
            : [this.unregisterHmiVisible(), this.registerInactive()];
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

    _render() {
        this._dirty = false;
        if (!this.rhmiApplication || !this._state) return;
        const m = this._model();
        const logs = this._view === 'logs';
        // the plain list: the colour and the last thing that happened, then the buttons' rows
        this._set(STATUS, 'Text', logs ? '' : 'DRL colour: ' + (m.colour ? m.colour.toUpperCase() : 'not known') + '. ' + (m.note || ''));
        this._set(FLASH, 'PrimaryText', logs ? '' : ui.action(m));
        this._set(AUTO, 'PrimaryText', logs ? '' : 'Auto white at each engine start');
        this._set(AUTO, 'FrequencyText', logs ? '' : m.auto ? 'ON' : 'OFF');
        this._set(AUTO, 'FrequencyVisible', !logs);
        this._set(FIX, 'PrimaryText', logs ? '' : 'Wrong colour? ' + ui.fixLabel(m));
        this._set(LEARN, 'PrimaryText', logs ? '' : m.ready ? 'Learn the high beams again' : 'Learn the high beams');
        this._set(LOGS, 'PrimaryText', logs ? 'Close the logs' : 'Logs');
        this._set(OLDER, 'PrimaryText', logs ? 'Older' : '');
        this._set(NEWER, 'PrimaryText', logs ? 'Newer' : '');
        const lines = logs ? ui.logLines(logger.lines, this._logPage, LINE_ROWS) : [];
        for (let i = 0; i < LINE_ROWS; i++) {
            const l = lines[i];
            this._set('dcLine' + i, 'PrimaryText', l ? ui.logText(l) : '');
        }
        Promise.resolve(this.rhmiApplication.flush && this.rhmiApplication.flush()).catch(() => { /* next render */ });
    }

    /* ---- the drawn screen ---- */
    _startGpu() {
        if (this._gpu) return;
        const gpu = new Gpu('ida_drlcolor', logger);
        this._gpu = gpu;
        gpu.on('ready', (scr, area) => {
            const a = area && area.w >= 1000 && area.h >= 400 ? area
                : scr.w === 2880 ? ID8_AREA : { x: 0, y: 0, w: scr.w, h: scr.h };
            gpu.place(ui.placement(a));
            this._ui.key = '';
            this._syncGpu();
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
        gpu.claim([{ x: 0, y: 0, w: ui.W, h: ui.H }]);
        gpu.frame(u.rec);
    }

    _focus(name, on) {
        if (on) this._ui.focus = name;
        else if (this._ui.focus === name) this._ui.focus = null;
    }

    _touch(phase, x, y) {
        const u = this._ui, t = ui.hit(u.targets, x, y);
        if (phase === 1) { u.down = t ? t.key : null; u.pressed = u.down; return; }
        if (phase === 2) { if (!t || t.key !== u.down) u.pressed = null; return; }
        if (phase !== 3) return;
        const key = u.down;
        u.down = null;
        setTimeout(() => { if (!u.down) u.pressed = null; }, 150);
        if (t && t.key === key && BUTTONS.indexOf(key) >= 0) this._press(key);
    }

    _stop(reason) {
        if (this._shutdown) return this._shutdown;
        logger.info('shutting down (' + reason + ')');
        this._timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
        clearInterval(this._ui.timer);
        if (this._gpu) this._gpu.close();
        this._shutdown = within(this._flasher.stop(), 3000, 'drl: a flash in progress')
            .then(() => this._link.stop())
            .then(() => this.destroyBundles().catch((err) => logger.info('destroyBundles: ' + (err && err.message))))
            .then(() => process.exit(0));
        return this._shutdown;
    }
}

const app = new DrlColourApp();
app.start().catch((err) => {
    logger.error('failed to start: ' + (err && err.message));
});
