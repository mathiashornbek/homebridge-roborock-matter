"use strict";

// #50 (nicoreese, Q Revo, German Siri): whatever he said, Siri started the
// robot in Vacuum + Mop, and his log shows Siri itself chose it —
//
//   Matter clean mode request for Rocky: 2.
//   Matter run mode request for Rocky: 1.
//
// — the mode request lands right before the start. He never uses Vacuum + Mop
// from Apple Home and asked for it to be gone from what Apple Home and Siri
// can pick. `matterHiddenCleanModes` leaves Mop and/or Vacuum + Mop out of the
// announced list. Every path that decides a mode asks that list, so a hidden
// mode must be neither published nor accepted — including during a clean the
// Roborock app started in that mode.
//
// Real Roborock API, cloud-shaped HomeData (an a70: mop and water control,
// suction levels 3-7), the 0.17.9 store. The context records that Matter holds
// Vacuum, so these starts are not the transitional one that
// hiding-the-stored-clean-mode-does-not-strand-the-robot is about.

const {
  createRealApiVacuum,
  disposeRealApiVacuums,
} = require("../test-support/real-api-matter-vacuum");

afterEach(disposeRealApiVacuums);

const VACUUM = 0;
const MOP = 1;
const VACUUM_AND_MOP = 2;
const BALANCED = 4;

// A clean the Roborock app started: fan on, water on — vacuum + mop.
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

const STORED_VACUUM = { matterStoredCleanMode: VACUUM };

function robot(platformConfig = {}) {
  return createRealApiVacuum({ platformConfig, savedContext: STORED_VACUUM });
}

const announced = (robot) =>
  robot.accessory.clusters.rvcCleanMode?.supportedModes.map(({ mode }) => mode);
const cleanMode = (robot) => robot.store.read("rvcCleanMode", "currentMode");
const publishedModes = (robot) =>
  robot.store.writes
    .filter(({ cluster }) => cluster === "rvcCleanMode")
    .map(({ attributes }) => attributes.currentMode)
    .filter((mode) => mode !== undefined);

describe("a hidden mode is left out of the list Apple Home registers", () => {
  test("Vacuum + Mop hidden: every other mode stays, the suction levels included", async () => {
    const rocky = await robot({ matterHiddenCleanModes: ["vacuumAndMop"] });

    expect(announced(rocky)).toEqual([0, 1, 3, 4, 5, 6, 7]);
    expect(
      rocky.store.read("rvcCleanMode", "supportedModes").map(({ mode }) => mode)
    ).toEqual([0, 1, 3, 4, 5, 6, 7]);
  });

  test("both hidden: Vacuum and its suction levels", async () => {
    const rocky = await robot({
      matterHiddenCleanModes: ["mop", "vacuumAndMop"],
    });

    expect(announced(rocky)).toEqual([0, 3, 4, 5, 6, 7]);
  });

  test("Vacuum cannot be hidden: it is what everything falls back to", async () => {
    const rocky = await robot({ matterHiddenCleanModes: ["vacuum", "mop"] });

    expect(announced(rocky)).toEqual([0, 2, 3, 4, 5, 6, 7]);
  });

  test("both hidden without suction levels leaves one mode, so no mode list at all", async () => {
    // Matter needs 2 modes; one mode is no choice, and the cluster is
    // optional for an RVC — the rule a robot that cannot mop already follows.
    const rocky = await robot({
      enableFanPowerCleanModes: false,
      matterHiddenCleanModes: ["mop", "vacuumAndMop"],
    });

    expect(rocky.accessory.clusters.rvcCleanMode).toBeUndefined();
    expect(rocky.accessory.handlers.rvcCleanMode).toBeUndefined();
  });

  test("no warning on a start that has nothing to keep", async () => {
    const rocky = await robot({ matterHiddenCleanModes: ["vacuumAndMop"] });

    expect(rocky.log.warn).not.toHaveBeenCalled();
  });
});

