"use strict";

// Apple Home does not draw `operationalError` as a passive warning. It draws
// WaterTankEmpty (68) as a BLOCKING condition, and it says so in words —
// vp-debug12's screenshot in issue #9, Spanish locale, 21 Aug 2026:
//
//   "Rellena el depósito de agua
//    'Roborock Qrevo' empezará a limpiar cuando se llene el depósito de agua."
//
//   ("Fill the water tank. 'Roborock Qrevo' will start cleaning once the water
//    tank is filled.")
//
// It is a push notification, not just a tile decoration — Wazza151 confirmed
// the same on an a70 in #5 — and it arrived over and over while his robot was
// set to VACUUM. For a vacuum-only run every word of it is false: the robot is
// not waiting for water, it will not start cleaning when the tank is filled,
// and it needs nothing from the user. So this is not a preference about when a
// warning is welcome. The plugin was asserting a blocking condition that did
// not exist.
//
// THE RULE THIS FILE ENUMERATES:
//
//   The Matter fault is published only when water is actually in play. An
//   empty tank on a vacuum-only run publishes NoError, because "no water" is
//   not a fault for a robot that was not going to use water.
//
// And the half that must not move with it: "vacuum-only" has to be something
// that was SAID, by the user or by the robot. `selectedCleanMode` starts at
// Vacuum on every restart and is not persisted (measured 20 Aug), so treating
// its default as a choice would silence the tank warning for every robot until
// somebody happened to touch the mode picker — which would quietly undo the
// one field-verified thing this attribute does.
//
// The HAP `Water Tank Empty` contact sensor is deliberately NOT gated by any
// of this. It is a statement of fact about the tank, it carries no claim about
// what the robot is going to do, and automations are built on it. Only the
// Matter fault makes the blocking claim, so only the Matter fault is gated.

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const RVC_ERROR_NONE = 0;
const RVC_ERROR_WATER_TANK_EMPTY = 68;
const RVC_ERROR_DUST_BIN_FULL = 67;

const CLEAN_MODE_VACUUM = 0;
const CLEAN_MODE_MOP = 1;
const CLEAN_MODE_VACUUM_AND_MOP = 2;
const CLEAN_MODE_VACUUM_MAX = 6;

const FAN_POWER_MAX = 104;
const FAN_POWER_OFF = 105;
const WATER_BOX_OFF = 200;
const WATER_BOX_ON = 201;

const ROBOROCK_STATE_CHARGING = 8;
const ROBOROCK_STATE_CLEANING = 5;

/** The tank as the a75 in #9 reports it: both fields set. */
const TANK_EMPTY = { dock_error_status: 38, water_shortage_status: 1 };

function harness({ initialStatus = {}, cleanMode = true } = {}) {
  const status = {
    state: ROBOROCK_STATE_CHARGING,
    battery: 100,
    error_code: 0,
    ...initialStatus,
  };
  const matterUpdates = [];
  const platform = {
    platformConfig: {
      enableMatter: true,
      enableMatterCleanMode: cleanMode,
      enableFanPowerCleanModes: true,
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
        property === "name" ? "Qrevo" : "",
      getProductAttribute: () => "roborock.vacuum.a75",
      getVacuumDeviceStatus: (duid, property) => {
        const value = status[property];
        return value === null || value === undefined ? "" : value;
      },
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
      applyMatterCleanModeSettings: jest.fn().mockResolvedValue(undefined),
      app_start: jest.fn().mockResolvedValue(undefined),
      app_stop: jest.fn().mockResolvedValue(undefined),
      app_pause: jest.fn().mockResolvedValue(undefined),
      app_charge: jest.fn().mockResolvedValue(undefined),
    },
  };

  const accessory = { UUID: "uuid-tank-mode", context: { duid: "duid-1" } };
  const instance = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "duid-1" },
    true
  );

  return {
    instance,
    platform,
    handlers: accessory.handlers,
    set: (patch) => Object.assign(status, patch),
    /** Publish a snapshot and return the fault that went out with it. */
    fault: async () => {
      await instance.updateMatterStateFromRoborock("test");
      for (let i = matterUpdates.length - 1; i >= 0; i -= 1) {
        if (matterUpdates[i].cluster === "rvcOperationalState") {
          return matterUpdates[i].attributes.operationalError;
        }
      }
      return undefined;
    },
    lines: () =>
      platform.log.info.mock.calls
        .concat(platform.log.debug.mock.calls)
        .map((call) => String(call[0]))
        .filter((line) => line.includes("Matter publish for")),
  };
}

