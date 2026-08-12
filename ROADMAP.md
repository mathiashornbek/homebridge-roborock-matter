# homebridge-roborock-matter Roadmap

## Recently Completed

- **Home app action switches (3.5.0).** Apple Home does not offer a Matter
  vacuum's commands as automation actions — measured for docking by pponce in
  issue #3, who moved that part of his setup to a HAP plugin rather than go
  without it. An opt-in switch per robot per action (Return to Dock, Pause,
  Find) gives an automation something it can actually turn on. The press routes
  through the same command path as the Matter tile, so it inherits the
  acknowledgement wait, the #4 forward-anyway decision, the dock retry and the
  optimistic tile update instead of re-earning all four. The switches are
  partitioned out of the Matter-only accessory sweep by a context marker, and
  registered under the real package name rather than PLUGIN_NAME.
- Repo cleanup (3.4.12): removed the ioBroker-era leftovers this fork never
  used — the orphaned map viewer and MITM sniffing script, ten locale files no
  code path could ever load, ten unreferenced functions, and the last dead
  branch of the withdrawn fault subsystem. Two rules now guard the classes of
  mistake behind them: a locale that ships must be selectable, and the README's
  test count is checked against the suite instead of typed in by hand.
- Live-room diagnosis for B01/Q7 (3.4.9, 3.4.10): the miss line now carries the
  room-outline range, the map origin, and a full field survey of the map
  payload. Measured on two Q7s mid-clean, the "position" came back as exactly
  (1100.0, 1100.0) on both — a constant, not a place. **Live room tracking has
  never worked on these models**, and the survey is how the right field gets
  identified from a log instead of guessed a third time.
- Never report a suction level the robot did not report (3.4.11).
- Clean-mode prep no longer lets one timed-out command cancel another (3.4.8):
  choosing Vacuum sends water-box OFF, and a fan-power timeout used to drop
  that command entirely, so the robot mopped a room the user asked to vacuum.
- Honest transport reporting for B01/Q7 (3.4.6, 3.4.7): the cloud-only marker
  that survived re-pairs and reinstalls is reconciled at startup, and a robot
  marked remote now records _why_ instead of the report inventing a failed LAN
  connection for a protocol that has no LAN surface.
- The Matter publish line is written on every change it reports (3.4.5), all
  nine Saros 10 status fields are mapped (3.4.4), and an unmapped field is
  reported once per robot rather than once a minute (3.4.3) — roughly 11,500
  warnings a day removed for one reporter.
- Withdrew the Matter fault attribute (3.4.0, 3.4.1): three controlled field
  tests on an S8 Pro Ultra showed Apple Home draws no Matter vacuum fault from
  a bridged accessory at all, and publishing one locked the tile in "Updating".
  Operational _states_ render fine. **Do not attempt this a third time without
  new evidence.**
- Every log line names the robot instead of printing a raw duid (3.3.1, 3.3.2),
  enforced by a test that enumerates the rule across the source tree.
- Live room made genuinely live on Q7 robots (3.2.0), and the dock statuses
  made real with the capability leak closed and the local channel hardened
  (3.1.0).
