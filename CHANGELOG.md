# Changelog

## 2.8.1

- **Suction modes now render with proper localized names in Apple Home.** Field observation: Apple ignores Matter mode labels and renders its own localized names from the mode TAGS (a variant with only the Vacuum tag displays as plain "Vacuum"). Balanced and Turbo therefore now carry distinct intensity tags (Auto and Quick), matching Quiet and Max — in Apple Home the five levels render as Quiet / Automatic / Quick / Max (+ Deep Clean for Max+ on Q7). Remember: enabling `enableFanPowerCleanModes` requires one remove/re-pair of the robot, since Matter fixes the mode list at commissioning.

## 2.8.0

- **Suction changes made in the Roborock app now show up in Apple Home.** With suction-level modes enabled, the announced current clean mode is derived live from the robot's actual fan power (approach adopted from `homebridge-roborock-matter-vacuum` by Jake Gold, MIT): change the suction anywhere and the Matter mode picker follows. A pending Apple Home selection always wins until the robot has confirmed it, and mop-family selections are never overridden by fan-power readings.
- Reviewed `homebridge-roborock-matter-vacuum`'s battery handling against this plugin's: its PowerSource payload is a subset of ours with the same publish mechanism, so it contains no additional fix for the Apple-side frozen-percentage limitation (see README); the upstream report in `docs/matter-battery-issue-draft.md` remains the correct path.
- Full suite: 256 passing.

## 2.7.0

Live room tracking for the whole fleet, a fifth suction level for the Q7, and quieter transport logs.

- **New: live room tracking for classic S/Q-series robots.** The flagship feature no longer stops at B01/Q7: classic robots now fetch their RRMap via the secure `get_map_v1` request (the protocol 301 decrypt/gunzip transport already existed), and the robot's millimeter position is resolved against the map's per-pixel room segments (`pixelIndex | segmentId << 21` grid). Same design as the B01 path: ~20 s attempt throttle, single-flight, fetches only while actively cleaning (never while paused or docked), previous room retained while crossing unsegmented floor, and a change re-broadcast so Apple Home updates within seconds. The Service Area layer — honest per-room progress included — is shared and unchanged.
- **New: Max+ suction mode for the Q7** (fifth wind level, v1 fan power 108) in the opt-in fan-power clean modes, tagged Vacuum + DeepClean. Only announced for robots whose protocol verifiably defines the level (B01/Q7); classic models stay at four levels until a reliable capability signal exists — model guessing is what this fork moves away from.
- **Fixed misleading MQTT outage spam.** Connection-state events were routed through the per-robot command error path, producing `Failed to execute client.on("error") on robot undefined (unknown model)` twice per reconnect attempt, unthrottled, for as long as an outage lasted (observed during a real nighttime DNS outage). Connection issues now log one clear warning per distinct message per 5 minutes, downgrade to debug in between, and a single recovery line is logged when the connection comes back.
- Battery upstream report (`docs/matter-battery-issue-draft.md`) finalized for filing against homebridge/homebridge, now including the resync-nudge finding and a reproduction section.
- Full suite: 254 passing (6 new classic live-room tests exercising the real RRMap parser end to end, plus Max+ coverage).

## 2.6.0

- **New: opt-in suction-level cleaning modes.** With `enableFanPowerCleanModes` (default off), the Matter cleaning mode list gains **Quiet / Balanced / Turbo / Max Vacuum** variants with proper Matter mode tags (Vacuum + Quiet/Max), so suction can be chosen directly from Apple Home's mode picker. Selecting a variant pins the robot's fan power (v1 codes 101-104; the B01/Q7 adapter translates to wind levels 1-4) while behaving as a vacuum-family mode everywhere else (water box handling, mop rules). Off by default because Matter fixes an accessory's mode list at commissioning: toggling the option requires removing and re-pairing the robot once — this ships as a deliberate opt-in rather than a forced re-pair for everyone.
- **README rebuilt from scratch** around what makes the plugin unique (2025 B01/Q7 support, live room tracking, Matter-only design), with a feature matrix, configuration reference, honest limitation notes, and the plugin icon.
- Full suite: 247 passing (6 new clean-mode tests). No changes to default behavior anywhere.

## 2.5.0

Supply-chain, robustness and capability-detection release. Every Socket.dev alert with a code-level source is eliminated at the source, and the plugin now adapts itself to unknown robot models instead of guessing silently.

- **Custom UI server moved to native ESM loading — no more dynamic code evaluation.** The `homebridge-ui` directory is now marked `"type": "module"`, so `server.js` imports the pure-ESM `@homebridge/plugin-ui-utils` natively and instantiates the exported (side-effect-free) server class from the compiled output. The `new Function("return import(...)")` interop shim is gone, and with it the Socket.dev "uses eval" alert.
- **Removed the dead ioBroker-era package/image downloader** (`roborockPackageHelper`) and its `jszip` dependency (12 packages out of the tree). The helper was never called by this fork, wrote to relative paths, and was the source of Socket.dev's AI-detected ZIP-slip/path-traversal alert. Deleting it removes the entire alert surface rather than patching around it.
- **Self-healing capability detection.** Any periodic poll request a robot definitively answers with an unsupported-method error is now remembered per device and skipped until the next restart (firmware updates get a fresh probe) — exotic and brand-new models stop generating repeated warnings for requests they will never answer. Timeouts and transport errors never count as unsupported.
- **Capability-derived poll profiles for unknown models.** Models without a dedicated poll profile (e.g. newly released Saros 10 / Q5 Max+ / QX Revo Plus-class devices) now derive their polls from the robot's own capability bitmask where available (carpet support), announce the chosen profile once in the log, and point to the model-report issue template. Known models keep their verified profiles unchanged.
- **Clearer model lookup mismatch logs:** a device whose HomeData model string does not look like a Roborock vacuum now logs exactly what was reported and how to file a useful report, instead of a generic "unsupported model" line.
- **Leaner npm package:** the mitmproxy sniffing script, the ioBroker map viewer, test files, and editor metadata no longer ship in the tarball.
- ROADMAP refreshed against live upstream status: applemanj#12 (pause/dock) confirmed fixed and closed upstream; applemanj#4 (S8 local timeouts) still awaiting reporter retest; homebridge#3951 stable with no recurrence since June. The legacy "HomeKit scene/room controls" item is superseded by the Matter-only design.
- Full suite: 241 passing (6 new capability-detection tests). Verified end to end under Homebridge 1.8.3 and 2.1.2-beta.3, including the plugin-verification harness's crash scenarios (invalid credentials, unreachable cloud).

## 2.4.2

Robustness and supply-chain release (Homebridge verification runtime checks + Socket.dev scan).

- **Startup failures can no longer crash Homebridge.** A rejected Roborock login previously escaped `startService` as an unhandled promise rejection — under Homebridge 2 / Node 22+ that reads as a plugin crash and can trigger a crash-restart loop. Wrong credentials now stop cleanly with a clear log message ("check the email and password ..."), while unreachable-cloud errors retry with increasing backoff (1-10 minutes, up to 10 attempts) since Homebridge often boots before the network is up. A belt-and-braces catch at the platform call site guarantees nothing escapes.
- **node-forge removed** (flagged by Socket.dev: its prime-generation worker contains a Math.random() fallback). The protocol's RSA-2048 keypair is now generated by Node's built-in OpenSSL-backed `crypto.generateKeyPairSync` (CSPRNG entropy) with identical output format — the components are byte-for-byte compatible minimal hex strings, verified by new tests including a reconstruction/roundtrip check. One less production dependency.
- Full suite: 235 passing.

## 2.4.1

