# MQTT session observations

The settings page's **Copy diagnostics** report includes an `mqttSession`
snapshot. Cloud timeout messages include the same observation at rejection time.
This instrumentation does not change transport selection, subscription handling,
request readiness, retries, the unanswered-method breaker, or reconnection.

- `generation` increments on each MQTT connect event, including automatic
  reconnects. It restarts with the plugin process; it is not a broker session ID.
- `connected` and `subscriptionAcknowledged` are separate observations. The latter
  requires a successful SUBACK with granted QoS values. It does not gate sends.
- Inbound ages distinguish the raw MQTT callback, attribution to a known robot,
  successful Roborock decoding, and correlation to a pending request. A correlated
  reply can be a refusal or a secure-map acknowledgement, not necessarily a
  completed successful operation. Unmatched messages do not update reply age.
- `lastLocalReplyAgeMs` records successful local request completions separately.
  It is account-wide supporting context, not proof that every robot answers LAN.
- `null` means that stage has not been observed in this connection generation.

`correlatedSilenceObserved` requires unanswered `get_*` cloud requests from at
least two distinct robots in the preceding 60 seconds, on the current connected,
subscription-acknowledged generation. Each request must have seen no raw MQTT
callback since it was sent. Any raw callback (even one that cannot be attributed
or decoded), disconnect, or new generation clears this evidence. Repeated
failures from one robot, writes, and idle time alone do not qualify. The in-memory
set is bounded to 128 robots. This is deliberately a conservative observation,
not a diagnosis of the client, broker, network, or robot-cloud path. B01 methods
translated to `prop.get` and separate map-upload requests do not contribute to
this first observation rule; their inbound replies are still measured.

The snapshot contains ages and counts, not robot IDs, MQTT topics, credentials,
or payloads. Activity-triggered persistence is limited to once per 30 seconds;
connection transitions, subscription results, and cloud timeouts publish
immediately. Ages are measured with a monotonic clock **at `capturedAt`**, not
at report-copy time. A quiet or stopped plugin can therefore have an older
snapshot. A successful local-only workload can legitimately have no MQTT replies.
The existing timeout log suppression still applies; this adds no polling timer
or network probes.

Tests drive production connect/SUBACK/message callbacks, actual request timeouts,
the settings diagnostics route, and the copied report. Run:

```sh
npm test -- --runInBand __tests__/mqtt-session-observations.test.js
```
