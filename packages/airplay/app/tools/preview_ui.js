'use strict';
/*
 * node packages/airplay/app/tools/preview_ui.js [out.html] [home|pin|mirror|stretch|logs]: the app's drawn screen
 * (src/ui.js), played back onto a browser canvas the way the renderer draws its ops (Light Logger's player). Open it
 * in a browser. On the car the Mirror screen is transparent right of the band (the video tool's picture shows there);
 * here a stand-in picture is drawn where the video tool would put it, in the shape asked for (its viewFor).
 */
const fs = require('fs');
const path = require('path');
const ui = require('../src/ui.js');
const video = require('../../../remoteplay/tool/video.js');

const variant = process.argv[3] || 'home';
const out = process.argv[2] || path.join(__dirname, '..', '..', 'design', 'app_' + variant + '.html');
const T = new Date(2026, 10, 22, 18, 5, 0).getTime();
const sampleLogs = [
    [0, 'info', 'AirPlay ida_airplay starting'], [1, 'info', 'video tool: connected'], [1, 'info', 'AirPlay engine: AirPlay Engine 1.0.0'],
    [1, 'info', 'video: GStreamer 1.20.3 (ida-gst), decoder v4l2h264dec (hardware), display waylandsink'], [2, 'info', 'car: parked'],
    [3, 'info', 'receiver on: "iDrive" (PIN) on 192.168.43.1'], [21, 'info', 'phone: Anna\'s iPhone (iPhone15,2)'], [22, 'info', 'PIN shown for the phone'],
    [34, 'info', 'mirroring: 886x1920 h264'], [34, 'info', 'picture: Fit, 886x1920 in {"x":1114,"y":76,"w":353,"h":764}'],
    [51, 'info', 'picture shape: Stretch'], [51, 'info', 'picture: Stretch, 886x1920 in {"x":320,"y":76,"w":2560,"h":764}'],
].map((x) => ({ t: T + x[0] * 1000, level: x[1], text: x[2] }));
const ready = {
    engine: { name: 'AirPlay Engine', version: '1.0.0' }, receiver: { on: true, name: 'iDrive' }, enabled: true, access: 'pin', name: 'iDrive',
    video: { tool: true, probe: { decoder: 'v4l2h264dec', hardware: true, sink: 'waylandsink' } }, parked: true, addresses: ['192.168.43.1'],
};
const phone = { name: 'Anna\'s iPhone', state: 'mirroring' };
const models = {
    home: Object.assign({ view: 'home', aspect: 'fit', phone: null }, ready),
    pin: Object.assign({ view: 'home', aspect: 'fit', pin: '4817', phone: { name: 'Anna\'s iPhone', state: 'connecting' } }, ready),
    mirror: { view: 'mirror', aspect: 'fit', phone: phone, mirror: { state: 'playing' } },
    stretch: { view: 'mirror', aspect: 'stretch', phone: phone, mirror: { state: 'playing' } },
    logs: { view: 'logs', logs: sampleLogs, logPage: 0 },
};
const m = Object.assign({ focus: null }, models[variant]);
const { rec } = ui.draw(new ui.Recorder(), m);
const words = Array.from(rec.words());
const atlases = rec.atlases.map((a) => ({ id: a.id, w: a.w, h: a.h, alpha: a.alpha.toString('base64') }));
// the stand-in picture: a phone held upright (886x1920), where the video tool would show it
const pic = m.view === 'mirror' ? video.viewFor(ui.VIDEO, { width: 886, height: 1920 }, m.aspect).rect : null;

const html = `<!doctype html><meta charset="utf-8"><title>AirPlay preview</title>
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
const pic = ${JSON.stringify(pic)};
if (pic) { g.fillStyle = '#000'; g.fillRect(0, 0, ${ui.W}, ${ui.H}); const gr = g.createLinearGradient(pic.x, pic.y, pic.x + pic.w, pic.y + pic.h); gr.addColorStop(0, '#2b5fa8'); gr.addColorStop(1, '#7a3b8f'); g.fillStyle = gr; g.fillRect(pic.x, pic.y, pic.w, pic.h);
  g.fillStyle = 'rgba(255,255,255,0.85)'; for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { const s = Math.min(pic.w, pic.h * 886 / 1920) * 0.14; const x = pic.x + pic.w * (0.14 + c * 0.2), y = pic.y + pic.h * (0.12 + r * 0.11); rr(x, y, pic.w * 0.12, pic.h * 0.06, 12); g.fill(); }
  g.fillStyle = 'rgba(255,255,255,0.4)'; g.font = '40px sans-serif'; g.textAlign = 'center'; g.fillText('the phone (video tool, hardware decoded)', pic.x + pic.w / 2, pic.y + pic.h - 40); }
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
