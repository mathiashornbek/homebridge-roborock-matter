"use strict";

/**
 * A local socket that stops answering is closed and reconnected; the robot is
 * never left cloud-only behind a socket that stays open.
 *
 * Until 3.39.0, three local timeouts in a row marked the robot remote
 * ("local-socket-connected-but-mute") while the socket stayed open, and only
 * a NEW connect cleared the mark. A robot that forgot the connection — a
 * Wi-Fi blip, an AP restart, a roam — never closed it on this side, because
 * nothing was written to it again, so the robot stayed on the cloud until
 * Homebridge restarted, and the settings page said "Local connected" the whole
 * time (#24 hit this repeatedly).
 *
 * Now: a run of three unanswered probes — keep-alive pings of a robot known to
 * answer them, or requests — closes the socket, and the reconnect decides.
 * Until a socket answers again it is not used for requests, and one whose
 * hello goes unanswered is closed, which is python-roborock's rule for every
 * socket (devices/transport/local_channel.py `connect`). The case that
 * started the mute rule (#8: a segmented network where the port opens and
 * nothing ever comes back) keeps going straight to the cloud.
 */

jest.mock("net", () => require("../test-support/fake-lan-robot").fakeNet);
jest.mock("dgram", () => require("../test-support/fake-lan-robot").fakeDgram);

const { createLanRig } = require("../test-support/fake-lan-robot");
const {
  describeConnectionState,
} = require("../roborockLib/lib/connectionState");
const {
  LOCAL_MUTE_REMOTE_REASON,
  LOCAL_MUTE_TIMEOUT_LIMIT,
} = require("../roborockLib/roborockAPI");

let rig;

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date("2026-10-23T08:00:00Z") });
  rig = await createLanRig();
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

function settingsCard() {
  return describeConnectionState(
    { online: true },
    rig.api.getTransportDiagnostics()[rig.duid],
    true
  ).status;
}

test("the limit is a small number greater than one", () => {
  expect(LOCAL_MUTE_TIMEOUT_LIMIT).toBeGreaterThan(1);
  expect(LOCAL_MUTE_TIMEOUT_LIMIT).toBeLessThanOrEqual(5);
});

test("a robot that drops off without closing the socket: three missed pings close it and a reconnect follows", async () => {
  const first = await rig.connect();
  await jest.advanceTimersByTimeAsync(30_000); // pings answered
  rig.robot.vanish();

  // Pings at 40, 50 and 60 s go unanswered; the third times out at 65 s.
  await jest.advanceTimersByTimeAsync(3 * 10_000 + 5_000 + 1);

  expect(first.destroyed).toBe(true);
  expect(rig.robot.sockets.length).toBeGreaterThan(1);
  // Not exiled: no remote mark, which nothing would ever clear.
  expect(await rig.api.isRemoteDevice(rig.duid)).toBe(false);
  expect(settingsCard()).not.toBe("Local connected");
});

test("while it stays silent, requests go straight to the cloud instead of waiting on a socket that has not answered", async () => {
  await rig.connect();
  await jest.advanceTimersByTimeAsync(30_000);
  rig.robot.vanish();
  await jest.advanceTimersByTimeAsync(35_000);

  const outcome = statusRead();
  await jest.advanceTimersByTimeAsync(0);

  expect(rig.api.rr_mqtt_connector.sendMessage).toHaveBeenCalledTimes(1);
  const [cloud] = rig.cloudRequests();
  rig.answerCloud(cloud.id, [{ state: 8 }]);
  await expect(outcome).resolves.toEqual({ value: [{ state: 8 }] });
});

test("a new socket whose hello goes unanswered is closed again, and retried with back-off", async () => {
  await rig.connect();
  await jest.advanceTimersByTimeAsync(30_000);
  rig.robot.vanish();
  await jest.advanceTimersByTimeAsync(35_000);
  const socketsAfterDrop = rig.robot.sockets.length;

  await jest.advanceTimersByTimeAsync(10 * 60_000);

  const opened = rig.robot.sockets.length - socketsAfterDrop;
  expect(rig.robot.sockets.slice(0, -1).every((s) => s.destroyed)).toBe(true);
  // At once, after 1 minute, 1.5, 2.25, 3.4 — not one every few seconds.
  expect(opened).toBeGreaterThan(0);
  expect(opened).toBeLessThanOrEqual(5);
});

