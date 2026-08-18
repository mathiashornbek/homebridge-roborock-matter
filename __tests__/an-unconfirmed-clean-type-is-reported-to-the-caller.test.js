"use strict";

// The prep sequence sends up to three commands and then resolves, whatever
// happened — the start command goes out either way, and giving up early is the
// defect 3.4.16 removed. So "acknowledged" and "sent, never confirmed, the
// robot may keep its previous settings" both arrived at the caller as the same
// `undefined`, and the caller had no way to tell them apart.
//
// That mattered because of what the caller does with it. On a confirmed apply
// it pins the clean TYPE for the run, outranking a robot report that has not
// caught up (see applied-clean-type-outranks-a-lagging-robot-report). On an
// unconfirmed one it was doing the same thing on no evidence at all.
//
// Measured in #8 (skmzwanke, Saros 10, 18 Aug 2026):
//
//   13:50:57  Applying Vacuum mode to Weebo before starting.
//   13:50:59  Roborock did not confirm the water mode and suction level ...
//             the robot may keep its previous settings for this run
//   13:51:09  ...app_segment_clean timed out after 10 seconds
//   13:52:22  Roborock still reports Vacuum + Mop after Vacuum was applied
//             and acknowledged
//
// He asked for vacuum-only on two rooms and the robot mopped them. The plugin
// had already logged, 83 seconds earlier, that the command carrying that choice
// went unanswered — and then told him it had been "acknowledged" and held the
// Apple Home tile on Vacuum for the whole run. It hid the failure it had itself
// detected.
//
// The rule these tests enumerate is about which knowledge the prep hands back:
//
//   a setting the robot never confirmed is not knowledge, and a setting that
//   carries the user's clean TYPE is the only kind whose loss can invalidate
//   the pin. A suction level is a level INSIDE the type; losing it says nothing
//   about which type is running.
//
// It is stated over the source as well as over the behaviour, so a fourth prep
// command added tomorrow has to declare which of the two it is.

const fs = require("fs");
const os = require("os");
const path = require("path");

const { Roborock } = require("../roborockLib/roborockAPI");
const { B01_PROTOCOL_VERSION } = require("../roborockLib/lib/b01Q7Adapter");

const SOURCE_PATH = path.join(__dirname, "..", "roborockLib", "roborockAPI.js");

const DUID = "device-1";
const VACUUM_SETTINGS = { cleanMode: 0, fanPower: 102, waterBoxMode: 200 };

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

/**
 * A Roborock instance with the transport stubbed out.
 *
 * @param {{ failWater?: boolean, failFan?: boolean, b01?: boolean }} options
 */
function createApi({ failWater = false, failFan = false, b01 = false } = {}) {
  const log = createLog();
  const api = new Roborock({
    log,
    storagePath: fs.mkdtempSync(
      path.join(os.tmpdir(), "roborock-prep-result-")
    ),
  });

  api.getVacuumDeviceInfo = jest
    .fn()
    .mockReturnValue(b01 ? B01_PROTOCOL_VERSION : "1.0");
  api.getMatterCleanModeCapabilities = jest.fn().mockReturnValue({
    canControlFanPower: true,
    canControlWater: true,
  });
  api.getMatterWaterModeCommandCandidates = jest
    .fn()
    .mockReturnValue(["set_water_box_custom_mode"]);
  api.describeDevice = jest
    .fn()
    .mockReturnValue("Weebo (roborock.vacuum.a144)");
  api.rememberUnsupportedMatterSettingCommand = jest.fn();

  api.runFirstMatterSettingCommand = jest.fn(async () => {
    if (failWater) {
      throw new Error("set_water_box_custom_mode timed out after 2 seconds.");
    }
  });

  // The B01 branch carries the clean type through set_clean_type and the level
  // through set_custom_mode, so the two failures have to be told apart here.
  api.runMatterSettingCommand = jest.fn(async (duid, command) => {
    if (command === "set_clean_type" && failWater) {
      throw new Error("set_clean_type timed out after 2 seconds.");
    }
    if (command === "set_custom_mode" && failFan) {
      throw new Error("set_custom_mode timed out after 2 seconds.");
    }
  });

  return { api, log };
}

const warnings = (log) => log.warn.mock.calls.map((call) => String(call[0]));

describe("the prep tells the caller what the robot confirmed", () => {
  test("a clean apply reports nothing unconfirmed", async () => {
    const { api, log } = createApi();

    const result = await api.applyMatterCleanModeSettings(
      DUID,
      VACUUM_SETTINGS,
      {}
    );

    expect(result).toEqual({
      unconfirmedSettings: [],
      cleanTypeConfirmed: true,
    });
    // Nothing was lost, so nothing is announced.
    expect(warnings(log)).toHaveLength(0);
  });

  test("a lost water command invalidates the clean type", async () => {
    // The #8 case: on a v1 robot the water-box mode IS the difference between
    // Vacuum and Vacuum-and-mop, so losing it loses the user's choice.
    const { api, log } = createApi({ failWater: true });

    const result = await api.applyMatterCleanModeSettings(
      DUID,
      VACUUM_SETTINGS,
      {}
    );

    expect(result.unconfirmedSettings).toContain("water mode");
    expect(result.cleanTypeConfirmed).toBe(false);
    expect(warnings(log)).toHaveLength(1);
    expect(warnings(log)[0]).toContain("water mode");
  });

  test("a lost suction level does NOT invalidate the clean type", async () => {
    // It is a level inside the chosen type. Dropping the pin for it would
    // reintroduce the lagging-report lie for a cosmetic command's sake.
    const { api, log } = createApi({ failFan: true });

    const result = await api.applyMatterCleanModeSettings(
      DUID,
      VACUUM_SETTINGS,
      {}
    );

    expect(result.unconfirmedSettings).toEqual(["suction level"]);
    expect(result.cleanTypeConfirmed).toBe(true);
    // Still reported to the user — it is still something they asked for.
    expect(warnings(log)).toHaveLength(1);
  });

  test("both lost reads as his log line did, and the type is gone", async () => {
    const { api, log } = createApi({ failWater: true, failFan: true });

    const result = await api.applyMatterCleanModeSettings(
      DUID,
      VACUUM_SETTINGS,
      {}
    );

    expect(result.cleanTypeConfirmed).toBe(false);
    expect(warnings(log)[0]).toContain("water mode and suction level");
  });

  test("the report never repeats a setting, however many paths lost it", async () => {
    const { api } = createApi({ failWater: true });

    // getMatterWaterModeCommandCandidates returning empty ALSO pushes "water
    // mode", and a closed prep window pushes the label again per command. The
    // user is told about a setting once.
    api.getMatterWaterModeCommandCandidates = jest.fn().mockReturnValue([]);

    const result = await api.applyMatterCleanModeSettings(
      DUID,
      VACUUM_SETTINGS,
      {}
    );

    expect(
      result.unconfirmedSettings.filter((l) => l === "water mode")
    ).toEqual(["water mode"]);
  });
});

