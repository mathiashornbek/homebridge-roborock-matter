"use strict";

// The Region select listed four servers. Setting a <select>'s value to one no
// option has selects nothing, and the select then reads "" (HTML's rule). The
// page did exactly that for any other saved region — python-roborock's RU
// server, or a hand-edited URL — and the next automatic save (toggling debug
// mode, editing the email, ticking a device row) wrote baseURL "" into
// config.json, which the plugin reads as US. A UI login sent "" too.
//
// The RU server is now listed, and a saved value the list does not have is
// kept: shown as an extra option and saved back unchanged.

const { loadSettingsPage } = require("../test-support/settings-page");

async function loadedPage(config) {
  const page = loadSettingsPage(config);
  await page.run("loadConfig()");
  return page;
}

async function toggleDebugMode(page) {
  const debug = page.element("debug-mode");
  debug.checked = !debug.checked;
  debug.dispatch("change");
  // autoSave is async; let it reach the saved config.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

test.each([
  ["the RU server", "https://ruiot.roborock.com"],
  ["a server the list does not have", "https://api-roborock.example.com:555"],
])(
  "%s survives an automatic save of another setting",
  async (_label, baseURL) => {
    const page = await loadedPage({
      email: "owner@example.com",
      baseURL,
      encryptedToken: "token",
    });
    page.run("init()");

    expect(page.run("getFormValues().baseURL")).toBe(baseURL);

    await toggleDebugMode(page);

    expect(page.savedConfig().debugMode).toBe(true);
    expect(page.savedConfig().baseURL).toBe(baseURL);
  }
);

test("the RU server is one of the listed regions", async () => {
  const page = await loadedPage({ email: "owner@example.com" });
  expect(page.element("base-url").options.map((o) => o.value)).toContain(
    "https://ruiot.roborock.com"
  );
  const schema = require("../config.schema.json");
  expect(schema.schema.properties.baseURL.enum).toContain(
    "https://ruiot.roborock.com"
  );
});
