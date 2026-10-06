"use strict";

/**
 * A replay of the RVC endpoint the way @matter/node 0.17.9 actually stores it
 * — the build Homebridge 2.4.0 ships — rather than the way the plugin's
 * comments describe it.
 *
 * WHY A SECOND HELPER. test-support/operational-state-writes.js models one
 * measured effect ("a write carrying operationalState wipes the error") and
 * nothing else. It omits the half of RvcOperationalStateServer that explains
 * that measurement: a non-NoError operationalError FORCES operationalState to
 * Error. Every test built on the old helper can therefore assert things the
 * real store never holds — e.g. "Running with fault 68" — and pass.
 *
 * Each `updateAccessoryState` call below is one Homebridge write, i.e. one
 * `endpoint.set({ [cluster]: attributes })` transaction (Homebridge 2.4.0
 * dist/matter/server/StateManager.js:104-105). Within it:
 *
 *  - Attributes are assigned, then every CHANGED field's `$Changing` reactor
 *    runs pre-commit (Datasource.ts:793-815; "changed" is isDeepEqual,
 *    Datasource.ts:955-966). A reactor that throws rolls the whole write back.
 *  - `$Changed` reactors run post-commit and may write again.
 *
 * Reactors modelled, all from @matter/node 0.17.9 src/behaviors:
 *
 *  rvc-operational-state/RvcOperationalStateServer.ts
 *   :72-77  operationalState must be in operationalStateList, else throw.
 *   :78-84  leaving Error while an error stands clears operationalError.
 *   :55-70  currentPhase must be null with an empty list, in range otherwise.
 *   :49-53  phaseList$Changed to null/empty forces currentPhase = null.
 *   :87-97  operationalError$Changed: NoError -> nothing (state NOT restored);
 *           anything else -> operationalState = Error (3) and the
 *           OperationalError EVENT is emitted.
 *  rvc-clean-mode/RvcCleanModeServer.ts:20,36-38 and
 *  rvc-run-mode/RvcRunModeServer.ts:20,54-56
 *           currentMode must be in supportedModes (mode-base/ModeUtils.ts:30-36).
 *  service-area/ServiceAreaServer.ts
 *   :92-145 supportedAreas: unique ids, non-empty info, unique AreaInfo per
 *           map, mapId null iff supportedMaps is empty.
 *   :73-90  supportedMaps: unique ids and names.
 *   :147-183 selectedAreas / currentArea / progress must reference
 *           supportedAreas.
 *
 * A rejected write does NOT reach the caller: Homebridge 2.4.0's
 * MatterAPIImpl.updateAccessoryState (dist/matter/MatterAPIImpl.js:337-357)
 * emits an event and returns; the set runs later in a setImmediate and its
 * failure is only logged (StateManager.js:94-130). So `updateAccessoryState`
 * here resolves either way and the rejection is recorded in `rejected`.
 *
 * The model was checked against the real 0.17.9 library on an offline
 * ServerNode (memory storage, mDNS stubbed): every sequence in the tests that
 * use it produced the same final store and the same event count there.
 */

const ERROR = 3;
const NO_ERROR = 0;

function isDeepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class ValidationError extends Error {}

const PRE_COMMIT = {
  rvcOperationalState: {
    // Field order is the cluster's own (Datasource iterates Object.keys of
    // the state class), which is the order reactors fire in.
    order: [
      "phaseList",
      "currentPhase",
      "operationalStateList",
      "operationalState",
      "operationalError",
    ],
    currentPhase(state, newValue) {
      if (state.phaseList === null || state.phaseList.length === 0) {
        if (newValue === null) return;
        throw new ValidationError(
          "Cannot set current phase to an other value than null when phase list is empty"
        );
      }
      if (
        newValue === null ||
        newValue < 0 ||
        newValue >= state.phaseList.length
      ) {
        throw new ValidationError(
          `Current phase ${newValue} is out of bounds for phase list of length ${state.phaseList.length}`
        );
      }
    },
    operationalState(state, newValue, oldValue) {
      if (
        !(state.operationalStateList || []).some(
          ({ operationalStateId }) => operationalStateId === newValue
        )
      ) {
        throw new ValidationError(
          `Cannot set operational state id ${newValue} as it is not in the operational state list`
        );
      }
      if (
        oldValue === ERROR &&
        state.operationalError?.errorStateId !== NO_ERROR &&
        newValue !== ERROR
      ) {
        state.operationalError = { errorStateId: NO_ERROR };
      }
    },
  },
  rvcCleanMode: {
    order: ["supportedModes", "currentMode"],
    currentMode: assertMode,
  },
  rvcRunMode: {
    order: ["supportedModes", "currentMode"],
    currentMode: assertMode,
  },
  serviceArea: {
    order: [
      "supportedAreas",
      "supportedMaps",
      "selectedAreas",
      "currentArea",
      "estimatedEndTime",
      "progress",
    ],
    supportedAreas(state, areas) {
      const ids = new Set();
      for (const { areaId, areaInfo } of areas) {
        if (ids.has(areaId)) {
          throw new ValidationError(`AreaID ${areaId} is not unique`);
        }
        const { locationInfo, landmarkInfo } = areaInfo;
        if (locationInfo === null && landmarkInfo === null) {
          throw new ValidationError(
            `Area ${areaId} has no location or landmark info`
          );
        }
        ids.add(areaId);
      }
      const mapIds = new Set();
      for (let i = 0; i < areas.length; i += 1) {
        mapIds.add(areas[i].mapId);
        for (let j = i + 1; j < areas.length; j += 1) {
          if (
            areas[j].mapId === areas[i].mapId &&
            isDeepEqual(areas[i].areaInfo, areas[j].areaInfo)
          ) {
            throw new ValidationError(
              `Areas must have a unique AreaInfo field, but area ${areas[i].areaId} and area ${areas[j].areaId} are equal`
            );
          }
        }
      }
      if (areas.length > 0) {
        if (state.supportedMaps !== undefined && state.supportedMaps.length) {
          if (mapIds.has(null)) {
            throw new ValidationError(
              "Areas must not have a null mapId when supportedMaps is defined"
            );
          }
        } else if (!mapIds.has(null) || mapIds.size > 1) {
          throw new ValidationError(
            "Areas must have a null mapId when supportedMaps is empty"
          );
        }
      }
    },
    supportedMaps(state, maps) {
      const ids = new Set();
      const names = new Set();
      for (const { mapId, name } of maps) {
        if (ids.has(mapId)) {
          throw new ValidationError(`MapID ${mapId} is not unique`);
        }
        if (names.has(name)) {
          throw new ValidationError(`MapName "${name}" is not unique`);
        }
        ids.add(mapId);
        names.add(name);
      }
    },
    selectedAreas(state, areas) {
      for (const areaId of areas) {
        assertKnownArea(state, areaId);
      }
    },
    currentArea(state, areaId) {
      if (areaId !== null) assertKnownArea(state, areaId);
    },
    progress(state, progress) {
      for (const { areaId } of progress) assertKnownArea(state, areaId);
    },
  },
};

