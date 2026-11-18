# Momentary Home action acknowledgement

Follow-up to https://github.com/mathiashornbek/homebridge-roborock-matter/pull/36.

Start, Dock, Empty Bin, Pause, Find and routine switches acknowledge a press as
accepted immediately. The command runs in the background through its existing
command path. The button returns to rest independently of command completion;
it does not assert that the robot acted. Robot state continues through normal
updates. Persistent schedule switches are outside this change.

Failures after acknowledgement are warnings or errors identifying the action,
robot and reason. This includes routine cloud failures and unavailable or
unsupported action targets. A renamed switch does not erase robot identity.
No late HAP write error can be returned after acknowledgement, so a button can
accept a press even when the robot does nothing; the log explains known failures.
A successful transport acknowledgement alone cannot prove physical movement.

Start, Dock, Empty Bin and Pause already dispatch through the background Matter
command path in v3.39.0. The new acknowledgement behavior applies to Find and
Routine switches; the other actions gain consistent acceptance/failure wording.

Repeated presses of the same Routine while its request is queued or awaiting the
cloud response are ignored, with an informational line naming the Routine and
robot. The 1.5-second switch reset does not release this guard. After the cloud
request finishes, another press is allowed; this does not wait for the physical
cleaning routine to finish, since the request response cannot prove that.