- Added the standard `name` property to the config schema (Homebridge verification requirement) so the platform name is editable in the Homebridge UI.
- No functional changes.

## 2.4.0

- **New: live room tracking for B01/Q7-series robots.** While the robot is actively cleaning, the plugin now fetches the robot's live position from the encrypted SCMap channel (`currentPose`, ~20s cadence, only during active cleaning states) and ray-casts it against the per-room boundary outlines (`roomChain`) to determine which room the robot is physically inside. The detected room is published as the Matter Service Area `currentArea`, so Apple Home's status pill can show "cleaning in \<room\>" with the actual room — including runs started from the robot button or the Roborock app, and full-home cleans, which previously had no room to name. This closes the gap noted in 2.3.1 ("deriving the live room from the robot's map position, the way the vendor app does").
- **Honest progress semantics.** The progress list only transitions rooms that are part of the announced run scope: a detected room becomes operating, and a previously operating room is marked completed only if the robot was actually detected inside it during this run — the old first-requested-room guess falls back to pending instead of claiming a clean that may never have happened. Rooms outside the announced scope update `currentArea` (a true statement about where the robot is) but never rewrite the scope, and stale progress lists from finished runs are never mutated.
- **Protocol layer:** the minimal SCMap protobuf reader now decodes `mapHead` (grid geometry), `currentPose` and `roomChain` alongside the existing room list, following the wider CRL-200S family schema documented by ioBroker.roborock; wire-format parsing is covered by tests that encode payloads independently and run the production AES/zlib decode path end to end. Each live fetch also opportunistically refreshes the room-name cache, postponing the next scheduled 6-hour room refresh.
- **Footprint and control:** map fetches ride a dedicated 20s attempt throttle with a single-flight guard, run only while the robot is in an actively-cleaning state, and stop the moment the run ends. The feature is on by default and can be disabled with the new **Enable Live Room Tracking** setting (`enableLiveRoomTracking: false`).
- Full suite: 232 passing (14 new tests: protobuf parsing/geometry, API throttle/notify/caching behavior, and Matter progress semantics).

## 2.3.2

Security and dependency hygiene release (prompted by the Socket.dev scan of 2.3.1).

- **All 10 known vulnerabilities in the production dependency tree resolved** (5 high, 5 moderate — including ws memory disclosure/DoS via mqtt and the qs DoS via express) through lockfile upgrades.
- **Nine unused dependencies removed entirely:** abstract-things, tinkerhub-discovery, yargs, chalk, deep-equal, rxjs, semver, debug, and express — all inherited from the upstream project's pre-Matter (miio) era and referenced by zero files in this fork. Removing express also eliminates the whole qs/body-parser/path-to-regexp advisory chain at the root instead of patching around it. Verified by full-tree usage analysis, the complete test suite, strict type checking, and a runtime load check.
- npm audit (production): 0 vulnerabilities. Smaller install footprint, cleaner supply-chain surface.

## 2.3.1

- **Full-home cleans now publish the run's scope as Service Area progress.** Previously a full clean cleared the progress list entirely, leaving controllers with no per-run data — which Apple Home renders as a permanent "Preparing" pill for the whole run. Every supported area is now reported as pending at start and completed when the robot returns to the charger. No area is claimed as current and currentArea stays null: the robots do not report which room they are physically inside, and the plugin does not invent one. Whether Apple's pill label improves with real scope data is up to Apple's renderer — this ships the honest maximum of what the robots expose. (Deriving the live room from the robot's map position, the way the vendor app does, remains a possible future feature.)
- Full suite: 217 passing.

## 2.3.0

Performance release: snappier state in Apple Home while robots are working, and a much quieter idle load.

- **Adaptive B01 poll cadence.** The dedicated B01/Q7 status loop still ticks every 15s, but the cloud-protecting attempt throttle is now state-aware: ~12s effective cadence while the robot is actively working (cleaning, spot/zone/segment runs, returning, docking, mop washing) and the conservative ~45s at rest. Phase transitions — started from the robot button or the Roborock app included — now reach Apple Home within seconds instead of up to ~45s, while a docked fleet keeps the gentle cloud footprint.
- **Confirmed-publish diffing.** Cluster payloads byte-identical to the last CONFIRMED publish are no longer re-submitted on every poll and live message (previously 4-6 unchanged clusters per robot per cycle through the Homebridge/matter.js stack, around the clock). Three safety layers prevent the historical "Updating..." store-desync that made upstream remove its old change tracking: all publishes remain serialized, tracking entries are recorded per cluster only after the individual write succeeded (and dropped on failure so retries always go through), and the 60s heartbeat now performs a FORCED full publish as a self-healing safety net. Behavior on failure paths, registration, and the battery resync nudge is unchanged.
- Test suite updated to the new contracts and extended with an adaptive-cadence test; the optimistic-state protection test is now stricter (any docked/charging leak during the start window fails it). Full suite: 216 passing.

## 2.2.1

- **Removed: the HomeKit battery companion accessories introduced in 2.2.0.** This fork stays Matter-only; a HAP side-channel is not the right answer. Any companions created by 2.2.0 are no longer registered by the plugin and can be removed from the Homebridge cache via the Homebridge UI (Settings -> Remove single cached accessory) if they linger.
- Retained from 2.2.0: Service Area progress persistence across restarts, the accessory-context mutation fix, the README documentation of the controller-side battery reporting limitation, and the ready-to-file upstream report in `docs/matter-battery-issue-draft.md` — filing that issue with Homebridge is the correct, Matter-native path to a permanent battery fix.
- Full suite: 215 passing.

## 2.2.0

- **New: HomeKit battery companion accessories (enabled by default).** The Matter battery percentage freezes in Apple Home because the attribute carries the Matter spec "changes omitted" reporting quality — changes are never pushed to subscribed controllers, matter.js implements this faithfully, and Apple never re-reads (matter.js' own controller compensates by always reading such attributes; Apple's does not). Since no bridge-side write can force the attribute to report, the plugin now publishes a small HomeKit Battery accessory per vacuum through the regular Homebridge child bridge, mirroring the exact values of every Matter publish: live percentage, charging state, and a low-battery flag at 20%. Pair the plugin's child bridge with Apple Home to see them; opt out with `disableBatteryCompanion` in the plugin config (removes existing companions cleanly).
- **New: Service Area progress survives restarts.** The active room and per-area progress are persisted in the accessory context and restored on startup, so a Homebridge restart mid-clean no longer drops Apple Home back to a generic label.
- **Fixed a context-replacement bug:** metadata updates replaced the accessory `context` object instead of mutating it, which could orphan persisted state held by Homebridge under the old reference. Found by the new persistence test.
- Documentation: README section on the Apple Home battery limitation with the full evidence chain, and `docs/matter-battery-issue-draft.md` — a ready-to-file upstream report for Homebridge/matter.js.
- Full suite: 217 passing, including companion mirroring in the three-robot end-to-end simulation.

## 2.1.3

