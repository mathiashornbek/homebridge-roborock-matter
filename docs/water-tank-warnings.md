# Water-tank warnings in Apple Home

For a robot with a recognised automatic wash-and-refill dock, an onboard water
shortage alone does not trigger the Matter **Refill water tank** warning when
a dock reading is present and reports no empty or missing clean-water tank.
This allows the robot to start its normal refill cycle. An empty or missing
dock tank still triggers the warning regardless of the onboard shortage flag.

| Dock clean-water reading | Onboard shortage  | Blocking clean-water warning    |
| ------------------------ | ----------------- | ------------------------------- |
| Present and clear        | No                | No                              |
| Present and clear        | Yes               | No                              |
| Empty/missing tank       | Any or unreported | Yes, for a mode that uses water |
| Unreported               | Yes               | Yes, for a mode that uses water |
| Unreported               | No                | No                              |
| Unreported               | Unreported        | Unknown; existing behavior      |

The onboard reading is `water_shortage_status`. The dock reports an empty or
missing clean-water tank through `dock_error_status: 38` or the clean-water
field in `dss`. Either empty-tank signal takes precedence over a clear reading
from the other field. Otherwise, a usable reading from either dock field is
enough to suppress an onboard-only warning. A missing reading, including a
`dss` word of zero, does not confirm that the dock tank is clear.

Vacuums with a plain charger, an auto-empty-only dock, or an unrecognised dock
keep the existing tank checks. Recognised refill docks also keep those checks
when neither dock field provides a usable reading. Known refill-dock types
follow python-roborock's `RoborockDockTypeCode` and `is_wash_n_fill_dock`
classification. A clear fault code is not a water-volume measurement, and the
robot still decides whether it can actually clean.

The separate **Water Tank Empty** HomeKit sensor keeps reporting the existing
tank condition. Dirty-water and other robot faults keep their existing
behavior. Vacuum-only mode and an already-running clean keep their existing
fault suppression.

This behavior applies with local or cloud servers. It needs no additional
toggle and is independent of the faster-refresh preset. Restart the Roborock
child bridge after updating; re-pairing is not required.
