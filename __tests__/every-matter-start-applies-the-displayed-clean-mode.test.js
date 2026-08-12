"use strict";

// Apple Home always shows a clean mode on the vacuum tile, and starting a
// clean is a promise that the robot will run in THAT mode.
//
// The prep that keeps that promise used to run only when the user had just
// CHANGED the mode — `selectedCleanModeNeedsApply` was set by the Matter
// ChangeToMode handler and by nothing else. That left the most ordinary case
// of all unhandled: the mode Home already displays is usually the mode the
// user wants, so they do not tap it, so no ChangeToMode ever arrives, so
// nothing was sent and the robot ran in whatever mode it had been left in.
//
// Measured end to end in #8 (skmzwanke, Saros 10, 11 Aug 2026):
//
//   18:08:41  Starting Weebo ... for selected service area(s): Bathroom
//   18:08:41  ... acknowledged by Roborock in 202 ms via cloud
//             ^ no "Applying ... mode" line at all — and it mopped.
//
//   19:06:13  Matter clean mode request for Weebo: 0
//   19:06:42  Applying Vacuum mode to Weebo before starting.
//             ^ the very same start, one tap earlier — and it vacuumed.
//
// So this file pins the RULE, not the two start sites: every Matter-initiated
// start must apply the clean mode Apple Home is displaying, whether or not the
// user just changed it. A start path added tomorrow is covered the moment it
// dispatches.
//
// Note the rule deliberately does NOT allow "skip it when the robot already
// matches". The reading such a check would consult is exactly the one that
// lies: while docked, the water-box status reported plain Vacuum for the robot
// that then went and mopped.

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

/** Matter actions that put the robot to work; these owe the user the mode. */
const START_ACTIONS = ["start", "service area clean", "resume"];

/** Matter actions that stop it; these must not touch the mode. */
const NON_START_ACTIONS = ["stop", "pause"];

const ROBOROCK_WATER_BOX_OFF = 200;

/** Body of a `dispatchRoborockMatterCommand("<action>", ...)` call, by action. */
function readDispatchBodies(source) {
  const bodies = new Map();
  const pattern = /dispatchRoborockMatterCommand\(\s*"([^"]+)"/g;

  for (const match of source.matchAll(pattern)) {
    const openParen = source.indexOf("(", match.index);
    let depth = 0;
    let end = openParen;
    for (let i = openParen; i < source.length; i += 1) {
      const character = source[i];
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    bodies.set(match[1], source.slice(openParen, end + 1));
  }

  return bodies;
}

function createPlatform({
  status = {},
  capabilities = {},
  config = {},
  applied = [],
  started = [],
  matterUpdates = [],
} = {}) {
  return {
    platformConfig: {
      enableMatter: true,
      enableMatterCleanMode: true,
      ...config,
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
        property === "name" ? "Weebo" : "",
      getProductAttribute: () => "roborock.vacuum.a144",
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
        ...capabilities,
      }),
      getStatus: jest.fn().mockResolvedValue(undefined),
      applyMatterCleanModeSettings: jest.fn(async (duid, settings, options) => {
        applied.push({ settings, options });
      }),
      app_start: jest.fn(async () => {
        started.push("app_start");
      }),
      app_stop: jest.fn(async () => {
        started.push("app_stop");
      }),
      app_pause: jest.fn(async () => {
        started.push("app_pause");
      }),
      app_charge: jest.fn(async () => {
        started.push("app_charge");
      }),
    },
  };
}