describe("a clean the Roborock app runs as vacuum + mop, with Vacuum + Mop hidden", () => {
  test("is published as the suction level it runs at, never as 2", async () => {
    const rocky = await robot({ matterHiddenCleanModes: ["vacuumAndMop"] });

    await rocky.localReply(CLEANING_WITH_WATER);
    await rocky.settle();

    expect(cleanMode(rocky)).toBe(BALANCED);
    expect(publishedModes(rocky)).not.toContain(VACUUM_AND_MOP);
    expect(rocky.store.rejected).toEqual([]);
  });

  test("without suction levels it is published as Vacuum", async () => {
    const rocky = await robot({
      enableFanPowerCleanModes: false,
      matterHiddenCleanModes: ["vacuumAndMop"],
    });

    await rocky.localReply(CLEANING_WITH_WATER);
    await rocky.settle();

    expect(cleanMode(rocky)).toBe(VACUUM);
    expect(publishedModes(rocky)).not.toContain(VACUUM_AND_MOP);
    expect(rocky.store.rejected).toEqual([]);
  });

  test("the same run with nothing hidden is still published as 2", async () => {
    // The control: the derivation above is the setting's doing.
    const rocky = await robot();

    await rocky.localReply(CLEANING_WITH_WATER);
    await rocky.settle();

    expect(cleanMode(rocky)).toBe(VACUUM_AND_MOP);
  });

  test("a mop-only run with Mop hidden is never published as 1", async () => {
    const rocky = await robot({ matterHiddenCleanModes: ["mop"] });

    // Fan power 105 is the mop-only signature.
    await rocky.localReply({ ...CLEANING_WITH_WATER, fan_power: 105 });
    await rocky.settle();

    expect(publishedModes(rocky)).not.toContain(MOP);
    expect(announced(rocky)).toContain(cleanMode(rocky));
    expect(rocky.store.rejected).toEqual([]);
  });
});

describe("a hidden mode is never accepted", () => {
  test("a mode request for it is refused, and nothing reaches the robot", async () => {
    const rocky = await robot({ matterHiddenCleanModes: ["vacuumAndMop"] });

    await rocky.accessory.handlers.rvcCleanMode.changeToMode({
      newMode: VACUUM_AND_MOP,
    });
    await rocky.settle();

    expect(rocky.log.warn).toHaveBeenCalledWith(
      "Ignoring unsupported Matter clean mode '2' for Rocky."
    );
    expect(rocky.commands).toEqual([]);
    expect(publishedModes(rocky)).not.toContain(VACUUM_AND_MOP);
  });

  test("Siri's mode request then start runs the robot in a visible mode", async () => {
    // #50's two lines, in order: the hidden mode is refused, the start goes
    // ahead with what is displayed.
    const rocky = await robot({ matterHiddenCleanModes: ["vacuumAndMop"] });

    await rocky.accessory.handlers.rvcCleanMode.changeToMode({
      newMode: VACUUM_AND_MOP,
    });
    await rocky.accessory.handlers.rvcRunMode.changeToMode({ newMode: 1 });
    await rocky.settle();

    expect(rocky.commands).toContain("app_start");
    expect(publishedModes(rocky)).not.toContain(VACUUM_AND_MOP);
  });
});

describe("nothing changes when the setting hides nothing", () => {
  test.each([
    ["absent", undefined],
    ["empty", []],
    ["not a list", "vacuumAndMop"],
    ["only values it does not know", ["vacuum", "turbo"]],
  ])("%s: the same registration as without the setting", async (_, value) => {
    const baseline = await robot();
    const rocky = await robot(
      value === undefined ? {} : { matterHiddenCleanModes: value }
    );

    expect(rocky.accessory.clusters).toEqual(baseline.accessory.clusters);
    expect(Object.keys(rocky.accessory.handlers)).toEqual(
      Object.keys(baseline.accessory.handlers)
    );
    expect(announced(rocky)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(rocky.log.warn).not.toHaveBeenCalled();
  });

  test("an empty setting publishes vacuum + mop as before, without a context record too", async () => {
    const rocky = await createRealApiVacuum({
      platformConfig: { matterHiddenCleanModes: [] },
    });

    await rocky.localReply(CLEANING_WITH_WATER);
    await rocky.settle();

    expect(cleanMode(rocky)).toBe(VACUUM_AND_MOP);
    expect(rocky.log.warn).not.toHaveBeenCalled();
  });
});
