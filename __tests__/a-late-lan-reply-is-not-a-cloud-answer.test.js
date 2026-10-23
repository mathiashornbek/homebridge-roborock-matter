"use strict";

/**
 * After a LAN timeout the request is sent again over MQTT under the same id,
 * as python-roborock does. The robot's LAN reply to the first attempt can
 * still arrive, and it found the cloud attempt's entry under that id: its
 * resolve booked a cloud answer and reset the MQTT health counter, although
 * MQTT had delivered nothing, so slow LAN replies could hide a silent MQTT
 * session. python-roborock stops listening on the LAN before its MQTT
 * attempt, so its HealthManager counts that attempt as a timeout.
 *
 * The caller still gets the answer; it is booked to the LAN.
 */

jest.mock("net", () => require("../test-support/fake-lan-robot").fakeNet);
jest.mock("dgram", () => require("../test-support/fake-lan-robot").fakeDgram);

const { createLanRig } = require("../test-support/fake-lan-robot");

let rig;

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date("2026-10-23T08:00:00Z") });
  rig = await createLanRig();
  await rig.connect();
});

afterEach(() => {
  rig.api.localConnector.destroyAllClients();
  rig.api.localConnector.clearLocalDevicedTimeout();
  rig.robot.remove();
  jest.useRealTimers();
});

function statusRead() {
  return rig.api.messageQueueHandler
    .sendRequest(rig.duid, "get_prop", ["get_status"])
    .then(
      (value) => ({ value }),
      (error) => ({ error })
    );
}

test("a LAN reply that lands during the cloud retry is booked to the LAN, not to the cloud session", async () => {
  rig.robot.answersRequests = false;
  rig.api.cloudSessionHealth.consecutiveSilences = 2;
  const note = jest.spyOn(rig.api, "noteTransportOutcome");

  const outcome = statusRead();
  await jest.advanceTimersByTimeAsync(10_000); // LAN timeout -> cloud retry
  const [retry] = rig.cloudRequests();
  expect(retry).toBeDefined();

  // The robot's LAN answer to the first attempt, 11 s late.
  await rig.robot.reply(rig.robot.socket, retry.id, [{ state: 8 }]);
  await jest.advanceTimersByTimeAsync(0);

  expect((await outcome).value).toEqual([{ state: 8 }]);
  expect(note).not.toHaveBeenCalledWith(rig.duid, "cloud", "ok");
  expect(note).toHaveBeenLastCalledWith(rig.duid, "local", "ok");
  expect(rig.api.cloudSessionHealth.consecutiveSilences).toBe(2);
});

test("the cloud's own answer to the retry still counts for the cloud session", async () => {
  rig.robot.answersRequests = false;
  rig.api.cloudSessionHealth.consecutiveSilences = 2;
  const note = jest.spyOn(rig.api, "noteTransportOutcome");

  const outcome = statusRead();
  await jest.advanceTimersByTimeAsync(10_000);
  const [retry] = rig.cloudRequests();
  rig.answerCloud(retry.id, [{ state: 8 }]);

  expect((await outcome).value).toEqual([{ state: 8 }]);
  expect(note).toHaveBeenLastCalledWith(rig.duid, "cloud", "ok");
  expect(rig.api.cloudSessionHealth.consecutiveSilences).toBe(0);
});
