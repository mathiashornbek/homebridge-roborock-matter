"use strict";

// Apple Home reads RvcRunMode as the answer to "is this robot cleaning?": it
// announces a cleaning that started when the mode becomes Cleaning, and one
// that finished when it goes back to Idle.
//
// A dock chore is neither. The dock emptying the dust bin, washing the mop or
// the robot updating its maps is housekeeping — it does not start a cleaning
// run and it does not end one. The plugin published Cleaning for all three,
// so a Q Revo sitting idle in its dock announced a cleaning that started and
// finished every time the dock emptied itself (issue #9).
//
// The mirror image is the reason the fix is "inherit", not "always Idle": a
// robot that empties its bin in the MIDDLE of a run must not announce that the
// run finished and then started again either. Both directions are enumerated
// below, for every dock chore and with the display toggle both ways — because
// with "Extended Operational States" off the chore is rewritten to RUNNING one
// level below, and a rule that read the controller-facing state would work
// only for the users who happened to enable that toggle.

const fs = require("fs");
const path = require("path");

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const SOURCE_PATH = path.join(
  __dirname,
  "..",
  "src",
  "matter_vacuum_accessory.ts"
);

const RUN_MODE_IDLE = 0;
const RUN_MODE_CLEANING = 1;

// Roborock state codes for the three dock chores, with the Matter operational
// state each one derives to.
const DOCK_CHORES = [
  { label: "emptying the dust bin", state: 22, operationalState: 67 },
  { label: "washing the mop", state: 23, operationalState: 68 },
  { label: "updating maps", state: 29, operationalState: 70 },
];

const TOGGLES = [
  { label: "extended operational states on", extended: true },
  { label: "extended operational states off", extended: false },
];

function createPlatform({ status, extended, matterUpdates }) {
  return {
    platformConfig: {
      enableMatter: true,
      enableMatterCleanMode: true,
      enableMatterExtendedOperationalStates: extended,
    },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => ({
      updateAccessoryState: jest.fn(async (uuid, cluster, attributes) => {
        matterUpdates.push({ cluster, attributes });
      }),
    }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Q Revo" : "",
      getProductAttribute: () => "roborock.vacuum.a75",
      getVacuumDeviceStatus: (duid, property) => status[property] ?? "",
      getRoomMappingsForDevice: () => [],
      getMapListForDevice: () => [],
      getCurrentMapIdForDevice: () => null,
      getMatterCleanModeCapabilities: () => ({
        canVacuum: true,
        canMop: true,
        canControlFanPower: true,
        canMaxPlusFanPower: false,
        canControlWater: true,
      }),
      getStatus: jest.fn().mockResolvedValue(undefined),
    },
  };
}

/**
 * Drive a robot through a sequence of live status frames and collect every
 * run mode that reached Matter, starting with the one published at
 * registration.
 */
