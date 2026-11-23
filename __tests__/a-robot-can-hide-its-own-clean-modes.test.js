"use strict";

// `matterHiddenCleanModes` (#50) hides Mop and/or Vacuum + Mop on every robot
// on the account. One account had a Q Revo, which mops, and a Q5 Max+, which
// is sold vacuum-only: Roborock's cloud still reports that it can mop, because
// an optional tank exists, so Apple Home and Siri offered it Mop and
// Vacuum + Mop. The owner wanted those modes gone from the Q5 Max+ and kept on
// the Q Revo. The cloud is not wrong about the tank, so this is a preference,
// not a detection bug.
//
// `devices` holds one entry per robot that differs, found by serial or DUID
// the way `skipDevices` is. An entry's `matterHiddenCleanModes` replaces the
// global one for that robot; a robot without one follows the global setting,
// so a config without `devices` behaves exactly as before.
//
// A robot whose own list hides nothing must not log the "stays for this
// start" warnings meant for a robot that hides something. A robot whose own
// list hides a mode keeps the safeguard that
// hiding-the-stored-clean-mode-does-not-strand-the-robot is about.
//
// Real Roborock API, cloud-shaped HomeData (an a70: mop and water control,
// suction levels 3-7), the 0.17.9 store.

const {
  createRealApiVacuum,
  disposeRealApiVacuums,
} = require("../test-support/real-api-matter-vacuum");

afterEach(disposeRealApiVacuums);

const VACUUM = 0;
const VACUUM_AND_MOP = 2;

const DUID = "device-real-api";
const SERIAL = "R0QSERIAL01";

const HIDE_BOTH = ["mop", "vacuumAndMop"];
const STORED_VACUUM = { matterStoredCleanMode: VACUUM };

const EVERY_MODE = [0, 1, 2, 3, 4, 5, 6, 7];
const WITHOUT_MOP_MODES = [0, 3, 4, 5, 6, 7];

function robot(platformConfig, overrides = {}) {
  return createRealApiVacuum({
    sn: SERIAL,
    savedContext: STORED_VACUUM,
    ...overrides,
    platformConfig,
  });
}

const announced = (robot) =>
  robot.accessory.clusters.rvcCleanMode.supportedModes.map(({ mode }) => mode);
const warnings = (robot) => robot.log.warn.mock.calls.map(([line]) => line);

describe("a robot with its own entry uses its own list", () => {
  test("found by DUID: the Q5 Max+ hides both while nothing is hidden globally", async () => {
    const rocky = await robot({
      devices: [{ id: DUID, matterHiddenCleanModes: HIDE_BOTH }],
    });

    expect(announced(rocky)).toEqual(WITHOUT_MOP_MODES);
    expect(warnings(rocky)).toEqual([]);
  });

  test("found by serial number", async () => {
    const rocky = await robot({
      devices: [{ id: SERIAL, matterHiddenCleanModes: HIDE_BOTH }],
    });

    expect(announced(rocky)).toEqual(WITHOUT_MOP_MODES);
  });

  test("an id with spaces around it still matches", async () => {
    const rocky = await robot({
      devices: [{ id: `  ${SERIAL} `, matterHiddenCleanModes: HIDE_BOTH }],
    });

    expect(announced(rocky)).toEqual(WITHOUT_MOP_MODES);
  });

  test("it can hide a different mode than the global setting", async () => {
    const rocky = await robot({
      matterHiddenCleanModes: ["mop"],
      devices: [{ id: SERIAL, matterHiddenCleanModes: ["vacuumAndMop"] }],
    });

    expect(announced(rocky)).toEqual([0, 1, 3, 4, 5, 6, 7]);
  });

  test("an empty list shows every mode, though the global setting hides both", async () => {
    // The Q Revo, when the global setting is the Q5 Max+'s.
    const rocky = await robot({
      matterHiddenCleanModes: HIDE_BOTH,
      devices: [{ id: DUID, matterHiddenCleanModes: [] }],
    });

    expect(announced(rocky)).toEqual(EVERY_MODE);
    expect(warnings(rocky)).toEqual([]);
  });

  test("the first entry with a list wins", async () => {
    const rocky = await robot({
      devices: [
        { id: SERIAL },
        { id: DUID, matterHiddenCleanModes: ["mop"] },
        { id: SERIAL, matterHiddenCleanModes: HIDE_BOTH },
      ],
    });

    expect(announced(rocky)).toEqual([0, 2, 3, 4, 5, 6, 7]);
  });
});