describe("the Q7/B01 dialect obeys the same rule with its own commands", () => {
  test("a lost native clean type invalidates it", async () => {
    const { api } = createApi({ b01: true, failWater: true });

    const result = await api.applyMatterCleanModeSettings(
      DUID,
      { cleanMode: 0, fanPower: 102 },
      {}
    );

    expect(result.unconfirmedSettings).toContain("clean type");
    expect(result.cleanTypeConfirmed).toBe(false);
  });

  test("a lost suction level does not", async () => {
    const { api } = createApi({ b01: true, failFan: true });

    const result = await api.applyMatterCleanModeSettings(
      DUID,
      { cleanMode: 0, fanPower: 102 },
      {}
    );

    expect(result.unconfirmedSettings).toEqual(["suction level"]);
    expect(result.cleanTypeConfirmed).toBe(true);
  });
});

describe("the rule is stated over the source, not per command", () => {
  const source = fs.readFileSync(SOURCE_PATH, "utf8");

  test("every label the prep can report is classified as type or level", () => {
    // A fourth prep command added tomorrow pushes a new label. Until someone
    // decides whether it carries the clean type, this fails — which is the
    // point: the default must be a decision, not a silent "level".
    const pushed = new Set(
      [...source.matchAll(/unconfirmedSettings\.push\(\s*"([^"]+)"\s*\)/g)].map(
        (match) => match[1]
      )
    );
    expect(pushed.size).toBeGreaterThan(0);

    const declared = source.match(
      /MATTER_CLEAN_TYPE_PREP_LABELS = new Set\(\[([^\]]*)\]\)/
    );
    expect(declared).not.toBeNull();
    const typeLabels = new Set(
      [...declared[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
    );

    // Known levels: everything that is deliberately NOT type-carrying. Listed
    // here rather than derived so adding one is a visible choice.
    const levelLabels = new Set(["suction level"]);

    for (const label of pushed) {
      expect(typeLabels.has(label) || levelLabels.has(label)).toBe(true);
    }
    // And the two sets may not overlap: a label cannot be both.
    for (const label of typeLabels) {
      expect(levelLabels.has(label)).toBe(false);
    }
  });

  test("the classification lives in exactly one place", () => {
    // Two hand-written copies drifting apart is the most repeated defect in
    // this codebase, and this one is read by both ends of the plugin.
    expect(source.match(/MATTER_CLEAN_TYPE_PREP_LABELS/g)).toHaveLength(2);
  });

  test("no exit path of the prep drops the report on the floor", () => {
    // Both dialects end by reporting, and both must hand the result back. A
    // bare `return;` here is how the caller silently goes back to guessing.
    const start = source.indexOf("async applyMatterCleanModeSettings(");
    expect(start).toBeGreaterThan(-1);
    // Anchor on the end of the signature, not the first brace after it: the
    // `options = {}` default is a brace pair that would close the body at
    // once and leave this rule inspecting nothing.
    const signatureEnd = source.indexOf(") {", start);
    expect(signatureEnd).toBeGreaterThan(start);
    const openBrace = source.indexOf("{", signatureEnd);
    let depth = 0;
    let end = source.length;
    for (let i = openBrace; i < source.length; i += 1) {
      if (source[i] === "{") {
        depth += 1;
      } else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    // Comments stripped first: this function's own commentary discusses "the
    // early return" that 3.4.16 removed, and scanning prose for control flow
    // finds sentences instead of statements.
    const body = source
      .slice(openBrace, end)
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    // Every `return` in the body either hands back the report or returns null
    // from the budget helper's callback — nothing else.
    const returns = [...body.matchAll(/\breturn\b([^;\n]*)/g)].map((match) =>
      match[1].trim()
    );
    for (const returned of returns) {
      const handsBackTheReport =
        returned === "this.reportUnconfirmedMatterCleanModeSettings(" ||
        returned.startsWith("this.reportUnconfirmedMatterCleanModeSettings");
      const isTheBudgetCallback =
        returned === "null" || returned.startsWith("{ ...commandOptions");
      expect(handsBackTheReport || isTheBudgetCallback).toBe(true);
    }
    expect(
      returns.filter((returned) =>
        returned.startsWith("this.reportUnconfirmedMatterCleanModeSettings")
      )
    ).toHaveLength(2);
  });
});
