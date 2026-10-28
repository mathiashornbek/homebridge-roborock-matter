<p align="center">
  <img src="https://raw.githubusercontent.com/mathiashornbek/homebridge-roborock-matter/main/assets/icon.png" width="140" alt="homebridge-roborock-matter icon">
</p>

<h1 align="center">homebridge-roborock-matter</h1>

<p align="center">
  <b>Your Roborock in Apple Home: every model, every room, and the Home app shows which room it is cleaning right now.</b>
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

Sign in with the account you already use in the Roborock app. That is the whole setup. Every robot on your account then appears in Apple Home as a real robot vacuum: start and stop it, send it to the kitchen, choose vacuum or mop, check the battery, and ask Siri to do it for you. No tokens to dig out, no network tricks, no command line.

## Why people choose it

- 🥇 **Every Roborock works.** From the classic S-series through the Q and Saros families to the 2025 Q7 series, which no other Homebridge plugin supports. New models are picked up automatically.
- 📍 **See where it is cleaning, live.** The Home app says _"Cleaning — Kitchen"_ and follows the robot from room to room, even for cleans started in the Roborock app or on the robot itself.
- 🧭 **One tidy tile per robot.** No fake fans or helper accessories. Your rooms keep the names you gave them in the Roborock app.
- ⚡ **Fast and dependable.** Commands go straight to the robot on your own network when they can, with the Roborock cloud as automatic backup.
- 🛡️ **Verified by Homebridge.** Reviewed by the Homebridge team, 2630 automated tests, no analytics, and it keeps running when the Wi-Fi or the Roborock cloud has a bad day.

## What you can do

