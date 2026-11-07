"use strict";

// SmartPlan and Custom are the Roborock app's modes in which the robot, not
// the user, sets suction, water and mop route per room. Each is a mode, and
// any one of its three values means the robot is in it:
//
//   SmartPlan  fan 110 or water 209 or mop route 306
//   Custom     fan 106 or water 204 or mop route 302
//
// (python-roborock's `is_smart_mode_set` and `is_mode_customized`). The other
// two values can look like ordinary levels: a Qrevo MaxV (a87) in SmartPlan
// reported fan 110, water 202, mop route 306 on 7 Nov 2026.
//
// The prep before a start re-sent the robot's current levels, and re-sending
// one of these values re-enters the mode. Measured on the same robot
// (22 Oct 2026): Vacuum sent water 200 then fan 110, the robot went back into
// SmartPlan, and the dock washed the mop two seconds later.
//
// The rule: while the robot chooses its own levels, none of its three values
// is re-sent or remembered as the user's. An explicit mode sends the last
// manual levels the robot was seen using, or Balanced / Mild, and moves the
// mop route back to Standard (300).

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const CLEAN_MODE_VACUUM = 0;
const CLEAN_MODE_MOP = 1;
const CLEAN_MODE_VACUUM_AND_MOP = 2;

const FAN_POWER_BALANCED = 102;
const FAN_POWER_TURBO = 103;
const FAN_POWER_OFF = 105;

const WATER_BOX_OFF = 200;
const WATER_BOX_MILD = 201;
const WATER_BOX_HIGH = 203;

