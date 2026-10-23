"use strict";

// SmartPlan is the Roborock app's mode where the robot picks suction, water
// and mop route per room itself. It is reported as fan power 110 and water
// 209. The prep that applies Apple Home's clean mode before a start re-sends
// the robot's current suction level, and on a SmartPlan robot that level is
// 110: `set_custom_mode 110` puts the robot back into SmartPlan, which
// overrides the water level the prep sent just before it.
//
// Measured on a Qrevo MaxV (roborock.vacuum.a87, 22 Oct 2026):
//
//   09:59:55  Applying Vacuum mode to Roborock Qrevo MaxV before starting.
//   09:59:55  ...service area clean command ... acknowledged ... via local
//   09:59:57  Matter publish ... cleanMode=0, phase=Washing mop.
//   10:00:16  get_status: fan_power 110, water_box_mode 209, mop_mode 306
//
// The rule: an explicit clean mode never carries a SmartPlan value. Vacuum
// sends a manual suction level with water off, Vacuum + Mop a manual suction
// level and a manual water level, falling back to the last manual level the
// robot was seen using, or Balanced / Mild.

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const CLEAN_MODE_VACUUM = 0;
const CLEAN_MODE_MOP = 1;
const CLEAN_MODE_VACUUM_AND_MOP = 2;

const FAN_POWER_BALANCED = 102;
const FAN_POWER_TURBO = 103;
const FAN_POWER_OFF = 105;
const FAN_POWER_SMART_PLAN = 110;

const WATER_BOX_OFF = 200;
const WATER_BOX_MILD = 201;
const WATER_BOX_HIGH = 203;
const WATER_BOX_SMART_PLAN = 209;

/** Roborock states: 8 is Charging (docked), 18 is Room Clean (running). */
const ROBOROCK_STATE_CHARGING = 8;
const ROBOROCK_STATE_ROOM_CLEAN = 18;

const CLEAN_MODE_SMART_PLAN = 8;
const RVC_CLEAN_MODE_TAG_AUTO = 0;
const RVC_CLEAN_MODE_TAG_DAY = 9;
const RVC_CLEAN_MODE_TAG_VACUUM = 16385;
const RVC_CLEAN_MODE_TAG_MOP = 16386;

function createHarness(
  initialStatus,
  { smartPlanCleanMode = false, canControlWater = true } = {}
) {
  const status = {
    state: ROBOROCK_STATE_CHARGING,
    battery: 100,
    ...initialStatus,
  };
  const applied = [];
  const platform = {
    platformConfig: {
      enableMatter: true,
      enableMatterCleanMode: true,
      enableFanPowerCleanModes: false,
      enableSmartPlanCleanMode: smartPlanCleanMode,
    },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => ({ updateAccessoryState: jest.fn() }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Qrevo MaxV" : "",
      getProductAttribute: () => "roborock.vacuum.a87",
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
        canControlWater,
      }),
      getStatus: jest.fn().mockResolvedValue(undefined),
      applyMatterCleanModeSettings: jest.fn(async (duid, settings) => {
        applied.push(settings);
      }),
      app_start: jest.fn(async () => {}),
      app_stop: jest.fn(async () => {}),
      app_pause: jest.fn(async () => {}),
      app_charge: jest.fn(async () => {}),
    },
  };

  const accessory = { UUID: "uuid-smart-plan", context: { duid: "duid-1" } };
  const instance = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "duid-1" },
    true
  );

  return {
    instance,
    applied,
    handlers: accessory.handlers,
    supportedModes: () => instance.getSupportedCleanModes(),
    cleanMode: () => instance.getCurrentCleanMode(),
    set: (patch) => Object.assign(status, patch),
  };
}

/** `dispatchRoborockMatterCommand` is fire-and-forget; let its chain settle. */
async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

async function selectAndStart(harness, cleanMode) {
  await harness.handlers.rvcCleanMode.changeToMode({ newMode: cleanMode });
  await settle();
  await harness.handlers.rvcRunMode.changeToMode({ newMode: 1 });
  await settle();
  return harness.applied[harness.applied.length - 1];
}

const SMART_PLAN = {
  fan_power: FAN_POWER_SMART_PLAN,
  water_box_mode: WATER_BOX_SMART_PLAN,
  mop_mode: 306,
};

