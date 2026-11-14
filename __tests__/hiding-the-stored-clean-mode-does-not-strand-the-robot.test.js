"use strict";

// The trap under `matterHiddenCleanModes` (#50), documented in
// docs/matter-clean-mode-shrink-issue-draft.md: matter.js 0.17.9 persists the
// clean mode cluster's `currentMode` and restores it at the next start, but
// not `supportedModes`, which is whatever the plugin supplies. A restored mode
// missing from the supplied list makes RvcCleanModeServer.initialize throw,
// the accessory fails to register on that start and every later one, and the
// robot is gone from Apple Home.
//
// #50's tile showed Vacuum + Mop — the mode he asked to hide. Enabling the
// setting naively would have done exactly that to his robot. So the accessory
// context keeps the mode Matter holds, and a hidden mode Matter still holds is
// announced for one more start, with a warning.
//
// Each "start" below is a new accessory on a new API, registered against what
// the previous start persisted (registerMatterEndpoint), with the context the
// platform saved at shutdown — the restart as Homebridge does it.

const {
  createRealApiVacuum,
  disposeRealApiVacuums,
} = require("../test-support/real-api-matter-vacuum");
const {
  registerMatterEndpoint,
} = require("../test-support/matter-0.17.9-store");

afterEach(disposeRealApiVacuums);

const VACUUM = 0;
const VACUUM_AND_MOP = 2;

const CLEANING_WITH_WATER = {
  state: 5,
  battery: 80,
  charge_status: 0,
  error_code: 0,
  in_cleaning: 1,
  fan_power: 102,
  water_box_mode: 202,
  mop_mode: 300,
  clean_area: 1250000,
  clean_time: 120,
};
const DOCKED = {
  state: 8,
  battery: 100,
  charge_status: 1,
  error_code: 0,
  in_cleaning: 0,
  fan_power: 102,
  water_box_mode: 202,
  mop_mode: 300,
};

const HIDE_VACUUM_AND_MOP = { matterHiddenCleanModes: ["vacuumAndMop"] };

const announced = (robot) =>
  robot.accessory.clusters.rvcCleanMode.supportedModes.map(({ mode }) => mode);
const cleanMode = (robot) => robot.store.read("rvcCleanMode", "currentMode");
const warnings = (robot) => robot.log.warn.mock.calls.map(([line]) => line);

/** A start on the version before the setting, ending with the tile on 2. */
async function aStartThatLeavesVacuumAndMopStored() {
  const first = await createRealApiVacuum();
  await first.localReply(CLEANING_WITH_WATER);
  await first.settle();
  expect(cleanMode(first)).toBe(VACUUM_AND_MOP);
  return first.restart();
}

describe("the brick, as the 0.17.9 store reproduces it", () => {
  test("a stored mode the supplied list lacks fails the registration", () => {
    expect(() =>
      registerMatterEndpoint(
        {
          rvcCleanMode: {
            supportedModes: [{ mode: 0 }, { mode: 1 }],
            currentMode: 0,
          },
        },
        { rvcCleanMode: { currentMode: 2 } }
      )
    ).toThrow("Can not use unsupported mode: 2. Allowed modes are 0, 1");
  });

  test("the list hiding Vacuum + Mop supplies, against a stored 2, does not register", async () => {
    // A context that wrongly says Vacuum is what a guard-less plugin amounts
    // to: it supplies the list without 2 whatever Matter holds.
    const restart = await aStartThatLeavesVacuumAndMopStored();

    await expect(
      createRealApiVacuum({
        platformConfig: HIDE_VACUUM_AND_MOP,
        savedContext: {
          ...restart.savedContext,
          matterStoredCleanMode: VACUUM,
        },
        persistedMatterState: restart.persistedMatterState,
      })
    ).rejects.toThrow(
      /Can not use unsupported mode: 2\. Allowed modes are 0, 1, 3/
    );
  });
});

describe("the context knows the mode Matter holds", () => {
  test("a start records the mode it leaves in the store", async () => {
    const restart = await aStartThatLeavesVacuumAndMopStored();

    expect(restart.persistedMatterState.rvcCleanMode.currentMode).toBe(
      VACUUM_AND_MOP
    );
    expect(restart.savedContext.matterStoredCleanMode).toBe(VACUUM_AND_MOP);
  });

  test("it is what the store holds, also when the publish wrote nothing", async () => {
    // The store came back from the last start holding 2 and the robot is
    // still in that run, so there is nothing to write; a stale record must
    // still give way to what the store reads back.
    const rocky = await createRealApiVacuum({
      savedContext: { matterStoredCleanMode: VACUUM },
      persistedMatterState: { rvcCleanMode: { currentMode: VACUUM_AND_MOP } },
    });

    await rocky.localReply(CLEANING_WITH_WATER);
    await rocky.settle();

    expect(
      rocky.store.writes.filter(
        ({ cluster, attributes }) =>
          cluster === "rvcCleanMode" && "currentMode" in attributes
      )
    ).toEqual([]);
    expect(rocky.accessory.context.matterStoredCleanMode).toBe(VACUUM_AND_MOP);
  });

  test("a store that cannot be read back holds what was written to it", async () => {
    const rocky = await createRealApiVacuum();
    delete rocky.store.getAccessoryState;

    await rocky.localReply(CLEANING_WITH_WATER);
    await rocky.settle();

    expect(rocky.accessory.context.matterStoredCleanMode).toBe(VACUUM_AND_MOP);
  });
});

