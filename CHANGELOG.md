# Changelog

## 3.27.0

**The scene resource named its one write verb, and it is the one that deletes. So the search moves off that resource and onto its siblings — asked safely, and this time with controls, so the round either finds the route or proves there is nothing left to find.**

3.26.0 asked `user/scene/<id>` which methods it accepts. Issue #22's reporter ran it and the answer came back on the first try:

```
OPTIONS user/scene/<id> → "" — the resource allows: DELETE,OPTIONS
```

That is an answer, and not one of the two the thread had planned for. The plan said an `Allow` naming a write verb means the next step is a promised no-op, and a missing `Allow` means we are near the end of what can be measured from outside. What arrived names exactly one method that changes anything, and it removes a schedule rather than toggling one. There is no write there to put behind a HomeKit switch, and a destructive verb is not something to try against someone's live account to see what happens.

**What that rules out is the resource, not the feature.** The plugin's own scene-run path reaches `user/scene/<id>/execute`, so sub-resources under a scene id exist and carry verbs the scene itself does not. This release asks the same safe question of the routes that are left:

- `user/scene` — the collection, where a REST API most often keeps an update
- `user/scene/<id>/enable` — the literal candidate for the nested `TIMER` flag the reporter's app flips

**And of two controls, which is the part that makes the answers mean anything.** An `Allow` header on its own is not evidence:

- `user/scene/device/<duid>` — a **positive** control. This same probe run already read it successfully, so it is mapped beyond doubt. If `OPTIONS` cannot describe even that, the instrument does not see routes and no other answer in the set is worth reading. It is also why the control is this route and not `/execute`: a control must not be a path whose real verb starts a robot.
- `user/scene/<id>/no-such-subresource-control` — a **negative** control. If a path with nothing behind it also answers with an `Allow` header, the server answers everything and every positive here is an artefact.

Together they bound the search instead of extending it: this round either names a route or shows that no later round would.

Everything that made the probe safe to ship is unchanged and still bound by tests — silent unless debug logging is on, safe methods only, once per robot per session, cannot throw into the poll it rides on, and only the `Allow` header is taken from a response rather than the header block, which carries session material. A source guard now also pins the two properties that would otherwise fail invisibly: every candidate is narrowed to a safe method at one point, and the negative control cannot be dropped.

## 3.26.0

**The refused route answered, and what it said was that the route exists — just not for the verb we asked with. So this release asks it which verb it does take, without attempting one.**

3.25.1 taught the schedule probe to keep the body of a refusal. Issue #22's reporter ran it, and the body was worth the release:

```
GET user/scene/<id> → 400
{"code":"servlet.exception","msg":"Request method 'GET' is not supported", ...}
```

That is not "no such route". A servlet says that sentence when the path _is_ mapped and the method is not — so the singular scene resource exists, and something other than GET reaches it.

Two releases have now established _what_ a HomeKit switch over these schedules would have to change: the `enabled` flag inside a scene's TIMER trigger, not the scene's own. Neither established _where_ to send it, and this thread has twice refused to guess, because a guessed write endpoint against somebody's live account does not fail politely.

There is a way to ask a resource which methods it accepts without attempting any of them, and it is what OPTIONS is for. It is a safe method, it carries no body, and it cannot alter a schedule. When the probe finds a timer-driven scene, it now asks that one scene resource the question and records the `Allow` header that answers it.

The probe was also dropping that header — on refusals and successes alike — which is the same defect 3.25.1 fixed one field over: a refusal saying "GET is not supported" names the verb that failed and not the ones that would work, and `Allow` is where a servlet puts those. It is now kept wherever it appears.

Exactly one header is taken, deliberately. A response header block carries session material, and a diagnostic somebody pastes into a public issue must not leak their cookie to measure a verb.

The constraints are otherwise unchanged and one of them is now stated more precisely: safe methods only — GET and OPTIONS — debug logging only, once per robot per session, cannot throw, credential-shaped fields redacted. Still a diagnostic, still not a feature.

## 3.25.1

**The schedule probe kept the status code of a refused route and threw away the server's explanation of it — so the route it was built to measure came back saying nothing.**

3.25.0 shipped a read of the singular cloud scene resource, on the reasoning that a 200 makes it a candidate for a later write and a 404 rules it out for free. Issue #22's reporter ran it, and the answer was neither: `400`.

That is the one outcome the probe had nothing to say about. A 404 means there is no such resource. A 400 means the server routed the request and then rejected it — which is a statement about the request, not about whether the route exists. Whether it means "unknown route", "wrong method" or "that scene is not yours" lives in the body the server sent back, and axios flattens every one of those into the same sentence: `Request failed with status code 400`.

The probe recorded that sentence and dropped the body. So a measurement that took a release to ship, and somebody else's live account to run, produced a number and no reading.

A refused route now keeps what the server actually said, in the log and in the diagnostics record, under the same compaction and redaction a successful answer already gets — an error envelope is no more ours to print blindly than a normal one. This holds for every route the probe reads, not just the one it was found on.

No behaviour outside the diagnostic changes, and the probe is still debug-only, GET-only, once per robot per session, and unable to throw.

## 3.25.0

**The schedule probe now measures whether a cloud schedule is a resource the plugin could ever write to.**

Issue #22's reporter switched two of his three app schedules off, restarted, and sent the reading without saying which two. The log named them, and it named something more useful than that: every scene-level `enabled` stayed `true`, and the flag his app had actually flipped was `enabled` inside each schedule's own TIMER trigger, nested a level deeper. So a HomeKit switch over these schedules would have to rewrite that nested field — not the scene's own.

Knowing what to write is not knowing where to send it. The only write route measured on this client is `user/scene/{id}/execute`, which runs a scene rather than enabling one, and a guessed write endpoint against somebody's live account does not fail politely — it edits or deletes a schedule they rely on.

So this release measures the one remaining thing that costs nothing: whether the singular scene resource answers at all. When the device route reports a timer-driven scene, the probe reads that one scene by id. A resource that answers GET is the only defensible candidate for a later write, and its answer is the payload shape such a write would have to send back; a 404 rules it out for free.

The constraints are unchanged, because they are what make shipping a measurement to thousands of installations defensible: debug logging only, GET only, once per robot per session, cannot throw, credential-shaped fields redacted. Exactly one scene is read rather than all of them — this is a shape measurement, not an inventory, and an account with nine schedules must not become nine requests.

Still a diagnostic, still not a feature. Reading these schedules is solved; switching them is not, and it will not be built on a guess.

## 3.24.2

**Shutting down while LAN discovery was listening left a UDP socket open and every caller waiting on it hung.**

Discovery listens for the robots' broadcasts for a fixed five-second window. One timer ends that window: it closes the socket and hands back whatever was heard. Shutdown's only hook into the local transport cleared that timer — which disarmed the one thing that ended the pass.

A pass caught in the air when Homebridge stopped therefore never closed its socket, leaving a bound handle holding the event loop open, and never settled its promise, so anything awaiting discovery waited until the process was killed. Shutdown already fixes exactly that hang for pending cloud requests; discovery was missing from the list. It also never released the single-flight claim added in 3.24.1, because that claim is released in the promise's own completion.

Shutdown now ends the pass properly: socket closed, promise resolved with the addresses already heard. Resolved rather than rejected, because a rejection would log an error line for an ordinary shutdown, and those addresses were measured facts already recorded — there is no reason to throw them away. Forgetting the pass without closing its socket would have been worse than the leak: the port is fixed, so the next pass would fail to bind with `EADDRINUSE` and reject a discovery that had nothing wrong with it.

Nobody would have noticed this as a fault. The process was being torn down anyway, so the leaked handle went with it. It is fixed because a shutdown that cannot finish cleanly is the thing that turns a restart into a kill.

## 3.24.1

**A robot whose DHCP lease moved it stayed on the cloud until Homebridge was restarted.**

Issue #21 asked the question directly: other plugins for this robot drop the connection when its IP changes, so does this one handle it? The honest answer needed measuring, and the measurement found a gap.

The local TCP transport learns each robot's address once, at startup, from the robot's own UDP broadcast. That address was then held in a closure for the life of the process. For every reason a local socket drops — a blip, a robot picked up and carried out of range, a reboot — retrying the same address is exactly right. For the one reason that lasts, a lease that moved the robot, it never was: the retry chain went on probing the old address, backing off to once every fifteen minutes, until somebody restarted Homebridge.

Nothing looked broken, which is why this survived. A failed local connect falls back to the Roborock cloud automatically, so commands kept working and Apple Home kept responding. The only symptom was that the fast path never came back.

Two things change:

- The address a reconnect aims at is resolved when the retry timer fires rather than when it was armed, so any correction from elsewhere is picked up.
- A reconnect also re-consults the LAN in the background. The robot's UDP broadcast is the one signal that means "this robot is on _this_ network at _this_ address", so it is the right source for the correction — the cloud's `get_network_info` cannot serve here, because a robot whose local connect just failed has already been marked cloud-only, and that mark is what gates the write of its address. The correction is written where every other caller reads it, so a moved robot is picked up by ordinary commands too, not only by the retry.

The re-check does not hold the reconnect attempt open: it is for the retry after this one, at least a minute out, and the common case is a robot that blipped and is still where we left it. A pass that hears nothing, or hears the address already held, changes nothing at all. Cloud-only installs never open the port. A move is reported once, by name, with both addresses.

LAN discovery is now also single-flight. It binds a fixed port, so a startup pass and a reconnect pass could overlap and the second `bind` would fail with `EADDRINUSE` — rejecting a discovery that had nothing wrong with it.

## 3.24.0

**The probe from 3.23.0 came back, and it found the schedules.**

Issue #22's reporter has three daily schedules in the Roborock app that his Saros 10R (`roborock.vacuum.a144`) insists it does not have — it refuses `get_server_timer` outright with `-10007 "Not FCC robot"`, and answers the legacy `get_timer` with `[]`. Both answers were true. 3.23.0 shipped a read-only diagnostic to find out where the schedules actually live, and his log settles it:

- `GET user/devices/<duid>/jobs` → `[]`. That route is out.
- `GET user/scene/device/<duid>` → **all three schedules**, with cron, timezone, enable flag and the room task.

His app screenshots explain the shape. The three entries under **Meine Programme** each carry a clock icon, and in Roborock's data model a named program with a timer _is_ a scene with a `TIMER` trigger. Newer robots keep their schedules as cloud scenes, not as device timers. The device protocol was being asked a question only the cloud can answer.

**What this release changes is the diagnostic, not the feature.** Reading these into HomeKit switches needs a route that can enable and disable a scene, and no such route has been measured. Guessing a write endpoint against somebody's live account is how you delete a schedule they depend on, so that half waits for a measurement rather than a hope.

What it does change is that the measurement now survives being logged. The probe printed its answer through the diagnostic compactor, which caps every string at 500 characters and every array at 8 entries — the right default for an envelope nobody has mapped, and costly on this one. Measured on the real answer: every one of the three scenes was cut mid-task, so the log recorded _when_ each schedule fires and never _what it runs_, and an account with more than eight schedules would have lost the rest of them silently. The payload is now decoded from the raw answer, before compaction, and reported as facts:

```
… — user/scene/device/<duid> carries 3 timer-driven scene(s):
…   "Saugen+" (scene …) — 09:00 on Wed (Europe/Berlin), enabled, runs do_scenes_segments over 7 segment(s)
```

The constraints from 3.23.0 are unchanged: debug logging only, `GET` only, once per robot per session, and it cannot throw. The decoder is pure, carries neither the duid nor room names out of the payload, and renders a cron only in the shape the app actually produces — anything else is printed verbatim rather than half-translated. A scene with no timer is one of the app's manually run Routines; it is counted in the summary rather than dropped without saying so.

## 3.23.1

**A Q7 that finished cleaning normally asked its owner to report a fault.**

The maintainer's own `roborock.vacuum.sc05` logged six distinct unexplained `error_code`s in a single day — 2110, 2108, 501, 2102, 2103 and the long-familiar 2105 — every one of them while it was running. It then finished its run and docked at 100%. Nothing was wrong with it at any point.

Read against python-roborock's own per-family fault tables, two of those six are not faults at all:

- **2102** — "Cleaning completed. Returning to the dock." It fires after **every** task.
- **2100** — "Low battery. Resume cleaning after recharging." The robot announcing normal auto-recharge-and-resume.

The plugin already treats the Q10 family's equivalents this way: upstream marks that family's 501 as hardware-confirmed and firing per completed task, and its 502 as a low-battery resume, and both have been informational here since the families were split. The Q7 family was simply never given its own two. The asymmetry ran the other way too — the Q7 has always silenced 407 ("cleaning in progress, scheduled clean ignored") while the Q10 did not, though upstream marks it hardware-confirmed and "lifecycle, not an error" on that family as well. All three are informational now.

Apple Home was never affected: no B01 fault number appears in the plugin's v1 error table, so an unrecognised one has always published nothing rather than drawing a fault on a healthy tile. What it reached was the log, which named the code once per run and asked the owner to report the number "if the robot really is in trouble right now" — asked, in these two cases, after a clean that had just completed successfully.

**Restraint is the other half of this.** Only a healthy robot's lifecycle notifications are silenced. A scheduled clean that did not run (2003, "Battery level below 20%. Scheduled task canceled") and a clean that ended without reaching its target (2007, 2012) are outcomes an owner may want to know about, so they still surface. And the codes upstream itself cannot explain — 2103, 2105, 2108 and 2110 are bare `fault_NNNN` entries there too — stay exactly as they were. Silencing a number nobody has explained would be a guess, not a translation.

## 3.23.0

**Where a newer robot actually keeps its schedules: a read-only measurement, on request.**

Some newer robots decline the device-side schedule method outright. A Saros 10R (`roborock.vacuum.a144`) answers `-10007 "Not FCC robot"` to every `get_server_timer`, while the legacy `get_timer` honestly answers `[]`. Both answers are true — that robot holds no _device-side_ timers — and yet its owner has three daily schedules, which he showed running under the robot's own Schedule screen in the Roborock app. They are held server-side, on cloud routes the device protocol never touches, and this plugin has only ever asked the robot.

Rather than map a payload nobody here has seen, this release measures it. With debug logging on, the plugin now asks the two candidate cloud routes for each robot once and prints what came back:

- `user/devices/{duid}/jobs` — schedules
- `user/scene/device/{duid}` — the app's Routines

The answer is also filed under `lastCloudScheduleProbe` in the plugin's diagnostics.

**This is a diagnostic, not a feature, and it is built to stay that way.** It is silent unless debug logging is on, so no installation pays for it uninvited. It only ever issues GETs, so it cannot alter a schedule. It runs once per robot per session, so no poll cadence can turn it into traffic. It cannot throw, because it rides along on a live poll. And credential-shaped fields in the answer are redacted before anything is logged.

It does not yet expose these schedules in HomeKit. It establishes their shape, which is what the next step needs.

## 3.22.0

**Schedule reads cost far fewer cloud calls, and the queue that makes that possible could deadlock itself.**

pponce contributed #23, which cuts the cloud traffic HomeKit schedule operations generate. The schedule snapshot is now cached for 5 minutes instead of 1, read failures back off progressively (1m → 2m → 5m → 15m → 1h, with 10% jitter) instead of retrying every 30 seconds, rapid switch toggles inside a 500ms window are coalesced so only the last value for a schedule is sent, all schedule traffic for an account is serialised through one queue with 500ms spacing, and an explicit rate-limit answer from Roborock pauses that account's schedule traffic for 65 minutes rather than hammering it. For an account with several vacuums this is the difference between a steady stream of requests and a handful.

**The defect found while reviewing it, and fixed here.** A write batch runs inside the account queue and verifies itself afterwards by refreshing. That verification refresh is told the queue is already held, so it reads directly instead of queueing behind itself — correct. But a refresh may _adopt_ another refresh that is already in flight, and an ordinary HomeKit read of a schedule switch starts one that does **not** hold the queue. With a schedule snapshot older than the cache, a single `onGet` during a write was enough:

- the HomeKit read's refresh takes a place in the queue **behind** the running batch;
- the batch finishes writing, waits, and adopts that refresh as its verification;
- the refresh cannot start until the batch releases the queue, and the batch cannot release it until the refresh returns.

Nothing below the queue could break this. The timeouts that make the queue safe apply to requests that have been issued, and this read was never issued — there was nothing to expire. Both promises stayed pending forever: the HomeKit switch never answered, and the account queue was wedged for **every** vacuum on the account until Homebridge restarted.

A caller holding the queue now refuses to adopt a refresh that does not hold it, and starts its own instead. Separately, a refresh that has been superseded while waiting in the queue no longer spends a cloud request when its turn comes — the generation guards already barred it from storing the result, so the request was pure waste.