- Startup now completes in ~2 s (3.0.1): local transport attaches in the background, and the first cloud requests wait for the MQTT session instead of racing it.
- Startup and refresh pass (3.0.0): LAN discovery now overlaps the rest of startup (~5 s faster restarts), per-robot probes run concurrently, the never-firing classic status refresh was repaired (60 s throttle), and the 1 s scheduler tick became 15 s.
- Live clean-mode mirroring (2.9.9): cleans started from the Roborock app or the robot's buttons now show the correct Vacuum / Mop / Vacuum+Mop mode in Apple Home during the run (Q7 native clean-type reporting; classic robots derived from suction/water signals).
- Added admin UI diagnostics for model resolution, local credential availability, local IP discovery, TCP connection state, and last cloud/local transport.
- Persisted discovery and transport state so failures can be inspected after startup.
- Hardened model lookup against newer Roborock HomeData shapes.
- Added regression coverage for discovery parsing, room mapping, payload normalization, battery handling, and transport fallback behavior.
- Added CI validation for Homebridge `1.11.x` and `2.0.0-beta`.
- Improved npm trusted publishing, GitHub release automation, and CodeQL security hygiene.
- Improved the Homebridge admin UI layout, setting descriptions, and diagnostics readability.
- Added GitHub Issue templates for bug reports, feature requests, and model support reports.
- Added plain-language per-device connection diagnostics and a redacted diagnostics report for GitHub Issues.
- Added startup diagnostics auto-refresh and transport freshness timestamps.
- Added a manual "Test Local Connection" action that runs a live LAN TCP probe from the admin UI.
- Added clearer transport logs for local TCP connections, cloud fallback, local recovery, remote/shared devices, missing local credentials, and missing local IP discovery.
- _(pre-Matter-only)_ Added dedicated HomeKit controls for Pause Cleaning and Return to Dock. These were removed in the Matter-only rebuild; Return to Dock, Pause and Find came back in 3.5.0 as opt-in switches beside the Matter vacuum, for the automation gap measured in issue #3 — not as a second way to publish the robot.
- Clarified cloud-only transport logs so expected Roborock cloud calls are not described as local fallback.
- Added configurable, per-vacuum throttling for recurring transient timeout warnings.
- _(pre-Matter-only)_ Added Phase 1 optional Matter robotic vacuum exposure for Homebridge 2 alongside the HomeKit fan/switch accessory. The HomeKit half is gone; Matter is now the only surface.
- Added capability-gated Matter clean modes for vacuum, mop, and vacuum + mop selection on mop-capable Roborock models.
- Stabilized Matter publishing: serialized full-snapshot writes with no plugin-side change tracking, restored spec-conformant RVC operational state (null phases, no state labels), and removed synthetic identify/phase churn that left Apple Home stuck on "Updating…" (1.4.58).
- _(pre-Matter-only)_ Added acknowledgement waiting + timing logs to the HomeKit Pause/Return-to-Dock controls (1.4.59, issue #12).
- Fixed Matter Pause/Return-to-Dock being dropped on slow-syncing models (e.g. S8 / `roborock.vacuum.a51`) while the cached state still reads docked (1.4.60, issue #4).
- Investigated the Apple Home Matter RVC "Updating…" tile, captured the upstream evidence, and later verified that a clean reset/re-pair can render the full RVC endpoint correctly (homebridge/homebridge#3951); see `docs/matter-rvc-updating-homebridge-report.md`.
- Added live room tracking for B01/Q7: the robot's map position is resolved against room outlines while cleaning and published as the current Matter Service Area, with honest scope-aware progress transitions (2.4.0).
- Hardened startup so a rejected login or unreachable Roborock cloud can never crash Homebridge: credential errors stop with clear guidance, network errors retry with backoff (2.4.2).
- Removed node-forge (RSA keys now via Node's OpenSSL CSPRNG), removed the dead ioBroker-era package/image downloader and jszip, and moved the custom UI server to native ESM loading — eliminating the Socket.dev "uses eval", "obfuscated code", and ZIP-handling alerts at the source (2.5.0).
- Added self-healing capability detection: poll requests a robot answers as unsupported are disabled automatically per device, unknown models get capability-derived poll profiles, and model lookup mismatches log actionable guidance (2.5.0).
- Shipped opt-in suction-level Matter clean modes (Quiet/Balanced/Turbo/Max + Max+ on Q7) with correct Apple-rendered intensity tags and live fan-power derivation, so app-side suction changes reflect in Apple Home (2.6.0-2.8.1).
- Extended live room tracking to classic S/Q-series robots via the RRMap segment grid — the flagship feature now covers the whole fleet (2.7.0).
- Rebuilt the README and the custom settings UI: every Apple Home feature toggle is now visible in a dedicated section with re-pair markers on capability-changing options (2.6.0, 2.9.0).
- Filed the frozen-battery-percentage report upstream as homebridge/homebridge#3958 with the full evidence chain; a Homebridge maintainer verified the corrected Matter 1.4 Q-quality analysis the same day (2026-07-15).
- **Achieved Verified by Homebridge status** after full review by the Homebridge team, with the Donate button enabled (2.9.3, 2026-07-15). The plugin icon was added to the official Homebridge icons registry by the team the same evening, and the plugin is listed on the Homebridge Matter Plugins wiki.
- Startup-cost cleanup: removed two redundant RSA-2048 key generations at boot (one unused, one now lazy for the rare photo path) plus dead HomeKit-era helpers (2.9.4).
- Deep performance pass on the live-room hot paths: classic map lookup went from ~23 ms + ~6.7 MB allocations to ~1 µs with zero allocations; room-cache disk writes and hot debug stringify eliminated when idle (2.9.1).

## In Progress

- **Fix B01/Q7 live room tracking.** The field being read as the robot's
  position is not the robot's position — measured, not suspected. The next
  Q7 run produces two consecutive `scalars` lines in the log; the value that
  changes while the robot drives is the position, and the field that grows is
  the trail it leaves. The fix follows the measurement, not a guess.
- Monitor homebridge/homebridge#3951 (Matter RVC "Updating…") — still open upstream but no recurrence reported since 2026-06-24; the clean reset/re-pair result has stayed stable so far.
- Continue reducing the remaining known-model poll maps toward capability-based logic (the default path for unknown models is capability-derived as of 2.5.0; the dedicated known-model profiles are kept as verified behavior).

## Worth Doing Next

- Enable GitHub 2FA before 2026-08-27, or the automated npm releases stop.
- Await responses on homebridge/homebridge#3958 (frozen battery percentage). The battery-percentage freeze itself is settled and closed upstream as works-as-intended: `batPercentRemaining` carries Matter's "changes omitted" quality, and Apple's controller does not re-read it. It is not fixable from this side.
- Confirm whether a Qrevo CurvX (`a185`) reports fan power 110 or 108 at fixed
  highest suction before shipping a model table for it — upstream has no a185
  profile, and `a288` is a sibling, not the same model.
- Field-validate the capability-derived defaults on newly released models (Saros 10, Q5 Max+, QX Revo Plus, Q10 S5+) as model reports come in; unsupported requests are now detected and disabled automatically per device.
- Review GitHub Issues regularly for new model reports, diagnostics exports, and feature requests (automated monitoring of issues, Socket.dev alerts, and homebridge#3951 is set up on the maintainer side).

## Superseded by the Matter-only design

- ~~Improve scene and room controls so HomeKit exposes room cleaning shortcuts~~ — the robot itself is published over Matter only, and room cleaning is exposed natively through Matter Service Area selection, which Apple Home renders with correct room names and no invalid-characteristic warnings. The one HAP exception is the 3.5.0 action switches, which exist because Apple offers no automation action for these commands; they do not publish the robot and are off by default.

## Worth Evaluating Carefully

- Optional manual overrides for model mapping when Roborock metadata is incomplete.
- Optional manual local IP override or reconnect tools in the UI.
- Native HomeKit vacuum support if Homebridge/HAP exposes a stable service in the future.

## Probably Not Worth It

- Rewriting the transport stack from scratch.
- Fork-only divergence without tests or observability.
- Large UI redesign before operational visibility is in place.
