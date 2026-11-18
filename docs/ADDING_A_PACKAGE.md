# Adding a package

A package is one product in `packages/<name>/`. It holds a **tool** (a root service, like a cluster widget
renderer), an **app** (an iDrive app with its own screen and BMW's SDK), or both.

## 1. Ids and names

MGU Store ids are global on the head unit, so every id here starts with **`ida`**:

| Kind | Id form | Example |
|---|---|---|
| tool | `ida-<name>[-<part>]` (hyphens) | `ida-vitals-cluster` |
| app | `ida_<name>` (underscores) | `ida_vitals` |

`scripts/test_all.js` refuses any other form. Never reuse an id another source or BMW uses.

Anything that lives on the head unit is named after the tool's id: `/var/opt/<tool id>/` (installed files and
settings), `/run/<tool id>/` (sockets), `<tool id>.service`.

## 2. Folders

```
packages/<name>/
  README.md                what it does, what it needs first, install steps, settings
  tool/                    component.json + its files (see packages/vitals/tool)
  app/                     mgu-app.json, src/, package/ (the staged tree), tools/ (see packages/vitals/app)
    tools/test_*.js        tests: plain Node scripts, no BMW SDK; exit non-zero on failure
  design/                  browser previews (optional)
```

Code shared by several packages goes in `shared/`. A tool or app only gets what its own folder holds on the car,
so copy shared runtime files into the package at build time rather than requiring them across folders. Fonts
and scripts that run on a desktop can stay shared.

## 3. List it in mgu-repo.json

```json
{ "id": "ida-<name>-...", "kind": "tool", "path": "packages/<name>/tool", "mguHmi": ["ID8"] },
{ "id": "ida_<name>", "kind": "app", "path": "packages/<name>/app", "build": "unit",
  "title": "...", "description": "...", "requires": { "ida-<name>-...": "1.0.0" },
  "uninstallable": true, "mguHmi": ["ID8"] }
```

- `mguHmi`: `["ID7"]`, `["ID8"]` or both. The Store won't install a component on a head unit it isn't listed for.
- `requires`: components installed first, at least that version (tools from other sources too, for example
  `cluster-render`).

## 4. Versions

Every change that should reach cars needs a higher version (`x.y.z`):

- tool: `version` in `component.json`
- app: `version` in `mgu-app.json`, then run the app's `tools/gen_package.js` so `package/package.json` matches
  (the test runner checks)
- bump a `requires` when the other side needs the newer version

Cars following the `main` branch see every commit. Merge to `main` only what's ready.

## 5. Test

```
node scripts/test_all.js
```

It checks every `mgu-repo.json` entry: id form, folder, manifest id and version, each listed file and module,
and that `package.json` is regenerated. Then it runs every `tools/test_*.js` under `packages/`. CI runs the same
on every push.

## Apps: things that matter on the car

- An app may `require` only its own modules (`./file.js`), the BMW SDK modules listed in `mgu-app.json` `sdk`,
  and Node built-ins. The head unit links them at install. No npm packages, and no BMW SDK files in the repository.
- The car runs **Node 8**: no optional chaining (`?.`), no `??`, no `Object.fromEntries`.
- Data from the car: declare each interface and field in the app's `manifest.json` `proxies` (see Vitals'
  `tools/gen_package.js`), then read it with `someipBuilders.buildTypedProxy(iface, instance)`.
- An app's entry point uuid must stay the same across versions. Generate new uuids only for a new app.
