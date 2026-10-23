"use strict";

/**
 * A Q7 status answer that does not say what the robot is doing must not be
 * published as "Idle, not charging".
 *
 * `mapStatusToV1` used to default `state` to 3 (Idle) and `charge_status` to 0
 * whenever `status` was missing or not in its table, and the status loop
 * published whatever came back. So a `{"code":0,"data":null}` answer, a
 * partial property set, or a work status the table lacked (11,
 * `working_sleep`) moved a docked or paused robot's tile to Idle off the dock.
 * python-roborock refuses a non-dict `prop.get` answer outright
 * (`b01_q7_channel.find_response`) and maps unknown work statuses to UNKNOWN,
 * not to a real state; Home Assistant maps 11 to PAUSED: "An untouched pause
 * falls asleep after ~10 minutes; the job is kept".
 *
 * Driven through the real MQTT handler and msgId correlation; the robot's
 * answers are framed with the plugin's own (symmetric) B01 cipher.
 */

jest.mock(
  "mqtt",
  () => require("../test-support/b01-robot-on-a-fake-broker").fakeMqttModule
);

const b01 = require("../roborockLib/lib/b01Q7Adapter");
const {
  createB01Robots,
  Q7_MODEL,
} = require("../test-support/b01-robot-on-a-fake-broker");

const Q7 = b01.B01_FAMILY.Q7;
const DUID = "duid-1sal";

describe("the adapter does not invent a work status", () => {
  test("a partial answer carries no state, charging or drying field", () => {
    const v1 = b01.mapStatusToV1({ quantity: 80, fault: 0 }, Q7);
    expect(v1).not.toHaveProperty("state");
    expect(v1).not.toHaveProperty("charge_status");
    expect(v1).not.toHaveProperty("dry_status");
    expect(v1.battery).toBe(80);
    expect(v1.error_code).toBe(0);
  });

  test("a work status the table does not know carries no state either", () => {
    const v1 = b01.mapStatusToV1({ status: 42, quantity: 80 }, Q7);
    expect(v1).not.toHaveProperty("state");
    expect(v1).not.toHaveProperty("charge_status");
  });

  test("11 (working_sleep) is a paused job, not an idle robot", () => {
    const v1 = b01.mapStatusToV1({ status: 11, quantity: 55 }, Q7);
    expect(v1.state).toBe(10);
    expect(v1.charge_status).toBe(0);
  });
});

describe("the status loop publishes only what the robot said", () => {
  let robots;

  beforeEach(async () => {
    robots = await createB01Robots({
      robots: [{ duid: DUID, name: "1. Sal", model: Q7_MODEL }],
    });
  });

  afterEach(() => {
    robots.api.clearTimersAndIntervals();
  });

  async function poll(answer) {
    const result = robots.api.refreshB01Status(DUID, { force: true });
    await robots.waitForSent(DUID);
    await robots.q7Answers(DUID, answer);
    return result;
  }

  test("a null answer publishes nothing and counts as a failed read", async () => {
    const notify = jest.fn();
    robots.api.setDeviceNotify(notify);

    await expect(poll(null)).resolves.toBeNull();

    expect(notify).not.toHaveBeenCalled();
    expect(robots.api._b01StatusState.get(DUID).consecutiveFailures).toBe(1);
  });

  test("a partial answer publishes what it carries and leaves the state alone", async () => {
    const notify = jest.fn();
    robots.api.setDeviceNotify(notify);

    await poll({ status: 4, quantity: 90, fault: 0 });
    robots.broker.published.length = 0;
    robots.api._b01StatusState.get(DUID).lastAttemptAt = 0;
    notify.mockClear();

    await poll({ quantity: 91 });

    const published = notify.mock.calls.map(([, message]) => message.payload);
    expect(published).toEqual([[{ battery: 91, error_code: 0 }]]);
    // Still charging as far as the plugin knows: the gap the robot left is
    // not filled with Idle.
    expect(robots.api._b01StatusState.get(DUID).lastKnownV1State).toBe(8);
  });

  test("an unknown work status is named once per robot, by number", async () => {
    await poll({ status: 42, quantity: 90, fault: 0 });
    robots.broker.published.length = 0;
    robots.api._b01StatusState.get(DUID).lastAttemptAt = 0;
    await poll({ status: 42, quantity: 90, fault: 0 });

    const lines = robots.log.info.mock.calls
      .map(([line]) => line)
      .filter((line) => /work status 42/.test(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/1\. Sal/);
  });
});
