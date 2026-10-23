# Opt-in MQTT session recreation

This proposal is parked for further field evidence. The full optional lifecycle
is retained here for comparison, rather than proposed for immediate merge. The
branch is based on 3.40.0-beta.2 and the revised ordinary send-readiness change.
3.40 already creates a fresh client with a random id on every reconnect.

`enableMqttSessionRecovery` defaults to false. Enable it in advanced plugin
settings or config.json and restart the child bridge to participate in this
experimental release. Leaving it absent preserves 3.40's default recovery: three consecutive V1
cloud timeouts with the same link up restart MQTT at most once every thirty
minutes. B01 traffic does not reset that streak. Ordinary reconnections use
3.40's 10-second, growing backoff and a fresh client with a new random id.

With recovery enabled, the measured multi-robot silence can
recreate the account's MQTT client. Upstream's baseline remains active (including
single-robot silence) and uses the same bounded lifecycle. The correlated policy
adds cross-robot evidence; it does not disable or narrow the baseline's counting
rules. Local timeouts and idle time do not trigger reactive recreation.

Cloud sends pause until the broker acknowledges the reply subscription. During
recreation, new cloud requests use the ordinary bounded readiness gate; a request
that cannot become ready within ten seconds fails as not sent. The gate is checked
again at publication. Local requests keep operating.
Existing cloud requests get up to 500 ms to finish. Remaining requests, including
B01 map reads, reject with an unknown outcome and are never replayed. Schedule
write reconciliation is independent of this lifecycle.

Recreation is single-flight. Forced client teardown is bounded at two seconds;
the experimental replacement opens immediately using upstream's client factory,
and connection plus subscription readiness is bounded at twenty seconds. Successful
attempts have a one-minute minimum interval; failures back off from one to fifteen
minutes. Both silence policies additionally share upstream's thirty-minute
cooldown, measured from actual teardown. Every replacement resets the baseline
streak, but only silence-triggered recovery starts the thirty-minute cooldown.
Preventive and health-check refreshes use the one-minute minimum interval instead.
A replacement that misses its twenty-second readiness deadline stays alive and
the connector keeps retrying with upstream's backoff and fresh clients. A connected client whose SUBACK remains
missing/refused, or a failed client creation, is retried after the bounded backoff.
Concurrent triggers share one in-flight attempt. Shutdown cancels
waits and prevents another client from being created. Retired client callbacks
cannot change readiness or process messages. Readiness observes actual SUBACK
packets on each fresh client; successful empty subscribe
callbacks leave readiness unchanged. The real mqtt.js loopback-broker regression
runs with experimental recovery both off and on.

## Preventive refresh: separate and off by default

`enableMqttPreventiveRefresh` defaults to false and lives in the collapsible
Advanced troubleshooting section of the plugin config UI for now. The maintainer
can choose another presentation later. It is a configuration option, not a HomeKit
accessory. It requires experimental session recovery to be enabled, and a child
bridge restart after changing it.

When enabled, a once-per-minute check refreshes sessions that have been ready for
at least four hours. Refresh defers if any cloud request is
outstanding, including a write or B01 map request, before closing the send gate.
Commands arriving during that deferral can still use the ready session.
It does not coordinate entire multi-command schedule transactions.

Lifecycle logs contain reasons, generations, timing and cooldowns, not credentials
or request payloads. The regression tests drive real connector callbacks and
request-queue timeouts; upstream baseline tests are retained, with additional tests for overlapping triggers and the shared cooldown.

## Recovery diagnostics

The persisted `MqttSessionDiagnostics` snapshot includes a `recovery` object:
`enabled`, `preventiveRefreshEnabled`, `inProgress`, `lastReason`, `lastResult`,
`consecutiveFailures`, `cooldownRemainingMs`, and `silenceCooldownRemainingMs`.
The two remaining durations distinguish the general success/failure cooldown from
the shared 30-minute silence cooldown. They are measured when the snapshot is
written; a saved snapshot is not a live countdown.

Results are `never`, `in-progress`, `succeeded`, `failed`, `recovered` (the retained replacement later became ready), `deferred` (new traffic
or an active request made recreation unnecessary), or `stopped` during teardown.
Suppressed attempts do not replace the last actual attempt's reason/result.
Snapshots are emitted when an attempt begins and finishes, including failed
attempts. Diagnostics change neither trigger policy nor retry timing.
With experimental recovery disabled, the object is `{ enabled: false }`; it does
not claim that upstream's separate default cloud-silence rule is disabled.

The ordinary startup watchdog and connection error/closed/recovered logs
also remain active in recovery mode. Client retirement preserves mqtt.js's own
listeners and handshake cleanup; guarded callbacks ignore retired clients.

The diagnostic `lastEligibleRead` records the most recent eligible timeout's
`generation`, `rawSilenceDuringRequest` and `ageMs`, even across disconnect/reconnect.
It is historical evidence only; current-generation correlation is still cleared.
