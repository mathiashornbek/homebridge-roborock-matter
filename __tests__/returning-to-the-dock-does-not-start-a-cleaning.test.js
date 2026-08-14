"use strict";

// 3.6.2 stopped a dock chore from announcing a cleaning, and the reporter of
// issue #9 confirmed in the field that it worked. Then he added one sentence:
// "after emptying the tank, it briefly returns to the dock for a second and
// sends another notification."
//
// That second notification is a different bug with the same shape. When the
// dust bin has been emptied the robot reports Roborock state 6/15 — returning
// to dock / docking — for about a second before settling back to charging.
// That state derives to SEEKING_CHARGER, which isInCleaningRunMode() counts as
// cleaning, and resolveRunMode() froze the run mode only for the three DOCK
// ACTIVITY states. So the one-second blip published Cleaning and then Idle: a
// cleaning that started and finished, from a robot that never left its dock.
//
// It is the mirror of 3.6.2's bug in one more way. That one hit everybody; this
// one hits only the users who enabled "Extended Operational States", because
// with the toggle off SEEKING_CHARGER is rewritten to STOPPED one level below
// and never reaches the cleaning test. The rule therefore has to be decided
// from the robot's own state, exactly as the comment above resolveRunMode
// already demands — the toggle decides how a state is DISPLAYED, never whether
// a cleaning happened.
//
// The fix is "inherit", not "always Idle", for the same reason it was in 3.6.2:
// driving home is how a real run ends. A robot that was cleaning must keep
// saying Cleaning until it docks. Inheriting delivers both directions from one
// rule — and, as a side effect, makes the toggle stop changing WHEN Apple Home
// announces that a cleaning finished.
//
// The `cleaning` HomeKit sensor mirrors the last PUBLISHED run mode, so the
// phantom pair did not only notify: it fired every automation triggered on the
// robot starting or finishing a clean. Covered below.

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

// Every Roborock state that derives to SEEKING_CHARGER. All three are transit:
// the robot is on its way somewhere, which is never the START of a cleaning.
const TRANSIT_STATES = [
  { label: "returning to dock", state: 6 },
  { label: "docking", state: 15 },
  { label: "going to wash the mop", state: 26 },
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
      app_charge: jest.fn().mockResolvedValue(undefined),
      app_start: jest.fn().mockResolvedValue(undefined),
      app_stop: jest.fn().mockResolvedValue(undefined),
      app_pause: jest.fn().mockResolvedValue(undefined),
    },
  };
}

