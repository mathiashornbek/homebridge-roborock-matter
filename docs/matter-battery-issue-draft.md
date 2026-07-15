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

## Corrected analysis (per Homebridge maintainer verification, 2026-07-15)

The original analysis assumed the attribute carries the Matter reporting
quality **C (changes omitted)** — never reported via subscription, controllers
must poll. That was true of older spec revisions, **but as of Matter 1.4 the
attribute is quality Q (quieter)** , and matter.js 0.17.x (shipped with every
Homebridge 2.1.x release) models it accordingly:

- **Q (quieter):** reported via subscription, rate-limited to at most one
  report per 10 seconds, plus an immediate report on any null ↔ value
  transition.

A Homebridge maintainer (bwp91) commissioned a matter.js controller against a
bridge exposing `PowerSource(Battery, Rechargeable)` — the same setup
Homebridge builds — and logged the subscription: percentage changes propagate
exactly as Q prescribes (immediate first report, deferred follow-up inside the
10 s window, correct application after an interleaved `batChargeState` bump).
The "stale cluster data version" theory does not hold on the controller side.

## Where that leaves things

- The bridge **emits** the reports; a spec-compliant controller **applies**
  them. Apple Home in steady state does not — consistent with Apple's
  controller still treating the attribute under the older changes-omitted
  rules and refreshing only on a fresh read.
- The plugin's boot-time resync nudge (null → value transition) does hit the
  wire immediately (maintainer-confirmed) and remains useful for controllers
  that re-prime their subscriptions; Apple still does not converge.
- **No device-side fix exists**: bumping the data version or re-announcing
  only produces more of the reports Apple already receives and ignores.

## Next verification steps (requested upstream)

1. Run Homebridge with matter.js debug logging during a battery change and
   capture the subscription flushes carrying `batPercentRemaining` — proves
   the reports leave THIS bridge specifically.
2. Optionally subscribe with `chip-tool` and confirm it sees (and applies)
   the live values.

If both confirm reports going out, the permanent fix belongs with Apple
(Apple Feedback report about the controller's handling of Q-quality
PowerSource attributes). The upstream issue stays open in the meantime.
