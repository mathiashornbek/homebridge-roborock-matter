# Matter PowerSource `batPercentRemaining` never refreshes in controllers (changes-omitted attribute; store is fresh)

## Summary

A Matter Robotic Vacuum Cleaner (0x74) exposed through Homebridge 2's Matter
API publishes battery updates continuously via `updateAccessoryState`. The
matter.js store demonstrably carries the live value. Controllers (Apple
Home, multi-hub) keep rendering the value from pairing time indefinitely —
across plugin restarts, Homebridge restarts, and days of uptime — while
`batChargeState` on the same cluster updates live.

## Environment

- Homebridge 2.1.1 (Matter API), plugin publishing via `updateAccessoryState`
- Three robots (one V1-protocol, two B01-protocol), all identical behavior
- Controller: Apple Home (Apple TV + HomePod hubs, current iOS)

## Evidence chain

1. Plugin log shows continuous publishes with live values (73% -> 92% over
   an hour, all three robots).
2. `grep -ro "batPercentRemaining[^,}]*" <storage> --include="*.json"`
   shows the persisted matter.js store matching the vendor app in real time
   (e.g. 170 = 85% while Apple renders 74%).
3. `batChargeState` (same PowerSource cluster) propagates to Apple Home in
   near-real-time throughout.
4. Values rendered by Apple are exactly the per-robot values from each
   robot's commissioning moment; a re-pair refreshes once, then freezes
   again.

## Analysis

`batPercentRemaining` (and `batTimeToFullCharge`) carry the Matter spec
reporting quality "changes omitted" (C). matter.js honors this on the
device side (changes are not delivered via subscription reports), and the
matter.js controller compensates on its side ("Always read attributes that
do not report changes via subscriptions" — matter.js changelog 0.10).
Apple's controller evidently performs no such re-reads, so bridged
accessories freeze on the pairing-time percentage.

## Suggestion

Consider a device-side mitigation in the Homebridge Matter layer for
bridged accessories, e.g. bumping the cluster data version or scheduling a
periodic re-announce for changes-omitted attributes whose value drifted,
so that controllers that rely purely on subscriptions eventually converge.
Happy to provide full logs, store dumps, and to test builds.
