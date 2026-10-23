# MQTT presence logging

Retained broker snapshots stay at debug level and do not establish the live
baseline. The first live online report is informational and says "first", without
claiming a recovery. The first live offline report is a warning, as are later
offline transitions. Reconnects do not reset the baseline. Repeated identical
live values produce no further informational or warning messages. A later
offline-to-online transition is reported as back online. DUP packets are
processed because the earlier copy may never have arrived.

Offline reports warn that cloud commands may fail. Only robots that support LAN
commands, with cloud-only mode disabled, receive the additional explanation that
LAN commands may still work. B01 robots, including Q7 models, do not receive that
reassurance. This changes logging only, not connectivity, routing or recovery.
