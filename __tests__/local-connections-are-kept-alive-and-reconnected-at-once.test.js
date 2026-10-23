"use strict";

/**
 * python-roborock keeps its local socket the way these tests expect
 * (devices/transport/local_channel.py, devices/rpc/v1_channel.py):
 *
 *  - from the moment the hello settles, a header-only PING_REQUEST (protocol
 *    2) every 10 s, which the robot answers on protocol 3 with the same seq;
 *  - after a loss, the first reconnect at once (its 15 s check bounds that),
 *    then 1 minute growing by 1.5 up to 10 minutes, starting over once the
 *    robot answers again.
 *
 * 3.36.0 added the hello without the keep-alive python-roborock starts right
 * after it, and reconnected 60 s after any loss, so on the maintainer's a70
 * every socket loss contained exactly one poll, which went to the cloud.
 */

jest.mock("net", () => require("../test-support/fake-lan-robot").fakeNet);
jest.mock("dgram", () => require("../test-support/fake-lan-robot").fakeDgram);

const {
  createLanRig,
  PING_REQUEST,
  HELLO_REQUEST,
} = require("../test-support/fake-lan-robot");
const { buildPingFrame } = require("../roborockLib/lib/localConnector");

describe("the ping frame is python-roborock's, byte for byte", () => {
  test.each([
    ["1.0", "00000015312e300001871b000028d86ab13b800002d6d99d4e"],
    ["L01", "000000154c30310001871b000028d86ab13b800002df8de3f2"],
  ])("%s", (version, expectedHex) => {
    // Produced by python-roborock 7.13.0:
    // create_local_encoder(key)(RoborockMessage(protocol=PING_REQUEST,
    //   version, seq=100123, random=10456, timestamp=1790000000))
    expect(
      buildPingFrame(version, 100123, 10456, 1790000000).toString("hex")
    ).toBe(expectedHex);
  });
});

describe("on the fake LAN", () => {
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

  const pings = (socket) =>
    rig.robot.headers.filter(
      (header) =>
        header.protocol === PING_REQUEST &&
        (socket === undefined || header.socket === socket)
    );
  const hellos = () =>
    rig.robot.headers.filter((header) => header.protocol === HELLO_REQUEST);

  test("a ping goes out every 10 seconds once the hello has settled, in the version it agreed", async () => {
    const socket = await rig.connect();
    expect(pings()).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(60_000);

    expect(pings(socket)).toHaveLength(6);
    expect(new Set(pings().map((ping) => ping.version))).toEqual(
      new Set(["1.0"])
    );
    // Each one a different seq, which the robot's answer echoes.
    expect(new Set(pings().map((ping) => ping.seq)).size).toBe(6);
  });

  test("a robot that answers no hello is pinged too, in 1.0", async () => {
    rig.robot.helloVersion = null;
    const socket = await rig.connect();
    await jest.advanceTimersByTimeAsync(10_000); // both hellos time out

    await jest.advanceTimersByTimeAsync(10_000);

    expect(pings(socket).map((ping) => ping.version)).toEqual(["1.0"]);
  });

  test("the pings stop with the socket", async () => {
    const socket = await rig.connect();
    await jest.advanceTimersByTimeAsync(10_000);
    rig.api.localConnector.destroyAllClients();

    await jest.advanceTimersByTimeAsync(60_000);

    expect(pings(socket)).toHaveLength(1);
  });

  test("a robot that closes a socket that had been up for a while is reconnected at once", async () => {
    const first = await rig.connect();
    await jest.advanceTimersByTimeAsync(120_000);

    rig.robot.closeConnection(first);
    await jest.advanceTimersByTimeAsync(0);

    expect(rig.robot.sockets).toHaveLength(2);
    expect(
      hellos().filter((hello) => hello.socket === rig.robot.socket)
    ).toHaveLength(1);
    expect(rig.api.localConnector.isConnected(rig.duid)).toBe(true);
  });

  test("a socket closed within 15 seconds of its connect is reconnected 15 seconds after that connect, not in a loop", async () => {
    const first = await rig.connect();
    await jest.advanceTimersByTimeAsync(4_000);

    rig.robot.closeConnection(first);
    await jest.advanceTimersByTimeAsync(10_999);
    expect(rig.robot.sockets).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(rig.robot.sockets).toHaveLength(2);
  });

  test("a robot that stays away is retried after 1 minute, then 1.5, 2.25 … up to 10 minutes", async () => {
    const first = await rig.connect();
    await jest.advanceTimersByTimeAsync(120_000);
    rig.robot.acceptsConnections = false;
    const attempts = () =>
      rig.api.localConnector.lastConnectAttemptAt.get(rig.duid);

    rig.robot.closeConnection(first);
    await jest.advanceTimersByTimeAsync(0);
    const times = [attempts()];
    for (let i = 0; i < 9; i += 1) {
      const before = attempts();
      while (attempts() === before) {
        await jest.advanceTimersByTimeAsync(1_000);
      }
      times.push(attempts());
    }
    const gaps = times.slice(1).map((at, i) => (at - times[i]) / 1000);

    expect(gaps).toEqual([60, 90, 135, 202.5, 303.75, 455.625, 600, 600, 600]);
  });

  test("a robot that answers again starts the back-off over", async () => {
    const first = await rig.connect();
    await jest.advanceTimersByTimeAsync(120_000);
    rig.robot.acceptsConnections = false;
    rig.robot.closeConnection(first);
    // At once (refused), after 60 s (refused), after 90 s (refused).
    await jest.advanceTimersByTimeAsync(60_000 + 90_000);
    expect(rig.api.localConnector.reconnectAttempts.get(rig.duid)).toBe(4);

    rig.robot.acceptsConnections = true;
    await jest.advanceTimersByTimeAsync(135_000);
    expect(rig.api.localConnector.isConnected(rig.duid)).toBe(true);
    expect(rig.api.localConnector.reconnectAttempts.has(rig.duid)).toBe(false);

    await jest.advanceTimersByTimeAsync(120_000);
    rig.robot.closeConnection(rig.robot.socket);
    await jest.advanceTimersByTimeAsync(0);
    expect(rig.api.localConnector.isConnected(rig.duid)).toBe(true);
  });
});
