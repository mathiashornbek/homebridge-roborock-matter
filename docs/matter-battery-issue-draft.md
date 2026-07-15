# Matter PowerSource `batPercentRemaining` never refreshes in controllers (changes-omitted attribute; device-side store is fresh)

Ready to file against `homebridge/homebridge` (Matter API). Title suggestion:

> Matter bridged accessories: `batPercentRemaining` freezes at pairing-time value in Apple Home (changes-omitted attribute; store verifiably fresh)

## Summary

A Matter Robotic Vacuum Cleaner (device type 0x74) exposed through Homebridge 2's
Matter API publishes battery updates continuously via `updateAccessoryState`. The
matter.js store demonstrably carries the live value. Controllers (Apple Home,
multi-hub) keep rendering the value from pairing time indefinitely — across
plugin restarts, Homebridge restarts, and days of uptime — while
`batChargeState` on the very same cluster updates live.

## Environment

- Homebridge 2.1.x (Matter API), plugin `homebridge-roborock-matter` publishing
  full-state snapshots via `updateAccessoryState`
- Three robots (one V1-protocol, two B01-protocol) — identical behavior on all
- Controller: Apple Home (Apple TV + HomePod hubs, current iOS/tvOS)

## Reproduction

1. Pair a bridged Matter accessory that exposes PowerSource with a battery
   percentage that changes over time (any RVC works).
2. Let the battery drain or charge by 10+ points.
3. Compare the Apple Home tile with the matter.js store on disk.

## Evidence chain

1. Plugin log shows continuous publishes with live values (73% → 92% over an
   hour, all three robots).
2. `grep -ro "batPercentRemaining[^,}]*" <storage> --include="*.json"` shows the
   persisted matter.js store matching the vendor app in real time (e.g. 170 =
   85% while Apple renders 74%).
3. `batChargeState` (same PowerSource cluster) propagates to Apple Home in
   near-real-time throughout.
4. The values Apple renders are exactly each robot's value from its
   commissioning moment; a re-pair refreshes once, then freezes again.
5. A device-side "resync nudge" (publishing the attribute as briefly unknown,
   then real, to force two genuine store changes and a data-version bump) helps
   only controllers that re-prime their subscription (e.g. after a hub
   restart); Apple in steady state still never converges.

## Analysis

`batPercentRemaining` (and `batTimeToFullCharge`) carry the Matter spec
reporting quality **"changes omitted" (C)**. matter.js honors this on the
device side (changes are not delivered via subscription reports), and the
matter.js controller compensates on its own side ("Always read attributes that
do not report changes via subscriptions" — matter.js changelog 0.10). Apple's
controller evidently performs no such re-reads, so bridged accessories freeze
on the pairing-time percentage. No plugin-side write can force a
changes-omitted attribute to report.

## Suggestion

Consider a device-side mitigation in the Homebridge Matter layer for bridged
accessories — for example bumping the cluster data version or scheduling a
periodic re-announce for changes-omitted attributes whose value has drifted —
so controllers that rely purely on subscriptions eventually converge. This
would fix frozen battery percentages for every bridged plugin at once, in one
place.

Happy to provide full logs, store dumps, and to test builds.
