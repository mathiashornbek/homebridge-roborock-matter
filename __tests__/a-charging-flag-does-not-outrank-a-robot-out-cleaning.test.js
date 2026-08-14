"use strict";

// A robot cannot be cleaning your hallway and sitting in its dock at the same
// time, but until this test the plugin believed it could.
//
// `isRoborockDockedOrCharging()` read `state === 8 || state === 100 ||
// !!chargeStatus`, so a non-zero charge_status was an independent sufficient
// condition — it outranked a state that positively said the robot was out
// cleaning. That contradicted the rule the same file already applies in
// getRoborockOperationalState(), which consults charge_status ONLY in its
// `default:` arm: state 5 is RUNNING no matter what charge_status says. Two
// functions, the same two fields, read at the same instant, opposite answers.
//
// The reason the pair disagrees in the field is that the two fields are not the
// same age. A sparse live frame carrying only dps 121 moves `state` and leaves
// `charge_status` untouched, and getNumberStatus() falls back to the slower
// HomeData snapshot for whatever the live frame omitted. So "state = Room
// Clean, charge_status = 1" is not a robot contradicting itself; it is one
// fresh field beside one stale one — and the old expression let the stale one
// win.
//
// Measured in issue #8 on a Saros 10 (roborock.vacuum.a144), twice out of two
// attempts on two different plugin versions. On 3.7.1 the plugin published
// operationalState=1 for eight minutes with the battery falling 100 → 97 % and
// live room tracking moving Dining room → Living room → Corridor → Bathroom,
// and still logged "despite a docked snapshot" when the run was ended from
// Apple Home. The reporter answered the "every time, or only sometimes?"
// question by reproducing it on 3.9.3.
//
// Two surfaces carried the damage, and the quiet one cost more:
//
//   1. The Docked state sensor (getHomeKitStateSensorValue("docked")) reported
//      DOCKED for a robot out on the floor — a sensor that exists to be an
//      automation trigger, lying for the whole run.
//   2. shouldRetryReturnToDock() asks isRoborockDockedOrCharging() FIRST and
//      returns false on it, before it ever reaches
//      isRoborockActivelyCleaningAwayFromDock(). So the dock-command retry was
//      permanently disarmed for exactly the robots whose charge_status lags —
//      the cloud-only ones whose commands time out, which is the population the
//      retry was written for.
//
// The existing coverage missed it for one reason worth naming: every
// away-from-the-dock row in the state-sensor table pairs its state with
// `charge_status: 0`, and the retry test uses `{ state: 5, battery: 100 }` with
// no charge_status at all. Every test asked whether the state was read
// correctly; none asked what happens when the OTHER field disagrees. This file
// enumerates the class — every state that means "away from the dock" against
// every charge_status value that means "on power" — rather than the one pairing
// that was reported.

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const RUN_MODE_CLEANING = 1;

afterEach(() => {
  jest.useRealTimers();
});

/**
 * The states isRoborockActivelyCleaningAwayFromDock() enumerates: the robot has
 * positively told us where it is, and it is not in the dock.
 */
const AWAY_FROM_DOCK_STATES = [
  { state: 4, label: "under remote control" },
  { state: 5, label: "cleaning" },
  { state: 7, label: "in manual mode" },
  { state: 10, label: "paused mid-run" },
  { state: 11, label: "spot cleaning" },
  { state: 16, label: "driving to a point" },
  { state: 17, label: "zone cleaning" },
  { state: 18, label: "room cleaning" },
  { state: 29, label: "mapping" },
];

/**
 * Every charge_status the field has produced for a robot that is NOT charging
 * right now. 1 is the ordinary leftover from the dock it just left; the larger
 * values were seen on the same account and are included because the old code
 * treated any truthy number identically, so the fix must too.
 */
const STALE_CHARGE_STATUSES = [1, 2, 102];

/** The states that genuinely mean "in the dock" — the no-regression half. */
const IN_THE_DOCK_STATES = [
  { state: 8, charge_status: 1, label: "charging in its dock" },
  { state: 100, charge_status: 0, label: "fully charged in its dock" },
  { state: 22, charge_status: 1, label: "emptying its bin in the dock" },
  { state: 23, charge_status: 1, label: "washing the mop in the dock" },
];

