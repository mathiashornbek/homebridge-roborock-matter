"use strict";

// Two releases in a row shipped a partial version of the same fix. 3.3.1
// converted the B01 log lines to friendly names and missed the v1 live-room
// line and the battery resync line — which then appeared in a field log
// directly above a line that DID use the name:
//
//   Battery resync for 3tELc5hUekaTlOJEW3YetI: ... (battery=86%).
//   Matter publish for Garage: battery=86%, ...
//
// Reviewing the diff told me nothing, because the bug was in the lines I had
// not touched. This test enumerates the class instead of the instances: no
// user-visible log line may interpolate a bare duid. That is checkable in one
// pass over the source, which is exactly what I failed to do by hand.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/**
 * Every template literal in a file that is passed to log.info/warn/error,
 * paired with the line it starts on.
 */
function userVisibleLogTemplates(relativePath) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
  const found = [];
  const call = /log\.(?:info|warn|error)\(\s*(`(?:[^`\\]|\\.)*`)/g;

  let match;
  while ((match = call.exec(source)) !== null) {
    found.push({
      template: match[1],
      line: source.slice(0, match.index).split("\n").length,
      file: relativePath,
    });
  }

  return found;
}

// Interpolations that put a raw device identifier in front of a human.
// `describeDevice(duid)` and `getVacuumName()` are the sanctioned wrappers.
const BARE_DUID =
  /\$\{\s*duid\s*\}|\$\{\s*String\(duid\)\s*\}|\$\{\s*this\.accessory\.context\??\.?\.duid[^}]*\}/;

describe("log lines identify robots by name", () => {
  test.each([
    "roborockLib/roborockAPI.js",
    "src/matter_vacuum_accessory.ts",
    "src/platform.ts",
  ])("%s has no info/warn/error line printing a bare duid", (file) => {
    const offenders = userVisibleLogTemplates(file)
      .filter((entry) => BARE_DUID.test(entry.template))
      .map(
        (entry) => `${entry.file}:${entry.line} ${entry.template.slice(0, 90)}`
      );

    // A duid is a 22-character opaque string. In a multi-robot house it tells
    // the reader nothing, and these are the messages people are asked to send
    // in when something is wrong. Use describeDevice(duid) / getVacuumName().
    expect(offenders).toEqual([]);
  });

  test("the sanctioned wrappers are actually used, so the rule above is not vacuous", () => {
    const lib = fs.readFileSync(
      path.join(ROOT, "roborockLib/roborockAPI.js"),
      "utf8"
    );

    expect(lib.match(/describeDevice\(duid\)/g).length).toBeGreaterThan(10);
  });
});
