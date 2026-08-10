"use strict";

// The diagnostic report states what the RUNNING plugin is doing. A setting
// ticked on screen but not saved and restarted is not in effect, so a report
// that quotes the form sends its reader chasing a behaviour the plugin never
// exhibited.
//
// That was already learned once, for the `matterFeatures` line — and the fix
// stopped at that line. The `cloudOnlyMode` line directly above it went on
// reading its checkbox, and a user whose device card said "Cloud only" while
// the report's own settings line said `disabled` spent an evening looking for
// a setting that was off. Fixing the line in front of you is the same mistake
// as a hand-written file list, one level down.
//
// So the rule is enumerated over the source instead of over the lines someone
// happened to look at: nothing the report builder reaches may read the form.

const fs = require("fs");
const path = require("path");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "homebridge-ui", "public", "index.js"),
  "utf8"
);

/**
 * Top-level function bodies, by name. Good enough for this file, which
 * declares everything as a top-level `function`/`async function`.
 */
function readTopLevelFunctions() {
  const pattern = /^(?:async )?function (\w+)\s*\(/gm;
  const starts = [...SOURCE.matchAll(pattern)];
  const bodies = new Map();

  starts.forEach((match, index) => {
    const from = match.index;
    const to =
      index + 1 < starts.length ? starts[index + 1].index : SOURCE.length;
    bodies.set(match[1], SOURCE.slice(from, to));
  });

  return bodies;
}

const FUNCTIONS = readTopLevelFunctions();

// The one deliberate exception. These helpers exist precisely to compare the
// form against the saved config so the report can WARN that they disagree;
// they never source a reported value from the form.
const FORM_COMPARISON_HELPERS = new Set([
  "hasUnsavedMatterFeatureEdits",
  "hasUnsavedCloudOnlyEdit",
]);

/** Everything the named function can reach, minus the allowed comparators. */
function reachableFrom(name, seen = new Set()) {
  if (seen.has(name) || !FUNCTIONS.has(name)) {
    return seen;
  }
  seen.add(name);

  for (const candidate of FUNCTIONS.keys()) {
    if (candidate === name || FORM_COMPARISON_HELPERS.has(candidate)) {
      continue;
    }
    if (new RegExp(`\\b${candidate}\\s*\\(`).test(FUNCTIONS.get(name))) {
      reachableFrom(candidate, seen);
    }
  }

  return seen;
}

describe("the diagnostic report quotes the saved config, never the form", () => {
  test("the report builder is present and parsed", () => {
    expect(FUNCTIONS.has("buildDiagnosticsReport")).toBe(true);
    expect(FUNCTIONS.size).toBeGreaterThan(20);
  });

  test("nothing the report builder reaches reads the settings form", () => {
    const offenders = [...reachableFrom("buildDiagnosticsReport")]
      .filter((name) => /\belements\./.test(FUNCTIONS.get(name)))
      .sort();

    expect(offenders).toEqual([]);
  });

  test("the allowed comparators really are only comparators", () => {
    // If one of them starts returning a reported value rather than a boolean
    // verdict, the exception above stops being safe.
    for (const name of FORM_COMPARISON_HELPERS) {
      if (!FUNCTIONS.has(name)) {
        continue;
      }
      expect(FUNCTIONS.get(name)).toMatch(/return .*(some|every|!==|===)/s);
    }
  });
});