function createPlatform({
  status = {},
  appCharge = jest.fn().mockResolvedValue(undefined),
  getStatus = jest.fn().mockResolvedValue(undefined),
} = {}) {
  return {
    platformConfig: {
      enableMatter: true,
      enableMatterCleanMode: false,
      enableMatterPowerSource: false,
      enableMatterServiceArea: false,
    },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => ({
      updateAccessoryState: jest.fn().mockResolvedValue(undefined),
    }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Weebo" : "sn-1",
      getProductAttribute: () => "roborock.vacuum.a144",
      getVacuumDeviceStatus: (duid, property) => status[property] ?? "",
      getRoomMappingsForDevice: () => [],
      getMapListForDevice: () => [],
      getCurrentMapIdForDevice: () => null,
      getMatterCleanModeCapabilities: () => ({ canVacuum: true, canMop: true }),
      app_start: jest.fn().mockResolvedValue(undefined),
      app_stop: jest.fn().mockResolvedValue(undefined),
      app_pause: jest.fn().mockResolvedValue(undefined),
      app_charge: appCharge,
      applyMatterCleanModeSettings: jest.fn().mockResolvedValue(undefined),
      find_me: jest.fn().mockResolvedValue(undefined),
      app_segment_clean_by_ids: jest.fn().mockResolvedValue(undefined),
      load_multi_map: jest.fn().mockResolvedValue(undefined),
      getStatus,
    },
  };
}

function createVacuum(platform) {
  const accessory = { UUID: "uuid-1", context: { duid: "device-1" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-1" },
    true
  );
  return { accessory, vacuum };
}

function loggedDockedSnapshot(platform) {
  return platform.log.info.mock.calls.some((call) =>
    String(call[0]).includes("despite a docked snapshot")
  );
}

describe("a stale charging flag never outranks a robot that says it is out cleaning", () => {
  const cases = AWAY_FROM_DOCK_STATES.flatMap((robot) =>
    STALE_CHARGE_STATUSES.map((chargeStatus) => [
      robot.label,
      chargeStatus,
      robot.state,
    ])
  );

  test.each(cases)(
    "a robot %s with a leftover charge_status of %i is not docked",
    (_label, chargeStatus, state) => {
      const platform = createPlatform({
        status: { state, battery: 100, charge_status: chargeStatus },
      });
      const { vacuum } = createVacuum(platform);

      expect(vacuum.getHomeKitStateSensorValue("docked")).toBe(false);
    }
  );

  test.each(cases)(
    "docking a robot %s with a leftover charge_status of %i is not called a stale snapshot",
    async (_label, chargeStatus, state) => {
      const appCharge = jest.fn().mockResolvedValue(undefined);
      const platform = createPlatform({
        status: { state, battery: 100, charge_status: chargeStatus },
        appCharge,
      });
      const { accessory } = createVacuum(platform);

      await accessory.handlers.rvcOperationalState.goHome();

      // The command is forwarded either way — that has been true since issues
      // #4/#12 and is not what changed. What changed is that the plugin no
      // longer describes a robot it can see cleaning as a docked snapshot.
      expect(appCharge).toHaveBeenCalled();
      expect(loggedDockedSnapshot(platform)).toBe(false);
    }
  );
});

describe("the retry the reporter never got", () => {
  // This is issue #8's real cost. The first dock command times out (the
  // reporter's log shows the cloud timing out roughly once a minute, sustained,
  // with no LAN fallback because cloud-only mode is on), so the retry is
  // scheduled. It then asks whether the robot is still cleaning — and the old
  // docked check answered "it is docked" off the leftover charge_status and
  // cancelled the retry. The robot kept cleaning.
  test("retries the dock command for a cleaning robot whose charge_status still says charging", async () => {
    jest.useFakeTimers();
    const getStatus = jest.fn().mockResolvedValue(undefined);
    const appCharge = jest
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Cloud request with id 1749 with method app_charge timed out after 10 seconds. MQTT connection state: true"
        )
      )
      .mockResolvedValue(undefined);
    const platform = createPlatform({
      status: { state: 5, battery: 100, charge_status: 1 },
      appCharge,
      getStatus,
    });
    const { vacuum } = createVacuum(platform);

    await vacuum.accessory.handlers.rvcOperationalState.goHome();
    await Promise.resolve();
    await Promise.resolve();

    expect(appCharge).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(7000);
    await Promise.resolve();

    expect(appCharge).toHaveBeenCalledTimes(2);
    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Retrying Matter return to dock command")
    );

    jest.clearAllTimers();
  });
});

