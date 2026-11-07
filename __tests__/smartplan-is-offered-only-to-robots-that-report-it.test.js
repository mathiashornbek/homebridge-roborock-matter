"use strict";

// SmartPlan is offered by the robot, not inferred from mop + suction + water:
// every classic mopping robot has those, and the option is platform-wide, so
// an S7 on the same account as a Qrevo MaxV would have been offered a mode
// that sends `set_custom_mode 110`. python-roborock's rule is the robot's
// `newFeatureSet` bit 55 (SMART_CLEAN_MODE_SET), and not bit 106
// (WATER_SLIDE_MODE, whose water levels have no SmartPlan value). Bit N is bit
// N % 4 of the hex digit N / 4 places from the right.

const fs = require("fs");
const os = require("os");
const path = require("path");

const { supportsSmartPlan } = require("../roborockLib/lib/deviceFeatures");
const { Roborock } = require("../roborockLib/roborockAPI");

/** A Qrevo MaxV (roborock.vacuum.a87), from its HomeData on 7 Nov 2026. */
const QREVO_MAXV = "508A977F7EFEFFFF";

/** The same robot with bit 55 cleared: hex digit 14 from the right, 8 -> 0. */
const WITHOUT_SMART_PLAN = "500A977F7EFEFFFF";
/** The same robot with bit 106 set: hex digit 27 from the right gets 4. */
const WATER_SLIDE = "4" + "0".repeat(10) + QREVO_MAXV;

describe("SmartPlan support is read from the robot's feature string", () => {
  test("a Qrevo MaxV reports it", () => {
    expect(supportsSmartPlan(QREVO_MAXV)).toBe(true);
  });

  test("without bit 55 it is not offered", () => {
    expect(supportsSmartPlan(WITHOUT_SMART_PLAN)).toBe(false);
  });

  test("a water-slide robot does not get it even with bit 55", () => {
    expect(supportsSmartPlan(WATER_SLIDE)).toBe(false);
  });

  test.each([undefined, null, "", "FFFF", "not hex at all!"])(
    "no usable feature string (%p) means no SmartPlan",
    (featuresStr) => {
      expect(supportsSmartPlan(featuresStr)).toBe(false);
    }
  );
});

describe("the clean-mode capabilities carry it", () => {
  function createApi(featuresStr) {
    const api = new Roborock({
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "roborock-smart-")),
    });
    api.isB01Device = () => false;
    api.hasVacuumSchemaCode = () => true;
    api.hasVacuumFeature = () => true;
    api.getVacuumDeviceStatus = () => "";
    api.getProductAttribute = () => "roborock.vacuum.a87";
    api.vacuums = { duid: { features: { featuresStr } } };
    return api;
  }

  test("from the robot's own feature string", () => {
    expect(
      createApi(QREVO_MAXV).getMatterCleanModeCapabilities("duid").canSmartPlan
    ).toBe(true);
    expect(
      createApi(WITHOUT_SMART_PLAN).getMatterCleanModeCapabilities("duid")
        .canSmartPlan
    ).toBe(false);
  });
});
