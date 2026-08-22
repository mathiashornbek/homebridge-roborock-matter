"use strict";

// deviceFeatures used to record capability detection in module-level tables
// that every instance shared. createDevices() sets the robots up one after
// another through that single module, so robot N inherited everything robots
// 1..N-1 had switched on: an S4 Max that followed an S8 Pro Ultra was handed
// app_start_collect_dust and the rest of the auto-empty dock commands it has
// no hardware for. It is not only a setup-time concern either — vacuum.js
// asks hasDeviceStatusAttribute()/getStatusDivider() on every get_status
// poll, so the polluted tables also decided how an untouched robot handled
// its runtime attributes.
//
// Every assertion below therefore has to hold whatever order the robots are
// set up in, which is why the tests run the same pair both ways round.

const S8_PRO_ULTRA = "roborock.vacuum.a70";
const S4_MAX = "roborock.vacuum.a19";
const S6 = "roborock.vacuum.s6";

// Bit 25 gates isDustCollectionSettingSupported and bit 37 gates
// isWashThenChargeCmdSupported — the two probes that switch on the dock
// commands. The S4 Max and the S6 are given an empty feature set: neither has
// an auto-empty or wash dock.
const DOCK_FEATURE_SET = Math.pow(2, 37) + Math.pow(2, 25);
const NO_DOCK_FEATURE_SET = 0;

const DUST_COLLECTION_COMMANDS = [
  "app_start_collect_dust",
  "app_stop_collect_dust",
  "set_dust_collection_switch_status",
  "set_dust_collection_mode",
];
const WASH_COMMANDS = [
  "app_start_wash",
  "app_stop_wash",
  "set_wash_towel_mode",
  "set_smart_wash_params",
];
const DOCK_DEVICE_STATES = [
  "wash_phase",
  "wash_ready",
  "wash_status",
  "back_type",
];
const BASELINE_RESET_CONSUMABLES = [
  "main_brush_work_time",
  "side_brush_work_time",
  "filter_work_time",
  "filter_element_work_time",
  "sensor_dirty_time",
  "dust_collection_work_times",
];

// A harness owns a private copy of the module so one test's robots can never
// be the reason another test's robot looks polluted.
function createHarness() {
  let deviceFeatures;
  jest.isolateModules(() => {
    deviceFeatures =
      require("../roborockLib/lib/deviceFeatures").deviceFeatures;
  });

  const models = {};
  const created = {};

  const bucket = (duid) => {
    if (!created[duid]) {
      created[duid] = {
        commands: [],
        deviceStatus: [],
        consumables: [],
        resetConsumables: [],
        cleaningRecords: [],
        cleaningInfo: [],
      };
    }
    return created[duid];
  };

  const adapter = {
    config: { hostname_ip: "127.0.0.1" },
    translations: {},
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    // Anything but "B01" keeps the v1 per-model path in play.
    getVacuumDeviceInfo: jest.fn(() => "1.0"),
    getProductAttribute: jest.fn((duid, attribute) =>
      attribute === "category" ? "robot.vacuum.cleaner" : models[duid]
    ),
    createBaseRobotObjects: jest.fn(async () => undefined),
    createCommand: jest.fn(async (duid, command) => {
      bucket(duid).commands.push(command);
    }),
    createDeviceStatus: jest.fn(async (duid, state) => {
      bucket(duid).deviceStatus.push(state);
    }),
    createConsumable: jest.fn(async (duid, consumable) => {
      bucket(duid).consumables.push(consumable);
    }),
    createResetConsumables: jest.fn(async (duid, name) => {
      bucket(duid).resetConsumables.push(name);
    }),
    createCleaningRecord: jest.fn(async (duid, record) => {
      bucket(duid).cleaningRecords.push(record);
    }),
    createCleaningInfo: jest.fn(async (duid, key) => {
      bucket(duid).cleaningInfo.push(key);
    }),
    setObjectAsync: jest.fn(async () => undefined),
  };

  // Construct a robot's deviceFeatures without running detection on it.
  function build(duid, model, featureSet) {
    models[duid] = model;
    return new deviceFeatures(adapter, featureSet, "0", duid);
  }

  async function setUp(duid, model, featureSet) {
    const features = build(duid, model, featureSet);
    bucket(duid);
    await features.processSupportedFeatures();
    return features;
  }

  return { adapter, created, build, setUp };
}

