'use strict';
/*
 * Light Logger: UDS over TASU, the head unit's own diagnostic transport, used the way BMW's ts_diagnostic_service
 * uses it (and the MIT-licensed idrive7-apps kit's kit/runtime/diag.js):
 *
 *   request  InternalTasu.sendTasuRequest { sourceAddress 0xF2, targetAddress, serviceID, subroutineID 0,
 *            udsDataLength, udsData = the bytes after the service id, deadlockTime 0 }
 *   reply    broadcast sendTasuResponse { udsResponse, errorCode }. The frame has a 9-byte header: [2] 0x7F =
 *            rejected by the transport (code in [4]), [6] = the address of the ECU that answered, the UDS reply
 *            from [9] on. 7F <sid> 78 = "response pending": the real reply comes later.
 *
 * READ ONLY: check() lets through ReadDataByIdentifier (22) to one ECU and nothing else, so this app cannot change
 * anything on the car. The SOME/IP side (link) is passed in: someip_link.js on the car, a fake in the tests.
 *
 *   const uds = new Uds(link, log);  await uds.init();
 *   const reply = await uds.read(0x40, [0xDA, 0x5F]);   // 62 DA 5F ... | 7F 22 xx | null (no answer)
 */
const EventEmitter = require('events');

const IFACE = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
const INSTANCE = 'SystemFunctionsInternalTasuInst1';
const TESTER = 0xF2;
const READ = 0x22;

function toBytes(b) {
    if (!b) return [];
    if (Buffer.isBuffer(b) || b instanceof Uint8Array) return Array.prototype.slice.call(b);
    if (Array.isArray(b)) return b.slice();
    if (b.data) return toBytes(b.data);
    if (typeof b === 'object' && typeof b.length === 'number') return Array.prototype.slice.call(b);
    return [];
}

/* throws unless it is a single-ECU ReadDataByIdentifier */
function check(target, sid, data) {
    const byte = (x) => Number.isInteger(x) && x >= 0 && x <= 0xff;
    if (sid !== READ) throw new Error('read-only: service ' + sid + ' is not allowed');
    if (!byte(target) || target === 0xdf) throw new Error('read-only: one ECU only');
    if (!Array.isArray(data) || data.length !== 2 || !data.every(byte)) throw new Error('read-only: one identifier only');
}

/* a sendTasuResponse value -> { ecu, uds } | { reject: code } | { error } | null */
function parseFrame(v) {
    const err = v && v.errorCode;
    if (err !== undefined && err !== null && err !== 'NO_ERROR' && err !== 0) return { error: String(err) };
    const b = toBytes(v && (v.udsResponse !== undefined ? v.udsResponse : v));
    if (b.length >= 5 && b[2] === 0x7f) return { reject: b[4] };
    if (b.length < 10) return null;
    return { ecu: b[6], uds: b.slice(9) };
}

/* the transport's verdict from a sendTasuRequest result */
function verdictOf(r) {
    if (r === undefined || r === null) return 'NO_ERROR';
    if (typeof r !== 'object') return String(r);
    if (r.TasuErrorEnum !== undefined) return String(r.TasuErrorEnum);
    const s = Object.keys(r).map((k) => r[k]).find((x) => typeof x === 'string' || typeof x === 'number');
    return s === undefined ? 'NO_ERROR' : String(s);
}
const accepted = (v) => v === 'NO_ERROR' || v === 'REQUEST_PENDING' || v === '0' || v === '1';

class Uds extends EventEmitter {
    constructor(link, log) {
        super();
        this.link = link; this.log = log;
        this.ready = false; this.error = null;
        this.sent = 0; this.answered = 0; this.missed = 0;
        this._busy = Promise.resolve();
    }

    init() {
        return this.link.open(IFACE, INSTANCE, { broadcasts: { sendTasuResponse: (v) => this._onFrame(v) } })
            .then(() => { this.ready = true; this.error = null; this.log.info('diagnostic link ready'); })
            .catch((e) => { this.error = (e && e.message) || String(e); throw e; });
    }

    _onFrame(v) {
        const f = parseFrame(v);
        if (!f) return;
        if (f.error) { this.emit('transportError', f.error); return; }
        if (f.reject !== undefined) { this.emit('reject', f.reject); return; }
        this.emit('frame', f);
    }

    /* One read at a time (the transport takes one request at a time). Resolves with the ECU's UDS reply,
     * or null when it didn't answer within timeoutMs (15 s more after each "pending"). */
    read(target, did, timeoutMs) {
        const run = () => this._read(target, did, timeoutMs || 15000);
        const p = this._busy.then(run, run);
        this._busy = p.catch(() => null);
        return p;
    }

    _read(target, did, timeoutMs) {
        check(target, READ, did);
        let timer, onFrame, onReject, finish, done = false;
        const got = new Promise((resolve) => {
            finish = (v) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                this.removeListener('frame', onFrame); this.removeListener('reject', onReject);
                resolve(v);
            };
            onFrame = (f) => {
                if (f.ecu !== target) return;
                const u = f.uds;
                if (u[0] === 0x7f && u[1] === READ && u[2] === 0x78) {      // pending: wait longer
                    clearTimeout(timer); timer = setTimeout(() => finish(null), timeoutMs);
                    return;
                }
                if (u[0] === READ + 0x40 && u[1] === did[0] && u[2] === did[1]) finish(u);
                else if (u[0] === 0x7f && u[1] === READ) finish(u);
            };
            onReject = () => finish(null);
            this.on('frame', onFrame); this.on('reject', onReject);
        });
        this.sent++;
        const req = {
            sourceAddress: TESTER, targetAddress: target, serviceID: READ, subroutineID: 0,
            udsDataLength: did.length, udsData: Buffer.from(did), deadlockTime: 0,
        };
        return Promise.resolve()
            .then(() => this.link.call(IFACE, 'sendTasuRequest', req, 8000))
            .then((r) => {
                const v = verdictOf(r);
                if (!accepted(v)) throw new Error('transport refused: ' + v);
                if (!done) timer = setTimeout(() => finish(null), timeoutMs);
                return got;
            }, (e) => { finish(null); throw e; })
            .then((u) => { if (u) this.answered++; else this.missed++; return u; });
    }
}

module.exports = { Uds, IFACE, INSTANCE, check, parseFrame, verdictOf, toBytes };
