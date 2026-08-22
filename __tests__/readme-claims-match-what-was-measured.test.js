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

/**
 * A denial in the claim's own words, one per absent finding.
 *
 * Deliberately not the broad `isQualified`: it is loose enough that
 * "automations can start, pause, stop and dock the robot, but only from the
 * tile" would sail through on the word "only" — and now that three of the four
 * commands genuinely ARE available, a sentence listing all four is a realistic
 * way for the dock promise to creep back.
 */
const DOCK_DENIAL =
  /(?:does|do|did|will|would)\s*n(?:o|')t\s+(?:offer|list|include|expose|surface|have)|\b(?:is|are|was|were)\s+not\s+(?:offered|available|listed|among|on)\b|\bno\s+(?:return-to-dock|send-home|dock(?:ing)?)\s+(?:action|option)\b|\bcannot\s+(?:call|send|dock|return)\b/i;

const TRIGGER_DENIAL =
  /\b(?:is|are|was|were)\s+not\s+(?:offered|available|selectable|listed)\b|(?:could|can|does|do|would)\s*n(?:o|')t\s+(?:be\s+)?(?:select|choose|pick|appear|offer)|\bnot\s+expressible\b/i;

/**
 * Everything anyone has measured about Apple's automation editor, and
 * everything nobody has.
 *
 * A registry rather than a constant per finding, because the drift this file
 * exists to stop has now happened twice in three days and both times the same
 * way: a measurement arrived, one place was updated, and a second place went
 * on describing the same fact the old way. 3.4.19 said "has not been verified
 * here" about the entire action list, and pponce verified two of it that
 * evening. 3.5.0 corrected those two and left "pause ... and whether a vacuum
 * can act as an automation trigger ... are still unverified" standing — eight
 * minutes, as it turned out, before he measured both of those too.
 *
 * Saying "unverified" after somebody verified it costs the user the exact
 * opposite of what a broken promise costs them: they go and install a second
 * plugin for a job this one never blocked. So both directions are enumerated,
 * and adding a row is the whole edit.
 */
const MEASURED = [
  {
    key: "start",
    name: "starting a clean",
    verb: /\bstart(?:s|ing|ed)?\b/i,
    verdict: "offered",
  },
  {
    key: "stop",
    name: "stopping a running clean",
    verb: /\bstop(?:s|ping|ped)?\b/i,
    verdict: "offered",
  },
  {
    key: "pause",
    name: "pausing a running clean",
    verb: /\bpaus(?:e|es|ing|ed)\b/i,
    verdict: "offered",
  },
  {
    key: "dock",
    name: "sending the robot to its dock",
    verb: /\b(?:dock|docking|send(?:s|ing)? (?:the )?(?:robot|vacuum) home|return to dock)\b/i,
    verdict: "absent",
    denial: DOCK_DENIAL,
  },
  {
    key: "trigger",
    name: "a vacuum as an automation trigger",
    verb: /\btrigger\b/i,
    verdict: "absent",
    denial: TRIGGER_DENIAL,
  },
];

const UNMEASURED = [
  {
    key: "resume",
    name: "resuming a clean",
    verb: /\bresum(?:e|es|ing|ed)\b/i,
  },
];

const AUTOMATIONS_HEADING = "Automations in Apple Home";

/** Sentences anywhere in the README that pair automations with `verb`. */
function automationSentencesAbout(verb) {
  return mentioning(plain(README), /automation/i).filter((sentence) =>
    verb.test(sentence)
  );
}

describe("the README matches the automation measurements on record", () => {
  test("no command is listed as both measured and unmeasured", () => {
    // The 3.5.0 miss in one assertion: pause was being stated as available in
    // one bullet while the bullet below it still called pause unverified.
    const keys = [...MEASURED, ...UNMEASURED].map((entry) => entry.key);
    expect(keys).toHaveLength(new Set(keys).size);

    const clashes = MEASURED.flatMap((measured) =>
      UNMEASURED.filter(
        (unmeasured) =>
          unmeasured.verb.test(measured.name) ||
          measured.verb.test(unmeasured.name)
      ).map((unmeasured) => `${measured.key} / ${unmeasured.key}`)
    );
    expect(clashes).toEqual([]);
  });

  test.each([...MEASURED, ...UNMEASURED].map((entry) => [entry.name, entry]))(
    "%s is discussed at all",
    (_name, entry) => {
      // A finding dropped in an edit would leave every rule below it green and
      // quiet. Whatever the section says about a row, it has to say something.
      expect(entry.verb.test(plain(section(AUTOMATIONS_HEADING)))).toBe(true);
    }
  );

  test.each(
    MEASURED.filter((entry) => entry.verdict === "offered").map((entry) => [
      entry.name,
      entry,
    ])
  )("%s is stated as an available automation action", (_name, entry) => {
    // Demands a positive statement, which is why a README that quietly
    // reverts to "unverified" fails here instead of going quiet.
    const positive = sentences(plain(section(AUTOMATIONS_HEADING))).filter(
      (sentence) =>
        /automation/i.test(sentence) &&
        entry.verb.test(sentence) &&
        !/\b(not|cannot|unverified|never)\b|n't/i.test(sentence)
    );

    expect(positive.length).toBeGreaterThan(0);
  });

  test.each(
    MEASURED.filter((entry) => entry.verdict === "absent").map((entry) => [
      entry.name,
      entry,
    ])
  )("%s is denied wherever it meets an automation", (_name, entry) => {
    const claims = automationSentencesAbout(entry.verb);

    expect(claims.filter((sentence) => !entry.denial.test(sentence))).toEqual(
      []
    );
  });

  test.each(
    MEASURED.filter((entry) => entry.verdict === "absent").map((entry) => [
      entry.name,
      entry,
    ])
  )("%s is stated as absent, not merely left out", (_name, entry) => {
    // The rule above is satisfied by silence. A user who needs this has to be
    // told it is missing, not left to infer it from an absence of promises.
    expect(automationSentencesAbout(entry.verb).length).toBeGreaterThan(0);
  });

  test.each(UNMEASURED.map((entry) => [entry.name, entry]))(
    "%s stays qualified until somebody measures it",
    (_name, entry) => {
      const claims = automationSentencesAbout(entry.verb);

      expect(claims.filter((sentence) => !isQualified(sentence))).toEqual([]);
    }
  );

  test("room selection is not dropped from the start finding", () => {
    // The start action carries room selection, and that detail is what decides
    // whether an Apple Home schedule can replace the Roborock app's own.
    // Losing it in an edit would leave the finding technically present and
    // practically useless.
    expect(plain(section(AUTOMATIONS_HEADING))).toMatch(/room/i);
  });

  test("the measurements are attributed, not asserted", () => {
    expect(section(AUTOMATIONS_HEADING)).toMatch(/issues\/3\b/);
  });

  test("each gap names the accessory that closes it", () => {
    // Both absent findings now have an answer in the product, and each answer
    // is a different accessory: a switch for the missing dock ACTION, a
    // read-only sensor for the missing TRIGGER. Stating a gap without naming
    // its answer is how a user concludes the plugin cannot do the thing it
    // ships a feature for — the same cost as the reverse mistake this file was
    // written about, arriving from the other side.
    const automations = plain(section(AUTOMATIONS_HEADING));

    expect(automations).toMatch(/switch(?:es)?\b/i);
    expect(automations).toMatch(/contact sensor/i);
    // And the sensors have to be named, or "a sensor exists somewhere" is all
    // the reader gets.
    expect(automations).toMatch(/Docked/);
    expect(automations).toMatch(/Cleaning/);
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

// The Troubleshooting section used to answer the single most-reported symptom
// in this project — a tile stuck on "Updating…" — by telling the user to
// unpair the robot and pair it again. That is the right cure for exactly one
// of the two causes on record, and it is the expensive one: it costs the user
// their rooms, their tile name and every automation pointing at it.
//
// Two users have since measured the other cause, and both times the plugin was
// provably innocent while the advice was still sending them to a teardown.
// jawnlydon (#7) had the tile alive on a Mac and dead on an iPhone at the same
// moment for nine days; iOS 26.6.1 fixed it with no change on this side.
// noppie (#11) reported the same asymmetry on 22 Aug and a plain iPhone
// restart cleared it — he had been offered the full teardown first, and it
// would have cost him an evening and taught him nothing.
//
// So the discriminator is not Apple's choice of words, which varies between
// "Updating…" and "No Response" for the same condition. It is whether a
// SECOND controller in the same Home draws the tile correctly at that same
// moment: if one does, the node is healthy and re-pairing cannot help.
//
// These rules encode the ladder rather than the prose. The section may be
// rewritten freely as long as the cheap remedy still comes before the
// destructive one and the destructive one still names the condition that makes
// it the right answer.
describe("the Updating tile is triaged controller-first", () => {
  const troubleshooting = () => plain(section("Troubleshooting"));

  /** "on every Apple device", however the sentence chooses to say it. */
  const EVERY_CONTROLLER =
    /\b(?:every|all|both|no)\b[^.]*\b(?:Apple\s+)?(?:device|controller|client|phone)s?\b/i;

  test("the two Apple wordings are named as one symptom", () => {
    // Keyed separately, a user whose tile says "Updating" reads only the
    // teardown entry and never reaches the controller-side one — which is
    // precisely what happened to noppie.
    const together = sentences(troubleshooting()).filter(
      (sentence) => /Updating/i.test(sentence) && /No Response/i.test(sentence)
    );

    expect(together.length).toBeGreaterThan(0);
  });

  test("a second controller is named as the thing that decides it", () => {
    expect(troubleshooting()).toMatch(
      /second Apple device|another controller|second controller/i
    );
  });

  test("restarting the controller is offered as a remedy", () => {
    const restart = sentences(troubleshooting()).filter(
      (sentence) =>
        /\brestart(?:ing)?\b/i.test(sentence) &&
        /\b(?:Apple device|iPhone|iPad|controller)\b/i.test(sentence)
    );

    expect(restart.length).toBeGreaterThan(0);
  });

  test("the restart is offered before the teardown", () => {
    // Order is the whole point of this block. A section that lists both but
    // leads with the unpair is the section we already had.
    const section_ = troubleshooting();
    const restart = section_.search(/\brestart the Apple device\b/i);
    const teardown = section_.search(/\bremove the robot from Apple Home\b/i);

    expect(restart).toBeGreaterThanOrEqual(0);
    expect(teardown).toBeGreaterThan(restart);
  });

  test("the teardown names the condition that makes it the right cure", () => {
    // Not "is it mentioned" but "is it conditioned": an unqualified
    // instruction to unpair is the defect, whatever else the section says.
    const prescriptions = sentences(troubleshooting()).filter(
      (sentence) =>
        /\b(?:remove|unpair)\b[^.]*\bApple Home\b/i.test(sentence) ||
        /\bApple Home\b[^.]*\b(?:remove|unpair)\b/i.test(sentence)
    );

    expect(prescriptions.length).toBeGreaterThan(0);
    expect(
      prescriptions.filter((sentence) => !EVERY_CONTROLLER.test(sentence))
    ).toEqual([]);
  });

  test("the teardown keeps the order that made it work", () => {
    // A re-pair on top of the existing install did not work for Wazza151. Drop
    // the uninstall step and the remedy stops being the remedy.
    expect(troubleshooting()).toMatch(/uninstall/i);
  });

  test("both controller-side findings are attributed", () => {
    const section_ = section("Troubleshooting");

    expect(section_).toMatch(/issues\/7\b/);
    expect(section_).toMatch(/issues\/11\b/);
  });

  test("the iOS version that fixed it is still named", () => {
    expect(troubleshooting()).toMatch(/26\.6\.1/);
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
