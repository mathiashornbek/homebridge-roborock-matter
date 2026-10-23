"use strict";

/**
 * A write matter.js refuses is only logged by Homebridge 2.4.0: its
 * `updateAccessoryState` emits and returns, and the store write runs later in
 * a setImmediate (MatterAPIImpl.js, StateManager.js). Until this change the
 * plugin recorded every write as published the moment the call returned, so
 * a refused write was believed — and the only repair was a forced heartbeat
 * that, for `operationalState`, could only run once every ten minutes,
 * because writing that attribute while a fault stands wipes the fault and the
 * next raise is a fresh "refill the water tank" notification (#5, #9, #26).
 *
 * The cluster is now written against the store as Homebridge reads it back
 * (`api.matter.getAccessoryState`), so:
 *
 *   - an unchanged state is never written, heartbeat or not;
 *   - a state the store does not hold is written on the very next publish;
 *   - with a fault standing, the state is never written and the fault is
 *     raised exactly once, however many publishes go by.
 *
 * Every test runs against test-support/matter-0.17.9-store.js, a replay of the
 * real 0.17.9 reactors.
 */

const { createMatterStore } = require("../test-support/matter-0.17.9-store");

const ERROR = 3;
const CHARGING = 65;
const DOCKED = 66;
const NO_ERROR = 0;
const TANK_EMPTY = 68;

const STATE_LIST = [0, 1, 2, 3, 64, 65, 66].map((operationalStateId) => ({
  operationalStateId,
}));

function makeStore(initialState = DOCKED) {
  const store = createMatterStore({
    rvcOperationalState: {
      phaseList: null,
      currentPhase: null,
      operationalStateList: STATE_LIST,
      operationalState: initialState,
      operationalError: { errorStateId: NO_ERROR },
    },
  });
  const stateWrites = () =>
    store.writes.filter((w) =>
      Object.prototype.hasOwnProperty.call(w.attributes, "operationalState")
    ).length;
  return { store, stateWrites, matter: store };
}

function makeAccessory() {
  const {
    default: RoborockMatterVacuumAccessory,
  } = require("../src/matter_vacuum_accessory");
  const accessory = Object.create(RoborockMatterVacuumAccessory.prototype);
  accessory.accessory = { UUID: "uuid-1" };
  return accessory;
}

/** One publish of the cluster, read back from the store first. */
async function publish(accessory, matter, attributes) {
  const stored = await matter.getAccessoryState(
    "uuid-1",
    "rvcOperationalState"
  );
  await accessory.writeOperationalStateCluster(matter, attributes, stored);
}

const payload = (state, errorStateId) => ({
  operationalStateList: STATE_LIST,
  operationalState: state,
  operationalError: { errorStateId },
});

const read = (store, attribute) => store.read("rvcOperationalState", attribute);

describe("a write matter.js threw away comes back on the next publish", () => {
  test("an unchanged state is never written again", async () => {
    const { stateWrites, matter } = makeStore();
    const accessory = makeAccessory();

    for (let i = 0; i < 30; i += 1) {
      await publish(accessory, matter, payload(DOCKED, NO_ERROR));
    }
    expect(stateWrites()).toBe(0);
  });

  test("a state the store refused is written again by the very next publish", async () => {
    const { store } = makeStore(CHARGING);
    const accessory = makeAccessory();
    let refuse = true;
    const matter = {
      // Refused: Homebridge resolves and only logs it.
      updateAccessoryState: async (uuid, cluster, attributes) => {
        if (refuse && "operationalState" in attributes) {
          refuse = false;
          return;
        }
        await store.updateAccessoryState(uuid, cluster, attributes);
      },
      getAccessoryState: (uuid, cluster) =>
        store.getAccessoryState(uuid, cluster),
    };

    await publish(accessory, matter, payload(DOCKED, NO_ERROR));
    expect(read(store, "operationalState")).toBe(CHARGING);

    await publish(accessory, matter, payload(DOCKED, NO_ERROR));
    expect(read(store, "operationalState")).toBe(DOCKED);
  });

  test("with a fault standing, an hour of publishes raises it once and never writes the state", async () => {
    const { store, stateWrites, matter } = makeStore();
    const accessory = makeAccessory();

    for (let i = 0; i < 61; i += 1) {
      await publish(accessory, matter, payload(DOCKED, TANK_EMPTY));
    }

    expect(store.events).toEqual([{ errorStateId: TANK_EMPTY }]);
    expect(stateWrites()).toBe(0);
    expect(read(store, "operationalError")).toEqual({
      errorStateId: TANK_EMPTY,
    });
    expect(read(store, "operationalState")).toBe(ERROR);
  });

  test("a fault the store refused is raised by the next publish, with one event", async () => {
    const { store } = makeStore(DOCKED);
    const accessory = makeAccessory();
    let refuse = true;
    const matter = {
      updateAccessoryState: async (uuid, cluster, attributes) => {
        if (refuse && "operationalError" in attributes) {
          refuse = false;
          return;
        }
        await store.updateAccessoryState(uuid, cluster, attributes);
      },
      getAccessoryState: (uuid, cluster) =>
        store.getAccessoryState(uuid, cluster),
    };

    await publish(accessory, matter, payload(DOCKED, TANK_EMPTY));
    expect(store.events).toHaveLength(0);

    await publish(accessory, matter, payload(DOCKED, TANK_EMPTY));
    await publish(accessory, matter, payload(DOCKED, TANK_EMPTY));
    expect(read(store, "operationalError")).toEqual({
      errorStateId: TANK_EMPTY,
    });
    expect(store.events).toHaveLength(1);
  });

  test("a real state change is written at once", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    for (let i = 0; i < 6; i += 1) {
      await publish(accessory, matter, payload(DOCKED, NO_ERROR));
    }

    await publish(accessory, matter, payload(CHARGING, NO_ERROR));
    expect(read(store, "operationalState")).toBe(CHARGING);
  });

  test("a snapshot that knows nothing about the fault leaves a standing one alone", async () => {
    const { store, stateWrites, matter } = makeStore();
    const accessory = makeAccessory();
    await publish(accessory, matter, payload(DOCKED, TANK_EMPTY));

    const { operationalError: _unknown, ...noFaultSaid } = payload(
      CHARGING,
      NO_ERROR
    );
    await publish(accessory, matter, noFaultSaid);

    expect(stateWrites()).toBe(0);
    expect(store.events).toHaveLength(1);
    expect(read(store, "operationalError")).toEqual({
      errorStateId: TANK_EMPTY,
    });
  });

  test("when the fault clears, the state the robot is really in comes straight back", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    await publish(accessory, matter, payload(DOCKED, TANK_EMPTY));
    expect(read(store, "operationalState")).toBe(ERROR);

    await publish(accessory, matter, payload(DOCKED, NO_ERROR));
    expect(read(store, "operationalState")).toBe(DOCKED);
    expect(read(store, "operationalError")).toEqual({
      errorStateId: NO_ERROR,
    });
  });
});
