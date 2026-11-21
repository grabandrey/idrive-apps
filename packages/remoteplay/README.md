# Remote Play: your PlayStation on the car's screen, parked

An iDrive 8 app and a root tool that put your PlayStation on the car's centre screen, for when you're parked and
waiting. Sign in with a QR code from your phone, find and wake the console on the car's network, pair it with its
PIN, and play with the touch controls or a USB gamepad plugged into the car.

| Home | Play |
|---|---|
| ![Home](design/app_home.png) | ![Play](design/app_play.png) |
| ![Sign in](design/app_signin.png) | ![Pair](design/app_pin.png) |

> **⚠️ Experimental, untested on a car or with a console.** Every part runs and is tested on a desktop. The engine's
> pairing and session code is chiaki-ng's, which is widely used, but the whole chain (car, console, head-unit
> decoder) hasn't been tried together yet.

> **Only while parked.** Play and the video test start only when the car reports 0 km/h. Anything over 3 km/h
> stops the game and the video at once. So does losing the speed signal.

## The parts

| Component | What it does |
|---|---|
| `ida_remoteplay` (app) | The screens, sign-in, finding and waking the console, pairing, the touch controls, parked-only play |
| `ida-remoteplay-video` (tool, root) | Shows the video **at the stream's full frame rate** through the head unit's own GStreamer and **hardware decoder**, and reads a **USB gamepad** |
| `ida-remoteplay-engine` (tool, root, **AGPL-3.0**) | The console's Remote Play session: pairing, the encrypted stream, the controller back to the console. Built on [chiaki-ng](https://github.com/streetpea/chiaki-ng)'s library |

**Why a root tool for the video:** an app can only draw through the Renderer, a few pictures a second, with no
decoder. Full frame rate needs the head unit's own video hardware. The tool starts a GStreamer pipeline:

```
fdsrc ! h264parse ! <hardware decoder> ! <display> render-rectangle=<the middle of the Play screen> sync=false
```

`sync=false` shows each frame as soon as it arrives, so the console sets the frame rate (60 fps), not a clock.
Decoders are tried in this order: `v4l2h264dec`, `v4l2slh264dec`, `omxh264dec`, `vaapih264dec`, `nvv4l2decoder`,
`imxvpudec_h264`, … and `avdec_h264` last (software, rarely 60 fps). H.265 is used when the head unit decodes it
in hardware. Displays are tried in this order: `waylandsink`, `glimagesink`, `kmssink`, … The Home screen shows
what was found.

## Use

1. In MGU Store, add the source `grabandrey/idrive-apps` (branch `main`) if you haven't, and install **Remote Play**
   (`ida_remoteplay`, which installs **Remote Play Video**, `ida-remoteplay-video`, and **Remote Play Engine**,
   `ida-remoteplay-engine`, first). For the drawn screens,
   also install **Renderer** (`mgu-render`) from MGU Store's own source.
2. **The network:** the car and the PlayStation must be on the same network. The easy way is to turn on the car's
   Wi-Fi hotspot and connect the console to it. If the console stays home, it needs another way to reach the car:
   that's play over the internet through PSN, which the app doesn't offer yet.
3. **Video test** (Home): an 8-second moving picture at 1280×720, 60 fps. With an encoder on the head unit, it's
   encoded and decoded the way a stream is. The result is the frame rate the car really shows. Do this first: it
   shows whether full frame rate works on your head unit, before any console is involved.
4. **Sign in**: a QR code. With your phone on the car's hotspot, scan it, tap **Sign in with PlayStation**, sign in
   at Sony, then copy the address of the page that ends on *redirect* and paste it into the car's page. The car
   swaps the code for your account's number at Sony and keeps only that number (the console asks for it when
   pairing). No password or token is kept. If you already know your account ID (base64), the page takes it
   directly.
5. **Find console**, then **Pair**: on the PlayStation, go to *Settings > System > Remote Play > Pair Device* and
   type the 8 digits it shows.
6. **Play**. **Exit** (bottom left) ends it. **Wake** wakes a paired console from rest mode.

If the console asks for a login PIN when a device connects, the stream ends with a message saying so. Switch the
PIN off on the console to play from the car.

### The controls

The game fills the middle of the screen at 16:9. The controls sit beside it: L1/L2, the left stick and the d-pad on
the left, R1/R2, the face buttons and the right stick on the right, then Create, PS and Options.
**The Renderer reports one touch at a time,** so you can't hold a stick and press a button together. For real
games, plug a **USB gamepad** into the car (a DualSense or DualShock 4 by cable, or another standard pad). The
video tool reads it straight from the kernel, it takes over from the touch controls, and only Exit stays on screen.

## The engine

`engine/` is the stream engine: `engine.c`, a small program around chiaki-ng's Remote Play library (pairing with
`chiaki_regist`, the session with `chiaki_session`). Each video frame (H.264 or H.265, Annex B) goes to the video
tool's stream socket, and each controller state from the app becomes the session's controller state. The library is
linked **unmodified**, from upstream at a pinned commit.

Because it links chiaki-ng, the engine is **AGPL-3.0** (`engine/LICENSE`). Its source and build script are installed
with it on the car, and the other libraries' licences are in `engine/licenses/`. The rest of this repository stays MIT.