function assertKnownArea(state, areaId) {
  if (!(state.supportedAreas || []).some((area) => area.areaId === areaId)) {
    throw new ValidationError(
      `AreaID ${areaId} is not in the supported areas list`
    );
  }
}

function assertMode(state, newMode) {
  if (!(state.supportedModes || []).some(({ mode }) => mode === newMode)) {
    throw new ValidationError(
      `Can not use unsupported mode: ${newMode}. Allowed modes are ${(state.supportedModes || []).map(({ mode }) => mode).join(", ")}`
    );
  }
}

/**
 * @param {Record<string, Record<string, unknown>>} [initial] the endpoint as
 *   registered (Homebridge passes accessory.clusters as the defaults).
 */
function createMatterStore(initial = {}) {
  const clusters = {};
  for (const [name, attributes] of Object.entries(initial)) {
    clusters[name] = clone(attributes);
  }
  if (clusters.rvcOperationalState) {
    // matter.js default for the mandatory struct when nothing is supplied
    // (measured on the real 0.17.9 endpoint: { errorStateId: 0 }).
    clusters.rvcOperationalState.operationalError ??= {
      errorStateId: NO_ERROR,
    };
  }

  const events = [];
  const rejected = [];
  const writes = [];

  function applyTransaction(cluster, attributes) {
    const before = clone(clusters[cluster] || {});
    const working = clone(before);
    Object.assign(working, clone(attributes));

    const rules = PRE_COMMIT[cluster];
    if (rules) {
      const seen = clone(before);
      // Re-run until stable, as Datasource.preCommit does when a reactor
      // mutates (a mutation is a new change for the next cycle).
      for (let cycle = 0; cycle < 5; cycle += 1) {
        let mutated = false;
        for (const field of rules.order) {
          if (!rules[field] || isDeepEqual(seen[field], working[field])) {
            continue;
          }
          const oldValue = seen[field];
          seen[field] = clone(working[field]);
          rules[field](working, working[field], oldValue);
          mutated = true;
        }
        if (!mutated) break;
      }
    }

    clusters[cluster] = working;
    return before;
  }

  function postCommit(cluster, before) {
    if (cluster !== "rvcOperationalState") {
      return;
    }
    const state = clusters.rvcOperationalState;
    if (
      !isDeepEqual(before.phaseList, state.phaseList) &&
      (state.phaseList === null || state.phaseList.length === 0)
    ) {
      state.currentPhase = null;
    }
    if (!isDeepEqual(before.operationalError, state.operationalError)) {
      if (state.operationalError.errorStateId === NO_ERROR) {
        return;
      }
      if (state.operationalState !== ERROR) {
        // A second change in the same context; its $Changing reactor runs
        // too (3 is always in the list — initialize() asserts it).
        const old = state.operationalState;
        state.operationalState = ERROR;
        PRE_COMMIT.rvcOperationalState.operationalState(state, ERROR, old);
      }
      events.push(clone(state.operationalError));
    }
  }

  async function updateAccessoryState(_uuid, cluster, attributes) {
    writes.push({ cluster, attributes: clone(attributes) });
    const snapshot = clone(clusters[cluster]);
    try {
      const before = applyTransaction(cluster, attributes);
      postCommit(cluster, before);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      clusters[cluster] = snapshot;
      rejected.push({
        cluster,
        attributes: clone(attributes),
        error: error.message,
      });
    }
    // Resolves either way: Homebridge 2.4.0 never hands the failure back.
  }

  return {
    clusters,
    events,
    rejected,
    writes,
    updateAccessoryState,
    /** What a subscribed controller would read right now. */
    read(cluster, attribute) {
      return clusters[cluster]?.[attribute];
    },
  };
}

module.exports = { createMatterStore };
