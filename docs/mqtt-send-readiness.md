# MQTT send readiness and response timing

Cloud RPCs wait up to 10 seconds for the current MQTT connection's reply
subscription to be acknowledged. TCP connect alone is insufficient. mqtt.js can
acknowledge a reconnect through a real SUBACK while its subscribe callback returns
an empty list; the gate uses the existing session observations for that case.
The gate observes connection state: it does not restart MQTT or replay commands.
Requests already routed to a working LAN connection do not wait on MQTT.

No RPC response timer or pending request exists while waiting for readiness.
Once publication returns, the robot gets its full existing response budget:
usually 10 seconds for an RPC and 20 seconds for a B01 map upload. Publication
here means handed to mqtt.js, not proof that the broker or robot received it.
For a default RPC, readiness plus response can therefore take about 20 seconds,
in addition to payload building, existing operation queues and any caller retries.

If readiness expires, the promise rejects with `MQTT_READINESS_TIMEOUT`,
`requestNotSent: true`, and `unansweredRequest: false`. The message says the reply
subscription did not become ready and the command was not sent. There is no robot
timeout, breaker increment, silence-recovery evidence, delayed publication, or
automatic replay from this gate. Disconnect cancels outstanding waits.

## What the user sees

This PR does not change Apple Home's acknowledgement or display policy. There is
no new "waiting for MQTT" tile or progress indicator.

- Native Matter commands already dispatch work in the background. A readiness
  failure follows the existing command-error path: an error log names the action
  and robot, and the plugin republishes current state while clearing its optimistic
  state. Home may briefly show the requested state before that correction.
- Existing HAP handlers that await the operation remain pending for longer. Their
  existing catch paths determine whether the error is returned or merely logged.
  For example, schedule writes retain their existing confirmation/rollback path;
  the gate does not guarantee an Apple Home error banner.
- Background polling has no user command to acknowledge. The failed read follows
  the existing diagnostics path and leaves the last reported robot state in place.

These are code-path guarantees, not observed Apple Home screenshots. Whether a
particular controller shows a spinner, a transient error, or just the eventual
state correction must be checked on the installed build. Before merge, record a
brief reconnect that succeeds and an outage exceeding 10 seconds, for both a
Matter command and a HAP switch. Include timestamps for the press, publication or
readiness failure, and the displayed state. Do not describe the expiry as a robot
refusal: no command was sent.