async function publishedRunModes({ initialStatus, frames, extended }) {
  const matterUpdates = [];
  const status = { ...initialStatus };
  const platform = createPlatform({ status, extended, matterUpdates });
  const accessory = { UUID: "uuid-dock-chore", context: { duid: "device-1" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-1" },
    true
  );

  const runModes = [accessory.clusters.rvcRunMode.currentMode];

  for (const frame of frames) {
    // Keep the snapshot in step with the live frame so nothing falls back to
    // a stale HomeData reading.
    Object.assign(status, frame);
    await vacuum.notifyDeviceUpdater("CloudMessage", [frame]);
    for (const update of matterUpdates) {
      if (
        update.cluster === "rvcRunMode" &&
        update.attributes &&
        "currentMode" in update.attributes
      ) {
        runModes.push(update.attributes.currentMode);
      }
    }
    matterUpdates.length = 0;
  }

  return runModes;
}

describe("the dock chores are named once", () => {
  const source = fs.readFileSync(SOURCE_PATH, "utf8");

  test("there is exactly one list of dock chores", () => {
    const declaration = source.match(
      /const DOCK_ACTIVITY_STATES: ReadonlySet<number> = new Set\(\[([\s\S]*?)\]\);/
    );
    expect(declaration).not.toBeNull();

    const listed = [...declaration[1].matchAll(/RVC_OPERATIONAL_STATE\.(\w+)/g)]
      .map((match) => match[1])
      .sort();
    expect(listed).toEqual([
      "CLEANING_MOP",
      "EMPTYING_DUST_BIN",
      "UPDATING_MAPS",
    ]);

    // The extended-states set advertises the same three plus SeekingCharger.
    // It must SPREAD the list rather than repeat it: two hand-written copies
    // of one list is how the two ends drift apart.
    const extended = source.match(
      /const EXTENDED_OPERATIONAL_STATES: ReadonlySet<number> = new Set\(\[([\s\S]*?)\]\);/
    );
    expect(extended).not.toBeNull();
    expect(extended[1]).toContain("...DOCK_ACTIVITY_STATES");
    expect(extended[1]).not.toContain("EMPTYING_DUST_BIN");
  });

  test("the run mode recognises a chore from the robot's own state", () => {
    // Reading the controller-facing state here would make the rule depend on
    // the Extended Operational States toggle, which only decides how the
    // chore is DISPLAYED.
    const resolver = source.slice(
      source.indexOf("private resolveRunMode(): number {")
    );
    expect(resolver).toContain("this.getRoborockOperationalState(");
    // The gate widened to RUN_MODE_INHERITED_STATES when transit joined the
    // dock chores in inheriting the run mode instead of deciding one. What
    // this test is here to hold is that the chores still reach that gate, so
    // assert the derivation rather than the literal name of the set.
    expect(
      resolver.indexOf(
        "RUN_MODE_INHERITED_STATES.has(roborockOperationalState)"
      )
    ).toBeGreaterThan(-1);

    const inherited = source.match(
      /const RUN_MODE_INHERITED_STATES: ReadonlySet<number> = new Set\(\[([\s\S]*?)\]\);/
    );
    expect(inherited).not.toBeNull();
    expect(inherited[1]).toContain("...DOCK_ACTIVITY_STATES");
  });
});

describe.each(TOGGLES)("with $label", ({ extended }) => {
  describe.each(DOCK_CHORES)(
    "a dock that starts $label while the robot is idle",
    ({ state, operationalState }) => {
      test("never announces a cleaning", async () => {
        const runModes = await publishedRunModes({
          // Docked and charging, exactly issue #9's snapshot.
          initialStatus: { state: 8, charge_status: 1, battery: 100 },
          frames: [
            { state, charge_status: 1, battery: 100 },
            { state: 8, charge_status: 1, battery: 100 },
          ],
          extended,
        });

        expect(runModes).not.toContain(RUN_MODE_CLEANING);
      });

      test("still reports the chore itself as the operational state", async () => {
        // The fix must not cost the Extended Operational States feature its
        // whole point: the tile still says what the dock is doing.
        const matterUpdates = [];
        const status = { state: 8, charge_status: 1, battery: 100 };
        const platform = createPlatform({ status, extended, matterUpdates });
        const accessory = {
          UUID: "uuid-dock-chore",
          context: { duid: "device-1" },
        };
        const vacuum = new RoborockMatterVacuumAccessory(
          platform,
          accessory,
          { duid: "device-1" },
          true
        );
        matterUpdates.length = 0;

        Object.assign(status, { state, charge_status: 1 });
        await vacuum.notifyDeviceUpdater("CloudMessage", [
          { state, charge_status: 1, battery: 100 },
        ]);

        const published = matterUpdates
          .filter((update) => update.cluster === "rvcOperationalState")
          .map((update) => update.attributes.operationalState)
          .filter((value) => value !== undefined);

        expect(published).toContain(extended ? operationalState : 1);
      });
    }
  );

  describe.each(DOCK_CHORES)(
    "a robot that pauses mid-run for $label",
    ({ state }) => {
      test("does not announce that the run finished", async () => {
        const runModes = await publishedRunModes({
          // Cleaning.
          initialStatus: { state: 5, charge_status: 0, battery: 70 },
          frames: [
            { state, charge_status: 1, battery: 70 },
            { state: 5, charge_status: 0, battery: 68 },
          ],
          extended,
        });

        expect(runModes[0]).toBe(RUN_MODE_CLEANING);
        expect(runModes).not.toContain(RUN_MODE_IDLE);
      });
    }
  );

  test("a chore that follows a finished run inherits the finished run", async () => {
    // Clean -> seek charger -> charging -> the dock empties itself. The run
    // ended when the robot docked; the chore must not revive it.
    const runModes = await publishedRunModes({
      initialStatus: { state: 5, charge_status: 0, battery: 40 },
      frames: [
        { state: 6, charge_status: 0, battery: 38 },
        { state: 8, charge_status: 1, battery: 38 },
        { state: 22, charge_status: 1, battery: 39 },
        { state: 8, charge_status: 1, battery: 40 },
      ],
      extended,
    });

    expect(runModes[0]).toBe(RUN_MODE_CLEANING);
    expect(runModes[runModes.length - 1]).toBe(RUN_MODE_IDLE);
    // Cleaning must never come back after the robot docked.
    const firstIdle = runModes.indexOf(RUN_MODE_IDLE);
    expect(firstIdle).toBeGreaterThan(-1);
    expect(runModes.slice(firstIdle)).not.toContain(RUN_MODE_CLEANING);
  });

  test("a plugin that starts up during a chore knows of no run", async () => {
    const runModes = await publishedRunModes({
      initialStatus: { state: 22, charge_status: 1, battery: 100 },
      frames: [],
      extended,
    });

    expect(runModes).toEqual([RUN_MODE_IDLE]);
  });

  // No-regression guards: everything that is not a dock chore must decide its
  // run mode exactly as before.
  test.each([
    {
      label: "cleaning",
      state: 5,
      chargeStatus: 0,
      expected: RUN_MODE_CLEANING,
    },
    {
      label: "room cleaning",
      state: 18,
      chargeStatus: 0,
      expected: RUN_MODE_CLEANING,
    },
    {
      label: "paused",
      state: 10,
      chargeStatus: 0,
      expected: RUN_MODE_CLEANING,
    },
    { label: "charging", state: 8, chargeStatus: 1, expected: RUN_MODE_IDLE },
    {
      label: "fully charged",
      state: 100,
      chargeStatus: 1,
      expected: RUN_MODE_IDLE,
    },
    { label: "in error", state: 12, chargeStatus: 0, expected: RUN_MODE_IDLE },
  ])(
    "$label still publishes its own run mode",
    async ({ state, chargeStatus, expected }) => {
      const runModes = await publishedRunModes({
        initialStatus: { state, charge_status: chargeStatus, battery: 50 },
        frames: [],
        extended,
      });

      expect(runModes).toEqual([expected]);
    }
  );
});