## 3.21.4

**The refusal 3.21.3 made visible was then reported as a plugin crash, twice per poll cycle, forever.**

DSimeone1989 ran 3.21.3 and sent the line it was written to produce. His Saros 10R answers:

```
Cloud message with protocol 102 and id 5 received. No result; reply was {"id":5,"error":{"code":-10007,"message":"Not FCC robot"}}
```

That is the answer: the robot's firmware declines `get_server_timer` outright. The fix worked. What it also produced was this, every poll cycle, for a robot behaving exactly as intended:

```
Failed to execute get_server_timer on robot Rocky (roborock.vacuum.a144): Error: The robot refused get_server_timer (cloud id 5): Not FCC robot (code -10007)
    at MqttClient.<anonymous> (…/roborock_mqtt_connector.js:420:17)
    at MqttClient.emit (node:events:514:28)
    … eight more frames
```

**A stated refusal was thrown as a bare `Error`.** It carried no code, so it matched none of `catchError`'s calm branches and fell through to the final `else`, which logs `error.stack`. The stack names our own MQTT handler and describes nothing that went wrong. Because the schedule coordinator and the generic poll both ask, it was emitted twice per cycle, indefinitely.

**A refusal the robot spelled out is now a capability fact, not a failure.** It is tagged where it is constructed, carries the robot's own error code, is reported once per robot per method so the owner learns why a feature is missing, and then drops to debug. It never carries a stack trace and never escalates to `log.error`.

Deliberately narrow: transport failures are untouched. A robot that is unreachable, a dead cloud link and a missing local socket all keep their existing loud paths — quieting those would tell an owner nothing is wrong while their robot is offline.

## 3.21.3

**A robot that refuses a request was reported as a robot that answered nothing.**

DSimeone1989 reported in #22 that his Roborock app schedules never appear. His Saros 10R (`roborock.vacuum.a144`) answers `get_status`, `get_timer`, `get_carpet_mode` and `get_water_box_custom_mode` over the cloud in the same second, and refuses `get_server_timer`. All the plugin could say about it was:

```
Cloud message with protocol 102 and id 10 received. Result: undefined
Schedule discovery for 1MDui…: type=undefined, value=undefined
Unable to reliably read Roborock schedules …: get_server_timer returned undefined
```

**The reason was decoded and then dropped.** A Roborock reply carries its payload in `result`. Both connectors handed `result` straight to the waiting promise without asking whether the reply had one, so a refusal resolved as a success whose value happened to be `undefined` — the same value a caller sees for a reply the parser could not read, and indistinguishable from a genuine empty answer. Whatever the robot said about why now never reached a log line, an error, or the user.

**A reply with no `result` is no longer treated as an empty answer.** When the robot spells out a refusal, the waiting caller gets it as an error naming the method and the robot's own words, over both the cloud and the LAN socket. When there is no result and no stated reason, the debug log prints the reply itself instead of the word `undefined`.

Deliberately narrow: a reply that carries a `result` is untouched, and an empty array stays an authoritative "you have no timers" rather than becoming an error. Only a refusal the robot actually stated changes behaviour.

11 new tests, red against the old code on both halves.

## 3.21.2

**Driving through a room still marked it cleaned. 3.19.7 was meant to fix that and did not.**

vp-debug12 reported in #9 that a room the robot merely crosses on its way somewhere else gets reported as cleaned. 3.19.7 answered it with a rule that a room has to be seen on 2 consecutive readings before it counts as visited. He reported the symptom unchanged, and guessed the reason himself: it takes longer than expected to move across the area. He was right, and the rule was defeated in two separate ways.

**It counted calls, not sightings.** The code that folds a live room into the Matter progress list runs from the 15-second poll, from the 60-second heartbeat, and from every pushed cloud message. The robot's position is refetched at most every 10 seconds. So two of those calls landing inside one fetch window read the _same_ physical position sample twice, and that was enough to confirm the room — one sighting, counted double. A room could be marked cleaned from a single glimpse, which is exactly the behaviour 3.19.7 set out to remove.

**And two readings was never long enough anyway.** Readings are 10 seconds apart, so the rule asked a crossed room to still be there roughly 10 to 20 seconds later — about as long as crossing a room takes. The gate was the same order of magnitude as the thing it was filtering, so it filtered very little.

**A visit is now measured in time, over distinct sightings.** Each reading carries the moment the position was observed, and repeated reads of one sample no longer count. A room is reported cleaned only once the robot has been seen inside it at least twice and those sightings span at least 90 seconds. Leaving the room ends the visit, so two crossings never add up to a clean.

90 seconds is picked against the two durations it has to separate rather than tuned: a crossing is bounded by the room's size divided by travel speed, which puts even a long traverse near 35 seconds, while covering a room in the robot's back-and-forth pattern takes minutes.

**If it errs, it errs toward saying less.** A room genuinely cleaned that somehow falls short of the dwell shows as pending mid-run, and the end of the run marks everything completed regardless — so that mistake corrects itself. Claiming a clean that never happened does not correct itself, which is the whole complaint.

4 new tests, 3 of which fail against the old rule, including a replay of a slow crossing and of one sample read by two publish cycles.

## 3.21.1

**A login retry could restart the plugin after Homebridge had already shut it down.**

3.20.0 added a retry for the case where the Roborock cloud is unreachable at boot, and wired it to shutdown properly. It was not the only retry in the file. The older one, on the login step itself, kept its timer handle in a local variable — so `clearTimersAndIntervals` had nothing it could clear even in principle, and nothing checked whether the adapter was still alive before the timer fired.

The window is up to 10 minutes wide. A boot where the network is not up yet arms the retry; if Homebridge stops the plugin inside that window — a restart from the UI, a config change, a child bridge reload — the timer still fires into the shut-down adapter and runs the full startup again: a fresh login, a new MQTT client, and a new set of poll intervals attached to an instance whose sockets had already been destroyed and whose pending requests had already been rejected.

**Both retries now check a shutdown latch, not just `bInited`.** That distinction is the actual fix. `bInited` is false both before a successful start and after a shutdown, so a retry callback that read it could not tell "still needs starting" from "already stopped" — which means the 3.20.0 retry had the same race, narrower but real, in the gap between the timer being picked up by the event loop and the clear running. A deliberate `startService` clears the latch, so restarting a stopped adapter in-process still works.

**The suite's `You are trying to require a file after the Jest environment has been torn down` is gone, and it was not what the last release assumed.** It was read as a stray cloud-retry timer in the library. The real source was the retry's own test file: the backoff test arms 8 real timers in a loop, nulling the handle between arms so the "only one in flight" guard lets the next one through, which orphans the 7 before it. Those fired 1 to 10 minutes later, inside whatever test happened to be running by then, and called `startService` — whose first statement requires the translations file. Unref'd timers cannot hold the worker open, so nothing failed; it just printed a warning that pointed at the library instead of at the test. All 8 are disarmed now.

5 new tests.

## 3.21.0

**You can now change the clean mode while the robot is already cleaning. This needed a change in Homebridge itself, and that change has now shipped.**

Until now a mode picked mid-run only moved the picker. The prep sequence that sends the mode to the robot runs before a start and nowhere else, so the robot carried on with the settings it began with, and the tile quietly disagreed with the floor. That was not an oversight in this plugin: Matter's RvcCleanMode cluster forbids a mode change outside idle unless the device advertises the `DirectModeChange` feature, and Homebridge had no way for a plugin to advertise it. [homebridge/homebridge#4001](https://github.com/homebridge/homebridge/pull/4001) added one, and it is merged and released in `2.4.1-beta.11`.

**What happens now.** A mode change while the robot is running or paused is sent to the robot immediately, and the picker holds your choice until the robot's own status agrees with it — up to 150 seconds, after which the picker gives up and follows the robot again with a warning line naming what it asked for. If the command fails outright, every piece of selection state rolls back to what it was and the controller is told the change failed, so a rejected change cannot leave the picker showing a mode the robot never took.

**On the empty-tank warning, which had to move with it.** The tank check deliberately read the robot's live water level rather than the picker, on the reasoning that a mid-run selection was never applied and so could not be trusted. That reasoning no longer holds, and left alone it would have raised a tank warning for water the robot had already acknowledged turning off. The applied-type pin is now the authority during the confirmation window.

**What you need to run it.** Homebridge `2.4.1-beta.11` or newer. On `2.4.0` the feature declaration is inert — that version has no concept of plugin-advertised Matter features, so nothing changes and nothing breaks. It follows the existing `enableMatterCleanMode` setting: leave it on and live changes are advertised, turn it off and neither the declaration nor the handler exists.

6 new tests.

## 3.20.1

**The resource half of the same review: seven things that leaked, hung on, or would have taken the bridge down given the right unlucky moment.**

**Every timer this library creates is now unref'd, and cannot become an unhandled rejection.** `src/timers.ts` has stated the policy since it was written — "a pending timer must never be why Homebridge cannot shut down" — and `src/` honours it at every one of its own call sites. `roborockLib` never imported that module, so all ~20 of its timers were ref'd, including each in-flight request timeout of up to 30 seconds, none of which were cleared on shutdown. Both fixes live in the 2 wrapper methods every timer in the library already goes through, so they cover all of them at once. The rejection guard matters more than it looks: Homebridge's `uncaughtException` handler is `process.kill(SIGTERM)` and node routes unhandled rejections into it, so one rejecting poll callback takes the whole bridge down. None can reject today — but `updateDataMinimumData` has no `try` in its 114 lines and survives only because each of its callees happens to catch, which is a contract nobody had written down.

**Shutdown now actually stops things.** `stopService()` cleared timers and nothing else. `client.end()` existed in exactly 1 place in the codebase, inside `reconnectClient`, and never on the shutdown path — so in the seconds between Homebridge's SIGTERM and its forced exit, robot frames kept arriving and being dispatched into disposed accessories, and a local socket closing in that window scheduled a _new_ reconnect and wrote diagnostics files into a bridge being dismantled. Both transports are closed now, and every pending request is rejected rather than left hanging.

**One throwing `dispose()` no longer skips the rest of shutdown.** The SHUTDOWN handler was a straight-line sequence, so a throw anywhere in it skipped `stopService()` — the step that stops the polling and closes the transports. A shutdown that half-runs is worse than one that fails loudly.

**A list that grew by 2 entries a minute, forever.** `processDockType()` runs on every status poll carrying `dock_type`, and the poll site's comment says that is safe because the function is idempotent. It is — for `commands`, `deviceStates` and `consumablesString`, which all use keyed assignment. `resetConsumables` was the one member using `.push`. Measured: 6 entries became 2016 after 1005 polls, about 86,400 a month per robot.

**A transient network failure no longer deletes your saved session.** The login error path made no distinction between "Roborock rejected your password" and "DNS was not up yet", and deleted both the stored session and the cached device list for either. On a boot where the router is still coming up that destroyed the only offline snapshot the plugin has. Only an actual refusal clears it now, and an unrecognised failure is treated as transport — deleting a good session costs a re-login, keeping a dead one costs one failed request.

**Two smaller ones.** A guard reading `photoGzipChunks != []` compared against a fresh array literal and was therefore always true, so it never guarded anything. And two concurrent `createClient` calls could each build a socket, with the later assignment orphaning the first — its handlers correctly declined to reconnect, so there was no storm, but the file descriptor stayed open for the life of the process. The new claim is released in a `finally`, because a leaked claim would be worse than the leak it prevents: that robot could never reconnect again.

17 new tests.

## 3.20.0

**Two ways the plugin could stop working and never start again. Both silent, both permanent until somebody restarted Homebridge.**

Neither was a crash, which is why neither had been noticed. The plugin stayed up and stopped doing its job.

### A classic robot that flapped offline was never polled again

`manageDeviceIntervals` stops both polling intervals when a robot reads as offline and restarts them when it reads as online. The restart half was unreachable for a classic robot: the only caller sits **inside the `get_status` handler**, so it runs only when a status poll succeeds — and `getStatusIntervalHandle` is the one thing driving those polls. Once they were cleared, nothing was left alive to notice the robot had come back. The one other caller, the home-data supervisor, filtered on B01 and skipped every classic robot deliberately.

`onlineChecker` reads the cached home-data snapshot, which lags by up to one refresh, so the trigger was ordinary rather than exotic: robot drops off wifi, comes back, its LAN socket reconnects first, the next local poll succeeds, the snapshot still says offline, both intervals die. From then on the tile froze on the last known state until the user pressed a button or restarted.

Same dead end at boot, for a different reason: the intervals are only started `if (device.online)`, so a robot that was offline when Homebridge started was **never polled at all** for the life of the process.

The supervisor now covers every robot. It runs on the home-data cadence, which is the same clock that decides `onlineChecker`'s answer, so a robot that comes back is picked up on the tick that notices it.

### A cloud outage during startup wedged the plugin permanently

`getUserData` returns a stored session **without touching the network**, so any install that has logged in once — essentially all of them — never reaches the login retry with backoff. It reaches `getHomeDetail` instead. When that failed, the plugin logged one warning and stopped.

The ordering is what made it terminal: `homedataInterval` and `reconnectIntervall` are created _after_ that call, and `initUser` was never reached, so there was no MQTT client either. **Not one timer existed that would ever try again.** A Pi rebooting after a power cut, with the router still coming up, registered nothing and sat idle until a human intervened. The README's "retries with increasing backoff, up to 10 attempts" described only the login step, which this path skips.

There is now a retry: 1 minute, doubling to a 10-minute ceiling, then holding there. Deliberately with no attempt cap — the failure it recovers from is "the network was not ready yet" and the device is unattended, so giving up means a person has to notice. One timer at a time, unref'd so it can never hold Homebridge open, cleared on shutdown, and reset by a success so a later outage starts from 1 minute again.

9 new tests, and the supervisor's own test previously asserted the skip that caused the first bug.

## 3.19.8

**A recovery line now names only a failure the log actually announced — and the test that says so had been failing on disk, uncommitted, for 3 days.**

Two things, and the second is the more uncomfortable.

**The log rule.** A B01 status attempt is logged at debug until the 10th consecutive failure, but the _recovery_ was announced at info from the first. With debug off, which is the default, a single transient miss that healed on the next tick told the user a channel had recovered from a problem they were never told about. On a robot with a flaky link that is a steady drip of good news about invisible bad news. The recovery is now announced exactly when the failure was — and no more than that, because a streak that did reach the warning must still get its closing line, or the log's last word on the channel stays "broken" long after it healed. The same rule was already written down in this file's own neighbour, `noteLiveRoomFetchRecovered`, whose doc comment says to announce a recovery exactly when the thing it reports on was itself announced "so the message and the behaviour it reports on cannot drift apart".

**The part worth saying out loud.** The test suite for that rule was written on 29 August, saved to disk, and never committed. `git status` had been showing it as untracked ever since. So it failed on every local `npm test` run for 3 days while CI stayed green — because CI only runs what is in the repository, and this was not. A suite that is red locally and green remotely is worse than no suite: it trains whoever runs it to expect failures and to scroll past them.

The test is now in the repository, where it fails 5 times against the old behaviour and passes against the new. Nothing about the release gate changes; the gate was never wrong. What was wrong was a file that only existed on one machine.

## 3.19.7

**Driving through a room is not cleaning it.**

