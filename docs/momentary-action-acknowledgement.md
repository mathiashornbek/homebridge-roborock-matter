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

## Validation before merge

Automated tests cover immediate acceptance, existing command routing, reset,
o commands from off writes, and prominent failure logs for all five actions and
routines. Physical-robot validation is pending. Do not mark it complete based on
the suite. Install the integrated home branch and record successful actions and
failed commands: timestamp, robot/action, button response, actual robot response
and corresponding warning/error. State clearly that this is integration-branch
validation rather than an isolated acknowledgement-branch installation.
