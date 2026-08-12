"use strict";

// This package ships its build output. `dist/` is in the published tarball,
// `main` points into it, and nothing a user installs needs compiling. Yet
// package.json carried `"prepare": "npm run build"` — a hook npm runs at
// install time — and that hook could only ever do one of two things to a
// user:
//
//   1. Fail. Installing straight from the git repository clones the package
//      to a temp directory and runs `prepare` there, but the internal
//      dependency install inherits `-g`/`--prefix` from the outer command,
//      so the clone is left with no `node_modules` and the build dies with
//      `sh: rimraf: command not found` / `code 127`. Measured, reproduced,
//      and not fixable from this side.
//   2. Warn. npm >= 11.16 refuses to run install scripts it has not been
//      told to trust and prints, for a tarball install:
//        npm warn allow-scripts homebridge-roborock-matter (prepare: npm run build)
//      A supply-chain warning naming this package, for a build that did not
//      need to happen. It cost a tester a round trip before it cost anyone
//      else anything.
//
// So the rule is not "drop the `prepare` line". It is that installing this
// package must never ask for a build — while packing one must always perform
// it, or a release could ship without `dist`. Both halves are enumerated
// here, because dropping the hook without moving the build is the obvious
// way to get this wrong.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(REPO, "package.json"), "utf8")
);
const scripts = manifest.scripts || {};

/**
 * The lifecycle scripts npm may run on the *consumer's* machine while
 * installing this package. `prepare` belongs here: it runs for git
 * dependencies and is what npm's allow-scripts hardening reports.
 */
const INSTALL_TIME_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
];

/** The lifecycle scripts that run while a tarball is being created. */
const PACKING_SCRIPTS = ["prepack", "prepublishOnly"];

/** Scripts the release gate runs; removing one silently skips a gate. */
const GATE_SCRIPTS = ["lint", "typecheck", "build", "test"];

describe("installing this package never runs a build", () => {
  test.each(INSTALL_TIME_SCRIPTS)(
    "package.json declares no %s script",
    (name) => {
      expect(scripts).not.toHaveProperty(name);
    }
  );

  test("no install-time script exists under any name npm would run", () => {
    const declared = Object.keys(scripts).filter((name) =>
      INSTALL_TIME_SCRIPTS.includes(name)
    );
    expect(declared).toEqual([]);
  });

  test("the build output is shipped rather than produced on install", () => {
    expect(manifest.main).toMatch(/^(\.\/)?dist\//);
  });

  test("dist is not excluded from the published package", () => {
    const npmignore = fs.readFileSync(path.join(REPO, ".npmignore"), "utf8");
    const excluded = npmignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .some((line) => /^\/?dist\/?$/.test(line));
    expect(excluded).toBe(false);
  });
});

describe("packing this package always runs a build", () => {
  test("a packing lifecycle script performs the build", () => {
    const building = PACKING_SCRIPTS.filter((name) =>
      (scripts[name] || "").includes("build")
    );
    expect(building.length).toBeGreaterThan(0);
  });

  test("prepack builds, so `npm pack` cannot produce a tarball without dist", () => {
    // `prepublishOnly` alone is not enough: it does not run for `npm pack`,
    // which is how the prebuilt beta tarballs are made.
    expect(scripts.prepack || "").toContain("build");
  });

  test.each(GATE_SCRIPTS)("the %s gate script still exists", (name) => {
    expect(typeof scripts[name]).toBe("string");
  });
});
