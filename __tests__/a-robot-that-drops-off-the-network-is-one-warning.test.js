"use strict";

/**
 * A robot that drops off the network is one event, and gets one warning.
 *
 * Measured on the maintainer's a70 ("Stueetage") on 14 Nov 2026, 17:37: the
 * robot was gone for about 45 seconds, and the log carried four warnings:
 *
 *   17:37:53 The local connection to Stueetage stopped answering …
 *   17:37:58 Failed to execute get_status … Cloud request … timed out …
 *            It was the cloud retry after the local attempt failed …
 *   17:38:08 Stueetage: first live MQTT presence report is offline …
 *   17:38:33 Failed to execute get_room_mapping … Stueetage is offline …
 *   17:38:38 Stueetage is back online.
 *
 * Each line was true; together they read like four faults. Now the first
 * symptom warns, the ones that follow are told at info as part of the same
 * story, the per-request failures go to debug (the hourly line still counts
 * them), and the way back says how long it lasted.
 */

jest.mock("net", () => require("../test-support/fake-lan-robot").fakeNet);
jest.mock("dgram", () => require("../test-support/fake-lan-robot").fakeDgram);

const { createLanRig } = require("../test-support/fake-lan-robot");

let rig;

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date("2026-11-14T16:37:00Z") });
  rig = await createLanRig();
});

afterEach(() => {
  rig.api.localConnector.destroyAllClients();
  rig.api.localConnector.clearLocalDevicedTimeout();
  rig.robot.remove();
  jest.useRealTimers();
});

const lines = (level) =>
  rig.log[level].mock.calls.map(([line]) => String(line));

/** A status read as the poll loop makes it: failures go through catchError. */
function statusRead(method = "get_status") {
  return rig.api.messageQueueHandler
    .sendRequest(rig.duid, "get_prop", [method])
    .then(
      (value) => ({ value }),
      async (error) => {
        await rig.api.catchError(
          error,
          method,
          rig.duid,
          "roborock.vacuum.a70"
        );
        return { error };
      }
    );
}

async function setHomeDataOnline(online) {
  await rig.api.setStateAsync("HomeData", {
    val: JSON.stringify({
      devices: [{ duid: rig.duid, name: "Stueetage", online, pv: "1.0" }],
      receivedDevices: [],
      products: [],
    }),
    ack: true,
  });
}

function comeBack() {
  rig.robot.helloVersion = "1.0";
  rig.robot.answersPings = true;
  rig.robot.answersRequests = true;
  rig.robot.result = () => [{ state: 8 }];
}

test("the 14 November sequence: LAN first, then cloud, presence and a refused read — one warning", async () => {
  await rig.connect();
  await jest.advanceTimersByTimeAsync(30_000);
  rig.robot.vanish();

  // Three missed keep-alive pings close the socket: the first symptom.
  await jest.advanceTimersByTimeAsync(35_001);
  expect(lines("warn")).toEqual([
    expect.stringContaining(
      "The local connection to Stueetage stopped answering"
    ),
  ]);

  // A status read now goes to the cloud, which the robot does not answer
  // either.
  const read = statusRead();
  await jest.advanceTimersByTimeAsync(10_001);
  expect((await read).error).toBeDefined();

  // The cloud says the robot is offline; a room read is refused for it.
  rig.api.rr_mqtt_connector.notePresence(rig.duid, false);
  await setHomeDataOnline(false);
  const refused = await statusRead("get_room_mapping");
  expect(String(refused.error)).toMatch(/is offline/);

  // 30 s later it is back.
  await jest.advanceTimersByTimeAsync(30_000);
  await setHomeDataOnline(true);
  rig.api.rr_mqtt_connector.notePresence(rig.duid, true);

  expect(lines("warn")).toHaveLength(1);
  expect(lines("error")).toEqual([]);
  expect(lines("info")).toEqual(
    expect.arrayContaining([
      expect.stringMatching(
        /^Stueetage also reports itself offline to the Roborock cloud, so it has dropped off the network/
      ),
      expect.stringMatching(/^Stueetage is back online after \d+ s\.$/),
    ])
  );
  // The failures are not lost: they are in the debug log.
  const debug = lines("debug").join("\n");
  expect(debug).toMatch(/get_status/);
  expect(debug).toMatch(/get_room_mapping/);
});

test("the episode's length is measured from the first symptom", async () => {
  await rig.connect();
  await jest.advanceTimersByTimeAsync(30_000);
  rig.robot.vanish();
  await jest.advanceTimersByTimeAsync(35_001); // LAN drop: the episode opens
  rig.api.rr_mqtt_connector.notePresence(rig.duid, false);
  await jest.advanceTimersByTimeAsync(45_000);
  rig.api.rr_mqtt_connector.notePresence(rig.duid, true);

  expect(lines("info")).toContain("Stueetage is back online after 45 s.");
});

test("a read that dies on both the LAN and the cloud opens the episode itself, and the LAN drop after it is not a second warning", async () => {
  await rig.connect();
  await jest.advanceTimersByTimeAsync(30_000);
  rig.robot.vanish();

  // Local attempt times out at 10 s, its cloud retry at 20 s.
  const read = statusRead();
  await jest.advanceTimersByTimeAsync(20_001);
  expect((await read).error).toBeDefined();
  expect(lines("warn")).toEqual([
    expect.stringMatching(
      /^Stueetage answered get_status neither on the LAN nor over the cloud, so it has probably dropped off the network/
    ),
  ]);

  // The keep-alive pings keep missing and the socket is closed.
  await jest.advanceTimersByTimeAsync(60_000);
  expect(lines("warn")).toHaveLength(1);
  expect(lines("info")).toEqual(
    expect.arrayContaining([
      expect.stringContaining(
        "The local connection to Stueetage stopped answering"
      ),
    ])
  );
  expect(lines("error")).toEqual([]);
});

test("a LAN-only fault does not hide a cloud failure: the next cloud reply ends the episode", async () => {
  await rig.connect();
  await jest.advanceTimersByTimeAsync(30_000);
  rig.robot.vanish();
  await jest.advanceTimersByTimeAsync(35_001); // LAN drop: warning 1

  // The cloud answers: the robot is on the network, only its LAN is not.
  const answered = statusRead();
  await jest.advanceTimersByTimeAsync(0);
  rig.answerCloud(rig.cloudRequests().at(-1).id, [{ state: 8 }]);
  expect((await answered).value).toEqual([{ state: 8 }]);
  expect(rig.api.unreachableEpisodes.isOpen(rig.duid)).toBe(false);

  // A later cloud timeout is a cloud problem, and is reported as one.
  const silent = statusRead();
  await jest.advanceTimersByTimeAsync(10_001);
  await silent;

  const warnings = lines("warn");
  expect(warnings).toHaveLength(2);
  expect(warnings[1]).toMatch(
    /^Failed to execute get_status on robot Stueetage .*Cloud request .* timed out/
  );
});

test("when the robot answers on the LAN again, the episode is over without a cloud report", async () => {
  await rig.connect();
  await jest.advanceTimersByTimeAsync(30_000);
  rig.robot.vanish();
  await jest.advanceTimersByTimeAsync(35_001);
  expect(rig.api.unreachableEpisodes.isOpen(rig.duid)).toBe(true);

  comeBack();
  await jest.advanceTimersByTimeAsync(5 * 60_000);
  expect(rig.api.unreachableEpisodes.isOpen(rig.duid)).toBe(false);
  expect(lines("warn")).toHaveLength(1);
});
