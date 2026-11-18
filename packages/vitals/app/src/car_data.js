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
        this.gearboxFirst = null;           // the first raw gearbox value, until it changes
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
                this.emit('data', decode.engine(v));
            },
        }));
        // basicDataSet is notify-only (no getter): subscribed, never read
        step(() => this._watch(IF_BASIC, '1', {
            basicDataSet: (v) => {
                const raw = v && v.valueTemperatureTransmissionOil;
                if (typeof raw !== 'number' || raw === 255) return;
                if (!this.available.gearbox) {
                    // a value that never changes is a car that doesn't fill it in
                    if (this.gearboxFirst === null) { this.gearboxFirst = raw; this.log.info('gearbox oil: first raw value ' + raw); return; }
                    if (raw === this.gearboxFirst) return;
                    this.available.gearbox = true;
                    this.log.info('gearbox oil: moved to raw ' + raw + ', showing it');
                }
                this.emit('data', { gearbox: decode.gearbox(v) });
            },
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
