# Handover: BMW G87 M2 seat logo apps (iDrive 8, MGU Store)

Repository: `grabandrey/idrive-apps` (GitHub). Cars install from the `main` branch through **MGU Store**
(Settings → Add source → `grabandrey/idrive-apps`, branch `main`). Development has been on the branch
`claude/peaceful-carson-coh64w`, fast-forwarded into `main` when the owner asked. `main` is at `919dc69`
(Seat Lights 1.4.0).

## Goal

The owner's G87 M2 has illuminated **M logos in the seat headrests**. The car lights them at unlock (welcome
light) and switches them off once the car is started. The owner wants them to stay on.

## What exists, and the key finding

1. **Light Logger** (`ida_lightlog`, v1.3.1) — a read-only diagnostic app that logs the car's interior light
   modules. It found that the logos are driven by the **body controller's (BDC, diagnostic address `0x40`) lamp
   output 45**. The **exterior door handle lights share that same output**, so they light together; the owner
   accepted that.
2. **Seat Lights** (`ida_seatlights`, v1.4.0) — one ON/OFF switch that holds output 45 on through the head unit's
   diagnostic link (via `InternalTasu`), using the same approach the MIT-licensed `idrive7-apps` kit uses to drive
   these outputs. **It works while the car is parked or standing still.**

### The limitation (unresolved)

While the car is **moving**, the body controller **refuses** to keep the output on — it returns "conditions not
correct" (negative response, seen at 45 km/h), even though it still accepts the diagnostic session. This is an
**interlock inside the body controller itself**, almost certainly because output 45 also feeds the **exterior**
door handle lights, and BMW blocks control of exterior lighting while driving. The result: the logos go dark
shortly after moving off and come back at the next stop.

**This is the car saying no, not an app bug.** Seat Lights already retries sensibly: it keeps the switch ON,
re-asks the body controller periodically and the moment the car stops, and logs every time the lights drop and
return (with the speed). It does not try to defeat the interlock, and that is deliberate — overriding a body-
controller safety interlock, or unlocking/reflashing the module to do so, risks leaving the module (which runs
the car's lights, locks and much of its body electronics) faulty, and isn't something to attempt on a daily driver.

## Realistic ways forward (for whoever picks this up)

1. **Keep Seat Lights as-is.** Logos on while parked and at every stop; dark while moving. No further work.
2. **Rewiring (the route that actually keeps them on while driving).** G87 owners on BimmerPost describe moving
   the logo feed to a separate 12 V line (e.g. an interior circuit that stays live while driving), so the logos no
   longer depend on output 45 and the exterior-light interlock. Use a proper fuse tap or a professional installer —
   one owner shorted a wire and lost the interior lighting around the controls. Thread:
   https://g87.bimmerpost.com/forums/showthread/2098710/always-on-illuminated-seat-emblem
3. **BimmerCode (limited).** No confirmed option keeps them on while driving. The only lever owners mention is
   lengthening the **welcome light duration** in the BDC, which only extends how long they stay lit after unlock.

## Repository layout (what's relevant)

```
mgu-repo.json                 the components MGU Store offers (ids, versions, titles)
packages/lightlog/            Light Logger (read-only diagnostic logger)
  app/src/                    uds.js (diagnostic link), lamps.js (BDC lamp outputs), lin.js (RGB ambient modules),
                              finder.js, journal.js, screen_model.js, ui.js, gpu.js, ...
  README.md                   how it works, how to read the log
packages/seatlights/          Seat Lights (the switch)
  app/src/seat_light.js       holds output 45 on: layout search, the hold, the retries, the car-state logic
  app/src/uds.js              the diagnostic link; read requests + the single allow-listed hold for output 45 only
  app/src/ida_seatlights.js   the app: the switch, the screen, the Logs screen, the log file
  app/src/ui.js, ui_font.js, gpu.js, seat_images.js, log_ring.js
  app/tools/                  gen_package.js (regenerates the package), test_seatlights.js, bake_images.py, preview_ui.js
  design/                     seat_off.png, seat_on.png (the owner's seat photos), app_preview.*
  README.md                   full behaviour, the hold format, the car-state rules
packages/vitals/              an unrelated earlier app (cluster widget), not part of this task
scripts/test_all.js           runs every package's tests; CI runs it on each push
```

## How Seat Lights behaves now (so a maintainer doesn't re-derive it)

- **Switch ON** holds output 45 on; **OFF** hands it back to the car. The choice is saved; the app autostarts with
  the head unit, so with it ON the logos come on by themselves.
- **First time ON** it finds the record layout the BDC accepts (the G87 needed a 2-byte element form, element
  `0x2C` = output 45 minus 1), with the logos dark, and saves it. It verifies the output lit and nothing else did.
- **Off while locked:** when the car is locked (`VehicleCondition` = parked) with the engine off for a settling
  period, it hands the output back so the car switches the logos off as it locks.
- **While driving (the limitation above):** the hold is refused; the app keeps the switch ON, retries, and logs it.
- **Safety in the app:** `uds.js` only ever sends read requests plus the one hold command for output 45, to the
  BDC only; anything else is refused in code, and the tests check that.

## Dev notes

- Apps run **Node 8** on the head unit (no `?.`, `??`, `Object.fromEntries`). An app only gets its own folder.
- After changing a Seat Lights screen/manifest/version: `node packages/seatlights/app/tools/gen_package.js`.
- After changing the seat photos: `python packages/seatlights/app/tools/bake_images.py`.
- Run all tests: `node scripts/test_all.js`.
- Not affiliated with BMW; no BMW code or artwork is in the repo (the seat photos in `design/` are the owner's).

## Current status

Seat Lights 1.4.0 and Light Logger 1.3.1 are on `main` and installable. The "stays on while driving" request is
**not solved in software** and, per the finding above, isn't solvable through this output without hardware
(rewiring) or possibly BMW-level coding. Everything else the owner asked for is done.
