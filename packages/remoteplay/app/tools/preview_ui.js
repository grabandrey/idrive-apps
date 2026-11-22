'use strict';
/*
 * node packages/remoteplay/app/tools/preview_ui.js [out.html] [home|away|signin|pin|play|logs]: the app's drawn screen
 * (src/ui.js), played back onto a browser canvas the way the renderer draws its ops (Light Logger's player). Open it
 * in a browser. The Play screen's middle is transparent on the car (the video tool's picture shows there); here a
 * placeholder stands in for it.
 */
const fs = require('fs');
const path = require('path');
const ui = require('../src/ui.js');
const qr = require('../src/qr.js');
const { layout } = require('../src/pad.js');

const variant = process.argv[3] || 'home';
const out = process.argv[2] || path.join(__dirname, '..', '..', 'design', 'app_' + variant + '.html');
const lay = layout(ui.W, ui.H);
const T = new Date(2026, 10, 21, 18, 5, 0).getTime();
const sampleLogs = [
    [0, 'info', 'Remote Play ida_remoteplay starting'], [1, 'info', 'video tool: connected'],
    [1, 'info', 'video: GStreamer 1.20.3, decoder v4l2h264dec (hardware), display waylandsink'], [2, 'info', 'car: parked'],
    [4, 'info', 'console: PS5-Living room (PS5, 192.168.43.20, ready)'], [30, 'info', 'video test (encoded and decoded, as a stream is)'],
    [39, 'info', 'video test: 59.9 fps of 60'], [61, 'info', 'play: PS5-Living room, 1280x720 60 fps h264'], [64, 'info', 'streaming'],
].map((x) => ({ t: T + x[0] * 1000, level: x[1], text: x[2] }));
const ready = {
    account: { onlineId: 'Driver_42' }, console: { name: 'PS5-Living room', host: '192.168.43.20', state: 'ready', type: 'PS5' },
    paired: { nickname: 'PS5-Living room' }, engine: { name: 'Stream engine', version: '1.0' },
    video: { tool: true, probe: { decoder: 'v4l2h264dec', hardware: true, sink: 'waylandsink' }, fps: 59.9, size: '1280x720', target: 60 },
    pad: null, parked: true, route: 'local', internet: true,
};
const url = 'http://192.168.43.1:8890/s/3f9a0c71b2de';
const models = {
    home: Object.assign({ view: 'home' }, ready),
    away: Object.assign({ view: 'home' }, ready, { console: { name: 'PS5-Living room', host: '192.168.43.20', state: 'gone', type: 'PS5' },
        route: 'internet', remote: { name: 'PS5-Living room', consoleId: 'ab', type: 'PS5', remotePlay: true } }),
    signin: { view: 'signin', url: url, qr: qr.encode(url) },
    pin: Object.assign({ view: 'pin', pin: '483' }, ready),
    play: { view: 'play', session: { state: 'streaming' }, input: { buttons: ['cross'], lx: 12000, ly: -8000, rx: 0, ry: 0 } },
    logs: { view: 'logs', logs: sampleLogs, logPage: 0 },
};
const { rec } = ui.draw(new ui.Recorder(), Object.assign({ focus: null }, models[variant]), lay);
const words = Array.from(rec.words());
const atlases = rec.atlases.map((a) => ({ id: a.id, w: a.w, h: a.h, alpha: a.alpha.toString('base64') }));