describe("hiding the mode Matter holds keeps it for one start", () => {
  test("#50: the robot registers, with Vacuum + Mop still offered and one warning", async () => {
    const restart = await aStartThatLeavesVacuumAndMopStored();

    const second = await createRealApiVacuum({
      platformConfig: HIDE_VACUUM_AND_MOP,
      ...restart,
    });

    expect(announced(second)).toContain(VACUUM_AND_MOP);
    expect(cleanMode(second)).toBe(VACUUM_AND_MOP);
    expect(warnings(second)).toHaveLength(1);
    const [warning] = warnings(second);
    expect(warning).toMatch(/^Rocky: /);
    expect(warning).toMatch(/Vacuum \+ Mop/);
    expect(warning).toMatch(
      /Pick another mode for Rocky in Apple Home and restart Homebridge/
    );
    expect(warning).toMatch(/removed from Apple Home and added again/);
  });

  test("for that start it is an ordinary mode: a vacuum + mop run shows it, and it can be picked", async () => {
    const restart = await aStartThatLeavesVacuumAndMopStored();
    const second = await createRealApiVacuum({
      platformConfig: HIDE_VACUUM_AND_MOP,
      ...restart,
    });

    await second.localReply(CLEANING_WITH_WATER);
    await second.settle();
    expect(cleanMode(second)).toBe(VACUUM_AND_MOP);
    expect(second.store.rejected).toEqual([]);

    await second.localReply(DOCKED);
    await second.accessory.handlers.rvcCleanMode.changeToMode({
      newMode: VACUUM_AND_MOP,
    });
    await second.settle();
    expect(warnings(second)).not.toContainEqual(
      expect.stringMatching(/Ignoring unsupported Matter clean mode/)
    );
    expect(cleanMode(second)).toBe(VACUUM_AND_MOP);
  });

  test("once Apple Home holds another mode, the next start leaves it out and registers", async () => {
    const restart = await aStartThatLeavesVacuumAndMopStored();
    const second = await createRealApiVacuum({
      platformConfig: HIDE_VACUUM_AND_MOP,
      ...restart,
    });

    // What the warning asks for: pick another mode in Apple Home.
    await second.accessory.handlers.rvcCleanMode.changeToMode({
      newMode: VACUUM,
    });
    await second.settle();
    expect(cleanMode(second)).toBe(VACUUM);
    const afterSecond = second.restart();
    expect(afterSecond.persistedMatterState.rvcCleanMode.currentMode).toBe(
      VACUUM
    );

    const third = await createRealApiVacuum({
      platformConfig: HIDE_VACUUM_AND_MOP,
      ...afterSecond,
    });

    expect(announced(third)).not.toContain(VACUUM_AND_MOP);
    expect(cleanMode(third)).toBe(VACUUM);
    expect(warnings(third)).toEqual([]);
  });

  test("a start that still holds it after a run keeps it again, and warns again", async () => {
    // The kept start ended mid vacuum + mop run, so the store still says 2.
    const restart = await aStartThatLeavesVacuumAndMopStored();
    const second = await createRealApiVacuum({
      platformConfig: HIDE_VACUUM_AND_MOP,
      ...restart,
    });
    await second.localReply(CLEANING_WITH_WATER);
    await second.settle();

    const third = await createRealApiVacuum({
      platformConfig: HIDE_VACUUM_AND_MOP,
      ...second.restart(),
    });

    expect(announced(third)).toContain(VACUUM_AND_MOP);
    expect(warnings(third)).toHaveLength(1);
  });
});

describe("a start that has not seen the stored mode yet", () => {
  // The first start on this version: the context the platform saved has no
  // record, and Matter may hold anything it was offered before.
  test("keeps every hidden mode, registers, and says one more restart is needed", async () => {
    const second = await createRealApiVacuum({
      platformConfig: { matterHiddenCleanModes: ["mop", "vacuumAndMop"] },
      savedContext: {},
      persistedMatterState: { rvcCleanMode: { currentMode: VACUUM_AND_MOP } },
    });

    expect(announced(second)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(warnings(second)).toHaveLength(1);
    expect(warnings(second)[0]).toMatch(
      /^Rocky: Mop and Vacuum \+ Mop stay .* From the next restart they are left out/
    );
  });

  test("and the next start, once a visible mode is stored, drops them", async () => {
    const second = await createRealApiVacuum({
      platformConfig: { matterHiddenCleanModes: ["mop", "vacuumAndMop"] },
      savedContext: {},
      persistedMatterState: { rvcCleanMode: { currentMode: VACUUM_AND_MOP } },
    });
    // The first publish at the dock replaces the stored 2.
    await second.localReply(DOCKED);
    await second.settle();
    expect([1, 2]).not.toContain(cleanMode(second));

    const third = await createRealApiVacuum({
      platformConfig: { matterHiddenCleanModes: ["mop", "vacuumAndMop"] },
      ...second.restart(),
    });

    expect(announced(third)).toEqual([0, 3, 4, 5, 6, 7]);
    expect(warnings(third)).toEqual([]);
  });
});
