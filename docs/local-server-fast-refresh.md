# Local server fast refresh

An opt-in test preset for a self-hosted Roborock server. In the plugin settings,
select **Custom server**, then open **Advanced troubleshooting** and enable
**Faster updates for local server (experimental)**. Save and restart the Roborock
child bridge. Turn it off and restart to restore the ordinary intervals.

The setting is `enableLocalServerFastRefresh`, default `false`. It applies to
the robots on this platform instance. It needs a valid custom HTTPS server URL
and a saved session advertising custom REST and MQTT endpoints. A custom URL
paired with an old Roborock cloud token keeps the ordinary rates. Startup logs
whether the preset is active. Changing the preset requires no HomeKit re-pairing.

## Refresh intervals

| Requests                                                                                                        | Ordinary setting                                | Local preset                                                              | Purpose                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Classic status (`get_prop` containing `get_status`)                                                             | At least 60 seconds apart, on a 15-second timer | At least 15 seconds apart, same timer                                     | State, battery, charging, errors and other live status; MQTT push continues independently.                                                              |
| Classic live map (`get_map_v1`)                                                                                 | At least 10 seconds apart                       | At least 5 seconds apart while the map channel is answering               | Locate the robot in a room during cleaning. Each robot allows only one live-map request in flight.                                                      |
| Slow device parameters                                                                                          | 30-minute minimum                               | 5-minute minimum; normally about 6 minutes on the existing 3-minute cycle | Consumables, timer lists when owned by the generic poller, carpet/water settings and model-specific dock settings. Unsupported requests remain skipped. |
| Schedule/routine list cache                                                                                     | 5 minutes                                       | **5 minutes**                                                             | Cache is checked on reads; expiry permits a fresh request. HomeKit writes still trigger their own verification.                                         |
| Account/device snapshot                                                                                         | 3 minutes                                       | **3 minutes**                                                             | Fetch account devices and supervise their polling.                                                                                                      |
| Classic map list / room names (`get_multi_maps_list`, `get_room_mapping`, plus fresh status for floor identity) | 3 minutes                                       | **3 minutes**                                                             | Notice new maps, renamed rooms and map changes.                                                                                                         |
| Missing saved-map room cache                                                                                    | 6 hours between attempts per map                | **6 hours**                                                               | Avoid repeatedly switching maps to discover missing room mappings; skipped while cleaning.                                                              |

The map gap is a limit, not an independent 5-second poller. Requests are triggered
by live status updates and the Matter accessory's update cycle. Sparse status
updates can therefore produce fewer map requests. Maps are fetched only for
states where the robot is moving through rooms, not when paused or docked.

B01/Q7 robots keep their existing status cadence (about 15 seconds active and
30 seconds idle), 30-second fresh-pushed-map suppression, and six-hour room-list
cache. Their healthy fallback live-map request gap can use the 5-second minimum,
but their existing failure backoff remains. Q10 live-map support is unchanged.

Faster status reads do not guarantee Apple Home will display battery percentages
more frequently; controller-side reading/reporting behavior still applies.

## Protections retained

| Mechanism                            | Current behavior retained                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repeated unanswered method           | Six consecutive qualifying timeouts pause that method on that robot for six hours; one answer clears it. Connection failures are classified separately. |
| Live-map failures                    | Classic maps retain a 10-second minimum retry gap; B01 retains exponential backoff after two failures, capped at five minutes.                          |
| Failed schedule list reads           | Progressive delays of 1, 2, 5, 15 and 60 minutes, with 10% jitter.                                                                                      |
| Explicit schedule/routine rate limit | Account-wide 65-minute cooldown. It applies to a real rate-limit response even from a self-hosted server.                                               |
| Schedule writes                      | 500 ms batch window, 500 ms spacing, shared account queue, duplicate coalescing, 3-second verification delay and existing write-outcome handling.       |
| Request deadlines                    | Ordinary RPC timeout 10 seconds; map switching 30 seconds; B01 map payload 20 seconds; REST 30 seconds. These are deadlines, not polling intervals.     |
| MQTT recovery                        | Existing reconnect backoff, session-silence recovery and optional preventive refresh settings. The preset does not enable or change session refresh.    |
| Direct robot LAN recovery            | Existing connection retry, keepalive and local-mute behavior. A self-hosted MQTT server and direct robot TCP are different transports.                  |
| Logging/persistence                  | Repeated-warning suppression and diagnostic disk-write debounce. These do not limit requests.                                                           |

Start, pause, dock and other user commands do not wait for these periodic refresh
windows. Their command routing and confirmation rules remain in place.

## First test

1. Enable the toggle, save and restart. Check for `Local server fast refresh active`.
2. Run a clean on each robot, including one run with both working together.
3. Watch room tracking and state changes; try pause, resume and dock.
4. Compare timeouts, map failures and MQTT reconnects against the ordinary mode.
5. Disable the toggle and restart if the extra traffic causes problems.

This preset has automated coverage for its request timing, configuration,
endpoint guards and retained protections. Physical testing is still required.

Implementation: [request policy](../roborockLib/lib/requestPolicy.js),
[status polling](../roborockLib/lib/vacuum.js),
[API polling and maps](../roborockLib/roborockAPI.js), and
[schedule policy](../src/hap_schedule_accessory.ts).
