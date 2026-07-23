<p align="center">
  <img src="https://raw.githubusercontent.com/mathiashornbek/homebridge-roborock-matter/main/assets/icon.png" width="140" alt="homebridge-roborock-matter icon">
</p>

<h1 align="center">homebridge-roborock-matter</h1>

<p align="center">
  <b>The most complete way to run your Roborock in Apple Home — every model, every feature, with live "cleaning in the kitchen" room tracking.</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/homebridge-roborock-matter"><img src="https://img.shields.io/npm/v/homebridge-roborock-matter?label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/homebridge-roborock-matter"><img src="https://img.shields.io/npm/dt/homebridge-roborock-matter?label=downloads&color=8a5cf5" alt="npm downloads"></a>
  <a href="https://github.com/mathiashornbek/homebridge-roborock-matter/actions"><img src="https://img.shields.io/github/actions/workflow/status/mathiashornbek/homebridge-roborock-matter/nodejs.yml?label=CI" alt="CI status"></a>
  <img src="https://img.shields.io/badge/node-22%20%7C%2024-brightgreen" alt="Node 22/24">
  <img src="https://img.shields.io/badge/homebridge-1.11%20%7C%202.x-purple" alt="Homebridge 1.11/2.x">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://paypal.me/MathiasHornbek"><img src="https://img.shields.io/badge/PayPal-Donate-00457C?logo=paypal&logoColor=white" alt="Donate via PayPal"></a>
</p>

<p align="center">
  <a href="https://github.com/homebridge/homebridge/wiki/Verified-Plugins"><img src="https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge" alt="Verified by Homebridge"></a>
</p>

---

Sign in with the same account you already use in the Roborock app — that's the whole setup. Every robot on your account then appears in Apple Home as a real vacuum: start and stop cleans, send it to specific rooms, pick the suction power, check the battery — and watch the Home app tell you **which room it's cleaning right now**. No token extraction, no network tricks, no command line.

This is the most feature-packed, most thoroughly engineered Roborock plugin for Homebridge — and the only one that speaks every generation of Roborock, including the newest.

## Why this plugin

- 🥇 **Every Roborock, fully supported.** The entire lineup works — from the classic S-series through the Q- and Saros families to the 2025 Q7 series (Q7 M5 / M5+), which speaks a brand-new protocol that no other Homebridge plugin understands. Brand-new models are adopted automatically with sensible defaults.
- 📍 **See where it's cleaning — live.** Apple Home shows _"Cleaning — Kitchen"_ with the room the robot is actually inside, updating as it moves from room to room. Works even for cleans started from the robot's button or the Roborock app. No other Homebridge plugin does this.
- 🧭 **One robot, one tile — and as many robots as you own.** Sign in once and your whole fleet comes along: every vacuum on your account appears as its own clean, native accessory in Apple Home. No clutter of fake fans and helper switches, and rooms appear with the names you gave them in the Roborock app.
- ⚡ **Fast and reliable.** Commands go directly to the robot over your own network whenever possible, with the Roborock cloud as automatic backup — and built-in diagnostics in the settings if you ever want to look under the hood.
- 🛡️ **Verified by Homebridge.** Reviewed and endorsed by the Homebridge team. 263 automated tests, zero known vulnerabilities, no analytics, and a startup designed to never crash your Homebridge — even when your Wi-Fi or the Roborock cloud has a bad day.

## Features