describe("charge_status still decides when the robot's state does not", () => {
  // The fix demotes charge_status to a tiebreaker; it does not discard it.
  // Every case here is one where the state genuinely fails to answer the
  // question, and the charging flag remains the best evidence available.
  test("a robot reporting no state at all is docked while it draws power", () => {
    const platform = createPlatform({
      status: { battery: 100, charge_status: 1 },
    });
    const { vacuum } = createVacuum(platform);

    expect(vacuum.getHomeKitStateSensorValue("docked")).toBe(true);
  });

  test("state 0 is not a Roborock state, so the charging flag answers instead", () => {
    const platform = createPlatform({
      status: { state: 0, battery: 100, charge_status: 1 },
    });
    const { vacuum } = createVacuum(platform);

    expect(vacuum.getHomeKitStateSensorValue("docked")).toBe(true);
  });

  test("a robot driving home is still deferred to the charging flag, so the dock retry stays disarmed", async () => {
    // State 6 is deliberately NOT in the away-from-dock set: a robot already
    // returning must not have its dock command re-sent, which the sibling test
    // in matter-vacuum.test.js pins. Widening the set to "not in the dock"
    // would read more consistently and would break that, so the transit states
    // keep deferring to charge_status on purpose.
    const platform = createPlatform({
      status: { state: 6, battery: 100, charge_status: 1 },
    });
    const { vacuum } = createVacuum(platform);

    expect(vacuum.getHomeKitStateSensorValue("docked")).toBe(true);
  });
});

describe("robots that really are in the dock are unaffected", () => {
  test.each(IN_THE_DOCK_STATES.map((robot) => [robot.label, robot]))(
    "a robot %s still reads as docked",
    (_label, robot) => {
      const platform = createPlatform({
        status: {
          state: robot.state,
          battery: 100,
          charge_status: robot.charge_status,
        },
      });
      const { vacuum } = createVacuum(platform);

      expect(vacuum.getHomeKitStateSensorValue("docked")).toBe(true);
    }
  );

  test("docking an already-docked robot still says the snapshot may be stale", async () => {
    const appCharge = jest.fn().mockResolvedValue(undefined);
    const platform = createPlatform({
      status: { state: 8, battery: 100, charge_status: 1 },
      appCharge,
    });
    const { accessory } = createVacuum(platform);

    await accessory.handlers.rvcOperationalState.goHome();

    expect(appCharge).toHaveBeenCalled();
    expect(loggedDockedSnapshot(platform)).toBe(true);
  });

  test("a cleaning run started from Matter is not reported as docked once optimism expires", async () => {
    // The end-to-end shape of the reporter's log: start a run, let the
    // optimistic window lapse, keep the leftover charge_status, and ask the
    // sensor. This is the assertion that would have caught the bug from his
    // transcript alone.
    jest.useFakeTimers();
    const status = { state: 8, battery: 100, charge_status: 1 };
    const platform = createPlatform({ status });
    const { vacuum } = createVacuum(platform);

    await vacuum.accessory.handlers.rvcRunMode.changeToMode({
      newMode: RUN_MODE_CLEANING,
    });
    await jest.advanceTimersByTimeAsync(0);

    // The robot confirms it is out cleaning; the dock's charging flag has not
    // been refreshed, exactly as a sparse dps 121 frame leaves it.
    status.state = 18;
    await vacuum.notifyDeviceUpdater("CloudMessage", [
      { state: 18, battery: 99 },
    ]);
    await jest.advanceTimersByTimeAsync(0);

    expect(vacuum.getHomeKitStateSensorValue("docked")).toBe(false);

    jest.clearAllTimers();
  });
});
