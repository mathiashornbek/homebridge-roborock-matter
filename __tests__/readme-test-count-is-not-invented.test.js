"use strict";

// The README claimed "463 automated tests" in one paragraph and "263 tests"
// a hundred lines later. Both were wrong, and they contradicted each other,
// which is the tell: two hand-written numbers describing one fact will drift
// apart and neither will be corrected, because nothing checks them.
//
// This does not pin an exact figure — jest's total is larger than the number of
// declarations in the files because `test.each` expands at runtime, and no
// static reader can know by how much. It pins the two things that actually went
// wrong: the README must state the count once, and that number must sit in a
// defensible band around what is really declared.
//
// The band's width is a measurement, not a taste. It was 1.3× when the suite
// declared 439 and ran 484. At 3.9.0 it declares 663 and runs 922 — a factor of
// 1.39 — because the parameterised suites now carry most of the coverage: one
// file turns 25 declarations into 133 cases by enumerating two sensors across
// nine robot states and four toggle combinations, which is the shape this repo
// keeps reaching for on purpose. So the ceiling is 1.6×, sized off 1.39 rather
// than off nothing. It still refuses an invented figure by a wide margin: the
// two numbers this file was written about, 463 and 263, would both fail it.

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
    if (distinct.length !== 1) {
      // Jest's expect takes no message argument, so this used to print a bare
      // "Expected length: 1" that told nobody which 2 numbers disagreed or
      // what to do about it. Three people have now hit this, always the same
      // way: tests were added, 1 of the 2 README claims was updated, and CI
      // was what found out — once on the release workflow itself, which left
      // npm a version behind GitHub.
      throw new Error(
        `The README states ${distinct.length} different test counts (${distinct.join(", ")}). ` +
          `Run "npm run sync:test-count" and commit the change.`
      );
    }
    expect(distinct).toHaveLength(1);
  });

  test("the stated count is consistent with what the suite declares", () => {
    const declared = declaredTests();
    const [claimed] = [...new Set(claimedCounts())];

    // Never fewer than the declarations: `test.each` only ever adds cases.
    expect(claimed).toBeGreaterThanOrEqual(declared);
    // And not a number someone made up: the expansion is real but bounded.
    expect(claimed).toBeLessThanOrEqual(Math.round(declared * 1.6));
  });
});