describe("a robot without its own list follows the global setting", () => {
  test("no devices at all: both hidden, as before", async () => {
    const rocky = await robot({ matterHiddenCleanModes: HIDE_BOTH });

    expect(announced(rocky)).toEqual(WITHOUT_MOP_MODES);
    expect(warnings(rocky)).toEqual([]);
  });

  test("only another robot has an entry", async () => {
    const rocky = await robot({
      matterHiddenCleanModes: HIDE_BOTH,
      devices: [{ id: "OTHERSERIAL", matterHiddenCleanModes: [] }],
    });

    expect(announced(rocky)).toEqual(WITHOUT_MOP_MODES);
  });

  test("only another robot has an entry, and nothing is hidden globally: nothing hidden, nothing logged", async () => {
    // The Q Revo, when only the Q5 Max+ has an entry.
    const rocky = await robot({
      devices: [{ id: "OTHERSERIAL", matterHiddenCleanModes: HIDE_BOTH }],
    });

    expect(announced(rocky)).toEqual(EVERY_MODE);
    expect(warnings(rocky)).toEqual([]);
  });

  test("its entry has no list of its own", async () => {
    const rocky = await robot({
      matterHiddenCleanModes: HIDE_BOTH,
      devices: [{ id: DUID }],
    });

    expect(announced(rocky)).toEqual(WITHOUT_MOP_MODES);
  });

  test.each([
    ["not a list", "R0QSERIAL01"],
    ["entries that are not robots", [null, 5, "R0QSERIAL01", {}]],
    ["an empty id", [{ id: "  ", matterHiddenCleanModes: [] }]],
    [
      "a list that is not a list",
      [{ id: SERIAL, matterHiddenCleanModes: "mop" }],
    ],
  ])("%s: ignored", async (_, devices) => {
    const rocky = await robot({ matterHiddenCleanModes: HIDE_BOTH, devices });

    expect(announced(rocky)).toEqual(WITHOUT_MOP_MODES);
  });
});

describe("the stored-mode safeguard follows the robot's own list", () => {
  test("a mode its own list hides, but Apple Home has stored, stays for this start, with a warning", async () => {
    const rocky = await robot(
      { devices: [{ id: SERIAL, matterHiddenCleanModes: HIDE_BOTH }] },
      {
        savedContext: { matterStoredCleanMode: VACUUM_AND_MOP },
        persistedMatterState: {
          rvcCleanMode: { currentMode: VACUUM_AND_MOP },
        },
      }
    );

    expect(announced(rocky)).toEqual([0, 2, 3, 4, 5, 6, 7]);
    expect(rocky.store.read("rvcCleanMode", "currentMode")).toBe(
      VACUUM_AND_MOP
    );
    expect(warnings(rocky)).toHaveLength(1);
    expect(warnings(rocky)[0]).toMatch(
      /^Rocky: Apple Home has Vacuum \+ Mop stored as the cleaning mode/
    );
  });

  test("without a stored-mode record, its hidden modes stay for this start, with a warning", async () => {
    const rocky = await robot(
      { devices: [{ id: DUID, matterHiddenCleanModes: HIDE_BOTH }] },
      {
        savedContext: {},
        persistedMatterState: {
          rvcCleanMode: { currentMode: VACUUM_AND_MOP },
        },
      }
    );

    expect(announced(rocky)).toEqual(EVERY_MODE);
    expect(warnings(rocky)).toHaveLength(1);
    expect(warnings(rocky)[0]).toMatch(
      /^Rocky: Mop and Vacuum \+ Mop stay .* From the next restart they are left out/
    );
  });

  test("a robot whose own list hides nothing has no warning, even without a record", async () => {
    // The global setting would have warned about this robot. Its own list
    // hides nothing, so nothing stays.
    const rocky = await robot(
      {
        matterHiddenCleanModes: HIDE_BOTH,
        devices: [{ id: SERIAL, matterHiddenCleanModes: [] }],
      },
      {
        savedContext: {},
        persistedMatterState: {
          rvcCleanMode: { currentMode: VACUUM_AND_MOP },
        },
      }
    );

    expect(announced(rocky)).toEqual(EVERY_MODE);
    expect(warnings(rocky)).toEqual([]);
  });
});
