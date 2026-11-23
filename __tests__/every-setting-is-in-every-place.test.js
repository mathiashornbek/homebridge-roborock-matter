"use strict";

// A setting lives in four places: config.schema.json (what Homebridge
// accepts), RoborockPlatformConfig in src/types.ts (what the code may read),
// and the settings page — its form, or, for the Matter feature toggles that
// 3.12.0 took off the form on purpose so a save can never turn one off, the
// diagnostic report. The review of 3.39.0 found the dock-phase toggle in the
// schema and read by the code but missing from the types and the report, and
// the schedule and Routine switches missing from the report, so a bug report
// could not show they were on. This pins the rule, not the cases.

const fs = require("fs");
const path = require("path");

const { loadSettingsPage } = require("../test-support/settings-page");

const REPO = path.join(__dirname, "..");
const schema = require("../config.schema.json").schema.properties;
const typesSource = fs.readFileSync(path.join(REPO, "src", "types.ts"), "utf8");
const pageSource = fs.readFileSync(
  path.join(REPO, "homebridge-ui", "public", "index.js"),
  "utf8"
);
const pageMarkup = fs.readFileSync(
  path.join(REPO, "homebridge-ui", "public", "index.html"),
  "utf8"
);
const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");

// Homebridge's own PlatformConfig field.
const HOMEBRIDGE_KEYS = new Set(["name"]);
// Read only to log that it is ignored (Matter-only edition).
const LEGACY_KEYS = new Set(["enableMatter"]);

function declaredConfigKeys() {
  const body = typesSource.match(
    /export interface RoborockPlatformConfig extends PlatformConfig \{([\s\S]*?)\n\}/
  )[1];
  return [...body.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1]);
}

function keysReadBySrc() {
  const keys = new Set();
  for (const file of fs.readdirSync(path.join(REPO, "src"))) {
    if (!file.endsWith(".ts")) continue;
    const source = fs.readFileSync(path.join(REPO, "src", file), "utf8");
    for (const m of source.matchAll(/platformConfig\??\.(\w+)/g)) {
      keys.add(m[1]);
    }
  }
  return [...keys];
}

const schemaKeys = Object.keys(schema).filter((k) => !HOMEBRIDGE_KEYS.has(k));

test("every schema setting is declared in the config type, and the other way round", () => {
  expect(declaredConfigKeys().sort()).toEqual([...schemaKeys].sort());
});

test("every setting the code reads is in the schema", () => {
  const unknown = keysReadBySrc().filter(
    (key) => !schemaKeys.includes(key) && !LEGACY_KEYS.has(key)
  );
  expect(unknown).toEqual([]);
});

test("every schema setting is on the settings page, on the form or in the report", () => {
  const missing = schemaKeys.filter(
    (key) =>
      !new RegExp(`\\bconfig\\.${key}\\b|\\b${key}:|"${key}"`).test(pageSource)
  );
  expect(missing).toEqual([]);
});

test("the report says which Apple Home features are on, the dock phases and the schedule and Routine switches included", async () => {
  const page = loadSettingsPage({
    email: "owner@example.com",
    enableMatterDockPhases: false,
    enableHomeKitActionSwitches: true,
    enableHomeKitScheduleSwitches: true,
    enableHomeKitRoutineSwitches: true,
  });
  await page.run("loadConfig()");

  const line = await page.run("describeEnabledMatterFeatures()");

  expect(line).not.toMatch(/dockPhases/);
  expect(line).toMatch(/homeKitScheduleSwitches/);
  expect(line).toMatch(/homeKitRoutineSwitches/);

  const defaults = loadSettingsPage({ email: "owner@example.com" });
  await defaults.run("loadConfig()");
  const defaultLine = await defaults.run("describeEnabledMatterFeatures()");
  expect(defaultLine).toMatch(/dockPhases/);
  expect(defaultLine).not.toMatch(/homeKitScheduleSwitches/);
});

