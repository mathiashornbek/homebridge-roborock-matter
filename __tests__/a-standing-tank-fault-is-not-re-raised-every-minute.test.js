"use strict";

/**
 * WHY THIS FILE EXISTS, AND WHY THE OLD ANSWER WAS WRONG.
 *
 * Three people reported the same thing on three different robots: the Home
 * app repeats "fill the water tank — <robot> will start cleaning when the
 * tank is filled" every two minutes while the tank is empty. #5 (Wazza151,
 * a70), #9 (vp-debug12, a75, with the screenshot and the wording), #26
 * (n0rt0nthec4t, Q Revo S).
 *
 * For three releases the answer in this codebase was that Apple re-raises a
 * standing block and nothing on this side can stop it, and the comment on
 * isWaterTankEmpty() said, in as many words, that no timer in this plugin can
 * produce a 68 -> 0 -> 68 cycle. That was measured — against
 * @matter/main 0.18.0-alpha. Homebridge 2.4.0 ships 0.17.9, and 0.17.9
 * CLEARS `operationalError` on every single write of `operationalState`,
 * including a write of the value already stored.
 *
 * So the plugin's own 60-second heartbeat was producing the cycle, and
 * matter.js emits the cluster's OperationalError event on the 0 -> 68 edge:
 * one notification per two heartbeats. Two minutes. Exactly what they saw.
 *
 * These tests pin the ordering rule that fixes it. They are written against
 * the write calls the plugin makes, because that is the thing this codebase
 * controls; the matter.js behaviour itself is recorded in the measurement
 * table in writeOperationalStateCluster().
 */

const fs = require("fs");
const path = require("path");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "matter_vacuum_accessory.ts"),
  "utf8"
);

/**
 * A stand-in for matter.js 0.17.9's measured behaviour: a write carrying
 * `operationalState` clears `operationalError`, whatever it was, and an
 * OperationalError event fires on every 0 -> non-zero edge.
 */
function makeStore() {
  const store = {
    operationalState: undefined,
    operationalError: 0,
    writes: [],
    errorEvents: 0,
    errorChanges: 0,
  };

  const updateAccessoryState = jest.fn(async (_uuid, cluster, attributes) => {
    store.writes.push({ cluster, attributes });
    if (cluster !== "rvcOperationalState") {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(attributes, "operationalState")) {
      store.operationalState = attributes.operationalState;
      if (store.operationalError !== 0) {
        store.operationalError = 0;
        store.errorChanges += 1;
      }
    }

    if (Object.prototype.hasOwnProperty.call(attributes, "operationalError")) {
      const next = attributes.operationalError?.errorStateId ?? 0;
      if (next !== store.operationalError) {
        if (store.operationalError === 0 && next !== 0) {
          store.errorEvents += 1;
        }
        store.operationalError = next;
        store.errorChanges += 1;
      }
    }
  });

  return { store, matter: { updateAccessoryState } };
}

/** The accessory's writer, with only what it touches. */
function makeAccessory() {
  const {
    default: RoborockMatterVacuumAccessory,
  } = require("../src/matter_vacuum_accessory");
  const accessory = Object.create(RoborockMatterVacuumAccessory.prototype);
  accessory.accessory = { UUID: "uuid-1" };
  accessory.publishedOperationalState = undefined;
  accessory.publishedOperationalError = undefined;
  return accessory;
}

const CLEANING = 0x42;
const PAUSED = 0x41;
const TANK_EMPTY = 68;

async function publish(accessory, matter, operationalState, errorStateId) {
  await accessory.writeOperationalStateCluster(matter, {
    operationalStateList: [{ operationalStateId: 0 }],
    operationalState,
    operationalError: { errorStateId },
  });
}