function createAccessory(platform) {
  const accessory = { UUID: "uuid-start", context: { duid: "device-1" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-1" },
    true
  );
  return { vacuum, handlers: accessory.handlers };
}

/** `dispatchRoborockMatterCommand` is fire-and-forget; let its chain settle. */
async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

describe("the rule: every start applies the displayed clean mode", () => {
  const source = fs.readFileSync(SOURCE_PATH, "utf8");
  const bodies = readDispatchBodies(source);

  test("the start actions this rule covers are all still dispatched", () => {
    for (const action of [...START_ACTIONS, ...NON_START_ACTIONS]) {
      expect(bodies.has(action)).toBe(true);
    }
  });

  test.each(START_ACTIONS)("'%s' applies the clean mode first", (action) => {
    const body = bodies.get(action);
    expect(body).toContain("applyCleanModeBeforeStarting()");
  });

  test.each(NON_START_ACTIONS)("'%s' does not touch the mode", (action) => {
    expect(bodies.get(action)).not.toContain("applyCleanModeBeforeStarting");
  });

  test("the apply is not gated on the user having changed the mode", () => {
    const start = source.indexOf(
      "private async applyCleanModeBeforeStarting()"
    );
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n  }", start));

    // The whole defect: an early return when nothing was changed. The flag may
    // still be cleared here, but it must not decide whether to send.
    expect(body).not.toMatch(/if\s*\(\s*!this\.selectedCleanModeNeedsApply/);
  });

  test("no start path skips the apply by comparing against robot state", () => {
    const start = source.indexOf(
      "private async applyCleanModeBeforeStarting()"
    );
    const body = source.slice(start, source.indexOf("\n  }", start));

    // A docked robot's water-box reading is precisely what lied in #8, so the
    // prep must not consult it to decide whether to send.
    expect(body).not.toContain("getWaterBoxModeStatus()");
    expect(body).not.toContain("getLiveCleanType()");
  });
});

describe("#8 replayed: a start with no preceding mode request", () => {
  test("still sends the Vacuum settings Apple Home is displaying", async () => {
    const applied = [];
    const platform = createPlatform({
      // Docked, and the water box reads as if mopping is on — the state that
      // made the plugin's own reading useless as a gate.
      status: { state: 8, battery: 100, fan_power: 102, water_box_mode: 201 },
      applied,
    });
    const { handlers } = createAccessory(platform);

    // No rvcCleanMode.changeToMode: Home already highlights "Vacuum".
    await handlers.rvcRunMode.changeToMode({ newMode: 1 });
    await settle();

    expect(applied).toHaveLength(1);
    expect(applied[0].settings.cleanMode).toBe(0);
    expect(applied[0].settings.waterBoxMode).toBe(ROBOROCK_WATER_BOX_OFF);
  });

  test("the start command is still sent after the prep", async () => {
    const applied = [];
    const started = [];
    const platform = createPlatform({
      status: { state: 8, battery: 100, water_box_mode: 201 },
      applied,
      started,
    });
    const { handlers } = createAccessory(platform);

    await handlers.rvcRunMode.changeToMode({ newMode: 1 });
    await settle();

    expect(applied).toHaveLength(1);
    expect(started).toEqual(["app_start"]);
  });

  test("the prep carries the caller's window, not a bare command", async () => {
    const applied = [];
    const platform = createPlatform({
      status: { state: 8, battery: 100, water_box_mode: 201 },
      applied,
    });
    const { handlers } = createAccessory(platform);

    await handlers.rvcRunMode.changeToMode({ newMode: 1 });
    await settle();

    expect(applied[0].options.prepWindowMs).toBe(2500);
    expect(applied[0].options.requestTimeoutMs).toBeGreaterThan(0);
  });
});

describe("what already worked keeps working", () => {
  test("an explicit mode change is still applied on the next start", async () => {
    const applied = [];
    const platform = createPlatform({
      status: { state: 8, battery: 100, water_box_mode: 200 },
      applied,
    });
    const { handlers } = createAccessory(platform);

    await handlers.rvcCleanMode.changeToMode({ newMode: 2 });
    await handlers.rvcRunMode.changeToMode({ newMode: 1 });
    await settle();

    expect(applied).toHaveLength(1);
    expect(applied[0].settings.cleanMode).toBe(2);
    expect(applied[0].settings.waterBoxMode).not.toBe(ROBOROCK_WATER_BOX_OFF);
  });

  test("stopping does not apply a clean mode", async () => {
    const applied = [];
    const started = [];
    const platform = createPlatform({
      status: { state: 5, battery: 100 },
      applied,
      started,
    });
    const { handlers } = createAccessory(platform);

    await handlers.rvcRunMode.changeToMode({ newMode: 0 });
    await settle();

    expect(applied).toHaveLength(0);
    expect(started).toEqual(["app_stop"]);
  });

  test("pausing does not apply a clean mode", async () => {
    const applied = [];
    const platform = createPlatform({
      status: { state: 5, battery: 100 },
      applied,
    });
    const { handlers } = createAccessory(platform);

    await handlers.rvcOperationalState.pause();
    await settle();

    expect(applied).toHaveLength(0);
  });

  test("resuming a mop run re-applies mop, not the default Vacuum", async () => {
    const applied = [];
    const platform = createPlatform({
      // Paused mid-run with the water box on: the run was started from the
      // Roborock app, so nothing ever selected a mode over Matter. Resuming
      // must not quietly turn the water off.
      status: { state: 10, battery: 80, fan_power: 105, water_box_mode: 201 },
      applied,
    });
    const { handlers } = createAccessory(platform);

    await handlers.rvcOperationalState.resume();
    await settle();

    expect(applied).toHaveLength(1);
    expect(applied[0].settings.waterBoxMode).not.toBe(ROBOROCK_WATER_BOX_OFF);
  });

  test("a failing prep never stops the start command", async () => {
    const started = [];
    const platform = createPlatform({
      status: { state: 8, battery: 100, water_box_mode: 201 },
      started,
    });
    platform.roborockAPI.applyMatterCleanModeSettings = jest.fn(async () => {
      throw new Error("Cloud request with method set_water_box timed out");
    });
    const { handlers } = createAccessory(platform);

    await handlers.rvcRunMode.changeToMode({ newMode: 1 });
    await settle();

    expect(started).toEqual(["app_start"]);
  });
});
