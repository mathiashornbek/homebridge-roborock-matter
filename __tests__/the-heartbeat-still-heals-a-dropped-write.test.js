"use strict";

/**
 * 3.30.0 stopped the heartbeat re-writing an unchanged `operationalState`,
 * because in @matter/main 0.17.9 every such write clears `operationalError`
 * and the clear/raise pair became a push notification every 2 minutes.
 *
 * That was right, and it left a hole. The whole publish-dedup design rests on
 * the heartbeat being a forced full write that self-heals any divergence
 * within a minute — and a cluster write can be REJECTED BY matter.js after
 * `updateAccessoryState` has already resolved. This codebase documents that
 * in buildOperationalStateCluster: `#assertCurrentPhase` throws, Homebridge
 * swallows the throw, "so the whole cluster write is silently rejected and
 * the controller keeps whatever it last accepted".
 *
 * So from 3.30.0 a single silently-rejected write made the plugin believe a
 * value was published that never was, and nothing ever wrote that attribute
 * again — a permanently stale tile, recoverable only by the robot reaching a
 * different state or a Homebridge restart. Before 3.30.0 the heartbeat fixed
 * it inside a minute.
 *
 * 3.31.0 re-asserts `operationalState` on one forced write in ten. These
 * tests pin both halves: the notification stays gone, and the tile heals.
 */

const CLEANING = 0x42;
const TANK_EMPTY = 68;

/** matter.js 0.17.9, as measured: a state write clears the error. */
function makeStore() {
  const store = {
    operationalState: undefined,
    operationalError: 0,
    errorEvents: 0,
    stateWrites: 0,
  };
  const updateAccessoryState = jest.fn(async (_uuid, cluster, attributes) => {
    if (cluster !== "rvcOperationalState") return;
    if (Object.prototype.hasOwnProperty.call(attributes, "operationalState")) {
      store.stateWrites += 1;
      store.operationalState = attributes.operationalState;
      store.operationalError = 0;
    }
    if (Object.prototype.hasOwnProperty.call(attributes, "operationalError")) {
      const next = attributes.operationalError?.errorStateId ?? 0;
      if (store.operationalError === 0 && next !== 0) store.errorEvents += 1;
      store.operationalError = next;
    }
  });
  return { store, matter: { updateAccessoryState } };
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
  operationalStateList: [{ operationalStateId: 0 }],
  operationalState: state,
  operationalError: { errorStateId },
});

describe("the heartbeat heals a write matter.js threw away", () => {
  test("an ordinary publish still never re-writes an unchanged state", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    await accessory.writeOperationalStateCluster(
      matter,
      payload(CLEANING, TANK_EMPTY)
    );
    const after = store.stateWrites;

    for (let i = 0; i < 30; i += 1) {
      await accessory.writeOperationalStateCluster(
        matter,
        payload(CLEANING, TANK_EMPTY)
      );
    }
    expect(store.stateWrites).toBe(after);
    expect(store.errorEvents).toBe(1);
  });

  test("a forced heartbeat re-asserts it once every ten cycles, not every one", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    await accessory.writeOperationalStateCluster(
      matter,
      payload(CLEANING, TANK_EMPTY),
      { force: true }
    );
    const baseline = store.stateWrites;

    // 60 heartbeats is an hour at the 60-second interval.
    for (let i = 0; i < 60; i += 1) {
      await accessory.writeOperationalStateCluster(
        matter,
        payload(CLEANING, TANK_EMPTY),
        { force: true }
      );
    }

    const extra = store.stateWrites - baseline;
    expect(extra).toBe(6);
    // The whole point: six re-assertions an hour, not sixty.
    expect(extra).toBeLessThan(10);
  });

  test("an hour of heartbeats produces at most a handful of notifications", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    for (let i = 0; i < 60; i += 1) {
      await accessory.writeOperationalStateCluster(
        matter,
        payload(CLEANING, TANK_EMPTY),
        { force: true }
      );
    }

    // Before 3.30.0 this was 30 (one per two heartbeats). The re-assertion
    // costs a few; the 2-minute repeat users reported is gone.
    expect(store.errorEvents).toBeLessThanOrEqual(7);
    expect(store.operationalError).toBe(TANK_EMPTY);
  });

  test("a stale belief is corrected within ten heartbeats", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    // The plugin believes it published Cleaning; the store never got it,
    // exactly as a silently-rejected write leaves things.
    accessory.publishedOperationalState = CLEANING;
    store.operationalState = 0;

    for (let i = 0; i < 10; i += 1) {
      await accessory.writeOperationalStateCluster(
        matter,
        payload(CLEANING, TANK_EMPTY),
        { force: true }
      );
    }

    expect(store.operationalState).toBe(CLEANING);
  });

  test("a real state change is still immediate, not delayed by the counter", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    await accessory.writeOperationalStateCluster(
      matter,
      payload(CLEANING, TANK_EMPTY),
      { force: true }
    );
    for (let i = 0; i < 5; i += 1) {
      await accessory.writeOperationalStateCluster(
        matter,
        payload(CLEANING, TANK_EMPTY),
        { force: true }
      );
    }

    await accessory.writeOperationalStateCluster(
      matter,
      payload(0x41, TANK_EMPTY)
    );
    expect(store.operationalState).toBe(0x41);
    expect(store.operationalError).toBe(TANK_EMPTY);
  });

  test("the counter resets on a real change, so the clock starts again", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    for (let i = 0; i < 9; i += 1) {
      await accessory.writeOperationalStateCluster(
        matter,
        payload(CLEANING, TANK_EMPTY),
        { force: true }
      );
    }
    await accessory.writeOperationalStateCluster(
      matter,
      payload(0x41, TANK_EMPTY)
    );
    expect(accessory.forcedWritesSinceOperationalState).toBe(0);

    const before = store.stateWrites;
    for (let i = 0; i < 5; i += 1) {
      await accessory.writeOperationalStateCluster(
        matter,
        payload(0x41, TANK_EMPTY),
        { force: true }
      );
    }
    expect(store.stateWrites).toBe(before);
  });
});
