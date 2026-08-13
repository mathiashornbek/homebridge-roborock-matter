"use strict";

// The Matter Pairing panel told users to do the one thing that cannot work.
//
// jawnlydon reported it in issue #7 on 13 Aug 2026, after losing a couple of
// evenings to it: to get his robot paired with a single code he had to
// *ignore and reverse* the panel's own instruction, which read "Pair the
// Roborock child/daughter bridge first, then add the external vacuum
// accessory if Apple Home asks for it."
//
// It is measured wrong on two independent setups:
//
//   * Mathias' server (`GET /api/server/pairings`): each of his three robots
//     is its own Matter node — `matter: true, matterOnly: true, isExternal:
//     true` — with its own setup code. Homebridge publishes a robotic vacuum
//     as a node of its own, so the robot never arrives *inside* the bridge
//     node, and Apple Home is therefore never in a position to "ask to add
//     the external vacuum after the bridge is paired".
//   * jawnlydon's setup: Matter is switched off for the child bridge and
//     everywhere else he could find it, with only "Allow Matter Externals"
//     left on — and his robot is paired and working over Matter anyway. The
//     bridge code was not a prerequisite for anything.
//
// So the bridge entry's code pairs the child bridge and nothing else, and
// telling a novice to scan it first hands them an empty bridge and the
// impression that the robot's own code is an optional extra.
//
// The rule is written over the surfaces rather than as two string edits,
// because that is the shape this repo keeps getting wrong: a correction
// applied to the lines someone happened to be looking at. Both halves are
// enumerated — no surface may make the robot's code conditional on the
// bridge, and every surface has to say positively that the robot's own code
// is what adds the robot. A rule with only the negative half passes the day
// somebody deletes the sentence instead of fixing it.
//
// CHANGELOG.md is deliberately not a surface: it records what past releases
// said, the old wording is quoted in it by design, and rewriting shipped
// history to satisfy a test would be the wrong repair.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");

const read = (relative) => fs.readFileSync(path.join(REPO, relative), "utf8");

/**
 * What a surface SAYS, with the markup taken off.
 *
 * The same sentence is bold in the README, wrapped in HTML on the settings
 * page and a plain string in the TypeScript. A prose rule that matches raw
 * text fails on `**Matter**` and passes on a genuinely missing instruction —
 * the trap already documented by the README claim rules.
 */
function spoken(text) {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&rsquo;|&#8217;/g, "'")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/[*_`\\]/g, "")
    .replace(/\s+/g, " ");
}

/** The Matter Pairing panel, and nothing else on the settings page. */
function matterPairingPanel() {
  const html = read("homebridge-ui/public/index.html");
  const start = html.indexOf("<h2>Matter Pairing</h2>");
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

/**
 * The per-entry hints the settings page renders under each code.
 *
 * Scoped to the hint expression rather than the whole file: the rest of
 * src/ui/index.ts is diagnostics prose, and a whole-file match would let a
 * sentence somewhere else vouch for a hint that still says the wrong thing.
 *
 * Anchored on the ternary and not on `hint:`, because the first `hint:` in
 * the file is the field's type declaration — anchoring there sliced in half
 * the class and made two assertions fail on the wrong text. An anchor that
 * matches something other than what it names is the anchor-drift trap this
 * repo has hit before, and it fails in both directions.
 */
function pairingHints() {
  const ui = read("src/ui/index.ts");
  const start = ui.search(/hint:\s*\n?\s*kind === "bridge"/);
  expect(start).toBeGreaterThan(-1);
  const end = ui.indexOf("\n    };", start);
  expect(end).toBeGreaterThan(start);
  return ui.slice(start, end);
}

/** The two hint strings: [what the bridge entry says, what a vacuum says]. */
function hintStrings() {
  const literals = pairingHints().match(/"(?:[^"\\]|\\.)*"/g) || [];
  expect(literals.length).toBeGreaterThanOrEqual(3);
  // The first literal is the "bridge" discriminator in the ternary test.
  return literals.slice(1).map((literal) => literal.slice(1, -1));
}

/** The Quick start step that tells a new user how to pair. */
function readmePairingStep() {
  const readme = read("README.md");
  const start = readme.indexOf("## Quick start");
  expect(start).toBeGreaterThan(-1);
  const end = readme.indexOf("## Live room tracking", start);
  expect(end).toBeGreaterThan(start);
  return readme.slice(start, end);
}