function createVacuum({ initialStatus, extended }) {
  const matterUpdates = [];
  const status = { ...initialStatus };
  const platform = createPlatform({ status, extended, matterUpdates });
  const accessory = { UUID: "uuid-transit", context: { duid: "device-1" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-1" },
    true
  );
  return { vacuum, accessory, platform, status, matterUpdates };
}

function drainRunModes(matterUpdates) {
  const runModes = [];
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
  return runModes;
}

/**
 * Drive a robot through a sequence of live status frames and collect every run
 * mode that reached Matter, starting with the one published at registration.
 */
async function publishedRunModes({ initialStatus, frames, extended }) {
  const harness = createVacuum({ initialStatus, extended });
  const runModes = [harness.accessory.clusters.rvcRunMode.currentMode];
  harness.matterUpdates.length = 0;

  for (const frame of frames) {
    // Keep the snapshot in step with the live frame so nothing falls back to a
    // stale HomeData reading.
    Object.assign(harness.status, frame);
    await harness.vacuum.notifyDeviceUpdater("CloudMessage", [frame]);
    runModes.push(...drainRunModes(harness.matterUpdates));
  }

  return runModes;
}

describe("the states that inherit a run mode are named once", () => {
  const source = fs.readFileSync(SOURCE_PATH, "utf8");

  test("the inherit list is derived from the dock chores plus seeking charger", () => {
    const declaration = source.match(
      /const RUN_MODE_INHERITED_STATES: ReadonlySet<number> = new Set\(\[([\s\S]*?)\]\);/
    );
    expect(declaration).not.toBeNull();

    // Spread, never a second hand-written copy: DOCK_ACTIVITY_STATES is the
    // one list of dock chores and adding a fourth must reach this rule too.
    expect(declaration[1]).toContain("...DOCK_ACTIVITY_STATES");
    expect(declaration[1]).toContain("RVC_OPERATIONAL_STATE.SEEKING_CHARGER");
    expect(declaration[1]).not.toContain("EMPTYING_DUST_BIN");
  });

  test("the run mode gates on the robot's own state, not the displayed one", () => {
    // Reading the controller-facing state here would make the rule depend on
    // the Extended Operational States toggle, which only decides how a state
    // is DISPLAYED. That is precisely how this bug reached the field.
    const resolver = source.slice(
      source.indexOf("private resolveRunMode(): number {")
    );
    expect(resolver).toContain("this.getRoborockOperationalState(");
    expect(resolver).toContain(
      "RUN_MODE_INHERITED_STATES.has(roborockOperationalState)"
    );
  });
});

describe.each(TOGGLES)("with $label", ({ extended }) => {
  describe.each(TRANSIT_STATES)(
    "a docked robot that reports $label",
    ({ state }) => {
      test("never announces a cleaning", async () => {
        const runModes = await publishedRunModes({
          initialStatus: { state: 8, charge_status: 1, battery: 100 },
          frames: [
            { state, charge_status: 1, battery: 100 },
            { state: 8, charge_status: 1, battery: 100 },
          ],
          extended,
        });

        expect(runModes).not.toContain(RUN_MODE_CLEANING);
      });
    }
  );

  describe.each(TRANSIT_STATES)(
    "the blip that follows emptying the dust bin, reported as $label",
    ({ state }) => {
      // The field sequence from issue #9, in full: docked and charging, the
      // dock empties itself, the robot reports transit for about a second,
      // then charges again.
      test("never announces a cleaning", async () => {
        const runModes = await publishedRunModes({
          initialStatus: { state: 8, charge_status: 1, battery: 100 },
          frames: [
            { state: 22, charge_status: 1, battery: 100 },
            { state, charge_status: 1, battery: 100 },
            { state: 8, charge_status: 1, battery: 100 },
          ],
          extended,
        });

        expect(runModes).not.toContain(RUN_MODE_CLEANING);
      });

      test("never fires the cleaning sensor either", async () => {
        // The sensor mirrors the published run mode, so a phantom pair on the
        // tile is a phantom pair on every automation built on that sensor.
        const harness = createVacuum({
          initialStatus: { state: 8, charge_status: 1, battery: 100 },
          extended,
        });
        const seen = [
          harness.vacuum.getHomeKitStateSensorValue("cleaning") === true,
        ];

        for (const frame of [
          { state: 22, charge_status: 1, battery: 100 },
          { state, charge_status: 1, battery: 100 },
          { state: 8, charge_status: 1, battery: 100 },
        ]) {
          Object.assign(harness.status, frame);
          await harness.vacuum.notifyDeviceUpdater("CloudMessage", [frame]);
          seen.push(
            harness.vacuum.getHomeKitStateSensorValue("cleaning") === true
          );
        }

        expect(seen).not.toContain(true);
      });
    }
  );

  test("a robot that never left its dock stays idle through a bare transit blip", async () => {
    const runModes = await publishedRunModes({
      initialStatus: { state: 8, charge_status: 1, battery: 100 },
      frames: [
        { state: 6, charge_status: 1, battery: 100 },
        { state: 8, charge_status: 1, battery: 100 },
      ],
      extended,
    });

    expect(runModes).toEqual(runModes.map(() => RUN_MODE_IDLE));
  });

  test("a run that ends by driving home stays Cleaning until the robot docks", async () => {
    // The reason the fix is "inherit" and not "always Idle" — and the reason
    // the toggle must stop deciding WHEN the cleaning is announced finished.
    const harness = createVacuum({
      initialStatus: { state: 5, charge_status: 0, battery: 40 },
      extended,
    });
    expect(harness.accessory.clusters.rvcRunMode.currentMode).toBe(
      RUN_MODE_CLEANING
    );
    harness.matterUpdates.length = 0;

    Object.assign(harness.status, { state: 6, charge_status: 0, battery: 38 });
    await harness.vacuum.notifyDeviceUpdater("CloudMessage", [
      { state: 6, charge_status: 0, battery: 38 },
    ]);
    const whileDrivingHome = drainRunModes(harness.matterUpdates);
    expect(whileDrivingHome).not.toContain(RUN_MODE_IDLE);
    expect(harness.vacuum.getHomeKitStateSensorValue("cleaning")).toBe(true);

    Object.assign(harness.status, { state: 8, charge_status: 1, battery: 38 });
    await harness.vacuum.notifyDeviceUpdater("CloudMessage", [
      { state: 8, charge_status: 1, battery: 38 },
    ]);
    expect(drainRunModes(harness.matterUpdates)).toContain(RUN_MODE_IDLE);
    expect(harness.vacuum.getHomeKitStateSensorValue("cleaning")).toBe(false);
  });

  test("a mid-run trip to wash the mop does not end the run", async () => {
    const runModes = await publishedRunModes({
      initialStatus: { state: 5, charge_status: 0, battery: 70 },
      frames: [
        { state: 26, charge_status: 0, battery: 69 },
        { state: 23, charge_status: 1, battery: 69 },
        { state: 5, charge_status: 0, battery: 68 },
      ],
      extended,
    });

    expect(runModes[0]).toBe(RUN_MODE_CLEANING);
    expect(runModes).not.toContain(RUN_MODE_IDLE);
  });

  test("docking from Apple Home while idle does not announce a cleaning", async () => {
    // The optimistic write moves the tile before the robot confirms. If it
    // decided its own run mode it would announce a cleaning that the live
    // status then silently withdraws a poll later.
    const harness = createVacuum({
      initialStatus: { state: 8, charge_status: 1, battery: 100 },
      extended,
    });
    harness.matterUpdates.length = 0;

    await harness.accessory.handlers.rvcOperationalState.goHome();

    expect(drainRunModes(harness.matterUpdates)).not.toContain(
      RUN_MODE_CLEANING
    );
    expect(harness.platform.roborockAPI.app_charge).toHaveBeenCalled();
  });

  test("docking from Apple Home mid-run keeps the run going", async () => {
    const harness = createVacuum({
      initialStatus: { state: 5, charge_status: 0, battery: 50 },
      extended,
    });
    harness.matterUpdates.length = 0;

    await harness.accessory.handlers.rvcOperationalState.goHome();

    expect(drainRunModes(harness.matterUpdates)).not.toContain(RUN_MODE_IDLE);
    expect(harness.platform.roborockAPI.app_charge).toHaveBeenCalled();
  });

  // No-regression guards: nothing that is not transit or a dock chore may stop
  // deciding its own run mode.
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

  test("a plugin that starts up mid-transit knows of no run", async () => {
    // Nothing was inherited because nothing was published yet: lastRunMode
    // starts Idle, and claiming a cleaning on the strength of a robot that is
    // merely driving somewhere would fire every start automation on restart.
    const runModes = await publishedRunModes({
      initialStatus: { state: 6, charge_status: 0, battery: 60 },
      frames: [],
      extended,
    });

    expect(runModes).toEqual([RUN_MODE_IDLE]);
  });
});