Reported by vp-debug12 in [#9](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/9): with several rooms selected, a room the robot merely crossed on its way to the first target was reported as cleaned.

Exactly right, and the mechanism is one line. A room joined the confirmed-visited set on its **first** live-room detection, and a confirmed room is reported Completed the moment the robot moves on. One reading taken while crossing the hall was therefore enough to call the hall done — while it still had its whole clean ahead of it.

A room now counts as visited only after the robot has been detected in it on **2 consecutive** live-room readings. Readings are at least 10 seconds apart, so this asks the robot to still be there next time: true of a room being cleaned, false of a room being crossed.

Erring low is deliberate and is why 2 is enough rather than some larger number picked by feel. A room that really was cleaned but missed its second reading falls back to Pending mid-run, and the end of the run marks everything Completed anyway — so under-confirming corrects itself. Over-confirming is the one that lies, and it lies about work the robot has not done.

Crossing a room early does not disqualify it either: confirmation is about the current visit, so a room crossed at the start and cleaned properly later still completes.

3 tests, 2 of which fail against the old behaviour.

## 3.19.6

**The periodic poll no longer carries a cloud firmware check whose answer nothing reads. The check has in fact never run — a missing `await` disabled it — and the tempting one-character repair would have added roughly 480 discarded cloud round-trips per robot per day.**

`checkForNewFirmware()` sat in the poll chain and asked the Roborock cloud for `ota/firmware/<duid>/updatev2` once per robot per poll interval. Its own gate read `const isLocalDevice = !this.isRemoteDevice(duid)`, and `isRemoteDevice` is `async`. Negating a promise is false for every promise there has ever been, so the gate never opened and the body behind it has been unreachable for the life of this plugin. Every other caller of that method awaits it; this one line did not.

Adding the missing `await` was the obvious repair and it was the wrong one. The request's result goes to `setObjectNotExistsAsync`, which is a documented no-op here, and to `setStateAsync("Devices.<duid>.updateStatus.<field>")`, which nothing in the plugin, the settings UI or the diagnostics export ever reads. The firmware revision Apple Home shows comes from a different source entirely — the `fv` field in HomeData. So the repair would have bought an awaited HTTPS round-trip on the poll thread, per robot, every three minutes, for an answer with no reader, plus a `catchError` path able to log a warning once per poll whenever the OTA endpoint was unhappy. That is the same never-throttled retry loop that 3.19.0, 3.19.1 and 3.19.5 each closed one instance of, and it would have been introduced rather than found.

The call and the unreachable method are removed instead. Because the code could never execute, this changes no runtime behaviour on any robot: the same requests go out, the same values reach Apple Home, and nothing that had a reader lost one.

What is new is the guard. A test now pins the outcome rather than the implementation — a periodic poll may spend no cloud round-trip on an answer no one can read — and it was verified by applying the naive `await` and watching it go red at exactly 480 requests per simulated day.

## 3.19.5

**A room-list refresh that cannot succeed is no longer re-attempted by every periodic poll. On a Q10 it is not attempted at all, and on a Q7 whose map channel is down it now backs off instead of running 480 guaranteed-to-fail map reads a day.**

Room names on B01 robots come from the map channel, and because rooms rarely change a successful fetch is good for six hours. That six-hour stamp was written only on success — correct for the happy path, and the whole story for a refresh that never completes one. A robot that cannot answer never closes the throttle, so it was asked again by every periodic poll for as long as the plugin ran.

**On a Q10 (`ss*`) the answer could never arrive.** `get_map_list` has no Q10 translation, so the send choke point refuses it by name before anything reaches the wire. That refusal is correct and is caught quietly at debug level, but it is certain before the request is made, and it was being repeated every three minutes forever. This is the third loop of that exact shape: the status loop was gated in 3.19.0 and the live-room loop in 3.19.1, and this one was missed both times. It is now gated at the same place and for the same reason — at the function entry, because both call sites reach it through a check that matches _both_ B01 dialects.

**On a Q7 (`sc*`) the request is not refused, so the same missing guard cost real work.** A robot whose map channel is down ran a `get_map_list` on the wire plus a map read that waited out its full 20-second timeout, once per poll cycle — roughly 480 attempts a day for a room list that was not going to arrive, and in the uncached case it delayed the rest of the poll chain by that timeout each time.

Repeated failures now widen the gap, following the same rule the live-room fetch already used. The first failure is deliberately not slowed, so a single lost frame on a healthy channel still costs nothing. Past that the gap doubles from two poll cycles and is capped at 30 minutes, which stays far below the six-hour success cadence — a channel that comes back is picked up within the same half hour rather than at the next scheduled refresh. A success clears the accumulated penalty outright.

A reply that arrives but reports no current map is explicitly not counted as a failure. That is a robot still building its first map, and it must not be asked ever more rarely precisely while the answer is about to become available.

This changes retry timing only. No new request is introduced, and nothing is published to Apple Home that was not published before.

## 3.19.4

**An unmapped `error_code` is now logged with the state the robot was in when it appeared, because these codes turn out to describe transitions rather than faults — and a bare number cannot be reported usefully or mapped later.**

When a robot reports an `error_code` this plugin has no entry for, nothing is published to Apple Home and the number is named once in the log so it can be reported and mapped. That behaviour is unchanged and correct. What was missing was the context that makes the number mean anything.

Three distinct unmapped codes appeared on two B01/sc05 robots in a single log during one ordinary scheduled run, and each one was tied to a state change: 2105 only while docked and charging at 100%, 2110 one second after the run started, 2104 on the way back to the dock. Nothing was wrong with any of the robots — the run started, ran and docked normally. Establishing that required hand-correlating each code against the neighbouring publish lines across a 2574-line log. Someone filing a model report pastes the one line, so that context never arrived with it.

The line now names the robot's own state number and the Matter operational state derived from it. It also makes its own question answerable: "if the robot really is in trouble right now" cannot be judged from a number alone, and it was being asked while a robot was demonstrably cleaning normally.

The once-per-code-per-robot-per-run rule is deliberately unchanged. Keying the de-duplication on code _and_ state would name a lingering code again at every transition it survived, which is the per-poll log burial that rule exists to prevent.

No mapping is claimed for 2104, 2105 or 2110. They are still published as nothing, which remains the right answer for a number nobody has explained.

## 3.19.3

**A periodic cloud snapshot could overwrite live status with its own slightly older view, so a robot mid-clean briefly showed as docked. Reported with a measured sequence by [@jbyhb](https://github.com/jbyhb) in [#20](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/20).**

During an active clean an S7 published 99% / running, a periodic HomeData refresh then published 88% / stopped, and the next live frame restored 99% / running one second later. No robot loses and regains 11% of its battery in a second, so the two readings were not a sequence of events — they were two views of the same moment, and the slower one won.

**The cause is that HomeData was being promoted into the live cache.** Status reads prefer the live cache while it is fresh and fall back to the cloud snapshot once it is not, which is the right order. But parsing a HomeData poll into that cache also stamped it with the current time, so the poll presented itself as the newest live reading. Its values then took precedence over the genuinely newer transport frames until the next one arrived — and the freshness window it reset is the same one that decides whether live data is trusted at all.

HomeData is no longer written into the live cache. It stays what it is: the fallback. The 15-minute staleness window is unchanged, so if live reporting genuinely goes quiet the snapshot still takes over and the tile still self-heals — that path is now pinned by a test that advances the clock past the window and asserts the snapshot wins, so this fix cannot quietly turn into a stale tile pinned forever.

This corrects reporting only. It adds no command path and cannot move the robot.

Troubleshooting documentation for the Apple Home "Updating…" tile is revised again, and this time it makes the remedy stronger rather than weaker. The reporter in [#7](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/7) clarified when his tile recovered during six months of chasing it: only ever immediately after installing an iOS release, perhaps twice, and never spontaneously. Installing a release restarts the device. So the recoveries that read as version fixes are the same restart step 1 already recommends, and the page now says so — including the part that matters to anyone living with it, which is that a restart buys days to a week rather than a permanent fix.

## 3.19.2

**Two releases in a row gated one caller each against the same defect. This one changes the shape of the error that kept producing them, so the next caller is calm without having to know.**

3.19.0 stopped the status loop polling a Q10 (`ss*`) for a value the dialect cannot return. 3.19.1 did the same for the live-room loop. Both were the same class one loop apart, and a sweep of every send site has since confirmed no third loop is left. What had not been fixed was the reason the class kept surfacing as a warning rather than a debug line.

The send choke point refuses an untranslatable Q10 read correctly and by design. But it built that refusal with `ROBOROCK_TRANSPORT_REFUSED`, and `catchError`'s calm early exit matches only `B01_METHOD_UNSUPPORTED`. So the refusal missed the calm branch, picked up the transient-warning path, and came out as `Failed to execute get_status on robot … Future transient warnings for this robot will be logged at most once every 360 minutes` — a line that reads as a failing robot when the plugin declined to send by design.

**A Q10 having no equivalent for a read is a capability fact, not a transport fault.** It is permanent, identical for every Q10, and the same kind of condition as the B01/Q7 unsupported-method case that has always logged at debug. It now carries the unsupported code, so any caller that reaches it is quiet by construction rather than by remembering to gate itself.

**The reclassification is deliberately narrow, and the guard is part of the change.** The same helper builds three genuine transport refusals — an offline robot, an unavailable cloud link, a missing local socket — and those must stay warnings, because for those the robot really is unreachable and the user does need to know. Only the dialect-capability refusal is reclassified; the three transport refusals are pinned by tests that fail if a future change widens it.

One existing test asserted the old code. It was not wrong about the code — the code was the defect — and its two message assertions are untouched.

**A flaky test in the release gate is fixed, and it was found by this release rather than reported.** Two tests start a real Node child process and wait for it to exit, on jest's default 5-second timeout — the only tests in the suite whose cost is a cold interpreter start. Under full-suite load that is a coin flip: two consecutive runs each failed one of the two, a different one each time, while the file passed 21 of 21 in nine seconds on its own. Both now carry an explicit ceiling generous enough that only a genuine hang reaches it, and the suite-wide default is raised from jest's 5 seconds to 20 seconds because the class is wider than those two — a socket test connecting to a closed port failed the next run for the same reason. Twenty seconds is roughly 220 times the suite's mean test, so a test that reaches it is stuck rather than unlucky. A gate that fails at random either blocks releases it should not or teaches whoever reads it to wave failures through, and the second is the worse outcome.

Troubleshooting documentation for the Apple Home "Updating…" / "No Response" tile is corrected on two points, both from field reports rather than reasoning. An iOS update is no longer presented as the confirmed cure: one reporter's tile has stayed up since 26.6.1, while another on the same version has watched it lapse and return for six months, so restarting the affected Apple device is now the remedy the page leads with. And a note explains why the symptom appears on a robot vacuum and no other accessory — Apple Home requires a vacuum to be its own Matter node, so it is the only accessory Homebridge publishes outside the bridge, and therefore the only one whose subscription can die alone.

## 3.19.1

**The live-room loop was polling a Q10 for a map it cannot answer, and counting each refusal as a failure. Same defect 3.19.0 fixed in the status loop, one loop over.**

3.19.0 stopped the dedicated B01 status loop asking a Q10 (`ss*`) for `get_status`. The live-room loop has the same shape and was missed. It sends `get_map_list`, which has no Q10 translation and is not answered neutrally, so the send choke point refuses it by name and throws — correctly. The catch then counted that refusal as a failure and logged `Live-room map fetch has failed N times in a row` at warn level every fifth one.

It reached a Q10 because `refreshLiveRoomForDevice` gates on `pv === "B01"`, and `pv === "B01"` is both dialects — which is the entire premise of [#19](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/19). The Matter accessory drives it whenever the robot is in a cleaning run and `enableMatterServiceArea` is not false, and that setting defaults to on.

**That timing is what makes it worth a release on its own: the live-room loop only runs while the robot is actively cleaning.** The first two attempts are 10 seconds apart before the backoff widens, so the first warning lands roughly two and a half minutes into a clean — during the exact operation [#14](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/14)'s reporter had just confirmed working on the only Q10 in the field. A fourth round of chasing this plugin's own designed refusal was one clean away.

A Q10 is now skipped before the request is built, and says once per robot that the dialect sends no reply to a map read, so no room is reported during a clean. No state entry is allocated and `null` is returned — the same answer the disabled-tracking branch already gives, so every caller already handles it. The gate sits at the loop's entry rather than at its two call sites, because one of those call sites is the `pv === "B01"` test that caused this.

A Q7 is unchanged and pinned as such: it is still fetched, an unrecognised B01 model is still treated as a Q7, and a Q7 that genuinely stops answering still raises the warning. The warning is kept off a robot that cannot answer by design, not removed.

The 6-hourly room-name refresh also sends `get_map_list` and is also refused on a Q10, but it logs at debug and is left alone. It wastes a request; it does not tell anyone their robot is failing.

## 3.19.0

**The B01 Q10 command dialect has now been run on a Q10, and it works. That measurement is the whole reason this goes to `latest`.**

[@niclasreich](https://github.com/niclasreich) installed `3.19.0-beta.1` on his Q10 S5 (`roborock.vacuum.ss07`) and reported on 27 August 2026 that the robot starts cleaning from both the Homebridge interface and the Home app, and that commands are accepted. Every datapoint code in the dialect was read from python-roborock's docstrings rather than measured here, and the beta shipped saying so; his robot is the first `ss*` device this project has ever had a result from. Commands, return to dock and the state the tile shows while returning all behave as the dialect predicts.

Nothing in the command path changed between the beta and this release. It is the same code with a field result behind it, which is the only thing the beta was waiting for. Details of what the dialect covers are in the `3.19.0-beta.1` notes below.

**A Q10 is no longer polled for status, and no longer reports its own by-design refusal as a failure.** The dedicated B01 status loop asked every Q10 for `get_status` every 25 seconds. The send choke point refused each one correctly — a fire-and-forget dialect cannot answer a read — but a refused request was still a counted one: each refusal incremented the consecutive-failure tally and every tenth logged `B01 status has failed N times in a row` at warn level. On a healthy Q10 that is a warning every four minutes about a robot doing exactly what its protocol says. It was the first thing the beta put in the one field log this project has, and a diagnostic that fires on a working robot is worse than none — it is the same false alarm that made [#14](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/14) take three rounds to diagnose. The loop now skips a Q10 before the request is built and states once, per robot, that the dialect sends no reply, that state comes from home data over HTTPS instead, and where the remaining work is tracked. Asking a question whose refusal is certain before it is asked was never a diagnostic.

A Q7 is unchanged and pinned as such: it is still polled, its answer is still mapped and dispatched, an unrecognised B01 model is still treated as a Q7, and a Q7 that genuinely stops answering still raises the warning. The warning is kept off a robot that cannot answer by design, not removed.

**Known and not fixed by this release: a Q10's tile does not follow the robot into a clean.** State on a Q10 still comes from the home data snapshot, so docked and charging read correctly while a run in progress does not. Reading state from the datapoint updates the robot pushes is the remaining half of [#19](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/19). It is deliberately not in this release: it is the one change that has to touch the incoming MQTT path that Q7 and Q10 share, and bundling it with the promotion of a command path that has exactly one field measurement behind it would risk three working Q7 robots to save a release.

A cloud request that times out without anything having arrived during it now says what its message total actually counts. It used to end with a bare `(8 since startup)`, and that figure is incremented in the MQTT receiver alone — a robot answering on the local socket never touches it, while the 180-second poll chain a reader would compare it against runs over whichever transport is up.

Measured on an S8 Pro Ultra (`roborock.vacuum.a70`) on 27 August 2026: one transient cloud timeout reported `(8 since startup)` after eight and a half hours of polling. Read as a like-for-like ratio that says a link dropping about 95 % of replies; read correctly it says nothing is wrong, because the robot had been answering locally the whole time. The sentence now states that the total covers cloud traffic only and that a low number on a locally-answering robot is normal. A diagnostic that exists to stop wrong conclusions should not hand the reader a ratio that cannot be taken.

## 3.19.0-beta.1

**Beta channel only — `npm install homebridge-roborock-matter@beta`. This does not go to `latest` and no existing installation will pick it up.** It contains the first implementation of the B01 Q10 command dialect, and there is no Q10 robot available to this project to verify it on. Every datapoint code in it is read from python-roborock, where the docstrings mark them verified live against `ss07` hardware, but none of it has been measured here. Shipping that to everyone on `latest` on the strength of someone else's docstrings would be the same mistake [#14](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/14) already cost three rounds of wrong diagnosis.

3.18.0 stopped this plugin sending Q7 frames to a Q10, which the robot discards, and refused instead. That made the plugin honest on a Q10; it did not make one work. This is the command half of [#19](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/19).

A Q10 command is now published in the dialect the robot speaks — a direct write to a numbered datapoint, `{"dps":{"201":1}}`, with no method name, no `msgId` and no datapoint 10000. Start, stop, pause, return to dock, empty the dustbin, room clean, suction level and clean mode are covered.

**The dialect is fire-and-forget, and that shapes the rest of the change.** A Q10 sends no RPC reply at all, so a Q10 request no longer registers a pending request or arms a timeout. Arming one would guarantee expiry on a perfectly healthy link, and reporting that expiry is exactly the false "the Roborock cloud has gone silent" that sent #14's reporter chasing a fault at Roborock. A command resolves when the write leaves the plugin, which means published and not acknowledged; the state Apple Home shows still comes from the optimistic-state machinery, which corrects itself against what the robot reports.

**Reads stay refused on a Q10, and that is the dialect rather than unfinished work.** `get_status`, `get_map_list` and `get_prop` exist to return a value, and a protocol that never answers cannot return one. Serving them would hand the caller something the robot never sent and publish that non-answer to Apple Home as the robot's state. A Q10's status continues to come from home data over HTTPS, a separate transport measured working in #14. Reading state from the datapoint updates the robot pushes is the remaining half of #19.

Two known limitations, stated rather than papered over. Resume restarts a whole-home clean instead of resuming, because the plugin has no distinct resume method to map onto the dialect's dedicated `205`. And `find_me` is refused: upstream has a datapoint number for it but no verified payload, and guessing one on hardware nobody here owns is how #14 happened.

The two clean-type tables are not interchangeable and neither are the two suction scales — Q7 is vacuum=0, vac+mop=1, mop=2 while Q10 is vac+mop=1, vacuum=2, mop=3, and Max+ is 5 on a Q7 and 8 on a Q10. The numbers overlap, so the wrong table does not fail loudly; it mops when it was asked to vacuum. Both directions are pinned by tests.

Q7 is unchanged. Three `sc*` robots run on the maintainer's own bridge, and the regression cover asserts that a Q7 still builds the RPC envelope on datapoint 10000, still arms its timeout, still registers its pending request, and that nothing addressed to a Q10 can ever carry the Q7 form — checked against the whole B01 method surface rather than a list of today's commands, with a guard that fails if that check ever becomes vacuous.

## 3.18.0

**`B01` is two wire protocols, this plugin only implements one of them, and it has been sending the wrong one to Q10 robots.** This is the root cause behind [#14](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/14), where [@niclasreich](https://github.com/niclasreich)'s Q10 S5 (`roborock.vacuum.ss07`) could not run a single command. The two diagnostic releases before this one, 3.17.7 and 3.17.8, both measured the symptom correctly and both pointed at Roborock's cloud. The cause was here.

Robots reporting `pv === "B01"` fall into two families that share the 23-byte framing and the AES-128-CBC payload encryption but not the request format. The Q7 series (`sc*`) carries an RPC envelope on datapoint 10000, with a method name and a `msgId` to correlate the reply against. The Q10 series (`ss*`) writes numbered datapoints directly — no method, no `msgId`, no datapoint 10000 — and does not reply at all, because the dialect is fire-and-forget.

This plugin built the Q7 envelope for every B01 device. On a Q10 that means every command ever sent was a well-formed, correctly encrypted frame addressed to a datapoint the robot does not have, which it discards, followed by the plugin waiting out a full timeout for an acknowledgement the protocol never sends. `b01FamilyForModel()` has classified `ss*` as Q10 since 3.15.5, but that flag only ever reached the suction scale and the fault tables — never the wire format. Getting the enums right for a dialect that is never spoken correctly bought nothing.

Q10 commands are now refused at the send choke point, immediately and by name, instead of being published in a form the robot cannot read. The refusal is classified as transient, so it is throttled like any other and does not arrive as a plugin error with a stack. Methods that are answered without touching the wire are unaffected, which keeps the room-mapping fix from 3.17.3 intact — the timeout the same reporter originally opened #14 about.

This makes the plugin honest on a Q10 rather than functional on one. It is a smaller change than it sounds and deliberately so: Q7 and Q10 share this code path, Q7 devices work, and implementing an unverifiable Q10 dialect in the same change that could regress them is a bad trade. Real Q10 support — the dialect encoder, the datapoint tables, a fire-and-forget command path, and status from pushed datapoint updates — is tracked in [#19](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/19).

Q7 behaviour is unchanged and covered by regression tests asserting that `sc*` models, and any unrecognised B01 model, still publish exactly as before. Two comments in `b01Q7Adapter.js` that listed `ss07` as a Q7 model have been corrected; that claim is what made #14 take three rounds to diagnose.

## 3.17.8

**The cloud-timeout diagnostic added in 3.17.7 drew a conclusion it could not support, and this corrects it.** Found by [@niclasreich](https://github.com/niclasreich) acting on it in [#14](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/14): he updated, read the new sentence, and reported the answer it gave — that no reply had ever arrived from his Q10 S5.

When no message had been attributed to a robot, 3.17.7 stated that "the reply never arrived rather than arriving unrecognised". That only follows if every inbound frame is either counted or logged where a user can see it, and one path is neither. The MQTT receiver drops a message before the counter whenever its topic matches no known robot, and that path logs at debug. A reply arriving on a topic the plugin cannot attribute is precisely "arriving unrecognised" — the one possibility the sentence ruled out. The other two ways a frame can be discarded are already visible, so they were never the gap: an undecodable message logs at error, and a missing local key warns once.

Frames that match no known robot are now counted account-wide — attribution is what failed, so there is no robot to file them under — and a cloud timeout reports total silence only when nothing arrived on any topic. If unattributed frames did arrive, the timeout now says so and names it as a fault on this side, because that is the difference between a robot that never answers and one whose answers this plugin is throwing away. An adapter that cannot supply the count states the observation and draws no conclusion at all.

Diagnostics only, as in 3.17.7. No change to when requests are sent, how long they wait, or what is retried, and a local timeout remains untouched.

## 3.17.7

**A cloud request that times out now says whether the robot answered at all.** Raised by the log [@niclasreich](https://github.com/niclasreich) posted in [#14](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/14), where every single Roborock request to a Q10 S5 timed out — status polls, the clean-type write, the start command — while the MQTT connection state read `true` throughout.

That combination has two causes needing opposite responses. Either no reply ever arrived, which points at the robot or the account, or a reply did arrive and could not be matched to its request, which points at a correlation bug in this plugin. The plugin already knew which: the MQTT receiver attributes every message it decodes to a device. But the three paths that could have said so — an unmatched topic, an unsolicited message, an ordinary cloud reply — all log at debug, so the fact never reached the warning a user reports. Two rounds of questions went by without it.

A cloud timeout now names what the link did while the request was outstanding: nothing at all since startup, some messages while this request was pending, or messages earlier but none during it. The counter is incremented only after a message has been attributed to a robot _and_ decrypted, so a link delivering only garbage cannot read as alive — an undecodable message already logs its own error and is deliberately not counted.

Diagnostics only. No change to when requests are sent, how long they wait, or what is retried; a local timeout is untouched, because MQTT receipts say nothing about a local socket.

## 3.17.6

**Optional HomeKit switches keep the name and the place in Home you gave them across a Homebridge restart.** Two independent reports of the same class of fault, from the two people using these switches most, and both are fixed here by their own pull requests.

**The Empty Bin switch.** Reported by [@pponce](https://github.com/pponce) in [#16](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/16) and fixed by [@jbyhb](https://github.com/jbyhb) in [#17](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/17), who had independently hit it on an S7. A renamed switch reverted to its generated name on restart, and one removed from Home View came back — the second symptom being the useful one, because it says HomeKit watched the accessory leave and return rather than merely redraw.

The cause is a question asked one poll too early. Whether a robot can auto-empty is read from its dock type, and some classic robots — the S7 among them — omit that capability from the account data and report the attached dock only in the first live status poll. Startup reconciliation ran before that poll arrived, read the absence as "this robot has no auto-empty dock", and unregistered the cached switch; the first `get_status` then supplied `dock_type: 1` and the capability update built it again. That unregister/register pair is a new accessory as far as HomeKit is concerned, and a custom name, a room and a Home View placement all belong to the old one. The reporter's second robot never showed the fault because its dock capability _is_ in the account data, so its switch was never in doubt.

An already-cached Empty Bin switch is now preserved through that short window where the dock is not yet known, and only through it. Nothing new is published for a robot whose dock is genuinely unsupported, and once a live capability update does arrive for a robot it is authoritative — a supported dock keeps the same accessory identity, an unsupported one still removes the switch. Both halves of that rule are pinned by a test.

**The schedule switches.** Reported and fixed by [@pponce](https://github.com/pponce) in [#15](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/15), found in live use of the schedule support he contributed in 3.16.0. A custom schedule name did not survive a restart and the schedule group tile was recreated.

One teardown path was serving two unrelated purposes. Stopping schedule work at a normal Homebridge shutdown and deliberately withdrawing the switches — because the feature was turned off, or the robot removed — ran the same code, and that code removed the Switch services and rewrote the cached accessory topology. For the shutdown case that discarded HomeKit's side of every schedule switch on the way out, every time. The two are now separate: a normal shutdown stops in-memory work and leaves the services exactly as they are, while intentional withdrawal still clears them.

Names and identity are also now kept apart. A schedule service's identity stays its schedule-ID-derived subtype, its generated display name is derived from the vacuum, and a name you set in Home is preserved across refreshes, schedule renumbering and restarts — while a blank or whitespace-only name is repaired to the generated one. A schedule service is removed only when a refresh that is known to have succeeded no longer lists its ID; a failed or untrusted refresh changes nothing, and a schedule merely switched off stays present and off.

No change to cloud request behaviour: no new polling, and the existing cache, coalescing, backoff and post-write verification are untouched. Verified in the field by the reporter across 15 schedule services on two vacuums, including a custom Home name surviving a restart and enable/disable round-tripping to the Roborock app both ways.

## 3.17.5

**A network outage no longer takes the Roborock account offline until Homebridge is restarted.** Found on the maintainer's own server, which lost DNS for about 75 minutes on 25 August 2026. Every other plugin on that bridge recovered by itself — the Tado platform was making successful API calls again 35 minutes after its last name-resolution error. This one did not. It logged `B01 status has failed 1070 times in a row … the Roborock cloud connection is not available` continuously for **1 hour and 44 minutes after the network was healthy again**, through three scheduled hourly reconnects, and came back only when a plugin update restarted the child bridge — instantly, on the very same saved session, which is what ruled out the credentials and pointed at the reconnect itself.

The reconnect tore the client down without forcing it. An unforced teardown waits for the MQTT client's outgoing queue to drain first, and a link that has just died still holds messages nobody will ever acknowledge, so that wait never ends. The teardown therefore never completed, the client stayed permanently marked as disconnecting, and a reconnect declines to act on a client in that state. The latch also fed itself: each later teardown returned early on the same flag, so every hourly retry after the first was a silent no-op. That is why three hours of log carried no MQTT error, no close and no connect — nothing was happening at all.

Reconnects are now forced, which is the only correct behaviour on the single path that calls them: there is no reason to wait for a queue to drain over a connection already concluded to be dead. The upstream detail the fix depends on is pinned by a test, so if the MQTT library ever changes that contract the suite reports it rather than the field doing so.

## 3.17.4

**The "no mapping for these fields" warning no longer asks you to report fields this plugin already maps.** Raised by the log [@jcoz00](https://github.com/jcoz00) posted in [#6](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/6), whose Qrevo CurvX was told the plugin has no mapping for **eighteen** `get_status` fields and that a GitHub model report quoting the line is how they get added. Fifteen of those eighteen are named in `deviceFeatures.js` already. There was nothing for a report to add, and the three fields that genuinely were news sat buried in a list of fifteen that were not.

The message was asking the wrong question. A robot's status table starts as a copy of the plugin's baseline and capability detection adds to it, so "this field is not switched on for **this robot**" and "this plugin has never heard of this field" are different questions — and only the second one is worth a user's time. The warning asked the first and reported the answer as the second.

Each case now says what it means. A field no table anywhere names is still warned about once, by name and value, and still worth a model report; for the CurvX that is three fields rather than eighteen. A field the plugin maps but this robot's capability gate did not switch on is a debug line that says so, once per field per robot, and does not point anyone at GitHub. The repeat line that followed it on every subsequent poll is gone for that case — fifteen lines a minute saying nothing the first one did not.

**No change for [#8](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/8), and the first draft of this entry said otherwise.** The nine fields [@skmzwanke](https://github.com/skmzwanke)'s Saros 10 reported went into the baseline table in 3.4.4, which means they have been recognised for every robot ever since and that warning has been quiet for months. What made them look outstanding was a test fixture that mocked them as unmapped — a fiction the old code could not detect and the new code can. The fixture is corrected; the shipped behaviour for that robot is unchanged.

Nothing about which fields are read, published or acted on changed — this release changes only what the log claims. The declared set of capability-installable fields is derived from the source by a test that scans for every writer, so a new capability cannot reintroduce the wrong warning without the suite failing.

## 3.17.3

**Q7- and Q10-series robots no longer spend a cloud request per poll on an answer the plugin cannot read.** Reported with a diagnostics export by [@niclasreich](https://github.com/niclasreich) in [#14](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/14), whose Q10 S5 (`roborock.vacuum.ss07`) logged `Failed to execute get_room_mapping … method prop.get timed out after 10 seconds` while the MQTT connection was reported as up.

The two method names in that line disagree, and that was the clue. `get_room_mapping` is the caller's label; `prop.get` is what actually went on the wire. The classic room-mapping routine opens by fetching `get_status` in order to read `map_status` and derive a floor number — and on these robots `get_status` translates to a real `prop.get`. `map_status` is a v1-only field that a Q7/Q10 status dictionary has never carried, so the reply could not have been used whatever it said. The request itself was already answered locally from the dialect's neutral table without touching the network, which is exactly why the existing skip did not catch this: the harmless call was making a second, expensive one.

The classic flow is now skipped outright for these robots, which is where their room data was never coming from in the first place — it arrives over the protobuf map channel. That removes one cloud round-trip per poll cycle per robot, along with the `No room mappings returned` notice and the empty room-list announcement that repeated at the same rate. Robots on the classic protocol are unaffected and still read `map_status` exactly as before.

**This does not by itself explain a robot that ignores commands from Apple Home**, which is the other half of that report; it removes a wasted request and the misleading error line it produced.

## 3.17.2

**The Qrevo CurvX's dock can now offer the Empty Bin switch.** Reported with a diagnostics export, and then settled by hand, by [@jcoz00](https://github.com/jcoz00) in [#6](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/6). His a185 reports `dock_type: 20`, and the dock table this plugin inherited stops at 9 — so the CurvX fell through to "unknown dock" and was treated as having no auto-empty capability, which kept the optional Empty Bin switch added in 3.17.0 from ever being offered for it. Dock type 20 is now a named, recognised auto-empty dock.

The switch is still opt-in and still off by default, so nothing changes for anyone who has not asked for it.

**Only the auto-empty is granted, and only because its owner confirmed it.** Upstream also names a dozen dock codes above 9 that this project has had no report for, and none of those was added — a capability granted on a table alone is what cost a Q Revo S owner a suction level its robot does not have in [#10](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/10). Wash and dry are unconfirmed on this dock and stay unclaimed. A test now pins both halves: dock type 20 is in the set because an owner said so, and the codes nobody has reported stay out until one does.

## 3.17.1

**Closing the plugin's settings page could print a Node crash dump into your Homebridge log.** Reported with the log to prove it by [@jcoz00](https://github.com/jcoz00) in [#6](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/6). The Homebridge UI runs the settings-page server as a child process and closes its IPC channel the moment the page goes away; every reply that server sends is a `process.send()`, including the `ready()` handshake it fires before serving a single request. A send that loses the race against that close is reported asynchronously as an unhandled `'error'` event, which is fatal — so a closed settings page ended in `Error: write EPIPE`, a stack trace and a `Node.js v24.19.0` banner in the log. Nothing was broken and nothing in the log said so. A dead channel now ends that child process quietly; every other error stays exactly as loud as it was.

**A robot's dock capability is announced when it changes, instead of on every poll.** `dock_type` rides along in nearly every `get_status`, and 3.17.0 told the platform about it each time, re-running the HomeKit action-switch sync roughly once a minute per robot. At default settings that sync returns immediately, but anyone who had switched the Empty Bin action on for a robot whose dock cannot auto-empty collected a `Not publishing the Empty Bin switch…` debug line every minute per robot — enough to shorten the useful reach of the debug log. Detection itself still runs on every poll; only the announcement is gated, and a dock type that genuinely changes is still announced.

## 3.17.0

**Compatible auto-empty docks can now expose an optional Empty Bin action switch in Apple Home.** Contributed by [@jbyhb](https://github.com/jbyhb) in [#13](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/13). It uses the same opt-in HomeKit action-switch bridge as Start, Dock, Pause and Find, appears only when the robot reports dust-collection support, and sends the dock's native `app_start_collect_dust` command through the normal confirmed command path. A cached status that does not show the robot docked is advisory rather than a hard gate: the robot is the authoritative judge and its refusal follows the existing command-error path.

**Live dock-type capability detection is fixed.** Found and fixed by [@jbyhb](https://github.com/jbyhb). The inherited status handler passed the literal field name `"dock_type"` to `processDockType()` instead of the numeric value reported by the robot, so that path never enabled any dock capability. Worse, under Homebridge the surrounding loop never reached the call at all: the branch sits behind an ioBroker object-database check that can only fail here, so it was dead code on top of a wrong argument. The live value now reaches the feature detector before that compatibility gate, allowing classic robots such as the S7 to expose capabilities their HomeData feature bits omit. A cross-layer test pins the auto-empty dock types so the API's early-discovery list and the command table cannot drift apart.

## 3.16.0

**The schedules you built in the Roborock app are now switches in Apple Home — the project's first feature from an outside contributor.** Contributed by [@pponce](https://github.com/pponce) over four review rounds, requested in [#3](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/3).

A Roborock schedule has always been invisible to Apple Home. You could build a weekday morning clean in the Roborock app, but nothing in the Home app could see it, so no automation could suspend it while you were away — the only way to pause a schedule was to open the Roborock app and do it by hand.

Turn on **Add Home app schedule switches** and each robot gains a grouped `<robot> Schedules` accessory holding one switch per schedule on your account. Off disables that schedule on the Roborock side; on enables it again. Unlike the action switches these are not momentary — each one reports whether its schedule is currently active, so "is the weekday clean on?" is answerable from the Home app.

- **They enable and disable; they do not author.** Days, times, rooms and clean modes stay in the Roborock app, because that is where those settings live. A schedule deleted there takes its switch with it on the next refresh, and a new one gains a switch the same way.
- **Switches are named positionally** — `<robot> Schedule 1`, `Schedule 2` — because the Roborock cloud does not give schedules names to borrow. Rename them in the Home app if the order is not enough.
- **Off by default,** because turning it on adds accessories to your Home app. Like the action switches, these are HomeKit accessories on the plugin's child bridge and need their own pairing — not the robot's Matter code.

**A failed schedule refresh no longer deletes the tiles.** This is the part worth reading even if you never turn the feature on, because it is the failure mode the review rounds were spent on. An earlier revision unregistered the schedule accessory whenever the cloud request failed, and a transient Roborock timeout is not evidence that your schedules are gone. An accessory that disappears takes its room assignment, its name and every automation pointing at it with it, and none of that comes back when the next refresh succeeds. Three outcomes are now told apart:

- **The cloud answered and reported schedules** — sync them, nothing else.
- **The cloud answered and reported no schedules** — the account genuinely has none, so removing the accessory is correct.
- **The request failed** — keep the switches Homebridge restored from its cache and reattach their handlers, so they heal themselves on the next successful read instead of being torn down.

**A verification read can no longer join a refresh that started before the write it is verifying.** Writes are coalesced against in-flight refreshes, and a `verify()` that attached to an older request could observe pre-write state and roll a successful write back. The refresh now records when it started, and a verification only joins one started at or after its own write.

**Also in this release:** the plugin's own settings schema documented every one of its 26 options except the new one; that description now exists, and the feature is documented in the README alongside the action switches and sensors rather than only in the changelog.

## 3.15.5

**B01 is two protocol families, and this plugin treated them as one.**

`pv === "B01"` covers the Q7 series (`sc01`, `sc05`) and the Q10 series (`ss07`). They are not the same wire protocol, and everything B01 went through the Q7 tables. On a Q10 that meant:

- **Max+ sent `wind: 5`, a value that does not exist in its scale.** The Q7 scale is 1–4 with Max+ at 5; the Q10's is 0–4 with Max+ at **8**.
- **The robot's own Max+ never came back.** An inbound `wind: 8` resolved to undefined, so the mode the user had actually selected never reached Apple Home.
- **A finished clean looked like a fault.** Upstream confirms `501` on Q10 hardware as "cleaning completed, returning to the dock", firing after every task — but 501 is not in the Q7 informational set, so a Q10 would sit at a non-zero error code permanently. The 2 families are documented upstream as disagreeing about 500, 501, 503, 569 and 570.
- **`wind: 0`, a genuine off level on the Q10, had nowhere to go**, because the Q7 has none.

Both scales are now read from python-roborock's own enums — `SCWindMapping` and `YXFanLevel` — rather than inferred. The family is derived from the model suffix, **anchored**: upstream uses an unanchored `if "ss" in model_part`, which would misroute any future model that merely contains those letters, and that is deliberately not copied. Anything unrecognised stays Q7, which is what every B01 device was treated as before, so no unknown model is made worse.

**Nobody has reported a Q10 yet.** This is a correctness fix ahead of the first one rather than a repair, and it is shipped now because the alternative is that the first `ss07` owner installs the plugin and finds a Max+ button that sends a value their robot has never heard of.

6 new tests, 5 of which fail against the single-family version.

Found by a systematic audit of this plugin's model tables against upstream — which also confirmed the plugin does **not** share 3 upstream defects worth naming, since the temptation on reading a reference implementation is to converge on it: an unknown model here grants no capabilities rather than silently becoming a top-of-range Qrevo MaxV; model matching is anchored rather than substring; and dock drying comes from the robot's own capability bit rather than being inferred by excluding 3 known dock types.

## 3.15.4

**Apple Home read "Roborock" and then "Roborock Qrevo S". The Model row no longer repeats the Manufacturer row.**

n0rt0nthec4t opened [#10](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/10) asking for two rows: Manufacturer "Roborock" and Model "Q Revo S". Both halves have now landed — the Manufacturer row was Homebridge's, fixed upstream in [homebridge/homebridge#3996](https://github.com/homebridge/homebridge/pull/3996) and out in `2.4.1-beta.3`, and the Model row was ours, given a real name in 3.15.0. Put together, they read as a duplicate, which is what he came back to say.

3.15.0 argued the opposite — that a name without the brand "reads as a bare SKU" — and that reasoning was wrong for a reason worth recording: there is no surface where this string appears without the manufacturer beside it. Apple Home's accessory details, the Homebridge UI and the HAP sensors' Model characteristic are all fed from `manufacturer` and `model` together, and the first is unconditionally "Roborock".

- The Model row now reads **"Qrevo S"**, **"S8 Pro Ultra"**, **"Saros 10R"** and so on, on all 34 known models.
- **The name table is unchanged and still carries the brand.** Every entry is upstream `copystring/ioBroker.roborock`'s own `VacuumProfile.name` verbatim, and the cross-check that catches a name hung on the wrong robot compares in that form. The de-branding happens at the display edge, not in the data.
- **A model with no upstream name is still shown as its raw code, untouched.** `roborock.vacuum.sc05` is the robot's own string, not a name this plugin composed, and shortening it would invent a model that does not exist.
- Still display-only. Every poll profile, feature lookup, capability branch and `isSupportedDevice` call keys on the raw code, and the test that reads the source and fails if a model _comparison_ is ever fed a display value is unchanged.
- No re-pairing. `ProductName` is a Fixed-quality Matter attribute, so it is never persisted and the new value applies on the next restart.

Also settled in #10, with no code change needed: the **Q Revo S offers Quiet, Balanced, Turbo and Max** and nothing above it, so `roborock.vacuum.a104` stays out of the Max+ suction list and no owner pays a re-pair for a level their robot does not have.

## 3.15.3

**An empty water tank told Apple Home a vacuum-only run was blocked, and Apple said so every 2 minutes.**

vp-debug12 confirmed in [#9](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/9) that 3.15.2 fixed the status line — the tile now reads "Limpiando" during a run instead of "Desplazándose" — and reported this in the same breath: a **"Fill the water tank"** notification, arriving every 2 minutes, on a robot set to **Vacuum**.

Apple does not draw the Matter fault attribute as a passive warning. It draws WaterTankEmpty as a **blocking** condition, and it says so in words:

> Rellena el depósito de agua
> "Roborock Qrevo" empezará a limpiar cuando se llene el depósito de agua.
>
> _(Fill the water tank. "Roborock Qrevo" will start cleaning once the water tank is filled.)_

On a vacuum-only run every word of that is false. The robot is not waiting for water, it will not start cleaning when the tank is filled, and it needs nothing from anybody. This was never a question of when a warning is welcome — the plugin was asserting a block that did not exist, and Apple re-notifies about a block for as long as it stands.

**The fault is now published only when water is actually in play.** An empty tank on a vacuum-only run publishes `NoError`, so switching the tile to Vacuum stops the notifications rather than merely not starting them.

- "Vacuum-only" has to be something that was **said** — by the user picking a mode, or by the robot reporting one. The selection defaults to Vacuum on every restart and is not persisted, so treating that default as a choice would have silenced the tank warning on every robot until somebody happened to touch the mode picker.
- Suction levels reduce to their base clean type, so Max Vacuum counts as vacuum-only like the rest of the family.
- During a run the robot's own report wins, deliberately unlike the mode picker: a mode picked mid-run is not applied mid-run, so a robot physically mopping with an empty tank is still blocked whatever the picker shows. The mode picker reports intent; this reports what is happening to the floor.
- A real robot fault is not swallowed with the tank — once the tank is ruled out, the robot's own error takes the attribute as usual.
- The HomeKit **Water Tank Empty** contact sensor is unchanged and still reports the tank whatever the mode is. It states a fact and makes no claim about what the robot is going to do, and automations are built on it.

## 3.15.2

**3.15.1 only fixed the runs you start in Apple Home, and most runs are not.**

3.15.1 stopped a whole-home clean from telling Apple Home that the robot had not started yet. It worked — but it ran from the Matter start handler, which means it only ever fired for a clean somebody tapped in the Home app. A clean started **in the Roborock app**, by a **schedule stored in that app**, by the **button on the robot** or by a **voice assistant** never touches that handler. It arrives here as a status change and nothing else, so the progress list stayed empty — or stale all-completed from the last Home-app run — for the entire run, and Apple went on saying "Traveling to Room" / "Desplazándose" exactly as before.

That is very likely how [#8](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/8) and [#9](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/9) start their robots, so for them 3.15.1 may well have changed nothing at all.

The asymmetry was the tell, and it is worth writing down as a habit: **finishing a run was already status-driven and starting one was not.** When one half of a pair reads the robot and the other half only reads commands, the half that reads commands is a bug waiting for a user who does not use commands.

- A robot that reports it is cleaning now announces the run's scope as `operating`, however the run was started.
- The guard is the robot's **own** state, not the one shown on the tile. With extended operational states switched off, a dock washing the mop or emptying the bin is reported as `Running` — and a dock doing its chores must not claim the robot is cleaning every room in the house.
- A room clean picked in Apple Home is never widened. Anything still `operating` or `pending` is a run that was already announced, with a narrower and better-known scope than this can produce.
- `currentArea` still stays empty on a run of unknown position, and live map-position tracking still narrows the claim to one room the moment it resolves one.

## 3.15.1

**A whole-home clean told Apple Home the robot had not started yet, for the whole run.**

vp-debug12 reported it in [#9](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/9): the tile says "Desplazándose" — Moving — when the robot leaves the dock, and never changes to "Limpiando" while it cleans. skmzwanke reported the same thing in [#8](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/8) months and many versions ago, in English: "Traveling to Room" for an entire run.

Apple's status line during a run comes from the Service Area progress list, not from the operational state. It reads "nothing is operating" as _the robot is on its way_. For a room clean the plugin marks the requested room operating and Apple says the right thing. For a **whole-home** clean it marked every room `Pending`, because the robots do not report which room they are physically inside — so Apple was told, truthfully in one sense, that the robot had started none of them, and said so for an hour.

2.3.1 already tried this. It moved a full clean from an empty list to an all-pending list hoping the label would improve, and said out loud that whether it did was up to Apple's renderer. It did not, and 2 users have now reported the same symptom against it.

Matter has 4 progress values and none of them means "in this run, exact position unknown", so both available encodings are imperfect: every area operating asserts the robot is in all of them, every area pending asserts it is in none of them. This release picks the one that is true at the only place a person looks. **The robot is operating; it is not on its way.**

- `currentArea` still stays null on a whole-home clean. No room is named that the plugin is not sure of, because naming the wrong room is worse than naming none.
- Live map-position tracking still collapses the wide claim to the accurate single room the moment it resolves one, and the run still flips wholly to completed on the charger.
- A room clean is unchanged.

## 3.15.0

**A Q Revo S owner asked for the accessory details to read like a native device. Half of that is fixed here; the other half is Homebridge's and is now filed.**

`accessory.model` has always been the raw string the robot reports itself as, so every surface that shows a model showed `roborock.vacuum.a104`. The HAP contact sensors carried it visibly today — their Model characteristic read "roborock.vacuum.a70 Docked" — and it is what the Matter node would show the moment Homebridge stops discarding it.

There is now a marketing-name table: `roborock.vacuum.a104` reads "Roborock Qrevo S", `a70` reads "Roborock S8 Pro Ultra", and 34 models are covered. Every entry is upstream `copystring/ioBroker.roborock`'s own `VacuumProfile.name`, cross-checked against this repository's model comments — the test that does the cross-check found a real disagreement on the a97 while it was being written. Models with no upstream profile are deliberately absent and keep showing the code, including the maintainer's own sc05: a wrong marketing name is worse than a code, because a code is at least unambiguous.

**The table is display-only, and that is the part worth guarding.** Every poll profile, feature lookup, capability branch and `isSupportedDevice` call keys on the raw code. A name resolved where a model is _compared_ would break model detection silently — a robot whose name we happen to know would stop matching its own profile, and the stale-accessory sweep would unregister it, which costs its owner a re-pair. So `__tests__/the-model-row-is-a-name-not-a-code.test.js` enumerates the rule instead of asserting the cases: it reads the source and fails if a model comparison is ever fed the display helper.

**What this does not fix, measured end to end before shipping so nobody re-measures it:** for an external Matter accessory, Homebridge hardcodes `vendorName: 'Homebridge'` and derives `productName` from the display name, discarding the manufacturer and model the plugin hands it. `ServerConfig.ts` validates and truncates both to the Matter 32-character limit and returns them; `ServerLifecycle.ts:319-326` then never reads either. So Apple Home shows Manufacturer "Homebridge" and a Model row containing the robot's _name_, and no plugin change could alter that. Filed as homebridge/homebridge#3996 with the three-line fix. The values are correct on this side so they are right the moment it lands.

**Since fixed upstream, and out: `homebridge@2.4.1-beta.3`.** Measured on a robot commissioned long before the beta and not otherwise touched, Manufacturer now reads "Roborock" and the Model row reads the actual model. No re-pairing and no removal from the Home app — both attributes are Fixed quality and therefore never persisted, so the new values simply apply on the next start. The upstream fix is gated on `externalAccessory`, because reading the config unconditionally would have renamed every commissioned bridge as a side effect.

## 3.14.3

**The wind-down fix from 3.12.3 was too narrow by exactly one dock.**

3.12.3 stopped a mop run from reporting "Vacuum + Mop" while the robot drove home. Three hours later the same robot did the same thing one step further along, and the log is as plain as the first one:

```
21:04:33  publish … operationalState=1,  cleanMode=1   mopping the hall
21:07:43  publish … operationalState=64, cleanMode=1   driving home, correctly held
21:09:31  publish … operationalState=68, cleanMode=2   washing its mop
```

The freeze covered the drive home and nothing else. A dock washing a mop runs water with the fan off and on again, which is the same signature that made the robot look like it was vacuuming in the first place — so the moment it arrived and started washing, the derivation woke up and changed the user's mode under them.

Everything the plugin already counts as part of a run except actually running or paused is now the wind-down: driving home, emptying the bin, washing the mop, updating the map. During those the fan power and the water box belong to the dock's business, not to what the user asked for. A mode genuinely changed in the Roborock app while the robot is still cleaning reaches Apple Home exactly as before, and that case keeps the test it has had since 3.12.3.

Two new tests replay the 21:04 to 21:09 window frame by frame. Both fail against 3.12.3.

## 3.14.2

**3.14.0 froze the operational state on the tile, and it did it to every robot that was not actively doing a dock job. Fix immediately.**

Measured on a real mop run, 20 minutes after the release went out. The robot was asked to mop the hall from Apple Home. It went to the dock, wetted its mop, drove out and mopped — and the tile went on saying "Cleaning Mop" for 5 minutes while it worked, and would have gone on saying it until the next time the dock did something.

The cause is a rule in Matter's own server implementation, and this project should have read it before shipping. From matter.js's `OperationalStateServer`:

```
if (currentPhase === null || currentPhase < 0 || currentPhase >= this.state.phaseList.length) {
  throw new ImplementationError(`Current phase ${currentPhase} is out of bounds ...`);
}
```

A null `CurrentPhase` beside a non-empty `PhaseList` throws. Homebridge swallows the throw, so the **entire cluster write** is discarded without a word in the log — not just the phase, but the operational state, the battery and the fault attribute with it. The controller keeps whatever it last accepted.

3.14.0 published a constant 4-entry list with a null phase whenever the dock was idle, which is nearly all the time. So the last write any controller accepted was the last one where the dock genuinely was emptying, washing or updating, and everything after it was thrown on the floor.

The list is now present only while there is a phase to point into, and absent otherwise. That is the specification's own encoding for "the current mode has no phases", so it is also the more faithful reading; the anti-flap argument that made the list a constant is untouched, because the list is still either that exact constant or nothing at all.

**The tests did not catch it because they publish into a mock that accepts anything.** That is the same shape of gap as 3.12.1, one layer further out: the logic was right and the contract was not. There is now a test that encodes matter.js's rule directly, quoting it, and walks every state a robot can be in plus a whole run frame by frame, asserting the pair is one the real server would take. It fails 16 times against 3.14.0.

## 3.14.1

**The publish line now names the phase, so 3.14.0 can actually be measured.**

3.14.0 shipped a feature whose status is "unmeasured": nobody knows whether Apple Home draws a Matter phase. That is a fine thing to ship — an attribute no controller reads costs nothing, and drying the mop has no other route to the tile — but it is only worth shipping if the answer can be found afterwards.

It could not have been. A tile showing nothing during a dry would have been ambiguous between "the controller ignored it" and "the plugin never sent it", and that exact ambiguity is what cost the empty-tank warning 2 withdrawn releases and 3 field tests before 3.12.1 found the plugin had never sent anything at all.

So the evidence line says it: `phase=Drying mop` while the dock dries, `phase=Washing mop` while it washes, and nothing at all when the dock is idle. One look at the log and one look at the tile now answer different halves of the same question.

## 3.14.0

**Your dock spends 2 to 4 hours drying the mop after every mop clean, and until now there was no way for Apple Home to know.**

Matter gives a robot vacuum an operational state for emptying the dust bin, one for washing the mop and one for updating the map. This plugin has published all 3 since 3.12.0. There is no state for drying — not in Matter 1.2, not in 1.6, not anywhere — so for the whole of that time the tile has said "Docked" while the dock worked.

The one place it can be said is `PhaseList` and `CurrentPhase` on the same cluster, and this release says it there. The dock's 4 jobs are announced as a fixed list of phases, and `CurrentPhase` steps through them: washing, then drying for as long as the dock takes, then nothing.

**The list never changes, and that is the entire safety argument.** Both attributes were null from 1.4.58 until today, and the reason was real even though the explanation written down for it was not: 1.4.58 removed a version that changed phases as a refresh trick and flapped them at every Apple Home hub in the house. The answer to flapping is a list that cannot move, not an empty one. The list is a module constant, only `CurrentPhase` moves, and a test fails if any future edit builds the list from anything else. A second test walks a full mop run frame by frame and asserts the list is byte-for-byte identical at every step.

Drying is detected on both protocols. A classic S- or Q-series robot with a drying dock reports `dry_status` itself. A B01/Q7 reports raw status 10, air-drying, which the adapter maps to "docked" so the tile does not claim a working robot — that mapping is correct and it stays, because Apple Home may refuse a Start command to a robot it thinks is busy, but it was also where the information disappeared. The adapter now writes the fact out under the same field name the v1 robots use, so both roads arrive at the same phase.

`dry_status` went into the live cache with it. Drying starts while the robot is parked and idle, which is exactly when the frames are sparsest and the cloud snapshot is stalest — without the cache the phase would light for 1 frame and go out on the next heartbeat, which is worse than never showing it. That is the same hole 3.12.1 found in the tank fields and 3.13.0 found in the error code, and the tests take the robot's own route through the live handler rather than stubbing the status reader.

**Whether Apple Home draws a phase at all is unmeasured, and this release does not pretend otherwise.** An attribute nobody reads costs nothing, and drying is worth the attempt because no other route to it exists. `enableMatterDockPhases: false` in `config.json` puts both attributes back to null if a controller dislikes them — not on the settings page, which 3.12.0 removed, but there for the person who would otherwise be reinstalling.

## 3.13.1

**A correction to 3.13.0, found on the maintainer's own robots within the hour, by the release that caused it.**

3.13.0 gave an unrecognised `error_code` the generic Matter fault rather than silence. The argument was that a robot which has stopped and says nothing is worse than one which says something vague, and it was wrong.

Within 30 minutes of the deploy, 2 robots that were docked, charging, at 100 % and in perfect health were both carrying `error_code: 2105` and both had a fault drawn on their Apple Home tile. Neither was in any kind of trouble. The reason is written in this repository already: a B01/Q7 robot's fault field is a separate diagnostic channel where informational codes linger after harmless events, which is why the adapter has always zeroed 407 — "cleaning in progress, scheduled cleanup ignored" — before it reaches anything else.

So an unrecognised number is not evidence of a fault. It is evidence of a number. It is now named once in the log, per code and per robot, with a link for reporting it, and nothing is published to Apple Home for it. An existing fault is not cleared by one either.

The same release stops reading a B01/Q7 robot's fault through Roborock's v1 error table at all. The 2 numbering spaces share a field name and nothing else, so translating 254 from a Q7 as "dust bin full" would have been a coincidence rather than a reading.

Curated codes are unaffected: stuck, jammed wheel, blocked brush, dust bin missing or full, unreachable dock, flat battery and the rest still reach the tile exactly as 3.13.0 shipped them.

## 3.13.0

**Apple Home could always tell you a robot had stopped. It could never tell you why. Now it can.**

A robot wedged under the sofa, a jammed wheel, a blocked brush, a dust bin someone took out and forgot to put back — Roborock reports every one of these as a numbered error code, and this plugin has polled that field on every cycle since the fork without ever showing it to anyone. The Matter side had half the answer already: operational state 3, Error, so the tile stops claiming the robot is Ready. The other half, the attribute that names the fault, has only ever carried 1 value out of 19 — an empty clean water tank.

This release maps the rest. Stuck, wheel jammed or floating, main or side brush blocked, dust bin missing, dust bin full, an unpowered or unreachable dock, a flat battery, a no-go zone in the way, a dirty laser or cliff or wall sensor, a failed suction fan. An error code the plugin has never seen still reports a fault rather than silence, and the raw number reaches the Homebridge log so it can be reported and mapped properly — `error_code: 2105` on a Q7 is exactly that case and is why the branch exists.

**The published codes deliberately stop at 71, and that is the interesting decision.** Matter 1.5 added names that fit several of these faults exactly: `WheelsJammed`, `BrushJammed`, `NavigationSensorObscured`. Everything up to 71 has been in the cluster since Matter 1.2. Nothing establishes which revision Apple implements, and this plugin has already measured what Apple Home does with a value it does not recognise in the neighbouring attribute — the tile sticks on "Connecting" forever, which is why `operationalStateList` ships bare ids and no labels. A robot reported as `Stuck` when the accurate word was `WheelsJammed` has lost a little precision. A robot whose tile will not finish connecting has lost the robot. The accurate 1.5 name is written to the log beside the code that was sent, so the day somebody watches a real tile with 76 on it, the mapping moves and the log already says which rows to move. A test fails if any future edit reaches for the accurate name without that measurement.

An empty clean water tank still outranks the robot's own fault when both are true at once. It is the one code measured all the way to a rendered tile, and it is the one the person standing in the kitchen can fix in 30 seconds.

**The plumbing got the same treatment the tank fields got in 3.12.1, for the same reason.** `error_code` was in neither the live cache nor, on the local transport, the list of dps keys the plugin reads — dps 120 was dropped on the floor, which on a B01 or Q7 is the single most likely way a fault arrives. Both are fixed, and the tests take the robot's own route through `notifyDeviceUpdater` rather than stubbing the status reader, because stubbing it is precisely how the tank feature passed its tests for 2 releases while being unable to fire.

Nothing needs re-pairing. An error attribute is a live value, not a capability. `enableMatterTankFaultReporting: false` still switches the whole attribute off; the key name predates the wider mapping and is kept so that anyone who turned it off stays turned off.

## 3.12.5

**3 things this project told you about the Matter specification were not in the Matter specification.**

An audit of the plugin's own claims against the specification text found 3 statements that were invented rather than read. None of them changes what the plugin does; all 3 were being used as reasons not to build something, which makes them expensive to leave standing.

`buildOperationalStateCluster` said "RVC Operational State requires PhaseList and CurrentPhase to be null". It does not. Both attributes are mandatory on that cluster and both are nullable, and null is the specification's own way of saying the current mode has no phases. The real reason they are null is history: 1.4.58 removed a version that changed phases as a refresh trick and flapped them at every Apple Home hub. That is an argument against flapping phases, not against having them, and it matters because `PhaseList` is free-form text up to 32 entries and is the one place the dock's own jobs could be named.

Which is also why the settings page no longer says mop drying "cannot be reported by any plugin". It has no operational state of its own, which is what the sentence should have said. Whether Apple Home would draw a phase is unmeasured, and the description no longer implies the question is closed.

The Vacuum + Mop clean mode carried a comment saying Matter has no dedicated tag for it. Matter has had `VacuumThenMop`, 0x4003, since the cluster was defined. This release does not switch to it, and the comment now says why: `SupportedModes` is fixed at commissioning, so changing a tag would leave every already-paired robot needing a re-pair before its mode picker worked again. Combining the 2 standard tags is legal, it is what has always shipped, and it stays.

No behaviour changes in this release.

## 3.12.4

**A correction. For one release this README said the opposite of the truth about how your robots reach Apple Home.**

3.12.3 rewrote the paragraph on Matter fault reporting around 2 beliefs: that Homebridge puts every Matter accessory on 1 shared node, and that the field tests which found Apple Home drawing no vacuum faults had therefore been run on a bridge. Both are wrong, and the evidence was in the maintainer's own log the whole time.

Homebridge has never bridged a robot vacuum. Its Matter layer keeps a list of device types that must be published on a dedicated Matter server of their own, and `RoboticVacuumCleaner` has been on that list since the first Matter commit landed on 23 February 2026 — before any released Homebridge could speak Matter at all. Every robot gets its own server, its own port and its own pairing code. On the maintainer's host that is ports 5532, 5533 and 5534 and 3 distinct bridge identifiers, printed in the Homebridge log at every startup.

So the sentence 3.12.3 deleted was correct and the one it added was not. "Bridged versus not" cannot explain why Apple Home drew nothing in those 3 controlled tests and drew the tap icon on this maintainer's own tile on 20 August, because every one of those measurements was taken on a standalone node. The condition is still unknown, and the README says so again.

The wrong version was live for 17 minutes. Nothing in the plugin changed in this release; the code shipped by 3.12.3 is untouched.

## 3.12.3

**A robot asked to mop said it was vacuuming — for the 40 seconds it spent driving home.**

Mathias asked his S8 Pro Ultra for a mop run from Apple Home and watched the tile report Mop, then Vacuum + Mop, then Mop again. The log is unambiguous: `cleanMode=1` at 16:55:16, `cleanMode=2` at 16:56:16 the second it was sent back to the dock, `cleanMode=1` at 16:56:54 once docked. He had asked for one thing.

The robot was not misbehaving. A classic S- and Q-series robot does not report its clean type, so the plugin derives it: fan power 105 means the fan is off, which means mop-only, and otherwise an active water level means vacuum + mop. That derivation is a single sample, and sending a robot home resets its fan power while leaving the water box configured — which is exactly the signature it reads as vacuum + mop.

The derivation is now frozen while the robot is driving home, and only then. It stays authoritative for the rest of a run, because a mode genuinely changed in the Roborock app mid-clean must still reach Apple Home; that is a real case and it has its own test. A first attempt held the type for the whole run and broke it, which is how the scope got settled. Robots that report their clean type directly — the B01 and Q7 generation — were never affected either way, because their answer is not a guess.

## 3.12.2

**Flipping debug mode could switch off 9 HomeKit sensors nobody had touched.**

`autoSave()` and the device-row toggle both went through `saveCredentials()`, which spread the entire settings form into the patch. The Apple Home checkboxes sat in their own panel with their own Save button and deliberately had no autoSave binding, so the intended flow was tick-then-Save. But any change to debug mode, region, email or a device row committed whatever those 4 keys happened to be in the DOM at that moment.

The signature is in the config diffs: `debugMode` false to true and `enableHomeKitStateSensors` true to false in the same write. One debug-mode toggle, and an untouched checkbox rode along and unpublished 9 HAP accessories without anyone pressing Save. It happened 3 times in one day.

`updatePluginConfig` is a merge, so a key left out of the patch keeps its saved value. An implicit save now writes only the fields whose own controls triggered it. The account password is off that list too, for the same reason `login()` deletes it: blurring the email field should not write a cleartext password back into `config.json`.

What this does not claim: nothing unticks that box on its own. `syncFeatureDependencies` is empty and no path outside `loadConfig` assigns to `.checked`. The bug was never a checkbox with a mind of its own — it was an unrelated control persisting it.

The new test enumerates the rule rather than the case: every control wired to `autoSave()` must have its key on the list, or that control silently stops saving.

## 3.12.1

**The empty-tank warning could never fire on a real robot, and it took the Roborock app saying "Out of water" next to a silent tile to prove it.**

3.10.0 added the `Water Tank Empty` sensor and 3.12.0 added the Matter fault on the tile. Both read `dock_error_status` and `water_shortage_status` through `getNumberStatus`, which checks the live cache first and the HomeData snapshot second. Neither field is in the snapshot, and the live handler remembered 7 fields — state, charge status, battery, clean area, clean time, fan power and clean type. The tank was not among them. So both features asked for a value that had nowhere to come from, got null, and correctly said nothing at all. On my own S8 Pro Ultra the raw frames carried `dock_error_status: 38` for days while the sensor stayed Open and the tile stayed clean.

The live cache now remembers both fields. Nothing else changes.

The reason no test caught it is worth writing down, because it is the sort of gap that repeats: every test for this feature stubbed `getVacuumDeviceStatus` and handed the code the value it was asking about. They proved the logic and nothing about the plumbing — a feature can be entirely correct and still be wired to a socket with no power in it. There are now 4 tests that take the robot's own route instead, pushing a live frame in through `notifyDeviceUpdater` with a snapshot that knows nothing about tanks, including the sparse-frame case where one message carries the tank and the next carries only the battery. All 4 fail against 3.12.0.

## 3.12.0

**An empty water tank now shows on the tile, and the page of switches that used to decide such things is gone.**

Apple Home draws a tap icon on the play button with "refill the water tank" when a robot publishes Matter's `WaterTankEmpty` fault. This plugin has written that attribute twice and withdrawn it twice — 1.4.61, then 3.3.0 into 3.4.1 — because 3 controlled tests on an S8 Pro Ultra with a genuinely empty tank produced nothing at all in Apple Home, and wedged the tile on "Updating…" for good measure. Then vp-debug12 posted a screenshot in [#9](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/9) of the same attribute rendered correctly by the same controller. One counterexample is worth more than my explanation, so it is back.

It is deliberately narrow. `WaterTankEmpty` goes out when the robot says the tank is empty and `NoError` when it says the tank is full, because an attribute only ever written when something is wrong never clears and a warning that survives a refill is worse than no warning. A robot that has not reported its tank gets no attribute at all rather than a cheerful all-clear. And the robot is **not** dragged into the Matter Error state along with it: that was the third of Wazza151's tests, Apple still drew nothing, and a robot in Error may be refused a Start command — a real cost for a robot that is docked, charging and perfectly able to vacuum without water. No re-pairing is needed; an error attribute is a live value, not a capability.

Both robots that have been measured with an empty tank disagree about how they say so. The S8 Pro Ultra sets `dock_error_status: 38` and leaves `water_shortage_status` at 0; the Q Revo sets both. Either is enough, which is the same rule the `Water Tank Empty` contact sensor already used.

**And the Apple Home Features section of the settings page is gone.** 9 switches, several of them marked "⚠ re-pair", every one of them a way to end up with a robot that shows less than it could. They are all on now. Rooms and map selection, live room tracking, cleaning and suction modes, battery, dock and returning status, charging and docked on the tile, fault reporting, and the tank warning — that is what a Roborock in Apple Home is, and it should not have been a quiz.

The switches were not just clutter, they were sharp. 3.10.1 measured what turning a mode set **off** does: Matter persists `CurrentMode` and does not persist `SupportedModes`, so a stored mode 6 meeting a freshly shrunken list of 0, 1, 2 throws inside `RvcCleanModeServer.initialize`, the endpoint rolls back, and the accessory never registers again — on that restart and every restart after it. The settings page was offering that as a checkbox. Growing a list has no such failure: the stored mode stays valid, which is why turning everything on is the safe direction and turning things off never was.

Every key is still read from `config.json`, so `"enableMatterFaultReporting": false` still works for anyone who wants the old silence, and an existing config that already says `false` is left alone. Nothing on the settings page writes them any more, which also closes a quieter bug: a save could previously write `false` for a feature the page had no opinion about.

**If your robot was paired before this release, re-pair it once.** Matter fixes an accessory's announced capabilities at commissioning, so a robot that was paired with 3 clean modes and 4 operational states keeps showing 3 and 4 until Apple Home is shown the new shape. Remove the robot in Apple Home, then add it again with the same Matter code. Anyone who already had these switched on has nothing to do.

## 3.11.2

**"Attempt 12 this run" counted every run since Homebridge started. So did "failed 10 times in a row", and the once-per-run explanation of why no room could be named was only ever printed on the first run of the process.**

Caught on my own a70. It ran a two-room clean from Apple Home, the cloud map channel was timing out that morning, and `get_map_v1` failed all ten times it was asked — ten guaranteed-to-fail cloud requests, 10 seconds of timeout each, spread across one ten-minute clean, and not one room named.

The clear that runs at every run boundary exists so nothing leaks into the next run. It dropped the cached room and nothing else. Every counter behind the log lines survived for the lifetime of the process, so three lines were telling you about a window that was not the one they named. A run that fails every attempt is exactly the run that leaves the counters high, and that run never had a cached room to clear in the first place — which is why the leak survived a release that went looking for the same class of thing. 3.11.0 stopped placeholder poses from inflating the miss count; it did not make the count per-run. It is per-run now.

**The failing fetch is also no longer retried at live-display cadence for the whole run.** After 2 failures in a row the gap doubles with each further failure, capped at 5 minutes, and drops straight back to the live cadence the moment one succeeds. The first two failures are deliberately not slowed: a single lost frame on a healthy channel must not make a working live room sluggish, the same rule 3.11.1's local-mute limit follows. A streak long enough to have been slowed now says so when it ends, because "failed N times in a row" at warn level had no counterpart and a channel that recovered left the log's last word saying it was broken.

Both protocol paths are covered — the classic `get_map_v1` fetch and the Q7/B01 SCMap fetch had the same two defects in the same shape. The test enumerates the rule across every live-room state the plugin keeps rather than the two call sites that happened to be found, so a third path added later fails the test instead of leaking quietly.

Not addressed, because there is no measurement to justify it: why the cloud map channel timed out at all. `get_map_v1` has the default 10-second timeout and had been resolving every position on this same robot nine days earlier, so a longer timeout would be a guess. The morning also carried an unrelated cloud `get_prop` timeout on the same robot, which points at the account's cloud rather than at the map request.

## 3.11.1

**The LAN port was open, the robot never answered on it, and the plugin kept asking for the life of the process — 10 seconds thrown away on every poll and every command.**

The reporter of [#8](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/8) runs Homebridge on a NAS in one VLAN and his Saros 10 in another. Port 58867 is reachable across that boundary, so the local client completes its TCP handshake and records `Local connect state: true` — and then every single request dies of silence 10 seconds later. `get_prop` on both startups, `app_segment_clean`, `app_pause`, `app_start`: all of them, every time.

The plugin only ever gave up on the LAN when the _connect_ failed. A socket that connected and then answered nothing was retried forever, which is why he saw a `get_prop` timeout at every restart and why his commands were slow before they worked at all. A successful handshake proves the port is reachable. It does not prove the robot is listening.

3 local timeouts in a row on a socket that still reports itself connected now write the LAN off for that robot and use the cloud instead, with 1 log line that says the port is open and the robot is not replying — the distinction that decides whether there is any point rewriting a firewall rule. Any local reply resets the count, so a single lost frame on a healthy network changes nothing; permanently exiling a robot to the cloud over one dropped packet would be worse than the bug being fixed.

The diagnostics report names this case separately from a failed connect, because those two look identical in a log and lead to opposite conclusions.

## 3.11.0

**A Q7 said it was between rooms 226 times during one clean. It was in the bedroom the whole time.**

I caught a run on my own robots and pulled the numbers rather than the impressions. One Q7, 47 minutes, 227 live-room fetches. 226 of them placed it at cell 22280,22100 — the same cell every time — while the room outlines on that map span 38 to 293. The pose behind it was exactly (1100, 1100), which is the same constant two other people's Q7s reported back in August. The remaining fetches resolved Stue, then Gang, then Soveværelse, in the order the robot actually moved.

So the robot does send a real position. It just serves a placeholder in between, and every one of those was being written up as "the robot's position did not fall inside any known room outline (it may be between rooms, or the map may still be building)". That sentence was wrong twice over: the robot was not between rooms, and there was nothing anyone could do about it. It also fed the miss counter, which is how a robot cleaning one bedroom produced "after 46 unresolved position(s)".

A position further outside the map than the map is wide is now recognised for what it is and named as a placeholder, once per run at a level you see and quietly thereafter. The test is geometry rather than the number 1100: the robot cannot be somewhere it has never mapped, which stays true if Roborock picks a different constant. A robot genuinely outside every outline — a doorway, a hallway nobody named, a strip the outlines do not cover — is still a real miss and still counts as one, because that is the case the miss line exists for. Classic S- and Q-series robots resolve every fetch and are untouched.

Two things fall out of it. The room still updates on a Q7, on the fetches that carry a true position; nothing about the tile changes. And a resolved room now prints the cell it resolved at, so a working position and a failing one can be compared in one log instead of across two field sessions — which is what this one cost.

**Also: 50 log lines a minute, per robot, that could never mean anything.** With debug on, every known status attribute produced `Skipping known get_status attribute without a Homebridge state object` on every poll. That check dates from this library's ioBroker origins, where the object it looks for exists; under Homebridge it never does, so the branch fired for every attribute forever and reported only that the plugin is not ioBroker. On my own server the log ring had shrunk to 90 minutes — the window you need when something real goes wrong. It is gone. An attribute nobody has mapped yet is still named once with its value, which is the half that carries information.

## 3.10.2

**You asked for vacuum-only, the robot mopped, and Apple Home showed vacuum anyway — because the plugin believed a command it had already logged that it lost.**

The reporter of [#8](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/8) selected two rooms, vacuum only, and his Saros 10 ran a vacuum-and-mop over them. His log contains both halves of the mistake, 83 seconds apart:

```
13:50:57  Applying Vacuum mode to Weebo before starting.
13:50:59  Roborock did not confirm the water mode and suction level ...
          the robot may keep its previous settings for this run
13:52:22  Roborock still reports Vacuum + Mop ... after Vacuum was applied
          and acknowledged
```

The second line is untrue, and the first line is the plugin saying so in advance.

Before a Matter start, the plugin makes the robot match the mode being displayed. On a v1 robot the difference between Vacuum and Vacuum-and-mop _is_ the water-box mode, so that one command carries the whole choice. When it lands, the plugin pins the clean type for the run so a robot whose own report lags by a minute or two cannot make the tile flicker to a mode nobody asked for — that is 3.10.0's behaviour and it is correct.

The pin was taken on the wrong evidence. It was taken whenever the prep sequence _resolved_, and the prep resolves on a partial apply too: it deliberately never gives up early, because a suction command that times out must not cancel the command carrying the user's actual choice. So it sends what it can, warns about what the robot never confirmed, and returns normally. "Acknowledged" and "sent, unconfirmed, the robot may keep its previous settings" reached the caller as the same answer — nothing.

So on his run the water command went unanswered, the robot kept mopping as the warning predicted, and the pin then suppressed the robot's honest vacuum-and-mop report in favour of a promise the plugin had already recorded it could not keep. The only place the failure remained visible was the floor.

A pin is either known ground truth or it is not taken. The prep now hands back what the robot confirmed, and the clean type is pinned only when the command carrying it was acknowledged. An unconfirmed suction level does not disturb it, because a level inside a type says nothing about which type is running — and the warning about it is unchanged either way. This is the rule the failed-apply path has always followed, finally extended to the apply that fails while resolving.

The cloud timeouts underneath this are not the plugin's to fix and are not new; what is fixed is that they can no longer be hidden from you.

**Also: the plugin's own heartbeat left no trace of itself, and that cost [#7](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/7) a wasted round of testing.**

Every robot gets a forced full Matter write every 60 seconds. Its evidence line is written only when the rendered line would read differently from the last one — deliberately, since 3.10.0, so an idle robot does not fill the log with identical minutes.

The reporter of #7 was asked to check whether those lines were still appearing while his Apple Home tile was dead. It is the cheapest way to separate "the plugin stopped" from "the Matter session died underneath a healthy plugin". His robot was docked at 100 %, so every line rendered identically, so the last one was written at startup and none followed. He looked, correctly reported 11 minutes of nothing, and the answer was worth nothing — absence was the deduplication working, not evidence about whether anything ran. The question was unanswerable from the log at any level, which for a liveness signal is the wrong outcome.

A suppressed publish is now recorded at debug, naming the robot, the values and what triggered it. The info log stays exactly as quiet as before, and with plugin debug on, 11 minutes of a docked robot leaves 11 traces — so a gap in them means something.

## 3.10.0

**An empty clean-water tank can now notify you, which Matter has never had a way to say.**

The robot vacuum device type has no water-tank attribute of any kind — not level, not presence, nothing. I have had to write that sentence to three people now: to Wazza151 in [#5](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/5), who asked for the tank warning he used to get from another bridge, and twice in [#9](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/9). Two releases tried to say it through the fault attribute instead and both came back out, and the plugin has been reading the condition accurately the whole time with nowhere to put it.

A HomeKit contact sensor has no such gap. Turn on **Water Tank Empty** under the Home app sensors and each robot gets a read-only sensor that reads Closed while it has no clean water. Point a Home notification at it and a mop run that would have been wasted becomes a message instead. Nothing about the tile changes, no re-pairing is needed, and it is off by default like the other two.

Robots do not agree on how they say it, which is the whole difficulty. Wazza151's S8 Pro Ultra reports `dock_error_status: 38` and leaves `water_shortage_status` at 0 — he emptied and refilled the tank and watched the first field track it exactly. vp-debug12's Q Revo sets both. A robot that carries its water onboard and has no dock tank is the mirror case and sets only the second. So both are read, and the a70 is the reason it is an OR rather than a preference order: consulting the shortage flag first and believing its 0 would report a full tank on the very robot the condition was measured on. Only 38 counts as empty — that field also carries a full waste-water tank, a missing dust bag and a blocked duct, and a sensor that sent you to fill an already-full tank would be worse than none.

It reports and nothing else. It will not refuse to start a mop run, and that is deliberate: this plugin has already shipped the bug where it declined to forward a command because its own cached snapshot said the command was unnecessary, and a robot that will not start because the plugin believes the tank is empty is that bug with a worse failure mode. The Roborock app owns the tank sensor and is the right place for a hard block.

**Also fixed, and it was live for both existing sensors.** With no reading yet — a fresh install, or a sensor just switched on — every sensor answered Closed, on the reasoning that Closed is the resting state of a robot on its dock. That is true for `Docked` and false for `Cleaning`, which therefore claimed a robot was cleaning until the robot first said otherwise, and then moved. Moving is exactly what an automation triggers on, so a new `Cleaning` sensor announced a finished cleaning on its first startup, from a robot that had done nothing. Each sensor now declares its own resting state, and a test pins the general rule: whatever a robot sitting idle in its dock reports, that is what every sensor must already be showing.

## 3.9.4

**A robot out cleaning your hallway was recorded as sitting in its dock, because of a charging flag it left behind there.**

The reporter of [#8](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/8) was asked whether a particular warning appeared every time he sent his Saros 10 home mid-clean, or only sometimes. He reproduced it: twice out of two attempts, on two different plugin versions. In one of them the plugin had been publishing "running" for eight minutes, with the battery falling 100 → 97 % and live room tracking following the robot from room to room, and still called its own snapshot docked.

Two fields disagreed, and the wrong one won. A non-zero `charge_status` was treated as sufficient proof of being in the dock — enough to overrule a `state` that positively said the robot was out cleaning. The plugin already applies the opposite rule when it decides what to publish, where the charging flag is consulted only if the state says nothing useful, so the same two values read at the same instant produced "running" in one place and "docked" in another.

They disagree because they are not the same age. A live frame carrying only the state field moves `state` and leaves `charge_status` at whatever it held before the robot undocked, and any field a live frame omits falls back to the slower cloud snapshot. "Room cleaning" beside "charging" is not a robot contradicting itself; it is one fresh reading next to one stale one.

The charging flag is now a tiebreaker for a state that does not answer the question, never an override of one that does.

The visible half of this was a log line. The costly half was silent: the retry that re-sends a dock command when the first one times out asks whether the robot is docked before it asks whether it is still cleaning, so it gave up on the leftover flag. That retry was therefore disarmed for precisely the robots it was written for — the ones on cloud-only connections whose commands time out in the first place. The **Docked** state sensor was reporting docked for a robot out on the floor for the length of a run, which any automation built on it would have acted on.

Robots that really are in the dock are unchanged, and the charging flag still decides for a robot that reports no usable state at all.

## 3.9.3

**The dock still announced a phantom cleaning — one second after the one 3.6.2 removed.**

3.6.2 stopped the dust bin emptying from announcing a cleaning, and the reporter of [#9](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/9) confirmed in the field that it worked. He then added one sentence: after the emptying, the robot briefly returns to the dock and sends another notification.

That is a second bug with the same shape. When the chore ends the robot reports "returning to dock" for about a second before it charges again, and that state counted as cleaning. So the blip published Cleaning and then Idle — a cleaning that started and finished, from a robot that never left its dock. It fired the `cleaning` state sensor too, so any automation built on the robot starting or finishing a clean ran with it.

Transit now inherits the run mode instead of deciding one, exactly as a dock chore does. Driving somewhere is never the start of a cleaning; it is how a real run ends. One rule covers both directions: a robot that was cleaning keeps saying Cleaning until it is actually home, and a robot that never left its dock stays Idle throughout.

The rule reads the robot's own state rather than the one shown to the controller, which is what let this survive 3.6.2: with **Extended Operational States** off, "returning to dock" is rewritten one level below and never reached the test, so the bug hit only the users who had turned that toggle on. Two smaller faults fell out with it — with the toggle off, a mid-run trip to wash the mop announced the run had finished and restarted, and Apple Home announced a cleaning finished the moment the robot set off home instead of when it docked. The toggle no longer changes whether, or when, a cleaning is announced.

## 3.9.2

**The tile showed a robot that was idle on plain Vacuum for the first half-minute after every restart — even after 3.9.1 made the robot report itself correctly one second in.**

3.9.1 fixed the refused first status request, and the field log proves it worked: both Q7s reported `B01 status online … state=8` a second after startup, with no recovery lines at all. The tile was still wrong for 28 seconds afterwards, which means the two symptoms were never the same event — the status was already online _before_ the accessory was added.

The status simply had nowhere to go. Discovery runs after the status loop is already answering, and a live status that arrives before its accessory exists is dropped twice over in silence: once because there is no accessory registered for that robot yet, and again because an accessory that is not yet registered ignores live updates by design. Nothing redelivered it. The tile therefore fell back on the cloud snapshot — pairing-day values — and corrected itself only on the next poll tick.

Now an accessory that has just become usable is handed the status the robot already reported, replayed on the same channel every other update arrives on, so one piece of code interprets it. Robots that have reported nothing are left alone rather than being given a guess: an invented value would move when real data arrived, and moving is what automations trigger on.

Both discovery paths get it, not only the one that was measured — a robot restored from the accessory cache had the same gap.

## 3.9.1

**The first status request of every startup was refused, on every Q7, on every restart.**

The log said so plainly and had for weeks: `B01 status for 1. Sal recovered after 1 failed attempt(s).` It looked like the Roborock cloud being briefly unreachable, so it was left alone.

It was not the cloud. Measured over 30,224 log lines covering 49 restarts: 92 recoveries, one per Q7 per restart, without a single exception. Always exactly one failed attempt, never two. Always between 2 and 32 seconds after startup, never later. The robot on the older protocol had none of them.

A flaky connection does not look like that. It gives a varying number of attempts at varying times. One attempt, every time, only at startup, only on the cloud-only protocol is a race — and it was an ordering mistake in the startup sequence. The dedicated Q7 status loop was started at the end of device creation, and it polls immediately; the sequence did not wait for the MQTT session until after device creation had returned. A Q7 request is cloud-only by construction, so that first poll was rejected before anything reached the wire. The wait was already there, with a comment explaining this exact hazard for the two calls after it. The loop start had simply slipped in front of it.

The same event explains the other half, which had been observed 14 times and never connected to it: for about 27 seconds after every restart, a Q7's tile in Apple Home showed `battery=100%, operationalState=0, runMode=0` — the snapshot taken at registration rather than the robot. That window is not a separate phenomenon. A refused attempt still stamps the request throttle, so the 15-second tick that followed fell inside the 25-second idle gap and was dropped, and the robot's real status did not arrive until the tick at 30 seconds. Measured median: 31 seconds.

Two changes, because the ordering fix alone leaves the hazard reachable — the wait resolves on a 10-second timeout whether or not the broker came up:

- The loop is started by the login sequence, immediately after it has waited for the MQTT session, instead of at the end of `createDevices()`. A source-level test now asserts that order and that device creation does not start the loop, so it cannot drift back.
- The loop's own boot poll is skipped when the cloud session is known to be down. A request that is never sent cannot stamp the throttle either, so even in that case the first real status arrives at the next tick rather than the one after it. A connector that cannot report its state is treated as usable, so nothing changes for callers without a live session.

Verified red against 3.9.0: 7 of 12 assertions failed, and the symptom test failed by producing the field log line verbatim.

934 tests, up from 922.

## 3.9.0

**Automations can now be triggered by the robot.**

Apple Home does not accept a Matter vacuum as an automation trigger at all. pponce measured that in [#3](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/3) and confirmed it again after the action switches shipped: the switches are commands an automation _sends_, so nothing the robot does can _start_ one. A contact sensor is a trigger source in every Home client, so each robot can now publish read-only sensors mirroring its state — `Vicky Docked` and `Vicky Cleaning`.

Two states, in the order he ranked them when asked which he would actually trigger on: docked first ("I'd use the docked feature on its own for sure"), cleaning second. He also named the pair he wants them for — not docked **and** not cleaning means the robot is probably stuck somewhere — which is why both ship together, and why there is no third "stuck" sensor: that one is a timeout over these two, and the timeout is his to pick.

Closed means the state the sensor is named after is true, in every sensor. Nothing is ever sent to the robot.

Three things the implementation is careful about, each enumerated as a rule rather than fixed for the case that prompted it:

- **The value comes from the robot's own state, never from the state Apple Home was told.** Two unrelated display toggles rewrite the published operational state: CHARGING and DOCKED become STOPPED without **Charging/Docked status**, and the dock chores become RUNNING without **Dock & Returning status**. A `Docked` sensor built on the published value would have worked only for users who had ticked a box about something else — the same fault form as [#9](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/9)'s fix and [#5](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/5)'s. Verified red against that exact wrong implementation: 13 assertions failed, on the docked-robot and dock-chore rows specifically.
- **A dock chore is not a cleaning run, and interrupting a run does not end it.** `Cleaning` mirrors the run mode that actually reached Matter, so it carries 3.6.2's inheritance rule and cannot disagree with the tile. The test asserts that agreement as an identity rather than as a second hand-written truth table, plus a guard that both values genuinely occur.
- **Nothing is claimed before the robot has reported in.** Roborock state 0 is not a real state; it maps to STOPPED, which is indistinguishable from a robot idle on the floor. A Q7 on the maintainer's own account reports it for 27 seconds after every restart, so a sensor that believed it would report "not docked" for a docked robot and then move — firing every automation watching for that, on every Homebridge restart. The sensors hold their last known reading and only move on real data. Verified red with the guard removed.

The partition that keeps both HAP accessory kinds alive is the fourth: `discoverDevices()` unregisters cached HAP accessories it does not recognise, and each kind's sync removes what its own config no longer asks for. A sensor has no `action` in its context, so before this the switch sync would have deleted every sensor on the first discovery pass. Both directions are asserted, and verified red against the unpartitioned version.

Off by default, and no re-pairing: like the switches these are HAP accessories on this plugin's child bridge, not Matter. They need that bridge's own HomeKit QR code — the plugin says which one at every start.

922 tests, up from 907.

## 3.8.0

**The settings page follows Homebridge's dark theme, and the icon is in the header.**

The page stayed white inside a dark Homebridge, in every version. It was not reading the operating system's setting — that would have been wrong too. Homebridge UI reaches into this plugin's iframe and puts classes on our own `<body>`: `dark-mode` when the user picks a dark theme, `config-ui-x-<theme>` when they pick a light one. The stylesheet had `color-scheme: light` hard-coded and one set of colours, so there was nothing to follow it with.

Every colour is now a token, the dark set is declared once, and `index.js` decides which applies and writes it to `<html data-theme>`. Homebridge's own choice wins over the OS, because someone who picked light in Homebridge on a dark Mac meant light; the OS is the fallback for a page opened outside Homebridge. A MutationObserver keeps up when the theme changes while the page is open — the switch is one screen away, and the parent applies it by mutating our body rather than reloading us.

Two details worth writing down. Homebridge also assigns `body.style.backgroundColor = "#242424 !important"`; the CSSOM rejects a value carrying `!important`, so that line has never done anything and the class is the only signal there is. And the QR tile stays white in both themes on purpose — a camera cannot read a code without a light quiet zone. It is the one colour on the page that is not a token, and the test names it so the exemption cannot grow.

**The plugin's icon now sits beside the title**, as on the other plugins' settings pages. It is `assets/icon.png` byte for byte rather than a redrawing or a resize, and a test holds the two files identical, so the tile here and the tile on the Homebridge plugin list cannot drift apart.

787 tests, up from 773. Verified red against 3.7.1: 14 of 14 fail.

## 3.7.1

**The Matter Pairing section told you to pair the wrong thing first.**

It read "Pair the Roborock child/daughter bridge first, then add the external vacuum accessory if Apple Home asks for it." That sequence cannot happen. Homebridge publishes a robotic vacuum as a Matter node of its own, so the robot never arrives inside the bridge node, and Apple Home is never in a position to offer it as an extra afterwards ([#7](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/7) — reported by a user who had to reverse the instruction to get paired with a single code, and confirmed against a second installation where each robot is its own `matterOnly` node with its own setup code).

Each robot's own code is now what the panel and the per-code hints point at, and the bridge entry says plainly that the robots do not need it. Both hints also name the code as a **Matter** code, because the other code in this product — the child bridge's HomeKit QR code for the action switches — is the one people reasonably confuse it with.

Wording only; nothing about pairing itself changed, and no re-pairing is needed. `__tests__/matter-pairing-guidance-points-at-the-robots-own-code.test.js` enumerates the rule over all three surfaces in both directions: no surface may make the robot's code conditional on the bridge, and every surface has to say positively that the robot's own code adds the robot. The negative half alone is satisfied by deleting the paragraph.

773 tests, up from 749. The README's count said 726 — it was not updated when 3.7.0 shipped.

## 3.7.0

**A Start Cleaning switch for automations.**

A fourth Home app switch per robot, alongside Return to Dock, Pause and Find. It starts exactly the clean the Home tile's play button would, rooms selected on the tile included, because it calls the same method the Matter run-mode handler calls — a switch with its own idea of what starting means would be a second command path, and the room selection it ignored would be the one the user is looking at. Clear the selection on the tile to get a whole-home clean.

It comes with the clean-mode prep, the acknowledgement wait, the timing line and the optimistic tile update the tile's own start already had, for the same reason: one path. The log says which surface asked — `Starting Vicky from the Home switch.` against `Starting Vicky from Matter.` — so a misfiring automation is findable.

Off by default like the other three, and no re-pairing: the switches are HAP accessories on this plugin's child bridge, not Matter. `__tests__/every-switch-is-wired-all-the-way-through.test.js` enumerates the rule over all five places an action has to be declared, because the failure mode of missing one is a tickable box that publishes nothing.

749 tests, up from 726.

## 3.6.2

**A dock emptying its own dust bin announced a cleaning that never happened.**

Apple Home reads Matter's `RvcRunMode` as the answer to "is this robot cleaning?" — it announces a cleaning that started when the mode becomes Cleaning and one that finished when it returns to Idle. The plugin published Cleaning for all three dock chores (emptying the dust bin, washing the mop, updating maps), so a robot sitting idle in its dock produced a start and a finish notification every time the dock emptied itself ([#9](https://github.com/mathiashornbek/homebridge-roborock-matter/issues/9), Q Revo).

A dock chore now inherits the run mode that was published before it began, rather than deciding one of its own. That is deliberately "inherit" and not "always Idle": a robot that empties its bin in the middle of a run must not announce that the run finished and started again either. Both directions are covered.

The chore is recognised from the robot's own status code, not from the state shown to the controller — with **Extended Operational States** off, emptying the dust bin is rewritten to Running one level below, so a rule that read the controller-facing state would have worked only for the users who had enabled that toggle.

The operational state is unchanged: with the toggle on, the tile still says the dock is emptying the bin. Only the run mode stopped claiming that it was a cleaning.

Also documented: the plugin's **Debug Mode** is not enough on its own — Homebridge suppresses plugin debug output unless Homebridge itself runs with `-D`.

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

**14 more log lines were printing a raw 22-character duid to users.** `log-lines-name-the-robot` only inspected template literals written inside the logging call, so anything built into a variable or an `Error` first was invisible — it was checking 39 of 59 calls in one file alone. It now follows the three laundering channels as well, and everything it found is fixed.

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

The startup log now answers which of three situations you are in, once per start, and warns rather than informs when HAP is off — an info line about a feature that cannot work reads like the 90 other info lines a start produces. The settings page shows the steps under the toggle when the feature is on, and the README and the setting's own description carry the same three: **Plugins → homebridge-roborock-matter → ⋮ → Child Bridge Config**, check **Enable HAP**, restart, then **Connect to HomeKit** on that screen and scan that QR code. All four surfaces name the two codes that look right and are not — the main Homebridge code, and the robot's Matter code, which covers the vacuum only.

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

- **Ten of the 11 shipped languages could never load.** `this.language` is only ever set from `options.language`; the sole production construction site passes none, the UI server hardcodes `"en"`, and no setting exposes the choice. So de, es, fr, it, nl, pl, pt, ru, uk and zh-cn — 78 KB of translations — were installed on every user's disk and read by nobody. They are gone. A test now enumerates the rule rather than the ten filenames: **a locale that ships must be selectable**, so adding one back fails until there is actually a way to pick it.
- **The README claimed 463 automated tests in one paragraph and 263 in another.** Both were wrong. Two hand-written numbers describing one fact will drift apart and neither gets corrected, because nothing checks them. There is one number now, and a test checks it against what the suite actually declares. It deliberately does not pin an exact figure — `test.each` expands at runtime and no static reader can know by how much — it pins the two things that went wrong: state it once, and keep it in a defensible band.
- **The publish log line still rendered `fault=…` from an attribute withdrawn in 3.4.1.** The branch was unreachable, and worse, it read as evidence the feature still existed. Removing it settles a real contradiction: `matter-fault-reporting.test.js` pinned that `operationalError` is never published, while `matter-publish-line-logs-every-change.test.js` hand-built one and asserted it rendered. Two tests disagreeing about whether a feature exists is worse than either answer.
- **An orphaned ioBroker map viewer and a MITM sniffing script** (`roborockLib/lib/map/`, `roborockLib/lib/sniffing/`) were excluded from the npm package rather than deleted — which is exactly how they survived unreviewed for so long. Ignored by the package, invisible in review, referenced by nothing.
- **Ten functions whose definition was their only occurrence in the entire tree** are gone: `getHomeID`, `decodeSniffedMessage`, `getConnector`, `updateDataExtraData`, `setupBasicObjects`, `getCleanSummary`, `resolve102Message`, `resolve301Message`, `BytesToInt`, `getErrorCodeDescription`, plus the unused `B01_REQUEST_DPS`/`B01_RESPONSE_DPS` constants and three exports nothing imported. `resolveLiveRoomId` went too — a one-line wrapper over `describeLiveRoomResolution` with no production callers, kept alive only by tests. Two ways to ask the same question is how one of them drifts.
- **`errorCodes` was NOT removed**, though a first pass called it dead. `deviceFeatures.js` still uses the table for its `error_code` state mapping. Worth recording: the check that catches this is grepping the whole tree, not reasoning about one file.
- **Two user-facing claims were false.** The `preferCloudForMatterCommands` setting promised to keep "the legacy HomeKit accessories unchanged", and a startup log line told users "The existing HomeKit accessory will continue to work." This fork removed every HAP accessory by design — there is nothing to fall back to. The log line now says what to actually do: enable Matter for the bridge.
- **ROADMAP.md was eight releases stale**, still titled for a different package, pointing at an `AGENTS.md` that has never existed in the tree, and listing HomeKit controls as delivered features 13 lines above its own note that all HAP accessories were removed. Rewritten, with the pre-Matter-only entries labelled rather than deleted so the history stays readable.

## 3.4.12

**A live frame whose only field was the suction level or the clean type was thrown away before anything could read it.** A live message passes two checks on its way to Apple Home: a gate that decides whether it is a status message at all, and a check in the publish path that decides whether anything meaningful arrived. Both named their fields by hand, and they had drifted apart — the publish path was taught that a frame carrying only `fan_power` or only `matter_clean_type` counts (a suction or mop-mode change made in the Roborock app, or picked by SmartPlan, pushes exactly that), while the gate one level below still listed five of the seven fields and discarded such a frame before the publish path ever ran.

- **Both checks now derive from one list.** Adding a field the publish path reads covers the gate in the same edit, so the two cannot drift again.
- **A frame carrying no meaningful field is still ignored**, so this widens the gate exactly as far as the publish path can actually use and no further.

The fix that added the two fields was made one level down from the gatekeeper, which is why it looked complete and was not. `__tests__/live-status-gate-matches-what-the-publish-reads.test.js` pins the rule over the source rather than the two field names, so a field added later is covered the moment it is read.

## 3.4.11

**Two docked Q7s flipped their Apple Home clean mode to "Vacuum" and back every 90 seconds, and the plugin was reporting a level it had never measured.** Caught in a log from a plugin author's own robots on 3.4.10: every battery tick produced a pair of publishes about a second apart, the first saying `cleanMode=0` and the second saying `cleanMode=6` — ten pairs in 14 minutes, on both robots, at the same battery value.

Mode 6 is "Max Vacuum", the level the robot is actually set to. Mode 0 is plain "Vacuum", a level nobody selected. When suction-level clean modes are announced (`enableFanPowerCleanModes`), the reported mode is derived from the robot's live fan power — but the derivation had no answer for "the fan power cannot be read right now". It fell through to the last Matter selection, which defaults to plain Vacuum, so a momentary gap in the reading was published as a definite statement about the robot's suction level.

- **An unreadable fan power now leaves the reported level unchanged.** Saying nothing new beats saying something untrue. This covers a value that reads fine but is not one of the announced levels (such as 105, "fan off") as well as no value at all — in both cases the plugin does not know which announced level to report, and inventing one is the defect.
- **An explicit Apple Home selection still wins immediately.** Choosing a mode discards the remembered level, so a user's choice is never shadowed by what the robot said before they made it — including a deliberate choice of plain Vacuum.
- **A robot whose fan power has never been readable is unaffected**, and so is any robot that does not announce suction levels.

This is the same class of defect as 3.4.6 and 3.4.7: reporting a value derived from missing data as though it had been measured. What makes the fan power intermittently unreadable on these robots is a separate question and is not answered here — but the reported mode no longer depends on the answer.

## 3.4.10

**The Q7 position that never resolved to a room is not a position at all.** 3.4.9 asked the two Q7s to report the range their room outlines occupy, and they answered: Garage sat in a map spanning cells 52–171 by 43–187, 1. Sal in one spanning 38–293 by 90–227. Back-computing through each map's own origin and resolution gives the same coordinate for both — exactly (1100.0, 1100.0), on two robots, two maps, and 12 minutes of active cleaning. A number that identical is arithmetic, not a place a robot stood, which means live-room tracking on these models has never worked from that field.

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
- **The log-naming rule from 3.3.2 was itself only half enumerated.** It listed three files by hand, and the files it left out held 12 log lines still printing a bare 22-character duid — including `Device <duid> is offline.`, which is exactly the line someone quotes when asking why a robot dropped out. A hand-written file list is the same mistake as a hand-written line list, one level up. The rule now discovers the file list from the source tree, so a new file is covered the moment it exists, and all 12 lines now name the robot.

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

- **Finished a job 3.3.1 only half did.** That release converted the B01 log lines to use the robot's name and missed 11 others, including the live-room line for classic S/Q-series robots and the battery resync line — which then appeared in a field log directly above a line that did use the name: `Battery resync for 3tELc5hUekaTlOJEW3YetI` followed by `Matter publish for Garage`. Every user-visible log line now names the robot, and a test enumerates the rule rather than the instances, so the next line written cannot reintroduce it.

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
- **Diagnostics no longer truncate away the answer.** A Roborock status payload runs to about 50 fields and the export kept the first 30 — which are largely housekeeping, while the 20 it dropped included `dock_error_status`, the single field a question about the dock's water tanks turns on. The fields that matter for a fault report are now always kept, however far down the payload they sit, with the size cap otherwise unchanged and secret redaction untouched.

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
