#!/usr/bin/env node
// Rewrite every test-count claim in the README from the suite's real total.
//
// The README states the count in 2 places — a feature bullet and the
// contributing section — and `__tests__/readme-test-count-is-not-invented.js`
// requires them to agree. That trap has now caught somebody 3 times: the
// original 463-versus-263 the test was written about, and twice on 21 August
// 2026 alone, once by hand and once by the maintenance job. The second of
// those failed the publish workflow on its own release and left npm a version
// behind GitHub until it was noticed.
//
// Each time the fix was to retype the number, which restores the trap. The
// number is derived data, so this makes it derived by a command:
//
//   npm run sync:test-count
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const README = new URL("../README.md", import.meta.url);
const CLAIM = /([\d,]+)(\s+(?:automated\s+)?tests\b)/g;
const report = join(tmpdir(), `jest-count-${process.pid}.json`);

let total;
try {
  execFileSync(
    "npx",
    ["jest", "--silent", "--ci", "--json", `--outputFile=${report}`],
    { stdio: ["ignore", "ignore", "ignore"] }
  );
} catch {
  // A red suite still writes the report, and the count is still the truth
  // about how many tests there are. Fixing the README is not the same job as
  // fixing a failing test, so this does not refuse to run.
}
try {
  total = JSON.parse(readFileSync(report, "utf8")).numTotalTests;
} finally {
  rmSync(report, { force: true });
}

if (!Number.isInteger(total) || total <= 0) {
  console.error("Could not read numTotalTests from jest's report.");
  process.exit(1);
}

const before = readFileSync(README, "utf8");
const claims = [...before.matchAll(CLAIM)].map((match) => match[1]);
const after = before.replace(CLAIM, `${total}$2`);

if (after === before) {
  console.log(`README already states ${total} in all ${claims.length} places.`);
  process.exit(0);
}
writeFileSync(README, after);
console.log(
  `README test count -> ${total} (was ${[...new Set(claims)].join(", ")}) in ${claims.length} places.`
);
