"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(REPO, ...parts), "utf8");

const platformSource = read("src", "platform.ts");
const apiSource = read("roborockLib", "roborockAPI.js");
const vacuumSource = read("roborockLib", "lib", "vacuum.js");
const uiSource = read("src", "ui", "index.ts");

function branchBetween(startMarker, endMarker) {
  const start = vacuumSource.indexOf(startMarker);
  const end = vacuumSource.indexOf(endMarker, start + startMarker.length);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return vacuumSource.slice(start, end);
}

describe("generic timer poll ownership", () => {
  test("the generic poll names both timer diagnostics", () => {
    expect(apiSource).toContain(
      'await this.pollParameter(duid, vacuum, "get_server_timer", isB01);'
    );
    expect(apiSource).toContain(
      'await this.pollParameter(duid, vacuum, "get_timer", isB01);'
    );
  });

  test("neither generic timer diagnostic sends outside explicit debug mode", () => {
    expect(platformSource).toMatch(
      /const debugMode = this\.platformConfig\.debugMode;[\s\S]*?new Roborock\(\{[\s\S]*?debug: debugMode,/
    );

    const serverTimerBranch = branchBetween(
      '} else if (parameter == "get_server_timer") {',
      '} else if (parameter == "get_timer") {'
    );
    const legacyTimerBranch = branchBetween(
      '} else if (parameter == "get_timer") {',
      '} else if (parameter == "get_photo") {'
    );

    for (const branch of [serverTimerBranch, legacyTimerBranch]) {
      expect(branch).toContain("if (this.adapter.config.debug) {");
      expect(branch).toContain("await sendParameterRequest(parameter, []);");
    }
  });

  test("get_timer remains a distinct user-requested diagnostic", () => {
    expect(vacuumSource).toContain(
      'await this.updateDiagnosticSnapshot(duid, "lastTimer", {'
    );
    expect(uiSource).toContain(
      "lastTimerDiagnostic: roborockDiagnostic.lastTimer || null"
    );
  });
});
