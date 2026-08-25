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
- 🛡️ **Verified by Homebridge.** Reviewed and endorsed by the Homebridge team. 1506 automated tests, zero known vulnerabilities, no analytics, and a startup designed to never crash your Homebridge — even when your Wi-Fi or the Roborock cloud has a bad day.

## Features

|                                       |                                                                                                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🤖 **Full control from Apple Home**   | Start, stop, pause and send the robot home to its dock — from the Home app or Siri                                                                                                                         |
| 🕹️ **Switches for automations**       | Optional per-robot Start Cleaning, Return to Dock, Pause and Find switches — Apple Home does not offer a dock action for a Matter vacuum ([details](#automations-in-apple-home))                           |
| 🎯 **Sensors as automation triggers** | Optional per-robot Docked, Cleaning and Water Tank Empty contact sensors — a Matter vacuum is not offered as an automation trigger at all, and a contact sensor is ([details](#automations-in-apple-home)) |
| 🗓️ **Roborock schedules as switches** | Optional per-robot switches that turn the schedules you made in the Roborock app on and off ([details](#automations-in-apple-home))                                                                        |
| 🚪 **Clean specific rooms**           | Pick rooms right in Apple Home, with the names you gave them in the Roborock app — multi-floor homes included                                                                                              |
| 📍 **Live room tracking**             | See which room the robot is cleaning right now, updated as it moves ([details](#live-room-tracking))                                                                                                       |
| 📊 **Honest cleaning progress**       | Each room goes pending → cleaning → done — and a room only counts as done when the robot was actually there                                                                                                |
| 🌀 **Cleaning & suction modes**       | Vacuum / Mop / Vacuum + Mop on models that support it — plus optional Quiet / Balanced / Turbo / Max suction levels (Max+ on Q7)                                                                           |
| 🔋 **Battery & charging**             | Battery level and charging state on the accessory ([one Apple-side caveat](#battery-percentage-in-apple-home))                                                                                             |
| 🧠 **New models just work**           | Brand-new Roborock models get sensible defaults automatically, and the plugin adapts to what each robot actually supports                                                                                  |
| 🩺 **Built-in diagnostics**           | Connection status, a one-click connection test, and a ready-to-share report if you ever need help                                                                                                          |
| 🔐 **Easy, safe login**               | Sign in with your Roborock account right in the settings — two-factor supported, session stored encrypted                                                                                                  |

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

**A B01/Q7 robot answers most of those fetches with a placeholder rather than its position, and that is normal.** Measured over a 47-minute clean, 227 fetches: 226 returned exactly the same cell, far outside the map the robot itself had built, while the rest resolved real rooms in the order the robot moved through them. So the room still updates on a Q7 — just on the fetches that carry a true position, which arrive alongside the robot's own map uploads rather than on every poll. A placeholder is now named as one instead of being reported as "the robot is between rooms", and it is said once per run rather than every ten seconds. Classic S/Q-series robots are unaffected and resolve every fetch.

</details>

## Suction modes (optional)

Enable **Enable Suction-Level Cleaning Modes** (`enableFanPowerCleanModes`) and Apple Home's mode picker gains the suction levels — rendered by Apple with localized names from the Matter mode tags: **Quiet / Automatic / Quick / Max** (+ **Deep Clean** for the Q7's Max+ level). The current mode follows the robot live, so suction changed in the Roborock app shows up in Apple Home too.

The clean mode follows the robot as well: start a vacuum+mop or mop-only clean from the Roborock app (or the robot's buttons) and Apple Home switches to the matching mode during the run — no setup needed.

> ⚠️ **Re-pairing required:** Matter locks an accessory's mode list at commissioning. After enabling (or disabling) this option, restart Homebridge, then **remove the robot from Apple Home and pair it again** — otherwise the new modes will not appear. The same applies to any option that changes announced capabilities.

> 🛑 **Turn a suction level off in Apple Home _before_ you disable this option.** Matter stores the selected clean mode on disk and restores it on every start, but it does not store the list of modes it is allowed to come from. So if a suction level (mode 3–7) is the one selected when you disable the option, the restored value is no longer in the announced list, and Matter refuses to bring the accessory up at all:
>
> ```
> Failed to register Matter accessory <name>: [endpoint-behaviors] Behaviors have errors
>   Caused by: [unsupported-mode] Can not use unsupported mode: 6. Allowed modes are 0, 1, 2
> ```
>
> The robot then disappears from Apple Home, and it stays gone on every restart — the stored value never becomes valid again on its own. **Recovery:** re-enable the option, restart, pick **Vacuum**, **Mop** or **Vacuum + Mop** in Apple Home, then disable the option and restart again. This is an upstream limitation rather than a plugin setting gone wrong; the full evidence is written up in [`docs/matter-clean-mode-shrink-issue-draft.md`](./docs/matter-clean-mode-shrink-issue-draft.md).

## Supported robots

**The entire Roborock lineup.** If it runs in the Roborock app, this plugin can control it:

- **2025 Q7 series** (`roborock.vacuum.sc05`, Q7 M5 / M5+) — the only Homebridge plugin that supports these at all, including manual-tank mopping with vacuum/mop mode switching.
- **Classic S-, Q- and Saros-series** — S4 / S5 Max through S8 Pro Ultra, Q5/Q7/Q8/Q Revo families, Saros, and newer.

> **Heads-up for early models:** a few legacy robots — most notably the original S5 — only work with Xiaomi's Mi Home app and can never be added to a Roborock account, so no Roborock-account plugin can reach them. For those, [homebridge-xiaomi-roborock-vacuum](https://github.com/homebridge-xiaomi-roborock-vacuum/homebridge-xiaomi-roborock-vacuum) is the right tool.

- **Future models** are adopted automatically: the plugin reads what each robot says it can do and adapts, so brand-new releases get sensible defaults from day one. If something looks off, [open a model report](https://github.com/mathiashornbek/homebridge-roborock-matter/issues) with a diagnostics export — that's exactly what it's for.

## Configuration

Everything is configurable from the Homebridge UI. The essentials:

| Option                                  | Default      | What it does                                                                                                                                                                                                                            |
| --------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email` / password                      | —            | Your Roborock app account (2FA handled in the UI; the session token is stored encrypted)                                                                                                                                                |
| `skipDevices`                           | —            | Comma-separated device IDs the plugin should ignore                                                                                                                                                                                     |
| `enableMatterServiceArea`               | `true`       | Room/map selection in Apple Home                                                                                                                                                                                                        |
| `enableLiveRoomTracking`                | `true`       | Live current-room from the robot's map position while cleaning                                                                                                                                                                          |
| `enableMatterCleanMode`                 | `true`       | Vacuum / Mop / Vacuum + Mop mode selection                                                                                                                                                                                              |
| `enableFanPowerCleanModes`              | `true`       | Quiet / Balanced / Turbo / Max (and Max+ on Q7) suction modes in the Matter mode list. **A robot paired before 3.12.0 needs one re-pair** — Matter locks the mode list at pairing                                                       |
| `enableMatterExtendedOperationalStates` | `true`       | Returning to dock, Emptying the dust bin, Washing the mop, Updating maps. **A robot paired before 3.12.0 needs one re-pair**                                                                                                            |
| `enableMatterChargingDockedStates`      | `true`       | The tile says Charging / Docked instead of Ready while the robot is on its dock                                                                                                                                                         |
| `enableMatterPowerSource`               | `true`       | Battery cluster                                                                                                                                                                                                                         |
| `enableMatterFaultReporting`            | `true`       | Report a robot that has genuinely halted as Error instead of Ready ([details](#why-the-robot-needs-attention))                                                                                                                          |
| `enableMatterTankFaultReporting`        | `true`       | Publish Matter's OperationalError attribute, which names the fault behind a stopped robot ([details](#why-the-robot-needs-attention))                                                                                                   |
| `enableMatterDockPhases`                | `true`       | Name the dock's own jobs as Matter phases, including drying the mop ([details](#what-the-dock-is-doing))                                                                                                                                |
| `enableHomeKitActionSwitches`           | `false`      | Adds a plain Home app switch per robot for Start Cleaning / Return to Dock / Empty Bin / Pause / Find, so automations can reach commands Apple does not offer for a Matter vacuum ([details](#automations-in-apple-home))               |
| `homeKitActionSwitches`                 | `["dock"]`   | Which of those switches to publish: `clean`, `dock`, `empty`, `pause`, `locate`. `empty` is published only for compatible auto-empty docks and runs only while the robot is docked.                                                     |
| `enableHomeKitStateSensors`             | `false`      | Adds a read-only Home app contact sensor per robot mirroring its state, so an automation can be _triggered_ by the robot — a Matter vacuum is not offered as a trigger, and a contact sensor is ([details](#automations-in-apple-home)) |
| `homeKitStateSensors`                   | `["docked"]` | Which of those sensors to publish: `docked`, `cleaning`, `waterTankEmpty`                                                                                                                                                               |
| `cloudOnlyMode`                         | `false`      | Skip local TCP entirely and use the cloud for everything                                                                                                                                                                                |
| `transientWarningThrottleHours`         | `6`          | How often recurring transient-timeout warnings may repeat (0 = only in debug)                                                                                                                                                           |

## Why the robot needs attention

By default a robot that has stopped for any reason shows as **Ready** in Apple Home — whether it finished the job or is wedged under the sofa. Since 3.12.0 it does not: a robot that is stuck, has a blocked brush or wheel, a missing dust bin, a flat battery or a dock it cannot reach reports the Matter **Error** state instead of Ready. The cost of that is real — a robot in Error may be refused a Start command by Apple Home — but that is the correct answer for a robot which cannot run, and the old silence is a `enableMatterFaultReporting: false` in `config.json` away.

**Since 3.13.0 it also says what stopped it.** The Error state on its own tells you the robot needs you without telling you why — you still have to open the Roborock app to find out whether it is wedged under the sofa or just missing its dust bin. The plugin now publishes Matter's `OperationalError` attribute alongside the state, mapped from the robot's own error code: stuck, a jammed wheel, a blocked brush, a missing or full dust bin, a dock it cannot reach, a flat battery, a no-go zone in the way. An error code the plugin has no entry for publishes nothing at all — it is named once in the Homebridge log so it can be [reported](https://github.com/mathiashornbek/homebridge-roborock-matter/issues) and mapped properly, and no fault is invented from it. 3.13.0 did invent one, and 2 of this maintainer's robots sat docked at 100 % with a fault on the tile within the hour to prove why that was wrong.

The published codes deliberately stop at 71. Matter 1.5 added names that fit several of these faults exactly — `WheelsJammed`, `BrushJammed`, `NavigationSensorObscured` — but everything up to 71 has been in the cluster since Matter 1.2, and nothing establishes which revision your controller implements. This plugin has already measured what Apple Home does with a value it does not recognise in the neighbouring attribute: the tile sticks on "Connecting" forever. A known-but-generic code is worth more than an accurate-but-unknown one, and the accurate name is written to the log either way. When somebody measures a 1.5 code on a real tile, the mapping moves.

**An empty clean-water tank is the one measured all the way through, and it outranks the rest.** Two releases tried the fault attribute and withdrew it, after 3 controlled tests on an S8 Pro Ultra with a genuinely empty tank in which Apple Home drew nothing — nothing beside a Charging state, and nothing in the last test either, where the robot was raised all the way to the Matter Error state carrying the fault. A counterexample in [#9](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/9) — another bridge rendering the same fault properly — brought it back in 3.12.0, and 3.12.1 found why those tests had all measured the same thing: the tank fields the code read arrived in neither the live cache nor the cloud snapshot, so the plugin had never once sent the fault it was being judged on. With that fixed, the tile draws it: a tap icon on the play button and a localised "refill the water tank", measured on an a70 on iOS 26. **Apple Home was never the problem here**, and earlier versions of this section said it was.

The robot is **not** forced into the Error state by a fault alone — Wazza151's third test did exactly that and it buys nothing measured, while a robot in Error may be refused a Start command by Apple Home. A docked robot with no water can still vacuum. No re-pairing is needed for any of this: an error attribute is a live value, not a capability.

If your tile misbehaves on the attribute, `enableMatterTankFaultReporting: false` in `config.json` switches all of it off — the key name predates the wider mapping and is kept so that turning it off once keeps it off.

There is also a route that does not depend on Apple rendering anything: **the `Water Tank Empty` contact sensor** under [Home app sensors](#automations-in-apple-home) can carry a notification and drive an automation, which a tile icon cannot.

This section also used to blame the setting for a tile stuck on "Updating…", which was not caused by it: in the final test the same robot, with both switches on, stayed in Ready throughout. That wedge came from a stale pairing left behind by an earlier install — see [Troubleshooting](#troubleshooting). The correction is stated here rather than quietly deleted, because someone may have left the feature switched off on the strength of it.

A detached water tank or mop pad is never treated as a fault either: that is the normal, correct configuration for a vacuum-only run.

## What the dock is doing

A Roborock dock works harder than the robot does. It empties the dust bin, washes the mop, updates the map — and then it spends 2 to 4 hours blowing air through a wet mop, every time the robot mops.

Matter has an operational state for 3 of those 4, and this plugin has published all 3 since 3.12.0. **There is no operational state for drying, in any revision of the specification.** The only place the fact can be expressed is the same cluster's `PhaseList` and `CurrentPhase` attributes, and since 3.14.0 that is where it goes: the dock's 4 jobs are announced as a fixed list of phases, and the current one moves between them.

The list is either that fixed set of 4 or absent entirely, and never anything else. It is absent whenever the dock is idle, which is both the specification's own encoding for "this mode has no phases" and the only shape Matter's server implementation will accept: a null phase beside a non-empty list is refused, and 3.14.2 exists because 3.14.0 got that wrong and silently froze the operational state on the tile. What the list never does is change its contents. That is deliberate and it is the whole safety argument: an early version of this plugin used phase changes as a refresh trick, flapped them against every Apple Home hub in the house, and 1.4.58 removed it by setting both attributes to null. Only `CurrentPhase` moves within a run — washing, then drying for as long as the dock takes, then nothing.

Drying is detected on both protocols. A classic S- or Q-series robot with a drying dock reports it itself; a B01/Q7 reports its own air-drying status, which the plugin previously discarded when it mapped that state to "docked" so the tile would not claim the robot was busy. It still maps it that way — a drying dock must not look like a working robot, or Apple Home may refuse it a Start command — but the fact now survives the mapping as a phase.

**Measured, and the answer is no — on every controller checked so far.** Apple Home renders `OperationalState`, including its optional values, and ignores `CurrentPhase` entirely: an S8 Pro Ultra caught all 3 dock jobs in one cycle, and the 2 that appeared on the tile were exactly the 2 that have an operational state of their own, while drying — which travels only as a phase — appeared nowhere. Home Assistant's Matter vacuum integration asks for one attribute from this cluster, `OperationalState`, and never reads the phase either.

The phases are published anyway. They are correct, they are mandatory in the cluster, and an attribute nobody reads costs nothing. But they are not currently a route to anything, so do not choose this plugin expecting to see drying on a tile. If one misbehaves, `enableMatterDockPhases: false` in `config.json` puts both attributes back to null.

## Automations in Apple Home

Every command lives on the tile: start, stop, pause and send-to-dock all work from the Home app and from Siri, because the plugin implements Matter's own `RvcOperationalState` commands — including **GoHome**, which is exactly what the dock button sends.

What Apple offers _inside_ Home automations is a separate question, and it is Apple's to answer, not the plugin's. It has now been measured three times by the same user in [#3](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/3), and the answer turns out to be partial rather than flat:

- **Starting a clean is offered as an automation action** — either the whole home or a chosen set of rooms — and so is **stopping** or **pausing** a clean that is already running. An Apple Home schedule can therefore do the things most schedules are built for, without any help from this section.
- **Sending the vacuum to its dock is not offered as an automation action.** A robot that finishes a clean normally returns to its dock by itself, so the gap only shows up when you want to end a clean early: the automation can cut it short, but it cannot call the robot home.
- **A Matter vacuum is not offered as an automation _trigger_ at all.** The vacuum could not be selected when setting an automation's trigger — only when choosing its action. The switches below do not change that: they are inputs an automation can turn on, not accessories that report what the robot is doing. The **sensors** below do, which is why they exist.
- **Whether an automation can resume a paused clean has not been measured.** Nobody has looked, so this page claims nothing about it in either direction.

**Optional Home app switches close the docking gap.** Turn on **Add Home app switches for Start, Dock, Pause and Find** in the plugin settings and each robot gets one plain HomeKit switch per action you pick — `Vicky Start Cleaning`, `Vicky Return to Dock`, `Vicky Pause`, `Vicky Find`. A switch is something every automation, scene and Shortcut can turn on, which is the whole point: an automation that cannot send the robot to its dock directly can flip a switch that does it instead. Each one is momentary and turns itself off again about a second and a half after it is pressed, so it never claims a command is still running.

**Start Cleaning starts the clean the tile would start.** That includes any rooms selected on the Matter tile: if the last thing you did in Apple Home was pick the kitchen, the switch cleans the kitchen. It is the same command with the same clean mode applied first, not a second idea of what starting means — a switch that ignored the selection you are looking at would be the surprising one. Clear the selection on the tile to get a whole-home clean.

A press takes exactly the same route as a press on the tile — the same acknowledgement wait, the same timing line in the log, the same retry if Roborock times out while the robot is still cleaning — and it moves the tile with it, so a robot sent home by a schedule does not sit there reading Ready. The log line names which surface asked, so `Sending Vicky back to dock from the Home switch.` and `Sending Vicky back to dock from Matter.` are told apart when a schedule misfires.

**Optional Home app sensors close the trigger gap.** A Matter vacuum is not offered as an automation trigger, but a HomeKit contact sensor is — so turn on **Add Home app sensors so automations can trigger on the robot** and each robot gets one read-only contact sensor per state you pick: `Vicky Docked`, `Vicky Cleaning` and `Vicky Water Tank Empty`. That makes "when the robot leaves its dock, do X" expressible. Each one reads **Closed** while the state it is named after is true and **Open** when it is not: `Vicky Docked` is Closed in the dock and Open once the robot drives off. Nothing is ever sent to the robot — these only report.

Docked and Cleaning are more useful together than either alone, and that is the automation they were asked for in [#3](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/3): **not docked and not cleaning means the robot is probably stuck somewhere.** A robot that has genuinely halted reads Open on both.

**Optional Home app schedule switches reach the schedules Apple Home cannot see.** The schedules you build in the Roborock app — weekday mornings, the Saturday whole-home run — are invisible to Apple Home, so an automation cannot suspend one when you are away or on holiday. Turn on **Add Home app schedule switches** and each robot gets a grouped `Vicky Schedules` accessory holding one switch per schedule on your account. Off disables that schedule on the Roborock side; on enables it again. These switches are not momentary: each one shows whether its schedule is currently active, which is the point.

**They enable and disable, they do not author.** Days, times, rooms and clean modes stay in the Roborock app, because that is where those settings live and a switch cannot express them. A schedule deleted in the Roborock app takes its switch with it on the next refresh, and a new one gains a switch the same way. They are named positionally — `Vicky Schedule 1`, `Vicky Schedule 2` — because the Roborock cloud does not give schedules names to borrow; rename them in the Home app if the order is not enough to tell them apart.

**A cloud hiccup does not delete your tiles.** If the schedule refresh fails, the switches are kept and their handlers reattached rather than unregistered — a failed request is not evidence that your schedules are gone, and an accessory that vanishes takes its room assignment, its name and every automation pointing at it along. Requested in [#3](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/3) and contributed by [@pponce](https://github.com/pponce).

**`Water Tank Empty` is the one that can carry a notification.** Since 3.12.1 the condition also reaches the tile itself as a Matter fault ([details](#why-the-robot-needs-attention)), but a tile icon cannot trigger anything — this sensor can. Point a Home notification at it and a mop run that would have been wasted becomes a message instead. It reports and nothing more: it never refuses to start a clean, because the plugin deciding your robot cannot mop on the strength of its own cached reading is a worse failure than a dry mop, and this project has shipped that bug before.

Robots do not agree on how they say it, so both signals are read. An S8 Pro Ultra with an empty tank reports `dock_error_status: 38` and leaves `water_shortage_status` at 0; a Q Revo in the same state sets both. Only 38 is treated as an empty clean-water tank — the same field carries a full waste-water tank and a missing dust bag, and those are not this. A robot that reports neither field leaves the sensor at Open rather than guessing.

Four details that are deliberate:

- **A dock chore is not a cleaning run.** Emptying the dust bin, washing the mop and updating maps leave `Cleaning` exactly where it was — Open if the robot was resting, Closed if it was interrupted mid-run. This is the same rule the Home tile follows since 3.6.2, and the sensor is checked against the tile rather than against a second opinion, so the two can never disagree.
- **`Docked` does not depend on any other setting.** It reads the robot's own charging state, not the state Apple Home was told, so it works the same whether or not **Dock & Returning status** and **Charging/Docked status** are switched on. `Cleaning` mirrors the tile, so with **Dock & Returning status** off it goes Open when the robot starts driving home rather than when it arrives — that is what the tile says too.
- **Nothing is claimed before the robot has reported in.** For the first seconds after a Homebridge restart some robots report no usable state at all, and a sensor that guessed would move once the real value arrived — firing every automation watching for it, on every restart. The sensors hold their last known reading instead and only move on real data.
- **A first-run sensor rests where it will not have to move from.** With no cached reading to hold — a fresh install, or a sensor just switched on — each one answers with its own resting state rather than a shared default: `Docked` closed, `Cleaning` and `Water Tank Empty` open. Until 3.10.0 all three would have answered Closed, so a fresh `Cleaning` sensor announced a finished cleaning the moment the robot first said it was idle.

They are off by default, because switching them on adds accessories to your Home app.

### The switches and sensors need their own pairing — a different QR code

This is the one step that quietly produces "I turned it on and nothing appeared", so it is worth reading before you do anything else. Your robot reaches Apple Home over **Matter**. These switches and sensors are ordinary **HomeKit** accessories, and they travel on this plugin's own Homebridge child bridge, which Apple Home pairs **separately**. The code you scanned for the vacuum does not cover them.

In the Homebridge UI, go to **Plugins → homebridge-roborock-matter → ⋮ → Child Bridge Config**, and then:

1. Check that **Enable HAP** is on. On a Matter-only setup it is frequently off — and while it is off, they exist inside Homebridge but are not published to anything, so no QR code anywhere will bring them in.
2. Save and restart Homebridge.
3. Return to the same screen and press **Connect to HomeKit**. That is the QR code to scan in the Home app.

It is **not** the main Homebridge QR code on the status page, and **not** the robot's Matter pairing code. The plugin tells you which of those three situations you are in: every start it writes one line naming the bridge they went to and what, if anything, is still missing.

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
- **Robot shows "Updating…" or "No Response" in Apple Home:** those two wordings are one tile condition, and Apple chooses between them for reasons of its own — so do not triage them as separate problems. **Open the same tile on a second Apple device before you change anything.** If another controller in the same Home draws it correctly at that same moment, the plugin is publishing and the pairing is sound, and re-pairing cannot help: what is broken is the controller in your hand. Then, cheapest first:
  1. **Restart the Apple device that shows it.** That cleared it outright for the reporter in [#11](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/11) — a restart makes the controller drop what it thinks it knows about the accessory and subscribe again.
  2. **Update to iOS 26.6.1 or later.** On earlier versions the controller could declare its own subscription invalid (Matter status `0x7D INVALID_SUBSCRIPTION`) and then never subscribe again, so one controller kept rendering the accessory while another had no live subscription to it — the same tile, dead on the phone and alive on the Mac at the same moment. The bridge does the right thing in that situation (it drops the dead subscription and re-announces over mDNS), but no Matter device can force a controller to subscribe, so there is nothing to fix on this side. Confirmed fixed on 26.6.1 by the reporter in [#7](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/7). A restart without the update can drift back, because the bug that killed the subscription is still on the phone.
  3. **`Add Accessory → More Options → Cancel`** revives the tile for about a minute, because it forces the controller to re-resolve and briefly re-subscribe. A stopgap, not a fix.
- **Robot shows "Updating…" on every Apple device at once:** _now_ remove the robot from Apple Home and pair it again — a pairing carrying state over from an earlier install is the usual cause (tracked upstream in homebridge/homebridge#3951). What finally worked for the reporter in [#5](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/5) was the full teardown in this exact order: unpair, **uninstall** the plugin, install the current version, pair fresh. A re-pair on top of the existing install did not work for him, so the order is part of the remedy.
- **Rooms missing for a Q7/B01 robot:** wait for the `B01 rooms for ...` log line, then re-pair once so the Service Area cluster is announced with room data.
- **Debug logging needs two switches, not one:** the plugin's own **Debug Mode** only decides whether it _calls_ the debug logger — Homebridge decides whether anything is _printed_, and it suppresses plugin debug output unless Homebridge itself runs with `-D`. Turn on **Homebridge Settings → Homebridge Debug Mode** as well, or the log will look exactly the same as before.
- **Startup without network:** the plugin retries the Roborock cloud with increasing backoff (up to 10 attempts) and never crash-loops Homebridge; wrong credentials stop cleanly with a clear log message.

## Contributing

Model reports, diagnostics exports, and pull requests are very welcome. The codebase ships with 1506 tests (protocol fixtures verified against the [python-roborock](https://github.com/Python-roborock/python-roborock) reference), strict TypeScript checking, and CI across Node 22/24 × Homebridge 1.11/2.x — `npm test` before you push and you're set.

## Support the project

If this plugin makes your home a little smarter, you can support its development via [PayPal](https://paypal.me/MathiasHornbek) — or through the ❤️ **Donate** button on the plugin's tile in the Homebridge UI. Model reports and diagnostics exports are just as valuable!

## Attribution

A Matter-only fork of [`homebridge-roborock-vacuum2`](https://github.com/applemanj/homebridge-roborock-vacuum2) by **Joshua Appleman**, itself adapted from [ioBroker.roborock](https://github.com/copystring/ioBroker.roborock) by **copystring**, with original work by **Nico Hartung**. B01/Q7 protocol work is implemented against the [python-roborock](https://github.com/Python-roborock/python-roborock) reference. All original copyright is preserved under the [MIT license](./LICENSE).

---

<p align="center">
  <sub>Not affiliated with or endorsed by Roborock, Apple, or the Connectivity Standards Alliance. Roborock is a trademark of Beijing Roborock Technology Co., Ltd.</sub>
</p>
