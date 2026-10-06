# PR5: home-branch extras for discussion

This is a work-in-progress proposal based directly on upstream v3.36.0. It is
independent of PRs #29–#32 and is not a fifth prerequisite for merging that series.

## Momentary action switches

Start, Dock, Empty Bin, Pause and Find acknowledge the HomeKit write immediately
while the existing command path completes in the background. This keeps a button
press from waiting for the robot's network round trip. The existing reset,
command routing and error logging remain in place.

The acknowledgement means the press was accepted, not that the robot succeeded.
A later failure is visible in plugin logs rather than returned through the HAP
write. The switch is already momentary and reads off; no robot state is invented.
Schedule switches and routine switches are outside this proposal.

## MQTT presence wording and transition logging

A protocol-500 offline notification is reported as what the robot said, not proof
that every local or cloud command must fail. Equal live values are logged once;
an initial online value does not claim a recovery. Retained subscription snapshots
remain visible at debug level but do not establish or change the live baseline.
The DUP flag does not suppress a first received copy. Boolean and numeric 0/1
values are supported, and observations are kept separately per robot.

This changes logging only. It does not mark devices online/offline, gate commands,
change breaker counts, or trigger recovery. Suppressing retained messages at warning
level trades a possibly useful startup hint for avoiding stale transition claims.

## Questions for the maintainer

- Is immediate HAP acknowledgement appropriate for these momentary actions, given
  that later command failures are logged rather than returned to the controller?
- Should retained presence snapshots be debug-only, or should they have a distinct
  startup informational message?
- Would you prefer these two independent changes split into separate PRs after
  agreeing on behavior?

The readiness wait, request timeout accounting, recovery diagnostics, and immediate
shutdown teardown are topics for PR3/lifecycle follow-up. Optimistic schedule
presentation, pending-write deduplication and routine acknowledgement are topics
for PR4. They are deliberately not added here.
