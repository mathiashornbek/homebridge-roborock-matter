"use strict";

// A live frame reaches Matter through two checks, one above the other:
//
//   extractStatusUpdate()          <- the gate: is this a status message at all?
//   updateMatterStateFromMessage() <- the caller: did anything meaningful arrive?
//
// Both used to name their fields by hand, and they drifted. The caller was
// taught that a frame carrying only `fan_power` or only `matter_clean_type` is
// meaningful — a suction or mop-mode change made in the Roborock app, or picked
// by SmartPlan, pushes exactly that — but the gate below it still listed only
// five of the seven fields and threw such a frame away before the caller ran.
// The fix that added the two fields was made one level down from the gatekeeper.
//
// So this file pins the RULE, not the two field names: every field the publish
// path reads out of a live frame must also open the gate. A field added
// tomorrow is covered the moment it is read.

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

/** The single list both checks are required to derive from. */
function readMeaningfulFieldList(source) {
  const match = source.match(
    /const MEANINGFUL_LIVE_STATUS_FIELDS = \[([\s\S]*?)\] as const;/
  );
  if (!match) {
    throw new Error(
      "MEANINGFUL_LIVE_STATUS_FIELDS is gone. Both the gate and the caller must still derive their fields from one list."
    );
  }
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/** Every `status.<field>` the publish path reads out of the extracted frame. */
function readFieldsThePublishReads(source) {
  const start = source.indexOf(
    "private async updateMatterStateFromMessage(data: unknown)"
  );
  expect(start).toBeGreaterThan(-1);
  // Stop at the point the frame has been consumed into locals; everything the
  // function reads off `status` is declared in that opening block.
  const end = source.indexOf("// Remember the freshest live values", start);
  expect(end).toBeGreaterThan(start);

  const body = source.slice(start, end);
  const fields = new Set();
  for (const match of body.matchAll(/status\.([a-z_]+)/g)) {
    fields.add(match[1]);
  }
  return [...fields];
}

function createPlatform({ status = {}, matterUpdates = [] } = {}) {
  return {
    platformConfig: {
      enableMatter: true,
      enableMatterPowerSource: true,
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
        property === "name" ? "Test Vacuum" : "",
      getProductAttribute: () => "roborock.vacuum.a70",
      getVacuumDeviceStatus: (duid, property) => status[property] ?? "",
      getRoomMappingsForDevice: () => [],
      getMapListForDevice: () => [],
      getCurrentMapIdForDevice: () => null,
      getMatterCleanModeCapabilities: () => ({
        canVacuum: true,
        canMop: true,
        canControlFanPower: true,
        canMaxPlusFanPower: false,
        canControlWater: false,
      }),
      getStatus: jest.fn().mockResolvedValue(undefined),
    },
  };
}

function createAccessory(platform) {
  const accessory = { UUID: "uuid-gate", context: { duid: "device-1" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-1" },
    true
  );
  return { vacuum };
}

function lastCleanMode(matterUpdates) {
  for (let i = matterUpdates.length - 1; i >= 0; i -= 1) {
    const update = matterUpdates[i];
    if (
      update.cluster === "rvcCleanMode" &&
      update.attributes &&
      "currentMode" in update.attributes
    ) {
      return update.attributes.currentMode;
    }
  }
  return undefined;
}

describe("the live-status gate names every field the publish reads", () => {
  const source = fs.readFileSync(SOURCE_PATH, "utf8");

  test("the gate derives its fields from the shared list, not by hand", () => {
    const gate = source.match(
      /const hasStatus = MEANINGFUL_LIVE_STATUS_FIELDS\.some\(/
    );
    expect(gate).not.toBeNull();
  });

  test("the caller derives its emptiness check from the same shared list", () => {
    expect(source).toMatch(
      /MEANINGFUL_LIVE_STATUS_FIELDS\.every\(\s*\(field\) => meaningfulValues\[field\] === null\s*\)/
    );
  });

  test("every field the publish reads is in the shared list", () => {
    const declared = readMeaningfulFieldList(source);
    const read = readFieldsThePublishReads(source);

    expect(read.length).toBeGreaterThanOrEqual(7);
    const missing = read.filter((field) => !declared.includes(field));
    expect(missing).toEqual([]);
  });

  test("fan_power and matter_clean_type are among them", () => {
    // Named explicitly because these are the two the gate used to drop; the
    // rule above is what protects the rest.
    const declared = readMeaningfulFieldList(source);
    expect(declared).toContain("fan_power");
    expect(declared).toContain("matter_clean_type");
  });
});

describe("a frame carrying only one meaningful field still reaches Matter", () => {
  test("suction-only frame updates the clean mode", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      // Robot is cleaning on Balanced; the user switches to Max in the app.
      status: { state: 5, battery: 60, fan_power: 102 },
      matterUpdates,
    });
    const { vacuum } = createAccessory(platform);
    matterUpdates.length = 0;

    await vacuum.notifyDeviceUpdater("CloudMessage", [{ fan_power: 104 }]);

    // 6 = Max Vacuum, the fan-power clean mode for 104.
    expect(lastCleanMode(matterUpdates)).toBe(6);
  });

  test("clean-type-only frame reaches the publish path", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      status: { state: 5, battery: 60 },
      matterUpdates,
    });
    const { vacuum } = createAccessory(platform);
    matterUpdates.length = 0;

    await vacuum.notifyDeviceUpdater("CloudMessage", [
      { matter_clean_type: 2 },
    ]);

    expect(matterUpdates.length).toBeGreaterThan(0);
  });

  test("a frame with no meaningful field is still ignored", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      status: { state: 5, battery: 60 },
      matterUpdates,
    });
    const { vacuum } = createAccessory(platform);
    matterUpdates.length = 0;

    await vacuum.notifyDeviceUpdater("CloudMessage", [
      { msg_seq: 41, unrelated: "noise" },
    ]);

    expect(matterUpdates).toEqual([]);
  });
});
