"use strict";

/**
 * A Q10's status comes from what it pushes, and the status loop asks it to
 * push — it does not wait on a home-data snapshot.
 *
 * The Q10 dialect has no read: a status read sends no reply, which is why the
 * loop stopped polling one in 3.19.0. But the dialect has a write that makes
 * the robot push its whole status: dpRequestDps (102), `{"102":{}}`.
 * python-roborock's `Q10PropertiesApi.refresh` sends exactly that, and Home
 * Assistant sends it once a minute. The pushed answer is read at the transport
 * boundary (a-b01-push-is-read-in-its-own-dialect.test.js); the request itself
 * is fire-and-forget, so it is never mistaken for an answer and never counts
 * as a failed read.
 */

jest.mock(
  "mqtt",
  () => require("../test-support/b01-robot-on-a-fake-broker").fakeMqttModule
);

const {
  createB01Robots,
  Q10_MODEL,
} = require("../test-support/b01-robot-on-a-fake-broker");

const DUID = "duid-q10";

describe("the status loop asks a Q10 to push its status", () => {
  let robots;

  beforeEach(async () => {
    robots = await createB01Robots({
      robots: [{ duid: DUID, name: "Kitchen Q10", model: Q10_MODEL }],
    });
    robots.notify = jest.fn();
    robots.api.setDeviceNotify(robots.notify);
  });

  afterEach(() => {
    robots.api.clearTimersAndIntervals();
  });

  test("a status poll sends exactly dpRequestDps and publishes nothing itself", async () => {
    await expect(
      robots.api.refreshB01Status(DUID, { force: true })
    ).resolves.toBeNull();

    expect(robots.sentTo(DUID)).toEqual([{ dps: { 102: {} } }]);
    expect(robots.notify).not.toHaveBeenCalled();
  });

  test("it asks at most once a minute unless forced", async () => {
    await robots.api.refreshB01Status(DUID, { force: true });
    await robots.api.refreshB01Status(DUID);
    expect(robots.sentTo(DUID)).toHaveLength(1);

    robots.api._b01Q10StatusRequestAt.set(DUID, Date.now() - 61_000);
    await robots.api.refreshB01Status(DUID);
    expect(robots.sentTo(DUID)).toHaveLength(2);
  });

  test("the pushed answer is what the tile reads", async () => {
    await robots.api.refreshB01Status(DUID, { force: true });
    await robots.pushes(DUID, { 121: 8, 122: 100, 101: { 90: 0 } });

    expect(robots.api.getLastKnownLiveStatus(DUID)).toMatchObject({
      state: 8,
      battery: 100,
      charge_status: 1,
      error_code: 0,
    });
  });

  test("a request the cloud could not carry is not a failed read", async () => {
    robots.api.rr_mqtt_connector.connected = false;
    for (let index = 0; index < 12; index += 1) {
      await robots.api.refreshB01Status(DUID, { force: true });
      robots.api._b01Q10StatusRequestAt.set(DUID, 0);
    }
    expect(robots.log.warn).not.toHaveBeenCalled();
    expect(robots.sentTo(DUID)).toEqual([]);
  });

  test("where the state comes from is said once per robot", async () => {
    for (let index = 0; index < 3; index += 1) {
      await robots.api.refreshB01Status(DUID, { force: true });
      robots.api._b01Q10StatusRequestAt.set(DUID, 0);
    }
    const lines = robots.log.info.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes("Q10"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/push/);
  });
});
