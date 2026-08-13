# Changelog

## 3.6.1

**Two of 3.6.0's own log fixes did not survive contact with my server.**

The per-model poll-profile line still printed twice for two robots of the same model. 3.6.0 moved the dedupe key from the duid to the rendered line — and then interpolated the robot's name into that line, which made the key per-robot again. The key is now the model-derived sentence alone and the robot is named after the key is taken.

The `Loading accessory 'X' from cache.` demotion was lost to a batch edit that failed on its second replacement and wrote neither. Its Matter twin shipped at debug; this one shipped at info.

Both are pinned by rules rather than by the two lines: the dedupe key must carry no robot identity, and the emitted line must still name one.

## 3.6.0

**A full pass over the log and the settings page. No new features; a lot of things that were quietly wrong.**

The settings page had four defects with the same shape — the form and the saved config disagreed and nobody was told:

- **A brand-new install wrote `false` for the four features that default to on.** Every checkbox was initialised inside `loadConfig`'s `else` branch, so a plugin that had never been configured skipped the lot, and the first keystroke in the email field auto-saved nine unchecked boxes. Absent means on and `false` means off, so a first-time user silently disabled room selection, clean mode, battery and live room tracking. Three of those are re-pair settings.
- **The cleartext password went back into `config.json` after a 2FA login.** The password path clears the field; the token path only hid the row, and a hidden input keeps its value, so the next auto-save of anything wrote it back.
- **Ticking "add the switches" and pressing Save published nothing.** It saved `homeKitActionSwitches: []`, and an empty array is an array, so the plugin's fallback to `["dock"]` never fired. The user then went hunting for the QR code the page had just told them to scan.
- **The pairing callout flashed on every page load** and stayed up permanently if the config failed to load, because its initial state lived only in a callback.

Also on that page: saves report failure instead of looking like they worked, the three settings that do nothing without a prerequisite are greyed out until it is on, a clamped number is written back into the field instead of showing the rejected value, the Devices list no longer races the skip list, and the Google Fonts import is gone — a render-blocking request to Google from a local admin page that stalled the whole settings page on an offline Homebridge box.

**The log.** Two lines were removed as duplicates: the poll-profile notice was keyed per robot while its text is per model, so two robots of one model printed the same sentence twice, naming neither; and every room change was announced by both the library and the Matter layer with the same prefix. `Service started` was printed on the failure path — the `getHomeDetail` catch falls through to the same callback — directly under the stack trace saying it had failed; it now says what actually happened. That stack trace is gone too: a Roborock outage or a DNS blip is a warning with a sentence, not an error with a Node stack. `Starting adapter. This might take a few minutes` (it takes one second) and `Lets go!!!!!!!` are gone with the rest of the ioBroker vocabulary, `Adapter not inited. Command not executed.` now names the robot and says to try again in a few seconds, and a robot going offline is a warning that says what to check — with the matching "back online" line uncommented after who knows how long.

**Fourteen more log lines were printing a raw 22-character duid to users.** `log-lines-name-the-robot` only inspected template literals written inside the logging call, so anything built into a variable or an `Error` first was invisible — it was checking 39 of 59 calls in one file alone. It now follows the three laundering channels as well, and everything it found is fixed.

**One resource leak.** `localConnector.js` opened its UDP discovery socket at module load, so requiring the file bound a socket a cloud-only install never uses, a second discovery pass attached a second set of handlers to it, and the first pass's `close()` left it unbindable for the next. It is now created per run and closed once. That also removes the "A worker process has failed to exit gracefully" warning the suite has printed for months, which was masking any real leak.

**And one coupling that broke while I was fixing the wording.** The transient-error classifier read the reason out of the refusal message with a regex, so making those messages readable turned a calm transport condition back into an error with a stack trace once per poll. Refusals now carry the reason as a code on the error and the prose is free to change.

688 tests, up from 672.

## 3.5.4

**3.5.3's log line named the wrong bridge on exactly the setup it was written for.** It read `_bridge` off the platform config, and Homebridge's `childBridgeFork` deletes that key before a plugin loads — "some plugins do not like unknown config". So on a child bridge it fell through to the main-bridge branch and pointed at the status page QR code: the wrong instruction, in the release about giving the right one. My own server printed it four minutes after publish.

The block is now read from `config.json`, from the platform entry matching this one. Anything unreadable — missing file, bad JSON, no matching block — falls through to a line that covers both bridges rather than asserting one, because a confident wrong answer is the thing being fixed. Three branches, one shared set of strings, so a later edit cannot correct one and leave two.

Verified red against 3.5.3: 3 of 29 fail, exactly the disk-read and fallback rules.

## 3.5.3

**Turning the switches on registered them, logged them, and showed nothing in Apple Home.** My child bridge carried `hap: { enabled: false }` — reasonable for a Matter-only setup, since this plugin published nothing over HAP before 3.5.0. In that state the switches exist inside Homebridge and are advertised to nobody, and no QR code helps until HAP is switched back on.

3.5.0 mentioned pairing in one sentence, and the sentence was wrong: it assumed the bridge needed pairing, not enabling.

The startup log now answers which of three situations you are in, once per start, and warns rather than informs when HAP is off — an info line about a feature that cannot work reads like the ninety other info lines a start produces. The settings page shows the steps under the toggle when the feature is on, and the README and the setting's own description carry the same three: **Plugins → homebridge-roborock-matter → ⋮ → Child Bridge Config**, check **Enable HAP**, restart, then **Connect to HomeKit** on that screen and scan that QR code. All four surfaces name the two codes that look right and are not — the main Homebridge code, and the robot's Matter code, which covers the vacuum only.

`__tests__/the-switches-say-which-qr-code-to-scan.test.js` enumerates the rule over the surfaces, because the original failure was that only one surface mentioned pairing at all. Matching ignores markup, so `<strong>` and `**bold**` count as the same instruction. Verified red against 3.5.2: 26 of 26 fail.

## 3.5.2

**Apple Home showed a clean mode nobody asked for for the first minute or two of every vacuum-only clean started from Home.** The clean itself was always correct; only the tile lied.

