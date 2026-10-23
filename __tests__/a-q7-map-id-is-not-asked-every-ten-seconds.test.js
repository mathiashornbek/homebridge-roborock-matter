"use strict";

/**
 * The Q7 live-room fallback does not ask `service.get_map_list` on every
 * attempt, and a map switch refreshes the rooms instead of waiting 6 hours.
 *
 * The live-room loop sent `get_map_list` and then `service.upload_by_mapid`
 * on every attempt while the robot cleaned, two cloud requests every 10 s just
 * to learn a map id that does not change mid-run. python-roborock reads the
 * current map from the status (`B01Props.current_map_id`). The map id from
 * the last map list is now reused, and the status's `current_map_id` is read
 * as the signal that the map changed — at which point the rooms, whose ids
 * are per map, are refreshed at once.
 */

jest.mock(
  "mqtt",
  () => require("../test-support/b01-robot-on-a-fake-broker").fakeMqttModule
);

const {
  createB01Robots,
  scMapFrames,
  Q7_MODEL,
} = require("../test-support/b01-robot-on-a-fake-broker");

const DUID = "duid-garage";
const { frames } = scMapFrames();

function methodsSent(robots) {
  return robots
    .sentTo(DUID)
    .map((payload) => payload?.dps?.["10000"]?.method)
    .filter(Boolean);
}

async function cleaningQ7() {
  const robots = await createB01Robots({
    robots: [{ duid: DUID, name: "Garage", model: Q7_MODEL }],
  });
  robots.api.setDeviceNotify(jest.fn());
  robots.api.rememberB01LiveStatus(DUID, { state: 5 });
  return robots;
}

/** One fallback attempt, answered the way a Q7 answers it. */
async function fallbackAttempt(robots) {
  const before = robots.sentTo(DUID).length;
  const live = robots.api._b01LiveRoomState?.get(DUID);
  if (live) live.lastAttemptAt = 0;
  const attempt = robots.api.refreshB01LiveRoom(DUID);
  let sent = await robots.waitForSent(DUID, before + 1);
  if (sent.at(-1).dps["10000"].method === "service.get_map_list") {
    await robots.q7Answers(DUID, { map_list: [{ id: 1, cur: true }] });
    sent = await robots.waitForSent(DUID, before + 2);
  }
  expect(sent.at(-1).dps["10000"].method).toBe("service.upload_by_mapid");
  await robots.q7MapFrame(DUID, frames.savedPlaceholder);
  await attempt;
}

describe("the live-room fallback reuses the map id", () => {
  let robots;
  afterEach(() => robots?.api.clearTimersAndIntervals());

  test("three attempts ask for the map list once", async () => {
    robots = await cleaningQ7();
    for (let index = 0; index < 3; index += 1) {
      await fallbackAttempt(robots);
    }
    const methods = methodsSent(robots);
    expect(
      methods.filter((method) => method === "service.get_map_list")
    ).toHaveLength(1);
    expect(
      methods.filter((method) => method === "service.upload_by_mapid")
    ).toHaveLength(3);
  });
});

describe("a map switch refreshes the rooms", () => {
  let robots;
  afterEach(() => robots?.api.clearTimersAndIntervals());

  async function statusReports(answer) {
    const before = robots.sentTo(DUID).length;
    const state = robots.api._b01StatusState.get(DUID);
    if (state) state.lastAttemptAt = 0;
    const poll = robots.api.refreshB01Status(DUID, { force: true });
    await robots.waitForSent(DUID, before + 1);
    await robots.q7Answers(DUID, answer);
    await poll;
  }

  test("the status read asks for current_map_id", async () => {
    robots = await cleaningQ7();
    await statusReports({ status: 4, quantity: 90 });
    const request = robots.sentTo(DUID)[0].dps["10000"];
    expect(request.method).toBe("prop.get");
    expect(request.params.property).toContain("current_map_id");
  });

  test("a changed current_map_id forces one room refresh, an unchanged one none", async () => {
    robots = await cleaningQ7();
    const refresh = jest
      .spyOn(robots.api, "refreshB01Rooms")
      .mockResolvedValue([]);

    await statusReports({ status: 4, quantity: 90, current_map_id: 1 });
    await statusReports({ status: 4, quantity: 90, current_map_id: 1 });
    expect(refresh).not.toHaveBeenCalled();

    await statusReports({ status: 4, quantity: 90, current_map_id: 2 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(DUID, { force: true });
  });
});
