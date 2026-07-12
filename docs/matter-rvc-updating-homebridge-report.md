# Matter Robotic Vacuum Cleaner (device type 0x74) "Updating…" investigation in Apple Home

Evidence gathered live from a running Homebridge 2.1.1‑beta.1 container for
**homebridge/homebridge#3951**.

## Summary

A Matter Robotic Vacuum Cleaner (RVC, device type `0x74`) exposed through Homebridge 2's Matter API commissioned successfully into Apple Home, the controller subscribed and read every attribute **without error**, but the accessory tile initially stayed **stuck on "Updating…"** and never became controllable.

The exposing plugin was ruled out during the original failure (see "Ruled out"). A later clean reset/re-pair of the same external RVC node, with the full intended cluster set enabled, rendered correctly in Apple Home on both Mac and iPhone. The current read is that the failure was likely stale Apple Home controller/presentation state, or a Homebridge/matter.js/Apple Home presentation edge case that is not deterministic.

## Latest status

After resetting the Homebridge external RVC Matter node and removing the stale Apple Home accessory, the full RVC endpoint paired and rendered successfully:

- Apple Home tile reached `Ready` on Mac and iPhone.
- The control sheet opened with Start, Clean Mode, Rooms, and Send to Dock.
- The Rooms sheet rendered the expected Service Area choices.
- Homebridge logs showed successful commissioning, fresh subscriptions, and full state publishes for `rvcRunMode`, `rvcOperationalState`, `rvcCleanMode`, `serviceArea`, and `powerSource`.
- No Homebridge conformance errors or subscription cancellations were found.

One Apple Home log remained:

```text
No options for RVC secondaryCleanControl
```

That log appeared non-fatal because the UI rendered and was controllable. The earlier `primaryCleanControl` / `Failed to build RVC status button control` messages only appeared on the stale pre-removal accessory and did not recur after fresh pairing.

## Environment

|                            |                                                                |
| -------------------------- | -------------------------------------------------------------- |
| Homebridge                 | **2.1.1‑beta.1** (also the newest published; `latest` = 2.1.0) |
| matter.js (`@matter/main`) | **0.17.2-alpha.0-20260605-b2c9f3f65**                          |
| Node                       | 24.17.0 (Docker `homebridge/homebridge:beta`)                  |
| Exposing plugin            | homebridge-roborock-vacuum2 1.4.58 (also reproduced on 1.4.42) |
| Controller                 | Apple Home, multi‑hub (Apple TV + HomePod), current iOS/tvOS   |
| Device                     | Roborock S6 Pure exposed as RVC `0x74` rev 4                   |

The RVC is published as a **standalone external Matter node** (its own commissioning node, separate from the child bridge's aggregator node), which is the documented Homebridge behavior for robotic vacuums.

Endpoint as instantiated by Homebridge:

```
endpoint#1 type: RoboticVacuumCleaner (0x74, rev 4)
behaviors: ✓identify ✓rvcRunMode ✓rvcOperationalState ✓rvcCleanMode ✓serviceArea ✓powerSource ✓descriptor
```

## Original symptom

- Commissioning completes: `generalCommissioning.commissioningComplete errorCode: 0`.
- The controller establishes a subscription and reads the RVC endpoint.
- The Apple Home tile shows **"Updating…" indefinitely** and is never controllable.
- It briefly clears if an `Identify` command is invoked (e.g. "Play Sound to Locate"), then reverts — i.e. a command round‑trip forces a one‑time re‑render, but passive subscription data does not.

## Original reproduction

1. Expose any Matter RVC (`0x74`) via Homebridge 2.1.x‑beta Matter.
2. Commission it into Apple Home.
3. Observe the tile never leaves "Updating…".

## What we ruled out (each with evidence)

| Hypothesis                      | Test                                                                    | Result                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Exposing plugin / its data      | Deployed a known‑good older plugin build                                | **Identical failure**                                                                                          |
| Stale/corrupt controller record | Full remove + fresh re‑pair (multiple times)                            | Still "Updating…"                                                                                              |
| Transport / reachability        | Inspected the subscription                                              | Controller subscribes, reads endpoint 1, **0 attribute errors**, ACKs all reports, then settles (no read loop) |
| Service Area cluster            | Removed `serviceArea` from the endpoint, re‑paired                      | Still "Updating…"                                                                                              |
| Multi‑admin contamination       | Device is co‑commissioned to Apple (vendor 4937) + Amazon (vendor 4996) | Amazon fabric is **idle (0 messages)**; multi‑admin is normal — not the cause                                  |

## Wire‑level evidence

The persisted RVC Operational State cluster is spec‑conformant (PhaseList/CurrentPhase null, only base states advertised, no labels):

```json
{
  "phaseList": null,
  "currentPhase": null,
  "operationalStateList": [
    { "operationalStateId": 0 },
    { "operationalStateId": 1 },
    { "operationalStateId": 2 },
    { "operationalStateId": 3 }
  ],
  "operationalState": 0
}
```

`rvcRunMode` / `rvcCleanMode` advertise valid `supportedModes` with conformant `modeTags`, and each `currentMode` exists in its `supportedModes`. The controller reads all of this with no `Status=Unsupported*`/constraint errors (only the benign `OTA Requestor (0x2A)` and Apple vendor‑cluster `0x1349…` probes return UnsupportedCluster, as expected).

During the original failure, the controller received correct, conformant, error‑free RVC data over a healthy subscription and still refused to render the tile.

## What we suspect / open question

Since the controller never errored on a read yet did not render until a later reset/re-pair, the gap is likely one of:

1. **Stale Apple Home controller/presentation state** for the external RVC node, especially after cluster-set or persisted-state changes, **or**
2. **A Homebridge/matter.js or Apple RVC presentation edge case** that can be cleared by a clean node reset and fresh Apple Home pairing.

**Questions for maintainers:**

- Is Matter RVC (`0x74`) via Homebridge 2.1.x expected to render in Apple Home today, or is it a known gap/limitation?
- Is the **standalone external node** the correct structure for RVC, and does Apple's RVC client require anything beyond what `@matter/main` 0.17.2 emits for this device type?
- Are there required RVC attributes/feature‑map bits (e.g. on RVC Operational State, or Service Area conformance) that the device type should be advertising but isn't?

## If it recurs

If the issue recurs after a clean reset/re-pair, pair the same RVC node into a **non‑Apple ecosystem with real RVC support (Google Home)**:

- Renders in Google but not Apple ⇒ **Apple RVC client** issue.
- Fails in Google too ⇒ **Homebridge/matter.js RVC output** issue.

(We could not use Alexa for this — Amazon co‑commissions the node automatically but its RVC support doesn't surface a usable tile, so it's not a clean comparison.)

## Notes

- The Apple + Amazon dual‑fabric is normal Matter multi‑admin (the Amazon fabric is created by the iOS‑level linked‑ecosystem handoff, not the plugin) and is **not** the cause — the failure reproduces identically and the Amazon fabric is idle.
- Logs (commissioning, subscription, attribute reads, persisted cluster state) are available on request, redacted of pairing codes.