Measured in [#8](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/8) (skmzwanke, Saros 10, 12 August 2026) — 114 seconds of it:

```
16:09:20  Applying Vacuum mode to Weebo before starting.
16:09:20  ...acknowledged by Roborock in 791 ms via cloud
16:09:22  Matter publish for Weebo: ... runMode=1, cleanMode=0   <- what was asked for
16:09:29  Matter publish for Weebo: ... runMode=1, cleanMode=2   <- vacuum+mop
16:11:23  Matter publish for Weebo: ... runMode=1, cleanMode=0   <- the robot caught up
```

That `2` is derived from the robot's water-box level, which was still reporting its old value seven seconds after the robot had **acknowledged** the command to turn water off. So this is not the robot being slow and the plugin being right — the plugin contradicted itself. The prep path already documents that this exact reading lies in this exact window and refuses to consult it when deciding whether to send; the reporting path published the same reading as truth.

**The fix is about knowledge, not about the water box.** A clean type this plugin sent _and had acknowledged_ for the run in progress now outranks a clean type merely _derived_ from the robot's status, until the robot's own report agrees with it once. Same rule as 3.4.11: when the plugin does not know, it says nothing new rather than something untrue.

It is deliberately bounded, because a pin that outlived its run would break the feature it sits inside — a clean started in the Roborock app is supposed to be reported in the mode the robot is actually running:

- Released the moment the robot's own report agrees, so a clean type changed mid-run in the Roborock app is still followed.
- Released when the run it was applied for ends — but **not** before that run has been seen running, or a publish landing in the gap between the acknowledgement and the robot reporting it had started would have released it before it did anything.
- Dropped by an explicit Apple Home selection, and never taken at all when the apply failed: without an acknowledgement there is nothing known, and pinning an unconfirmed intent would hide a real failure.
- The disagreement is reported **once per run on warn**, not silently and not once per publish. A robot that acknowledges the command and then ignores it is a different and worse fault than a robot that lags, and the log is the only way to tell them apart without debug logging on.

The clean-type family reduction (a suction-level mode is a vacuum-family variant) was written out by hand in the settings builder and was needed in a second place for this. It is now one helper called from both, and a test counts the copies — two hand-written copies of one fact drifting apart is the most repeated defect in this codebase.

`__tests__/applied-clean-type-outranks-a-lagging-robot-report.test.js` (20 tests). **Verified red against untouched 3.5.1: 16 of 20 fail**, and the symptom test fails with the symptom itself — `Expected: 0, Received: 2`, exactly the 16:09:29 publish. The 4 that pass in both are the no-regression guards.

## 3.5.1

**The README shipped saying two things were unverified, eight minutes after they had been verified.** No behaviour changes in this release.

pponce finished the survey in [#3](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/3) while 3.5.0 was being published: **pausing** a running clean _is_ offered as an automation action, and a Matter vacuum is **not** offered as an automation _trigger_ at all — the vacuum cannot be selected when setting a trigger, only when choosing an action. The page that went out with 3.5.0 still called both of those unmeasured.

The trigger finding is the one worth reading twice. It means "when the robot finishes cleaning, do X" cannot be built in Apple Home today — and the switches added in 3.5.0 do not change it, because they are inputs an automation turns on, not accessories that report what the robot is doing. Something read-only would be needed for that. It is on the roadmap as a question, not a plan, because the right shape depends on what people actually want to automate on.

`__tests__/readme-claims-match-what-was-measured.test.js` is now driven by one registry of findings instead of a constant per finding, and that is the real fix. The same drift has now happened twice in three days, both times because a measurement landed, one sentence was corrected, and a second sentence about the same fact was left behind. Each row carries the command, the verdict, and — for an absent finding — the denial its own claim has to make. The rules then demand that every offered command is positively stated, every absent one is denied wherever the README pairs it with automations _and_ stated as absent at least once, every unmeasured one stays qualified, and no command sits in both lists — which is exactly the shape of the 3.5.0 miss. Verified red against the shipped 3.5.0 README: 2 of 20 fail.

## 3.5.0

**Apple Home cannot send a Matter vacuum to its dock from an automation, so the plugin now offers a switch that can.** The measurement is pponce's, in [#3](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/3): the commands all work from the tile and from Siri, but "send the vacuum to its dock" is not on Apple's list of automation actions for a Matter vacuum, and he moved that part of his setup to a HAP-based plugin rather than go without it. 3.4.19 stopped the README from promising what could not be delivered. This release delivers it.

Turning on **Add Home app switches for Dock, Pause and Find** publishes one plain HomeKit switch per robot per action you select — `Vicky Return to Dock`, `Vicky Pause`, `Vicky Find`. A switch is an automation action everywhere, so the schedule that could not reach the tile can reach the switch. Each one is momentary: it turns itself off again 1.5 s after it is pressed, because there is no docking state worth mirroring and a second state machine racing the same laggy Roborock snapshot is exactly what issues #4 and #12 were about.

**The press takes the existing command path rather than a second one.** It routes into the same `returnToDock` / `pauseCleaning` / `identifyVacuum` the Matter cluster handlers use, so it inherits the acknowledgement wait and timing log (#12), the decision to forward a command the cached snapshot claims is unnecessary (#4), the retry when Roborock times out while the robot is still cleaning, and the optimistic cluster write that moves the tile so a robot driving home does not read Ready. The log now names the surface that asked: `Sending Vicky back to dock from the Home switch.` next to `Sending Vicky back to dock from Matter.` — the first question when a schedule misfires is which one sent it.

Three things this had to get right that are not in the feature description:

- **The Matter-only sweep would have deleted them.** `discoverDevices()` has always unregistered every cached HAP accessory without looking at what it was, which was correct while this plugin registered none. A switch shipped against that rule would work until the first restart and then vanish out of every automation using it, while the log went on calling it a legacy accessory. The sweep now partitions on a context marker written into the accessory — not on its name, which is editable in the Home app.
- **They are registered under the real package name.** `PLUGIN_NAME` has never matched package.json, and Homebridge stores whatever it is given as the accessory's owning plugin. On restore it falls back to searching by dynamic platform name, which repairs the mismatch with an alarming log line — and throws when two plugins claim the same platform name, at which point the accessory is called orphaned and removed. Matter keeps its own cache and cannot be moved without forcing every user to re-pair, so the correct identifier is introduced for HAP only.
- **An empty device list does not remove anything.** The same trap `unregisterStaleMatterAccessories` documents: a failed startup arrives at discovery as "the account has no robots". Removing a switch because the config no longer asks for it is safe; removing one because the Roborock cloud had a bad minute is not.

Off by default, per robot per action, and the Find switch is only published for robots that report `find_me` at all. No re-pairing is needed to add or remove them — they are HomeKit accessories and arrive over the Homebridge bridge, which does mean a user who has only ever paired the Matter robot has to pair the bridge itself before they appear. The robot stays a Matter vacuum and is untouched.

`__tests__/action-switches-survive-the-legacy-sweep.test.js` enumerates the partition over context shapes rather than the two cases I happened to think of, `__tests__/action-switches-are-an-opt-in.test.js` covers the config and removal rules, and `__tests__/action-switch-press-uses-the-matter-command-path.test.js` pins that a press reaches Roborock through the shared path and is named apart from Matter in the log. Verified red: 4 of 8 fail with the old sweep restored, and the empty-device-list rule fails 1 of 17 with the guard removed.

**And the gap turns out to be narrower than this release was written to believe.** pponce went back into Shortcuts after the above was written and measured the rest of the list ([#3](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/3)): **starting a clean is offered as an automation action — whole home or a chosen set of rooms — and so is stopping one that is already running.** Only return-to-dock is missing. So an Apple Home schedule could already do the two things schedules are mostly built for, and the switches are for the one thing it could not: ending a clean early and sending the robot home. The README said "whether it offers the other commands as actions … has not been verified here", which was true the day it was written and false the day after — the same defect as a promise nobody checked, pointed the other way, and more expensive here, because it sends a user off to install a second plugin for a job this one never blocked. The feature table also claimed Apple offers no automation action for Pause and Find either; nobody has measured those, and it no longer says so. `readme-claims-match-what-was-measured.test.js` now enumerates both directions — the dock claim must deny itself in its own words, the two measured-present actions must be stated, and pause/resume/trigger must stay qualified. **Verified red against this release's own README: 3 of 10 failed, exactly the three positive claims.**

## 3.4.19

**Two things the README told users were not what had been measured.** No behaviour changes in this release; both are wording, and wording is what people choose a plugin on.

The feature table promised control "from the Home app, Siri, or automations". Nobody had ever checked the last word, and a user has now measured it: Apple Home does **not** offer sending a Matter vacuum to its dock as an automation action, which is why he had to move that part of his setup to a HAP-based plugin. The table no longer claims it, and a new [Automations in Apple Home](README.md#automations-in-apple-home) section says exactly what is known — the commands all work from the tile and from Siri, one automation action has been measured absent, and the rest is unverified rather than promised.

The fault-reporting section also blamed the "Report faults in Apple Home" setting for a tile that got stuck on "Updating…". A controlled test on the same robot, with fault reporting and dock-fault escalation both switched on and a genuinely empty clean-water tank, has now shown the tile staying in Ready throughout: the wedge was a stale pairing from an earlier install, which the Troubleshooting section already explained. The correction is written into the section rather than quietly deleted, because someone may have left the feature off on the strength of it. The same test also confirms the main finding more strongly than before — the fault was published beside a full Matter **Error** state this time, not just beside Charging, and Apple Home still drew nothing.

## 3.4.18

**A robot that drops off the Roborock cloud filled the log with stack traces about the plugin correctly deciding not to send.** When the transport a request would need is not there — the robot is marked offline, MQTT is down, or the local socket is not connected — the request queue declines to put it on the wire. That is a deliberate, calm decision, and it writes its own debug line where it happens. But the rejection then arrived at the error handler unclassified, so it was logged as a plugin error, with a full stack trace, once per poll, for as long as the condition lasted.

The shape it takes in a real log: a robot goes offline at 3:28 AM, and a single poll cycle produces six stack-traced errors in the same second, followed by one a minute after that. Nothing is wrong with the plugin in any of them.

These three refusals now go through the same throttle the request timeouts have always used: one warning, then a suppressed-count summary when the window reopens. Each reason keeps its own bucket, so a robot being offline does not silence the reporting of a separate MQTT outage. Errors that are genuinely the plugin's fault — including its failure to build a request at all — are untouched and still log with their stack.

`__tests__/refused-sends-are-not-plugin-errors.test.js` enumerates the rule over the source rather than over the three messages that were reported: every message the request queue can reject with must be one the classifier recognises, so a refusal path added later fails the test until it is classified. Verified red against 3.4.17: 10 of 15 failed.

## 3.4.17

**Installing this package asked npm to build it, and that build could only ever fail or warn.** `dist/` is in the published tarball and `main` points into it, so nothing a user installs needs compiling — but package.json still carried `"prepare": "npm run build"`, a hook npm runs at install time. The two things it could do to a user, both measured:

- **Fail.** Installing straight from the git repository clones the package to a temp directory and runs `prepare` there. The internal dependency install inherits `-g` and `--prefix` from the outer command, so the clone is left with no `node_modules` at all, and the build dies with `sh: rimraf: command not found` / `code 127`. Reproduced line by line from npm's own debug log; not fixable from this side, which is why prebuilt tarballs are now the way to install anything that is not on npm.
- **Warn.** npm 11.16 and later will not run install scripts it has not been told to trust, and prints `npm warn allow-scripts homebridge-roborock-matter (prepare: npm run build)` for a tarball install — a supply-chain warning naming this package, for a build that did not need to happen. It cost a tester a round trip before it cost anyone else anything.

The build now runs on `prepack` instead, so packing or publishing still cannot produce a tarball without `dist`, while installing one asks for nothing. No behaviour in the plugin changes.

`__tests__/installing-the-package-runs-no-build.test.js` holds both halves of the rule: package.json may declare none of npm's install-time lifecycle scripts, and a packing script must perform the build. Dropping the hook without moving the build is the obvious way to get this wrong, so both are enumerated rather than assumed. Verified red against 3.4.16: 3 of 13 failed.

## 3.4.16

**The clean mode shown on the tile is now applied before every Matter-initiated start, changed or not.** The prep that applied it only ran when Apple Home sent a `ChangeToMode` command — and Home only sends that when the selection actually changes. So the most ordinary case of all went unhandled: the mode Home already displays is usually the mode the user wants, so they never tap it, nothing was sent, and the robot ran in whatever mode it had been left in.

Measured end to end in #8: a "Vacuum" start with no preceding mode request produced no `Applying ... mode` line at all and the robot mopped, while the very same start one explicit tap later sent it and vacuumed. It is deliberately not skipped when the robot looks like it already matches, because that reading is the one that lies. The user's levels are preserved — only the clean _type_ is pinned.

`__tests__/every-matter-start-applies-the-displayed-clean-mode.test.js` holds the rule over the source: every start dispatch must apply the mode, and stop/pause must not. Verified red against 3.4.15: 8 of 16 failed.

## 3.4.15

**The clean-mode prep was never losing its window to the commands it sends. It was losing it to a read nobody was waiting for.** skmzwanke's log from 3.4.14 (#8) has the whole thing in ten seconds:

```
1:09:11  Applying Vacuum + Mop mode to Weebo before starting.
1:09:13  Unable to apply Vacuum + Mop mode ...; prep timed out after 2500 ms.
1:09:13  Matter service area clean command ... acknowledged in 2589 ms via cloud
1:09:21  Roborock did not confirm the water mode and suction level for Weebo
```

The water command was acknowledged over the cloud in about a tenth of a second. The report of its failure arrived eight seconds after the clean had already started — ten seconds after the prep began, which is the transport's default timeout and nothing else in this codebase.

After every `set_*` command, `vacuum.command` awaited the paired `get_*` to refresh this plugin's own state cache. That read was issued **with no options at all**: not the caller's transport, so it went out over the LAN of a user who has `preferCloudForMatterCommands` on and whose LAN times out every request at ten seconds; and not the caller's timeout, so it ignored the 2500 ms budget the two previous releases went to such lengths to compute. The window was spent before the fallback water command — the one that would have worked — ever got its turn.

- **A command is finished when the robot acknowledges it.** The state refresh that follows is bookkeeping: it is no longer awaited, it can no longer fail the command, and it can no longer delay one.
- **It inherits the caller's transport, never the caller's deadline.** A caller that asked for cloud does not get a local request it never asked for.
- **`getParameter` now carries the caller's options on every branch.** Only the `get_status` branch did, by hand; every other one silently reverted to the local transport and the ten-second default.
- **One place decides which options travel with a request.** Two hand-kept copies of that list is what let the refresh drift away from the command that triggered it.
- **A command with no `set` in its name is no longer re-sent to the robot as its own "refresh"** — `parameter.replace("set", "get")` returns the command unchanged for those.

`__tests__/command-refresh-stays-out-of-the-callers-budget.test.js` holds the rule over the source — no request issued on a caller's behalf may bypass the one option-carrying helper — and reproduces #8 end to end through the real `vacuum` class. Verified red against 3.4.14: 9 of 11 failed, the command took 3041 ms instead of resolving on its acknowledgement, and the fallback water command was never sent at all.

**Note for anyone reading the older prep tests:** they stub `api.vacuums[duid].command` wholesale. That is exactly why ten seconds could hide inside it for two releases. This one does not.

## 3.4.14

**A "vacuum only" room clean could still mop, because the command carrying that choice was started inside the prep window but not finished inside it.** 3.4.8 fixed the ordering — the water command goes first and no failure cancels a later command — and skmzwanke's log from the fixed version shows why ordering alone was not enough:

```
9:44:57  Applying Vacuum mode to Weebo before starting.
9:45:00  Unable to apply Vacuum mode to Weebo before starting; continuing with
         the start command. Matter clean mode prep timed out after 2500 ms.
9:45:00  Matter service area clean command for Weebo was acknowledged ...
```

The prep sequence sends up to three commands one after another, each with a two-second timeout, inside a window of 2500 ms that the caller races the whole sequence against before sending the start command. Three seconds of commands do not fit in two and a half. So the command carrying his "vacuum only" choice was merely _in flight_ when the window closed, the start command overtook it, and his Saros 10 mopped the room he had asked to be vacuumed — the same outcome as before the fix, arrived at by the clock instead of by an early return.

- **Each command is now sized against what is left of the window**, not given a fixed timeout. The command that carries the user's clean mode goes first and gets the window; a cosmetic one that no longer fits is reported rather than started. The sequence ends by itself instead of being cut off mid-command.
- **A command is never sent with a non-positive timeout.** Below the prep, a timeout of zero or less is not an override — it silently restores the transport's own ten-second default, four times the whole window.
- **Every way the prep can end without the robot having confirmed the selected mode now reports at warn, from one place.** One of those ways was debug-only: when the plugin believes water is controllable — so Apple Home is offering "Vacuum" and "Vacuum and mop" — but has no water command left to send, the mop ran anyway and nothing above debug said so.
- **The Q7/B01 branch was silent about all of this** and now reports the same way. Its clean type is the same kind of command and it had the same arithmetic problem.

`__tests__/clean-mode-prep-fits-its-window.test.js` holds the rule over both dialects: no command may be started that cannot finish inside the window the caller is waiting on, and the window is handed down from the one constant that defines it rather than restated. Verified red against 3.4.13, where the suction command is started at t=2000 with a two-second timeout while the start command goes out at t=2500.

## 3.4.13

**Nothing in this release changes what the plugin does. It removes things that were never doing anything, and two of them were actively lying.**

- **Ten of the eleven shipped languages could never load.** `this.language` is only ever set from `options.language`; the sole production construction site passes none, the UI server hardcodes `"en"`, and no setting exposes the choice. So de, es, fr, it, nl, pl, pt, ru, uk and zh-cn — 78 KB of translations — were installed on every user's disk and read by nobody. They are gone. A test now enumerates the rule rather than the ten filenames: **a locale that ships must be selectable**, so adding one back fails until there is actually a way to pick it.
- **The README claimed 463 automated tests in one paragraph and 263 in another.** Both were wrong. Two hand-written numbers describing one fact will drift apart and neither gets corrected, because nothing checks them. There is one number now, and a test checks it against what the suite actually declares. It deliberately does not pin an exact figure — `test.each` expands at runtime and no static reader can know by how much — it pins the two things that went wrong: state it once, and keep it in a defensible band.
- **The publish log line still rendered `fault=…` from an attribute withdrawn in 3.4.1.** The branch was unreachable, and worse, it read as evidence the feature still existed. Removing it settles a real contradiction: `matter-fault-reporting.test.js` pinned that `operationalError` is never published, while `matter-publish-line-logs-every-change.test.js` hand-built one and asserted it rendered. Two tests disagreeing about whether a feature exists is worse than either answer.
- **An orphaned ioBroker map viewer and a MITM sniffing script** (`roborockLib/lib/map/`, `roborockLib/lib/sniffing/`) were excluded from the npm package rather than deleted — which is exactly how they survived unreviewed for so long. Ignored by the package, invisible in review, referenced by nothing.
- **Ten functions whose definition was their only occurrence in the entire tree** are gone: `getHomeID`, `decodeSniffedMessage`, `getConnector`, `updateDataExtraData`, `setupBasicObjects`, `getCleanSummary`, `resolve102Message`, `resolve301Message`, `BytesToInt`, `getErrorCodeDescription`, plus the unused `B01_REQUEST_DPS`/`B01_RESPONSE_DPS` constants and three exports nothing imported. `resolveLiveRoomId` went too — a one-line wrapper over `describeLiveRoomResolution` with no production callers, kept alive only by tests. Two ways to ask the same question is how one of them drifts.
- **`errorCodes` was NOT removed**, though a first pass called it dead. `deviceFeatures.js` still uses the table for its `error_code` state mapping. Worth recording: the check that catches this is grepping the whole tree, not reasoning about one file.
- **Two user-facing claims were false.** The `preferCloudForMatterCommands` setting promised to keep "the legacy HomeKit accessories unchanged", and a startup log line told users "The existing HomeKit accessory will continue to work." This fork removed every HAP accessory by design — there is nothing to fall back to. The log line now says what to actually do: enable Matter for the bridge.
- **ROADMAP.md was eight releases stale**, still titled for a different package, pointing at an `AGENTS.md` that has never existed in the tree, and listing HomeKit controls as delivered features thirteen lines above its own note that all HAP accessories were removed. Rewritten, with the pre-Matter-only entries labelled rather than deleted so the history stays readable.

## 3.4.12

**A live frame whose only field was the suction level or the clean type was thrown away before anything could read it.** A live message passes two checks on its way to Apple Home: a gate that decides whether it is a status message at all, and a check in the publish path that decides whether anything meaningful arrived. Both named their fields by hand, and they had drifted apart — the publish path was taught that a frame carrying only `fan_power` or only `matter_clean_type` counts (a suction or mop-mode change made in the Roborock app, or picked by SmartPlan, pushes exactly that), while the gate one level below still listed five of the seven fields and discarded such a frame before the publish path ever ran.

- **Both checks now derive from one list.** Adding a field the publish path reads covers the gate in the same edit, so the two cannot drift again.
- **A frame carrying no meaningful field is still ignored**, so this widens the gate exactly as far as the publish path can actually use and no further.

The fix that added the two fields was made one level down from the gatekeeper, which is why it looked complete and was not. `__tests__/live-status-gate-matches-what-the-publish-reads.test.js` pins the rule over the source rather than the two field names, so a field added later is covered the moment it is read.

## 3.4.11

**Two docked Q7s flipped their Apple Home clean mode to "Vacuum" and back every ninety seconds, and the plugin was reporting a level it had never measured.** Caught in a log from a plugin author's own robots on 3.4.10: every battery tick produced a pair of publishes about a second apart, the first saying `cleanMode=0` and the second saying `cleanMode=6` — ten pairs in fourteen minutes, on both robots, at the same battery value.

Mode 6 is "Max Vacuum", the level the robot is actually set to. Mode 0 is plain "Vacuum", a level nobody selected. When suction-level clean modes are announced (`enableFanPowerCleanModes`), the reported mode is derived from the robot's live fan power — but the derivation had no answer for "the fan power cannot be read right now". It fell through to the last Matter selection, which defaults to plain Vacuum, so a momentary gap in the reading was published as a definite statement about the robot's suction level.

- **An unreadable fan power now leaves the reported level unchanged.** Saying nothing new beats saying something untrue. This covers a value that reads fine but is not one of the announced levels (such as 105, "fan off") as well as no value at all — in both cases the plugin does not know which announced level to report, and inventing one is the defect.
- **An explicit Apple Home selection still wins immediately.** Choosing a mode discards the remembered level, so a user's choice is never shadowed by what the robot said before they made it — including a deliberate choice of plain Vacuum.
- **A robot whose fan power has never been readable is unaffected**, and so is any robot that does not announce suction levels.

This is the same class of defect as 3.4.6 and 3.4.7: reporting a value derived from missing data as though it had been measured. What makes the fan power intermittently unreadable on these robots is a separate question and is not answered here — but the reported mode no longer depends on the answer.

## 3.4.10

**The Q7 position that never resolved to a room is not a position at all.** 3.4.9 asked the two Q7s to report the range their room outlines occupy, and they answered: Garage sat in a map spanning cells 52–171 by 43–187, 1. Sal in one spanning 38–293 by 90–227. Back-computing through each map's own origin and resolution gives the same coordinate for both — exactly (1100.0, 1100.0), on two robots, two maps, and twelve minutes of active cleaning. A number that identical is arithmetic, not a place a robot stood, which means live-room tracking on these models has never worked from that field.

- **The miss line now surveys the payload rather than asserting anything about it.** It prints the size of every top-level field and every scalar inside the small ones, keyed by field path. Two consecutive lines are then a diff: the value that changed while the robot was driving is the position, and the submessage that grew is the trail behind it.
- **Varints are surveyed, not just floats.** The pose message carries an `update` flag alongside its coordinates, so a float-only dump would have printed two plausible-looking numbers and hidden the field saying they were stale.
- **The survey descends one level.** A pose trail's last point is by construction where the robot is now, and repeated paths overwrite, so the end of a trail lands in the log under a stable key.
- **A bare scalar on the map itself is now visible.** The parse loop only ever descended into submessages, so a position stored as a plain float would not have appeared anywhere.
- **It is bounded and it cannot throw.** The occupancy grid is measured rather than walked, the scalar count is capped, recursion is capped, and bytes that turn out not to be protobuf are swallowed. A diagnostic must never be the reason a robot stops reporting its room.

This changes no behaviour. It exists because guessing another field number would have been the third guess in a row on this code path, and the robots were running.

## 3.4.9

- **A live-room miss now says where the rooms actually are.** Two Q7s produced position cells around 22,000 while a Roborock map is a couple of thousand cells across at most — so those robots were never "between rooms", their computed position was nowhere near the map. One of them reported x exactly equal to y, which is arithmetic rather than a place a robot stood. The position on its own cannot separate a unit mismatch from a wrong origin, so the miss line now carries the range the room outlines occupy plus the map origin and resolution the transform used. This changes no behaviour; it turns the next log from a hypothesis into a measurement. The bounding box is computed only on the failure path, so a run that resolves every position pays nothing.

## 3.4.8

**Selecting "Vacuum" and getting a vacuum-and-mop was not a display bug — one timed-out command cancelled the one that mattered.** skmzwanke reported in [#8](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/8) that he selected Vacuum for a single room and the robot mopped it anyway, and his 3.4.5 log names the cause outright.

On a v1 robot the difference between "Vacuum" and "Vacuum and mop" **is** the water-box mode: choosing Vacuum sends water-box OFF. Fan power only picks a suction level within the chosen mode. The prep sequence sent fan power first and, if that command timed out, returned — so the water command was never sent at all. In his log, `set_custom_mode` timed out after two seconds, `set_water_box_custom_mode` never appeared, and the robot kept the mopping setting it already had from the Roborock app. A cosmetic command that did not answer in time cancelled the one carrying the user's actual choice.

- **The water command now goes out first, and no command in the sequence is cancelled by another's failure.** Dropping the early return cannot delay the start: the caller already races the whole prep against its own timeout, so the early return was buying latency protection that was paid for one level up.
- **A partial apply is now announced at warn level**, naming the robot and what was not confirmed. It was a debug line before, which meant that on a default log level the robot simply did the wrong job in silence while the Matter tile reported the mode that had been selected. That mismatch took two rounds of #8 to pin down.
- **The rule is enumerated over the sequence, not over the two commands in it today:** no clean-mode prep command may return out of the middle of the sequence. A third setting added later is covered by construction.

## 3.4.7

**The diagnostic report told Q7 owners their robot had tried to reach the LAN and failed. It never tried.** Following [#7](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/7), jawnlydon unpaired his robot from Apple Home, uninstalled the plugin, reinstalled it and paired fresh — and his report still read `markedRemote: true`, `remoteReason: marked-remote-after-connect-failure`, `connectionStatus: Cloud fallback`, "usually because LAN TCP was not connected at that moment". His `roborock.vacuum.sc05` speaks the B01 protocol, which has no LAN request surface at all: the plugin marks these robots cloud-only at startup precisely so it never opens a local socket to them. Every line above described a network fault that could not occur, and he spent an evening chasing it.

- **A robot marked remote now records why it was marked.** Membership of the remote set could tell the report _that_ a robot was on cloud transport but not _why_, and the report assumed the most common cause — a failed local TCP connect — for every member. The two causes have nothing in common: one is a protocol with no local side, the other is a genuine LAN failure worth investigating. Both reasons now travel with the mark, from the one place that sets it.
- **A future marking that forgets its reason degrades to "the vacuum is marked remote".** Uninformative, and deliberately so. Guessing the usual cause is what turned a design decision into a phantom network fault in the first place.
- **The device card no longer calls the only transport a fallback.** A B01/Q7 robot now reads `Cloud control (this model)` with a hint saying its protocol has no LAN control surface and that a blank local IP, discovery state and TCP state are expected. The LAN connection test stops telling its owner to wait for a discovery that is never coming, and the robot is no longer flagged as a likely cloud fallback. A robot on a LAN-capable model that really is falling back is still reported exactly as before.
- **The wording moved into plain JavaScript** (`roborockLib/lib/connectionState.js`), because the test job runs before any build and could therefore only grep the TypeScript UI server for these strings. They are not decoration — they are what an owner acts on when a robot will not respond — so they are now exercised directly.
- **The rule is enumerated over the source tree**, not over the two call sites that exist today: no code path may mark a robot remote without stating its reason. A hand-written list of call sites is the same mistake as a hand-written list of files or log lines.

## 3.4.6

**Trying cloud-only mode once marked a robot "Cloud only" forever.** jawnlydon reported in [#7](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/7) that a "Cloud Only" instance of his robot "seems to have stuck around through several re-pairs" — surviving a bridge restart, repeated Apple Home re-pairings, and a complete uninstall and reinstall of the plugin. It was not a leftover accessory. It was one stale field.

- **The markers cloud-only mode writes are now retracted when it is switched off.** Enabling the mode stamps a robot's transport diagnostics to say local transport is disabled, and those diagnostics are persisted. `tcpConnectionState` is only ever rewritten when a LAN connection is actually attempted — and none is attempted for a robot no local IP was discovered for — so for such a robot the marker stayed on disk permanently, outliving the setting that wrote it. Startup now reconciles the markers in both directions, clearing only the fields that still hold the marker value so a live LAN connection is never stomped.
- **The report stopped contradicting itself.** Reading that stale marker back, the device card said `connectionStatus: Cloud only` with the hint "Cloud-only mode is enabled, so local LAN discovery and local TCP control are disabled" — two lines under the same report's `cloudOnlyMode: disabled`. The report was pointing at a setting that was off, and it cost its reader an evening.
- **Setting and clearing derive from one table**, so a marker added later is retracted later. A hand-written list of fields to put back is the same mistake as a hand-written list of files or log lines, one level down — the lesson 3.4.3 and 3.4.5 each learned in their own layer.
- **`cloudOnlyMode` in the diagnostic report now quotes the saved config, not the checkbox.** The `matterFeatures` line was fixed for exactly this reason and the fix stopped at that line, leaving the line directly above it still reading its form control — so a report could state a setting the running plugin did not have. A test now enumerates the rule over the source: nothing the report builder reaches may read the settings form, except the helpers whose whole job is to warn that the form and the saved config disagree. Unsaved edits to cloud-only mode now raise that warning too.

## 3.4.5

**The one log line that exists to diagnose Apple Home display problems was hiding the transitions.** `Matter publish for <robot>: battery=…, operationalState=…, runMode=…, cleanMode=…` was added so an Apple Home display issue could be settled from a single log excerpt — and it was only ever emitted when the **battery** value changed. skmzwanke reported in [#8](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/8) that his Apple Home tile sat on "Traveling to Room"/"Preparing" for an entire cleaning run, and sent a log covering that whole run: every operational-state transition in it was invisible, because the line only appeared on the four polls where the battery happened to tick down. The log contained the answer and could not show it.

- **The line is now written whenever it would read differently from the last one written.** Not "on battery change", and not "on battery, state, run mode or clean mode change" either — a hand-written field list is the same failure mode as a hand-written line list, one level up (the lesson 3.4.3 learned about file lists). Comparing the rendered line means every value the line names triggers it by construction, including a value added to the message later.
- **It now covers every publish path.** The decision moved into the publish routine itself, so state changes arriving on a live MQTT frame are logged too, not only those seen by the periodic poll. A heartbeat's forced republish of unchanged values still says nothing, so the self-healing full write stays silent.
- **The battery resync line no longer claims something that is impossible.** It said it "forced a fresh Matter attribute report". `PowerSource.batPercentRemaining` carries the Matter "changes omitted" quality, and the specification is explicit that such an attribute "SHALL NOT have delta changes published as part of a Subscribe interaction"; matter.js closed the request to opt out of that as working-as-intended on 28 July 2026 ([matter.js#4163](https://github.com/project-chip/matter.js/issues/4163)), noting that ecosystems are expected to poll these attributes themselves. The resync still does what it can — republishing the attributes bumps the cluster data version, so a controller that reads gets a new version rather than a value untouched since pairing day — and the line now says that instead. A frozen battery percentage in Apple Home is an Apple-side gap, reportable through Apple's feedback process, and no bridge-side workaround will fix it.

## 3.4.4

- **Nine Saros 10 status fields are now mapped.** 3.4.3 started naming unknown `get_status` fields once instead of once a minute, and asked owners to paste that line into a model report. skmzwanke did exactly that for his `roborock.vacuum.a144` ([#8](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/8)), so `home_sec_status`, `voice_chat_status`, `home_sec_enable_password`, `extra_time`, `sterilize_status`, `rst`, `cleaning_info`, `exit_dock` and `seq_type` are known from now on and his log is quiet. None of them drive behaviour — control, battery, rooms and state come from a model-agnostic path — so this is purely about not pestering the owner of a new model about fields the plugin had simply never met.

## 3.4.3

**A robot with no model profile no longer fills your log with the same request forever.** Models the plugin has no dedicated profile for — the Saros 10 in [#8](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/8), the Qrevo CurvX in [#6](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/6) — run on the capability-derived path, which works, but every status field the profile did not name produced its own `Unsupported attribute … Please contact the dev` warning on every status poll. For the Saros 10 that is eight warnings a minute: about 11,500 requests a day to report the same eight fields. Both issues were promised this would be quietened.

- **Each unmapped field is now reported once per robot, in one line, and then never again.** A firmware's set of unmapped fields is fixed, so a repeat says nothing a user can act on. Repeats go to debug. A time-based throttle was the wrong shape: it would bring the message back forever, which is the complaint rather than the fix.
- **A field nobody has seen before still gets through.** If a robot starts sending something new after hours of uptime, it is reported on its own — quietening the noise must not also hide the signal, since these lines are the raw material for a model profile.
- **The line is now usable in a model report.** It names the robot and model, lists every field with its value, and says plainly that control, battery, rooms and state do not depend on them. Object values are serialised instead of arriving as `[object Object]`, which is what `cleaning_info` looked like in #8 — the one field where the shape was the interesting part.
- **Two startup tests no longer assert on the clock.** Both checked that per-robot probes run concurrently by timing them against a 180 ms budget — and on a quiet machine they finish in ~65 ms, so the assertion could only ever fail for a reason it was not testing. A scheduling hiccup was enough to fail a build with the concurrency perfectly correct. The check was also redundant: serialized probes give a peak concurrency of 1, which the neighbouring assertion already catches exactly. They now assert the property directly — every probe started before the first one finished — which holds on any machine under any load. Same defect 3.4.2 removed from the B01 full-chain simulation.
- **The log-naming rule from 3.3.2 was itself only half enumerated.** It listed three files by hand, and the files it left out held twelve log lines still printing a bare 22-character duid — including `Device <duid> is offline.`, which is exactly the line someone quotes when asking why a robot dropped out. A hand-written file list is the same mistake as a hand-written line list, one level up. The rule now discovers the file list from the source tree, so a new file is covered the moment it exists, and all twelve lines now name the robot.

## 3.4.2

**Q7-series robots are no longer asked for things they cannot answer.** Every restart, each Q7-generation robot (`roborock.vacuum.sc05`, `ss07`, and the rest of the B01 family) logged an unsupported-method notice — most visibly for `get_water_box_custom_mode`, and also for `get_timer` and `get_carpet_clean_mode`. The message blamed the robot, and the robot was never involved: the plugin's own send path rejects v1-only requests for B01 devices before anything reaches the network, and the poller then recorded that self-rejection as though the robot had answered it.

- **The periodic poller now consults the dialect before asking.** For a B01 robot it skips exactly the requests that have neither a Q7 translation nor a neutral placeholder, and says so once per robot at debug level instead of once per robot as a notice. Classic S- and Q-series robots poll precisely as before.
- **The check derives from the translation table itself**, not from a hand-written list of method names — a second list would drift the first time a translation was added, and the drift would only ever show up as noise in somebody's log.
- **The poll-profile line stops promising a water-box probe it will not perform** on a robot whose water tank is filled by hand and has no electronic level to read.
- **A test enumerates the rule rather than the three reported methods:** for a B01 robot, no periodic poll may be one the dialect cannot answer. Probes added later are covered without anyone having to remember this.
- Also fixed: the B01 full-chain simulation ran under Jest's 5-second default, which quietly made suite-wide CPU load an implicit assertion — it began failing on an unrelated new test file. Its wall-clock time was never what it set out to verify.

## 3.4.1

**The Matter fault attribute is withdrawn.** Wazza151 ran three controlled tests on an S8 Pro Ultra with a genuinely empty clean water tank ([#5](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/5)) and the result was unambiguous: Apple Home drew no warning with the fault published beside a Charging state, drew no warning with it published beside a forced Error state either, and the tile went into a stuck "Updating…" that needed a manual poke to clear. Everything off, and the tile behaved perfectly.

So the feature cost people their tile and never once delivered the thing it promised. Apple Home does not appear to render Matter vacuum faults from a bridged accessory at all — the same conclusion 1.4.61 reached when it removed the original write. Rather than keep a switch that can only do harm, it is gone.

- **`operationalError` is no longer published in any configuration**, and a test pins that it stays that way. The mapping tables from Roborock error and dock codes to Matter error states are removed with it; they were accurate and they were useless.
- **The 3.4.0 setting Show Dock & Tank Warnings as Errors is removed.** If it is still in your `config.json` it now does nothing — a stale key cannot resurrect the behaviour.
- **Report Faults in Apple Home keeps its worthwhile half.** A robot that has genuinely halted — stuck, blocked brush or wheel, missing dust bin, flat battery, unreachable dock — still reports the Matter **Error** state instead of Ready. Apple renders operational states perfectly well; the same robot shows Charging, Docked, Emptying and Washing correctly. That was always the valuable part.
- **The diagnostics report's `matterFeatures` line now reads the saved plugin config rather than the checkboxes on screen.** A tick that has not been saved and had the bridge restarted is not in effect, and a report claiming otherwise sends everyone chasing behaviour the plugin was never exhibiting. If the form has unsaved edits, the report now says so.

## 3.4.0

**If you turned on Report Faults in Apple Home in 3.3.0, update.** Field testing on an S8 Pro Ultra found that the feature could leave the Apple Home tile stuck on "Updating…", needing a manual poke to come back — and the same robot behaved perfectly the moment the setting was switched off. That is fixed here, and the reason it happened has changed how the feature works.

- **A fault is now only ever published alongside the Error state.** 3.3.0 wrote the attribute continuously — the live fault while one existed, NoError otherwise — so a robot sitting on the dock reported "Charging" and "clean water tank empty" in the same breath. A robot cannot be both, and the Matter specification agrees: OperationalError describes the condition "when the OperationalState attribute is populated with Error". A healthy robot's payload now contains no fault attribute at all, byte-identical to running with the feature off, and a cleared fault sends exactly one all-clear rather than attaching NoError to every snapshot forever.
- **Dock and tank conditions moved behind their own switch, Show Dock & Tank Warnings as Errors.** The same test established the other half of the picture: with the fault published but the tile not in Error, Apple Home drew nothing. So reporting a dock condition without raising Error is all cost and no benefit. The new switch raises it — which makes the warning visible, at the price of a robot Apple Home may refuse to start even though it could still vacuum. That trade-off is now the user's to make, stated plainly in both settings screens. Off by default, and it does nothing unless fault reporting is on too.
- **Robot faults are unchanged and still work:** stuck, blocked brush or wheel, missing dust bin, flat battery, unreachable dock. Those genuinely halt the robot, so state and fault agree and there is no contradiction to confuse a controller.

## 3.3.2

- **Finished a job 3.3.1 only half did.** That release converted the B01 log lines to use the robot's name and missed eleven others, including the live-room line for classic S/Q-series robots and the battery resync line — which then appeared in a field log directly above a line that did use the name: `Battery resync for 3tELc5hUekaTlOJEW3YetI` followed by `Matter publish for Garage`. Every user-visible log line now names the robot, and a test enumerates the rule rather than the instances, so the next line written cannot reintroduce it.

## 3.3.1

Two field reports arrived within an hour of 3.3.0 and both came down to the same thing: the log and the diagnostics report were answering questions nobody had asked while staying silent on the one that mattered. This release is almost entirely about making the plugin legible.

- **The live-room log said "the robot may be between rooms" for four different problems.** The resolver returns nothing when the map payload has no header, when it carries no robot position, when it carries no room outlines, or when the position genuinely falls outside every outline — and only the last of those is "between rooms". A day of field logs produced 51 of these messages, every one of them asserting a cause that may not have been the cause. Each case is now named, with the number of outlines in the map and the computed position cell, so a coordinate problem is visible in the log instead of needing a debug build.
- **The message identifying a misbehaving robot was the one you could not read.** The failure line printed a raw 22-character duid while the success line beside it printed the robot's name. In a three-robot house that is the difference between a usable log and a wall of identifiers. The live-room, B01 status and B01 room lines all use the name now.
- **The attempt counter appeared to reset at random.** A robot resolving back into the room it was already in silently zeroed the miss counter without logging anything, so "attempt 15" was followed by "attempt 5" with nothing in between. Re-entering a known room after a run of misses now says so.
- **The startup line announced a cadence the code stopped using.** 3.2.0 changed the at-rest B01 poll from 45 s to 25 s and left the message advertising 45 s — misleading in exactly the area it was meant to explain. The cadence values are named constants now and the message is derived from them, so they cannot drift apart again.
- **The diagnostics report now lists which Apple Home features are switched on.** A report that omits them cannot answer "why doesn't Apple Home show this?", which is the first question most of them are sent to answer — and it cost a full round-trip with a user who had run the test correctly.
- **The Matter publish line names the robot, and reports a fault when one is being published.** Previously it printed a duid and said nothing about faults, so there was no way to tell whether Apple Home was showing nothing because the plugin sent nothing.
- **`operationalError` is no longer part of the accessory's registration snapshot.** It is published on the first runtime update instead, seconds later. Matter commissions the endpoint from that snapshot, and 1.4.61 removed the plugin's fault write precisely because Apple Home reacted badly to it there — so a robot that happens to be faulted when Homebridge starts can no longer change what gets commissioned. The mandatory Matter default covers the gap.

## 3.3.0

A robot that has stopped because it is wedged under the sofa has always looked exactly like a robot that finished the job: **Ready**. This release lets the plugin say what is actually wrong — asked for by Wazza151 in [#5](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/5), whose previous Matter bridge showed him when the clean-water tank ran empty.

- **New setting: Report faults in Apple Home** (off by default). The robot's own faults — stuck, blocked brush or wheel, missing dust bin, flat battery, unreachable dock — are published as the Matter Error state with the Roborock description attached, instead of being flattened to Ready. Dock and tank conditions — clean-water tank empty, waste-water tank full, dust bag missing, air duct blocked, mop-wash tank full — are published as a Matter fault too, but deliberately do **not** force the Error state: a robot whose waste-water tank is full can still vacuum, and an accessory in Error may be refused a Start command by the controller.
- **The Error state was never gated for a reason.** `ERROR` (3) is a member of even the basic advertised operational state list, so publishing it was always legal — it was being rewritten to `STOPPED` alongside the states that genuinely did need a gate. That is why no released version has ever shown a Roborock fault in Apple Home.
- **A detached water tank or mop pad is not a fault.** Both are the normal, correct configuration for a vacuum-only run, so reporting them would leave a permanent warning on every dry robot's tile. They are read, and deliberately ignored.
- **The fault detail can never cost you the tile.** `operationalError` travels in the same cluster payload as the operational state, so a Matter build that refuses the attribute would otherwise freeze Cleaning/Docked along with it — the reason the explicit write was removed back in 1.4.61. If the write is rejected, the plugin immediately re-publishes without it, logs a warning naming the reason, and stops sending it for the rest of the session. An endpoint that is merely still starting up keeps its normal retry and does not disable the feature.
- **Diagnostics no longer truncate away the answer.** A Roborock status payload runs to about fifty fields and the export kept the first thirty — which are largely housekeeping, while the twenty it dropped included `dock_error_status`, the single field a question about the dock's water tanks turns on. The fields that matter for a fault report are now always kept, however far down the payload they sit, with the size cap otherwise unchanged and secret redaction untouched.

## 3.2.0

Field feedback on the Q7 series: the live room in Apple Home lagged badly behind the robot. One run took 90 seconds to name the first room; another took seven minutes.

- **The first room of a run now appears as soon as the robot is seen cleaning.** Two throttles were stacking. The status poll backed off to 45 seconds while the robot looked idle, so a clean started from the Roborock app or a schedule was invisible for up to that long; then the live-room map fetch applied its own 20-second gap on top, counted from the last attempt rather than from the start of the run. The idle poll is now 25 seconds, the map gap is 10 seconds, and the transition from idle to cleaning clears the gap so the first fetch goes out immediately. Steady-state pacing during a run is unchanged in spirit — the map payload is still an order of magnitude heavier than a status read and is still paced deliberately.
- **A robot that cannot place itself on the map now says so.** When the robot's position doesn't fall inside any known room outline, the plugin used to return silently at debug level. That is the most likely explanation for a run going minutes without a room — in the field a Q7 spent seven minutes doing exactly this — and it was indistinguishable from the feature being broken. Repeated misses are now reported at a level you can actually see, with a count.

## 3.1.1

- **The Apple Home Features checkbox still said "Returning status".** 3.1.0 renamed the setting in the config schema but not in the plugin's own settings UI, which is the one most people actually see — so the first person to install it reasonably wondered whether the update had applied at all. Both now read **Dock & Returning status**, and the description spells out that Emptying and Washing only appear while the dock is genuinely doing that, and that mop drying has no Matter equivalent.

## 3.1.0

Driven by two open model reports, plus the parts of the 3.0.2 audit that were too large to rush. Nothing here requires re-pairing unless you turn on the dock statuses below.

- **"Emptying the dust bin" and "Washing the mop" now actually reach Apple Home** (#5). The Extended Operational States toggle promised four statuses and delivered one. The other three were missing from the advertised operational state list — and Matter refuses to publish a state that is not advertised — and the code path that maps them rewrote all three to plain Running regardless of the setting. Both halves are fixed, and the setting is renamed to **Dock & Returning Status** to say what it does. Still opt-in, and still needs one remove-and-re-pair, because Matter fixes an accessory's capabilities at commissioning. Mop _drying_ has no equivalent in the Matter robot vacuum specification, so no plugin can report it; that is now stated in the setting's own description rather than left to be discovered.
- **Changing suction no longer makes a cleaning robot claim it is charging.** Live push field 123 was read as charge status. It is fan power — charge status is 133 — so a suction change from the Roborock app, a schedule, or SmartPlan pushed a frame that the plugin interpreted as "charging" while the robot was mid-clean. Fan power, water level and charge status now come off the wire with their real meanings, and a suction change made outside Apple Home refreshes the clean-mode picker instead of being discarded as an empty update (#6).
- **Capability detection no longer leaks between robots in the same account.** The per-model feature tables were module-level objects shared by every robot, and devices are set up one after another — so a plain S4 or S6 that happened to be created after an S8 Pro Ultra inherited its dock-wash, dust-collection and dryer commands, and which extras a robot got depended on the order its owner's account happened to list them in. The tables that drive the per-poll status handling were shared the same way. Each robot now has its own.
- **A single malformed local frame no longer wedges a robot's LAN channel.** The chunk buffer was only reset after a successful parse, so one bad frame left the buffer in place, re-processed the same bytes on every subsequent packet, and threw at the same offset forever: unbounded memory growth on a Pi and every later local reply lost, with no self-heal. The reset is now unconditional, a corrupt length prefix is treated as a desync and recovered from instead of buffering without bound, and a chunk boundary landing inside a length prefix no longer misaligns the stream.
- **Local transport recovers on its own again.** A failed reconnect attempt scheduled nothing further, so a robot that was unplugged, or offline when the retry happened to fire, stayed on cloud transport until Homebridge restarted. Retries now re-arm with backoff (60s, 2m, 4m, 8m, up to 15m) and reset the moment the robot answers.
- **Security: the cloud session and every device's LAN key are no longer world-readable.** `roborock.UserData` and `roborock.HomeData` were written 0644 next to the AES key that `src/crypto.ts` carefully writes 0600 — so the encrypted-token feature bought nothing on any host with a second user or service account. Both are now owner-only, existing files are repaired in place on the next write, and the emergency temp-directory fallback is covered too.
- **Security: logging out logs you out.** The account password was kept in `config.json` after a token was obtained (and rewritten on every later settings change), and Logout cleared only the token — so the next restart silently signed back in. The password is now dropped once a token exists, and Logout clears the password and the cached device keys as well.
- **Security: the diagnostics report no longer leaks your Wi-Fi.** The raw robot RPC block was passed through a single IPv4 regex, so a `get_network_info` reply still in the buffer published the home SSID, the access point BSSID and the robot MAC verbatim into a report users are told to paste into public issues — and a BSSID resolves to a street address in public geolocation databases. Identifying fields are now redacted structurally, at any nesting depth, while the values that make a report useful are untouched.
- Full suite: 352 tests, 37 new since 3.0.2. Every new test was checked to fail before its fix and pass after.

## 3.0.2

A full read of the codebase turned up defects that no test covered and that the logs had been reporting for weeks without anyone reading them properly. Two of these could end the Homebridge process; one meant a headline feature had never worked in any released version. Nothing here requires re-pairing.

- **A malformed UDP packet can no longer take Homebridge down.** The discovery socket is bound to `0.0.0.0:58866` and receives whatever the network broadcasts at it — the Roborock phone app doing its own discovery, a port scanner, a truncated retransmit. Neither the binary parser nor `JSON.parse` was guarded, and a synchronous throw inside a dgram handler is an uncaught exception. One stray datagram from any host on the LAN was enough to stop the bridge, and because such senders are usually periodic, to keep stopping it.
- **The MQTT startup watchdog no longer crashes the process it was written to rescue.** After 30 seconds without a broker connection it called `restart()` on the adapter — a method this class has never had. The resulting TypeError inside an async timer is an unhandled rejection, which Node terminates on. The one situation it was meant to handle, a Pi that boots before the network is up, was therefore the one situation guaranteed to kill the bridge. It now logs a clear, throttled warning and lets the client keep reconnecting, and the timer is tracked and cancelled on shutdown.
- **LAN discovery works for the first time.** `decryptECB` called the PKCS#7 helper without `this.`, so every broadcast raised a ReferenceError that the surrounding `catch` swallowed and turned into `null`. Robots were only ever reached locally when the cloud happened to report their IP; otherwise they stayed cloud-only, with slower commands and no resilience to a Roborock outage. Startup also spent its full five-second discovery window on a result that could not contain anything.
- **Q7-series clean mode and suction now reach the robot.** Both commands were dispatched through an allow-list that contained neither of them, so they fell through to `Command set_clean_type not found.` and nothing was sent. The log line has been there since 13 July. They now take the same path the classic models already used, which also reports genuinely unsupported commands instead of discarding them silently.
- **Cloud commands no longer time out after doing exactly what was asked.** The protocol-102 handler tried to detect a secure request by comparing the result to the string `"ok"`, but the wire format is the array `["ok"]`, and `["ok"] != "ok"` is false. Every ordinary cloud command that acknowledges this way — start, stop, pause, dock, suction, room clean — was left pending until the ten-second timeout and then reported as failed in Apple Home, while the robot had already carried it out. Secure requests are now tracked by an explicit flag, and a secure request that fails resolves instead of hanging.
- **A cloud hiccup can no longer unregister every robot.** When the home-data fetch fails, startup logs the error and continues, so the device list reads as empty — and stale-accessory cleanup then removed every Matter accessory. Matter locks the mode list at commissioning, so that meant re-pairing the entire fleet, and a restart did not undo it. Cleanup is now skipped unless the API is initialised and actually returned robots, and a `result`-less cloud response no longer overwrites the cached device list on disk.
- **Mop modes are no longer offered on robots that cannot mop.** Two capability entries were written as bare arrays where every neighbouring entry ends in `.includes(robotModel)` — and an array, empty or not, is truthy. Both were therefore true for every robot, which is why dry-only models (S4, S4 Max, S5, S6 Pure) showed Mop and Vacuum + Mop plus a water-level control, and had `set_water_box_custom_mode` fired at hardware with no tank.
- **Fixed a corrupt header on robots reporting protocol version `\x81S\x19`.** The version is three raw bytes, but it was written as UTF-8, which encodes `0x81` as two bytes; the sequence number then overwrote the overflow. Both the version and the sequence number went out wrong, so those robots ignored every message. The decode side already used latin1.
- A local reconnect failure can no longer surface as an unhandled rejection, and the byte-identical copy of the MQTT connector at the repository root — dead code that was being hand-synced with the real one, and had already drifted — is gone.
- Full suite: 315 tests, 36 new. Each new test was checked to fail against the previous code and pass against this one.

## 3.0.1

Follow-up to 3.0.0 after measuring a real restart instead of trusting the reasoning. Two things needed fixing, one of them mine.

- **Startup now genuinely finishes in ~2 seconds instead of ~7.** 3.0.0 moved LAN discovery off the critical path but still waited for its full 5-second broadcast window before declaring startup finished, so the total barely moved — the claim in the 3.0.0 notes ("~8 s before, ~3 s after") was wrong, and the corrected numbers are below. Local transport is an optimisation over the cloud path, not a prerequisite for it, so it now attaches in the background after the robots are already live in Apple Home.
- **Fixed: the first cloud request could fail on a cold start.** `get_network_info` was issued about a second after the MQTT handshake began and failed with "Cloud connection not available" — visible in real logs for a cloud-transported robot. Startup now waits for the broker session to actually come up (up to 10 s, then continues regardless) before the first requests, instead of relying on an unrelated delay to cover the gap.
- The diagnostics export is no longer headed `homebridge-roborock-vacuum2 diagnostic report` — a leftover from the fork that made reports confusing to read.

Measured on a three-robot fleet (two Q7, one S8 Pro Ultra), "Starting adapter" to "Lets go!!!!!!!": 6–7 s on 2.9.x and 3.0.0, ~2 s on 3.0.1.

## 3.0.0

Startup and refresh pass: Homebridge restarts are noticeably faster, and a status refresh that had never actually run now does. Nothing here requires re-pairing — existing setups keep working exactly as they are.

- **LAN discovery moved off the critical path.** It listens for robot broadcasts for a fixed 5-second window, and startup used to sit and wait for it before even creating the devices. Device setup and network probes now run inside that window instead. (The wall-clock win landed in 3.0.1 — see above; this release only reordered the work.)
- **Multi-robot startup no longer costs extra time.** Each robot's first status read and network probe used to run one after another; they now run at once, so three robots start as quickly as one. New tests pin the concurrency down so it cannot silently regress.
- **A dead status refresh has been repaired.** The periodic `get_status` refresh for classic (S/Q-series) robots was gated on a config key this plugin never sets, which made the condition permanently false — the refresh promised by the code has never run in any released version. It now polls each robot at most once a minute (forced refreshes are unaffected), so a dropped MQTT push self-corrects within a minute instead of waiting up to three for the slow full poll.
- **~86,000 needless timer wake-ups per robot per day removed.** With the refresh properly throttled, the 1-second scheduler tick that served it is now 15 seconds — same refresh rate, a fraction of the idle CPU on Raspberry Pi class hardware.
- One request removed from every startup: a scene list was fetched from the Roborock cloud and thrown away.
- **Security:** a newly published high-severity advisory in a transitive dependency (`ip-address`, reached through the MQTT client) is resolved, and the build toolchain was refreshed. `npm audit` reports zero vulnerabilities for both the shipped package and the development tree.
- Full suite: 279 passing (7 new startup/refresh tests).

## 2.9.9

- **Cleans started outside Apple Home now show the right clean mode.** Starting a vacuum+mop (or mop-only) clean from the Roborock app or the robot's buttons left Apple Home claiming plain "Vacuum". The Q7 series reports its active clean type in every status poll (the plugin sent it on start but never read it back); classic S/Q robots are derived from the mop-only suction signature and the active water-flow setting. Apple Home's mode picker now follows the robot live during a run — no re-pairing needed.
- Live fan power and clean type are now also picked up from push messages, not only polls, so mode changes surface within one update.
- The periodic `Matter publish` log line now includes `runMode` and `cleanMode` alongside `operationalState`, making Apple Home display issues diagnosable from a single log excerpt.
- Full suite: 272 passing (9 new live clean-type tests).

## 2.9.8

- Fixed a long-standing quirk in state persistence: the file encoding argument was passed to `JSON.stringify` (where it is silently ignored) instead of `fs.writeFileSync`. Behavior was correct by luck (utf8 is the default); the code now says what it means.
- npm search keywords expanded (s7, s8, q revo, saros, robotic vacuum) so the plugin is found by people searching for their model.
- README: highlighted that one sign-in brings the whole fleet — every robot on the account appears as its own accessory.

## 2.9.7

- Positioning sharpened across the npm description and README: the entire Roborock lineup is supported (classic S/Q/Saros series through the 2025 Q7 series that no other plugin can control, with automatic adoption of future models), presented as the most complete Roborock plugin for Apple Home. No functional changes.

## 2.9.6

- **Friendlier plugin description and README.** The npm description shown in the Homebridge UI now leads with what the plugin does for you ("sign in with your Roborock account — start cleans, pick rooms, set suction power, and see live which room the robot is cleaning") instead of protocol terminology. The README's intro, feature matrix and live-room section were rewritten in plain language, with the technical depth preserved in collapsible under-the-hood sections. No functional changes.

## 2.9.5

- **One synchronous disk write per received robot message eliminated.** The per-device diagnostics states (last cloud/local message, transport history) were flushed to disk with a blocking `fs.writeFileSync` on EVERY message a robot pushed — every few seconds per robot while cleaning. They are served from memory (the settings UI never reads the file); the on-disk copy only needs to survive restarts. Disk flushes for these two states are now debounced to at most once per minute, with a guaranteed flush on shutdown. Result: event-loop stalls removed from the message hot path, and meaningfully less SD-card wear on Raspberry Pi installs. Critical states (credentials, HomeData, room caches) still persist immediately.
- Full suite: 263 passing (3 new persistence-debounce tests).

## 2.9.4

Startup-cost cleanup release (also refreshes the npm README with the Donate button and the prominent Verified badge).

- **Two fewer RSA-2048 key generations at every startup.** The MQTT connector generated a protocol keypair that nothing ever read (removed), and the message layer generated its keypair eagerly even though it is only needed for the rare photo request path on camera-equipped models (now created lazily on first use). Measured ~50 ms per keygen on fast hardware — substantially more on a Raspberry Pi.
- Removed dead code: the never-called `decryptWithPrivateKey` helper and the unused `scenesData` field (both HomeKit-era leftovers).

## 2.9.3

**The plugin is now Verified by Homebridge!** 🎉 Reviewed and endorsed by the Homebridge team (homebridge/plugins#1124), with specific praise for the encrypted at-rest session storage, the preserved fork attribution, and the per-release notes.

- Verified badge added to the README.
- **Donate button enabled** on the plugin's Homebridge UI tile via the standard `funding` field (PayPal), plus a Support section in the README.
- Verified plugins are bumped in Homebridge UI search results and distributed via the pre-bundled tarball pipeline for faster, more reliable installs on low-power devices.

## 2.9.2

- **Max+ ("Grundig"/"Deep Clean") suction mode now announced on the S8 Pro Ultra.** Field report from a re-paired fleet: the S8 Pro Ultra only showed four suction levels because Max+ was gated to B01/Q7. The classic gate now uses the upstream-vetted per-model feature data (`set_custom_mode_max_plus` in the model's action list) — currently confirming the S8 Pro Ultra (`a70`); further models are added as feature data or field reports with diagnostics exports confirm the level. NOTE: the robot must be re-paired once for the new mode to appear (Matter locks the mode list at commissioning).
- Battery documentation corrected after upstream verification on homebridge#3958: `batPercentRemaining` is quality **Q (quieter)** as of Matter 1.4 (reports ARE sent via subscription, 10 s throttle) — a spec-compliant controller applies them; Apple Home in steady state does not. No plugin architecture change needed; the bridge already does the right thing.

## 2.9.1

Deep performance pass over the live-room hot paths, with honest before/after measurements.

- **Classic live-room lookup: ~23 ms + ~6.7 MB of allocations -> ~1 microsecond, zero allocations.** The RRMap was previously fully parsed every ~20 s while cleaning: parsedata materializes floor/obstacle/segment pixel arrays (hundreds of thousands of entries on a real 800x800 map) only for the tracker to look up a single pixel. The new `resolveLiveSegmentFromMapBuffer` fast path walks the block table once and reads exactly ONE pixel byte from the raw buffer (~19,000x faster, measured on an 800x800/700 KB map with a 20k-point path block). Equivalence with the full parser is locked by tests probing both paths across room, corridor and out-of-map positions.
- **B01 room cache is only written to disk on actual change.** The live map fetch refreshed the persisted room-name cache every ~20 s during cleaning even when nothing changed; identical room lists no longer touch the disk.
- **Hot debug lines no longer pay JSON.stringify when debug is off.** Template arguments are evaluated eagerly in JavaScript; the per-poll B01 status line and the per-message protocol-102 line are now gated behind the debug flag.
- B01 SCMap parsing consolidated to a single walk (head, pose, rooms, chains in one pass). Measured honestly: no speed win (~0.05 ms either way, the grid field is skipped via its length prefix) — kept for the simpler structure.
- Full suite: 259 passing (3 new fast-path equivalence/robustness tests).

## 2.9.0

- **All Apple Home feature toggles are now visible in the plugin settings UI.** The custom settings page previously exposed only a subset of the configuration; options like suction-level cleaning modes, live room tracking, room/map selection, cleaning mode selection, battery and Returning status could only be set by editing the JSON config by hand. They now live in a dedicated **Apple Home Features** section, with a clear "&#9888; re-pair" marker on every option that changes the robot's announced Matter capabilities (Matter locks capabilities at commissioning — after toggling those, restart Homebridge, then remove and re-pair the robot).
- No functional changes to the plugin itself.

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
