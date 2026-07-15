<p align="center">
  <img src="https://raw.githubusercontent.com/mathiashornbek/homebridge-roborock-matter/main/assets/icon.png" width="140" alt="homebridge-roborock-matter icon">
</p>

<h1 align="center">homebridge-roborock-matter</h1>

<p align="center">
  <b>Your Roborock vacuum as a native Matter robot in Apple Home — with live "cleaning in the kitchen" room tracking.</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/homebridge-roborock-matter"><img src="https://img.shields.io/npm/v/homebridge-roborock-matter?label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/homebridge-roborock-matter"><img src="https://img.shields.io/npm/dt/homebridge-roborock-matter?label=downloads&color=8a5cf5" alt="npm downloads"></a>
  <a href="https://github.com/mathiashornbek/homebridge-roborock-matter/actions"><img src="https://img.shields.io/github/actions/workflow/status/mathiashornbek/homebridge-roborock-matter/nodejs.yml?label=CI" alt="CI status"></a>
  <img src="https://img.shields.io/badge/node-22%20%7C%2024-brightgreen" alt="Node 22/24">
  <img src="https://img.shields.io/badge/homebridge-1.11%20%7C%202.x-purple" alt="Homebridge 1.11/2.x">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

---

Log in with your **Roborock app account** — no token extraction, no rooted apps, no packet sniffing — and every robot appears in Apple Home as a first-class **Matter Robotic Vacuum Cleaner**: start, pause, dock, pick rooms, choose cleaning modes, and watch the status pill name the room the robot is _actually inside_, live.

## Why this plugin

- 🗣️ **The only plugin that speaks 2025 Roborock.** The B01/Q7-series (`roborock.vacuum.sc05`, Q7 M5 / M5+) exists solely in the Roborock app ecosystem — a new RPC dialect with an encrypted protobuf map channel that miio-based plugins cannot talk to at all. Fully implemented here: commands, status, battery, suction levels, room cleaning, and the map channel.
- 📍 **Live room tracking — on every robot.** While the robot works, its position is read from the map channel (encrypted SCMap on B01/Q7, classic RRMap on S/Q-series), matched against your room geometry, and published as the current Matter Service Area. Apple Home shows _"Cleaning — Kitchen"_ — including runs started from the robot's button or the Roborock app. No other Homebridge plugin does this.
- 🧭 **Matter-only, by design.** No legacy fan tiles, no helper-switch clutter. One robot, one native accessory, on Homebridge 2's built-in Matter bridge — including room/map selection sourced from your Roborock account's named rooms.
- 🔌 **Cloud + local, automatically.** Commands prefer a direct local TCP connection to the robot and fall back to the Roborock cloud transparently, with per-device connection diagnostics in the settings UI when you want to see exactly what happened.
- 🛡️ **Hardened and boring where it counts.** 256 automated tests, CI on Node 22/24 against Homebridge 1.11 and 2.x, zero known vulnerabilities, no analytics, no post-install scripts, and a startup that retries with backoff instead of ever crash-looping Homebridge — verified against the Homebridge plugin-verification harness.

## Features

