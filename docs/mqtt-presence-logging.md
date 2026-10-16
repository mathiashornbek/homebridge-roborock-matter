# MQTT presence logging

Retained broker snapshots stay at debug level and do not establish the live
baseline. The first live presence report produces one informational message per
robot during the plugin lifetime, saying online or offline without claiming a
recovery. Reconnects do not reset that baseline. Repeated identical live values
produce no further informational or warning messages. Later offline transitions
are warnings; a later offline-to-online transition is reported as back online.
DUP packets are processed because the earlier copy may never have arrived.

Cloud presence does not establish whether LAN commands can succeed. Logs avoid
claiming that an offline notification makes every command fail. This changes
logging only, not connectivity, command routing or recovery policy.

This is the presence-only part of the discussion in upstream PR #36. Momentary
action acknowledgement is a separate proposal with separate validation.
