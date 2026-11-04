# MQTT send readiness and response timing

Cloud RPCs wait up to 10 seconds for the current MQTT connection's reply
subscription to be acknowledged. TCP connect alone is insufficient. mqtt.js can
acknowledge a reconnect through a real SUBACK while its subscribe callback returns
an empty list; the gate uses the existing session observations for that case.
The gate observes connection state and never replays commands. After three
consecutive readiness expiries on a connected but unsubscribed client, the
connector requests a fresh session using the existing 30-minute health-restart
cooldown. Disconnected expiries and waits started on an older connection do not count. A successful SUBACK or disconnect
resets that streak. Reconnection keeps 3.40's new-client-per-connection backoff.
Requests with a working LAN route do not wait on MQTT, including `preferCloud`
requests while MQTT is disconnected or still awaiting SUBACK. Cloud-only, remote,
secure, map/network-info and B01 operations still require MQTT. Readiness is event-driven: a
SUBACK wakes waiting requests; each has one deadline timer, with no polling or
repeated diagnostics snapshots.

No RPC response timer or pending request exists while waiting for readiness.
Without an explicit caller timeout, publication starts the full response budget:
usually 10 seconds for an RPC and 20 seconds for a B01 map upload. Publication
here means handed to mqtt.js, not proof that the broker or robot received it.
For a default RPC, readiness plus response can therefore take about 20 seconds,
in addition to payload building, existing operation queues and any caller retries.

An explicit `requestTimeoutMs` is a total command budget: initial readiness is
capped by the time remaining, and only the remainder is available for the reply.
A two-second command is never published when MQTT recovers nine seconds later.
A failed LAN request is retried only while MQTT is connected. If that retry cannot
be published, the original LAN failure is retained, including breaker and
late-reply evidence. A disconnected cloud does not add a ten-second wait to a
LAN failure.

If readiness expires, the promise rejects with `MQTT_READINESS_TIMEOUT`,
`requestNotSent: true`, and `unansweredRequest: false`. The message says the reply
subscription did not become ready and the command was not sent. There is no robot
timeout, method-breaker increment, delayed publication, or automatic replay.
Connected-but-unsubscribed expiries can request the bounded health restart above.
Shutdown cancels outstanding waits. With neither LAN nor ready MQTT available,
a command waits up to 10 seconds before failing as unsent.

## What the user sees

Existing acknowledgement and display policies are retained. Locate/Identify,
which await their command, use a 2.5-second command budget. There is no new
"waiting for MQTT" tile or progress indicator.

- Native Matter commands already dispatch work in the background. A readiness
  failure follows the existing command-error path: an error log names the action
  and robot, and the plugin republishes current state while clearing its optimistic
  state. Home may briefly show the requested state before that correction.
- Existing HAP handlers that await the operation remain pending for longer. Their
  existing catch paths determine whether the error is returned or merely logged.
  Schedule switches in 3.40 answer HomeKit within 2.5 seconds and confirm in
  the background; a later failure rolls the switch back. Controller-specific
  error presentation still requires a live check.
- Background polling has no user command to acknowledge. The failed read follows
  the existing diagnostics path and leaves the last reported robot state in place.

These are code-path guarantees, not observed Apple Home screenshots. Whether a
particular controller shows a spinner, a transient error, or just the eventual
state correction must be checked on the installed build. Useful live validation is a
brief reconnect that succeeds and an outage exceeding 10 seconds, for both a
Matter command and a HAP switch. Include timestamps for the press, publication or
readiness failure, and the displayed state. Do not describe the expiry as a robot
refusal: no command was sent.