const html = `<!doctype html><meta charset="utf-8"><title>Remote Play preview</title>
<style>body{margin:0;background:#000}canvas{width:100%;display:block}</style>
<canvas id="c" width="${ui.W}" height="${ui.H}"></canvas>
<script>
const words = new Uint32Array(${JSON.stringify(words)});
const f = new Float32Array(words.buffer);
const atl = {};
${JSON.stringify(atlases)}.forEach((a) => { const b = atob(a.alpha); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); atl[a.id] = { w: a.w, h: a.h, a: u }; });
const g = document.getElementById('c').getContext('2d');
const pics = {};
[].forEach((p) => {
  const b = atob(p.data), c = document.createElement('canvas'); c.width = p.w; c.height = p.h;
  const cx = c.getContext('2d'), im = cx.createImageData(p.w, p.h);
  for (let i = 0; i < b.length; i += 4) { const a = b.charCodeAt(i + 3); for (let k = 0; k < 3; k++) im.data[i + k] = a ? Math.min(255, b.charCodeAt(i + k) * 255 / a) : 0; im.data[i + 3] = a; }
  cx.putImageData(im, 0, 0); pics[p.id] = c;
});
const col = (v) => 'rgba(' + (v >>> 24) + ',' + ((v >>> 16) & 255) + ',' + ((v >>> 8) & 255) + ',' + ((v & 255) / 255) + ')';
const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
if (${JSON.stringify(variant)} === 'play') { const gr = g.createLinearGradient(0, 0, ${ui.W}, ${ui.H}); gr.addColorStop(0, '#1d2a44'); gr.addColorStop(1, '#3a2240'); g.fillStyle = '#000'; g.fillRect(0, 0, ${ui.W}, ${ui.H}); g.fillStyle = gr; g.fillRect(${lay.video.x}, 0, ${lay.video.w}, ${ui.H}); g.fillStyle = 'rgba(255,255,255,0.35)'; g.font = '48px sans-serif'; g.textAlign = 'center'; g.fillText('the game (video tool, hardware decoded)', ${lay.video.x + lay.video.w / 2}, ${ui.H / 2}); }
let i = 0;
while (i < words.length) {
  const op = words[i];
  if (op === 1) { if (words[i + 1] & 255) { g.fillStyle = col(words[i + 1]); g.fillRect(0, 0, ${ui.W}, ${ui.H}); } i += 2; }
  else if (op === 2) { g.fillStyle = col(words[i + 5]); g.fillRect(f[i + 1], f[i + 2], f[i + 3], f[i + 4]); i += 6; }
  else if (op === 4) { g.fillStyle = col(words[i + 6]); rr(f[i + 1], f[i + 2], f[i + 3], f[i + 4], f[i + 5]); g.fill(); i += 7; }
  else if (op === 5) { g.strokeStyle = col(words[i + 7]); g.lineWidth = f[i + 6]; rr(f[i + 1], f[i + 2], f[i + 3], f[i + 4], f[i + 5]); g.stroke(); i += 8; }
  else if (op === 18) { const c = pics[words[i + 6]]; if (c) { g.imageSmoothingQuality = 'high'; g.drawImage(c, f[i + 1], f[i + 2], f[i + 3], f[i + 4]); } i += 7; }
  else if (op === 15) { g.fillStyle = col(words[i + 9]); g.beginPath(); g.moveTo(f[i + 1], f[i + 2]); for (let k = 1; k < 4; k++) g.lineTo(f[i + 1 + 2 * k], f[i + 2 + 2 * k]); g.closePath(); g.fill(); i += 10; }
  else if (op === 11) {
    const a = atl[words[i + 1]], c = words[i + 2], n = words[i + 3];
    let j = i + 4;
    for (let k = 0; k < n; k++, j += 8) {
      const x = f[j], y = f[j + 1], w = f[j + 2], h = f[j + 3], u0 = f[j + 4], v0 = f[j + 5];
      const im = g.getImageData(x, y, w, h);
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const al = a.a[(v0 + yy) * a.w + u0 + xx] / 255 * ((c & 255) / 255), p = (yy * w + xx) * 4;
        im.data[p] = im.data[p] * (1 - al) + (c >>> 24) * al; im.data[p + 1] = im.data[p + 1] * (1 - al) + ((c >>> 16) & 255) * al;
        im.data[p + 2] = im.data[p + 2] * (1 - al) + ((c >>> 8) & 255) * al;
      }
      g.putImageData(im, x, y);
    }
    i = j;
  } else { console.log('unknown op ' + op); break; }
}
</script>`;
fs.writeFileSync(out, html);
console.log('wrote ' + out);
