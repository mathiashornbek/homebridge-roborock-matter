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

## In Progress

- Monitor homebridge/homebridge#3951 for recurrence after Apple Home/controller refresh cycles; close if the clean reset/re-pair result stays stable.
- Await reporter retests on issues #4 and #12 after the 1.4.59/1.4.60 fixes.
- Improve scene and room controls so HomeKit exposes room cleaning shortcuts with cleaner names and fewer invalid characteristic warnings.
- Add clearer model lookup mismatch and unsupported attribute logs.

## Worth Doing Next

- Evaluate supported fan or cleaning modes where the HomeKit service model allows it.
- Continue validating Matter room/service-area selection and clean-mode behavior across Apple Home and other controllers.
- Improve support for recently reported models such as Saros 10, Q5 Max+, QX Revo Plus, and Q10 S5+.
- Reduce brittle model-specific switches by moving feature detection toward schema/capability-based logic.
- Review GitHub Issues regularly for new model reports, diagnostics exports, and feature requests.

## Worth Evaluating Carefully

- Optional manual overrides for model mapping when Roborock metadata is incomplete.
- Optional manual local IP override or reconnect tools in the UI.
- Native HomeKit vacuum support if Homebridge/HAP exposes a stable service in the future.

## Probably Not Worth It

- Rewriting the transport stack from scratch.
- Fork-only divergence without tests or observability.
- Large UI redesign before operational visibility is in place.
