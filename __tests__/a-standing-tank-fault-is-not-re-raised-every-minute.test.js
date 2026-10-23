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
 * table in writeOperationalStateCluster(). Each publish reads the store back
 * first, as the plugin does through `api.matter.getAccessoryState`.
 */

const fs = require("fs");
const path = require("path");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "matter_vacuum_accessory.ts"),
  "utf8"
);

const { createMatterStore } = require("../test-support/matter-0.17.9-store");

const ERROR = 3;
const CHARGING = 0x41;
const DOCKED = 0x42;
const TANK_EMPTY = 68;

/**
 * The real 0.17.9 store (test-support/matter-0.17.9-store.js), seen through
 * the few numbers these tests read. Until 3.35.0 this file carried its own
 * stand-in that knew only "a state write clears the error" — the half of the
 * behaviour that was measured — and not the half that explains it: a fault
 * FORCES the state to Error. That stand-in let a test assert "Charging with
 * fault 68", a store 0.17.9 can never hold (issue #35).
 */
function makeStore() {
  const real = createMatterStore({
    rvcOperationalState: {
      phaseList: null,
      currentPhase: null,
      operationalStateList: [0, 1, 2, 3, 64, 65, 66].map(
        (operationalStateId) => ({ operationalStateId })
      ),
      operationalState: DOCKED,
      operationalError: { errorStateId: 0 },
    },
  });
  const store = {
    get operationalState() {
      return real.read("rvcOperationalState", "operationalState");
    },
    get operationalError() {
      return real.read("rvcOperationalState", "operationalError").errorStateId;
    },
    get writes() {
      return real.writes;
    },
    get errorEvents() {
      return real.events.length;
    },
  };
  return { store, matter: real };
}

/** The accessory's writer, with only what it touches. */
function makeAccessory() {
  const {
    default: RoborockMatterVacuumAccessory,
  } = require("../src/matter_vacuum_accessory");
  const accessory = Object.create(RoborockMatterVacuumAccessory.prototype);
  accessory.accessory = { UUID: "uuid-1" };
  return accessory;
}

/** One publish of the cluster, against the store as it reads back. */
async function write(accessory, matter, attributes) {
  const stored = await matter.getAccessoryState(
    "uuid-1",
    "rvcOperationalState"
  );
  await accessory.writeOperationalStateCluster(matter, attributes, stored);
}

async function publish(accessory, matter, operationalState, errorStateId) {
  await write(accessory, matter, {
    operationalStateList: [0, 1, 2, 3, 64, 65, 66].map(
      (operationalStateId) => ({ operationalStateId })
    ),
    operationalState,
    operationalError: { errorStateId },
  });
}

describe("a standing tank fault is not re-raised every minute", () => {
  test("an hour of heartbeats with the tank empty raises it once", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    await publish(accessory, matter, DOCKED, TANK_EMPTY);
    expect(store.operationalError).toBe(TANK_EMPTY);
    expect(store.errorEvents).toBe(1);

    // 60 heartbeats: one an hour at the heartbeat interval.
    for (let i = 0; i < 60; i += 1) {
      await publish(accessory, matter, DOCKED, TANK_EMPTY);
    }

    expect(store.errorEvents).toBe(1);
    expect(store.operationalError).toBe(TANK_EMPTY);
    expect(store.operationalState).toBe(ERROR);
  });

  test("the unchanged state is not written at all, which is the whole fix", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    await publish(accessory, matter, DOCKED, TANK_EMPTY);
    const after = store.writes.length;

    for (let i = 0; i < 5; i += 1) {
      await publish(accessory, matter, DOCKED, TANK_EMPTY);
    }

    const extra = store.writes.slice(after);
    expect(extra.some((write) => "operationalState" in write.attributes)).toBe(
      false
    );
  });

  test("a fault is raised in a write of its own, never beside a state", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    // From Charging: the state differs from the store, and is still not
    // written — matter.js puts the store at Error the moment the fault lands.
    await publish(accessory, matter, CHARGING, TANK_EMPTY);

    for (const written of store.writes) {
      const both =
        "operationalState" in written.attributes &&
        "operationalError" in written.attributes;
      expect(both).toBe(false);
    }
    expect(
      store.writes.some((written) => "operationalState" in written.attributes)
    ).toBe(false);
    expect(store.operationalState).toBe(ERROR);
    expect(store.errorEvents).toBe(1);
  });

  test("a state change underneath a standing fault does not re-raise it", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    await publish(accessory, matter, DOCKED, TANK_EMPTY);
    // Docked -> Charging while the tank is still empty. 3.30.0 wrote the new
    // state, which wiped the fault (the store was in Error), and re-raised it:
    // one notification per dock transition. The store reads Error either
    // way, so the state is held back until the fault goes.
    await publish(accessory, matter, CHARGING, TANK_EMPTY);

    expect(store.operationalError).toBe(TANK_EMPTY);
    expect(store.operationalState).toBe(ERROR);
    expect(store.errorEvents).toBe(1);

    for (let i = 0; i < 10; i += 1) {
      await publish(accessory, matter, CHARGING, TANK_EMPTY);
    }
    expect(store.errorEvents).toBe(1);

    // And the moment it clears, the state the robot is in NOW comes back.
    await publish(accessory, matter, CHARGING, 0);
    expect(store.operationalState).toBe(CHARGING);
    expect(store.operationalError).toBe(0);
  });

  test("filling the tank clears it, and emptying it raises it again", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    await publish(accessory, matter, DOCKED, TANK_EMPTY);
    expect(store.errorEvents).toBe(1);

    await publish(accessory, matter, DOCKED, 0);
    expect(store.operationalError).toBe(0);
    for (let i = 0; i < 5; i += 1) {
      await publish(accessory, matter, DOCKED, 0);
    }
    expect(store.errorEvents).toBe(1);

    await publish(accessory, matter, DOCKED, TANK_EMPTY);
    expect(store.errorEvents).toBe(2);
    expect(store.operationalError).toBe(TANK_EMPTY);
  });

  test("the rest of the cluster is still written every time", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    // The phase and the state list must keep flowing: they do not touch the
    // error, and suppressing them would be a different bug.
    await write(accessory, matter, {
      operationalState: DOCKED,
      operationalError: { errorStateId: TANK_EMPTY },
      phaseList: ["Cleaning"],
      currentPhase: 0,
    });
    await write(accessory, matter, {
      operationalState: DOCKED,
      operationalError: { errorStateId: TANK_EMPTY },
      phaseList: ["Cleaning", "Drying"],
      currentPhase: 1,
    });

    const phaseWrites = store.writes.filter(
      (written) => "currentPhase" in written.attributes
    );
    expect(phaseWrites.at(-1).attributes.currentPhase).toBe(1);
    expect(phaseWrites.at(-1).attributes.phaseList).toEqual([
      "Cleaning",
      "Drying",
    ]);
    expect(store.errorEvents).toBe(1);
  });

  test("a cluster with no fault at all writes no error", async () => {
    const { store, matter } = makeStore();
    const accessory = makeAccessory();

    await write(accessory, matter, {
      operationalState: DOCKED,
      currentPhase: null,
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
