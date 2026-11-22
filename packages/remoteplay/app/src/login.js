'use strict';
/*
 * Remote Play: sign in with a phone. The car shows a QR code (qr.js) for a small page this module serves on the car's
 * own network (its Wi-Fi hotspot). On the phone:
 *
 *   1. "Sign in with PlayStation" opens Sony's sign-in page (the same one the PlayStation Remote Play app uses).
 *   2. After signing in, Sony's page shows "redirect": its address carries a one-time code. The phone pastes that
 *      address (or just the code) back into this page.
 *   3. The car swaps the code at Sony (auth.api.sonyentertainmentnetwork.com) for the account id (8 bytes, base64: the
 *      console asks for it when the car pairs) and a refresh token: with it the car gets a fresh access token before
 *      each game over the internet (PSN finds the console and opens the way through the routers). No password is
 *      kept; Sign out deletes the token.
 *
 * The page also takes an account id directly (base64), for when the car can't reach Sony.
 *
 *   const s = new SignIn({ log, port: 8890, duid: () => this car's PSN device id (the engine's) or null });
 *   s.start(); s.url()  -> 'http://192.168.x.y:8890/s/<token>' (null without a network)
 *   s.on('account', ({ accountId, onlineId, refreshToken, duid }) => ...)
 *   refresh(refreshToken) -> Promise<{ accessToken, refreshToken, expiresAt }>     (Sony rotates the refresh token)
 *
 * A random token in the address keeps other people on the same hotspot out. Node 8: no BigInt (accountIdFromUserId).
 */
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const EventEmitter = require('events');
const querystring = require('querystring');

/* the PlayStation Remote Play (Windows) client's sign-in, as the public psn-account-id scripts use it */
const CLIENT_ID = 'ba495a24-818c-472b-b12d-ff231c1b5745';
const CLIENT_SECRET = 'mvaiZkRsAsI1IBkY';
const REDIRECT = 'https://remoteplay.dl.playstation.net/remoteplay/redirect';
const AUTH_HOST = 'auth.api.sonyentertainmentnetwork.com';
/* the account, and what play over the internet needs: the console list, PSN's push channel, its Remote Play sessions */
const SCOPES = 'psn:clientapp referenceDataService:countryConfig.read pushNotification:webSocket.desktop.connect sessionManager:remotePlaySession.system.update';
const LOGIN_URL = 'https://' + AUTH_HOST + '/2.0/oauth/authorize?service_entity=urn:service-entity:psn&response_type=code' +
    '&client_id=' + CLIENT_ID + '&redirect_uri=' + encodeURIComponent(REDIRECT) + '&scope=' + encodeURIComponent(SCOPES) + '&request_locale=en_US' +
    '&ui=pr&service_logo=ps&layout_type=popup&smcid=remoteplay&prompt=always&PlatformPrivacyWs1=minimal&';
/* the sign-in address; with this car's device id (the token is then good for PSN's Remote Play sessions) */
function loginUrl(duid) { return LOGIN_URL + (duid && /^[0-9a-f]{48}$/i.test(duid) ? 'duid=' + duid + '&' : ''); }
const TOKEN_PATH = '/2.0/oauth/token';

/* "1234567890123456789" (a 64-bit decimal, too big for a double) -> 8 bytes little endian, base64 */
function accountIdFromUserId(userId) {
    let digits = String(userId).replace(/\D/g, '').split('').map(Number);
    if (!digits.length) throw new Error('no user id');
    const out = Buffer.alloc(8);
    for (let i = 0; i < 8; i++) {
        let rem = 0;
        const q = [];
        digits.forEach((d) => { const cur = rem * 10 + d; q.push(Math.floor(cur / 256)); rem = cur % 256; });
        out[i] = rem;
        digits = q;
        while (digits.length > 1 && digits[0] === 0) digits.shift();
    }
    if (digits.some((d) => d !== 0)) throw new Error('user id is more than 64 bits');
    return out.toString('base64');
}

