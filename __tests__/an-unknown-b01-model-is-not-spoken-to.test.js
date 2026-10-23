"use strict";

/**
 * A B01 robot whose model is neither a Q7 (`sc*`) nor a Q10 (`ss*`) is not
 * spoken to in either dialect.
 *
 * `pv === "B01"` is two wire protocols, and the model is the only thing that
 * tells them apart. Until now anything else — including a model missing from
 * the home data because the product lookup missed — was treated as a Q7. A
 * Q10 caught by that miss gets Q7 `prop.get` frames it discards, every status
 * tick, forever: the shape of the log in #19 (hypothesis (b) in the last
 * maintainer comment there). python-roborock refuses such a device outright
 * (`device_manager.device_creator`: `ss` -> Q10, `sc` -> Q7, anything else
 * `UnsupportedDeviceError`).
 *
 * What the user sees instead: the robot keeps its tile (its state comes from
 * the Roborock cloud snapshot), one info line names the model the plugin saw,
 * and a command from Apple Home fails at once rather than timing out.
 */

jest.mock(
  "mqtt",
  () => require("../test-support/b01-robot-on-a-fake-broker").fakeMqttModule
);

const b01 = require("../roborockLib/lib/b01Q7Adapter");
const {
  createB01Robots,
} = require("../test-support/b01-robot-on-a-fake-broker");

const DUID = "duid-mystery";

describe("the family is read off the model and nothing else", () => {
  test("only sc* and ss* name a family", () => {
    expect(b01.b01FamilyForModel("roborock.vacuum.sc05")).toBe(
      b01.B01_FAMILY.Q7
    );
    expect(b01.b01FamilyForModel("roborock.vacuum.ss07")).toBe(
      b01.B01_FAMILY.Q10
    );
    expect(b01.b01FamilyForModel("roborock.vacuum.zz99")).toBeNull();
    expect(b01.b01FamilyForModel("roborock.vacuum.a70")).toBeNull();
    expect(b01.b01FamilyForModel(null)).toBeNull();
    expect(b01.b01FamilyForModel(undefined)).toBeNull();
  });
});

describe.each([
  ["a model nobody has classified", "roborock.vacuum.zz99", false],
  ["a model missing from the home data", "roborock.vacuum.ss07", true],
])("%s", (label, model, dropProduct) => {
  let robots;

  beforeEach(async () => {
    robots = await createB01Robots({
      robots: [{ duid: DUID, name: "Mystery", model }],
    });
    if (dropProduct) {
      robots.homeData.products = [];
      await robots.api.setStateAsync("HomeData", {
        val: JSON.stringify(robots.homeData),
        ack: true,
      });
    }
  });

  afterEach(() => {
    robots.api.clearTimersAndIntervals();
  });

  test("the status loop sends nothing and says why once", async () => {
    await expect(
      robots.api.refreshB01Status(DUID, { force: true })
    ).resolves.toBeNull();
    robots.api._b01StatusState?.get(DUID) &&
      (robots.api._b01StatusState.get(DUID).lastAttemptAt = 0);
    await robots.api.refreshB01Status(DUID, { force: true });

    expect(robots.sentTo(DUID)).toEqual([]);
    const lines = robots.log.info.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes("neither a Q7"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Mystery/);
    expect(lines[0]).toContain(dropProduct ? "missing" : model);
    expect(robots.log.warn).not.toHaveBeenCalled();
  });

  test("a command is refused at once, calmly, and nothing is sent", async () => {
    await expect(
      robots.api.messageQueueHandler.sendRequest(DUID, "app_start", [])
    ).rejects.toMatchObject({ code: "B01_METHOD_UNSUPPORTED" });
    expect(robots.sentTo(DUID)).toEqual([]);
  });

  test("rooms and the live room are not fetched", async () => {
    await robots.api.refreshB01Rooms(DUID, { force: true });
    await expect(robots.api.refreshB01LiveRoom(DUID)).resolves.toBeNull();
    expect(robots.sentTo(DUID)).toEqual([]);
  });
});
