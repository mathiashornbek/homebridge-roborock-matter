# A shrinking mode list bricks an RVC accessory permanently

**Status:** ready to file upstream. Not filed yet.
**Where it belongs:** matter.js (`RvcCleanModeServer.initialize` / `ModeUtils.assertMode`), with a
secondary question for Homebridge about how plugin-supplied cluster state is applied.

## Summary

`CurrentMode` on a ModeBase-derived cluster is nonvolatile and is restored from storage on every
start. `SupportedModes` is **not** stored — it is whatever the device supplies at construction time.
When the supplied list no longer contains the restored `CurrentMode`, `initialize` throws instead of
falling back, the endpoint's construction is rolled back, and the whole accessory fails to register.

The failure is not transient. The stored value never becomes valid on its own, so the accessory
fails to register on every subsequent start too, and the device disappears from the controller for
good. Recovering requires the operator to re-widen the mode list, change the mode from the
controller, and only then narrow it again.

## Environment

- Homebridge 2.3.1 (Matter.js 0.17.9), Node v24.19.0, Debian x64
- `homebridge-roborock-matter` 3.10.0, publishing each robot as its **own** Matter node via
  `publishExternalMatterAccessory` (not a bridged accessory)
- Three separate accessories, three separate Matter storage roots — all three failed identically

## Reproduction

The plugin announces RVC clean modes 0/1/2 (Vacuum, Mop, Vacuum + Mop) always, and additionally
modes 3–7 (suction levels) when an opt-in setting is on. The setting was on, and mode **6** was the
selected one.

1. With the setting on, select a suction level in Apple Home. Stored state becomes `currentMode: 6`.
2. Turn the setting off, so the device now supplies `supportedModes: [0, 1, 2]`.
3. Restart.

Every accessory fails to come up:

```
[Matter/Server] Adding custom RvcCleanMode behavior with handlers
[Matter/Server] Applied 6 custom behavior(s) to device type
[Matter/Transaction] Rolling back ◦initialize<<node-id>.<endpoint-id>>#25 due to error: Behaviors have errors
[Matter/Server] Failed to register Matter accessory Garage: [endpoint-behaviors] Behaviors have errors
      at @matter/node/src/endpoint/properties/Behaviors.ts:253:27
      Cause #0: [behavior-initialization] Error initializing <node-id>.<endpoint-id>.rvcCleanMode
      Caused by: [unsupported-mode] Can not use unsupported mode: 6. Allowed modes are 0, 1, 2
        at Object.assertMode (@matter/node/src/behaviors/mode-base/ModeUtils.ts:32:19)
        at HomebridgeRvcCleanModeServer.initialize (@matter/node/src/behaviors/rvc-clean-mode/RvcCleanModeServer.ts:19:19)
        at ServerBehaviorBacking.invokeInitializer (@matter/node/src/behavior/internal/BehaviorBacking.ts:163:25)
[Matter/Server] Matter server cleaned up (initialised but never ran)
[Matter/ChildManager] Failed to publish external Matter accessory Garage: MatterDeviceError:
  Failed to register accessory: AggregateError: Behaviors have errors
  { code: 'DEVICE_ERROR', recoverable: true }
```

## The stored state, read straight off disk

Only `currentMode` is persisted for the cluster — there is no stored `supportedModes` to compare it
against:

```
$ ls /var/lib/homebridge/matter/<node-id>/<node-id>/ | grep rvcCleanMode
root.parts.<endpoint-id>.rvcCleanMode.__features__
root.parts.<endpoint-id>.rvcCleanMode.currentMode

$ cat root.parts.<endpoint-id>.rvcCleanMode.currentMode
6
```

## Why the device's own value does not save it

The plugin already clamps: it supplies `currentMode` from a helper that only ever returns a mode
present in the list it is supplying alongside it. In the failing run it supplied `currentMode: 0`
together with `supportedModes: [0, 1, 2]`, and the log line confirms it
(`Matter publish for Garage: … cleanMode=0`).

The restored value still won. So the value a device supplies at construction behaves as a default
that the persisted value overrides, and a device has no way to say "this is the mode now, discard
what you stored". That is the second half of the problem: even a device that knows its mode list
shrank cannot repair the state it is about to be judged on.

`recoverable: true` is set on the resulting error, but nothing retries, and a retry with the same
inputs would fail the same way.

## Suggested fix

`assertMode` is the right check for a `ChangeToMode` command coming from a controller — rejecting an
unsupported mode there is correct. It is the wrong behaviour during `initialize`, where the input is
the device's own restored state rather than a controller request.

Preferred: on initialize, if the restored `CurrentMode` is not in `SupportedModes`, fall back to a
supported mode (the supplied one, or the first entry) and log it, rather than throwing. The spec
requires `CurrentMode` to be one of `SupportedModes`; clamping satisfies that invariant, whereas
failing construction leaves the invariant unenforceable and the device unreachable.

Alternative, or in addition: let a device supply `CurrentMode` as an explicit override at
construction so it can reconcile its own persisted state.

## Impact beyond this plugin

Nothing here is specific to suction levels, or to this plugin. Any ModeBase-derived cluster whose
mode list can legitimately differ between two starts hits it — a setting toggled off, a capability
that is detected on one boot and not the next, a device whose firmware drops a mode. The list
shrinking is a normal event; losing the accessory permanently should not be the consequence.
