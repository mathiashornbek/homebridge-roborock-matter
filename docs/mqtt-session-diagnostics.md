# MQTT session observations

The settings page's **Copy diagnostics** report includes an `mqttSession`
snapshot. Cloud timeout messages include the same observation at rejection time.
The observations do not change transport selection, subscription handling,
request readiness, retries, or reconnection. The breaker integration below uses
the measured signal to avoid counting account-session failures against methods.

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

## Breaker integration (PR 2 of 4)

A production cloud timeout carries `accountSessionWasSilent: true` only when
its own read qualified for the correlated-silence observation at rejection time.
The error still rejects the caller normally and retains `unansweredRequest` and
`transportWasUp`. The breaker reads the boolean field, not the log text, and
ignores that failure rather than incrementing the robot/method count.

This is prospective suppression: previous counts and already-open breakers are
not cleared, and genuine robot-method failures keep their existing cooldowns.
Until cross-robot evidence exists, ordinary counting continues. Inbound activity,
evidence expiry, or a new generation can make subsequent read timeouts count
again. Local timeouts, writes, and requests spanning generations do not inherit
an unrelated account observation. Missing instrumentation keeps the existing
classification. `requestWasSilent` in the timeout snapshot explains whether
that particular request qualified; the persisted account snapshot remains
request-independent.

This is the second change in the four-part series discussed in issue #27:

1. Session instrumentation and diagnostics (#29).
2. Feed correlated silence into the breaker (this change).
3. Opt-in bounded session recreation, with separately switchable preventive refresh.
4. Read-before-retry schedule reconciliation (independently reviewable).

No session recreation, retry, request gating, schedule writes, or new settings
are introduced here.
