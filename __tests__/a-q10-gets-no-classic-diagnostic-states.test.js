"use strict";

/**
 * A Q10 (`roborock.vacuum.ss07`, B01) is not set up as a classic Saros 10.
 *
 * The per-model tables listed ss07 beside the Saros 10 (a147/a140/...), so a
 * Q10 ran the Saros 10 action set and got classic diagnostic states (dss, rss,
 * kct, ...) its dialect never sends; ss07 is the Q10 S5, a different
 * protocol. A B01 robot's states come from its own adapter.
 */

const { deviceFeatures } = require("../roborockLib/lib/deviceFeatures");

function setUp(model) {
  const statuses = [];
  const adapter = {
    config: {},
    translations: {},
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getVacuumDeviceInfo: jest.fn((duid, key) => (key === "pv" ? "B01" : "")),
    getProductAttribute: jest.fn((duid, attribute) =>
      attribute === "category" ? "robot.vacuum.cleaner" : model
    ),
    createBaseRobotObjects: jest.fn(async () => undefined),
    createCommand: jest.fn(async () => undefined),
    createDeviceStatus: jest.fn(async (duid, state) => statuses.push(state)),
    createConsumable: jest.fn(async () => undefined),
    createResetConsumables: jest.fn(async () => undefined),
    createCleaningRecord: jest.fn(async () => undefined),
    createCleaningInfo: jest.fn(async () => undefined),
    setObjectAsync: jest.fn(async () => undefined),
  };
  return {
    statuses,
    adapter,
    features: new deviceFeatures(adapter, "0", "0", "duid-q10"),
  };
}

describe("a Q10 is not a Saros 10", () => {
  test("it gets none of the Saros 10 diagnostic states", async () => {
    const { statuses, features, adapter } = setUp("roborock.vacuum.ss07");
    await features.processSupportedFeatures();

    for (const state of ["dss", "rss", "kct", "in_warmup", "last_clean_t"]) {
      expect(statuses).not.toContain(state);
    }
    expect(
      adapter.log.debug.mock.calls.some(([line]) =>
        String(line).includes("using the B01 adapter feature set")
      )
    ).toBe(true);
  });

  test("a real Saros 10 still gets them", async () => {
    const { statuses, features, adapter } = setUp("roborock.vacuum.a147");
    adapter.getVacuumDeviceInfo = jest.fn(() => "1.0");
    await features.processSupportedFeatures();
    expect(statuses).toContain("dss");
  });

  test("no classic capability list names it", () => {
    const { features } = setUp("roborock.vacuum.ss07");
    const list = features.getFeatureList();
    for (const feature of [
      "isMopForbiddenSupported",
      "isShakeMopStrengthSupported",
      "isWaterBoxSupported",
      "isAvoidCarpetSupported",
    ]) {
      expect(Boolean(list[feature])).toBe(false);
    }
  });
});