describe("a standing tank fault is not re-raised every minute", () => {
  test("an hour of heartbeats with the tank empty raises it once", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    await publish(accessory, matter, CLEANING, TANK_EMPTY);
    expect(store.operationalError).toBe(TANK_EMPTY);
    expect(store.errorEvents).toBe(1);

    // 60 heartbeats: one an hour at the heartbeat interval.
    for (let i = 0; i < 60; i += 1) {
      await publish(accessory, matter, CLEANING, TANK_EMPTY);
    }

    expect(store.errorEvents).toBe(1);
    expect(store.errorChanges).toBe(1);
    expect(store.operationalError).toBe(TANK_EMPTY);
  });

  test("the unchanged state is not written at all, which is the whole fix", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    await publish(accessory, matter, CLEANING, TANK_EMPTY);
    const after = store.writes.length;

    for (let i = 0; i < 5; i += 1) {
      await publish(accessory, matter, CLEANING, TANK_EMPTY);
    }

    const extra = store.writes.slice(after);
    expect(extra.some((write) => "operationalState" in write.attributes)).toBe(
      false
    );
  });

  test("the error is written after the state, never with it", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    await publish(accessory, matter, CLEANING, TANK_EMPTY);

    for (const write of store.writes) {
      const both =
        "operationalState" in write.attributes &&
        "operationalError" in write.attributes;
      expect(both).toBe(false);
    }

    const stateAt = store.writes.findIndex(
      (write) => "operationalState" in write.attributes
    );
    const errorAt = store.writes.findIndex(
      (write) => "operationalError" in write.attributes
    );
    expect(stateAt).toBeGreaterThanOrEqual(0);
    expect(errorAt).toBeGreaterThan(stateAt);
  });

  test("a genuine state change keeps the fault standing", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    await publish(accessory, matter, CLEANING, TANK_EMPTY);
    await publish(accessory, matter, PAUSED, TANK_EMPTY);

    // The store really was cleared by the state write, so re-asserting it is
    // not optional — and the robot did change state, so one notification is
    // honest.
    expect(store.operationalError).toBe(TANK_EMPTY);
    expect(store.operationalState).toBe(PAUSED);

    const events = store.errorEvents;
    for (let i = 0; i < 10; i += 1) {
      await publish(accessory, matter, PAUSED, TANK_EMPTY);
    }
    expect(store.errorEvents).toBe(events);
  });

  test("filling the tank clears it, and emptying it raises it again", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    await publish(accessory, matter, CLEANING, TANK_EMPTY);
    expect(store.errorEvents).toBe(1);

    await publish(accessory, matter, CLEANING, 0);
    expect(store.operationalError).toBe(0);
    for (let i = 0; i < 5; i += 1) {
      await publish(accessory, matter, CLEANING, 0);
    }
    expect(store.errorEvents).toBe(1);

    await publish(accessory, matter, CLEANING, TANK_EMPTY);
    expect(store.errorEvents).toBe(2);
    expect(store.operationalError).toBe(TANK_EMPTY);
  });

  test("the rest of the cluster is still written every time", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    // The phase and the state list must keep flowing: they do not touch the
    // error, and suppressing them would be a different bug.
    await accessory.writeOperationalStateCluster(matter, {
      operationalState: CLEANING,
      operationalError: { errorStateId: TANK_EMPTY },
      currentPhase: 0,
      phaseList: ["Cleaning"],
    });
    await accessory.writeOperationalStateCluster(matter, {
      operationalState: CLEANING,
      operationalError: { errorStateId: TANK_EMPTY },
      currentPhase: 1,
      phaseList: ["Cleaning", "Drying"],
    });

    const last = store.writes[store.writes.length - 1];
    expect(last.attributes.currentPhase).toBe(1);
    expect(last.attributes.phaseList).toEqual(["Cleaning", "Drying"]);
    expect(store.errorEvents).toBe(1);
  });

  test("a cluster with no fault at all writes no error", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    await accessory.writeOperationalStateCluster(matter, {
      operationalState: CLEANING,
      currentPhase: 0,
    });

    expect(
      store.writes.some((write) => "operationalError" in write.attributes)
    ).toBe(false);
    expect(store.errorEvents).toBe(0);
  });
});

describe("the claim that was wrong is not left in the source", () => {
  test("nothing still says no timer here can produce the cycle", () => {
    expect(SOURCE).not.toMatch(
      /No timer in this plugin can produce a 68 → 0 → 68 cycle/
    );
  });

  test("the measurement that replaced it names the version people run", () => {
    expect(SOURCE).toMatch(/0\.17\.9/);
    expect(SOURCE).toMatch(/writeOperationalStateCluster/);
  });
});
