"use strict";

// The settings page stayed white inside a dark Homebridge, in every version.
//
// It is not the operating system's setting that decides. Homebridge UI reaches
// into this plugin's iframe and mutates our own `<body>`: in dark mode it adds
// `dark-mode` and `config-ui-x-dark-mode-<theme>`, in light mode
// `config-ui-x-<theme>`. (It also assigns
// `body.style.backgroundColor = "#242424 !important"`, which the CSSOM drops
// on the floor because a property value may not carry `!important` — so that
// line has never done anything, and the class is the only signal there is.)
// The stylesheet had `color-scheme: light` hard-coded and one set of colours,
// so it could not follow anything.
//
// These are source rules rather than DOM tests because that is what this suite
// can run, and because each defect is visible in the source shape. They
// enumerate the rule, not the four or five places that happened to be wrong:
// one hard-coded hex added later is all it takes to put unreadable text
// somewhere nobody scrolls to.

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const UI = path.join(REPO, "homebridge-ui", "public");

const css = fs.readFileSync(path.join(UI, "styles.css"), "utf8");
const js = fs.readFileSync(path.join(UI, "index.js"), "utf8");
const html = fs.readFileSync(path.join(UI, "index.html"), "utf8");

/**
 * The body of a `selector { ... }` rule, first match only, or "" if the rule
 * is not there.
 *
 * Deliberately not asserting here: these are read at module scope, and a
 * throw at import time reports "0 tests" instead of a failure, which is
 * exactly the signal you do not want when checking a fix red against the
 * previous release.
 */
function ruleBody(selector) {
  const start = css.indexOf(selector + " {");
  if (start === -1) {
    return "";
  }
  const open = css.indexOf("{", start);
  const close = css.indexOf("\n}", open);
  return css.slice(open + 1, close);
}

/** `--name` declarations in a rule body, in order. */
function tokenNames(body) {
  return (body.match(/^\s*(--[a-z0-9-]+):/gm) || []).map((line) =>
    line.trim().replace(":", "")
  );
}

const LIGHT = ruleBody(":root");
const DARK = ruleBody(':root[data-theme="dark"]');

describe("there is one set of colours and one dark override of it", () => {
  test("both blocks exist at all", () => {
    expect(LIGHT).not.toBe("");
    expect(DARK).not.toBe("");
  });

  test("both sets declare exactly the same token names", () => {
    // A token added to light and forgotten in dark is invisible until somebody
    // switches theme, which is the whole class of bug being fixed here.
    expect(tokenNames(DARK).sort()).toEqual(tokenNames(LIGHT).sort());
    expect(tokenNames(LIGHT).length).toBeGreaterThan(20);
  });

  test("each set declares its own color-scheme", () => {
    // Without it the browser paints native controls, scrollbars and the
    // autofill background for the wrong theme even when everything else is
    // right.
    expect(LIGHT).toMatch(/color-scheme:\s*light;/);
    expect(DARK).toMatch(/color-scheme:\s*dark;/);
  });

  test("no rule outside the two token blocks carries a colour literal", () => {
    const outside = css.replace(LIGHT, "").replace(DARK, "");
    const literals =
      outside.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) || [];
    // The one allowed exception, and it is deliberate: a QR code needs a light
    // quiet zone or a camera cannot read it, so that tile stays white in both
    // themes. It is asserted by name so the exemption cannot quietly grow.
    expect(literals).toEqual(["#ffffff"]);
    expect(css).toMatch(
      /A QR code needs a light[\s\S]{0,120}background: #ffffff;/
    );
  });

  test("the dark set is not achieved with extra rules", () => {
    // Anything that needs to differ in dark mode differs as a token. A second
    // `[data-theme="dark"] .something { ... }` rule is how two stylesheets
    // start living in one file.
    const overrides = css.match(/\[data-theme="dark"\][^{]*\{/g) || [];
    expect(overrides).toEqual(['[data-theme="dark"] {']);
  });
});

describe("the theme comes from Homebridge, with the OS only as a fallback", () => {
  test("it reads the class Homebridge actually sets", () => {
    expect(js).toMatch(/const DARK_CLASS = "dark-mode";/);
    expect(js).toMatch(/config-ui-x-/);
  });

  test("a Homebridge light theme beats a dark OS", () => {
    // The precedence is the point: someone who picked light in Homebridge on a
    // dark Mac meant light. Falling straight through to matchMedia would
    // override them.
    const body = js.slice(
      js.indexOf("function applyTheme()"),
      js.indexOf("function watchTheme()")
    );
    expect(body).toMatch(/classList\.contains\(DARK_CLASS\)/);
    expect(body).toMatch(/homebridgeHasChosenATheme\(\)/);
    expect(body).toMatch(/prefersDark\(\)/);
    expect(body.indexOf("homebridgeHasChosenATheme()")).toBeLessThan(
      body.indexOf("prefersDark()")
    );
  });

  test("the answer is written where the stylesheet reads it", () => {
    expect(js).toMatch(/document\.documentElement\.dataset\.theme/);
  });

  test("it keeps following the theme after the first paint", () => {
    // The switch is one screen away in the same UI, and the parent applies it
    // by mutating our body's class rather than reloading the iframe.
    const body = js.slice(js.indexOf("function watchTheme()"));
    expect(body).toMatch(/new MutationObserver\(applyTheme\)/);
    expect(body).toMatch(/attributeFilter: \["class"\]/);
    expect(body).toMatch(/addEventListener\("change", applyTheme\)/);
  });

  test("it runs before anything else on the page", () => {
    const init = js.slice(js.indexOf("function init() {"));
    const end = init.indexOf("\n}");
    const first = init.slice(0, end);
    expect(first).toMatch(/watchTheme\(\);/);
    expect(first.indexOf("watchTheme()")).toBeLessThan(
      first.indexOf("syncActionSwitchAvailability()")
    );
  });
});

describe("the header carries the plugin's own icon", () => {
  test("the file served to the page is the icon, byte for byte", () => {
    // Not a redrawing and not a resize: a second copy drifts from the first
    // the moment either is touched, and then the tile here and the tile on the
    // Homebridge plugin list stop matching. The whole file is a hundred
    // kilobytes served over the LAN once per page open, which is a price worth
    // paying for a guarantee instead of a resemblance.
    const source = fs.readFileSync(path.join(REPO, "assets", "icon.png"));
    const served = fs.readFileSync(path.join(UI, "icon.png"));
    expect(served.equals(source)).toBe(true);
  });

  test("it is in the header, beside the title", () => {
    const header = html.slice(
      html.indexOf("<header"),
      html.indexOf("</header>")
    );
    expect(header).toMatch(/class="brand-mark"/);
    expect(header).toMatch(/src="icon\.png"/);
    expect(header).toMatch(/<h1>Roborock Vacuum<\/h1>/);
  });

  test("it is decorative, so a screen reader reads the heading instead", () => {
    expect(html).toMatch(/class="brand-mark"[\s\S]{0,120}alt=""/);
  });

  test("the header lays out as a row and shrinks on a phone", () => {
    expect(css).toMatch(
      /\.page-header \{[\s\S]{0,120}display: flex;[\s\S]{0,120}\}/
    );
    const small = css.slice(css.indexOf("@media (max-width: 640px)"));
    expect(small).toMatch(/\.brand-mark \{[\s\S]{0,80}width: 44px;/);
  });
});