|                                      |                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| 🤖 **Native Matter RVC**             | Start / stop / pause / return-to-dock, run modes, operational state, error reporting                                                  |
| 🚪 **Room cleaning from Apple Home** | Matter Service Area selection with your real room names, multi-map homes included                                                     |
| 📍 **Live room tracking**            | The room the robot is physically inside, updated every ~20 s while cleaning ([details](#live-room-tracking))                          |
| 📊 **Honest cleaning progress**      | Per-room pending → operating → completed, only claiming rooms the robot was actually detected in                                      |
| 🌀 **Cleaning modes**                | Vacuum / Mop / Vacuum + Mop, capability-gated per robot — plus optional Quiet / Balanced / Turbo / Max suction modes (and Max+ on Q7) |
| 🔋 **Battery & charging**            | Live percentage and charge state via Matter PowerSource ([one Apple-side caveat](#battery-percentage-in-apple-home))                  |
| 🧠 **Self-adapting model support**   | Unknown models get capability-derived polling; requests a robot reports as unsupported are disabled automatically                     |
| 🩺 **Built-in diagnostics**          | Connection state, transport history, live LAN probe, and a redacted report generator for bug reports                                  |
| 🔐 **2FA-friendly login**            | Roborock account two-factor authentication handled entirely in the settings UI                                                        |

## Quick start

1. Install through the Homebridge UI (search for **`homebridge-roborock-matter`**) or:

   ```bash
   npm install -g homebridge-roborock-matter
   ```

2. Open the plugin settings, sign in with your **Roborock app account** (2FA supported), and pick which robots to manage.
3. Enable **Matter** for the plugin's child bridge, restart Homebridge, and add each robot to Apple Home with the pairing code from the **Matter Pairing** section of the settings.

For B01/Q7 robots, room selection appears once the map has been fetched (watch for a `B01 rooms for ...` log line). Robots paired _before_ rooms were available need one remove/re-pair in Apple Home — Matter fixes an accessory's capabilities at commissioning time.

## Live room tracking

While a robot is actively cleaning, the plugin fetches its live position from the map channel (throttled to ~20 s, active runs only, nothing while docked or paused) and publishes the room it is inside as the Matter Service Area `currentArea`. Both robot generations are covered: **B01/Q7** robots via the encrypted SCMap protobuf (position ray-cast against per-room boundary outlines), **classic S/Q-series** robots via the RRMap segment grid (position resolved against per-pixel room segments):

- Apple Home's status pill names the room the robot is **physically inside** — the way the vendor app does it.
- Works for full-home cleans and for runs started from the robot's button or the Roborock app, which previously had no room to show at all.
- Progress stays honest: a room is only marked _completed_ once the robot was actually detected inside it and has moved on. The plugin never invents data the robot didn't report.

Enabled by default; opt out with `enableLiveRoomTracking: false`.

## Suction modes (optional)

Enable **Enable Suction-Level Cleaning Modes** (`enableFanPowerCleanModes`) and Apple Home's mode picker gains the suction levels — rendered by Apple with localized names from the Matter mode tags: **Quiet / Automatic / Quick / Max** (+ **Deep Clean** for the Q7's Max+ level). The current mode follows the robot live, so suction changed in the Roborock app shows up in Apple Home too.

> ⚠️ **Re-pairing required:** Matter locks an accessory's mode list at commissioning. After enabling (or disabling) this option, restart Homebridge, then **remove the robot from Apple Home and pair it again** — otherwise the new modes will not appear. The same applies to any option that changes announced capabilities.

## Supported robots

- **B01/Q7-series (2025):** `roborock.vacuum.sc05` and compatible (Q7 M5 / M5+), including manual-tank mopping with vacuum/mop mode switching.
- **Classic app-account Roborock vacuums** supported by the upstream lineage (S-series, Q-series, Saros — S5 through S8 Pro Ultra, Q5/Q7/Q8/Q Revo families and newer), published as Matter accessories.
- Brand-new models get capability-derived defaults automatically. If something looks off, [open a model report](https://github.com/mathiashornbek/homebridge-roborock-matter/issues) with a diagnostics export — that's exactly what it's for.

## Configuration

Everything is configurable from the Homebridge UI. The essentials:

| Option                          | Default | What it does                                                                                                                                                                  |
| ------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email` / password              | —       | Your Roborock app account (2FA handled in the UI; the session token is stored encrypted)                                                                                      |
| `skipDevices`                   | —       | Comma-separated device IDs the plugin should ignore                                                                                                                           |
| `enableMatterServiceArea`       | `true`  | Room/map selection in Apple Home                                                                                                                                              |
| `enableLiveRoomTracking`        | `true`  | Live current-room from the robot's map position while cleaning                                                                                                                |
| `enableMatterCleanMode`         | `true`  | Vacuum / Mop / Vacuum + Mop mode selection                                                                                                                                    |
| `enableFanPowerCleanModes`      | `false` | Adds Quiet / Balanced / Turbo / Max (and Max+ on Q7) suction modes to the Matter mode list. **Re-pair the robot once after toggling** — Matter locks the mode list at pairing |
| `enableMatterPowerSource`       | `true`  | Battery cluster                                                                                                                                                               |
| `cloudOnlyMode`                 | `false` | Skip local TCP entirely and use the cloud for everything                                                                                                                      |
| `transientWarningThrottleHours` | `6`     | How often recurring transient-timeout warnings may repeat (0 = only in debug)                                                                                                 |

## Battery percentage in Apple Home

Apple Home renders the battery percentage from pairing time and never re-reads it — the Matter attribute carries the spec's "changes omitted" reporting quality, so value changes are not pushed to controllers _by design_ (charging state on the very same cluster updates live). This is a controller-side limitation verified end-to-end, not a plugin bug.

<details>
<summary>The full evidence chain and workarounds</summary>

The complete path — robot → plugin → Homebridge → matter.js store — was verified to carry the live value in real time while Apple kept rendering the pairing-day percentage. matter.js's own controller documents the consequence ("always read attributes that do not report changes via subscriptions"); Apple's controller performs no such re-reads. The plugin performs a one-time battery resync each boot so controllers that re-prime their subscriptions pick up a fresh value. Known refresh paths: restarting the Matter hub (HomePod/Apple TV) or re-pairing. A ready-to-file upstream report with the full evidence lives in [`docs/matter-battery-issue-draft.md`](./docs/matter-battery-issue-draft.md).

</details>

## Troubleshooting

- **Diagnostics first:** the plugin settings include per-device connection state, the last cloud/local transport used, a live **Test Local Connection** probe, and a **redacted diagnostics report** you can paste straight into a GitHub issue.
- **Robot shows "Updating…" in Apple Home:** remove the robot from Apple Home and pair it again — a stale controller cache from an earlier pairing is the usual cause (tracked upstream in homebridge/homebridge#3951).
- **Rooms missing for a Q7/B01 robot:** wait for the `B01 rooms for ...` log line, then re-pair once so the Service Area cluster is announced with room data.
- **Startup without network:** the plugin retries the Roborock cloud with increasing backoff (up to 10 attempts) and never crash-loops Homebridge; wrong credentials stop cleanly with a clear log message.

## Contributing

Model reports, diagnostics exports, and pull requests are very welcome. The codebase ships with 256 tests (protocol fixtures verified against the [python-roborock](https://github.com/Python-roborock/python-roborock) reference), strict TypeScript checking, and CI across Node 22/24 × Homebridge 1.11/2.x — `npm test` before you push and you're set.

## Attribution

A Matter-only fork of [`homebridge-roborock-vacuum2`](https://github.com/applemanj/homebridge-roborock-vacuum2) by **Joshua Appleman**, itself adapted from [ioBroker.roborock](https://github.com/copystring/ioBroker.roborock) by **copystring**, with original work by **Nico Hartung**. B01/Q7 protocol work is implemented against the [python-roborock](https://github.com/Python-roborock/python-roborock) reference. All original copyright is preserved under the [MIT license](./LICENSE).

---

<p align="center">
  <sub>Not affiliated with or endorsed by Roborock, Apple, or the Connectivity Standards Alliance. Roborock is a trademark of Beijing Roborock Technology Co., Ltd.</sub>
</p>