|                                     |                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 🤖 **Full control from Apple Home** | Start, stop, pause and send the robot home to its dock — from the Home app, Siri, or automations                                 |
| 🚪 **Clean specific rooms**         | Pick rooms right in Apple Home, with the names you gave them in the Roborock app — multi-floor homes included                    |
| 📍 **Live room tracking**           | See which room the robot is cleaning right now, updated as it moves ([details](#live-room-tracking))                             |
| 📊 **Honest cleaning progress**     | Each room goes pending → cleaning → done — and a room only counts as done when the robot was actually there                      |
| 🌀 **Cleaning & suction modes**     | Vacuum / Mop / Vacuum + Mop on models that support it — plus optional Quiet / Balanced / Turbo / Max suction levels (Max+ on Q7) |
| 🔋 **Battery & charging**           | Battery level and charging state on the accessory ([one Apple-side caveat](#battery-percentage-in-apple-home))                   |
| 🧠 **New models just work**         | Brand-new Roborock models get sensible defaults automatically, and the plugin adapts to what each robot actually supports        |
| 🩺 **Built-in diagnostics**         | Connection status, a one-click connection test, and a ready-to-share report if you ever need help                                |
| 🔐 **Easy, safe login**             | Sign in with your Roborock account right in the settings — two-factor supported, session stored encrypted                        |

## Quick start

1. Install through the Homebridge UI (search for **`homebridge-roborock-matter`**) or:

   ```bash
   npm install -g homebridge-roborock-matter
   ```

2. Open the plugin settings, sign in with your **Roborock app account** (2FA supported), and pick which robots to manage.
3. Enable **Matter** for the plugin's child bridge, restart Homebridge, and add each robot to Apple Home with the pairing code from the **Matter Pairing** section of the settings.

For B01/Q7 robots, room selection appears once the map has been fetched (watch for a `B01 rooms for ...` log line). Robots paired _before_ rooms were available need one remove/re-pair in Apple Home — Matter fixes an accessory's capabilities at commissioning time.

## Live room tracking

While your robot cleans, the plugin follows its position on the map and tells Apple Home which room it's in — _"Cleaning — Kitchen"_, just like the Roborock app shows it. It updates as the robot moves, works for whole-home cleans, and even for cleans you start from the robot's button.

Progress stays honest: a room is only shown as _completed_ once the robot was actually seen inside it. The plugin never invents data the robot didn't report. Enabled by default; turn it off with `enableLiveRoomTracking: false`.

<details>
<summary>How it works under the hood</summary>

While a robot is actively cleaning, the plugin fetches its live position from the map channel (throttled to ~20 s, active runs only, nothing while docked or paused) and publishes the room it is inside as the Matter Service Area `currentArea`. Both robot generations are covered: **B01/Q7** robots via the encrypted SCMap protobuf (position ray-cast against per-room boundary outlines), **classic S/Q-series** robots via the RRMap segment grid (position resolved against per-pixel room segments — a single-byte lookup on the raw map buffer, ~1 µs per check).

</details>

## Suction modes (optional)

Enable **Enable Suction-Level Cleaning Modes** (`enableFanPowerCleanModes`) and Apple Home's mode picker gains the suction levels — rendered by Apple with localized names from the Matter mode tags: **Quiet / Automatic / Quick / Max** (+ **Deep Clean** for the Q7's Max+ level). The current mode follows the robot live, so suction changed in the Roborock app shows up in Apple Home too.

The clean mode follows the robot as well: start a vacuum+mop or mop-only clean from the Roborock app (or the robot's buttons) and Apple Home switches to the matching mode during the run — no setup needed.

> ⚠️ **Re-pairing required:** Matter locks an accessory's mode list at commissioning. After enabling (or disabling) this option, restart Homebridge, then **remove the robot from Apple Home and pair it again** — otherwise the new modes will not appear. The same applies to any option that changes announced capabilities.

## Supported robots

**The entire Roborock lineup.** If it runs in the Roborock app, this plugin can control it:

- **2025 Q7 series** (`roborock.vacuum.sc05`, Q7 M5 / M5+) — the only Homebridge plugin that supports these at all, including manual-tank mopping with vacuum/mop mode switching.
- **Classic S-, Q- and Saros-series** — S5 through S8 Pro Ultra, Q5/Q7/Q8/Q Revo families, Saros, and newer.
- **Future models** are adopted automatically: the plugin reads what each robot says it can do and adapts, so brand-new releases get sensible defaults from day one. If something looks off, [open a model report](https://github.com/mathiashornbek/homebridge-roborock-matter/issues) with a diagnostics export — that's exactly what it's for.

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

Apple Home renders the battery percentage from pairing time and refreshes it only on a fresh read (commissioning, hub restart) — while charging state on the very same cluster updates live. This is a controller-side limitation, not a plugin bug, and it is being investigated upstream with the Homebridge team ([homebridge#3958](https://github.com/homebridge/homebridge/issues/3958)). Current state of knowledge: as of Matter 1.4 the attribute carries the **"quieter" (Q)** reporting quality — reports ARE sent over the subscription (rate-limited to one per 10 s), a Homebridge maintainer verified that a spec-compliant matter.js controller receives and applies them, yet Apple Home in steady state does not. The likely permanent fix is on Apple's side (Apple Feedback).

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

Model reports, diagnostics exports, and pull requests are very welcome. The codebase ships with 263 tests (protocol fixtures verified against the [python-roborock](https://github.com/Python-roborock/python-roborock) reference), strict TypeScript checking, and CI across Node 22/24 × Homebridge 1.11/2.x — `npm test` before you push and you're set.

## Support the project

If this plugin makes your home a little smarter, you can support its development via [PayPal](https://paypal.me/MathiasHornbek) — or through the ❤️ **Donate** button on the plugin's tile in the Homebridge UI. Model reports and diagnostics exports are just as valuable!

## Attribution

A Matter-only fork of [`homebridge-roborock-vacuum2`](https://github.com/applemanj/homebridge-roborock-vacuum2) by **Joshua Appleman**, itself adapted from [ioBroker.roborock](https://github.com/copystring/ioBroker.roborock) by **copystring**, with original work by **Nico Hartung**. B01/Q7 protocol work is implemented against the [python-roborock](https://github.com/Python-roborock/python-roborock) reference. All original copyright is preserved under the [MIT license](./LICENSE).

---

<p align="center">
  <sub>Not affiliated with or endorsed by Roborock, Apple, or the Connectivity Standards Alliance. Roborock is a trademark of Beijing Roborock Technology Co., Ltd.</sub>
</p>
