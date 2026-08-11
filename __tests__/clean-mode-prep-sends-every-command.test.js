"use strict";

// Selecting "Vacuum" in a Matter controller and getting a vacuum-and-mop is
// not a display problem — the robot did the wrong job to the wrong room.
//
// On a v1 robot the difference between "Vacuum" and "Vacuum and mop" IS the
// water-box mode: choosing Vacuum sends water-box OFF. Fan power only picks a
// suction level within the chosen mode. The prep sequence used to send fan
// power first and, if that command timed out, return — so the water command
// was never sent and the robot kept whatever the Roborock app had it set to.
// skmzwanke reported exactly that in #8: he selected Vacuum, `set_custom_mode`
// timed out after two seconds, and his Saros 10 mopped the room anyway.
//
// The rule these tests hold is not "send the water command first" as a fact
// about today's two commands. It is that no command in the prep sequence may
// be cancelled by the outcome of another: each one carries part of what the
// user asked for, and the caller already bounds the total time with its own
// prep timeout, so there is nothing to win by giving up early.

const fs = require("fs");
const os = require("os");
const path = require("path");

const { Roborock } = require("../roborockLib/roborockAPI");

const DUID = "device-1";
const WATER_COMMANDS = ["set_water_box_custom_mode"];
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
 * A Roborock instance with the transport stubbed out, recording the order in
 * which prep commands are attempted.
 */
function createApi({ failWater = false, failFan = false } = {}) {
  const api = new Roborock({
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "roborock-prep-")),
  });

  const attempted = [];

  api.getVacuumDeviceInfo = jest.fn().mockReturnValue("1.0");
  api.getMatterCleanModeCapabilities = jest.fn().mockReturnValue({
    canControlFanPower: true,
    canControlWater: true,
  });
  api.getMatterWaterModeCommandCandidates = jest
    .fn()
    .mockReturnValue([...WATER_COMMANDS]);
  api.describeDevice = jest
    .fn()
    .mockReturnValue("Weebo (roborock.vacuum.a144)");
  api.rememberUnsupportedMatterSettingCommand = jest.fn();

  api.runFirstMatterSettingCommand = jest.fn(async (duid, commands, value) => {
    attempted.push({ command: commands[0], value });
    if (failWater) {
      throw new Error(
        "Cloud request with id 685 with method set_water_box_custom_mode timed out after 2 seconds."
      );
    }
  });

  api.runMatterSettingCommand = jest.fn(async (duid, command, value) => {
    attempted.push({ command, value });
    if (failFan) {
      throw new Error(
        "Cloud request with id 685 with method set_custom_mode timed out after 2 seconds."
      );
    }
  });

  return { api, attempted };
}

/**
 * Every `catch (error) { … }` body in `source`, brace-matched rather than
 * sliced on a fixed indentation so that nesting a command in an `if` does not
 * quietly shrink what the rule inspects.
 *
 * @param {string} source
 * @returns {string[]}
 */
function collectCatchHandlers(source) {
  const handlers = [];
  const opener = "} catch (error) {";
  let index = source.indexOf(opener);

  while (index !== -1) {
    let depth = 1;
    let cursor = index + opener.length;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === "{") {
        depth += 1;
      } else if (source[cursor] === "}") {
        depth -= 1;
      }
      cursor += 1;
    }
    handlers.push(source.slice(index + opener.length, cursor - 1));
    index = source.indexOf(opener, cursor);
  }

  return handlers;
}

describe("clean-mode prep sends every command the selection asks for", () => {
  test("a timed-out suction command does not swallow the mop setting", async () => {
    // The #8 scenario, exactly: Vacuum selected, fan command times out.
    const { api, attempted } = createApi({ failFan: true });

    await api.applyMatterCleanModeSettings(DUID, VACUUM_SETTINGS, {});

    const commands = attempted.map((entry) => entry.command);
    expect(commands).toContain("set_water_box_custom_mode");
    expect(commands).toContain("set_custom_mode");

    // And it carried the value that turns mopping off for this run.
    expect(
      attempted.find((entry) => entry.command === "set_water_box_custom_mode")
        .value
    ).toBe(VACUUM_SETTINGS.waterBoxMode);
  });

  test("a failed mop command does not swallow the suction level either", async () => {
    // The rule is symmetric: neither command owns the other's fate.
    const { api, attempted } = createApi({ failWater: true });

    await api.applyMatterCleanModeSettings(DUID, VACUUM_SETTINGS, {});

    expect(attempted.map((entry) => entry.command)).toEqual([
      "set_water_box_custom_mode",
      "set_custom_mode",
    ]);
  });

  test("the command carrying the mode goes out before the one carrying the level", async () => {
    // If only one of the two survives a flaky link, it should be the one that
    // decides whether the robot mops at all.
    const { api, attempted } = createApi();

    await api.applyMatterCleanModeSettings(DUID, VACUUM_SETTINGS, {});

    expect(attempted.map((entry) => entry.command)).toEqual([
      "set_water_box_custom_mode",
      "set_custom_mode",
    ]);
  });

  test("a partial apply is announced, because the tile will claim otherwise", async () => {
    const { api } = createApi({ failFan: true });

    await api.applyMatterCleanModeSettings(DUID, VACUUM_SETTINGS, {});

    const warning = api.log.warn.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("suction level"));

    expect(warning).toBeDefined();
    expect(warning).toMatch(/may not match the mode selected/i);
    // The robot is named, not printed as a raw duid.
    expect(warning).toContain("Weebo");
    expect(warning).not.toContain(DUID);
  });

  test("a clean apply says nothing", async () => {
    const { api } = createApi();

    await api.applyMatterCleanModeSettings(DUID, VACUUM_SETTINGS, {});

    expect(api.log.warn).not.toHaveBeenCalled();
  });

  test("both failures are named in one line", async () => {
    const { api } = createApi({ failWater: true, failFan: true });

    await api.applyMatterCleanModeSettings(DUID, VACUUM_SETTINGS, {});

    expect(api.log.warn).toHaveBeenCalledTimes(1);
    expect(String(api.log.warn.mock.calls[0][0])).toMatch(
      /water mode and suction level/
    );
  });

  test("no prep command aborts the sequence early", () => {
    // The rule over the source: the sequence may log and move on, but it may
    // not return out of the middle of itself. A `return` between the first
    // command and the last is how the water command was lost in the first
    // place, and it would be lost again the same way.
    //
    // This used to read only the classic half, anchored on a
    // `const failedCommands = []` line that no longer exists — the failure
    // bookkeeping moved to the top of the method so both dialect branches share
    // it. The rule now covers every catch handler in the method, which is what
    // it should always have said: the B01 branch sends the Q7's clean type the
    // same way, and a `return` in its first catch would lose the suction level
    // for exactly the same reason.
    const source = fs.readFileSync(
      path.join(__dirname, "..", "roborockLib", "roborockAPI.js"),
      "utf8"
    );
    const start = source.indexOf("async applyMatterCleanModeSettings(");
    expect(start).toBeGreaterThan(-1);

    const body = source.slice(start, source.indexOf("\n  }", start));
    const catchBlocks = collectCatchHandlers(body);
    // Both dialect branches, at least one handler per command they send.
    expect(catchBlocks.length).toBeGreaterThan(3);
    for (const handler of catchBlocks) {
      expect(handler).not.toMatch(/\breturn\b/);
    }
  });
});
