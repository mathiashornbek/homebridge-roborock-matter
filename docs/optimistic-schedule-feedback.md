# Immediate schedule feedback and rollback

A HomeKit schedule write acknowledges acceptance immediately and displays the
requested value while the existing write/reconciliation operation runs. The
display is provisional; the cached schedule value remains the latest confirmed
state. Repeated identical pending taps share one operation.

When confirmation succeeds the requested value becomes confirmed. When it fails
or the operation reports that it did not execute, the characteristic returns to
the latest confirmed value as soon as that outcome is available. There is no
additional rollback delay. Total time depends on batching, cloud round trips,
read-back verification and any bounded fallback, so it is not a fixed interval.

The plugin emits a warning containing `Schedule display rollback`, robot and
schedule identifiers, requested and restored values, elapsed milliseconds, and
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
