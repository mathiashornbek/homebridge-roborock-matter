"use strict";

/**
 * 3.30.0 stopped the heartbeat re-writing an unchanged `operationalState`,
 * because in @matter/main 0.17.9 such a write wiped a standing
 * `operationalError` and the clear/raise pair became a push notification
 * every 2 minutes.
 *
 * That was right, and it left a hole. The whole publish-dedup design rests on
 * the heartbeat being a forced full write that self-heals any divergence
 * within a minute — and a cluster write can be REJECTED BY matter.js after
 * `updateAccessoryState` has already resolved (`#assertCurrentPhase` throws,
 * Homebridge swallows it). 3.31.0 therefore re-asserted `operationalState` on
 * one forced write in ten.
 *
 * 3.35.0 corrected the model under both halves (issue #35). In 0.17.9 a fault
 * FORCES `operationalState` to Error; the wipe 3.30.0 measured was a write out
 * of that Error. So:
 *
 *   - with no fault standing, the resync re-writes the state, which heals a
 *     dropped write and costs nothing (the same value is a no-op);
 *   - with a fault standing, the resync must NOT write the state — the store
 *     reads Error anyway, and the write would wipe the fault and re-raise it,
 *     one notification per resync. It re-asserts the fault instead, which is
 *     a no-op when it landed and a repair when it did not.
 *
 * Every test runs against test-support/matter-0.17.9-store.js, a replay of the
 * real 0.17.9 reactors, not against what the plugin believes.
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
  accessory.publishedOperationalState = undefined;
  accessory.publishedOperationalError = undefined;
  accessory.forcedWritesSinceOperationalState = 0;
  return accessory;
}

const payload = (state, errorStateId) => ({
  operationalStateList: STATE_LIST,
  operationalState: state,
  operationalError: { errorStateId },
});

const read = (store, attribute) => store.read("rvcOperationalState", attribute);

describe("the heartbeat heals a write matter.js threw away", () => {
  test("an ordinary publish never re-writes an unchanged state", async () => {
    const { stateWrites, matter } = makeStore();
    const accessory = makeAccessory();

    await accessory.writeOperationalStateCluster(
      matter,
      payload(DOCKED, NO_ERROR)
    );
    const after = stateWrites();

    for (let i = 0; i < 30; i += 1) {
      await accessory.writeOperationalStateCluster(
        matter,
        payload(DOCKED, NO_ERROR)
      );
    }
    expect(stateWrites()).toBe(after);
  });

  test("with no fault standing, a forced heartbeat re-asserts the state once every ten cycles", async () => {
    const { stateWrites, matter } = makeStore();
    const accessory = makeAccessory();

    await accessory.writeOperationalStateCluster(
      matter,
      payload(DOCKED, NO_ERROR),
      { force: true }
    );
    const baseline = stateWrites();

    // 60 heartbeats is an hour at the 60-second interval.
    for (let i = 0; i < 60; i += 1) {
      await accessory.writeOperationalStateCluster(
        matter,
        payload(DOCKED, NO_ERROR),
        { force: true }
      );
    }

    expect(stateWrites() - baseline).toBe(6);
  });

  test("with a fault standing, an hour of heartbeats raises it once and never writes the state", async () => {
    const { store, stateWrites, matter } = makeStore();
    const accessory = makeAccessory();

    await accessory.writeOperationalStateCluster(
      matter,
      payload(DOCKED, TANK_EMPTY),
      { force: true }
    );
    const baseline = stateWrites();

    for (let i = 0; i < 60; i += 1) {
      await accessory.writeOperationalStateCluster(
        matter,
        payload(DOCKED, TANK_EMPTY),
        { force: true }
      );
    }

    // 3.31.0's resync gave 7 here: one per re-assertion of the state.
    expect(store.events).toEqual([{ errorStateId: TANK_EMPTY }]);
    expect(stateWrites()).toBe(baseline);
    expect(read(store, "operationalError")).toEqual({
      errorStateId: TANK_EMPTY,
    });
    expect(read(store, "operationalState")).toBe(ERROR);
  });

  test("a stale state belief is corrected within ten heartbeats", async () => {
    const { store, matter } = makeStore(CHARGING);
    const accessory = makeAccessory();

    // The plugin believes it published Docked; the store never got it,
    // exactly as a silently-rejected write leaves things.
    accessory.publishedOperationalState = DOCKED;
    accessory.publishedOperationalError = NO_ERROR;

    for (let i = 0; i < 10; i += 1) {
      await accessory.writeOperationalStateCluster(
        matter,
        payload(DOCKED, NO_ERROR),
        { force: true }
      );
    }

    expect(read(store, "operationalState")).toBe(DOCKED);
  });

  test("a stale fault belief is corrected within ten heartbeats, with one event", async () => {
    const { store, matter } = makeStore(DOCKED);
    const accessory = makeAccessory();

    // The plugin believes the fault landed; the store never got it.
    accessory.publishedOperationalState = DOCKED;
    accessory.publishedOperationalError = TANK_EMPTY;

    for (let i = 0; i < 10; i += 1) {
      await accessory.writeOperationalStateCluster(
        matter,
        payload(DOCKED, TANK_EMPTY),
        { force: true }
      );
    }

    expect(read(store, "operationalError")).toEqual({
      errorStateId: TANK_EMPTY,
    });
    expect(store.events).toHaveLength(1);
  });

  test("a real state change is still immediate, not delayed by the counter", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    for (let i = 0; i < 6; i += 1) {
      await accessory.writeOperationalStateCluster(
        matter,
        payload(DOCKED, NO_ERROR),
        { force: true }
      );
    }

    await accessory.writeOperationalStateCluster(
      matter,
      payload(CHARGING, NO_ERROR)
    );
    expect(read(store, "operationalState")).toBe(CHARGING);
  });

  test("the counter resets on a real change, so the clock starts again", async () => {
    const { stateWrites, matter } = makeStore();
    const accessory = makeAccessory();

    for (let i = 0; i < 9; i += 1) {
      await accessory.writeOperationalStateCluster(
        matter,
        payload(DOCKED, NO_ERROR),
        { force: true }
      );
    }
    await accessory.writeOperationalStateCluster(
      matter,
      payload(CHARGING, NO_ERROR)
    );
    expect(accessory.forcedWritesSinceOperationalState).toBe(0);

    const before = stateWrites();
    for (let i = 0; i < 5; i += 1) {
      await accessory.writeOperationalStateCluster(
        matter,
        payload(CHARGING, NO_ERROR),
        { force: true }
      );
    }
    expect(stateWrites()).toBe(before);
  });

  test("when the fault clears, the state the robot is really in comes straight back", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    await accessory.writeOperationalStateCluster(
      matter,
      payload(DOCKED, TANK_EMPTY)
    );
    expect(read(store, "operationalState")).toBe(ERROR);

    await accessory.writeOperationalStateCluster(
      matter,
      payload(DOCKED, NO_ERROR)
    );
    expect(read(store, "operationalState")).toBe(DOCKED);
    expect(read(store, "operationalError")).toEqual({
      errorStateId: NO_ERROR,
    });
  });
});