describe("a robot in SmartPlan gets the mode Apple Home asked for", () => {
  test("Vacuum sends Balanced suction and water off, not SmartPlan", async () => {
    const harness = createHarness(SMART_PLAN);
    const settings = await selectAndStart(harness, CLEAN_MODE_VACUUM);

    expect(settings.waterBoxMode).toBe(WATER_BOX_OFF);
    expect(settings.fanPower).toBe(FAN_POWER_BALANCED);
  });

  test("Vacuum + Mop sends manual suction and a manual water level", async () => {
    const harness = createHarness(SMART_PLAN);
    const settings = await selectAndStart(harness, CLEAN_MODE_VACUUM_AND_MOP);

    expect(settings.fanPower).toBe(FAN_POWER_BALANCED);
    expect(settings.waterBoxMode).toBe(WATER_BOX_MILD);
  });

  test("Mop still sends suction off", async () => {
    const harness = createHarness(SMART_PLAN);
    const settings = await selectAndStart(harness, CLEAN_MODE_MOP);

    expect(settings.fanPower).toBe(FAN_POWER_OFF);
    expect(settings.waterBoxMode).toBe(WATER_BOX_MILD);
  });

  test("the last manual levels seen before SmartPlan are reused", async () => {
    const harness = createHarness({
      fan_power: FAN_POWER_TURBO,
      water_box_mode: WATER_BOX_HIGH,
    });
    // One apply while manual teaches the plugin the user's levels.
    await selectAndStart(harness, CLEAN_MODE_VACUUM_AND_MOP);

    harness.set(SMART_PLAN);
    const settings = await selectAndStart(harness, CLEAN_MODE_VACUUM_AND_MOP);

    expect(settings.fanPower).toBe(FAN_POWER_TURBO);
    expect(settings.waterBoxMode).toBe(WATER_BOX_HIGH);
  });

  test("a manual robot is unchanged: its own levels are re-sent", async () => {
    const harness = createHarness({
      fan_power: FAN_POWER_TURBO,
      water_box_mode: WATER_BOX_HIGH,
    });
    const settings = await selectAndStart(harness, CLEAN_MODE_VACUUM);

    expect(settings.fanPower).toBe(FAN_POWER_TURBO);
    expect(settings.waterBoxMode).toBe(WATER_BOX_OFF);
  });
});

describe("SmartPlan as a clean mode of its own (enableSmartPlanCleanMode)", () => {
  test("it is off by default, and a SmartPlan run reads as Vacuum + Mop", () => {
    const harness = createHarness({
      ...SMART_PLAN,
      state: ROBOROCK_STATE_ROOM_CLEAN,
    });

    expect(harness.supportedModes().map((m) => m.mode)).not.toContain(
      CLEAN_MODE_SMART_PLAN
    );
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM_AND_MOP);
  });

  test("enabled, it is announced as Vacuum + Mop + Auto", () => {
    const harness = createHarness({}, { smartPlanCleanMode: true });
    const smartPlan = harness
      .supportedModes()
      .find((m) => m.mode === CLEAN_MODE_SMART_PLAN);

    expect(smartPlan.label).toBe("SmartPlan");
    expect(smartPlan.modeTags.map((tag) => tag.value)).toEqual([
      RVC_CLEAN_MODE_TAG_VACUUM,
      RVC_CLEAN_MODE_TAG_MOP,
      RVC_CLEAN_MODE_TAG_AUTO,
    ]);
  });

  test("enabled, plain Vacuum + Mop is tagged Day so the two look different", () => {
    const harness = createHarness({}, { smartPlanCleanMode: true });
    const vacuumAndMop = harness
      .supportedModes()
      .find((m) => m.mode === CLEAN_MODE_VACUUM_AND_MOP);

    expect(vacuumAndMop.modeTags.map((tag) => tag.value)).toEqual([
      RVC_CLEAN_MODE_TAG_VACUUM,
      RVC_CLEAN_MODE_TAG_MOP,
      RVC_CLEAN_MODE_TAG_DAY,
    ]);
  });

  test("disabled, plain Vacuum + Mop keeps exactly the tags it shipped with", () => {
    const harness = createHarness({});
    const vacuumAndMop = harness
      .supportedModes()
      .find((m) => m.mode === CLEAN_MODE_VACUUM_AND_MOP);

    expect(vacuumAndMop.modeTags.map((tag) => tag.value)).toEqual([
      RVC_CLEAN_MODE_TAG_VACUUM,
      RVC_CLEAN_MODE_TAG_MOP,
    ]);
  });

  test("it is not announced for a robot without water control (Q7)", () => {
    const harness = createHarness(
      {},
      { smartPlanCleanMode: true, canControlWater: false }
    );

    expect(harness.supportedModes().map((m) => m.mode)).not.toContain(
      CLEAN_MODE_SMART_PLAN
    );
  });

  test("starting in SmartPlan sends fan power 110 and no water level", async () => {
    const harness = createHarness(
      { fan_power: FAN_POWER_TURBO, water_box_mode: WATER_BOX_HIGH },
      { smartPlanCleanMode: true }
    );
    const settings = await selectAndStart(harness, CLEAN_MODE_SMART_PLAN);

    expect(settings.fanPower).toBe(FAN_POWER_SMART_PLAN);
    expect(settings.waterBoxMode).toBeUndefined();
  });

  test("a SmartPlan run started in the Roborock app reads as SmartPlan", () => {
    const harness = createHarness(
      { ...SMART_PLAN, state: ROBOROCK_STATE_ROOM_CLEAN },
      { smartPlanCleanMode: true }
    );

    expect(harness.cleanMode()).toBe(CLEAN_MODE_SMART_PLAN);
  });

  test("Vacuum from SmartPlan still leaves it, with the mode announced", async () => {
    const harness = createHarness(SMART_PLAN, { smartPlanCleanMode: true });
    const settings = await selectAndStart(harness, CLEAN_MODE_VACUUM);

    expect(settings.fanPower).toBe(FAN_POWER_BALANCED);
    expect(settings.waterBoxMode).toBe(WATER_BOX_OFF);
  });
});