/** Pick a mode on the tile, the way Apple Home does. */
async function select(test, mode) {
  await test.handlers.rvcCleanMode.changeToMode({ newMode: mode });
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

describe("an empty tank blocks nothing on a vacuum-only run", () => {
  test("a user who picked Vacuum on the tile is not told to fill the tank", async () => {
    const test = harness({ initialStatus: TANK_EMPTY });

    await select(test, CLEAN_MODE_VACUUM);

    expect(await test.fault()).toEqual({ errorStateId: RVC_ERROR_NONE });
  });

  test("a suction level is still a vacuum-only mode", async () => {
    // Max Vacuum is a vacuum-family variant with a pinned fan power, not a
    // separate clean type. Reducing it to its base type is what keeps this
    // rule from having 5 more cases.
    const test = harness({
      initialStatus: { ...TANK_EMPTY, fan_power: FAN_POWER_MAX },
    });

    await select(test, CLEAN_MODE_VACUUM_MAX);

    expect(await test.fault()).toEqual({ errorStateId: RVC_ERROR_NONE });
  });

  test("picking Mop brings the warning straight back", async () => {
    const test = harness({ initialStatus: TANK_EMPTY });

    await select(test, CLEAN_MODE_MOP);

    expect(await test.fault()).toEqual({
      errorStateId: RVC_ERROR_WATER_TANK_EMPTY,
    });
  });

  test("Vacuum + Mop keeps it too", async () => {
    const test = harness({ initialStatus: TANK_EMPTY });

    await select(test, CLEAN_MODE_VACUUM_AND_MOP);

    expect(await test.fault()).toEqual({
      errorStateId: RVC_ERROR_WATER_TANK_EMPTY,
    });
  });

  test("switching from Mop to Vacuum clears a warning already drawn", async () => {
    // The half that stops the notifications rather than merely not starting
    // them. Going quiet here would leave 68 standing in the store, and Apple
    // keeps notifying about a blocking condition for as long as it stands.
    const test = harness({ initialStatus: TANK_EMPTY });

    await select(test, CLEAN_MODE_MOP);
    expect(await test.fault()).toEqual({
      errorStateId: RVC_ERROR_WATER_TANK_EMPTY,
    });

    await select(test, CLEAN_MODE_VACUUM);
    expect(await test.fault()).toEqual({ errorStateId: RVC_ERROR_NONE });
  });

  test("the robot's own report counts during a run with no live mode command", async () => {
    // A run started in the Roborock app carries its own clean type. Fan power
    // off is the mop-only signature, so this robot is mopping with no water.
    const test = harness({
      initialStatus: {
        ...TANK_EMPTY,
        state: ROBOROCK_STATE_CLEANING,
        fan_power: FAN_POWER_OFF,
        water_box_mode: WATER_BOX_ON,
      },
    });

    expect(await test.fault()).toEqual({
      errorStateId: RVC_ERROR_WATER_TANK_EMPTY,
    });
  });

  test("an acknowledged live Vacuum change outranks a lagging mop report", async () => {
    // The robot has accepted the live change, but its cached status can still
    // describe the mode that was running immediately before it. During that
    // confirmation window the acknowledged command is the stronger evidence.
    const test = harness({
      initialStatus: {
        ...TANK_EMPTY,
        state: ROBOROCK_STATE_CLEANING,
        fan_power: FAN_POWER_OFF,
        water_box_mode: WATER_BOX_ON,
      },
    });

    await select(test, CLEAN_MODE_VACUUM);

    expect(await test.fault()).toEqual({ errorStateId: RVC_ERROR_NONE });
  });

  test("a robot cleaning with its water off gets no tank fault", async () => {
    const test = harness({
      initialStatus: {
        ...TANK_EMPTY,
        state: ROBOROCK_STATE_CLEANING,
        fan_power: FAN_POWER_MAX,
        water_box_mode: WATER_BOX_OFF,
      },
    });

    expect(await test.fault()).toEqual({ errorStateId: RVC_ERROR_NONE });
  });

  test("nobody has said anything, so the warning stands", async () => {
    // THE LOAD-BEARING CASE. `selectedCleanMode` is Vacuum on every restart
    // and that default is not a choice. Wazza151's field-verified warning
    // arrived on a robot nobody had touched the mode picker on, and it has to
    // keep arriving.
    const test = harness({ initialStatus: TANK_EMPTY });

    expect(await test.fault()).toEqual({
      errorStateId: RVC_ERROR_WATER_TANK_EMPTY,
    });
  });

  test("a robot with no water control at all keeps the warning", async () => {
    // Nothing can be derived about water use, so nothing is claimed. Silence
    // here would be a guess dressed as a fact.
    const test = harness({
      initialStatus: { ...TANK_EMPTY, fan_power: FAN_POWER_MAX },
      cleanMode: false,
    });

    expect(await test.fault()).toEqual({
      errorStateId: RVC_ERROR_WATER_TANK_EMPTY,
    });
  });

  test("a real robot fault is not swallowed along with the tank", async () => {
    // The tank normally outranks the robot's own error. Once the tank is out
    // of the way the robot's fault has to take its place rather than be
    // replaced by a cheerful NoError. 254 is Roborock's "dust bin full".
    const test = harness({
      initialStatus: { ...TANK_EMPTY, error_code: 254 },
    });

    await select(test, CLEAN_MODE_VACUUM);

    expect(await test.fault()).toEqual({
      errorStateId: RVC_ERROR_DUST_BIN_FULL,
    });
  });

  test("the publish line stops claiming a fault it no longer sends", async () => {
    const test = harness({ initialStatus: TANK_EMPTY });

    await select(test, CLEAN_MODE_VACUUM);
    await test.fault();

    const lines = test.lines();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[lines.length - 1]).not.toContain("fault=68");
  });

  test("the HAP sensor still reports the tank, gate or no gate", async () => {
    // The sensor states a fact about the tank and makes no claim about what
    // the robot is going to do. Gating it would break automations built on
    // it, and it is not what notifies anybody.
    const test = harness({ initialStatus: TANK_EMPTY });

    await select(test, CLEAN_MODE_VACUUM);

    expect(test.instance.getHomeKitStateSensorValue("waterTankEmpty")).toBe(
      true
    );
  });
});
