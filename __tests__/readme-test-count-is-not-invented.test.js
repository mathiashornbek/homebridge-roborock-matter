"use strict";

// The README claimed "463 automated tests" in one paragraph and "263 tests"
// a hundred lines later. Both were wrong, and they contradicted each other,
// which is the tell: two hand-written numbers describing one fact will drift
// apart and neither will be corrected, because nothing checks them.
//
// This does not pin an exact figure — jest's total (484) is larger than the
// number of declarations in the files (439) because `test.each` expands at
// runtime, and no static reader can know by how much. It pins the two things
// that actually went wrong: the README must state the count once, and that
// number must sit in a defensible band around what is really declared.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");

/** Every `test(` / `it(` declaration across the suite. */
function declaredTests() {
  return fs
    .readdirSync(__dirname)
    .filter((name) => name.endsWith(".test.js"))
    .reduce((total, name) => {
      const source = fs.readFileSync(path.join(__dirname, name), "utf8");
      const matches = source.match(/^\s*(test|it)(\.each)?\(/gm) || [];
      return total + matches.length;
    }, 0);
}

/** Every "<n> tests" claim in the README. */
function claimedCounts() {
  const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
  return (readme.match(/([\d,]+)\s+(?:automated\s+)?tests\b/g) || []).map(
    (claim) => Number(claim.replace(/[^\d]/g, ""))
  );
}

describe("the README's test count is checked against the suite", () => {
  test("the count is stated with one number, not two", () => {
    const distinct = [...new Set(claimedCounts())];
    expect(distinct).toHaveLength(1);
  });

  test("the stated count is consistent with what the suite declares", () => {
    const declared = declaredTests();
    const [claimed] = [...new Set(claimedCounts())];

    // Never fewer than the declarations: `test.each` only ever adds cases.
    expect(claimed).toBeGreaterThanOrEqual(declared);
    // And not a number someone made up: the expansion is real but bounded.
    expect(claimed).toBeLessThanOrEqual(Math.round(declared * 1.3));
  });
});
