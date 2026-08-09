"use strict";

// Every model list in getFeatureList() is meant to be evaluated against the
// robot's own model. Two of them were written as bare arrays, and an array —
// including an empty one — is truthy in JavaScript, so the
// `if (featureList[feature])` gate fired for every robot regardless of
// hardware. These tests lock the gating down per model.

const { deviceFeatures } = require("../roborockLib/lib/deviceFeatures");

function createFeatures(model, { featureSet = "0", featuresStr = "0" } = {}) {
  const adapter = {
    log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    getVacuumDeviceInfo: jest.fn(() => ""),
    getProductAttribute: jest.fn(() => model),
  };
  const features = new deviceFeatures(adapter, featureSet, featuresStr, "duid-1");
  features.robotModel = model;
  return features;
}

/** getFeatureList() reads the model from the enclosing scope in the source. */
function featureListFor(model, options) {
  const features = createFeatures(model, options);
  // The production call site is processSupportedFeatures, which resolves the
  // model through the adapter before calling getFeatureList.
  features.adapter.getProductAttribute = jest.fn(() => model);
  return features.getFeatureList();
}

describe("model-gated capabilities are not universally true", () => {
  const DRY_ONLY = [
    "roborock.vacuum.a19", // S4 Max — no water tank at all
    "roborock.vacuum.a08", // S6 Pure
  ];

  test.each(DRY_ONLY)(
    "%s is not advertised as having an electronic water box",
    (model) => {
      const list = featureListFor(model);
      // Truthiness is what the gate actually tests, so assert on that and not
      // just on the raw value.
      expect(Boolean(list.isElectronicWaterBoxSupported)).toBe(false);
    }
  );

  test("no model currently claims the electronic water box", () => {
    for (const model of [
      "roborock.vacuum.a19",
      "roborock.vacuum.a27",
      "roborock.vacuum.a51",
      "roborock.vacuum.a70",
      "roborock.vacuum.a185", // unknown model, capability-derived path
    ]) {
      expect(Boolean(featureListFor(model).isElectronicWaterBoxSupported)).toBe(
        false
      );
    }
  });

  test("voice control is gated to the S7 MaxV and nothing else", () => {
    expect(
      Boolean(featureListFor("roborock.vacuum.a27").isVoiceControlSupported)
    ).toBe(true);
    for (const model of [
      "roborock.vacuum.a19",
      "roborock.vacuum.a51",
      "roborock.vacuum.a70",
    ]) {
      expect(
        Boolean(featureListFor(model).isVoiceControlSupported)
      ).toBe(false);
    }
  });

  test("the water-box allowlist that was already correct still works", () => {
    expect(
      Boolean(featureListFor("roborock.vacuum.a70").isWaterBoxSupported)
    ).toBe(true);
    expect(
      Boolean(featureListFor("roborock.vacuum.a19").isWaterBoxSupported)
    ).toBe(false);
  });

  test("every model list in getFeatureList resolves to a boolean, never an array", () => {
    const list = featureListFor("roborock.vacuum.a19");
    const arrayValued = Object.entries(list)
      .filter(([, value]) => Array.isArray(value))
      .map(([key]) => key);
    // An array here is always truthy and therefore always "supported".
    expect(arrayValued).toEqual([]);
  });
});