`engine/bin/x86_64/` and `engine/bin/aarch64/` hold the programs, one per processor the head unit may have. They're
static (musl), so they don't depend on the head unit's libraries. `start.sh` picks the right one. To rebuild them:

```
pip install ziglang protobuf grpcio-tools     # and git, cmake, ninja, protoc
packages/remoteplay/engine/build.sh           # both, or: build.sh x86_64
```

`build.sh` clones chiaki-ng (commit `43728af`) and what it links (OpenSSL 3.0.15, libevent 2.1.12, json-c 0.17,
miniupnpc 2.2.8, and chiaki-ng's own curl, nanopb, jerasure and gf-complete) and builds everything with `zig cc`.
Two things differ from a desktop chiaki-ng build. `musl_compat.c` provides `pthread_clockjoin_np`, a glibc-only
function the library uses. And it uses OpenSSL, the library's default: its Mbed TLS option writes a 32-byte HMAC
into a 16-byte buffer and crashes during pairing.

The app talks to it on `/run/ida-remoteplay-engine/engine.sock`, in JSON lines (see `app/src/links.js`):

| → engine | ← reply / event |
|---|---|
| `{"op":"hello","proto":1}` | `{"ok":true,"name","version","targets":["ps5","ps4"]}` |
| `{"op":"register","host","type","accountId","pin"}` | `{"ok":true,"registered":{"registKey","rpRegistKey","rpKey","nickname","mac",…}}` (the app keeps it as given) |
| `{"op":"start","host","type","accountId","registered","video":{"socket","codec","width","height","fps","bitrateKbps","rect"}}` | events `{"ev":"session","state":"connecting"\|"streaming"\|"ended","reason"}` |
| `{"op":"input","state":{"buttons":["cross",…],"lx","ly","rx","ry","l2","r2"}}` | none (sent on each change, and every 0.5 s) |
| `{"op":"stop"}` | `{"ok":true}` |

The video goes to `/run/ida-remoteplay-video/stream.sock`: first one JSON line,
`{"codec":"h264","width":1280,"height":720,"fps":60,"rect":{…}}`, then the frames. The engine asks the console for
a keyframe whenever it opens that socket, so the decoder always starts on a full picture.

**Not yet:** sound. The engine runs the session with audio off, because the car's audio belongs to BMW's system.
Play over the internet isn't offered either: the library can do it, but the app doesn't drive it yet.

## Settings and logs

- App: `remoteplay.json` (the account id and nickname, the console, the pairing, the stream size) and
  `remoteplay.log`, in the first writable folder of the app's home, its working folder and the temp folder. The
  **Logs** screen shows the same lines, as does the head unit's log (`RMPL`).
- Engine: its log is in the journal (`journalctl -u ida-remoteplay-engine`): pairing, the session, and why it ended.
- Video tool: `/var/opt/ida-remoteplay-video/settings.json` can name the decoder and display, for example
  `{"decoder":{"h264":"omxh264dec"},"sink":"kmssink","sinkProps":"fullscreen=true"}`. Its log is in the journal
  (`journalctl -u ida-remoteplay-video`): what it found, each pipeline, and the frame rate.

The sign-in page runs on port 8890 only while the Sign in screen is open. A random token in its address keeps out
anyone else on the hotspot.

## Package layout

```
app/                       the app (source package, id ida_remoteplay, built on the head unit)
  src/ida_remoteplay.js    the app: the screens' actions, parked-only play, the parts together
  src/login.js             the sign-in page on the hotspot, Sony's code -> the account id
  src/qr.js                a QR code encoder (byte mode, level M, versions 1-10)
  src/discovery.js         finding and waking consoles (UDP 9302 / 987)
  src/links.js             the video tool's and the engine's sockets (JSON lines)
  src/pad.js               the touch controller: the layout, touches -> the controller state
  src/gate.js              parked or not, from the speed
  src/ui.js                the drawn screens: home, sign in, pair, play, logs
  src/gpu.js, ui_font.js, log_ring.js, someip_link.js
                           Seat Lights' (the same files; the test fails when they differ)
  tools/test_remoteplay.js tests: the QR code, sign-in, discovery, the links, the controls, the gate, the screens,
                           the video tool's pipelines and frame counting, the gamepad, the package, and the engine
                           (its component, both programs, and the real x86_64 one answering the app)
  tools/preview_ui.js      design/app_<screen>.html (home | signin | pin | play | logs)
  tools/gen_package.js     the package tree
tool/                      the root tool (id ida-remoteplay-video)
  video.js                 GStreamer: the probe, the video test, the stream pipeline
  gamepad.js               a USB gamepad from /dev/input
engine/                    the root tool (id ida-remoteplay-engine), AGPL-3.0
  engine.c                 the engine: the socket, pairing, the session, video out, controller in
  musl_compat.c/.h         pthread_clockjoin_np for musl
  build.sh                 builds bin/<arch>/ida-rp-engine from upstream sources
  start.sh                 runs the one for this processor
  bin/x86_64, bin/aarch64  the built programs (static)
  LICENSE, licenses/       AGPL-3.0; the linked libraries' licences
```

Not affiliated with Sony Interactive Entertainment. PlayStation, PS5, DualSense and DualShock are Sony Interactive
Entertainment's trademarks, named here only to say what the app works with. MIT licensed, except `engine/`
(AGPL-3.0).
