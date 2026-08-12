"use strict";

// Two user-facing claims in the shipped README were contradicted by
// measurements from the very users they were written for, and both are the
// same failure: a sentence that outlived the evidence it was based on.
//
// 1. The feature table offered "Start, stop, pause and send the robot home to
//    its dock — from the Home app, Siri, or automations". Nobody had ever
//    checked the last word. pponce measured it in issue #3: Apple Home does
//    not offer "send the vacuum to its dock" as an automation *action* for a
//    Matter vacuum, which is why he had to leave for a HAP-switch plugin.
//
// 2. The fault-reporting section said publishing the fault attribute sent the
//    tile "into a stuck 'Updating…' that needed a manual poke to clear".
//    Wazza151 then ran the controlled test on the same S8 Pro Ultra with both
//    switches on and a genuinely empty tank (issue #5, 12 Aug): the tile
//    stayed Ready for the whole test. The wedge was a stale pairing from an
//    earlier install — which the Troubleshooting section already says — not
//    this setting. The README was blaming a plugin feature for a controller
//    cache bug.
//
// These rules are prose rules, which is unusual here, and the shape is chosen
// deliberately: a sentence may still *discuss* automations or "Updating", it
// just may not make the positive claim that was measured false. That way an
// honest correction passes and a re-introduced promise fails. The wording is
// not decoration — it is what a user picks the plugin for, and in pponce's
// case what he picked it for and did not get.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const README = fs.readFileSync(path.join(REPO, "README.md"), "utf8");

/** Naive sentence split — good enough for prose, and never empty. */
function sentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\n{2,}|\n(?=[-|#])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function mentioning(text, pattern) {
  return sentences(text).filter((sentence) => pattern.test(sentence));
}

/**
 * Does the sentence limit or deny, rather than promise? Kept broad on
 * purpose: the point is to allow every honest phrasing of "this does not
 * work / has not been verified" and reject only the bare promise.
 */
function isQualified(sentence) {
  return /\b(not|n't|cannot|never|no longer|without|unverified|instead of|limit(?:ed|ation)?s?|caveat|only)\b/i.test(
    sentence
  );
}

/**
 * Prose with markdown emphasis removed. A rule about what the README *says*
 * must not fail because a phrase was bolded: "Matter **Error** state" and
 * "Matter Error state" are the same claim, and the first shape broke this
 * file's own rule the moment the section was rewritten.
 */
function plain(text) {
  return text.replace(/[*_`]+/g, "");
}

/** The body of one `## Heading` section, heading line excluded. */
function section(heading) {
  const lines = README.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

const CONTROL_VERBS =
  /\b(start|stop|pause|resume|dock|docking|send the (?:robot|vacuum) home)\b/i;

describe("the README does not promise control through Apple Home automations", () => {
  test("every sentence that pairs automations with a command is qualified", () => {
    const claims = mentioning(README, /automation/i).filter((sentence) =>
      CONTROL_VERBS.test(sentence)
    );

    // pponce's measurement is the only evidence we have about Apple's
    // automation actions, and it is negative. Anything unqualified here is a
    // promise we cannot keep.
    expect(claims.filter((sentence) => !isQualified(sentence))).toEqual([]);
  });

  test("the rule is not passing vacuously", () => {
    // If a rewrite ever drops the subject entirely, the rule above would go
    // quiet rather than wrong. The README is expected to keep explaining the
    // limitation, because a user who needs scheduled docking has to know.
    expect(mentioning(README, /automation/i).length).toBeGreaterThan(0);
    expect(mentioning(README, CONTROL_VERBS).length).toBeGreaterThan(0);
  });
});

describe("the README does not blame fault reporting for the stuck tile", () => {
  const FAULTS = "Why the robot needs attention";

  // Deliberately NOT the broad `isQualified` used above. The first version of
  // this rule reused it and passed green against the very sentence it was
  // written to catch: that sentence also contains "does not work" (about
  // Apple drawing nothing), so a generic negation check waved the claim
  // through. A rule about one specific claim has to demand that claim's own
  // evidence, not merely the presence of a negative word somewhere nearby.
  const EXONERATION =
    /stale pairing|earlier install|previous install|stayed (?:in )?Ready|not (?:caused|this setting|the fault)/i;

  test('any mention of "Updating" in the fault section names the real cause', () => {
    const claims = mentioning(section(FAULTS), /Updating/).filter(
      (sentence) => !EXONERATION.test(sentence)
    );

    // The measured record: fault published beside Charging -> nothing drawn;
    // fault published beside a forced Error -> nothing drawn, and the tile
    // stayed Ready for the whole test. The tile never wedged.
    expect(claims).toEqual([]);
  });

  test("the stuck tile is still explained where it belongs", () => {
    // Removing the wrong cause must not remove the right one: a user whose
    // tile is wedged still needs the pairing answer.
    const troubleshooting = section("Troubleshooting");
    expect(troubleshooting).toMatch(/Updating/);
    expect(troubleshooting).toMatch(/pair/i);
  });
});

describe("the fault section's evidence is stated, not implied", () => {
  test("it names the state the fault was published beside", () => {
    const faults = plain(section("Why the robot needs attention"));

    // Both halves of the test matter and only one of them is intuitive: the
    // fault was ignored beside a Charging state AND beside an Error state.
    // Without the second half a reader would reasonably assume the fault was
    // dropped for contradicting a charging robot, and would try again.
    expect(faults).toMatch(/Charging/);
    expect(faults).toMatch(/Error state/);
  });
});