describe("per-robot capability isolation", () => {
  test("a live S7 auto-empty dock updates the public capability report", () => {
    const harness = createHarness();
    const s7 = harness.build(
      "duid-s7",
      "roborock.vacuum.a15",
      NO_DOCK_FEATURE_SET
    );

    expect(s7.getFeatureList().isDustCollectionSettingSupported).toBe(false);

    s7.processDockType(1);

    expect(s7.getFeatureList().isDustCollectionSettingSupported).toBe(true);
  });

  test("an S4 Max set up after an S8 Pro Ultra gets none of the dock capabilities", async () => {
    const harness = createHarness();
    await harness.setUp("duid-s8", S8_PRO_ULTRA, DOCK_FEATURE_SET);
    await harness.setUp("duid-s4", S4_MAX, NO_DOCK_FEATURE_SET);

    const s4 = harness.created["duid-s4"];
    for (const command of [...DUST_COLLECTION_COMMANDS, ...WASH_COMMANDS]) {
      expect(s4.commands).not.toContain(command);
    }
    for (const state of DOCK_DEVICE_STATES) {
      expect(s4.deviceStatus).not.toContain(state);
    }
    // The S4 Max is on none of the model allowlists behind these, so they can
    // only ever arrive from the robot ahead of it in the setup loop.
    for (const state of [
      "water_box_carriage_status",
      "carpet_mode",
      "carpet_clean_mode",
      "mop_forbidden_enable",
      "map_flag",
      "charge_status",
    ]) {
      expect(s4.deviceStatus).not.toContain(state);
    }

    // Positive control: the S4 Max still gets its own baseline objects.
    expect(s4.commands).toEqual(
      expect.arrayContaining(["app_start", "app_stop"])
    );
    expect(s4.deviceStatus).toEqual(
      expect.arrayContaining(["battery", "state"])
    );
  });

  test("setup order changes nothing for either robot", async () => {
    const forwards = createHarness();
    await forwards.setUp("duid-s8", S8_PRO_ULTRA, DOCK_FEATURE_SET);
    await forwards.setUp("duid-s4", S4_MAX, NO_DOCK_FEATURE_SET);

    const backwards = createHarness();
    await backwards.setUp("duid-s4", S4_MAX, NO_DOCK_FEATURE_SET);
    await backwards.setUp("duid-s8", S8_PRO_ULTRA, DOCK_FEATURE_SET);

    // Same robot, same objects — down to the order they are created in.
    expect(backwards.created["duid-s4"]).toEqual(forwards.created["duid-s4"]);
    expect(backwards.created["duid-s8"]).toEqual(forwards.created["duid-s8"]);

    // ...and isolating the tables must not have cost the S8 Pro Ultra the
    // dock commands it genuinely has.
    for (const command of [...DUST_COLLECTION_COMMANDS, ...WASH_COMMANDS]) {
      expect(forwards.created["duid-s8"].commands).toContain(command);
      expect(backwards.created["duid-s8"].commands).toContain(command);
    }
    for (const state of DOCK_DEVICE_STATES) {
      expect(forwards.created["duid-s8"].deviceStatus).toContain(state);
      expect(backwards.created["duid-s8"].deviceStatus).toContain(state);
    }
  });

  test("a later robot does not inherit the dock robot's consumables or cleaning records", async () => {
    // The S6 is the interesting follower here: it is one of the few models on
    // the string consumables/cleaning-records tables, which are exactly the
    // tables the wash-dock probes and the per-model actions write into.
    const harness = createHarness();
    await harness.setUp("duid-s8", S8_PRO_ULTRA, DOCK_FEATURE_SET);
    await harness.setUp("duid-s6", S6, NO_DOCK_FEATURE_SET);

    const s6 = harness.created["duid-s6"];
    for (const consumable of [
      "strainer_work_times",
      "cleaning_brush_work_times",
    ]) {
      expect(s6.consumables).not.toContain(consumable);
    }
    for (const record of ["map_flag", "wash_count"]) {
      expect(s6.cleaningRecords).not.toContain(record);
    }

    // Positive control: its own string-table entries are all still created.
    expect(s6.consumables).toEqual(
      expect.arrayContaining(["main_brush_life", "filter_life"])
    );
    expect(s6.cleaningRecords).toEqual(
      expect.arrayContaining(["begin", "end", "duration"])
    );
  });

  test("resetConsumables does not accumulate duplicates across robots", async () => {
    const harness = createHarness();
    await harness.setUp("duid-s8-a", S8_PRO_ULTRA, DOCK_FEATURE_SET);
    await harness.setUp("duid-s8-b", S8_PRO_ULTRA, DOCK_FEATURE_SET);
    await harness.setUp("duid-s4", S4_MAX, NO_DOCK_FEATURE_SET);

    for (const duid of ["duid-s8-a", "duid-s8-b", "duid-s4"]) {
      const list = harness.created[duid].resetConsumables;
      expect(list).toEqual([...new Set(list)]);
    }

    // Two identical robots must end up with an identical reset list.
    expect(harness.created["duid-s8-b"].resetConsumables).toEqual(
      harness.created["duid-s8-a"].resetConsumables
    );
    expect(harness.created["duid-s8-a"].resetConsumables).toEqual([
      ...BASELINE_RESET_CONSUMABLES,
      "strainer_work_times",
      "cleaning_brush_work_times",
    ]);
    // The S4 Max has no wash dock, so it gets the bare baseline.
    expect(harness.created["duid-s4"].resetConsumables).toEqual(
      BASELINE_RESET_CONSUMABLES
    );
  });

  test("the module-level baselines survive a full setup pass", async () => {
    const harness = createHarness();
    await harness.setUp("duid-s8", S8_PRO_ULTRA, DOCK_FEATURE_SET);
    await harness.setUp("duid-s4", S4_MAX, NO_DOCK_FEATURE_SET);

    // A robot that has not been through detection yet sees the baselines and
    // nothing else. vacuum.js calls both of these on every get_status poll,
    // so a baseline the earlier robots had written into would silently change
    // how this one classifies its own status attributes.
    const untouched = harness.build("duid-new", S4_MAX, NO_DOCK_FEATURE_SET);
    for (const attribute of [
      ...DOCK_DEVICE_STATES,
      "dry_status",
      "carpet_mode",
      "water_box_carriage_status",
      "map_flag",
      "charge_status",
      "clean_percent",
    ]) {
      expect(untouched.hasDeviceStatusAttribute(attribute)).toBe(false);
    }

    // Positive control: the pristine baseline itself is intact.
    expect(untouched.hasDeviceStatusAttribute("battery")).toBe(true);
    expect(untouched.hasDeviceStatusAttribute("dock_type")).toBe(true);
    expect(untouched.getStatusDivider("clean_area")).toBe(1000000);
    expect(untouched.getStatusDivider("battery")).toBe(false);
  });
});
