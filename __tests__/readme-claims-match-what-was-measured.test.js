"use strict";

// Three user-facing claims in the shipped README were contradicted by
// measurements from the very users they were written for. The first two are
// the same failure — a sentence that outlived the evidence it was based on.
// The third is that failure's mirror image, and it is the easier one to miss:
// a stated *limitation* that outlived its evidence, and went on saying
// "unverified" about something a user had since gone and verified.
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
// 3. 3.4.19 replaced the promise in (1) with "whether it offers the other
//    commands as actions, or a vacuum as an automation trigger, has not been
//    verified here". True when written; false the next day. pponce went back
//    into Shortcuts (#3, 12 Aug 23:51) and found that starting a clean — all
//    rooms or a chosen set of rooms — and stopping a clean already running ARE
//    offered as automation actions. Only the return-to-dock action is absent.
//    Saying "unverified" after somebody verified it costs the user the exact
//    opposite of what a broken promise costs them: they go and install a
//    second plugin for a job this one never blocked. Both directions are
//    enumerated below, so neither can drift back.
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

/** The one automation action measured ABSENT (pponce, #3). */
const DOCK_VERBS =
  /\b(dock|docking|send(?:s|ing)? (?:the )?(?:robot|vacuum) home|return to dock)\b/i;

/**
 * Never measured by anyone, in either direction: pause and resume as actions,
 * and a vacuum as an automation *trigger*. These stay qualified until somebody
 * goes and looks — which is the state the whole feature table was in before
 * pponce did.
 */
const UNMEASURED_VERBS = /\b(pause|resume|trigger)\b/i;

/** The two actions measured PRESENT (pponce, #3, 12 Aug 23:51). */
const START_VERB = /\bstart(?:s|ing|ed)?\b/i;
const STOP_VERB = /\bstop(?:s|ping|ped)?\b/i;

/**
 * A sentence that puts docking and automations together has to deny
 * availability in its own words. `isQualified` is deliberately NOT reused
 * here: it is broad enough that "automations can start, stop and dock the
 * robot, but only from the tile" would sail through on the word "only" — and
 * now that two of the three commands genuinely ARE available, a sentence
 * listing all three is a realistic way for the dock promise to creep back.
 * Same lesson as the EXONERATION rule below: a rule about one specific claim
 * has to demand that claim's own evidence.
 */
const DOCK_DENIAL =
  /(?:does|do|did|will|would)\s*n(?:o|')t\s+(?:offer|list|include|expose|surface|have)|\b(?:is|are|was|were)\s+not\s+(?:offered|available|listed|among|on)\b|\bno\s+(?:return-to-dock|send-home|dock(?:ing)?)\s+(?:action|option)\b|\bcannot\s+(?:call|send|dock|return)\b/i;

describe("the README does not promise the automation action Apple does not offer", () => {
  test("every sentence pairing automations with docking denies it", () => {
    const claims = mentioning(plain(README), /automation/i).filter((sentence) =>
      DOCK_VERBS.test(sentence)
    );

    expect(claims.filter((sentence) => !DOCK_DENIAL.test(sentence))).toEqual(
      []
    );
  });

  test("commands nobody has measured stay qualified", () => {
    const claims = mentioning(plain(README), /automation/i).filter((sentence) =>
      UNMEASURED_VERBS.test(sentence)
    );

    expect(claims.filter((sentence) => !isQualified(sentence))).toEqual([]);
  });

  test("the rules are not passing vacuously", () => {
    // If a rewrite ever drops the subject entirely, the rules above would go
    // quiet rather than wrong. The README is expected to keep explaining the
    // gap, because a user who needs scheduled docking has to know it is the
    // one thing an automation cannot ask for.
    const paired = mentioning(plain(README), /automation/i).filter((sentence) =>
      DOCK_VERBS.test(sentence)
    );

    expect(paired.length).toBeGreaterThan(0);
  });
});

describe("the README states the automation actions measured to exist", () => {
  const AUTOMATIONS = "Automations in Apple Home";

  /**
   * Sentences in the section that claim a command IS reachable from an
   * automation. Denials are filtered out, so this demands a positive
   * statement — the exact opposite of the dock rule, and the reason a README
   * that reverts to "unverified" fails here instead of going quiet.
   */
  const claimsFor = (verb) =>
    sentences(plain(section(AUTOMATIONS))).filter(
      (sentence) =>
        /automation/i.test(sentence) &&
        verb.test(sentence) &&
        !/\b(not|cannot|unverified|never)\b|n't/i.test(sentence)
    );

  test("starting a clean is stated as an available action", () => {
    expect(claimsFor(START_VERB).length).toBeGreaterThan(0);
  });

  test("stopping a running clean is stated as an available action", () => {
    expect(claimsFor(STOP_VERB).length).toBeGreaterThan(0);
  });

  test("room selection is not dropped from the finding", () => {
    // The start action carries room selection, and that detail is what
    // decides whether an Apple Home schedule can replace the Roborock app's
    // own. Losing it in an edit would leave the finding technically present
    // and practically useless.
    expect(plain(section(AUTOMATIONS))).toMatch(/room/i);
  });

  test("the measurement is attributed, not asserted", () => {
    expect(section(AUTOMATIONS)).toMatch(/issues\/3\b/);
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
