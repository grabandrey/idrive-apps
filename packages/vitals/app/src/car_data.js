'use strict';
/*
 * Vitals: reads the car's temperatures (engine, gearbox) and tyre data through BMW's SDK (typed SOME/IP
 * proxies, as manifest.json declares them) and emits them as metric numbers.
 *
 *   const car = new CarData(logger); car.on('data', (partial) => ...); car.start();
 *
 * Each interface is set up one after another, in its own tick, the way the SDK's own code
 * does; a missing interface or field is logged and the rest carry on. TPMS is also read
 * every 5 s: some cars answer reads but never notify it.
 */
const EventEmitter = require('events');
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');
const decode = require('./decode.js');

const IF_CDS = 'de.bmw.infotainment.vehicle.CDS';
const IF_TPMS = 'de.bmw.infotainment.vehicle.TPMS';
const IF_VEHICLE = 'de.bmw.infotainment.vehicle.Vehicle';
const IF_BASIC = 'de.bmw.infrastructure.analytics.BasicDataSet';
const TPMS_POLL_MS = 5000;
const STUCK_RISE = 25;              // C of engine oil warming with a gearbox value that never moved

const tick = () => new Promise((resolve) => setImmediate(resolve));

class CarData extends EventEmitter {
    constructor(log) {
        super();
        this.log = log;
        this.units = { carTemp: null, carPress: null };
        this.raw = { tyreT: null, tyreP: null };
        this.proxies = {};
        this.timers = [];
        this.available = { engine: false, gearbox: false, tyres: false };
        this.gearbox = { first: null, oilAtFirst: null, moved: false, stuck: false, logged: 0 };
        this.oil = null;                    // the latest engine oil temperature, C
    }

    start() {
        let chain = Promise.resolve();
        const step = (fn) => { chain = chain.then(tick).then(fn).catch((err) => this.log.warn('car data: ' + (err && err.message))); };
        step(() => this._watch(IF_VEHICLE, '1', {
            statusNewCurrentUnitsStatusExt: (v) => {
                const u = decode.units(v);
                if (u.carTemp === this.units.carTemp && u.carPress === this.units.carPress) return;
                this.units = u;
                this.log.info('car units: temperature ' + (u.carTemp || '?') + ', pressure ' + (u.carPress || '?'));
                this._tyres();                          // the raw tyre values read again in the new units
                this.emit('data', { carTemp: u.carTemp, carPress: u.carPress });
            },
        }));
        step(() => this._watch(IF_CDS, '1', {
            statusEngineTemperature: (v) => {
                this.available.engine = true;
                const e = decode.engine(v);
                if (e.oil !== null) this.oil = e.oil;
                this.emit('data', e);
            },
        }));
        // basicDataSet is notify-only (no getter): subscribed, never read
        step(() => this._watch(IF_BASIC, '1', {
            basicDataSet: (v) => this._gearbox(v),
        }, 0, ['basicDataSet']));
        step(() => this._watch(IF_TPMS, '1', {
            statusTyreTemperature: (v) => { this.raw.tyreT = v; this._tyres(); },
            statusTyrePressure: (v) => { this.raw.tyreP = v; this._tyres(); },
        }, TPMS_POLL_MS));
        return chain;
    }

    stop() {
        this.timers.forEach((t) => clearInterval(t));
        Object.keys(this.proxies).forEach((k) => {
            const p = this.proxies[k];
            try { if (p && p.shutdown) p.shutdown(); } catch (e) { /* stopping anyway */ }
        });
    }

    /* gearbox oil: shown at once when the value is plausible. Some cars never fill the field in and send
     * one fixed number: a value that has not moved once while the engine oil warmed by STUCK_RISE C is
     * taken for that, and hidden. Raw values go to the log (the first few, then each change). */
    _gearbox(v) {
        const g = this.gearbox;
        const raw = v && v.valueTemperatureTransmissionOil;
        if (g.logged < 5 || (typeof raw === 'number' && raw !== g.last)) {
            if (g.logged < 40) { g.logged++; this.log.info('gearbox oil raw ' + raw + (g.logged === 1 ? ' (fields: ' + Object.keys(v || {}).join(',') + ')' : '')); }
        }
        g.last = raw;
        const c = decode.gearbox(v);
        if (c === null || c < -40 || c > 160 || g.stuck) return;
        if (g.first === null) { g.first = raw; g.oilAtFirst = this.oil; }
        if (raw !== g.first) g.moved = true;
        if (!g.moved && g.oilAtFirst !== null && this.oil !== null && this.oil - g.oilAtFirst >= STUCK_RISE) {
            g.stuck = true;
            this.available.gearbox = false;
            this.log.info('gearbox oil stuck at raw ' + raw + ' while the engine oil warmed: this car does not send it');
            this.emit('data', { gearbox: null });
            return;
        }
        this.available.gearbox = true;
        this.emit('data', { gearbox: c });
    }

    _tyres() {
        const out = {};
        if (this.raw.tyreT) out.tyreT = decode.tyreTemps(this.raw.tyreT, this.units.carTemp);
        if (this.raw.tyreP) out.tyreP = decode.tyrePressures(this.raw.tyreP, this.units.carPress);
        if (out.tyreT || out.tyreP) { this.available.tyres = true; this.emit('data', out); }
    }

    /* one interface: subscribe to each field and read it now (and every pollMs, if given), except the
     * notify-only fields named in noRead */
    _watch(iface, instance, handlers, pollMs, noRead) {
        let proxy;
        return someipBuilders.buildTypedProxy(iface, instance)
            .then((p) => { proxy = p; this.proxies[iface] = p; return proxy.init(); })
            .then(() => proxy.waitUntilAvailable())
            .then(() => {
                this.log.info(iface + ' available');
                const fields = Object.keys(handlers);
                const read = () => fields.filter((f) => !noRead || noRead.indexOf(f) < 0).forEach((f) => {
                    const field = proxy[f];
                    if (!field || !field.getValue) return;
                    Promise.resolve(field.getValue()).then((v) => handlers[f](v))
                        .catch((err) => this.log.warn('read ' + iface + '.' + f + ': ' + (err && err.message)));
                });
                let chain = Promise.resolve();
                fields.forEach((f) => {
                    chain = chain.then(tick).then(() => {
                        const field = proxy[f];
                        if (!field || !field.subscribe) { this.log.warn(iface + '.' + f + ': no such field'); return undefined; }
                        return Promise.resolve(field.subscribe((v) => {
                            try { handlers[f](v); } catch (e) { this.log.warn(iface + '.' + f + ': ' + e.message); }
                        })).catch((err) => this.log.warn('subscribe ' + iface + '.' + f + ': ' + (err && err.message)));
                    });
                });
                return chain.then(() => {
                    read();
                    if (pollMs) this.timers.push(setInterval(read, pollMs));
                });
            })
            .catch((err) => this.log.warn(iface + ' unavailable: ' + (err && err.message)));
    }
}

module.exports = { CarData };