- **Service Area progress feature is now announced at commissioning.** Homebridge derives Matter cluster features from which attributes are present when the accessory registers (the same mechanism as its own PowerSource Rechargeable fix, homebridge#3914). The `progress` list was previously only included while a room clean was running — never at registration — so the progress feature was likely never announced to controllers, leaving Apple Home unable to render "cleaning in <room>" and stuck on "heading to the room"/"Preparing" instead. `progress` (empty when idle) and `estimatedEndTime` (null; the robots provide no ETA data) are now always present in the cluster state. NOTE: Matter locks cluster features at commissioning, so this improvement requires re-pairing the robot once.
- **Battery investigation concluded (evidence in README):** the full chain robot → plugin → Homebridge → matter.js store is verified correct end-to-end (store values match the Roborock app in real time), while Apple Home renders the percentage from pairing time. The charge state on the same cluster updates live; the percentage attribute has the Matter "changes omitted" reporting quality, so value changes are not pushed to subscribed controllers by design and Apple never re-reads it. No plugin-side write can force this attribute to report; the resync nudge from 2.1.1 remains as a best-effort priming aid. Verified paths to a fresh value: re-establishing the controller subscription (hub restart) or re-pairing.
- Code cleanup: removed unused parameters; the codebase now compiles clean with noUnusedLocals + noUnusedParameters.
- Full suite: 214 passing.

## 2.1.2

- **Apple Home's status pill now shows real cleaning progress instead of a permanent "Preparing".** The Service Area cluster previously exposed rooms but never populated the progress attributes, so controllers that render a progress pill had nothing to show for the entire run. Room cleans started from Apple Home now publish `currentArea` (the room being cleaned — Apple displays its name) and a per-area `progress` list: the requested room is marked operating, additional requested rooms pending, and everything flips to completed when the robot returns to the charger. Honest limitations: with multiple rooms selected the first is shown as current (the robot does not report which room it is inside), and full-home cleans have no room to name.
- **Battery publish diagnostics on every change:** the "Matter publish for <duid>: battery=…%" info line now also logs whenever the published battery value changes (not only on the first publish after boot), making the exact value handed to the Matter layer permanently visible in normal logs.
- The end-to-end simulation now runs with a realistic stale cloud snapshot (pairing-day battery in HomeData) and proves the live channel wins in every publish, plus a full room-clean progress scenario (start → operating → completed).
- Full suite: 214 passing.

## 2.1.1

- **Fixed Apple Home showing a frozen, hours-old battery percentage even though the plugin publishes the correct value.** Root cause: Matter controllers filter attribute reports by cluster data version, and matter.js suppresses no-op attribute writes — so a battery that sits at the same value forever never generates a new report for a controller whose cache missed one (observed in the field as a Q7 stuck on its pairing-day percentage across full server restarts, while frequently-changing attributes like the operational state kept updating fine). The plugin now performs a one-time battery resync per boot: the battery attributes are published as briefly unknown and then with their real values, forcing two genuine store changes that bump the cluster data version so every subscribed controller receives a fresh report — no hub restart or re-pairing required. The resync covers both publish paths (live messages and periodic refreshes), runs exactly once per boot, and logs an info line ("Battery resync for <duid>: ... battery=100%") for verification.
- Full suite: 211 passing, including nudge-ordering assertions in the three-robot end-to-end simulation.

## 2.1.0 (first public fork release as homebridge-roborock-matter)

This is the first release under the fork name **homebridge-roborock-matter**, maintained by Mathias Hornbek. It is a Matter-only fork of `homebridge-roborock-vacuum2` by Joshua Appleman (originally adapted from ioBroker.roborock by copystring), published under the MIT license with all original copyright preserved.

The 2.0.0-matter.x pre-release series is consolidated into this release. Highlights versus upstream:

- Matter-only: HomeKit accessories removed; each robot is a single native Matter vacuum.
- Full B01/Q7-series (roborock.vacuum.sc05) support: commands, status, battery, charging, mop/vacuum mode switching, and room selection via the encrypted B01 map channel, built against the python-roborock reference.
- Robustness: startup guards, a dedicated self-healing B01 status loop, per-cluster Matter publish isolation, interval-lifecycle fixes, request-id and throttling fixes.
- UI: light, WCAG-AA settings theme with per-device enable/disable and a Charging/Docked tile option with a configurable battery threshold.
- 210 passing tests, including fixture-driven B01 protocol and map-decode verification and a full three-robot end-to-end simulation.

## 2.0.0-matter.10 (Matter-only edition, unofficial)

Boot responsiveness and publish evidence, following field verification that the plugin chain is now fully correct (robots report state=8, battery=100%, charging=yes across restarts):

- **The dedicated B01 status loop now polls immediately at start** instead of waiting for the first 15-second tick: after a restart the Matter store briefly holds the registration snapshot, and landing the real values right away both shortens that window and generates a genuine attribute-change report for controllers as early as possible.
- **One-time publish evidence at info level:** the first successful Matter publish per accessory logs the exact values handed to the Matter layer ("Matter publish for <duid>: battery=100%, operationalState=66"), closing the last observability gap between the robot and Apple Home — any remaining discrepancy is now provably on the controller side (hub cache/subscription), where a Matter-hub restart or a re-pair of the affected accessory resolves it.
- Full suite: 210 passing.

## 2.0.0-matter.9 (Matter-only edition, unofficial)

The frozen-battery mystery, solved with field evidence:

- **Root cause found via the new first-success log lines:** both Q7 robots reported `battery=100%` correctly through the B01 channel — but with `fault=407`, and the adapter treated any non-zero fault as an error state. Q7 fault code 407 is the informational "Cleaning in progress. Scheduled cleanup ignored." message, which lingers after harmless events; the reference implementation treats the fault field as a separate diagnostic channel that never overrides the work status. The adapter now does the same: work status is the sole source of the robot state, informational codes (0, 407) are normalized out of error_code, and real fault codes still surface as diagnostics without disturbing the state.
- **Fixed the freezing mechanism itself — per-cluster Matter publish isolation.** Cluster publishes ran in one all-or-nothing batch, so a single misbehaving cluster (here: the erroneous operational-state publish) could block every other attribute, leaving Apple Home stuck on pairing-day values (74%, not charging, Ready). Each cluster now publishes independently: one failure can never again freeze the battery. A totally failed batch keeps its previous semantics, and an "endpoint still initializing" failure still schedules the retry even when other clusters landed.
- **The full-chain simulation now replays the exact field payloads** (fault 407 on healthy, charging robots) and asserts the complete user-visible outcome: correct battery, Charging below the threshold, Docked at 100%.
- Full suite: 210 passing.

## 2.0.0-matter.8 (Matter-only edition, unofficial)

Deep verification and cleanup pass, anchored by a new full-chain simulation:

- **Fixed a sequencing flaw in the dedicated B01 status loop start:** the loop was started from inside the device-creation loop but gated on a set that is only populated later, so whether it started at boot depended on device ordering (with a single Q7 it would not start until the 3-minute supervisor). It now starts deterministically after all devices are created.
- **Verification without debug mode:** the loop start is logged at info level, and each Q7 logs a one-time "B01 status online for <duid>: state=…, battery=…%, charging=yes/no" info line on its first successful status — the raw values straight from the robot, making frozen-battery reports diagnosable at a glance.
- **New full-chain simulation test** replicating the exact three-robot setup (two Q7s + one classic): real createDevices + initializeDeviceUpdates, real dedicated loop under fake timers, real map decode against the reference fixture, real Matter accessories — only the cloud transport is scripted. It asserts battery following the robot (74% → 100%) and the tile switching Charging (65) → Docked (66) across the 90% threshold.
- **The startup warning for sc05/Q7 models is gone:** B01/Q7-series robots are first-class citizens of this fork (debug note instead), and the v1 feature probes (get_timer, carpet, water box) are skipped for them entirely — faster startup, clean log.
- **Dead-weight removal:** the HomeKit-era scenes machinery is deleted (this also removes a pointless cloud API call every 3 minutes), consumable state churn is dropped from the HomeData poller, the per-device 1-second status tick is skipped for B01 robots (the dedicated loop owns their cadence), room refreshes run in the background when a persisted cache exists (faster boot), and unused water tables plus a dead variable are removed.
- Full suite: 209 passing.

## 2.0.0-matter.7 (Matter-only edition, unofficial)

Deep interval-lifecycle surgery — the actual root cause behind frozen battery/status readings:

- **Found and fixed an upstream architectural bug: the per-device interval properties held STARTER FUNCTIONS, not interval handles.** Every `clearInterval(vacuum.getStatusIntervall)` call was a silent no-op, and the "restart when missing" check (`!vacuum.mainUpdateInterval`) could never fire because a function is always truthy. Consequence: whichever flow stopped polling first (offline flap, reconnect, shutdown-restart races) killed it permanently, and every supervision layer — including matter.6's — faithfully called a restart mechanism that was structurally incapable of restarting anything. The starters now store real handles (self-clearing on restart), offline clears the handles and nulls the properties, and coming back online genuinely restarts both intervals. This benefits classic robots too.
- **B01/Q7 robots get a dedicated, self-managed status loop** completely independent of the v1 per-device machinery: one adapter-level interval ticks every 15 seconds and refreshes every initialized B01 robot (the attempt throttle keeps the effective cloud cadence at ~45s). It is cleared properly on shutdown and revived by the HomeData supervisor within 3 minutes if anything ever kills it. A Q7 battery reading can now be at most about a minute old whenever the cloud answers.
- Four new lifecycle tests, including the historically impossible restart branch and a full kill-and-revive cycle of the B01 loop. Full suite: 208 passing.

## 2.0.0-matter.6 (Matter-only edition, unofficial)

Room cleaning fix plus a status self-healing package, both driven by field logs:

- **Fixed Q7 room cleaning aborting with "Method load_multi_map is not supported".** The Matter room-clean flow compares the area's map id with the device's current map id and switches maps on mismatch. For B01 robots the current-map lookup returned null (v1 structure), so every room command attempted a map switch that has no Q7 equivalent — and aborted before the segment command was ever sent. B01 rooms are always fetched from the robot's current map (the `cur` flag), so the current map id now reports the canonical 0 and no switch is attempted. Full-home cleaning was unaffected; per-room cleaning now sends `service.set_room_clean` with the selected room ids directly.
- **Fixed stale battery/status freezing (Home app showing an hours-old percentage):**
  - B01 status refreshes now throttle on attempts, not successes — a robot or cloud that stops answering no longer turns the poll tick into a per-second retry storm that can perpetuate rate limiting.
  - Consecutive failures are counted: every 10th logs a warning with the last error, and recovery logs an info line, so silent outages become visible.
  - The HomeData poller now supervises B01 device intervals: an online flap used to kill Q7 status polling permanently (the v1 restart path never runs for B01); intervals now restart automatically when the robot is back online.
  - Live status values older than 15 minutes fall back to the periodically refreshed HomeData snapshot (which translates Q7-native codes), so the Matter tile self-heals even if the request path is down.
- Note: Q7 room names are refreshed from the map at most every 6 hours; after renaming rooms in the Roborock app, restart the Roborock bridge to pick the new names up immediately.
- Nine new tests (attempt throttling, failure escalation and recovery, staleness fallback, interval supervision, canonical B01 map id, and a no-map-switch room-clean regression). Full suite: 204 passing.

## 2.0.0-matter.5 (Matter-only edition, unofficial)

- **Fixed the Apple Home tile showing "Ready" instead of "Charging" on Q7 robots.** Root cause: when the Matter layer falls back to the cloud HomeData snapshot (cold start, or before the first live refresh), Q7 devices store their NATIVE work-status codes there — charging is 4, which reads as the v1 "remote control" state and never maps to the Charging tile. The fallback now translates Q7 codes to v1 states for B01 robots, and the live status mapping additionally carries `charge_status` (charging and dock air-drying) so the PowerSource cluster and the Charging/Docked threshold logic see the charger in every path. Verified by three new tests including an end-to-end accessory publish asserting Matter operational state 65 (Charging) for a charging Q7 at 74% with the 90% threshold.

## 2.0.0-matter.4 (Matter-only edition, unofficial)

- Removed the "Enable Matter vacuum" option from the settings UI, config schema, and code. In a Matter-only plugin the toggle was meaningless (off would mean the plugin does nothing). Matter publication is now unconditional; availability depends solely on the Homebridge Matter API. Legacy configs still carrying `"enableMatter": false` are ignored with a friendly one-line note in the log. The Matter feature toggles (Service Area, Power Source, Clean Mode, Charging/Docked status, threshold) are unchanged.

## 2.0.0-matter.4 (Matter-only edition, unofficial)

The two missing Q7 pieces, built against the python-roborock reference:

- **Mop/Vacuum mode switching for Q7.** The Matter clean-mode selection (Vacuum / Mop / Vacuum + Mop) now maps to the Q7 native `mode` property via `prop.set` — including the crossed enum values (Matter Mop=1 is Q7 mode 2; Matter combo=2 is Q7 mode 1). The v1-era "fan power off" workaround for mop-only is never sent to Q7 robots; suction levels still apply through the wind mapping. Water remains fully unexposed (manual tank).
- **Room selection (Matter Service Area) for Q7.** Implemented the B01 map channel end to end: `service.get_map_list` -> current map id (`cur` flag) -> `service.upload_by_mapid` -> protocol-301 payload -> base64 + AES-128-ECB (key derived from serial+model exactly as the reference) + zlib inflate -> minimal SCMap protobuf reader extracting room ids and names. Rooms are cached, persisted across restarts, refreshed at most every 6 hours, and fed to the Matter Service Area cluster in the standard shape — so per-room cleaning uses the same `service.set_room_clean` room ids the robot expects.
- Verified against a wire fixture generated with the reference implementation's own protobuf gencode and crypto: map-key derivation matches character for character, and the full decode chain reproduces the reference rooms (including UTF-8 names). Full suite: 195 passing.
- Note: robots already paired before rooms were available must be removed from Apple Home and re-paired once for the Service Area cluster to appear (Matter locks the cluster set at commissioning).

## 2.0.0-matter.3 (Matter-only edition, unofficial)

Deep Q7/B01 hardening pass:

- **Fixed a serious polling bug: B01 status refreshes bypassed the v1 throttle**, turning the 1-second poll tick into roughly one cloud request per second per Q7 robot. B01 refreshes are now throttled (periodic at most every 45s, forced/post-command at most every 1.5s) with concurrent callers sharing a single in-flight request. Robot-initiated pushes trigger a forced refresh so Matter still converges within seconds of real changes.
- **Q7 water is neither queried nor exposed.** Q7-series robots use a manually filled water tank with no electronic water control, so the `water` property is no longer polled, water state is never mapped, water-control commands are rejected, and — most importantly — Matter clean-mode capabilities for B01 robots are now pinned to vacuum-only (`canMop: false`) regardless of what the generic cloud schema claims. No mop modes ever appear in Apple Home for Q7 robots.
- **Fixed Matter room cleaning for Q7**: the adapter translated `app_segment_clean`, but the API layer's actual wire method is `app_segment_clean_by_ids` with a `{segments, repeat}` object. Both names now translate to `service.set_room_clean` with the correct room ids (ready for when the B01 map channel lands).
- **B01 robots are marked remote at creation**, so the transport layer never attempts local TCP connections to them (they are cloud/MQTT-only by design).
- **Fixed a request-id wraparound collision** affecting all protocols: the id generator handed out 0 twice in a row every 10,000 requests, colliding two pending requests.
- Six new tests: throttle cadence and forced-gap behavior, in-flight deduplication, B01 capability pinning against a mop-advertising schema, the segment wire-method translation, water exclusion, and wraparound id uniqueness. Full suite: 186 passing.

## 2.0.0-matter.2 (Matter-only edition, unofficial)

Fixes from the first field test of B01/Q7 support:

- **Fixed Apple Home commissioning failure for room-less robots.** The Service Area cluster was published with an empty supportedAreas list for robots without room data (all B01/Q7 robots until the map channel lands), which violates Matter conformance and makes Apple Home abort pairing. The cluster is now omitted entirely when no rooms are available; robots with rooms (classic models) are unchanged. Covered by tests for both cases.
- **Fixed a TypeError in the Service Area room refresh on B01 devices** ("Cannot read properties of undefined (reading 'map_status')"): the classic get_room_mapping flow reads a v1-shaped status array, but B01 status responses are Q7 dictionaries. The room refresh is now skipped for B01 robots (their room data requires the protobuf map channel), and the map_status read is defensively guarded regardless.
- **B01-unsupported methods now log at debug level** instead of red errors. get_timer, get_carpet_clean_mode, and similar feature probes simply have no Q7 equivalent yet; startup logs stay calm.

## 2.0.0-matter.1 (Matter-only edition, unofficial)

**Breaking: HomeKit (HAP) accessories removed.** The plugin now publishes each robot exclusively as a native Matter vacuum for Apple Home. On first start, all legacy HomeKit accessories (the fan tile and helper switches, including scene and schedule switches) are unregistered automatically, so every robot appears exactly once. This removes ~1,500 lines of accessory code, the scene/schedule polling loops, and the consumables/clean-summary refreshers — fewer moving parts, less MQTT traffic, fewer failure modes.

**New: B01/Q7-series protocol support (Q7 M5 `roborock.vacuum.sc05`, Q7 M5+ `ss07`, ...).** These 2025 robots speak a different RPC dialect; the plugin previously sent classic v1 methods they ignore, and dropped their responses (correlated by `msgId`, not `id`) — hence the endless command timeouts. Implemented against the actively maintained python-roborock reference and its recorded protocol fixtures:

- A translation layer (`b01Q7Adapter`) maps the plugin's v1 command surface to the Q7 dialect: start/stop/pause via `service.set_room_clean`, dock via `service.start_recharge`, locate via `service.find_device`, segment cleaning with Q7 room ids, fan power and water level via `prop.set`, and status via `prop.get` — with Q7 work states, battery, faults, and modes mapped back to the universal v1 fields the Matter layer already understands (including the Charging/Docked tile logic).
- Correct B01 request payloads (single object on dps 10000 with `method`/`msgId`/`params`; no `t`, no numeric `id`) and response correlation by the 12-digit `msgId` on dps 10001, with `code != 0` surfaced as command errors. Robot-initiated B01 pushes trigger an immediate status refresh.
- B01 devices are routed cloud/MQTT-only, and periodic v1 reads with no Q7 equivalent (network info, consumables, server timers, room mapping) return quiet neutral responses — ending the `get_network_info` timeout noise permanently.
- Known limitation: Matter Service Area (room selection) is not yet available for Q7-series robots; it requires the B01 protobuf map channel and will follow. Classic robots are unaffected.
- 20 new tests, including byte-level encryption round-trips and correlation against a real recorded Q7 response fixture. Full suite: 175 passing.

## 1.4.67-hardened.6 (unofficial hardening build)

- Redesigned the plugin settings UI as a light, readable theme: white panels on a soft neutral background, a calm teal accent, and dark headings/text. All key color pairs verified at WCAG AA contrast (headings 16-17:1, muted text and pills 5+:1).
- Headings now use explicit colors instead of inheritance. Homebridge UI injects its own theme stylesheet into custom-UI iframes, which could previously render section headings nearly invisible depending on the selected Homebridge theme.
- Fixed the Devices section layout: the list container borrowed the pairing-list grid class, misaligning checkbox rows. Devices now have their own styled rows with hover states and a "Disabled" chip on skipped robots.
- Accessibility and polish: keyboard focus rings on buttons/inputs/links, input focus glow, accent-colored checkboxes, toast notifications with colored edge indicators, and consistent button hover/active states.

## 1.4.67-hardened.5 (unofficial hardening build)

- Fixed Matter pairing entries never matching their robots: the commissioning serial (the robot's SN for vacuum nodes) was looked up in a DUID-keyed map, so every node fell back to the generic "Matter Roborock Bridge" label. Devices are now indexed by both DUID and serial, so vacuum pairing cards show the robot's name.
- Pairing records belonging to disabled (skipped) robots are now hidden behind a one-line note with a "Show anyway" toggle. These records are inert leftovers in Homebridge's Matter storage from when the robots were managed; the accessories themselves are no longer registered. The list updates live when robots are enabled/disabled in the Devices section.
- The platform now logs each stale Matter accessory it unregisters ("Unregistering stale Matter accessory ..."), making skip-list cleanup visible in the Homebridge log.
- Polished the Devices section row layout (alignment/spacing) introduced in hardened.3.

## 1.4.67-hardened.4 (unofficial hardening build)

- The Charging/Docked tile opt-in now uses the battery percentage as the discriminator between the two states, with a configurable "Charged Battery Threshold (%)" (default 100). While docked below the threshold the Apple Home tile shows Charging — even if the robot already claims fully charged — and at or above it the tile shows Docked, even if the robot still reports a charging flag. Worn batteries commonly report "fully charged" early; lowering the threshold (e.g. 90) keeps the tile honest. Falls back to the state-based value when no battery reading is available. Exposed in both the config schema and the settings UI; covered by four new tests.

## 1.4.67-hardened.3 (unofficial hardening build)

- Fixed skip-list enforcement: `skipDevices` was only applied to the login-time runtime list, so skipped robots still had HomeKit and Matter accessories published for them with no runtime behind them. The skip list is now enforced at the source (`getAllHomeDevices`), covering discovery, Matter publication, read paths, and local-key refresh consistently; existing accessories for skipped robots are unregistered by the stale-accessory cleanup on the next bridge restart. Covered by a regression test matching both DUID and serial number.
- Added a Devices section to the plugin settings UI listing every robot from cached HomeData (name, model, DUID, serial, online state) with a per-robot checkbox. Unchecking a robot writes it to Skip Devices and saves automatically; skipped robots stay visible so they can be re-enabled. The section is fed by the existing diagnostics endpoint, so it works even for robots the plugin no longer manages.
- Exposed the "Show Charging/Docked on the Apple Home tile" option in the settings UI (previously only reachable through the JSON config editor, since the custom UI replaces the schema-generated form).
- Performance: `getStoredHomeData` now memoizes the parsed HomeData per distinct payload. Previously every Matter attribute read and cluster build re-parsed the full multi-kilobyte HomeData JSON; steady-state CPU/GC pressure drops accordingly. The ignored-device set is also cached per config identity (including a fix for a fresh-array fallback that defeated identity comparison).
- Regression suite extended to 19 tests, including parse-memoization reference stability and source-level skip enforcement.

## 1.4.67-hardened.2 (unofficial hardening build)

- Added an opt-in "Enable Matter Charging/Docked Status" setting. When enabled, the plugin publishes the standard RVC Charging (0x41) and Docked (0x42) operational states — and advertises them in the operational state list for Matter conformance — so the Apple Home tile shows "Charging"/"Docked" instead of always "Ready" while on the dock. Default remains off, preserving the upstream Ready-on-dock behavior for older iOS versions. Covered by three new conformance tests (charging, fully-charged/docked, and default-off).

## 1.4.67-hardened.1 (unofficial hardening build)

All robustness changes from the 1.4.64-hardened.1 build, re-ported onto upstream 1.4.66 (none had been independently fixed upstream), plus two new fixes:

- `catchError` no longer renders "Failed to execute undefined on robot undefined (unknown model)" when a caller only passes a message; the message is logged as-is. Contextual calls keep the existing format.
- The unmapped-model notice (e.g. `roborock.vacuum.sc05` / Q7 M5) is now an informative warning explaining that generic defaults are applied and that core controls and Matter still work, instead of a scary "not fully supported / contact the dev" error with broken formatting.
- The Matter device-not-ready classifier now also recognizes the upstream "Vacuum <duid> is not initialized." phrasing used by the new schedule endpoints, so those failures log calmly during startup races too.

Re-ported hardening (see 1.4.64-hardened.1 notes for details): startup-race command guards with rollback, no silent success on unbuildable messages, self-healing 60s Matter heartbeat, throw-proof status reads, extended endpoint-init backoff (1s–60s), dispose() lifecycle on shutdown/unregister, unref'ed timers, clean-mode capability fallback, and lazy HomeData debug serialization. Regression suite extended to 13 tests covering all of the above.

## 1.4.66

- Exposed each Roborock app schedule as a persistent HomeKit switch, with live enable/disable state backed by `get_server_timer` and `upd_server_timer`. Addresses issue #6.
- Added Matter Service Area current-room reporting for active room cleaning, including resets that prevent stale room status during whole-home, spot, or zone cleaning. Addresses issue #7.

## 1.4.65

- Internal cleanup pass across the whole codebase: removed duplicated logic (shared crypto helpers, shared live-message parsing, consolidated device-model tables), deleted dead code, and simplified several hot paths (parallelized independent requests, reduced redundant JSON parsing/buffer reads) with no intended behavior changes. Verified against a live Roborock S6 Pure over Matter (start, pause, dock).
- Fixed a display bug in the Homebridge UI's Matter pairing card where a real pairing/setup code could be mistaken for "not available" if it happened to match the literal placeholder text used for missing codes.
- Fixed plugin config local test failing after first successful run within the same config session. The TCP socket probe was not properly managing socket lifecycle, which could cause resource exhaustion on subsequent test runs. Added `socket.unref()` to prevent sockets from keeping the Node process alive and improved error handling during socket cleanup. Addresses issue #13.

## 1.4.63

- Matter Pause and Return to Dock are now always forwarded to the robot instead of being dropped when the plugin's cached state looks idle. The cache can lag or be overridden by a stale HomeData refresh while the robot is really cleaning, which previously made the plugin silently reject real pause/dock commands as "not cleaning" / "already docked" (seen on a Roborock S7 `roborock.vacuum.a15` that was room-cleaning while HomeData reported it as charging). A redundant pause/dock on an already-docked robot is a harmless no-op. Addresses issue #12.
- Fixed the Matter Cleaning tile collapsing back to Docked/Ready in Apple Home almost immediately after Start on models that sync slowly through the cloud (e.g. S8 / `roborock.vacuum.a51`). The optimistic Cleaning state is now held through the lagging "still docked/charging" reports during the recent-command window after a Start/Resume/area-clean, instead of being abandoned after two contradicting reports, so the tile stays on Cleaning — and Return to Dock stays available — until the robot actually reports Cleaning. It still falls back to the real state once that window passes, so a start the robot never acted on (e.g. a full bin) does not stay stuck on Cleaning. Follow-up to the 1.4.60 command-forwarding fix for issue #4.

## 1.4.62

- Added explicit package author metadata so npm identifies Joshua Appleman as the package author while keeping trusted GitHub Actions publishing intact.

## 1.4.61

- Kept Matter RVC state publishes as serialized full snapshots for all refresh paths, including live updates and Service Area selection changes, so Apple Home is not left depending on partial cluster writes after controller refreshes.
- Removed the plugin's explicit RVC Operational State `operationalError` write and added tests pinning the Matter RVC mode clusters without unsupported `startUpMode`/`onMode` attributes.
- Added rechargeable battery metadata to the optional Matter Power Source cluster, including nullable charging-current and time-to-full-charge values.
- Improved the Homebridge UI Matter Pairing lookup to search common Docker/Homebridge Matter storage paths and keep loading pairing data even when plugin config is unavailable.
- Updated Matter RVC `Updating...` documentation after the live Homebridge 2.1.1-beta reset/re-pair test rendered the full RVC endpoint correctly in Apple Home.

## 1.4.60

- Fixed Matter Pause and Return to Dock being silently dropped on models that sync slowly (e.g. Roborock S8 / `roborock.vacuum.a51`, which fall back to the cloud). After a Matter Start, these robots can keep reporting "docked/charging" for tens of seconds before they report "Cleaning"; during that lag the plugin's cached state was stale, so a follow-up pause/dock was rejected as "not cleaning" / "already docked." An explicit Matter pause/dock issued within 60s of a start/resume/area-clean is now forwarded to the robot even when the cached snapshot still reads docked (a redundant pause/dock on an already-docked robot is a harmless no-op). The Pause control also gained the same in-flight-command allowance that Return to Dock already had. Addresses issue #4.

## 1.4.59

- Made the HomeKit Pause Cleaning and Return to Dock switches wait for Roborock acknowledgement and log command timing, matching the fan Start/Stop path. Previously these were fire-and-forget, so a pause/dock that the robot did not acknowledge (e.g. once it is already cleaning) failed silently with no log; they now surface the acknowledgement time or a clear timeout/error to aid diagnosis.

## 1.4.58

- Fixed the root cause of Apple Home getting stuck on "Updating..." until Play Sound to Locate was pressed: Matter publishes are now serialized full snapshots with no plugin-side change tracking, so racing state updates can no longer leave the Matter store holding a stale value that the plugin refused to re-send. Verified at the Matter protocol level against a live Homebridge 2.1.1-beta container.
- Restored spec-conformant RVC Operational State phase attributes (`phaseList`/`currentPhase` are null again) and removed the synthetic identify pulses and phase flapping that were broadcast to every Apple Home hub as refresh signals. The nulls are written on every publish so upgraded installs repair their Matter store without re-pairing.
- Replaced the 5-second active-state heartbeat with a quiet 60-second full-snapshot safety net; matter.js suppresses unchanged writes, so steady-state Matter traffic drops to normal keep-alives.
- Kept Play Sound to Locate (Identify) working as a manual full-state resync, and added regression tests pinning publish serialization, null phase attributes, full-snapshot republishes, and the no-synthetic-identify rule.

## 1.4.57

- Hardened Roborock MQTT protocol 300/301 parsing so short cloud payloads are skipped cleanly instead of throwing `RangeError` during inbound message handling.
- Made legacy HomeKit fan Start/Stop commands wait for Roborock acknowledgement and log command timing, improving diagnostics for models where switches appear to do nothing.
- Propagated Matter command errors/timeouts reliably and added one bounded Matter Return to Dock retry when Roborock still reports active cleaning after an ambiguous `app_charge` timeout.

## 1.4.56

- Hardened Roborock live cloud/local status routing so device-scoped updates are delivered only to the matching vacuum, and unscoped live arrays are ignored when multiple vacuums are configured.
- Added normal Homebridge log entries when the legacy HomeKit fan accessory receives Start/Stop writes, making it easier to tell whether a failed command reached the plugin.
- Added regression coverage for multi-vacuum live-message routing and unscoped live payload handling.

## 1.4.55

- Kept Matter optimistic state after Roborock cloud or local command acknowledgement timeouts and started an immediate fast follow-up refresh cadence so Apple Home can converge once live `get_status` catches up.
- Allowed Matter Return to Dock to send `app_charge` after a recently timed-out Start even when the cached Roborock snapshot still says docked or charging.
- Added regression coverage for timed-out Matter commands, fast status refreshes, and stale docked snapshots during follow-up dock requests.

## 1.4.54

- Bounded Matter clean-mode preparation so slow Roborock cloud acknowledgements for fan or mop settings no longer delay the actual Start command for 30-40 seconds.
- Limited Matter clean-mode prep commands to a short request timeout and kept Start moving with optimistic state when prep is slow or ambiguous.
- Stopped trying alternate Roborock water-mode commands after timeout errors, while still falling back for unsupported or unknown command responses.

## 1.4.53

- Improved Matter state reads so Apple Home can receive cached/live vacuum state quickly while the plugin refreshes Roborock in the background, reducing long `Updating...` stalls after reopening Home.
- Added a Matter Pairing section to the Config UI that reads Homebridge commissioning data and shows the Roborock child/daughter bridge QR code plus each vacuum's 11-digit setup code after restart.
- Improved the Config UI local connection test to recognize an already-active or recently-used local Roborock connection and show the source of the diagnostic result.
- Moved debug logging and Roborock cloud fallback toggles into an Advanced troubleshooting section so the normal setup flow stays focused on account, Matter, and pairing.
- Quieted repeated `get_status` warnings for known Roborock status fields when Homebridge has not created a matching diagnostic state object, while keeping warnings for genuinely new fields.

## 1.4.52

- Delayed and retried Matter state refreshes while Homebridge reports a freshly registered endpoint is still initializing, reducing startup AccessControl warnings after bridge or child-bridge restarts.
- Added compact Roborock status diagnostics to copied Config UI reports, including recent `get_status` and live cloud/local payloads for troubleshooting incorrect current-state or room-status reports.
- Captured compact `get_server_timer` and `get_timer` responses while debug logging is enabled so schedule-switch feature requests can be investigated without exposing credentials.

## 1.4.51

- Scoped live Roborock cloud/local status updates to the source vacuum so one robot's push messages no longer update every configured HomeKit or Matter vacuum.
- Kept Matter optimistic state after Roborock command acknowledgement timeouts, avoiding stale Idle/Charging rollbacks when the robot accepted the command but the cloud acknowledgement arrived late or not at all.
- Made the Config UI local connection test recover from stalled requests and skip LAN probing when **Use Roborock cloud only** is enabled.

## 1.4.50

- Fixed the Node current CI test failure by isolating Matter timer cleanup in tests and adding a safe timer fallback for deferred Matter state updates when the test runtime removes the global timer.

## 1.4.49

- Added **Use Roborock cloud only** to disable local LAN discovery and local TCP commands for installations where local sockets appear connected but repeatedly time out; commands and status polling now route through Roborock cloud when available.
- Updated diagnostics and copied reports to show cloud-only mode clearly instead of stale local connection state.
- Graduated Matter Service Area room selection from a separate beta checkbox so it is included automatically whenever the Matter vacuum is enabled.

## 1.4.48

- Applied **Prefer Roborock cloud for Matter commands** to Matter follow-up status refreshes as well as commands, so S8-style local status timeouts do not leave Apple Home stuck on Cleaning after the robot returns to dock.
- Passed the Matter cloud preference through the Roborock status polling stack down to the underlying `get_prop/get_status` request.

## 1.4.47

- Kept the Matter vacuum run mode active while Roborock is returning to dock, avoiding an inconsistent Idle/Returning state combination that could make Apple Home show "No Response" during the charging transition.

## 1.4.46

- Preferred Roborock cloud acknowledgements for Matter saved-map switches before selected-area cleaning, avoiding local `load_multi_map` acknowledgement timeouts that could leave Apple Home stuck on "Updating...".
- Continued Matter selected-area cleaning when Roborock has already switched to the requested saved map even if the map-load acknowledgement reports a timeout.

## 1.4.45

- Added an optional **Prefer Roborock cloud for Matter commands** setting so Matter vacuum commands can bypass local LAN command timeouts on models such as the S8 while leaving the existing HomeKit accessories on their normal transport path.
- Forced short follow-up status refreshes after Matter commands are acknowledged so Apple Home can move out of optimistic states such as Returning once Roborock reports the real charging/docked status.
- Ignored empty Roborock cloud push results so `CloudMessage data: undefined` packets no longer get forwarded as accessory updates.

## 1.4.44

- Treated unsupported Roborock clean-mode setting responses such as `unknown_method` as best-effort during Matter starts, so models that reject water-box commands can still continue to the actual start command and remember the unsupported setting path.

## 1.4.43

- Cleared stale remote-fallback markers when a vacuum reconnects over local TCP, so polling can return to local transport instead of staying pinned to Roborock cloud after a temporary connect failure.

## 1.4.42

- Fixed Apple Home getting stuck on "Connecting" when commissioning the Matter vacuum by reverting the operational state list to bare state IDs without labels. The manufacturer-range operational states with labels introduced in 1.4.40 were not tolerated by Apple Home during commissioning; this restores the known-good advertisement that paired successfully.

## 1.4.41

- Built the Matter cluster snapshot from the freshest live Roborock status (state, battery, charge) instead of the slower periodic HomeData snapshot, so registration snapshots and Apple Home attribute reads reflect changes sooner.
- Allowed slow saved-map switches (`load_multi_map`) up to 30 seconds before timing out, because older models such as the S6 Pure can take longer than the default 10 seconds to switch maps, and kept transient timeout warnings classified correctly regardless of the configured duration.
- Internal hardening with no behavior change: introduced a typed Roborock API surface for the Matter accessory and consolidated duplicated Matter name normalization to reduce drift.

## 1.4.40

- Restored the original Roborock map after Matter Service Area room refreshes, even when another saved-map load times out, and retried empty saved maps periodically so newly segmented rooms can appear without restarting Homebridge.
- Hardened Matter RVC conformance by using standard Vacuum and Mop clean-mode tags for Vacuum + Mop, moving Roborock-specific operational states into the labeled manufacturer range, and returning INVALID_SET for multi-map room selections.
- Cleared optimistic Matter state after repeated contradicting Roborock updates so Apple Home does not stay on a wrong state until the timeout when a command is acknowledged but has no effect.
- Built only the requested Matter cluster for single-attribute reads and mirrored the Roborock name onto the accessory `name` to reduce generic "Matter Accessory" labels during pairing.

## 1.4.38

- Ensured every Matter Service Area room advertises a matching saved-map entry, using Roborock map names when available and a generated label otherwise, so Apple Home no longer risks getting stuck on Updating when a room references a map without a reported name.
- Cached persisted Roborock state (HomeData, room mappings, transport diagnostics) in memory after the first read to cut repeated disk reads on every status lookup and command while preserving the on-disk file format and legacy migration.
- Removed an unreachable internal command branch and a duplicate status helper, and ignored local tooling files during lint.

## 1.4.37

- Kept unresolved Roborock maps out of Matter Service Area metadata until they have matching room segment IDs, avoiding Apple Home getting stuck on Updating with incomplete map data.
- Avoided reloading the Roborock map that is already active while refreshing Matter room mappings, preventing startup timeouts on models that reject that reload.

## 1.4.36

- Reloaded saved Roborock maps during Matter Service Area refresh even when Roborock reports the map is already active, giving multi-floor rooms another chance to expose segment IDs.
- Published saved Matter Service Area map names as soon as Roborock reports them, even while rooms for a map are still being resolved.
- Documented Matter pairing-name behavior and why Apple Home may ask to add the external vacuum accessory after the bridge is commissioned.

## 1.4.35

- Added capability-gated Matter clean modes for Vacuum, Mop, and Vacuum + Mop on Roborock models that report mop or water support.
- Applied selected Matter clean modes before Matter start/resume commands by updating Roborock suction and water settings where the model exposes those controls.
- Refreshed Matter Service Area room mappings across saved Roborock maps while idle, then restored the original map so multi-floor room lists can populate automatically.
- Applied cached Roborock identity metadata earlier for restored Matter accessories so re-pairing is less likely to show a generic Matter Accessory name.

## 1.4.34

- Prefixed Matter Service Area room labels with the Roborock map name when multiple saved maps are available, so controllers that flatten maps still show floor context.
- Documented the map-name label fallback for Apple Home and other Matter clients that do not expose a separate map picker yet.

## 1.4.33

- Added multi-map Matter Service Area metadata so supported clients can group rooms by saved Roborock maps.
- Cached room mappings per Roborock map and preserved saved map names for upper/lower floor setups.
- Loaded the selected Roborock map before starting Matter room cleaning when a selected area is on another map.

## 1.4.32

- Deferred Matter state pushes until after command handlers return to reduce HomeKit command timeouts.
- Added Matter Service Area map metadata and clearer Matter command/room-selection diagnostics.
- Documented re-pairing the Matter vacuum after changing the Service Area beta setting because controllers can cache the cluster list.

## 1.4.31

- Added an opt-in beta Matter Service Area path that exposes cached Roborock rooms to Matter clients and uses selected rooms for Matter-initiated cleaning.
- Documented the Service Area beta as work in progress and kept it behind a separate setting from the main experimental Matter vacuum.

## 1.4.30

- Moved local/cloud transport transition diagnostics behind debug logging to keep normal Homebridge logs quieter.
- Updated Matter vacuum commands to report the requested state immediately and log Roborock acknowledgment timing.
- Expanded Matter battery power-source state and linked the regular HomeKit battery service to the main accessory.
- Sanitized Roborock scene switch names so generated HomeKit names avoid unsupported characters.

## 1.4.29

- Kept Matter vacuum state optimistic after commands so Apple Home does not fall back to stale ready/idle status while Roborock reports the transition.

## 1.4.28

- Added a Matter RVC clean-mode cluster so Apple Home can complete the native vacuum accessory setup.
- Clarified Matter vacuum setup instructions for child bridge Matter enablement and log-based pairing codes.

## 1.4.27

- Removed the unsupported Matter run-mode startup attribute from experimental vacuum state updates.

## 1.4.26

- Fixed experimental Matter vacuum registration by omitting standard operational-state labels that Matter rejects during conformance validation.

## 1.4.25

- Added optional experimental Matter robotic vacuum exposure for Homebridge 2 with Matter enabled.
- Kept the existing HomeKit fan/switch accessory path active for backwards compatibility.
- Documented the Matter setting and Phase 1 command mapping in the README, roadmap, and admin UI.

## 1.4.24

- Changed transient timeout warning throttling to group repeated polling failures per vacuum instead of per command.
- Increased the default transient warning interval to 6 hours and added a configurable Homebridge/UI setting.
- Added support for setting the transient warning interval to 0 so recurring transient warnings only appear when debug logging is enabled.

## 1.4.23

- Throttled repeated transient command warnings so recurring Roborock polling timeouts are logged periodically instead of every refresh cycle.

## 1.4.22

- Added dedicated HomeKit momentary switches for Pause Cleaning and Return to Dock.
- Changed the main HomeKit off action to stop cleaning only instead of also sending a dock command.
- Clarified cloud-only transport logs so expected Roborock cloud calls are not described as fallback from local control.

## 1.4.21

- Added plain-English transport transition logs for local TCP connections, cloud fallback, local recovery, remote/shared devices, offline state, missing local credentials, and missing local IP discovery.
- Reduced duplicate fallback logging and stopped printing local keys in debug discovery logs.

## 1.4.20

- Added a "Test Local Connection" action in the admin UI that performs a live LAN TCP probe for each cached vacuum.
- Included local test results in copied diagnostic reports with DUIDs and local IPs still redacted.

## 1.4.19

- Added a short diagnostics auto-refresh after admin UI startup when the first snapshot is not locally connected.
- Added transport freshness timestamps to diagnostic cards and copied diagnostic reports.

## 1.4.18

- Updated the roadmap to reflect completed diagnostics, Homebridge compatibility, CI, release automation, and security work.
- Improved diagnostics wording so local credentials, local TCP connectivity, cloud fallback, and offline states are easier to understand.
- Added a redacted "Copy Diagnostic Report" action for future GitHub Issues.
- Added GitHub Issue templates for bug reports, feature requests, and model support reports.

## 1.4.17

- Maintenance release to verify the trusted publishing and GitHub release automation after the admin UI and diagnostics updates.
- No runtime behavior changes from `1.4.16`.

## 1.4.16

- Improved the Homebridge admin UI for readability with clearer section layout, status messaging, help text, and explicit settings save behavior.
- Documented all plugin settings in the Homebridge schema and README, including region selection, encrypted tokens, password fallback, debug logging, and skipped devices.
- Added serial numbers to UI diagnostics so ignored device values are easier to copy from the admin panel.
- Fixed `skipDevices` so Homebridge config values are passed into discovery and can match either Roborock serial numbers or DUIDs.

## 1.4.15

- Tightened obstacle photo handling in the map UI to accept only base64-encoded image data and render it through browser-generated blob URLs.
- Added blob URL cleanup when closing or replacing obstacle photos to avoid leaking browser-side object URLs.

## 1.4.14

- Hardened region detection by parsing the configured Roborock host instead of using substring matches.
- Sanitized map obstacle image URLs before assigning them in the browser UI to reduce XSS and client-side redirect risk.
- Added explicit read-only permissions to the CI workflow, upgraded GitHub Actions versions, and moved Codecov uploads to a repository secret.

## 1.4.13

- Adjusted `package.json` repository metadata to match the fork URL exactly for npm Trusted Publishing compatibility.
- Updated the npm publish workflow to use Node 24 and the latest npm CLI for Trusted Publishing compatibility.

## 1.4.12

- Improved model resolution and startup hardening for newer Roborock metadata layouts.
- Added diagnostics in the Homebridge UI for model detection, local key availability, discovery state, local IP, TCP connection state, and last transport used.
- Fixed updater payload crashes caused by malformed or partial cloud/local message payloads.
- Improved room mapping behavior with clearer logging and fallback labels when Roborock room names are missing.
- Replaced forced hourly MQTT reconnects with a health-check-based reconnect path.
- Added guards against transient `0%` battery reports while the robot is docked or charging to reduce false HomeKit low-battery alerts.
- Added regression tests around transport selection, room mapping, and model/diagnostics handling.
- Added incremental TypeScript-style checking for the core transport queue and a `typecheck` script for ongoing migration work.
- Added GitHub Actions automation for npm publishing on `master` using npm Trusted Publishing.

## 1.2.2

- **New Feature**: Dynamic Scene Switch Management
  - Automatically create HomeKit switch buttons for each device's available scenes
  - Scene switches named after scene names with momentary switch behavior
  - Automatically add/remove corresponding switch buttons when scenes change
  - Execute corresponding scenes when switches are pressed, with error handling and status feedback
  - Synchronize scene switches when HomeData is updated
- **Improvement**: Refactored scene API methods, separated scene fetching and device filtering functionality
- **Fix**: Resolved recursive call issue in scene methods

## 1.0.15

- Fix Roborock Saros 10R Status issue

## 1.0.6

- Support new model

## 1.0.0

- First version.
