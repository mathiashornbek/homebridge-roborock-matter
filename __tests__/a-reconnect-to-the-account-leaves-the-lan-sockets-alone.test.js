"use strict";

/**
 * A re-login and a robot added to or removed from the account run the whole
 * start again (restartService). Until 3.40.0-beta.1 that start stopped the
 * keep-alive of every LAN socket still up, and the attach that followed found
 * the socket connected and left it alone, so it was never pinged again: a
 * robot that then dropped off the network silently was only noticed after
 * three requests had each waited out their 10 seconds. And the attach opened
 * a socket to every robot ever heard on the LAN, so a robot just removed
 * from the account (or skipped in the settings) got a new socket, pinged
 * every 10 seconds for the life of the process.
 *
 * The real start runs here, against the fake Roborock cloud, with one robot
 * on the fake LAN.
 */

jest.mock("mqtt");
jest.mock("net", () => require("../test-support/fake-lan-robot").fakeNet);
jest.mock("dgram", () => require("../test-support/fake-lan-robot").fakeDgram);

const mqtt = require("mqtt");
const { FakeRobot, PING_REQUEST } = require("../test-support/fake-lan-robot");
const {
  startFakeRoborockCloud,
} = require("../test-support/fake-roborock-cloud");
const {
  advanceUntil,
  createAdapterOnFakeCloud,
  fakeMqttClient,
  homeData,
  robot,
  useFakeTimersAroundRealIo,
  waitFor,
} = require("../test-support/roborock-on-fake-cloud");

const STUE = robot("duid-stue", "Stueetage");
const GARAGE = robot("duid-garage", "Garage");
const STUE_IP = "192.168.1.42";
const REFRESH_MS = 180_000;

let cloud;
let api;
let lanRobot;

beforeAll(async () => {
  cloud = await startFakeRoborockCloud();
  cloud.trust();
});

afterAll(async () => {
  await cloud.close();
});

beforeEach(() => {
  mqtt.connect.mockReset();
  mqtt.connect.mockImplementation(() => fakeMqttClient());
  useFakeTimersAroundRealIo();
});

afterEach(async () => {
  await api?.stopService();
  lanRobot?.remove();
  jest.useRealTimers();
});

/** Start with Stueetage on the LAN, and let its socket and hello settle. */
async function startWithStueOnTheLan(options = {}) {
  api = createAdapterOnFakeCloud(cloud, {
    userData: cloud.issueSession(),
    cloudOnlyMode: false,
    ...options,
  });
  api.setReadyListener(jest.fn());
  // What LAN discovery would have heard; the fake UDP socket hears nothing.
  api.localDevices = { [STUE.duid]: STUE_IP };
  lanRobot = new FakeRobot(api, STUE.duid, STUE_IP);
  await api.startService();
  await waitFor(() => api.isInited(), "the start");
  // The 5 s discovery window, then the attach and the hello.
  await jest.advanceTimersByTimeAsync(5_000);
  await jest.advanceTimersByTimeAsync(0);
}

const pings = (socket) =>
  lanRobot.headers.filter(
    (header) =>
      header.protocol === PING_REQUEST &&
      (socket === undefined || header.socket === socket)
  );

async function restart() {
  const ready = api.readyListener.mock.calls.length;
  await api.restartService();
  await waitFor(() => api.isInited(), "the restart");
  expect(api.readyListener.mock.calls.length).toBe(ready + 1);
  await jest.advanceTimersByTimeAsync(5_000);
  await jest.advanceTimersByTimeAsync(0);
}

test("a socket still up across a reconnect to the account is still pinged", async () => {
  cloud.config.homeData = homeData({ devices: [STUE] });
  await startWithStueOnTheLan();
  const socket = lanRobot.socket;
  expect(socket).toBeDefined();
  await jest.advanceTimersByTimeAsync(30_000);
  const before = pings(socket).length;
  expect(before).toBeGreaterThanOrEqual(3);

  await restart();
  expect(lanRobot.socket).toBe(socket);

  await jest.advanceTimersByTimeAsync(60_000);
  expect(pings(socket).length - before).toBeGreaterThanOrEqual(6);
});

test("a robot that drops off the network after a reconnect is still noticed by its missed pings", async () => {
  cloud.config.homeData = homeData({ devices: [STUE] });
  await startWithStueOnTheLan();
  await jest.advanceTimersByTimeAsync(30_000); // it answers pings
  await restart();

  lanRobot.vanish(); // an AP restart: the socket stays open, the robot is gone
  await jest.advanceTimersByTimeAsync(60_000);

  expect(api.localConnector.isConnected(STUE.duid)).toBe(false);
});

test("a robot removed from the account gets no new LAN socket", async () => {
  cloud.config.homeData = homeData({ devices: [STUE, GARAGE] });
  await startWithStueOnTheLan();
  const first = lanRobot.socket;
  expect(first).toBeDefined();

  cloud.config.homeData = homeData({ devices: [GARAGE] });
  // Two refreshes, each followed by whatever it starts.
  for (let i = 0; i < 2; i += 1) {
    await jest.advanceTimersByTimeAsync(REFRESH_MS);
    await cloud.quiet();
    await advanceUntil(cloud, () => api.isInited(), "the start after it");
  }
  await jest.advanceTimersByTimeAsync(60_000);

  expect(api.getVacuumList().map((device) => device.duid)).toEqual([
    GARAGE.duid,
  ]);
  expect(first.destroyed).toBe(true);
  const open = lanRobot.sockets.filter((socket) => !socket.destroyed);
  expect({
    openSockets: open.length,
    pingsOnNewSockets: pings().filter((ping) => ping.socket !== first).length,
  }).toEqual({ openSockets: 0, pingsOnNewSockets: 0 });
});

test("a robot the settings skip gets no LAN socket, though it is heard on the LAN", async () => {
  cloud.config.homeData = homeData({ devices: [STUE, GARAGE] });
  await startWithStueOnTheLan({ skipDevices: STUE.duid });
  await jest.advanceTimersByTimeAsync(30_000);

  expect(lanRobot.sockets).toHaveLength(0);
});
