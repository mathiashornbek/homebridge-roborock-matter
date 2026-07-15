# Homebridge Roborock Vacuum 2 Roadmap

## Recently Completed

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
- Added dedicated HomeKit controls for Pause Cleaning and Return to Dock so docking is no longer bundled into the main on/off control.
- Clarified cloud-only transport logs so expected Roborock cloud calls are not described as local fallback.
- Added configurable, per-vacuum throttling for recurring transient timeout warnings.
- Added Phase 1 optional Matter robotic vacuum exposure for Homebridge 2 while preserving the existing HomeKit fan/switch accessory.
- Added capability-gated Matter clean modes for vacuum, mop, and vacuum + mop selection on mop-capable Roborock models.
- Stabilized Matter publishing: serialized full-snapshot writes with no plugin-side change tracking, restored spec-conformant RVC operational state (null phases, no state labels), and removed synthetic identify/phase churn that left Apple Home stuck on "Updating…" (1.4.58).
- Added acknowledgement waiting + timing logs to the HomeKit Pause/Return-to-Dock controls (1.4.59, issue #12).
- Fixed Matter Pause/Return-to-Dock being dropped on slow-syncing models (e.g. S8 / `roborock.vacuum.a51`) while the cached state still reads docked (1.4.60, issue #4).
- Investigated the Apple Home Matter RVC "Updating…" tile, captured the upstream evidence, and later verified that a clean reset/re-pair can render the full RVC endpoint correctly (homebridge/homebridge#3951); see `docs/matter-rvc-updating-homebridge-report.md`.
- Added an `AGENTS.md` handoff guide for AI coding agents.
- Added live room tracking for B01/Q7: the robot's map position is resolved against room outlines while cleaning and published as the current Matter Service Area, with honest scope-aware progress transitions (2.4.0).
- Hardened startup so a rejected login or unreachable Roborock cloud can never crash Homebridge: credential errors stop with clear guidance, network errors retry with backoff (2.4.2).
- Removed node-forge (RSA keys now via Node's OpenSSL CSPRNG), removed the dead ioBroker-era package/image downloader and jszip, and moved the custom UI server to native ESM loading — eliminating the Socket.dev "uses eval", "obfuscated code", and ZIP-handling alerts at the source (2.5.0).
- Added self-healing capability detection: poll requests a robot answers as unsupported are disabled automatically per device, unknown models get capability-derived poll profiles, and model lookup mismatches log actionable guidance (2.5.0).
- Shipped opt-in suction-level Matter clean modes (Quiet/Balanced/Turbo/Max + Max+ on Q7) with correct Apple-rendered intensity tags and live fan-power derivation, so app-side suction changes reflect in Apple Home (2.6.0-2.8.1).
- Extended live room tracking to classic S/Q-series robots via the RRMap segment grid — the flagship feature now covers the whole fleet (2.7.0).
- Rebuilt the README and the custom settings UI: every Apple Home feature toggle is now visible in a dedicated section with re-pair markers on capability-changing options (2.6.0, 2.9.0).
- Filed the frozen-battery-percentage report upstream as homebridge/homebridge#3958 with the full evidence chain; a Homebridge maintainer verified the corrected Matter 1.4 Q-quality analysis the same day (2026-07-15).\n- **Achieved Verified by Homebridge status** after full review by the Homebridge team, with the Donate button enabled (2.9.3, 2026-07-15).
- Deep performance pass on the live-room hot paths: classic map lookup went from ~23 ms + ~6.7 MB allocations to ~1 µs with zero allocations; room-cache disk writes and hot debug stringify eliminated when idle (2.9.1).

## In Progress

- Monitor homebridge/homebridge#3951 (Matter RVC "Updating…") — still open upstream but no recurrence reported since 2026-06-24; the clean reset/re-pair result has stayed stable so far.
- Await the reporter retest on upstream issue applemanj#4 (S8 local timeouts) after the 1.4.60 fix. Upstream issue applemanj#12 (pause/dock) was confirmed fixed and closed on 2026-07-08.
- Continue reducing the remaining known-model poll maps toward capability-based logic (the default path for unknown models is capability-derived as of 2.5.0; the dedicated known-model profiles are kept as verified behavior).

## Worth Doing Next

- Await responses on homebridge/homebridge#3958 (frozen battery percentage) and the plugin verification final review (homebridge/plugins#1124, all automated checks passed).
- Field-validate the classic S/Q-series live room tracking and the suction-level modes on real hardware (first run pending on the maintainer's own S8 Pro Ultra and Q7 fleet).
- Continue validating Matter room/service-area selection, live room tracking, and clean-mode behavior across Apple Home and other controllers.
- Field-validate the capability-derived defaults on newly released models (Saros 10, Q5 Max+, QX Revo Plus, Q10 S5+) as model reports come in; unsupported requests are now detected and disabled automatically per device.
- Review GitHub Issues regularly for new model reports, diagnostics exports, and feature requests (automated monitoring of issues, Socket.dev alerts, and homebridge#3951 is set up on the maintainer side).

## Superseded by the Matter-only design

- ~~Improve scene and room controls so HomeKit exposes room cleaning shortcuts~~ — this fork removed all HomeKit (HAP) accessories by design; room cleaning is exposed natively through Matter Service Area selection, which Apple Home renders with correct room names and no invalid-characteristic warnings.

## Worth Evaluating Carefully

- Optional manual overrides for model mapping when Roborock metadata is incomplete.
- Optional manual local IP override or reconnect tools in the UI.
- Native HomeKit vacuum support if Homebridge/HAP exposes a stable service in the future.

## Probably Not Worth It

- Rewriting the transport stack from scratch.
- Fork-only divergence without tests or observability.
- Large UI redesign before operational visibility is in place.
