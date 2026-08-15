"use strict";

// vp-debug12 offered in #9 to test changes on his Q Revo before they ship, if
// they are published as betas. That offer is worth a great deal — this project
// has twice shipped a Matter attribute on reasoning and twice taken it back
// out — but the release pipeline could not accept it.
//
// Measured against npm 11.16.0, not reasoned about:
//
//   $ npm publish --dry-run          (version 3.11.0-beta.1)
//   npm error You must specify a tag using --tag when publishing a prerelease
//
// So the failure mode was never "a beta silently becomes latest and every user
// is offered it" — npm refuses outright. It is the quieter one: the publish
// job runs lint, typecheck, build and 1100 tests, then dies on the last step,
// and the beta does not exist. The channel was not dangerous, it was absent.
//
// This test pins the rule rather than the one case that prompted it. The tag
// is derived from the version by a script the workflow actually calls, so the
// mapping is checkable here instead of only being observable in a release. The
// rule that matters most is the negative one: nothing carrying a prerelease
// identifier may ever land on `latest`, including the adversarial spellings
// (`3.11.0-latest.1`) that a naive "take the identifier" implementation hands
// straight through.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, ".github", "scripts", "npm-dist-tag.js");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "publish-npm.yml");

const { distTagFor } = require("../.github/scripts/npm-dist-tag.js");

describe("the dist-tag a version publishes to", () => {
  test("a stable version publishes to latest, exactly as it does today", () => {
    // Every version this project has ever released is of this shape, so this
    // is the case that must not change behaviour. npm's own default for a
    // stable version and no --tag is `latest`; passing it explicitly has to
    // mean the same thing, or the fix breaks the releases it was not about.
    expect(distTagFor("3.10.1")).toBe("latest");
    expect(distTagFor("3.11.0")).toBe("latest");
    expect(distTagFor("4.0.0")).toBe("latest");
    expect(distTagFor("0.0.1")).toBe("latest");
  });

  test("a prerelease publishes to a channel named by its identifier", () => {
    expect(distTagFor("3.11.0-beta.1")).toBe("beta");
    expect(distTagFor("3.11.0-beta")).toBe("beta");
    expect(distTagFor("3.11.0-rc.2")).toBe("rc");
    expect(distTagFor("4.0.0-alpha.0")).toBe("alpha");
    expect(distTagFor("3.11.0-next.7")).toBe("next");
  });

  test("an identifier that names no channel falls back to next", () => {
    // `3.11.0-1` is legal semver. Its identifier is `1`, which is not a
    // channel anyone would install from, and `npm install pkg@1` already
    // means something else entirely.
    expect(distTagFor("3.11.0-1")).toBe("next");
    expect(distTagFor("3.11.0-0")).toBe("next");
  });

  test("no prerelease reaches latest, however it is spelled", () => {
    // The class, not the cases. A tag is derived from user-controlled text in
    // package.json; the one output that must be unreachable from a prerelease
    // is the channel every existing installation follows.
    const prereleases = [
      "3.11.0-beta.1",
      "3.11.0-rc.1",
      "3.11.0-alpha",
      "3.11.0-1",
      "3.11.0-latest", // the adversarial spelling
      "3.11.0-latest.4",
      "3.11.0-LATEST.1",
      "3.11.0-beta.1+build.9",
      "3.11.0-.",
      "3.11.0-",
    ];

    for (const version of prereleases) {
      expect(distTagFor(version)).not.toBe("latest");
    }
  });

  test("a tag is always a single non-empty token npm will accept", () => {
    const versions = [
      "3.10.1",
      "3.11.0-beta.1",
      "3.11.0-rc.2",
      "3.11.0-",
      "3.11.0-.",
      "3.11.0-beta.1+build.9",
      "3.11.0-LATEST.1",
      "3.11.0-weird_identifier.2",
    ];

    for (const version of versions) {
      const tag = distTagFor(version);
      expect(typeof tag).toBe("string");
      expect(tag).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
      expect(tag).not.toMatch(/\s/);
    }
  });

  test("build metadata alone is not a prerelease", () => {
    expect(distTagFor("3.11.0+build.9")).toBe("latest");

    // The case that actually pins the stripping. Semver allows hyphens inside
    // build metadata, so a version with no prerelease at all can still contain
    // a `-`. Reading the dash without discarding the metadata first turns a
    // stable release into `next` — a release nobody would be offered. Written
    // down because mutating the strip out of the script left every other case
    // in this file green.
    expect(distTagFor("3.11.0+build-9")).toBe("latest");
    expect(distTagFor("3.11.0+sha-abc1234")).toBe("latest");
  });

  test("the script prints the tag when run directly, which is how CI uses it", () => {
    const { execFileSync } = require("child_process");

    const stable = execFileSync("node", [SCRIPT, "3.10.1"], {
      encoding: "utf8",
    }).trim();
    const beta = execFileSync("node", [SCRIPT, "3.11.0-beta.1"], {
      encoding: "utf8",
    }).trim();

    expect(stable).toBe("latest");
    expect(beta).toBe("beta");
  });
});

describe("the publish workflow actually uses it", () => {
  const workflow = fs.readFileSync(WORKFLOW, "utf8");

  test("npm publish is never invoked without an explicit --tag", () => {
    // Without this, npm 11 aborts the publish step on any prerelease — after
    // the whole gate has already run.
    // Only actual invocations — the workflow also logs the words "npm
    // publish" in a skip message, and prose is not a command.
    const publishInvocations = workflow
      .split("\n")
      .filter((line) => /^\s*(run:\s*)?npm publish\b/.test(line));

    expect(publishInvocations.length).toBeGreaterThan(0);

    for (const line of publishInvocations) {
      expect(line).toMatch(/--tag\b/);
    }
  });

  test("the tag comes from the script, not from a second copy of the rule", () => {
    // A rule written twice is a rule that will disagree with itself. The
    // workflow must call the script this test covers.
    expect(workflow).toContain(".github/scripts/npm-dist-tag.js");
  });

  test("every script a workflow calls is actually tracked by git", () => {
    // This one nearly shipped broken. `.gitignore` line 16 is `.github/*`
    // with an allowlist under it for `workflows/` and `ISSUE_TEMPLATE/`, so a
    // new file under `.github/scripts/` is ignored by default. The workflow
    // would have been committed calling a script that does not exist in the
    // repository, and the failure would not appear until the next release —
    // after the gate had passed, on a push that was supposed to publish.
    //
    // The rule is enumerated from the workflows rather than listing the one
    // script, so the next one added is covered before it can bite.
    const { execFileSync } = require("child_process");

    const workflowDir = path.join(ROOT, ".github", "workflows");
    const referenced = new Set();

    for (const file of fs.readdirSync(workflowDir)) {
      const text = fs.readFileSync(path.join(workflowDir, file), "utf8");
      for (const match of text.matchAll(/\.github\/scripts\/[\w.-]+/g)) {
        referenced.add(match[0]);
      }
    }

    expect(referenced.size).toBeGreaterThan(0);

    const tracked = new Set(
      execFileSync("git", ["ls-files", ".github"], {
        cwd: ROOT,
        encoding: "utf8",
      })
        .split("\n")
        .filter(Boolean)
    );

    for (const script of referenced) {
      expect(fs.existsSync(path.join(ROOT, script))).toBe(true);
      expect(Array.from(tracked)).toContain(script);
    }
  });

  test("a prerelease is not published as the GitHub 'Latest' release either", () => {
    // Same mistake, different surface: the repo front page advertises one
    // release as Latest, and a beta must not take that slot.
    expect(workflow).toMatch(/--prerelease/);
  });
});