// A list setting is one key with several choices, and a choice can go missing
// from one place while the key itself is everywhere: the schema offers it, but
// the page has no box for it, or the code's key list does not know it. The
// switches and the sensors each grew a test of their own for this; the hidden
// clean modes (#50) are the third list, so the rule covers every list instead.
const LIST_SETTINGS = Object.entries(schema).filter(
  ([, property]) =>
    property.type === "array" && Array.isArray(property.items?.enum)
);

/** Every `const NAME = [ "a", "b" ]` string list in a source, by name. */
function stringLists(source) {
  return [...source.matchAll(/const (\w+) = \[([^\]]*)\]/g)].map((m) => ({
    name: m[1],
    entries: [...m[2].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]),
  }));
}

test("there are list settings to check", () => {
  expect(LIST_SETTINGS.map(([key]) => key)).toEqual(
    expect.arrayContaining([
      "homeKitActionSwitches",
      "homeKitStateSensors",
      "matterHiddenCleanModes",
    ])
  );
});

describe.each(LIST_SETTINGS)("every choice of %s", (key, property) => {
  const choices = property.items.enum;

  test("has a title in the schema", () => {
    expect(property.items.oneOf.map((entry) => entry.enum[0])).toEqual(choices);
  });

  test("is in a key list in src/types.ts, the same list in the same order", () => {
    expect(
      stringLists(typesSource).some(
        ({ entries }) => entries.join() === choices.join()
      )
    ).toBe(true);
  });

  test("has a checkbox on the settings page", () => {
    // The page's key list is the order the boxes are read in; a different
    // order compared against the saved list reads as an unsaved change.
    expect(
      stringLists(pageSource).some(
        ({ entries }) => entries.join() === choices.join()
      )
    ).toBe(true);
    for (const choice of choices) {
      const mapped = pageSource.match(
        new RegExp(`\\b${choice}: \\(\\) => elements\\.([A-Za-z0-9_]+)`)
      );
      expect(mapped).not.toBeNull();
      const elementId = pageSource.match(
        new RegExp(`${mapped[1]}: document\\.getElementById\\(\\s*"([^"]+)"`)
      );
      expect(elementId).not.toBeNull();
      expect(pageMarkup).toContain(`id="${elementId[1]}"`);
    }
  });

  test("is named in the README's settings table", () => {
    const row = readme.split("\n").find((line) => line.includes(`\`${key}\``));
    expect(row).toBeDefined();
    for (const choice of choices) {
      expect(row).toContain(`\`${choice}\``);
    }
  });
});

describe("the hidden clean modes on the settings page", () => {
  const hideMop = "matter-hide-clean-mode-mop";
  const hideVacuumAndMop = "matter-hide-clean-mode-vacuum-and-mop";

  test("a saved selection is shown, reported, and saved back unchanged", async () => {
    const page = loadSettingsPage({
      email: "owner@example.com",
      matterHiddenCleanModes: ["vacuumAndMop"],
    });
    await page.run("loadConfig()");

    expect(page.element(hideMop).checked).toBe(false);
    expect(page.element(hideVacuumAndMop).checked).toBe(true);
    expect(await page.run("describeEnabledMatterFeatures()")).toMatch(
      /hiddenCleanModes\(vacuumAndMop\)(?!.*WARNING)/
    );

    await page.run("saveCredentials(true)");
    expect(page.savedConfig().matterHiddenCleanModes).toEqual(["vacuumAndMop"]);
  });

  test("a tick is an unsaved change until Save, and Save writes it", async () => {
    const page = loadSettingsPage({ email: "owner@example.com" });
    await page.run("loadConfig()");
    expect(await page.run("describeEnabledMatterFeatures()")).not.toMatch(
      /hiddenCleanModes|WARNING/
    );

    page.element(hideMop).checked = true;
    page.element(hideVacuumAndMop).checked = true;
    expect(await page.run("describeEnabledMatterFeatures()")).toMatch(
      /WARNING: the settings form has unsaved changes/
    );

    await page.run("saveCredentials(true)");
    expect(page.savedConfig().matterHiddenCleanModes).toEqual([
      "mop",
      "vacuumAndMop",
    ]);
    expect(await page.run("describeEnabledMatterFeatures()")).toMatch(
      /hiddenCleanModes\(mop\+vacuumAndMop\)(?!.*WARNING)/
    );
  });

  test("the report leaves it out while there is no mode list to hide from", async () => {
    const page = loadSettingsPage({
      email: "owner@example.com",
      enableMatterCleanMode: false,
      matterHiddenCleanModes: ["mop"],
    });
    await page.run("loadConfig()");

    expect(await page.run("describeEnabledMatterFeatures()")).not.toMatch(
      /hiddenCleanModes/
    );
  });

  test("an implicit save does not write it", async () => {
    const page = loadSettingsPage({ email: "owner@example.com" });
    await page.run("loadConfig()");

    page.element(hideVacuumAndMop).checked = true;
    page.element("debug-mode").checked = true;
    await page.run("autoSave()");
    // autoSave does not wait for its save; let it land.
    await new Promise((resolve) => setImmediate(resolve));

    expect(page.savedConfig().debugMode).toBe(true);
    expect(page.savedConfig().matterHiddenCleanModes).toBeUndefined();
  });
});

