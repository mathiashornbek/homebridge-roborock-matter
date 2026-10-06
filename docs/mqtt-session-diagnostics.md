# MQTT session observations

The settings page's **Copy diagnostics** report includes an `mqttSession`
snapshot. Cloud timeout messages append a short summary only for correlated
silence or an unacknowledged subscription; the full snapshot stays in diagnostics.
This instrumentation does not change transport selection, subscription handling,
request readiness, retries, the unanswered-method breaker, or reconnection.

- `generation` increments on each MQTT connect event, including automatic
  reconnects. It restarts with the plugin process; it is not a broker session ID.
- `connected` and `subscriptionAcknowledged` are separate observations. The latter
  observes successful SUBACK packets through the current client's `packetreceive`
  event, including mqtt.js automatic resubscriptions after reconnect. Nonempty
  connect-handler callback grants also record the result for their captured
  generation. mqtt.js can call back with no error and an empty granted list for
  a topic it already knows; this is a no-op, not an acknowledgement or refusal.
  Failed subscriptions and refused SUBACK grants remain unacknowledged. Late
  callbacks from older connections and the legacy reconnect-handler callback
  cannot acknowledge or revoke the new generation. The existing subscribe calls
  remain unchanged; this does not gate sends. The timeout summary only says
  "subscription not acknowledged" when the session is still connected.
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

`rawSilenceDuringRequest` describes the latest eligible `get_*` cloud read
that timed out on the current connected, acknowledged generation: `true` means
no raw MQTT callback arrived between send and timeout, `false` means at least
one did, and `null` means no eligible timeout has been observed. It is useful
on single-robot accounts without relaxing the two-robot correlation rule.
`lastReadTimeoutAgeMs` dates that observation at `capturedAt`; later traffic
does not rewrite the historical result. Disconnect and connect reset both
fields. Writes, B01 translated reads, and old-generation timeouts cannot
supply this observation. An idle or non-answering robot can produce raw silence
on a healthy session: this is evidence to inspect, not a session-fault verdict
or a reason to change breaker/recovery policy in this PR.

The snapshot contains ages and counts, not robot IDs, MQTT topics, credentials,
or payloads. Activity-triggered publication is limited to once per 30 seconds;
connection transitions, subscription results, and cloud timeouts publish
immediately into memory. The production API debounces disk writes to at most
once per 60 seconds and flushes pending values on shutdown. The UI reads this
disk snapshot, so a new observation may take up to a minute to appear. Ages are measured with a monotonic clock **at `capturedAt`**, not
at report-copy time. A quiet or stopped plugin can therefore have an older
snapshot. A successful local-only workload can legitimately have no MQTT replies.
The existing timeout log suppression still applies; this adds no polling timer
or network probes.

Tests drive production connect/SUBACK/message callbacks, actual request timeouts,
the real API persistence/debounce and shutdown flush, the settings diagnostics
route, and the copied report. No diagnostics snapshot file is seeded by the test. Run:

```sh
npm test -- --runInBand __tests__/mqtt-session-observations.test.js
npm test -- --runInBand __tests__/mqtt-session-real-reconnect.test.js
```

The reconnect regression uses the real mqtt.js client and production connector
against a loopback TCP broker implemented with mqtt.js's MQTT packet codec. It
drops the socket, withholds the second SUBACK, and verifies generation 2 becomes
acknowledged only after that packet arrives. It also checks the broker receives
exactly one SUBSCRIBE per connection. No Roborock account or external broker is
used. Upstream v3.36.0's recovery policy remains unchanged by this instrumentation.
