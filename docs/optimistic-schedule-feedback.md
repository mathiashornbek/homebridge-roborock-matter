# Immediate schedule feedback and rollback

A HomeKit schedule write acknowledges acceptance immediately and displays the
requested value while the existing write/reconciliation operation runs. The
display is provisional; the cached schedule value remains the latest confirmed
state. Repeated identical pending taps share one operation. This keeps 3.40's
HomeKit acknowledgement within its time limit, and adds immediate provisional
feedback plus persisted confirmation/intent state.

When confirmation succeeds the requested value becomes confirmed. When it fails
or the operation reports that it did not execute, the characteristic returns to
the latest confirmed value as soon as that outcome is available. There is no
additional rollback delay. Total time depends on batching, cloud round trips,
read-back verification and any bounded fallback. Typical confirmation takes
5–8 seconds. An ambiguous write plus fallback can exceed a minute, with extra
queueing behind other robots; these are not hard end-to-end time limits.

The plugin emits a warning containing `Schedule display rollback`, robot and
the robot name and switch ConfiguredName/Name available to Homebridge (plus their
identifiers), requested and restored values, elapsed milliseconds, and
the failure reason. It explicitly labels the correction as failure recovery,
not a user change. A repeat of the failed state during the existing 30-second
failure cooldown retains the confirmed display and logs suppression.

A newer opposite-state tap creates a new intent. An older failure cannot replace
the newer pending display; its warning says that the newer intent was retained.
If that newest operation fails too, rollback uses confirmed state, never an older
optimistic value. Refreshes can update confirmed state during a pending operation
without removing its provisional display.

Tests drive the actual HAP set handler, including delayed rejection, taps before
and after failure, superseded failures, and authoritative refreshes. They verify
the characteristic and log outputs. Apple Home should visibly move back when it
receives the correction, but actual rendering/latency still needs a live check
before merge; no screenshot or precise Home UI timing is claimed by these tests.

This follow-up stacks on PR #32 and adds no routine or momentary-action changes.

## Restart during a pending change

Confirmed values and pending intent metadata are saved in accessory context before
acknowledgement. The provisional `On` characteristic is never the only record of
confirmation. If Homebridge caches it before shutdown, the next start restores
the separately saved confirmed value and logs the interrupted request and display
correction. A later trusted read logs how that unknown outcome was resolved.
Shutdown cancels feedback timers, and late completions cannot change disposed
switches. Existing caches without separate state use their old value once.

## An unverified write has an unknown outcome

If the source cannot be read after an ambiguous/submitted write, the write may
have applied. The log says **outcome unknown**. The requested value remains
provisional, and the failed-command 30-second cooldown is not armed. One follow-up
refresh is scheduled after three seconds, subject to the account queue and rate
limit policy. A trusted read logs the resolved value and any display correction;
failed or retained source data cannot confirm it. If that follow-up also fails,
that explicit follow-up is not repeated in a loop. Upstream's source-retry
backoff and normal refreshes can later resolve the outcome, which is logged. A new user request remains possible. Account-wide throttle protection
still applies.

Real hap-nodejs tests exercise post-onSet ordering, cooldown correction, shutdown,
cache-before-shutdown restoration, unknown outcomes and the follow-up read. Live
Apple Home rendering and timing remain to be recorded before merge.