/* the code from what the phone pasted: the whole redirect address, or the code alone */
function codeFrom(text) {
    text = String(text || '').trim();
    const m = /[?&#]code=([^&#\s]+)/.exec(text);
    if (m) return decodeURIComponent(m[1]);
    return /^[A-Za-z0-9._~-]{4,}$/.test(text) ? text : null;
}

/* an account id as it is pasted: 8 bytes in base64 */
function validAccountId(s) {
    s = String(s || '').trim();
    if (!/^[A-Za-z0-9+/]{11}=$/.test(s)) return null;
    return Buffer.from(s, 'base64').length === 8 ? s : null;
}

/* the car's own address on its hotspot or Wi-Fi: a private IPv4, wireless interfaces first */
function localAddress(ifaces) {
    ifaces = ifaces || os.networkInterfaces();
    const list = [];
    Object.keys(ifaces).forEach((name) => (ifaces[name] || []).forEach((a) => {
        if (a.family !== 'IPv4' && a.family !== 4) return;
        if (a.internal || /^127\./.test(a.address) || /^169\.254\./.test(a.address)) return;
        const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
        const wireless = /^(wl|wlan|uap|ap|mlan|softap)/i.test(name);
        list.push({ name: name, address: a.address, score: (wireless ? 2 : 0) + (priv ? 1 : 0) });
    }));
    list.sort((a, b) => b.score - a.score);
    return list.length ? list[0].address : null;
}

function request(opts, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(opts, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch (e) { /* not json */ }
                resolve({ status: res.statusCode, json: json, text: text });
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.abort());
        if (body) req.write(body);
        req.end();
    });
}