describe("each robot's own hidden clean modes, on the settings page", () => {
  // A Q Revo and a Q5 Max+ on one account: the mop modes hidden on the Q5
  // Max+ only. A robot's own list is as much a re-pair as the list for every
  // robot, so it saves with the panel's Save button and never with an
  // implicit save. The robots come from the Devices list.
  const Q5 = {
    duid: "duid-q5",
    serialNumber: "Q5SERIAL",
    name: "Q5 Max+",
    resolvedModel: "roborock.vacuum.a117",
  };
  const Q_REVO = {
    duid: "duid-qrevo",
    serialNumber: "QREVOSERIAL",
    name: "Q Revo",
    resolvedModel: "roborock.vacuum.a75",
  };

  async function open(config, { robots = [Q5, Q_REVO] } = {}) {
    const page = loadSettingsPage(config, {
      request: async (route) =>
        route === "/diagnostics/state"
          ? { ok: true, devices: robots }
          : { ok: false, message: "offline" },
    });
    // init() loads the config and the Devices list itself, as Homebridge
    // UI's "ready" does, and wires the boxes for every robot.
    page.run("init()");
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    return page;
  }

  /** A robot's row, as it is now: a re-render replaces the boxes. */
  const row = (page, duid) =>
    page.run(`robotHiddenCleanModeControls.get(${JSON.stringify(duid)})`);
  const shows = (page, duid) => {
    const { follow, mop, vacuumAndMop } = row(page, duid);
    return {
      follow: follow.checked,
      mop: mop.checked,
      vacuumAndMop: vacuumAndMop.checked,
      greyed: mop.disabled && vacuumAndMop.disabled,
    };
  };
  function tick(box, checked) {
    box.checked = checked;
    box.dispatch("change");
  }

  test("a saved entry is shown on its robot, reported as a count, and saved back unchanged", async () => {
    const devices = [
      { id: "Q5SERIAL", matterHiddenCleanModes: ["mop", "vacuumAndMop"] },
      // A robot the Devices list does not show, with a setting this page
      // does not know: both are kept.
      { id: "gone-robot", matterHiddenCleanModes: ["mop"], laterSetting: 1 },
    ];
    const page = await open({ email: "owner@example.com", devices });

    expect(shows(page, "duid-q5")).toEqual({
      follow: false,
      mop: true,
      vacuumAndMop: true,
      greyed: false,
    });
    expect(shows(page, "duid-qrevo")).toMatchObject({
      follow: true,
      greyed: true,
    });
    const report = await page.run("describeEnabledMatterFeatures()");
    expect(report).toMatch(
      /hiddenCleanModes\(none, 2 robots overridden\)(?!.*WARNING)/
    );
    // The report is pasted into public issues.
    expect(report).not.toMatch(/Q5SERIAL|gone-robot|duid-q5/);

    await page.run("saveCredentials(true)");
    expect(page.savedConfig().devices).toEqual(devices);
  });

  test("a robot that follows shows the setting for every robot, greyed out", async () => {
    const page = await open({
      email: "owner@example.com",
      matterHiddenCleanModes: ["vacuumAndMop"],
    });

    expect(shows(page, "duid-qrevo")).toEqual({
      follow: true,
      mop: false,
      vacuumAndMop: true,
      greyed: true,
    });

    tick(page.element("matter-hide-clean-mode-mop"), true);
    expect(shows(page, "duid-qrevo")).toMatchObject({
      mop: true,
      vacuumAndMop: true,
    });
    expect(await page.run("describeEnabledMatterFeatures()")).toMatch(
      /hiddenCleanModes\(vacuumAndMop\).*WARNING/
    );
  });

  test("its own list is an unsaved change until Save, and Save writes it", async () => {
    const page = await open({ email: "owner@example.com" });

    // Unticking starts from the setting for every robot, which hides nothing.
    tick(row(page, "duid-q5").follow, false);
    expect(shows(page, "duid-q5")).toEqual({
      follow: false,
      mop: false,
      vacuumAndMop: false,
      greyed: false,
    });
    tick(row(page, "duid-q5").mop, true);
    tick(row(page, "duid-q5").vacuumAndMop, true);
    expect(await page.run("describeEnabledMatterFeatures()")).toMatch(
      /WARNING: the settings form has unsaved changes/
    );

    await page.run("saveCredentials(true)");
    expect(page.savedConfig().devices).toEqual([
      { id: "duid-q5", matterHiddenCleanModes: ["mop", "vacuumAndMop"] },
    ]);
    expect(await page.run("describeEnabledMatterFeatures()")).toMatch(
      /hiddenCleanModes\(none, 1 robot overridden\)(?!.*WARNING)/
    );
  });

  test("Same as all robots again removes the robot's list, and the key once nothing is left", async () => {
    const page = await open({
      email: "owner@example.com",
      devices: [{ id: "Q5SERIAL", matterHiddenCleanModes: ["mop"] }],
    });

    tick(row(page, "duid-q5").follow, true);
    await page.run("saveCredentials(true)");

    expect(page.savedConfig()).not.toHaveProperty("devices");
    expect(await page.run("describeEnabledMatterFeatures()")).not.toMatch(
      /hiddenCleanModes/
    );
  });

  test("Same as all robots keeps the rest of the robot's entry", async () => {
    const page = await open({
      email: "owner@example.com",
      devices: [
        { id: "duid-q5", matterHiddenCleanModes: ["mop"], laterSetting: 1 },
      ],
    });

    tick(row(page, "duid-q5").follow, true);
    await page.run("saveCredentials(true)");

    expect(page.savedConfig().devices).toEqual([
      { id: "duid-q5", laterSetting: 1 },
    ]);
  });

  test("before the robots load, there are no rows, and Save keeps every entry", async () => {
    const devices = [{ id: "Q5SERIAL", matterHiddenCleanModes: ["mop"] }];
    const page = await open(
      { email: "owner@example.com", devices },
      { robots: [] }
    );

    expect(page.run("robotHiddenCleanModeControls.size")).toBe(0);
    expect(
      page
        .element("matter-robot-hidden-clean-modes-empty")
        .classList.contains("hidden")
    ).toBe(false);

    await page.run("saveCredentials(true)");
    expect(page.savedConfig().devices).toEqual(devices);
  });

  test("an implicit save does not write it", async () => {
    const page = await open({ email: "owner@example.com" });

    tick(row(page, "duid-q5").follow, false);
    tick(row(page, "duid-q5").mop, true);
    page.element("debug-mode").checked = true;
    await page.run("autoSave()");
    // autoSave does not wait for its save; let it land.
    await new Promise((resolve) => setImmediate(resolve));

    expect(page.savedConfig().debugMode).toBe(true);
    expect(page.savedConfig()).not.toHaveProperty("devices");
  });
});

test("a robot's own hidden clean modes offer the choices the setting for every robot does", () => {
  // A nested list escapes the list-setting rule above, which reads top-level
  // keys only, so its choices are pinned to the list it replaces.
  expect(schema.devices.items.properties.matterHiddenCleanModes.items).toEqual(
    schema.matterHiddenCleanModes.items
  );
});
