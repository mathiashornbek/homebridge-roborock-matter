"use strict";

// Homebridge 2.5 runs on Node ^22.12.0 || ^24 || ^26, and its apt package
// moved to Node 26 on 9 Nov 2026. The plugin's own range stopped at ^24, so
// every start on Node 26 logged "requires a Node.js version of … which does
// not satisfy the current Node.js version of v26.13.1" — measured on the
// maintainer's server on 11 Nov 2026, while the plugin ran fine there.
//
// The range and the CI matrix are pinned to each other: a Node major the
// range accepts is one CI runs the suite on, and the other way round.

const fs = require("fs");
const path = require("path");
const pkg = require("../package.json");
const lock = require("../package-lock.json");

const workflow = fs.readFileSync(
  path.join(__dirname, "..", ".github", "workflows", "nodejs.yml"),
  "utf8"
);

// The range is only ever caret terms joined by "||", so this reads it
// without depending on semver, which is not a dependency of this package.
function satisfies(version, range) {
  const [major, minor, patch] = version.split(".").map(Number);
  return range.split("||").some((term) => {
    const match = /^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(term.trim());
    if (!match) {
      throw new Error(`Unexpected Node range term: ${term}`);
    }
    const [floorMajor, floorMinor, floorPatch] = match
      .slice(1)
      .map((part) => Number(part ?? 0));
    if (major !== floorMajor) {
      return false;
    }
    return minor !== floorMinor ? minor > floorMinor : patch >= floorPatch;
  });
}

/** The Node versions the "tests" job runs on, as written in the workflow. */
function testedNodeMajors() {
  const tests = workflow.slice(workflow.indexOf("\n  tests:"));
  const match = /node-version:\s*\[([^\]]+)\]/.exec(tests);
  if (!match) {
    throw new Error("No node-version matrix in the tests job");
  }
  return match[1].split(",").map((entry) => entry.trim().replace(/"/g, ""));
}

describe("the plugin's Node range", () => {
  test.each(["22.12.0", "24.0.0", "26.0.0", "26.13.1"])(
    "accepts Node %s, which Homebridge 2.5 supports",
    (version) => {
      expect(satisfies(version, pkg.engines.node)).toBe(true);
    }
  );

  test("does not accept a Node major it was never run on", () => {
    expect(satisfies("16.20.0", pkg.engines.node)).toBe(false);
    expect(satisfies("20.15.0", pkg.engines.node)).toBe(false);
    expect(satisfies("27.0.0", pkg.engines.node)).toBe(false);
  });

  test("package-lock.json carries the same range", () => {
    expect(lock.packages[""].engines.node).toBe(pkg.engines.node);
  });
});

describe("CI runs the suite on the Node majors the range claims", () => {
  test("every tested version is a pinned major the range accepts", () => {
    for (const major of testedNodeMajors()) {
      // lts/* and current move under the matrix; a pinned major does not.
      expect(major).toMatch(/^\d+$/);
      expect(satisfies(`${major}.99.0`, pkg.engines.node)).toBe(true);
    }
  });

  test.each(["22", "24", "26"])(
    "Node %s, which Homebridge 2.x runs on, is tested",
    (major) => {
      expect(testedNodeMajors()).toContain(major);
    }
  );
});
