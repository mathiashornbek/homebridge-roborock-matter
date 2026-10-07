# Opt-in MQTT session recreation (PR 3 of 4)

`enableMqttSessionRecovery` defaults to false. Enable it in advanced plugin
settings or config.json and restart the child bridge to participate in this
experimental release. Leaving it absent preserves v3.36.0's default recovery:
three consecutive cloud timeouts with the link up and no traffic from the robot
while each request waited restart MQTT, at most once every thirty minutes.

With recovery enabled, the measured multi-robot silence from PRs 1 and 2 can
recreate the account's MQTT client. Upstream's baseline remains active (including
single-robot silence) and uses the same bounded lifecycle. The correlated policy
adds cross-robot evidence; it does not disable or narrow the baseline's counting
rules. Local timeouts and idle time do not trigger reactive recreation.

Cloud sends pause until the broker acknowledges the reply subscription. During
recreation, new cloud requests fail as not sent; requests already building a
payload recheck the gate before publication. Local requests keep operating.
Existing cloud requests get up to 500 ms to finish. Remaining requests, including
B01 map reads, reject with an unknown outcome and are never replayed. This does
not reconcile ambiguous schedule writes; that belongs to PR 4.

Recreation is single-flight. Forced client teardown is bounded at two seconds;
connection plus subscription readiness is bounded at twenty seconds. Successful
attempts have a one-minute minimum interval; failures back off from one to fifteen
minutes. Both silence policies additionally share upstream's thirty-minute
cooldown, measured from actual teardown. Any replacement resets the baseline
streak and starts that silence cooldown, including preventive refresh. Concurrent
triggers share one in-flight attempt. There is no tight retry loop: subsequent qualifying evidence or the
existing hourly connection check can retry after that cooldown. Shutdown cancels
waits and prevents another client from being created. Retired client callbacks
cannot change readiness or process messages. Readiness observes actual SUBACK
packets, including mqtt.js automatic resubscriptions; successful empty subscribe
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
still outstanding after the drain window, including a write or B01 map request.
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

Results are `never`, `in-progress`, `succeeded`, `failed`, `deferred` (new traffic
or an active request made recreation unnecessary), or `stopped` during teardown.
Suppressed attempts do not replace the last actual attempt's reason/result.
Snapshots are emitted when an attempt begins and finishes, including failed
attempts. Diagnostics change neither trigger policy nor retry timing.
With experimental recovery disabled, the object is `{ enabled: false }`; it does
not claim that upstream's separate default cloud-silence rule is disabled.