test("once the robot answers again, the next status read goes over the LAN", async () => {
  await rig.connect();
  await jest.advanceTimersByTimeAsync(30_000);
  rig.robot.vanish();
  await jest.advanceTimersByTimeAsync(35_000);

  rig.robot.helloVersion = "1.0";
  rig.robot.answersPings = true;
  rig.robot.answersRequests = true;
  rig.robot.result = () => [{ state: 8 }];
  await jest.advanceTimersByTimeAsync(5 * 60_000);
  // Its hello is answered, so requests try the new socket; the robot only
  // counts as answering again once it answers one.
  expect(rig.api.localConnector.isConnected(rig.duid)).toBe(true);
  expect(settingsCard()).toBe("Local not answering");

  const outcome = statusRead();
  await jest.advanceTimersByTimeAsync(0);
  await expect(outcome).resolves.toEqual({ value: [{ state: 8 }] });
  expect(rig.api.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
  expect(settingsCard()).toBe("Local connected");
  expect(
    rig.log.info.mock.calls.some(([line]) =>
      /answers on the LAN again/.test(line)
    )
  ).toBe(true);
});

test("a robot that never answers pings is judged by its requests: three unanswered in a row close the socket", async () => {
  rig.robot.answersPings = false;
  rig.robot.answersRequests = false;
  const first = await rig.connect();

  for (let i = 0; i < 3; i += 1) {
    const outcome = statusRead();
    // Each is retried over the cloud, which answers it.
    await jest.advanceTimersByTimeAsync(10_000);
    const cloud = rig.cloudRequests().at(-1);
    rig.answerCloud(cloud.id, [{ state: 8 }]);
    await outcome;
  }

  expect(first.destroyed).toBe(true);
  expect(await rig.api.isRemoteDevice(rig.duid)).toBe(false);
  expect(rig.api.getTransportDiagnostics()[rig.duid]).toMatchObject({
    tcpConnectionState: expect.stringMatching(/unanswered|verifying/),
  });
});

test("timeouts with answers in between never close a socket", async () => {
  const first = await rig.connect();
  rig.robot.result = () => undefined; // requests unanswered, pings answered

  for (let i = 0; i < 6; i += 1) {
    const outcome = statusRead();
    await jest.advanceTimersByTimeAsync(10_000);
    const cloud = rig.cloudRequests().at(-1);
    rig.answerCloud(cloud.id, [{ state: 8 }]);
    await outcome;
    await jest.advanceTimersByTimeAsync(50_000);
  }

  expect(first.destroyed).toBe(false);
  expect(rig.robot.sockets).toHaveLength(1);
});

test("the episode is announced once, by name, and the recovery once", async () => {
  await rig.connect();
  await jest.advanceTimersByTimeAsync(30_000);
  rig.robot.vanish();
  await jest.advanceTimersByTimeAsync(10 * 60_000);

  const warnings = rig.log.warn.mock.calls
    .map(([line]) => String(line))
    .filter((line) => /stopped answering/.test(line));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/Stueetage/);
});

test("the settings page never says Local connected for a robot routed through the cloud", () => {
  expect(
    describeConnectionState(
      { online: true },
      {
        tcpConnectionState: "connected",
        isRemote: true,
        remoteReason: "received-device",
        lastTransport: "cloud",
      },
      true
    ).status
  ).not.toBe("Local connected");
  expect(
    describeConnectionState(
      { online: true },
      { tcpConnectionState: "unanswered", lastTransport: "cloud" },
      true
    ).status
  ).toBe("Local not answering");
});

test("the reason is explained in words instead of echoed as a slug", () => {
  const explained = rig.api.describeTransportReason(LOCAL_MUTE_REMOTE_REASON);

  expect(explained).not.toBe(LOCAL_MUTE_REMOTE_REASON);
  expect(explained).toMatch(/stopped answering/);
  expect(explained).toMatch(/reconnecting/);
});