- 🤖 Start, stop, pause and send the robot home to its dock, from the Home app or with Siri.
- 🚪 Clean only the rooms you pick, on every floor.
- 📊 Follow the progress room by room. A room only counts as done when the robot was actually there.
- 🌀 Choose Vacuum, Mop or Vacuum + Mop, and the suction level from Quiet to Max.
- 🔋 See the battery and whether it is charging.
- 🚨 Apple Home is told why it stopped: stuck, a blocked brush, a full bin or an empty water tank.
- 🕹️ Add optional switches and sensors that open up more Home automations ([see below](#automations-in-apple-home)).
- 🩺 Check the connection and share a ready-made report from the settings page if you ever need help.
- 🔐 Sign in safely from the settings page. Two-factor sign-in works, and the session is stored encrypted.

## Quick start

1. In the Homebridge UI, search for **`homebridge-roborock-matter`** and install it. (Or run `npm install -g homebridge-roborock-matter`.)
2. Open the plugin settings, sign in with your **Roborock app account**, and choose your robots.
3. Turn on **Matter** for the plugin's child bridge and restart Homebridge. Then add each robot in the Home app with its own pairing code, found in the plugin settings under **Matter Pairing**.

Q7 robots show their rooms once the map has been fetched (look for a `B01 rooms for ...` line in the log). A robot added to Apple Home before that needs to be removed and added once more, because Matter fixes what an accessory can do when it is paired.

## Live room tracking

While the robot cleans, the plugin follows it on the map and tells Apple Home which room it is in, just like the Roborock app does. It is on by default (`enableLiveRoomTracking`). A Q7 reports its true position less often than the S and Q series, so its room can update a little later.

## Supported robots

- **The 2025 Q7 series** (Q7 M5 / M5+, `roborock.vacuum.sc05`), including mopping with vacuum and mop modes.
- **The S, Q and Saros series**, from the S4 and S5 Max through the S8 Pro Ultra, the Q5, Q7, Q8 and Q Revo families, Saros and newer.
- **Future models** are adopted automatically. If something looks wrong, [open a model report](https://github.com/mathiashornbek/homebridge-roborock-matter/issues) with a diagnostics report from the settings page.

A few early robots, such as the original S5, only work with Xiaomi's Mi Home app and can never join a Roborock account. For those, use [homebridge-xiaomi-roborock-vacuum](https://github.com/homebridge-xiaomi-roborock-vacuum/homebridge-xiaomi-roborock-vacuum).

## Automations in Apple Home

On the tile and with Siri everything works, including sending the robot home: the dock button on the tile is Matter's own GoHome command.

What Home automations may do with a robot vacuum is up to Apple. Measured in [#3](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/3):

- An automation can **start** a clean, for the whole home or for chosen rooms, and can **stop** or **pause** a clean that is running.
- Apple does not offer sending the robot to its dock as an automation action.
- A robot vacuum is not offered as an automation trigger at all.
- If an automation starts a robot that is paused, the plugin resumes the paused clean instead of starting a new one.

The plugin fills both gaps with optional extras, as plain HomeKit accessories:

- **Switches.** Each robot can get `Vicky Start Cleaning`, `Vicky Return to Dock`, `Vicky Empty Bin`, `Vicky Pause` and `Vicky Find`. Any automation, scene or Shortcut can turn a switch on, and the switch does the rest, then turns itself off again. Start Cleaning starts the clean the tile would start, including any rooms selected on the tile.
- **Sensors.** Read-only contact sensors: `Vicky Docked`, `Vicky Cleaning`, `Vicky Water Tank Empty`, `Vicky Dirty Water Tank Full` and `Vicky Cleaning Fluid Empty`. Apple Home accepts a contact sensor where it refuses a vacuum, so "when the robot leaves its dock, turn on the hall light" becomes possible. Not docked and not cleaning usually means the robot is stuck somewhere. A sensor reads Closed while its state is true.
- **Schedule switches.** Turn the schedules you made in the Roborock app on and off, for example while you are on holiday. Days, times and rooms stay in the Roborock app.
- **Routine switches.** Run a Routine from the Roborock app, so "Hey Siri, turn on Deep Clean" works.

All of them are off until you turn them on in the settings.

### The switches and sensors need their own QR code

Your robot reaches Apple Home over Matter. The switches and sensors are ordinary HomeKit accessories on the plugin's child bridge, which is paired separately:

1. In the Homebridge UI, go to **Plugins → homebridge-roborock-matter → ⋮ → Child Bridge Config** and make sure **Enable HAP** is on.
2. Save and restart Homebridge.
3. Go back to the same screen and press **Connect to HomeKit**. Scan that QR code in the Home app.

It is **not the main Homebridge QR code** on the status page, and **not the robot's Matter pairing code**. The log says on every start what, if anything, is still missing.

## Settings

Everything can be set on the plugin's settings page. The most useful options:

| Option                                  | Default      | What it does                                                                                                                                         |
| --------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enableMatterServiceArea`               | `true`       | Pick rooms in Apple Home                                                                                                                             |
| `enableLiveRoomTracking`                | `true`       | Show the room the robot is in right now                                                                                                              |
| `enableMatterCleanMode`                 | `true`       | Vacuum / Mop / Vacuum + Mop                                                                                                                          |
| `enableFanPowerCleanModes`              | `true`       | Suction levels in the mode list                                                                                                                      |
| `enableMatterExtendedOperationalStates` | `true`       | Show returning, emptying the bin and washing the mop                                                                                                 |
| `enableMatterChargingDockedStates`      | `true`       | Say Charging or Docked instead of Ready on the dock                                                                                                  |
| `enableMatterFaultReporting`            | `true`       | Show a robot that has stopped with a problem as Error ([details](#why-the-robot-needs-attention))                                                    |
| `enableMatterTankFaultReporting`        | `true`       | Say what the problem is, such as an empty water tank                                                                                                 |
| `enableHomeKitActionSwitches`           | `false`      | Add the switches                                                                                                                                     |
| `homeKitActionSwitches`                 | `["dock"]`   | Which switches: `clean`, `dock`, `empty`, `pause`, `locate`                                                                                          |
| `enableHomeKitStateSensors`             | `false`      | Add the sensors                                                                                                                                      |
| `homeKitStateSensors`                   | `["docked"]` | Which sensors: `docked`, `cleaning`, `waterTankEmpty`, `dirtyWaterTankFull`, `cleaningFluidEmpty`                                                    |
| `enableHomeKitScheduleSwitches`         | `false`      | Add the schedule switches                                                                                                                            |
| `enableHomeKitRoutineSwitches`          | `false`      | Add the Routine switches                                                                                                                             |
| `cloudOnlyMode`                         | `false`      | Use only the Roborock cloud, never your local network                                                                                                |
| `enableLocalServerFastRefresh`          | `false`      | Experimental faster status, live maps and device settings for a self-hosted server ([intervals and test guide](./docs/local-server-fast-refresh.md)) |
| `skipDevices`                           |              | Robots the plugin should leave alone                                                                                                                 |
| `transientWarningThrottleHours`         | `1`          | How often a recurring connection warning may repeat (0 = debug log only)                                                                             |

> ⚠️ Options that change what a robot can do in Apple Home (modes, rooms, states) need the robot removed from Apple Home and added again. **Before you turn suction levels off, select Vacuum, Mop or Vacuum + Mop on the tile**, or Matter refuses to bring the robot back. [The details](./docs/matter-clean-mode-shrink-issue-draft.md).

## Why the robot needs attention

A robot that has stopped because of a problem shows as **Error** in Apple Home instead of Ready, and the plugin tells Apple Home why: stuck, a jammed wheel or brush, a missing or full bin, a dock it cannot reach, a flat battery. An empty clean-water tank shows on the tile as a refill icon on the play button. A robot that can still vacuum is not forced into the Error state just because a tank is empty, and while it charges the tile keeps saying Charging. An error code the plugin does not know is written to the log so it can be [reported](https://github.com/mathiashornbek/homebridge-roborock-matter/issues), and nothing is made up from it.

## Battery percentage in Apple Home

Apple Home updates the charging state live, but shows the battery percentage from when it last read it. That is a limit in matter.js, the Matter software Homebridge uses, and it affects every plugin. Restarting your HomePod or Apple TV refreshes it. It is tracked in [matter-js/matter.js#4163](https://github.com/matter-js/matter.js/issues/4163) and [homebridge#3958](https://github.com/homebridge/homebridge/issues/3958).

## Troubleshooting

- **Start with the settings page.** It shows each robot's connection, has a **Test Local Connection** button, and makes a diagnostics report with private details removed, ready to paste into a GitHub issue.
- **The tile says "Updating…" or "No Response"?** Apple uses both words for the same problem. First open the same tile on a second Apple device. If it works there, the plugin and the pairing are fine and the device in your hand is the problem: restart the Apple device that shows it. It can come back after days or a week, so you may need to repeat that ([#7](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/7), [#11](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/11)); it was still seen on iOS 26.6.1.
- **Stuck on every Apple device at once?** Only then, with every device showing it, remove the robot from Apple Home, uninstall the plugin, install the current version and pair again, in that order ([#5](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/5)).
- **Pairing fails with "Accessory not found"?** Try again with your iPhone on the 2.4 GHz Wi-Fi, and check that the phone and Homebridge are on the same network ([#21](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/21)).
- **Rooms missing on a Q7?** Wait for the `B01 rooms for ...` log line, then re-pair the robot once.
- **Debug logging** needs two switches: the plugin's **Debug Mode** and **Homebridge Debug Mode** in the Homebridge settings. A debug log is safe to paste; keys, serial numbers and tokens are masked.
- **No network at startup?** The plugin keeps retrying and never crashes Homebridge. A wrong password stops it with a clear message in the log.

## Support the project

If the plugin makes your home a little smarter, a small donation via [PayPal](https://paypal.me/MathiasHornbek) helps me keep developing it. You can also use the ❤️ **Donate** button on the plugin's tile in the Homebridge UI. Model reports and diagnostics reports help just as much.

## Contributing

Model reports, diagnostics reports and pull requests are welcome. The code has 2630 tests, strict TypeScript and CI on Node 22 and 24 with Homebridge 1.11 and 2.x; run `npm test` before you push. Every change is described in the [changelog](./CHANGELOG.md).

## Attribution

A Matter-only fork of [`homebridge-roborock-vacuum2`](https://github.com/applemanj/homebridge-roborock-vacuum2) by **Joshua Appleman**, itself adapted from [ioBroker.roborock](https://github.com/copystring/ioBroker.roborock) by **copystring**, with original work by **Nico Hartung**. The protocol work follows [python-roborock](https://github.com/Python-roborock/python-roborock). All original copyright is kept under the [MIT license](./LICENSE).

---

<p align="center">
  <sub>Not affiliated with or endorsed by Roborock, Apple, or the Connectivity Standards Alliance. Roborock is a trademark of Beijing Roborock Technology Co., Ltd.</sub>
</p>
