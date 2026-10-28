"use strict";

const {
  createRealApiVacuum,
  disposeRealApiVacuums,
} = require("../test-support/real-api-matter-vacuum");

afterEach(disposeRealApiVacuums);

// Relevant fields from Uptown Rock's 2026-10-26 00:25:23Z LAN reply.
// The owner had filled the dock reservoir; the OEM app showed no water fault.
const UPTOWN = {
  state: 8,
  battery: 100,
  charge_status: 1,
  error_code: 0,
  in_cleaning: 0,
  in_returning: 0,
  water_box_status: 1,
  water_box_carriage_status: 1,
  water_box_mode: 204,
  fan_power: 106,
  mop_mode: 302,
  dock_type: 3,
  dock_error_status: 0,
  water_shortage_status: 1,
};

const fault = (robot) =>
  robot.store.read("rvcOperationalState", "operationalError").errorStateId;
const state = (robot) =>
  robot.store.read("rvcOperationalState", "operationalState");

async function uptown(frame = UPTOWN) {
  const robot = await createRealApiVacuum({ model: "roborock.vacuum.a27" });
  await robot.localReply(frame);
  return robot;
}

async function select(robot, mode) {
  await robot.accessory.handlers.rvcCleanMode.changeToMode({ newMode: mode });
  await robot.settle();
}

describe("an automatic refill dock provides a second water supply", () => {
  test("Uptown's reported shortage does not create a blocking fault at rest", async () => {
    const robot = await uptown();

    expect(fault(robot)).toBe(0);
    expect(state(robot)).toBe(66);
    expect(robot.store.events).toEqual([]);
    // The raw sensor is still useful for maintenance/automations.
    expect(robot.vacuum.getHomeKitStateSensorValue("waterTankEmpty")).toBe(
      true
    );
  });

  test.each([
    ["Mop", 1],
    ["Vacuum + Mop", 2],
  ])(
    "%s is blocked only when both supplies report empty",
    async (_name, mode) => {
      const robot = await uptown();
      await select(robot, mode);

      for (const [dockError, shortage, expected] of [
        [0, 0, 0],
        [0, 1, 0],
        [38, 0, 0],
        [38, 1, 68],
      ]) {
        await robot.localReply({
          ...UPTOWN,
          dock_error_status: dockError,
          water_shortage_status: shortage,
        });
        expect(fault(robot)).toBe(expected);
        expect(state(robot)).toBe(expected === 68 ? 3 : 66);
      }
      expect(robot.store.rejected).toEqual([]);
    }
  );

  test.each([
    ["dock reservoir", { dock_error_status: 0 }],
    ["onboard tank", { water_shortage_status: 0 }],
  ])(
    "refilling either the %s clears a standing warning immediately",
    async (_name, refill) => {
      const empty = { ...UPTOWN, dock_error_status: 38 };
      const robot = await uptown(empty);
      expect(fault(robot)).toBe(68);
      expect(state(robot)).toBe(3);

      await robot.localReply({ ...empty, ...refill });

      expect(fault(robot)).toBe(0);
      expect(state(robot)).toBe(66);
      expect(robot.store.events).toHaveLength(1);
    }
  );

  test.each([2, 3, 6, 7, 8, 9, 15, 16, 20, 45])(
    "dock type %i also permits an onboard shortage when its reservoir is clear",
    async (dockType) => {
      const robot = await uptown({ ...UPTOWN, dock_type: dockType });
      await select(robot, 1);
      expect(fault(robot)).toBe(0);
    }
  );

  test.each([
    ["both clear", 40, 0, 0],
    ["onboard shortage only", 40, 1, 0],
    ["dock reservoir empty only", 36, 0, 0],
    ["both empty", 36, 1, 68],
  ])(
    "a dock status word distinguishes %s",
    async (_name, dss, shortage, expected) => {
      // Dirty-water field 2 (okay); clean-water field 2 (okay) or 1 (empty).
      const robot = await uptown({
        ...UPTOWN,
        dock_type: 16,
        dss,
        water_shortage_status: shortage,
      });
      expect(fault(robot)).toBe(expected);
    }
  );

  test.each([
    ["onboard reading", "water_shortage_status"],
    ["dock reading", "dock_error_status"],
  ])(
    "a missing %s does not establish that both tanks are empty",
    async (_name, key) => {
      const frame = { ...UPTOWN, dock_error_status: 38 };
      delete frame[key];
      const robot = await uptown(frame);
      expect(fault(robot)).toBe(0);
      expect(robot.store.events).toEqual([]);
    }
  );

  test("a clean dock word clears the warning while onboard shortage remains", async () => {
    const robot = await uptown({ ...UPTOWN, dock_type: 16, dss: 36 });
    expect(fault(robot)).toBe(68);

    await robot.localReply({ ...UPTOWN, dock_type: 16, dss: 40 });

    expect(fault(robot)).toBe(0);
    expect(state(robot)).toBe(66);
  });

  test("a standing two-tank fault survives sparse battery pushes without repeated events", async () => {
    const robot = await uptown({ ...UPTOWN, dock_error_status: 38 });
    await robot.localReply({ battery: 99 });
    for (let i = 0; i < 3; i += 1) {
      await robot.vacuum.updateMatterStateFromRoborock();
    }
    expect(fault(robot)).toBe(68);
    expect(robot.store.events).toHaveLength(1);
  });

  test("selecting Mop and starting from Matter still sends the cleaning command", async () => {
    const robot = await uptown();
    await select(robot, 1);
    expect(fault(robot)).toBe(0);

    await robot.accessory.handlers.rvcRunMode.changeToMode({ newMode: 1 });
    await robot.settle();

    expect(robot.commands).toContain("app_start");
    expect(fault(robot)).toBe(0);
    expect(state(robot)).toBe(1);
    expect(robot.store.rejected).toEqual([]);
  });

  test("vacuum-only use remains available even with both tanks empty", async () => {
    const robot = await uptown({ ...UPTOWN, dock_error_status: 38 });
    expect(fault(robot)).toBe(68);
    await select(robot, 0);
    expect(fault(robot)).toBe(0);
    await select(robot, 1);
    expect(fault(robot)).toBe(68);
  });
});

describe("other water sensors and faults retain their meaning", () => {
  test.each([0, 1, 5, -9999, 999])(
    "dock type %i does not grant an automatic refill",
    async (dockType) => {
      const robot = await uptown({ ...UPTOWN, dock_type: dockType });
      expect(fault(robot)).toBe(68);
    }
  );

  test("an unknown dock retains the existing single-tank warning", async () => {
    const frame = { ...UPTOWN };
    delete frame.dock_type;
    const robot = await uptown(frame);
    expect(fault(robot)).toBe(68);
  });

  test("an empty dock reservoir remains visible on the HAP sensor", async () => {
    const robot = await uptown({
      ...UPTOWN,
      dock_error_status: 38,
      water_shortage_status: 0,
    });
    expect(fault(robot)).toBe(0);
    expect(robot.vacuum.getHomeKitStateSensorValue("waterTankEmpty")).toBe(
      true
    );
  });

  test("a full dirty-water tank still blocks mopping", async () => {
    const robot = await uptown({ ...UPTOWN, dock_error_status: 39 });
    expect(fault(robot)).toBe(74);
    expect(robot.vacuum.getHomeKitStateSensorValue("dirtyWaterTankFull")).toBe(
      true
    );
  });

  test("a robot fault is not hidden by the available refill supply", async () => {
    const robot = await uptown({ ...UPTOWN, state: 12, error_code: 8 });
    expect(fault(robot)).toBe(65);
    expect(state(robot)).toBe(3);
  });
});