const SURFACES = [
  {
    name: "the settings page's Matter Pairing panel",
    text: matterPairingPanel,
  },
  { name: "the pairing hint rendered under each code", text: pairingHints },
  { name: "the README's quick start", text: readmePairingStep },
];

/**
 * Wordings that make the robot's code conditional on the bridge.
 *
 * Each one is the shape of the reported defect, not the defect's exact
 * sentence: "bridge first" catches a reordering, "asks to add" catches the
 * claim about Apple Home's behaviour, and "after the bridge is paired/
 * commissioned" catches the same claim stated as a sequence.
 */
const FORBIDDEN = [
  {
    what: "does not tell the user to pair a bridge first",
    pattern: /\b(?:pair|scan|add)[^.]{0,60}\bbridge\b[^.]{0,20}\bfirst\b/i,
  },
  {
    what: "does not tell the user to scan a code first",
    pattern: /\b(?:scan|use)\s+this[^.]{0,30}\bcode\b[^.]{0,30}\bfirst\b/i,
  },
  {
    what: "does not claim Apple Home asks to add the vacuum",
    pattern: /\basks?\s+(?:to\s+add|for\s+it)\b/i,
  },
  {
    what: "does not make the robot wait for the bridge to be paired",
    pattern: /\bafter\s+the\s+bridge\s+is\s+(?:paired|commissioned)\b/i,
  },
];

/** What every surface has to say, in any wording. */
const REQUIRED = [
  {
    what: "names the code as belonging to the robot itself",
    pattern:
      /\b(?:each\s+robot|per\s+robot|the\s+robot'?s?\s+own|its\s+own)\b/i,
  },
  {
    what: "names what that code does — it adds the robot to Apple Home",
    pattern:
      /\b(?:pairing|setup)\s+code\b[^.]{0,120}|(?:add|pair)[^.]{0,60}\b(?:pairing|setup)\s+code\b/i,
  },
];

describe("no pairing guidance makes the robot's code depend on the bridge", () => {
  const cases = SURFACES.flatMap((surface) =>
    FORBIDDEN.map((rule) => [surface.name, rule.what, surface, rule])
  );

  test.each(cases)("%s %s", (_name, _what, surface, rule) => {
    expect(spoken(surface.text())).not.toMatch(rule.pattern);
  });
});

describe("every pairing surface says the robot's own code is the one to scan", () => {
  const cases = SURFACES.flatMap((surface) =>
    REQUIRED.map((rule) => [surface.name, rule.what, surface, rule])
  );

  test.each(cases)("%s %s", (_name, _what, surface, rule) => {
    expect(spoken(surface.text())).toMatch(rule.pattern);
  });
});

describe("the rule cannot pass on an empty surface", () => {
  // Every guard here exists because the negative half of this rule is
  // satisfied perfectly by a deleted paragraph. If a slice stops matching its
  // anchors, the test has to fail rather than quietly assert nothing.
  test.each(SURFACES.map((surface) => [surface.name, surface]))(
    "%s still carries pairing guidance",
    (_name, surface) => {
      const text = spoken(surface.text());
      expect(text.length).toBeGreaterThan(80);
      expect(text).toMatch(/\bmatter\b/i);
      expect(text).toMatch(/\brobot\b/i);
    }
  );

  test("both kinds of entry still get their own hint", () => {
    // One hint for the bridge entry and one for a vacuum entry. Collapsing
    // them into a single string is how the bridge entry ends up described as
    // though it were the robot's.
    expect(hintStrings()).toHaveLength(2);
    expect(pairingHints()).toMatch(/kind === "bridge"/);
  });
});

describe("the bridge entry is honest about what its code pairs", () => {
  test("the bridge hint says the robots do not need it", () => {
    // The measured fact, and the whole point of the correction: this code
    // commissions the child bridge. On a Matter-only setup that bridge
    // carries none of this plugin's accessories, because Homebridge gives a
    // robotic vacuum a node of its own.
    const [bridgeHint] = hintStrings();
    expect(bridgeHint).toMatch(
      /\b(?:not\s+need|do\s+not\s+need|is\s+not\s+needed|need\s+it)\b/i
    );
  });

  test("the vacuum hint is unconditional", () => {
    // "Use this code if …" is what sent jawnlydon looking for the bridge
    // first. The robot's code is not a fallback for a question Apple Home
    // never asks.
    const [, vacuumHint] = hintStrings();
    expect(vacuumHint).not.toMatch(/\bif\b/i);
    expect(vacuumHint).toMatch(/\badd\b|\bpair\b/i);
  });
});
