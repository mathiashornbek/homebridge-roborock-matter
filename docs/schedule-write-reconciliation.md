# Schedule write reconciliation

A missing write acknowledgement does not prove a schedule stayed unchanged.
The coordinator now includes ambiguous writes in verification, alongside
acknowledged writes. This works with MQTT session recovery disabled and does
not trigger recreation. It can wait for a recreation already in progress.

Each verification starts a fresh read after the writes complete. A retained
cache from a failed or skipped source cannot confirm a write or authorize a
fallback, even when another schedule source answered successfully.

- If the relevant source confirms the requested state, the operation succeeds
  without another write.
- If the existing schedule still has the other state, at most one fallback
  assignment is sent, followed by another fresh verification.
- A missing schedule, failed/untrusted read, explicit refusal, throttle or
  shutdown stops further writes. A failed verification remains unconfirmed.
- An ambiguous fallback is read back too, but never leads to a third write.

Device timers retain the existing `upd_timer` fallback. Timer-driven cloud
scenes can repeat an ambiguous absolute on/off assignment once, rebuilt from
a fresh scene reading so app edits are preserved. Routine execution is never
retried. There is no new setting or forced MQTT reconnect.

The MQTT tests use the real queue's timeout and the real receiver's refusal
objects. Scene tests use Roborock's HTTP methods against a local server that
can apply a PUT and then drop its socket, producing an actual Axios error.
The code does not depend on the parked MQTT recovery work (#31); its optional
hooks are absent on 3.40 and harmless.

## Repeated taps

A same-state write that arrives while an earlier one is still waiting for its
HomeKit answer (until Roborock accepts the write, or 2.5 s) shares that answer
and sends nothing. After HomeKit has been answered, read-back continues in the
background; a further same-state write is a new request and sends the
assignment again once the running batch ends. An intervening opposite-state
request is a new intent and keeps the existing batching rules.

An on → off → on sequence while the first on is in flight represents three
intents. Sharing checks the newest intent, so the final on can send another
assignment. A failure known before the HomeKit answer throws `HapStatusError`;
one found by the later read-back turns the switch back, with a warning.

## Account throttle policy

A definite rate limit from either schedule source starts the account-wide
65-minute schedule cooldown, even when the other source succeeds or retained
source data lets a periodic refresh preserve a usable display. This applies to
ordinary refreshes as well as write verification. A partial refresh is not proof
that the account can safely accept more schedule requests. During cooldown the
existing state is retained and account-coordinated reads/writes are suppressed.

The summary log retains `primaryConfirmed` and `fallbackSent` alongside requested,
ambiguous, retried and failed counts. `fallbackSent` includes an ambiguous fallback
that was submitted and required read-back, as well as an acknowledged one.
