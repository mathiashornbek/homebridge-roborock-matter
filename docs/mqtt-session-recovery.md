# Opt-in MQTT session recreation (PR 3 of 4)

`enableMqttSessionRecovery` defaults to false. Enable it in advanced plugin
settings or config.json and restart the child bridge to participate in this
experimental release. Leaving it absent preserves the existing reconnect path.

With recovery enabled, the measured multi-robot silence from PRs 1 and 2 can
recreate the account's MQTT client. A single silent robot, idle time, local
timeouts, or writes alone do not trigger reactive recreation.

Cloud sends pause until the broker acknowledges the reply subscription. During
recreation, new cloud requests fail as not sent; requests already building a
payload recheck the gate before publication. Local requests keep operating.
Existing cloud requests get up to 500 ms to finish. Remaining requests, including
B01 map reads, reject with an unknown outcome and are never replayed. This does
not reconcile ambiguous schedule writes; that belongs to PR 4.

Recreation is single-flight. Forced client teardown is bounded at two seconds;
connection plus subscription readiness is bounded at twenty seconds. Successful
attempts have a one-minute cooldown; failures back off from one to fifteen
minutes. There is no tight retry loop: subsequent qualifying evidence or the
existing hourly connection check can retry after that cooldown. Shutdown cancels
waits and prevents another client from being created. Retired client callbacks
cannot change readiness or process messages.

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
request-queue timeouts; the same tests are run against PR 2 as a red baseline.
