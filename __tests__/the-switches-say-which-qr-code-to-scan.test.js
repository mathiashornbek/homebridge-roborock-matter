"use strict";

// The switches shipped in 3.5.0 with one sentence about pairing buried in a
// paragraph of caveats, and the sentence was not even the whole truth. On
// Mathias' own server the plugin's child bridge carried `hap: { enabled:
// false }` — the Matter-only setup had switched the HomeKit half of that
// bridge off, quite reasonably, because until 3.5.0 the plugin published
// nothing over HAP. So three switches registered, the log said they were
// added, Homebridge was happy, and there was no QR code anywhere in the
// product that would have made them appear.
//
// That is the worst shape a feature can fail in: everything reports success
// and the user is left hunting. It cost the maintainer of this plugin an
// afternoon on his own house, which is the cheapest possible way to find out.
//
// The rule is enumerated over the surfaces rather than written once, because
// the failure was that only one surface mentioned pairing at all. Every place
// that offers the feature has to also say which QR code makes it work, and
// name the two codes that look right and are not.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");

const read = (relative) => fs.readFileSync(path.join(REPO, relative), "utf8");

/**
 * What the surface SAYS, with the markup taken off.
 *
 * The rule is about wording, and the same sentence is bold in the README,
 * wrapped in `<strong>` on the settings page and plain in the log. Matching
 * raw text would fail the settings page for `not the main` being written
 * `<strong>not</strong> the main`, which is a formatting difference and not a
 * missing instruction — exactly the trap the README's own claim rules
 * documented when a bolded phrase broke a prose rule.
 */
function spoken(text) {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&rsquo;|&#8217;/g, "'")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/[*_`\\]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Every surface a user can meet the switches on.
 *
 * The plugin source is in the list on purpose: the settings page is only read
 * by someone who already went looking, while the log is read by someone who
 * turned the feature on and is now wondering where it went.
 */
const SURFACES = [
  { name: "the README", source: () => read("README.md") },
  { name: "the settings schema", source: () => read("config.schema.json") },
  {
    name: "the settings page",
    source: () => read("homebridge-ui/public/index.html"),
  },
  { name: "the startup log", source: () => read("src/platform.ts") },
];

/** The three things a user has to be told, in any wording. */
const REQUIREMENTS = [
  {
    what: "names the Child Bridge Config screen",
    pattern: /child\s*bridge\s*config/i,
  },
  {
    what: "names the Enable HAP toggle",
    pattern: /enable\s*hap/i,
  },
  {
    what: "names the Connect to HomeKit action that reveals the QR code",
    pattern: /connect\s*to\s*homekit/i,
  },
  {
    what: "rules out the robot's Matter code",
    pattern: /not\s+the\s+(?:robot'?s?\s+)?matter\s+pairing\s+code/i,
  },
  {
    what: "rules out the main Homebridge code",
    pattern: /not\s+the\s+main\s+homebridge\s+qr\s+code/i,
  },
];

describe("every surface that offers the switches says which QR code to scan", () => {
  const cases = SURFACES.flatMap((surface) =>
    REQUIREMENTS.map((requirement) => [
      surface.name,
      requirement.what,
      surface,
      requirement,
    ])
  );

  test.each(cases)("%s %s", (_surfaceName, _what, surface, requirement) => {
    expect(spoken(surface.source())).toMatch(requirement.pattern);
  });
});

describe("the startup line answers the situation the user is actually in", () => {
  const platform = read("src/platform.ts");

  test("the HAP-disabled case is a warning, not an info line", () => {
    // An info line about a feature that cannot work is indistinguishable from
    // the ninety other info lines a Homebridge start produces.
    const hint = platform.slice(
      platform.indexOf("private logActionSwitchPairingHint"),
      platform.indexOf("private removeActionSwitches")
    );

    expect(hint).toMatch(/hap\?\.enabled === false/);
    const disabledBranch = hint.slice(hint.indexOf("hap?.enabled === false"));
    expect(disabledBranch).toMatch(/log\.warn/);
  });

  test("all three bridge situations are answered separately", () => {
    const hint = platform.slice(
      platform.indexOf("private logActionSwitchPairingHint"),
      platform.indexOf("private removeActionSwitches")
    );

    // No child bridge at all, child bridge with HAP off, child bridge with HAP
    // on. One paragraph covering all three would send two thirds of readers
    // to the wrong screen.
    expect(hint).toMatch(/main Homebridge bridge/);
    expect(hint).toMatch(/turned OFF/);
    expect(hint).toMatch(/paired with Apple Home separately/);
  });

  test("it is written once per start, not once per discovery pass", () => {
    // discoverDevices runs again on every reconnection; a five-line pairing
    // paragraph on repeat is how a useful warning becomes log noise people
    // filter out.
    expect(platform).toMatch(/actionSwitchPairingHintLogged/);
    const hint = platform.slice(
      platform.indexOf("private logActionSwitchPairingHint"),
      platform.indexOf("private removeActionSwitches")
    );
    expect(hint).toMatch(/if \(this\.actionSwitchPairingHintLogged\)/);
  });

  test("nothing is said when no switch was published", () => {
    // A user who never turned the feature on must not be told how to pair it.
    const sync = platform.slice(
      platform.indexOf("private syncActionSwitches"),
      platform.indexOf("private removeActionSwitches")
    );
    expect(sync).toMatch(
      /if \(wanted\.size > 0\) \{\s*this\.logActionSwitchPairingHint/
    );
  });
});

describe("the settings page keeps the pairing steps next to the switch", () => {
  const html = read("homebridge-ui/public/index.html");
  const js = read("homebridge-ui/public/index.js");

  test("the callout exists and is tied to the feature toggle", () => {
    expect(html).toMatch(/id="homekit-switch-pairing"/);
    // Shown when the feature is on, hidden when it is off: pairing steps for a
    // feature you have not enabled are noise, and noise is what gets skipped.
    expect(js).toMatch(/homeKitSwitchPairing/);
    expect(js).toMatch(/classList\.toggle\("hidden", !on\)/);
  });

  test("it explains why the Matter code is not enough", () => {
    // Without the reason, a user who has already paired the robot reasonably
    // concludes the instruction does not apply to them.
    expect(html).toMatch(/Matter/);
    expect(html).toMatch(/HomeKit/);
    expect(html).toMatch(/paired separately|paired\s+separately/i);
  });
});