const BASIC = 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
function tokenRequest(send, fields) {
    const body = querystring.stringify(Object.assign(fields, { scope: SCOPES, redirect_uri: REDIRECT }));
    return send({ host: AUTH_HOST, path: TOKEN_PATH, method: 'POST',
        headers: { Authorization: BASIC, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, body);
}
function tokens(r, now) {
    return { accessToken: r.json.access_token, refreshToken: r.json.refresh_token || null,
        expiresAt: now + Math.max(60, Number(r.json.expires_in) || 3600) * 1000 };
}

/* Sony: the code -> tokens -> the account's user id -> the account id */
function exchange(code, httpsRequest, now) {
    const send = httpsRequest || request;
    let t = null;
    return tokenRequest(send, { grant_type: 'authorization_code', code: code })
        .then((r) => {
            if (r.status !== 200 || !r.json || !r.json.access_token) throw new Error('Sony refused the code (' + r.status + '): ' + (r.json && (r.json.error_description || r.json.error) || 'no token'));
            t = tokens(r, now === undefined ? Date.now() : now);
            return send({ host: AUTH_HOST, path: TOKEN_PATH + '/' + encodeURIComponent(t.accessToken), method: 'GET', headers: { Authorization: BASIC } });
        })
        .then((r) => {
            if (r.status !== 200 || !r.json || !r.json.user_id) throw new Error('Sony sent no account (' + r.status + ')');
            return { accountId: accountIdFromUserId(r.json.user_id), onlineId: r.json.online_id || null,
                refreshToken: t.refreshToken, accessToken: t.accessToken, expiresAt: t.expiresAt };
        });
}

/* a fresh access token from the refresh token (before each game over the internet); Sony may send a new refresh token */
function refresh(refreshToken, httpsRequest, now) {
    if (!refreshToken) return Promise.reject(new Error('not signed in for play over the internet: sign in again'));
    return tokenRequest(httpsRequest || request, { grant_type: 'refresh_token', refresh_token: refreshToken })
        .then((r) => {
            if (r.status !== 200 || !r.json || !r.json.access_token) {
                throw new Error('Sony refused the sign-in (' + r.status + ': ' + (r.json && (r.json.error_description || r.json.error) || 'no token') + '): sign in again');
            }
            const t = tokens(r, now === undefined ? Date.now() : now);
            if (!t.refreshToken) t.refreshToken = refreshToken;
            return t;
        });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function page(title, body) {
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>' + esc(title) + '</title><style>' +
        ':root{color-scheme:light dark;--bg:#f4f5f8;--card:#fff;--text:#15171c;--dim:#5d6473;--accent:#1e6fd9;--line:#d9dde5}' +
        '@media (prefers-color-scheme:dark){:root{--bg:#0b0d12;--card:#151922;--text:#eef0f4;--dim:#98a0b2;--accent:#4b93f0;--line:#2a303d}}' +
        'body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,sans-serif}' +
        'main{max-width:560px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}p{color:var(--dim)}' +
        '.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin:16px 0}' +
        '.n{display:inline-block;width:26px;height:26px;border-radius:13px;background:var(--accent);color:#fff;text-align:center;font-weight:600;margin-right:8px}' +
        'a.btn,button{display:block;width:100%;box-sizing:border-box;padding:14px;border-radius:10px;border:0;background:var(--accent);color:#fff;font:600 16px system-ui;text-align:center;text-decoration:none;margin-top:12px}' +
        'textarea,input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:14px ui-monospace,monospace}' +
        'details{margin-top:8px;color:var(--dim)}.ok{color:#1f9d55}.err{color:#d64535}</style></head><body><main>' + body + '</main></body></html>';
}

class SignIn extends EventEmitter {
    constructor(o) {
        super();
        o = o || {};
        this.log = o.log;
        this.port = o.port || 8890;
        this.exchange = o.exchange || exchange;
        this.duid = o.duid || (() => null);
        this.token = crypto.randomBytes(6).toString('hex');
        this.server = null;
        this.address = null;
        this.result = null;           // { ok, text } of the last attempt, shown on the page
    }

    url() { this.address = localAddress(); return this.address ? 'http://' + this.address + ':' + this.port + '/s/' + this.token : null; }

    start() {
        if (this.server) return Promise.resolve(this.url());
        return new Promise((resolve) => {
            const srv = http.createServer((req, res) => this._serve(req, res));
            srv.on('error', (e) => { this.log.warn('sign-in page: ' + e.message); this.server = null; resolve(null); });
            srv.listen(this.port, '0.0.0.0', () => { this.server = srv; this.log.info('sign-in page on port ' + this.port); resolve(this.url()); });
        });
    }

    stop() { if (this.server) { this.server.close(); this.server = null; } }

    _serve(req, res) {
        const base = '/s/' + this.token;
        const u = req.url.split('?')[0];
        const send = (code, html) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); };
        if (u !== base && u !== base + '/') {
            if (u.indexOf(base + '/') !== 0 || req.method !== 'POST') return send(404, page('Remote Play', '<h1>Not here</h1><p>Scan the code on the car\'s screen again.</p>'));
        }
        if (req.method === 'GET') return send(200, this._page());
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
        req.on('end', () => {
            const form = querystring.parse(body);
            let work;
            const id = validAccountId(form.accountId);
            if (id) work = Promise.resolve({ accountId: id, onlineId: null, refreshToken: null });
            else {
                const code = codeFrom(form.url);
                work = code ? this.exchange(code) : Promise.reject(new Error('That has no code in it. Copy the whole address of the page that says "redirect".'));
            }
            const duid = this.duid();
            work.then((acc) => {
                acc.duid = acc.refreshToken ? duid : null;
                this.result = { ok: true, text: 'Signed in' + (acc.onlineId ? ' as ' + acc.onlineId : '') + '. ' +
                    (acc.refreshToken && duid ? 'The car can now reach your PS5 at home and over the internet' : 'The car can now pair with your PS5 at home') +
                    '. You can close this page.' };
                this.log.info('signed in' + (acc.onlineId ? ' as ' + acc.onlineId : '') + ' (account id kept)');
                this.emit('account', acc);
            }, (err) => {
                this.result = { ok: false, text: err.message };
                this.log.warn('sign-in failed: ' + err.message);
            }).then(() => { res.writeHead(303, { Location: base }); res.end(); });
        });
    }

    _page() {
        const r = this.result;
        return page('Remote Play: sign in',
            '<h1>Remote Play in the car</h1><p>Sign in with the PlayStation account you play on. The car keeps your account\'s number (the console asks for it when it pairs) and a sign-in token, so it can reach your PS5 over the internet when you\'re away. Your password stays with Sony. <b>Sign out</b> in the car deletes the token.</p>' +
            (r ? '<div class="card ' + (r.ok ? 'ok' : 'err') + '">' + esc(r.text) + '</div>' : '') +
            '<div class="card"><span class="n">1</span><b>Sign in at PlayStation</b>' +
            '<a class="btn" href="' + esc(loginUrl(this.duid())) + '" target="_blank" rel="noreferrer">Sign in with PlayStation</a></div>' +
            '<div class="card"><span class="n">2</span><b>Paste the page it ends on</b><p>After signing in, the page says <i>redirect</i>. Copy its whole address from the address bar and paste it here.</p>' +
            '<form method="post" action="/s/' + this.token + '/code"><textarea name="url" rows="4" placeholder="https://remoteplay.dl.playstation.net/remoteplay/redirect?code=..."></textarea>' +
            '<button type="submit">Send to the car</button></form>' +
            '<details><summary>I already know my account ID (play at home only)</summary><form method="post" action="/s/' + this.token + '/id">' +
            '<input name="accountId" placeholder="8 bytes in base64, e.g. AbCdEfGhIjk=" autocomplete="off"><button type="submit">Send to the car</button></form></details></div>');
    }
}

module.exports = { SignIn, exchange, refresh, loginUrl, accountIdFromUserId, codeFrom, validAccountId, localAddress, LOGIN_URL, SCOPES };
