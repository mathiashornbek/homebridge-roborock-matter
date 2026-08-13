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
- 🛡️ **Verified by Homebridge.** Reviewed and endorsed by the Homebridge team. 726 automated tests, zero known vulnerabilities, no analytics, and a startup designed to never crash your Homebridge — even when your Wi-Fi or the Roborock cloud has a bad day.

## Features

|                                     |                                                                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🤖 **Full control from Apple Home** | Start, stop, pause and send the robot home to its dock — from the Home app or Siri                                                                                               |
| 🕹️ **Switches for automations**     | Optional per-robot Start Cleaning, Return to Dock, Pause and Find switches — Apple Home does not offer a dock action for a Matter vacuum ([details](#automations-in-apple-home)) |
| 🚪 **Clean specific rooms**         | Pick rooms right in Apple Home, with the names you gave them in the Roborock app — multi-floor homes included                                                                    |
| 📍 **Live room tracking**           | See which room the robot is cleaning right now, updated as it moves ([details](#live-room-tracking))                                                                             |
| 📊 **Honest cleaning progress**     | Each room goes pending → cleaning → done — and a room only counts as done when the robot was actually there                                                                      |
| 🌀 **Cleaning & suction modes**     | Vacuum / Mop / Vacuum + Mop on models that support it — plus optional Quiet / Balanced / Turbo / Max suction levels (Max+ on Q7)                                                 |
| 🔋 **Battery & charging**           | Battery level and charging state on the accessory ([one Apple-side caveat](#battery-percentage-in-apple-home))                                                                   |
| 🧠 **New models just work**         | Brand-new Roborock models get sensible defaults automatically, and the plugin adapts to what each robot actually supports                                                        |
| 🩺 **Built-in diagnostics**         | Connection status, a one-click connection test, and a ready-to-share report if you ever need help                                                                                |
| 🔐 **Easy, safe login**             | Sign in with your Roborock account right in the settings — two-factor supported, session stored encrypted                                                                        |

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

While a robot is actively cleaning, the plugin fetches its live position from the map channel (the first room of a run goes out immediately, then ~10 s apart, active runs only, nothing while docked or paused) and publishes the room it is inside as the Matter Service Area `currentArea`. Both robot generations are covered: **B01/Q7** robots via the encrypted SCMap protobuf (position ray-cast against per-room boundary outlines), **classic S/Q-series** robots via the RRMap segment grid (position resolved against per-pixel room segments — a single-byte lookup on the raw map buffer, ~1 µs per check).

</details>

## Suction modes (optional)

Enable **Enable Suction-Level Cleaning Modes** (`enableFanPowerCleanModes`) and Apple Home's mode picker gains the suction levels — rendered by Apple with localized names from the Matter mode tags: **Quiet / Automatic / Quick / Max** (+ **Deep Clean** for the Q7's Max+ level). The current mode follows the robot live, so suction changed in the Roborock app shows up in Apple Home too.

The clean mode follows the robot as well: start a vacuum+mop or mop-only clean from the Roborock app (or the robot's buttons) and Apple Home switches to the matching mode during the run — no setup needed.

> ⚠️ **Re-pairing required:** Matter locks an accessory's mode list at commissioning. After enabling (or disabling) this option, restart Homebridge, then **remove the robot from Apple Home and pair it again** — otherwise the new modes will not appear. The same applies to any option that changes announced capabilities.

## Supported robots

**The entire Roborock lineup.** If it runs in the Roborock app, this plugin can control it:

- **2025 Q7 series** (`roborock.vacuum.sc05`, Q7 M5 / M5+) — the only Homebridge plugin that supports these at all, including manual-tank mopping with vacuum/mop mode switching.
- **Classic S-, Q- and Saros-series** — S4 / S5 Max through S8 Pro Ultra, Q5/Q7/Q8/Q Revo families, Saros, and newer.

> **Heads-up for early models:** a few legacy robots — most notably the original S5 — only work with Xiaomi's Mi Home app and can never be added to a Roborock account, so no Roborock-account plugin can reach them. For those, [homebridge-xiaomi-roborock-vacuum](https://github.com/homebridge-xiaomi-roborock-vacuum/homebridge-xiaomi-roborock-vacuum) is the right tool.

- **Future models** are adopted automatically: the plugin reads what each robot says it can do and adapts, so brand-new releases get sensible defaults from day one. If something looks off, [open a model report](https://github.com/mathiashornbek/homebridge-roborock-matter/issues) with a diagnostics export — that's exactly what it's for.

## Configuration

Everything is configurable from the Homebridge UI. The essentials:

| Option                          | Default    | What it does                                                                                                                                                                                                  |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email` / password              | —          | Your Roborock app account (2FA handled in the UI; the session token is stored encrypted)                                                                                                                      |
| `skipDevices`                   | —          | Comma-separated device IDs the plugin should ignore                                                                                                                                                           |
| `enableMatterServiceArea`       | `true`     | Room/map selection in Apple Home                                                                                                                                                                              |
| `enableLiveRoomTracking`        | `true`     | Live current-room from the robot's map position while cleaning                                                                                                                                                |
| `enableMatterCleanMode`         | `true`     | Vacuum / Mop / Vacuum + Mop mode selection                                                                                                                                                                    |
| `enableFanPowerCleanModes`      | `false`    | Adds Quiet / Balanced / Turbo / Max (and Max+ on Q7) suction modes to the Matter mode list. **Re-pair the robot once after toggling** — Matter locks the mode list at pairing                                 |
| `enableMatterPowerSource`       | `true`     | Battery cluster                                                                                                                                                                                               |
| `enableMatterFaultReporting`    | `false`    | Report a robot that has genuinely halted as Error instead of Ready ([details](#why-the-robot-needs-attention))                                                                                                |
| `enableHomeKitActionSwitches`   | `false`    | Adds a plain Home app switch per robot for Start Cleaning / Return to Dock / Pause / Find, so automations can reach commands Apple does not offer for a Matter vacuum ([details](#automations-in-apple-home)) |
| `homeKitActionSwitches`         | `["dock"]` | Which of those switches to publish: `clean`, `dock`, `pause`, `locate`                                                                                                                                        |
| `cloudOnlyMode`                 | `false`    | Skip local TCP entirely and use the cloud for everything                                                                                                                                                      |
| `transientWarningThrottleHours` | `6`        | How often recurring transient-timeout warnings may repeat (0 = only in debug)                                                                                                                                 |

## Why the robot needs attention

By default a robot that has stopped for any reason shows as **Ready** in Apple Home — whether it finished the job or is wedged under the sofa. Turning on **Report faults in Apple Home** changes that: a robot that is stuck, has a blocked brush or wheel, a missing dust bin, a flat battery or a dock it cannot reach reports the Matter **Error** state instead of Ready. It is off by default because a robot in Error may be refused a Start command by Apple Home.

**Dock and tank conditions are deliberately not reported, and this is worth explaining.** The plugin can read them all accurately — empty clean-water tank, full waste-water tank, missing dust bag, blocked air duct — and two releases tried to surface them through Matter's fault attribute (`OperationalError`). Four controlled tests on an S8 Pro Ultra with a genuinely empty clean-water tank showed it does not work: Apple Home drew no warning when the fault was published beside a Charging state, and drew no warning in the final test either, where the robot was raised all the way to the Matter **Error** state carrying "Clean water tank empty" — the tile simply kept reading Ready. **Apple Home does not appear to render Matter vacuum faults from a bridged accessory at all** — which is also why an earlier version removed the same write back in 1.4.61. Reporting them was therefore pure cost, and the attribute is no longer published in any configuration.

This section also used to blame the setting for a tile stuck on "Updating…", which was not caused by it: in the final test the same robot, with both switches on, stayed in Ready throughout. That wedge came from a stale pairing left behind by an earlier install — see [Troubleshooting](#troubleshooting). The correction is stated here rather than quietly deleted, because someone may have left the feature switched off on the strength of it.

A detached water tank or mop pad is never treated as a fault either: that is the normal, correct configuration for a vacuum-only run.

## Automations in Apple Home

Every command lives on the tile: start, stop, pause and send-to-dock all work from the Home app and from Siri, because the plugin implements Matter's own `RvcOperationalState` commands — including **GoHome**, which is exactly what the dock button sends.

What Apple offers _inside_ Home automations is a separate question, and it is Apple's to answer, not the plugin's. It has now been measured three times by the same user in [#3](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/3), and the answer turns out to be partial rather than flat:

- **Starting a clean is offered as an automation action** — either the whole home or a chosen set of rooms — and so is **stopping** or **pausing** a clean that is already running. An Apple Home schedule can therefore do the things most schedules are built for, without any help from this section.
- **Sending the vacuum to its dock is not offered as an automation action.** A robot that finishes a clean normally returns to its dock by itself, so the gap only shows up when you want to end a clean early: the automation can cut it short, but it cannot call the robot home.
- **A Matter vacuum is not offered as an automation _trigger_ at all.** The vacuum could not be selected when setting an automation's trigger — only when choosing its action. "When the robot finishes cleaning, close the balcony door" is therefore not expressible in Apple Home today, and the switches below do not change it: they are inputs an automation can turn on, not accessories that report what the robot is doing.
- **Whether an automation can resume a paused clean has not been measured.** Nobody has looked, so this page claims nothing about it in either direction.

**Optional Home app switches close the docking gap.** Turn on **Add Home app switches for Start, Dock, Pause and Find** in the plugin settings and each robot gets one plain HomeKit switch per action you pick — `Vicky Start Cleaning`, `Vicky Return to Dock`, `Vicky Pause`, `Vicky Find`. A switch is something every automation, scene and Shortcut can turn on, which is the whole point: an automation that cannot send the robot to its dock directly can flip a switch that does it instead. Each one is momentary and turns itself off again about a second and a half after it is pressed, so it never claims a command is still running.

**Start Cleaning starts the clean the tile would start.** That includes any rooms selected on the Matter tile: if the last thing you did in Apple Home was pick the kitchen, the switch cleans the kitchen. It is the same command with the same clean mode applied first, not a second idea of what starting means — a switch that ignored the selection you are looking at would be the surprising one. Clear the selection on the tile to get a whole-home clean.

A press takes exactly the same route as a press on the tile — the same acknowledgement wait, the same timing line in the log, the same retry if Roborock times out while the robot is still cleaning — and it moves the tile with it, so a robot sent home by a schedule does not sit there reading Ready. The log line names which surface asked, so `Sending Vicky back to dock from the Home switch.` and `Sending Vicky back to dock from Matter.` are told apart when a schedule misfires.

### The switches need their own pairing — a different QR code

This is the one step that quietly produces "I turned it on and nothing appeared", so it is worth reading before you do anything else. Your robot reaches Apple Home over **Matter**. These switches are ordinary **HomeKit** accessories, and they travel on this plugin's own Homebridge child bridge, which Apple Home pairs **separately**. The code you scanned for the vacuum does not cover them.

In the Homebridge UI, go to **Plugins → homebridge-roborock-matter → ⋮ → Child Bridge Config**, and then:

1. Check that **Enable HAP** is on. On a Matter-only setup it is frequently off — and while it is off, the switches exist inside Homebridge but are not published to anything, so no QR code anywhere will bring them in.
2. Save and restart Homebridge.
3. Return to the same screen and press **Connect to HomeKit**. That is the QR code to scan in the Home app.

It is **not** the main Homebridge QR code on the status page, and **not** the robot's Matter pairing code. The plugin tells you which of those three situations you are in: every start it writes one line naming the bridge the switches went to and what, if anything, is still missing.

Two smaller things. They are off by default because switching them on adds accessories to your Home app, one per robot per action. And the Find switch is only published for robots that actually support the command, because a switch that silently does nothing is worse than no switch at all.

Deselecting an action, or turning the feature off, removes those switches on the next restart. The robot itself is untouched throughout: it stays a Matter vacuum, and no re-pairing is needed to add or remove the switches.

## Battery percentage in Apple Home

Apple Home renders the battery percentage from pairing time and refreshes it only on a fresh read (commissioning, hub restart) — while charging state on the very same cluster updates live. This is not a plugin bug, and the root cause is now **confirmed in the source of matter.js** (the Matter stack Homebridge uses): the percentage attribute carries the spec's "changes omitted" quality, and matter.js currently never emits subscription reports for such attributes — while Apple Home never re-reads them on its own. The fix is tracked upstream in [matter-js/matter.js#4163](https://github.com/matter-js/matter.js/issues/4163) (an opt-in to report them anyway, which the spec permits); once it lands, Homebridge can enable it for bridged accessories and every plugin gets working battery percentages at once. Full investigation: [homebridge#3958](https://github.com/homebridge/homebridge/issues/3958).

<details>
<summary>The full evidence chain and workarounds</summary>

The complete path — robot → plugin → Homebridge → matter.js store — was verified to carry the live value in real time while Apple kept rendering the pairing-day percentage. matter.js's own controller documents the consequence ("always read attributes that do not report changes via subscriptions"); Apple's controller performs no such re-reads. The plugin performs a one-time battery resync each boot so controllers that re-prime their subscriptions pick up a fresh value. Known refresh paths: restarting the Matter hub (HomePod/Apple TV) or re-pairing. A ready-to-file upstream report with the full evidence lives in [`docs/matter-battery-issue-draft.md`](./docs/matter-battery-issue-draft.md).

</details>

## Troubleshooting

- **Diagnostics first:** the plugin settings include per-device connection state, the last cloud/local transport used, a live **Test Local Connection** probe, and a **redacted diagnostics report** you can paste straight into a GitHub issue.
- **Robot shows "Updating…" in Apple Home:** remove the robot from Apple Home and pair it again — a stale controller cache from an earlier pairing is the usual cause (tracked upstream in homebridge/homebridge#3951).
- **Rooms missing for a Q7/B01 robot:** wait for the `B01 rooms for ...` log line, then re-pair once so the Service Area cluster is announced with room data.
- **Debug logging needs two switches, not one:** the plugin's own **Debug Mode** only decides whether it _calls_ the debug logger — Homebridge decides whether anything is _printed_, and it suppresses plugin debug output unless Homebridge itself runs with `-D`. Turn on **Homebridge Settings → Homebridge Debug Mode** as well, or the log will look exactly the same as before.
- **Startup without network:** the plugin retries the Roborock cloud with increasing backoff (up to 10 attempts) and never crash-loops Homebridge; wrong credentials stop cleanly with a clear log message.

## Contributing

Model reports, diagnostics exports, and pull requests are very welcome. The codebase ships with 726 tests (protocol fixtures verified against the [python-roborock](https://github.com/Python-roborock/python-roborock) reference), strict TypeScript checking, and CI across Node 22/24 × Homebridge 1.11/2.x — `npm test` before you push and you're set.

## Support the project

If this plugin makes your home a little smarter, you can support its development via [PayPal](https://paypal.me/MathiasHornbek) — or through the ❤️ **Donate** button on the plugin's tile in the Homebridge UI. Model reports and diagnostics exports are just as valuable!

## Attribution

A Matter-only fork of [`homebridge-roborock-vacuum2`](https://github.com/applemanj/homebridge-roborock-vacuum2) by **Joshua Appleman**, itself adapted from [ioBroker.roborock](https://github.com/copystring/ioBroker.roborock) by **copystring**, with original work by **Nico Hartung**. B01/Q7 protocol work is implemented against the [python-roborock](https://github.com/Python-roborock/python-roborock) reference. All original copyright is preserved under the [MIT license](./LICENSE).

---

<p align="center">
  <sub>Not affiliated with or endorsed by Roborock, Apple, or the Connectivity Standards Alliance. Roborock is a trademark of Beijing Roborock Technology Co., Ltd.</sub>
</p>
