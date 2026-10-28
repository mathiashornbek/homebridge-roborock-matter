# Water-tank warnings in Apple Home

For a robot with a recognised automatic wash-and-refill dock, the Matter
**Refill water tank** warning requires both an onboard water shortage and an
empty or missing dock clean-water reservoir. This allows a robot to start its
normal refill cycle when the dock has water.

| Dock reservoir | Onboard shortage | Blocking clean-water warning    |
| -------------- | ---------------- | ------------------------------- |
| Clear          | No               | No                              |
| Clear          | Yes              | No                              |
| Empty/missing  | No               | No                              |
| Empty/missing  | Yes              | Yes, for a mode that uses water |

The onboard reading is `water_shortage_status`. The dock reading is
`dock_error_status: 38` or the clean-water field in `dss`. Missing readings do
not establish that both tanks are empty. Some firmware reports an onboard
shortage unreliably or omits it; those robots may not show the blocking warning
even when the dock reservoir is empty. A clear fault code is not a water-volume
measurement, and the robot still decides whether it can actually clean.

Vacuums with a plain charger, an auto-empty-only dock, or an unrecognised dock
keep the existing single-tank warning. Known refill-dock types follow
python-roborock's `RoborockDockTypeCode` and `is_wash_n_fill_dock` classification.

The separate **Water Tank Empty** HomeKit sensor keeps reporting the existing
tank condition, so an empty dock reservoir remains visible to automations even
while the Matter tile allows a start. Dirty-water and other robot faults keep
their existing behavior. Vacuum-only mode and an already-running clean keep
their existing fault suppression.

This behavior applies with local or cloud servers. It needs no additional
toggle and is independent of the faster-refresh preset. Restart the Roborock
child bridge after updating; re-pairing is not required.
