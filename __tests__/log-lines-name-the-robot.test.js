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
//
// It then shipped half-enumerated. The rule listed three files by hand, and
// the two it left out — vacuum.js and roborock_mqtt_connector.js — had ten
// bare-duid lines between them, including `Device <duid> is offline.`, which
// is precisely the line a user quotes when asking why a robot dropped out. A
// hand-written file list is the same failure mode as a hand-written line list,
// one level up. The list is now discovered from the tree, so a new source file
// is covered the moment it exists.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// Every shipped source file, discovered rather than listed. `dist` is build
// output and `node_modules` is not ours.
function sourceFiles(dir = ".") {
  const entries = fs.readdirSync(path.join(ROOT, dir), {
    withFileTypes: true,
  });
  const found = [];

  for (const entry of entries) {
    const relative = path.posix.join(dir === "." ? "" : dir, entry.name);

    if (entry.isDirectory()) {
      if (["node_modules", "dist", ".git", "__tests__"].includes(entry.name)) {
        continue;
      }

      found.push(...sourceFiles(relative));
    } else if (/\.(js|ts)$/.test(entry.name)) {
      found.push(relative);
    }
  }

  return found;
}

/**
 * Every template literal in a file that reaches a user, paired with its line.
 *
 * Two shapes, not one. The direct `log.info(`…`)` call is the obvious half.
 * The other half is a template built into a variable or an Error and handed
 * to the logger afterwards — `this.log.warn(notReadyError.message)` printed
 * `Roborock device 3tELc5hUekaTlOJEW3YetI is not initialized yet` at warn for
 * months, and this file passed the whole time, because the rule only looked
 * at what was written inside the parentheses. The laundering channels are
 * enumerated rather than the instances: anything assigned to a name that ends
 * in message/line/reason/warning, and anything handed to `new Error(`.
 */
function userVisibleLogTemplates(relativePath) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
  const found = [];
  const patterns = [
    /log\.(?:info|warn|error)\(\s*(`(?:[^`\\]|\\.)*`)/g,
    /(?:const|let|var)\s+\w*(?:[Mm]essage|[Ll]ine|[Rr]eason|[Ww]arning)\s*=\s*(`(?:[^`\\]|\\.)*`)/g,
    /new Error\(\s*(`(?:[^`\\]|\\.)*`)/g,
  ];

  for (const call of patterns) {
    let match;
    while ((match = call.exec(source)) !== null) {
      found.push({
        template: match[1],
        line: source.slice(0, match.index).split("\n").length,
        file: relativePath,
      });
    }
  }

  return found;
}

/**
 * Templates that carry a duid on purpose and never reach a user.
 *
 * One entry, and it earns its place: the ROBOROCK_DEVICE_NOT_READY error is
 * matched by message elsewhere, so its wording is a contract. The line the
 * user actually sees is built separately, right below it, and names the robot.
 */
const INTERNAL_CONTRACT_MESSAGES = [
  /Roborock device \$\{duid\} is not initialized yet/,
];

// Interpolations that put a raw device identifier in front of a human.
// `describeDevice(duid)` and `getVacuumName()` are the sanctioned wrappers.
const BARE_DUID =
  /\$\{\s*duid\s*\}|\$\{\s*String\(duid\)\s*\}|\$\{\s*this\.accessory\.context\??\.?\.duid[^}]*\}/;

describe("log lines identify robots by name", () => {
  test("no info/warn/error line in any source file prints a bare duid", () => {
    const offenders = sourceFiles()
      .flatMap((file) => userVisibleLogTemplates(file))
      .filter(
        (entry) =>
          BARE_DUID.test(entry.template) &&
          !INTERNAL_CONTRACT_MESSAGES.some((allowed) =>
            allowed.test(entry.template)
          )
      )
      .map(
        (entry) => `${entry.file}:${entry.line} ${entry.template.slice(0, 90)}`
      );

    // A duid is a 22-character opaque string. In a multi-robot house it tells
    // the reader nothing, and these are the messages people are asked to send
    // in when something is wrong. Use describeDevice(duid) / getVacuumName().
    expect(offenders).toEqual([]);
  });

  test("the file list is discovered, not hardcoded, and covers the whole plugin", () => {
    const files = sourceFiles();

    // Guards the guard: if the walk silently stopped finding files, the rule
    // above would pass by looking at nothing.
    expect(files).toContain("roborockLib/roborockAPI.js");
    expect(files).toContain("roborockLib/lib/vacuum.js");
    expect(files).toContain("roborockLib/lib/roborock_mqtt_connector.js");
    expect(files).toContain("src/matter_vacuum_accessory.ts");
    expect(files).toContain("src/platform.ts");
    expect(files.length).toBeGreaterThan(15);
  });

  test("the sanctioned wrappers are actually used, so the rule above is not vacuous", () => {
    const lib = fs.readFileSync(
      path.join(ROOT, "roborockLib/roborockAPI.js"),
      "utf8"
    );

    expect(lib.match(/describeDevice\(duid\)/g).length).toBeGreaterThan(10);
  });
});

describe("a line whose content is per-model is printed once, not once per robot", () => {
  // 3.6.0 fixed this by keying the dedupe Set on the rendered line instead of
  // the duid — and then interpolated the robot's name into that same line, so
  // the key went back to being per-robot and the duplicate survived. His log
  // printed it twice for two sc05 robots the same hour it shipped.
  const source = fs.readFileSync(
    path.join(ROOT, "roborockLib/roborockAPI.js"),
    "utf8"
  );

  test("the poll-profile dedupe key carries no robot identity", () => {
    const key = source.slice(
      source.indexOf("const profileKey ="),
      source.indexOf("loggedPollProfiles.add")
    );

    expect(key).toMatch(/robotModel/);
    expect(key).not.toMatch(/describeDevice|getVacuumName|\$\{duid\}/);
  });

  test("the robot is still named, just outside the key", () => {
    const emit = source.slice(
      source.indexOf("loggedPollProfiles.add(profileKey)"),
      source.indexOf("if (carpetSupported)")
    );

    expect(emit).toMatch(/describeDevice\(duid\)/);
  });
});