const MOP_ROUTE_STANDARD = 300;
const MOP_ROUTE_DEEP = 301;

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
  config = {},
  { canSmartPlan = true, prepResult } = {}
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
      // enableFanPowerCleanModes is left at its shipped default, on.
      ...config,
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
        canControlWater: true,
        canSmartPlan,
      }),
      getStatus: jest.fn().mockResolvedValue(undefined),
      applyMatterCleanModeSettings: jest.fn(async (duid, settings) => {
        applied.push(settings);
        return prepResult;
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
    supportedModes: () => instance.getSupportedCleanModes().map((m) => m.mode),
    tagsOf: (mode) =>
      instance
        .getSupportedCleanModes()
        .find((m) => m.mode === mode)
        .modeTags.map((tag) => tag.value),
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

/** The a87 in SmartPlan, as measured on 7 Nov 2026. */
const SMART_PLAN = { fan_power: 110, water_box_mode: 202, mop_mode: 306 };
const CUSTOM = { fan_power: 106, water_box_mode: 204, mop_mode: 302 };
/** The value of each field that alone marks the mode. */
const SMART_PLAN_MARKERS = {
  fan_power: 110,
  water_box_mode: 209,
  mop_mode: 306,
};
const UNREADABLE = { fan_power: null, water_box_mode: null, mop_mode: null };

describe.each([
  ["SmartPlan", SMART_PLAN, SMART_PLAN_MARKERS],
  ["Custom", CUSTOM, CUSTOM],
])(
  "a robot in %s gets the mode Apple Home asked for",
  (_, robotMode, markers) => {
    test.each([
      ["suction levels on (the shipped default)", {}],
      ["suction levels off", { enableFanPowerCleanModes: false }],
    ])(
      "Vacuum sends Balanced suction, water off and the Standard route, %s",
      async (_, config) => {
        const harness = createHarness(robotMode, config);
        const settings = await selectAndStart(harness, CLEAN_MODE_VACUUM);

        expect(settings.fanPower).toBe(FAN_POWER_BALANCED);
        expect(settings.waterBoxMode).toBe(WATER_BOX_OFF);
        expect(settings.mopRoute).toBe(MOP_ROUTE_STANDARD);
      }
    );

    test("Vacuum + Mop sends Balanced and Mild, and remembers none of the robot's own levels", async () => {
      const harness = createHarness(robotMode);
      const settings = await selectAndStart(harness, CLEAN_MODE_VACUUM_AND_MOP);

      expect(settings.fanPower).toBe(FAN_POWER_BALANCED);
      expect(settings.waterBoxMode).toBe(WATER_BOX_MILD);
      expect(settings.mopRoute).toBe(MOP_ROUTE_STANDARD);

      // With nothing readable the plugin falls back to what it remembered.
      harness.set(UNREADABLE);
      const next = await selectAndStart(harness, CLEAN_MODE_VACUUM_AND_MOP);

      expect(next.fanPower).toBe(FAN_POWER_BALANCED);
      expect(next.waterBoxMode).toBe(WATER_BOX_MILD);
    });

    test("Mop still sends suction off", async () => {
      const harness = createHarness(robotMode);
      const settings = await selectAndStart(harness, CLEAN_MODE_MOP);

      expect(settings.fanPower).toBe(FAN_POWER_OFF);
      expect(settings.waterBoxMode).toBe(WATER_BOX_MILD);
    });

    test.each(Object.entries(markers))(
      "%s alone is the mode",
      async (field, value) => {
        const harness = createHarness({
          fan_power: FAN_POWER_TURBO,
          water_box_mode: WATER_BOX_HIGH,
          mop_mode: MOP_ROUTE_DEEP,
          [field]: value,
        });
        const settings = await selectAndStart(
          harness,
          CLEAN_MODE_VACUUM_AND_MOP
        );

        expect(settings.fanPower).toBe(FAN_POWER_BALANCED);
        expect(settings.waterBoxMode).toBe(WATER_BOX_MILD);
      }
    );

    test("the last manual levels seen before it are reused", async () => {
      const harness = createHarness({
        fan_power: FAN_POWER_TURBO,
        water_box_mode: WATER_BOX_HIGH,
      });
      // One apply while manual teaches the plugin the user's levels.
      await selectAndStart(harness, CLEAN_MODE_VACUUM_AND_MOP);

      harness.set(robotMode);
      const settings = await selectAndStart(harness, CLEAN_MODE_VACUUM_AND_MOP);

      expect(settings.fanPower).toBe(FAN_POWER_TURBO);
      expect(settings.waterBoxMode).toBe(WATER_BOX_HIGH);
    });
  }
);

describe("a robot on manual levels is unchanged", () => {
  test("its own levels are re-sent", async () => {
    const harness = createHarness({
      fan_power: FAN_POWER_TURBO,
      water_box_mode: WATER_BOX_HIGH,
    });
    const settings = await selectAndStart(harness, CLEAN_MODE_VACUUM);

    expect(settings.fanPower).toBe(FAN_POWER_TURBO);
    expect(settings.waterBoxMode).toBe(WATER_BOX_OFF);
  });

  test("a mop route the user chose is left alone", async () => {
    const harness = createHarness({
      fan_power: FAN_POWER_TURBO,
      water_box_mode: WATER_BOX_HIGH,
      mop_mode: MOP_ROUTE_DEEP,
    });
    const settings = await selectAndStart(harness, CLEAN_MODE_VACUUM_AND_MOP);

    expect(settings).not.toHaveProperty("mopRoute");
  });

  test("a robot that reports no mop route is never sent one", async () => {
    const harness = createHarness({ fan_power: SMART_PLAN_MARKERS.fan_power });
    const settings = await selectAndStart(harness, CLEAN_MODE_VACUUM);

    expect(settings).not.toHaveProperty("mopRoute");
  });
});

describe("SmartPlan as a clean mode of its own (enableSmartPlanCleanMode)", () => {
  const ENABLED = { enableSmartPlanCleanMode: true };
  const SHIPPED_TAGS = [RVC_CLEAN_MODE_TAG_VACUUM, RVC_CLEAN_MODE_TAG_MOP];

  test("it is off by default, and a SmartPlan run reads as Vacuum + Mop", () => {
    const harness = createHarness({
      ...SMART_PLAN,
      state: ROBOROCK_STATE_ROOM_CLEAN,
    });

    expect(harness.supportedModes()).not.toContain(CLEAN_MODE_SMART_PLAN);
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM_AND_MOP);
    // Plain Vacuum + Mop keeps exactly the tags it shipped with.
    expect(harness.tagsOf(CLEAN_MODE_VACUUM_AND_MOP)).toEqual(SHIPPED_TAGS);
  });

  test("enabled, it is announced as Vacuum + Mop + Auto", () => {
    const harness = createHarness({}, ENABLED);
    expect(harness.tagsOf(CLEAN_MODE_SMART_PLAN)).toEqual([
      RVC_CLEAN_MODE_TAG_VACUUM,
      RVC_CLEAN_MODE_TAG_MOP,
      RVC_CLEAN_MODE_TAG_AUTO,
    ]);
  });

  test("enabled, plain Vacuum + Mop is tagged Day so the two look different", () => {
    const harness = createHarness({}, ENABLED);

    expect(harness.tagsOf(CLEAN_MODE_VACUUM_AND_MOP)).toEqual([
      RVC_CLEAN_MODE_TAG_VACUUM,
      RVC_CLEAN_MODE_TAG_MOP,
      RVC_CLEAN_MODE_TAG_DAY,
    ]);
  });

  test("it is not announced for a mopping robot without SmartPlan, such as an S7", () => {
    // Mop, suction and water control all present: only the robot's own
    // SmartPlan feature bit decides.
    const harness = createHarness({}, ENABLED, { canSmartPlan: false });

    expect(harness.supportedModes()).not.toContain(CLEAN_MODE_SMART_PLAN);
    expect(harness.tagsOf(CLEAN_MODE_VACUUM_AND_MOP)).toEqual(SHIPPED_TAGS);
  });

  test("starting in SmartPlan sends fan power 110 alone", async () => {
    const harness = createHarness(
      { fan_power: FAN_POWER_TURBO, water_box_mode: WATER_BOX_HIGH },
      ENABLED
    );
    const settings = await selectAndStart(harness, CLEAN_MODE_SMART_PLAN);

    expect(settings).toEqual({
      cleanMode: CLEAN_MODE_SMART_PLAN,
      fanPower: SMART_PLAN_MARKERS.fan_power,
    });
  });

  test.each(Object.entries(SMART_PLAN_MARKERS))(
    "a run started in the Roborock app reads as SmartPlan from %s alone",
    (field, value) => {
      const harness = createHarness(
        {
          fan_power: FAN_POWER_BALANCED,
          water_box_mode: WATER_BOX_MILD,
          mop_mode: MOP_ROUTE_STANDARD,
          [field]: value,
          state: ROBOROCK_STATE_ROOM_CLEAN,
        },
        ENABLED
      );

      expect(harness.cleanMode()).toBe(CLEAN_MODE_SMART_PLAN);
    }
  );

  test("Vacuum from SmartPlan still leaves it, with the mode announced", async () => {
    const harness = createHarness(SMART_PLAN, ENABLED);
    const settings = await selectAndStart(harness, CLEAN_MODE_VACUUM);

    expect(settings.fanPower).toBe(FAN_POWER_BALANCED);
    expect(settings.waterBoxMode).toBe(WATER_BOX_OFF);
    expect(settings.mopRoute).toBe(MOP_ROUTE_STANDARD);
  });

  test("an unconfirmed SmartPlan leaves the robot's own report in charge", async () => {
    // The prep reports SmartPlan's fan command as the clean type. If it went
    // unconfirmed the robot may still be on manual levels, so Apple Home must
    // follow what the robot reports rather than hold SmartPlan.
    const harness = createHarness(
      { fan_power: FAN_POWER_BALANCED, water_box_mode: WATER_BOX_MILD },
      ENABLED,
      {
        prepResult: {
          unconfirmedSettings: ["SmartPlan"],
          cleanTypeConfirmed: false,
        },
      }
    );
    await selectAndStart(harness, CLEAN_MODE_SMART_PLAN);

    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });

    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM_AND_MOP);
  });

  test("a SmartPlan selection is not shown as the suction level the robot still reports", async () => {
    // Before the robot reports SmartPlan it still reports its manual fan
    // power, which the suction-level modes (on by default) would display.
    const harness = createHarness(
      { fan_power: FAN_POWER_BALANCED, water_box_mode: WATER_BOX_OFF },
      ENABLED
    );
    await selectAndStart(harness, CLEAN_MODE_SMART_PLAN);

    expect(harness.supportedModes()).toContain(CLEAN_MODE_SMART_PLAN);
    expect(harness.cleanMode()).toBe(CLEAN_MODE_SMART_PLAN);
  });
});
