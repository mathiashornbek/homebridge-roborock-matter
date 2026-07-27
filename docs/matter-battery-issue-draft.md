# Matter PowerSource `batPercentRemaining` — investigation record

Filed upstream as
[homebridge/homebridge#3958](https://github.com/homebridge/homebridge/issues/3958)
on 2026-07-15. This document tracks the current state of knowledge; the
original report text lives in the issue.

## Symptom

A Matter RVC bridged through Homebridge 2's Matter API publishes battery
updates continuously; the matter.js store verifiably carries the live value;
`batChargeState` on the same PowerSource cluster updates live in Apple Home —
but the rendered battery **percentage** stays at its commissioning-time value
until a fresh read (re-pair or Matter hub restart).

## Root cause (confirmed in the matter.js source by the Homebridge maintainer, July 2026)

`ServerBehaviorBacking#configureEventSuppression()` collects every
changes-omitted property into a suppressed set; only properties that are ALSO
marked `quieter` get the observer that re-broadcasts them
(`broadcastChanges([name])`). `batPercentRemaining` is changes-omitted without
`quieter`, so it hits the `continue` and **no subscription report is ever
produced** — the store stays fresh and reads serve the live value, which is
exactly what this investigation's store dumps showed. `batChargeState`
carries no C quality, which is why it updates live on the same cluster.

Ruled out along the way:

- An intermediate theory (Matter 1.4 Q-quality, reports leaving the bridge)
  did not survive the maintainer's source check.
- The freeze reproduces on Homebridge v2.2.2-beta.12 in a **restart-free**
  window, ruling out the dead-subscription bug fixed by homebridge#3973.
- matter.js 0.17.7 does not change the behavior (`ServerBehaviorBacking.js`
  is byte-identical to what Homebridge ships).
- No viable device-side nudge exists from the Homebridge layer:
  `broadcastChanges` is `protected`, and private-internals access or patching
  would break silently on a matter.js update.

## The fix

The Matter spec says a server _may_ omit changes for C attributes — reporting
them anyway is permitted. The clean solution is an opt-in on the matter.js
side, raised upstream by the Homebridge maintainer as
[matter-js/matter.js#4163](https://github.com/matter-js/matter.js/issues/4163)
with this investigation linked as evidence. Once it lands, Homebridge wires it
up for bridged accessories and every plugin gets working battery percentages
at once — no plugin-side change needed.

Until then: homebridge#3958 stays open to track; the plugin keeps its
boot-time battery resync (useful for controllers that re-prime their
subscriptions after a hub restart), and the known refresh paths remain
restarting the Matter hub or re-pairing.
