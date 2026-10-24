# Changelog

Entries before 3.39.0 are short summaries. The full notes for every release are on the [GitHub releases page](https://github.com/mathiashornbek/homebridge-roborock-matter/releases) and in the git history of this file.

## 3.40.1

**A robot that stops away from its dock no longer reads as docked, a start from an automation resumes a paused clean, and three contributions from @pponce are in.**

- **The Docked sensor (#28).** A robot that stopped at a pin & go spot read Docked, and the tile could say Charging there. Robots report `charge_status` 1 off the dock too (CooperCGN's own S8 does while paused mid-room), so Idle, Charger Disconnected and the states on the way home now place the robot from its state alone, as python-roborock does.
- **A start resumes a paused clean (#28).** Automations and Shortcuts have no Resume; they set the robot to Cleaning. On a paused robot that started the run over, or turned a paused room clean into a whole-home clean. A start now resumes the paused clean, unless other rooms have been selected since. The Start Cleaning switch does the same.
- **Schedule switches** ([#32](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/32), @pponce). A write Roborock confirms is no longer reported as failed because the other schedule source is rate-limited. Only unconfirmed writes fail, and no second write is sent during the 65-minute pause. Repeated taps share one write while Apple Home waits for the answer.
- **Presence lines** ([#36](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/36), @pponce). The "online" snapshot the broker replays at startup is no longer logged as the robot coming back. A robot's first live offline report is still a warning, and the LAN reassurance is only given to robots that have a LAN.
- **Diagnostics** ([#46](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/46), @pponce). The MQTT diagnostics keep the last eligible read timeout across sessions, for comparison.
- **A quieter log.** A failed robot-list refresh during a network outage is a warning that says the robots keep working, instead of "Failed to update updateHomeData" at error level. The note about a Q7's pushed datapoints is debug.
- **Shorter documents.** The README is rewritten for everyday users at a third of its length, and this changelog is cut down.

2,600 tests. 7 of the 12 new docked-sensor tests and 3 of the 5 new resume tests fail on 3.40.0.

## 3.40.0

**The same failures kept coming back because the plugin handled its connections differently from python-roborock, the library Home Assistant uses, in exactly the places where that library had already fixed them. A full review against it found those differences and the faults around them.**

### My own mistakes first

- The "Failed to execute …" line was printed at most once every 6 hours per robot and error, so the log hid most failures (36 lines in a week stood for about 1,400 timeouts on my own server). One line per robot per hour now sums up its LAN and cloud requests, and the warning repeats after an hour.
- 3.36.0's "3 unanswered cloud requests → fresh MQTT session" could not fire on an account with a Q7: any Q7 reply reset the count. My own S8 Pro Ultra's cloud path stayed dead for 2.3 days that way.
- 3.35.0's resume fix (#28) never worked in production: `in_cleaning` was not kept from the live status, so Resume always sent a whole-home start.
- Matter does have a code for a full dirty-water tank (74, since Matter 1.4.2); I told #26 otherwise.
- A start that failed and then succeeded on its retry never published the robots, so every robot showed "No Response" until a restart.

### Connections

- Every local connection is pinged every 10 s, as python-roborock does, and reconnected at once after a drop. A request whose connection dies, or that times out on the LAN, is sent again over the cloud instead of failing (#24). Map lists, maps and network info always go over the cloud.
- Each MQTT connection is a new client with its own id, opened after python-roborock's back-off (10 s, ×1.5, at most 10 minutes). Every cloud request carries the security block. The 3-silence restart counts classic robots' cloud requests only, and a request whose connection went away is never counted as a silent robot.

### Apple Home

- Resume continues a paused room clean (`resume_segment_clean`). The clean mode follows the robot's own water setting, live.
- A standing tank warning is no longer withdrawn and raised again by a restart, a quiet spell or a dock chore. A full dirty-water tank is reported as DirtyWaterTankFull (#26).
- Rooms are marked cleaned only when a run finished; a Stop marks the rest skipped. The room selection survives a restart, and an incomplete room list no longer shrinks or freezes it.

### Startup, login and schedules

- A login session Roborock no longer accepts is replaced or reported once, instead of retried forever. Logins send the agreement version Roborock asks for (avoiding error 3006) and are capped at python-roborock's rates.
- Shared robots get a runtime and their owner's room names; renamed robots and rooms are picked up on the 3-minute refresh, and a robot is removed only after two readings without it.
- A self-hosted [local_roborock_server](https://github.com/Python-roborock/local_roborock_server) can be used for the login (#43).
- The cloud REST clients give up after 30 s. A schedule switch answers Apple Home in time and confirms afterwards; a write the cloud does not confirm is switched back, with the reason in the log.

### Q7 and Q10

- A Q7's live room comes from the map it pushes while cleaning, not from the saved map. Trapped, brush-jammed and similar Q7 and Q10 faults reach Apple Home. A Q7 state the tables cannot translate reads as unknown, not idle.
- A Q10 reads its own units for suction, clean mode and faults, shows its rooms, resumes a paused room clean and is asked for its status once a minute (#19).

Contains @pponce's [#30](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/30) and [#42](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/42). 2,541 tests; four independent reviews ran before release.

## 3.39.0

**Cloud requests go out the way python-roborock sends them, and my own S8 Pro Ultra answered the map request again after weeks of silence.**

- Cloud requests use QoS 0 and a lowercase security nonce, matching python-roborock; a publish made while the link is down is refused at once instead of reaching the robot minutes later.
- Selecting every room in Apple Home no longer shows the rooms of the last run (#24). A room selection spanning two maps is refused so the old one is kept.
- A schedule write the cloud refused no longer looks like it succeeded: the switch stays where it was and Apple Home is told the write failed.
- HomeKit names such as "Q5 Max+" no longer make HAP warn (#40): `+` reads as "Plus", and other unsupported characters become spaces.
- Fixed a crash of the child bridge 30 s after a retried start during a network outage (beta only), and several leftovers at shutdown and restart. About 640 lines of dead code removed.
- 2,255 tests. CI now runs the suite in one process, as the release workflow does.

## 3.38.0

- Map give-up log lines no longer accuse the plugin of a bug when the discarded replies were meant for another controller on the account, usually the Roborock app (#28).
- The `Matter service area selection request` log line now shows what actually arrived, and a selection refused for spanning two maps says so and explains why it reverts (#24).

## 3.37.0

- **New MQTT session diagnostics**: when a cloud request times out, the diagnostics report now shows whether the cloud connection was actually delivering anything, contributed by @pponce (#29).
- Diagnostics only: nothing about connecting or sending requests changes, and the report holds only counts and ages, no robot IDs, topics, credentials or payloads.

## 3.36.0

- **Robots that accept the LAN connection but never answer should now respond**: local connections start with a protocol hello and match python-roborock's message format (#24, #28).
- The log now says once how the robot answered the hello, e.g. `answered the local hello in 1.0`; please include that line in #24 and #28.
- A cloud session that reports itself connected but delivers nothing is now restarted after 3 timeouts in a row, at most once every 30 minutes.

## 3.35.0

- Fixed a 3.34.0 regression where resuming a paused full clean used the room-clean command; each paused clean type now resumes with its own command, as in Home Assistant.
- **An empty water tank no longer turns a running clean into an error** in Apple Home, and the refill notification no longer repeats every 10 minutes (#35, thanks to @pponce).
- New optional Dirty Water Tank Full and Cleaning Fluid Empty sensors; Water Tank Empty reads the dock's per-tank status (#22, #26); Q10 robots no longer flip between Stopped and Docked (#33).

## 3.34.0

- The room poll now asks for rooms first, so robots that never answer it are finally paused after six tries instead of flooding the log, fixing what 3.33.0 missed (#22, #24).
- **Pressing play on a paused room clean** now continues it instead of starting a new full clean; a failed resume leaves the robot paused. B01/Q7 robots are unchanged (#28).

## 3.33.0

- The room poll on classic robots no longer starts with a status request, saving a cloud round-trip and letting the plugin pause a robot that never answers room requests (#22, #24).
- This explains log lines like `Failed to execute get_room_mapping` followed by `get_status timed out`; the fix only partly worked and was completed in 3.34.0.

## 3.32.0

- **The give-up rule now actually works for all optional polls**: before, only map requests were ever counted, so other unanswered requests kept timing out instead of being paused.
- Network outages are now reliably kept out of the give-up rule; the previous check could never match.
- When `get_map_v1` is given up, the normal log line now says whether map replies were arriving and being discarded, so no debug logging is needed (#24).

## 3.31.0

- Give-up rule fixes: Q7/B01 map fetches are counted per request, robots coming back online start fresh, and network blips should not count (that check only worked from 3.32.0).
- An Apple Home tile left stale by a rejected update now heals within about 10 minutes through the regular heartbeat.
- Map replies dropped by the plugin are now logged with the robot's name, a wrong address check is fixed, and one robot's interrupted photo transfer no longer blocks every robot's maps.

## 3.30.0

- **The water-tank notification repeating every two minutes is fixed**: it came from the plugin, not Apple; you can turn `enableMatterTankFaultReporting` back on (#5, #9, #26).
- A request a robot never answers is now paused for six hours after six silent tries; status and commands are exempt (only map requests were actually counted until 3.32.0).
- Unchecking schedules or routines now removes their tiles, and enabling both creates tiles for both without resetting the plugin (#22).

## 3.29.0

- Robots that refuse device-side schedules, like the Saros 10R in #22, now show their timed app Routines as switches in the robot's Schedules accessory, named after each Routine.
- **Run Routines from Apple Home**: optional `enableHomeKitRoutineSwitches` (off by default) adds a Routines accessory with one switch per app Routine, usable from Siri and Home automations.
- The debug log no longer prints your robots' local keys, serial numbers or account token; if you posted an older debug log publicly, consider removing it.

## 3.28.0

- Vacuums appear in Apple Home much sooner after a restart, especially robots that don't answer locally (#22), and the first status shows immediately instead of after 15 seconds.
- Much less background traffic: about 160 to 52 requests an hour per classic robot and 60 to 6 for a Q7, by checking slow-changing readings every 30 minutes.

## 3.27.0

- Schedule diagnostic for #22 (debug logging only): the scene route allows only deleting, so the probe now asks two neighbouring routes which methods they accept, with safety controls.

## 3.26.0

- Schedule diagnostic for #22 (debug logging only): the probe now asks the scene route which request methods it accepts, without trying any, and logs the answer. Still not a feature.

## 3.25.1

- Schedule diagnostic for #22 (debug logging only): a refused request now logs the server's actual explanation instead of just a bare status code 400.

## 3.25.0

- Schedule diagnostic for #22 (debug logging only) now reads one cloud schedule directly to see whether the plugin could ever switch it; switching schedules from HomeKit is still not built.

## 3.24.2

- Fixed shutdown hanging and leaving a network socket open when Homebridge stopped during the five-second LAN discovery window.

## 3.24.1

- A robot that gets a new IP address from DHCP now finds its way back to the fast local connection instead of staying on the cloud until Homebridge restarts (#21).

## 3.24.0

- Schedule diagnostic for #22 found where newer robots like the Saros 10R keep their schedules: as app Routines with a timer in the cloud, not on the robot.
- The debug log now shows every such schedule readably (name, time, enabled, what it runs) instead of cutting it off; switching them from HomeKit is not built yet.

## 3.23.1

- Normal lifecycle codes are no longer logged as possible faults: 2102 (clean finished) and 2100 (recharge and resume) on Q7, and 407 on Q10. Apple Home was never affected.

## 3.23.0

- New read-only diagnostic (debug logging only) asks two cloud routes where newer robots like the Saros 10R keep their app schedules, and logs the answer and saves it in diagnostics.
- These schedules are not shown in HomeKit yet; this release only measures their shape.

## 3.22.0

- Schedule switches use far fewer cloud calls: longer caching, backoff after failures, merged rapid toggles, one queue per account and a pause after rate limiting. Contributed by @pponce (#23).
- Fixed a deadlock where reading a schedule switch during a write could freeze schedule traffic for every vacuum on the account until Homebridge restarted.

## 3.21.4

- A robot refusing a request, like a Saros 10R's "Not FCC robot", no longer logs a stack trace every poll; it is noted once, then logged at debug. Thanks to @DSimeone1989.

## 3.21.3

- When a robot refuses a request, the log and error now give the robot's own reason instead of `Result: undefined`. Reported by @DSimeone1989 in #22 about missing app schedules.

## 3.21.2

- Rooms the robot only drives through are no longer marked cleaned; the 3.19.7 fix fell short, so a room now needs sightings spanning 90 seconds (#9, reported by @vp-debug12).

## 3.21.1

- Fixed a login retry that could restart the plugin after Homebridge had already shut it down, for example a restart soon after booting without network.

## 3.21.0

- **Change clean mode mid-run**: a mode picked while the robot is cleaning or paused is now sent to it immediately; if the robot rejects it, the picker rolls back.
- Requires Homebridge 2.4.1-beta.11 or newer (homebridge/homebridge#4001) and follows `enableMatterCleanMode`; on Homebridge 2.4.0 nothing changes.
- The empty-water-tank warning now respects a mode changed mid-run, so it won't warn about water the robot has already turned off.

## 3.20.1

- Fixed seven resource problems: shutdown now really closes robot connections and pending requests, and a list that grew by about 86,400 entries a month per robot no longer grows.
- A brief network failure at boot no longer deletes your saved login session and cached device list; only an actual login refusal does.

## 3.20.0

- A robot that dropped offline briefly, or was offline when Homebridge started, is polled again when it returns instead of freezing its tile until a restart.
- A Roborock cloud outage during startup no longer leaves the plugin idle forever; it now retries from 1 minute, backing off to every 10 minutes, without giving up.

## 3.19.8

- A "recovered" log line now appears only if the failure was announced too, so default logs no longer report recoveries from problems you were never told about.

## 3.19.7

- Tried to stop rooms the robot only drives through from being marked cleaned by requiring two consecutive sightings (#9, reported by @vp-debug12); superseded by 3.21.2, because it was not enough.

## 3.19.6

- Removed an unused cloud firmware check that had never actually run; nothing changes for you, and a new test stops it returning as about 480 wasted requests per robot daily.

## 3.19.5

- Room-list refreshes that cannot succeed are no longer retried every poll: skipped on a Q10, and backed off up to 30 minutes on a Q7 whose map channel is down.

## 3.19.4

- Log lines for an unknown `error_code` now include the robot's state at the time, so reports are useful; codes 2104, 2105 and 2110 are still not mapped.

## 3.19.3

- Fixed a robot mid-clean briefly showing as docked when an older cloud snapshot overwrote live status. Reported by @jbyhb in #20.
- Troubleshooting docs for the "Updating…" tile now say restarting the Apple device is what helps, and only for days to a week (#7).

## 3.19.2

- A Q10 read the plugin deliberately doesn't send no longer logs a "Failed to execute" warning; genuine connection problems still warn.
- Troubleshooting docs for the "Updating…" / "No Response" tile now lead with restarting the Apple device rather than updating iOS.

## 3.19.1

- Q10 robots no longer cause repeated `Live-room map fetch has failed` warnings while cleaning; the plugin skips the map read and notes once that rooms are not reported mid-clean.

## 3.19.0

- **Q10 commands in the regular release**: confirmed working on a Q10 S5 by @niclasreich, unchanged since the beta; a Q10 tile still doesn't show a clean in progress (#19).
- A Q10 is no longer polled for status, ending false `B01 status has failed` warnings every few minutes on healthy robots.
- Cloud timeout messages now say their message count covers cloud traffic only, so a low number on a locally connected robot is normal.

## 3.19.0-beta.1

- Beta channel only, not pushed to existing installs: first Q10 commands (start, stop, pause, dock, empty bin, room clean, suction, clean mode) for #19, not yet verified on hardware.
- Known limits: resume restarts a whole-home clean, find me is refused, and Q10 status still comes from cloud home data. Q7 robots are unchanged.

## 3.18.0

- Found the real cause of #14: Q10-series robots (e.g. Q10 S5) were sent commands in the Q7 format, which they silently ignore (reported by @niclasreich).
- Q10 commands are now refused right away with a clear message instead of timing out; full Q10 support is tracked in #19.
- Q7-series robots are unchanged.

## 3.17.8

- Corrected the 3.17.7 cloud-timeout message, which could wrongly claim the robot never replied; replies the plugin cannot match to a robot are now counted and reported (#14, found by @niclasreich).

## 3.17.7

- A cloud request that times out now logs whether the robot sent anything at all, to tell a silent robot from a plugin bug; diagnostics only (#14, prompted by @niclasreich's log).

## 3.17.6

- The Empty Bin switch on robots like the S7 now keeps its custom name and Home placement after a restart (#16, reported by @pponce; fixed by @jbyhb in #17).
- Schedule switches now keep their custom names after a restart, and the schedule tile is no longer recreated (reported and fixed by @pponce in #15).

## 3.17.5

- Fixed the Roborock cloud connection staying offline after a network outage until Homebridge was restarted; it now reconnects on its own.

## 3.17.4

- The "no mapping for these fields" warning now names only fields the plugin genuinely doesn't know, not ones it already maps (#6, from @jcoz00's log; no change for #8).

## 3.17.3

- Q7- and Q10-series robots no longer make a useless cloud request every poll, removing the `get_room_mapping … timed out` error and repeated `No room mappings returned` notices (#14, reported by @niclasreich).

## 3.17.2

- The Qrevo CurvX's dock (dock type 20) is now recognised as auto-empty, so the optional Empty Bin switch can be offered for it (#6, confirmed by @jcoz00).

## 3.17.1

- Closing the plugin's settings page no longer prints a Node `Error: write EPIPE` crash dump into the Homebridge log (#6, reported by @jcoz00).
- The dock capability is now announced only when it changes, stopping a `Not publishing the Empty Bin switch…` debug line every minute per robot.

## 3.17.0

- Added an optional Empty Bin switch in Apple Home for compatible auto-empty docks (contributed by @jbyhb in #13).
- Fixed live dock-type detection, so classic robots like the S7 can expose dock features missing from their account data (found and fixed by @jbyhb).

## 3.16.0

- Turn on **Add Home app schedule switches** to enable or disable each Roborock app schedule from Apple Home (contributed by @pponce, requested in #3).
- A failed schedule refresh now keeps the existing switches instead of deleting them, so names, rooms and automations survive cloud timeouts.
- Fixed a race that could undo a successful schedule change; the new option is now documented in the settings page and README.

## 3.15.5

- Q10-series robots now use their own suction scale and fault codes instead of the Q7's, fixing Max+ and finished cleans showing as faults; a precaution before any Q10 report.

## 3.15.4

- Apple Home's Model row now shows just the model name (e.g. "Qrevo S") instead of repeating "Roborock" from the Manufacturer row; no re-pairing needed (#10, raised by n0rt0nthec4t).

## 3.15.3

- An empty water tank no longer triggers Apple Home's repeated "Fill the water tank" notification on vacuum-only runs; the Water Tank Empty sensor is unchanged (#9, reported by vp-debug12).

## 3.15.2

- Cleans started outside Apple Home (Roborock app, schedules, the robot's button, voice assistants) now also show "Cleaning" instead of "Traveling to Room", completing 3.15.1's fix (#8, #9).

## 3.15.1

- A whole-home clean now shows "Cleaning" in Apple Home instead of "Traveling to Room" for the entire run (#9, reported by vp-debug12; also #8 from skmzwanke).

## 3.15.0

- Accessory details now show a real model name (e.g. "Roborock Qrevo S") instead of a code like `roborock.vacuum.a104`, for 34 models; unknown models keep their code.
- Apple Home still showed Manufacturer "Homebridge" because Homebridge discarded these values; fixed upstream in Homebridge 2.4.1-beta.3 (homebridge/homebridge#3996), with no re-pairing needed.

## 3.14.3

- A mop run no longer switches to "Vacuum + Mop" in Apple Home while the dock washes the mop, empties the bin or updates the map, extending 3.12.3's fix.

## 3.14.2

- Urgent fix: 3.14.0 froze the robot's status, battery and faults in Apple Home whenever the dock was idle (e.g. stuck on "Cleaning Mop"); updates now get through again.

## 3.14.1

- The Homebridge log's publish line now shows the dock phase (e.g. `phase=Drying mop`), so you can check whether Apple Home displays 3.14.0's phases.

## 3.14.0

- The dock's jobs, including the 2 to 4 hours of mop drying after every mop clean, are now published to Apple Home as Matter phases; whether Apple Home shows them is unmeasured.
- Mop drying is detected on both classic robots and B01/Q7 robots.
- Set `enableMatterDockPhases: false` in `config.json` to turn phases off if a controller dislikes them.

## 3.13.1

- Correction to 3.13.0: unknown robot error codes (such as `error_code: 2105` on healthy docked Q7s) no longer show a fault in Apple Home; they are logged once instead.

## 3.13.0

- Apple Home now shows why a robot stopped: stuck, jammed wheel, blocked brush, dust bin missing or full, unreachable dock, flat battery and more.
- Unrecognised error codes reported a generic fault and were logged for reporting (the generic fault was withdrawn in 3.13.1).
- Fixed error codes being lost between polls and on local connections; no re-pairing needed, and `enableMatterTankFaultReporting: false` still turns it off.

## 3.12.5

- Corrected code comments and settings-page text that misstated the Matter specification; no behaviour changes.

## 3.12.4

- Corrected the README, which for 17 minutes wrongly said Homebridge puts all robots on one shared Matter node; each robot has its own. No code changes.

## 3.12.3

- A mop run no longer briefly shows "Vacuum + Mop" in Apple Home while a classic S- or Q-series robot drives back to the dock.

## 3.12.2

- Changing debug mode, region, email or a device row in the settings page no longer silently switches off untouched HomeKit sensor options or writes your password into `config.json`.

## 3.12.1

- The empty-tank warning (Water Tank Empty sensor and the Apple Home fault) now actually fires; the plugin had never kept the tank status it needed.

## 3.12.0

- Apple Home now shows a "refill the water tank" warning on the tile when the robot reports an empty clean-water tank (prompted by vp-debug12's screenshot in #9).
- Removed the Apple Home Features switches from the settings page; those features are now all on, and existing `config.json` values are still honoured.
- **Re-pair once** if your robot was paired before this release with any of those features off.

## 3.11.2

- Failing map fetches during a run now back off (up to 5 minutes) instead of retrying constantly, and the "failed N times in a row" counters now reset each run.

## 3.11.1

- If the robot's LAN port accepts connections but never answers, the plugin now switches to the cloud after 3 timeouts instead of losing 10 seconds on every request (#8).

## 3.11.0

- Q7 placeholder positions are no longer reported as "between rooms" or counted as misses in live room tracking.
- A resolved room now logs its map cell, making position problems easier to compare.
- Removed the `Skipping known get_status attribute without a Homebridge state object` debug line that flooded the log about 50 times a minute per robot.

## 3.10.2

- Apple Home no longer shows Vacuum when the robot never confirmed the vacuum-only command and keeps mopping; the mode is pinned only once the robot acknowledges it (#8).
- Skipped heartbeat publishes are now logged at debug, so a gap in the log really means something stopped (#7).

## 3.10.0

- Added an optional **Water Tank Empty** contact sensor per robot, so a Home notification can tell you when the clean-water tank is empty (requested by Wazza151 in #5; also #9).
- The sensor only reports and never blocks a mop run; it is off by default and needs no re-pairing.
- Fixed new sensors showing a wrong state on startup, such as `Cleaning` announcing a finished clean that never happened.

## 3.9.4

- A robot sent home mid-clean is no longer wrongly treated as docked because of a leftover charging flag, which also fixes the Docked sensor and the dock-command retry (#8).

## 3.9.3

- The dock no longer announces a phantom cleaning start and finish when the robot briefly reports "returning to dock" after emptying its bin, which also falsely triggered the `Cleaning` sensor (#9).

## 3.9.2

- After a restart, the Apple Home tile now shows the robot's real status straight away instead of a stale idle/Vacuum state for about 30 seconds.

## 3.9.1

- Fixed the first status request failing on every Q7 at every startup (`recovered after 1 failed attempt(s)`), which also left the tile showing stale status for about 30 seconds.

## 3.9.0

- Added optional read-only contact sensors per robot (e.g. `Vicky Docked`, `Vicky Cleaning`) so the robot's state can trigger Apple Home automations (based on pponce's feedback in #3).
- The sensors follow the robot's real state, ignore dock chores, and wait for the robot to report in, avoiding false automation triggers after a restart.
- Off by default and no re-pairing; they pair using the plugin's child bridge HomeKit QR code.

## 3.8.0

- **The settings page now follows Homebridge's dark theme**, switching as soon as you change the theme; the QR code stays white so cameras can still read it.
- The plugin's icon now appears beside the settings page title, as on other plugins' settings pages.

## 3.7.1

- The Matter Pairing section no longer tells you to pair the bridge first: each robot pairs with its own Matter code and does not need the bridge. Wording only (#7).

## 3.7.0

- **New Start Cleaning switch** for automations, next to Return to Dock, Pause and Find; it starts the same clean as the Home tile's play button, including any rooms selected there.
- Off by default and no re-pairing needed; the log says which surface started a clean, e.g. `Starting Vicky from the Home switch.`

## 3.6.2

- A dock chore such as emptying the dust bin no longer makes Apple Home announce a clean starting and finishing (#9); docs note Debug Mode also needs Homebridge's `-D`.

## 3.6.1

- Two 3.6.0 log fixes now actually work: the poll-profile line prints once per model, and `Loading accessory 'X' from cache.` moved to debug.

## 3.6.0

- Settings page: a new install no longer saves default-on features as off, the password is no longer re-saved after a 2FA login, and the switches option now publishes them.
- The page now reports failed saves, greys out settings that need another one turned on, and no longer loads Google Fonts, which stalled it on offline Homebridge boxes.
- Calmer, clearer log: duplicate lines removed, Roborock outages logged as short warnings instead of stack traces, and 14 more lines name the robot instead of a raw ID.

## 3.5.4

- 3.5.3's new startup line pointed child-bridge users at the wrong QR code; it now reads the bridge setup from `config.json` and covers both bridges when unsure.

## 3.5.3

- If the switches don't show in Apple Home, the log, settings page and README now explain why: the child bridge needs Enable HAP turned on, then its own QR code paired.

## 3.5.2

- Apple Home no longer shows Vacuum and mop for the first minute or two of a vacuum-only clean started from Home; the clean itself was always right (#8, thanks to @skmzwanke).

## 3.5.1

- Docs only: the README now records that Pause is offered as an Apple Home automation action, but a Matter vacuum cannot be an automation trigger (#3, thanks to @pponce).

## 3.5.0

- **New Home app switches for Return to Dock, Pause and Find**, so automations can send a robot home, which Apple Home does not offer for a Matter vacuum (#3, thanks to @pponce).
- Off by default, per robot and per action, and momentary; no re-pairing needed, but the Homebridge bridge itself must be paired before the switches appear.
- README corrected: Apple Home automations can already start a clean, whole home or chosen rooms, and stop one; only sending the robot to its dock is missing.

## 3.4.19

- Docs only: the README no longer promises automations can dock a Matter vacuum, and no longer blames fault reporting for a tile stuck on "Updating…", which was a stale pairing.

## 3.4.18

- A robot dropping off the Roborock cloud no longer fills the log with stack traces on every poll; it now logs one warning, then a summary of suppressed repeats.

## 3.4.17

- Installing the package no longer triggers a build, which failed for git installs and made npm 11.16+ print `npm warn allow-scripts` for this plugin. No plugin behaviour changes.

## 3.4.16

- The clean mode shown on the Home tile is now applied before every clean started from Apple Home, so an untouched Vacuum selection no longer lets the robot mop (#8).

## 3.4.15

- The chosen clean mode no longer times out before the clean starts (`prep timed out after 2500 ms`); commands stop waiting on a slow status read (#8, thanks to @skmzwanke).

## 3.4.14

- Fixed vacuum-only room cleans that still mopped because the start command overtook the mode command; mode setup now fits its time window, Q7 robots included (thanks to @skmzwanke).

## 3.4.13

- Cleanup with no behaviour change: unused translations and dead code removed, and false claims fixed, including a startup line promising a HomeKit accessory that no longer exists.

## 3.4.12

- Suction or clean-type changes made in the Roborock app or by SmartPlan now reach Apple Home; live updates carrying only that change were being discarded.

## 3.4.11

- Robots using `enableFanPowerCleanModes` no longer flip their Apple Home clean mode to plain Vacuum and back; an unreadable suction level now leaves the shown mode unchanged.

## 3.4.10

- Diagnostics only: the Q7 position used for live-room tracking proved to be a constant, so the room-miss log line now surveys the map data to locate the real position.

## 3.4.9

- Diagnostics only: when live-room tracking cannot place a robot, the log now shows where the map's rooms lie, to explain Q7 positions far outside the map.

## 3.4.8

- Choosing Vacuum no longer mops: a timed-out suction command could stop the water-off command being sent; it now goes first, and a partial apply logs a warning (#8, thanks to @skmzwanke).

## 3.4.7

- The diagnostics report no longer tells Q7 owners their robot failed to reach the LAN; these models are cloud-only by design and now show `Cloud control (this model)` (#7, thanks to @jawnlydon).

## 3.4.6

- Trying cloud-only mode no longer leaves a robot marked "Cloud only" after it is switched off, and the diagnostics report now quotes the saved setting (#7, thanks to @jawnlydon).

## 3.4.5

- The `Matter publish for` log line now appears on every change, not only when the battery changed, so Apple Home display problems show up in the log (#8, thanks to @skmzwanke).
- The battery resync line no longer claims to force an update; a frozen battery percentage in Apple Home is an Apple-side gap no plugin can work around.

## 3.4.4

- Nine Saros 10 status fields are now recognised, so its log no longer asks the owner to report them (#8, thanks to @skmzwanke).

## 3.4.3

- Robots without a model profile, such as the Saros 10 and Qrevo CurvX, now report unknown status fields once per robot instead of an `Unsupported attribute` warning every poll (#8, #6).
- 12 more log lines, including the device-offline line, now name the robot instead of a raw device ID.

## 3.4.2

- Q7-series robots no longer log unsupported-method notices on every restart for requests like `get_water_box_custom_mode`; the plugin stops asking them for things they cannot answer.

## 3.4.1

- **Matter fault details are withdrawn**: Apple Home never showed them and they could stick the tile on "Updating…"; Show Dock & Tank Warnings as Errors is gone (#5, thanks to @Wazza151).
- Report Faults in Apple Home still shows a genuinely halted robot as Error, and the diagnostics report now reflects saved settings rather than unsaved checkboxes.

## 3.4.0

- **If you turned on Report Faults in 3.3.0, update**: it could leave the Apple Home tile stuck on "Updating…"; faults are now only published alongside the Error state.
- Dock and tank warnings moved to a new opt-in setting, Show Dock & Tank Warnings as Errors, which may stop Apple Home starting the robot (removed again in 3.4.1).
- Robot faults such as stuck, blocked brush or wheel, missing dust bin, flat battery or unreachable dock work as before.

## 3.3.2

- Finished 3.3.1's work: 11 more log lines, including the battery resync line, now name the robot instead of a raw device ID.

## 3.3.1

- Clearer logs: a live-room miss now says which of four problems occurred instead of always "between rooms", and more lines name the robot instead of a raw device ID.
- The diagnostics report now lists which Apple Home features are switched on.

## 3.3.0

- **New setting: Report faults in Apple Home** (off by default): a stuck robot, missing dust bin or flat battery now shows as Error instead of Ready (#5, requested by @Wazza151).
- Dock and tank conditions, such as an empty clean-water tank, were sent as a fault without forcing Error; this part was withdrawn in 3.4.1 because Apple Home never showed it.
- Diagnostics now always keep fault fields such as `dock_error_status` instead of truncating them away.

## 3.2.0

- On Q7-series robots, the first room of a clean now appears in Apple Home as soon as the robot is seen cleaning, instead of up to minutes later.
- When a robot cannot place itself in any room, the log now says so with a count instead of staying silent.

## 3.1.1

- The settings page checkbox now reads Dock & Returning status, matching 3.1.0's rename, and explains that Emptying and Washing show only while the dock does them.

## 3.1.0

- **Emptying the dust bin and Washing the mop now reach Apple Home**; the setting is renamed Dock & Returning Status, still opt-in and needs one re-pair (#5).
- Changing suction in the Roborock app no longer makes a cleaning robot show as charging (#6), robots no longer borrow each other's features, and LAN control recovers on its own.
- Security: the cloud session and LAN keys are no longer world-readable, Logout really logs out, and diagnostics no longer leak your Wi-Fi name or robot MAC.

## 3.0.2

- Fixed two ways Homebridge could crash (a stray LAN packet, and the startup watchdog when the network comes up late) and a cloud hiccup at startup unregistering every robot.
- Cloud commands no longer report failure after succeeding, LAN discovery and Q7 clean mode and suction work for the first time, and dry-only robots no longer offer mop modes.

## 3.0.1

- Startup now really takes about 2 seconds instead of 6 to 7, and the first cloud request no longer fails on a cold start.

## 3.0.0

- Faster restarts: device setup no longer waits for LAN discovery, and several robots start at once instead of one by one (the real time saving landed in 3.0.1).
- The periodic status refresh for S/Q-series robots, which had never run, now works, so a missed live update corrects itself within a minute; idle CPU use also drops.
- Security: resolved a high-severity advisory in the `ip-address` dependency; `npm audit` reports zero vulnerabilities.

## 2.9.9 and earlier

- **2.5.0–2.9.9:** suction levels in the mode list (2.6.0), shown with Apple's own names (2.8.1) and following the Roborock app (2.8.0); live room tracking for classic robots and Max+ on the Q7 (2.7.0); robots that refuse a request are no longer asked again (2.5.0); Verified by Homebridge, with a Donate button (2.9.3); faster startup and room lookups (2.9.1–2.9.5); the clean mode of a clean started outside Apple Home (2.9.9).
- **2.1.1–2.4.2:** live room tracking for the Q7 (2.4.0), room-by-room progress in Apple Home (2.1.2, 2.3.1), progress kept across restarts (2.2.0), all known dependency vulnerabilities resolved and unused dependencies removed (2.3.2), and a failed login can no longer crash Homebridge (2.4.2).
- **2.1.0:** the first public release as homebridge-roborock-matter. Matter only, one native Matter vacuum per robot, full Q7 (B01) support built against python-roborock, and a new settings page. The 2.0.0-matter pre-releases led up to it.
- **1.4.67-hardened.1–6:** unofficial hardening builds on upstream 1.4.66: startup guards, a device list with per-robot on/off in the settings, and the Charging/Docked option.
- **1.0.0–1.4.66:** [homebridge-roborock-vacuum2](https://github.com/applemanj/homebridge-roborock-vacuum2) by Joshua Appleman, which this plugin is forked from.
