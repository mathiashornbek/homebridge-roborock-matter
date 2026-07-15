# homebridge-roborock-matter

A **Matter-only** Homebridge plugin that publishes your Roborock robot vacuums — including the 2025 **B01/Q7-series** (`roborock.vacuum.sc05`, Q7 M5 / M5+) — as native **Matter** accessories for Apple Home.

> This is a fork of [`homebridge-roborock-vacuum2`](https://github.com/applemanj/homebridge-roborock-vacuum2) by Joshua Appleman, itself adapted from [ioBroker.roborock](https://github.com/copystring/ioBroker.roborock) by copystring. See [Attribution](#attribution) and [LICENSE](./LICENSE). All original copyright is preserved.

## What makes this fork different

- **Matter-only.** All HomeKit (HAP) accessories — the fan tile, helper switches, scene and schedule switches — have been removed. Each robot appears exactly once in Apple Home as a native Matter robot vacuum. Legacy HomeKit accessories are unregistered automatically on first start.
- **B01/Q7-series protocol support.** The 2025 Q-series robots speak a different RPC dialect that upstream does not implement. This fork adds a full B01 adapter — commands (start/stop/pause/dock/locate/segment cleaning), status, battery, charging state, mop/vacuum mode switching, and room selection via the encrypted B01 map channel — implemented against the [python-roborock](https://github.com/Python-roborock/python-roborock) reference and verified with fixture-driven tests.
- **Robustness hardening.** Startup guards, self-healing status polling with a dedicated B01 loop, per-cluster Matter publish isolation, interval-lifecycle fixes, and a light, accessible settings UI with per-device enable/disable.

## Battery percentage in Apple Home — known controller-side limitation

The Matter PowerSource attribute `batPercentRemaining` carries the spec
reporting quality **"changes omitted"**: value changes are not pushed to
subscribed controllers, by design. matter.js implements this faithfully on
the device side, and its own controller documents the consequence ("Always
read attributes that do not report changes via subscriptions"). Apple Home
performs no such re-reads, so the vacuum tile's battery percentage freezes
at whatever it was when the accessory was paired — while the charging state
on the very same cluster updates live.

This was verified end-to-end in the field: the plugin's publishes, the
Homebridge API, and the persisted matter.js store all carry the live value
in real time while Apple keeps rendering the pairing-day percentage. The
plugin performs a one-time battery resync per boot so controllers that
re-prime their subscriptions pick up a fresh value; beyond that, no
device-side write can force a changes-omitted attribute to report. Known
refresh paths today: re-establishing the controller subscription (Matter
hub restart) and re-pairing. The permanent fix belongs in the controller
ecosystem — `docs/matter-battery-issue-draft.md` contains a ready-to-file
upstream report with the complete evidence chain.
## Requirements

- Homebridge 2 with Matter enabled on the Roborock child/daughter bridge.
- A Matter controller (a HomePod or Apple TV acting as a home hub) to add the accessories to Apple Home.

## Supported robots

- Classic protocol Roborock vacuums supported by the upstream plugin (published as Matter).
- **B01/Q7-series** (`roborock.vacuum.sc05` and compatible), including manual-tank mopping (vacuum/mop mode switch; no water-level status, by design).

## Setup

1. Install the plugin in Homebridge.
2. Enter your Roborock app account credentials in the plugin settings.
3. Enable Matter for the Roborock child bridge, restart, and add each robot to Apple Home using the codes shown in the **Matter Pairing** section of the plugin settings.
4. Use the **Devices** section to choose which robots the plugin manages.

For B01/Q7 robots, room selection appears after the plugin has fetched the map (watch for a `B01 rooms for ...` log line); robots paired before rooms were available must be removed from Apple Home and re-paired once, as Matter fixes the cluster set at commissioning.

## Attribution

This project builds directly on the work of others, preserved under the MIT license:

- **Nico Hartung** — original author of the upstream lineage.
- **Joshua Appleman** — author of [`homebridge-roborock-vacuum2`](https://github.com/applemanj/homebridge-roborock-vacuum2), the base for this fork.
- **copystring** — [ioBroker.roborock](https://github.com/copystring/ioBroker.roborock), the source of much of the Roborock protocol implementation.
- **The python-roborock project** — the reference implementation used to build B01/Q7 support.

This fork is maintained by **Mathias Hornbek**. It is an independent, community-maintained fork and is not affiliated with or endorsed by Roborock or Apple.

## License

MIT — see [LICENSE](./LICENSE).
