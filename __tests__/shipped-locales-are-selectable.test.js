"use strict";

// Eleven locale directories shipped in every npm install for months. Ten of
// them could never load: `this.language` is only ever set from
// `options.language`, the sole production construction site passes none, the
// UI server hardcodes "en", and no config key exposes the choice. So 78 KB of
// translations reached every user's disk to sit unread.
//
// Deleting them fixes today. This test fixes tomorrow: it enumerates the rule
// rather than the ten filenames, so a locale added later fails until there is
// actually a way to select it. That is the same shape as the log-line rule —
// a hand-written list of what is wrong right now is not a rule.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const I18N = path.join(REPO, "roborockLib", "i18n");

/** The locale the API falls back to when none is configured. */
function defaultLocale() {
  const source = fs.readFileSync(
    path.join(REPO, "roborockLib", "roborockAPI.js"),
    "utf8"
  );
  const match =
    /this\.language\s*=\s*options\.language\s*\|\|\s*"([\w-]+)"/.exec(source);
  expect(match).not.toBeNull();
  return match[1];
}

/** Locales a user could actually pick, from the settings schema. */
function selectableLocales() {
  const schema = JSON.parse(
    fs.readFileSync(path.join(REPO, "config.schema.json"), "utf8")
  );
  const found = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    for (const [key, value] of Object.entries(node)) {
      if (key === "language" && value && Array.isArray(value.enum)) {
        value.enum.forEach((locale) => found.add(String(locale)));
      }
      walk(value);
    }
  };
  walk(schema);
  return found;
}

describe("every locale that ships can actually be loaded", () => {
  test("no locale directory exists that no user can reach", () => {
    const shipped = fs
      .readdirSync(I18N, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(shipped.length).toBeGreaterThan(0);

    const reachable = selectableLocales();
    reachable.add(defaultLocale());

    const unreachable = shipped.filter((locale) => !reachable.has(locale));
    expect(unreachable).toEqual([]);
  });

  test("the fallback locale is one that exists on disk", () => {
    // The require is built from a template string, so a missing directory is
    // a crash at first status poll rather than a build error.
    expect(fs.existsSync(path.join(I18N, defaultLocale()))).toBe(true);
  });

  test("the shipped locale carries the keys the code looks up", () => {
    const translations = JSON.parse(
      fs.readFileSync(
        path.join(I18N, defaultLocale(), "translations.json"),
        "utf8"
      )
    );
    // The lookups are dynamic (`this.translations[state]`), so a truncated
    // file surfaces as `undefined` in a device name rather than as an error.
    // A couple of real keys plus a floor on the count is enough to catch a
    // file that got emptied or half-written.
    expect(typeof translations.set_water_box_custom_mode).toBe("string");
    expect(typeof translations.water_box_custom_mode_200).toBe("string");
    expect(Object.keys(translations).length).toBeGreaterThan(150);
  });
});
