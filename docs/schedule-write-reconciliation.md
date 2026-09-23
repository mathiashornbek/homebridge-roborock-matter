# Schedule write reconciliation (PR 4 of 4)

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
The same tests are run against the preceding PR and v3.33.0 to show the missing
behavior before this change.
