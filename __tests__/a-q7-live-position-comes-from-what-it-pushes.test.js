"use strict";

/**
 * A Q7's live position comes from the live map frames it pushes while it
 * cleans; the saved map a request returns is used for rooms and outlines only.
 *
 * The field (pi-roborock.log 19/21 Oct 2026, "1. Sal", origin -14,-5): 226 of
 * 227 live-room fetches during a clean carried the pose (1100, 1100), cell
 * 22280,22100, and a handful named a real room. python-roborock explains the
 * shape: `service.upload_by_mapid` returns the SAVED map, which "carries no
 * live pose", while "Q7 devices additionally stream map frames unprompted
 * while cleaning ... Pushed frames carry the live robot pose" and only
 * `mapType == 0` is the live map (b01/q7/map_content.py, b01_map_parser.py).
 * The plugin resolved its pending request with whichever 301 frame came first
 * and read that frame's pose, and every other push went through the classic
 * parser and was counted as a frame for another controller.
 *
 * Frames are SCMaps serialized by python-roborock's own schema
 * (testdata/b01_scmap_frames.json), encrypted and framed as a Q7 sends them,
 * and fed through the real MQTT handler.
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
const {
  describeDroppedFrames,
  resetFrameCounters,
} = require("../roborockLib/lib/roborock_mqtt_connector");

const DUID = "duid-1sal";
const { frames } = scMapFrames();

async function cleaningQ7() {
  resetFrameCounters();
  const robots = await createB01Robots({
    robots: [{ duid: DUID, name: "1. Sal", model: Q7_MODEL }],
  });
  robots.notify = jest.fn();
  robots.api.setDeviceNotify(robots.notify);
  // The robot is cleaning (status 5), as the status loop last read it.
  robots.api.rememberB01LiveStatus(DUID, { state: 5, battery: 80 });
  return robots;
}

/** Start the fallback map request and wait until it is on the wire. */
async function pendingMapRequest(robots) {
  robots.api._b01LiveRoomState?.delete(DUID);
  const fetch = robots.api.refreshB01LiveRoom(DUID);
  await robots.waitForSent(DUID, 1);
  await robots.q7Answers(DUID, { map_list: [{ id: 1, cur: true }] });
  const sent = await robots.waitForSent(DUID, 2);
  expect(sent[1].dps["10000"].method).toBe("service.upload_by_mapid");
  // Wrapped: an async function returning the promise would adopt it, and the
  // caller would wait for the very answer it has not sent yet.
  return { fetch };
}

describe("the live position comes from pushed live frames", () => {
  let robots;
  afterEach(() => robots?.api.clearTimersAndIntervals());

  test("a pushed live frame places the robot with nothing asked", async () => {
    robots = await cleaningQ7();
    await robots.q7MapFrame(DUID, frames.liveInStue);

    expect(robots.api.getB01LiveRoomForDevice(DUID)).toMatchObject({
      segmentId: 10,
      roomName: "Stue",
    });
    expect(robots.sentTo(DUID)).toEqual([]);
    // The room change is re-broadcast for a prompt Service Area publish.
    expect(robots.notify).toHaveBeenCalledWith("CloudMessage", {
      duid: DUID,
      payload: [{ state: 5, battery: 80 }],
    });
  });

  test("a live frame whose pose is a placeholder is no position", async () => {
    robots = await cleaningQ7();
    await robots.q7MapFrame(DUID, frames.livePlaceholder);

    expect(robots.api.getB01LiveRoomForDevice(DUID)).toBeNull();
    const line = robots.log.info.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes("placeholder"));
    expect(line).toMatch(/map type 0/);
  });

  test("pushes are not counted as frames for another controller", async () => {
    robots = await cleaningQ7();
    await robots.q7MapFrame(DUID, frames.liveInStue);
    await robots.q7MapFrame(DUID, frames.liveInGaest);

    expect(
      describeDroppedFrames(DUID).byReason["addressed-elsewhere"]
    ).toBeUndefined();
  });

  test("a frame that arrives after the run ended does not place the robot", async () => {
    robots = await cleaningQ7();
    robots.api.rememberB01LiveStatus(DUID, { state: 8 });
    await robots.q7MapFrame(DUID, frames.liveInStue);
    expect(robots.api.getB01LiveRoomForDevice(DUID)).toBeNull();
  });
});

describe("a map request is settled only by the saved map it asked for", () => {
  let robots;
  afterEach(() => robots?.api.clearTimersAndIntervals());

  test("a saved map is never a position, even one whose pose is inside the map", async () => {
    robots = await cleaningQ7();
    const { fetch } = await pendingMapRequest(robots);
    await robots.q7MapFrame(DUID, frames.savedInStue);
    await fetch;

    expect(robots.api.getB01LiveRoomForDevice(DUID)).toBeNull();
    expect(robots.api.getB01RoomCache(DUID).map((room) => room.roomId)).toEqual(
      [10, 11]
    );
    // The remaining line names the map type, so one clean settles which kind
    // of frame this robot returns on request.
    const line = robots.log.info.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes("saved map"));
    expect(line).toMatch(/map type 1/);
  });

  test("a live push while a request waits places the robot and leaves the request waiting", async () => {
    robots = await cleaningQ7();
    const { fetch } = await pendingMapRequest(robots);

    await robots.q7MapFrame(DUID, frames.liveInGaest);
    expect(robots.api.getB01LiveRoomForDevice(DUID)).toMatchObject({
      segmentId: 11,
    });
    expect(robots.api.pendingB01MapRequests.has(DUID)).toBe(true);

    // The saved map settles it, and its placeholder moves nobody.
    await robots.q7MapFrame(DUID, frames.savedPlaceholder);
    await fetch;
    expect(robots.api.pendingB01MapRequests.has(DUID)).toBe(false);
    expect(robots.api.getB01LiveRoomForDevice(DUID)).toMatchObject({
      segmentId: 11,
    });
  });

  test("the saved map first, then the live push: the same answer", async () => {
    robots = await cleaningQ7();
    const { fetch } = await pendingMapRequest(robots);
    await robots.q7MapFrame(DUID, frames.savedPlaceholder);
    await fetch;
    expect(robots.api.getB01LiveRoomForDevice(DUID)).toBeNull();

    await robots.q7MapFrame(DUID, frames.liveInGaest);
    expect(robots.api.getB01LiveRoomForDevice(DUID)).toMatchObject({
      segmentId: 11,
    });
  });

  test("no request is made while live frames keep arriving", async () => {
    robots = await cleaningQ7();
    await robots.q7MapFrame(DUID, frames.liveInStue);
    await robots.api.refreshB01LiveRoom(DUID);
    expect(robots.sentTo(DUID)).toEqual([]);
  });
});

describe("what a request that gets no saved map says", () => {
  let robots;
  afterEach(() => {
    robots?.api.clearTimersAndIntervals();
    jest.useRealTimers();
  });

  async function timedOutRequest(beforeTimeout) {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    robots = await cleaningQ7();
    const { fetch } = await pendingMapRequest(robots);
    const failed = robots.api.pendingB01MapRequests
      .get(DUID)
      .promise.catch((error) => error);
    await beforeTimeout();
    jest.advanceTimersByTime(20_000);
    const error = await failed;
    await fetch;
    return error;
  }

  test("only live frames arrived: said as such, and not a failure", async () => {
    const error = await timedOutRequest(() =>
      robots.q7MapFrame(DUID, frames.liveInStue)
    );

    expect(error.message).toMatch(/live map frame\(s\) \(map type 0\)/);
    expect(error.unansweredRequest).toBe(false);
    expect(robots.api._b01LiveRoomState.get(DUID).consecutiveFailures).toBe(0);
    expect(robots.api.getB01LiveRoomForDevice(DUID)).toMatchObject({
      segmentId: 10,
    });
  });

  test("nothing arrived: a timeout, counted as before", async () => {
    const error = await timedOutRequest(async () => undefined);

    expect(error.message).toMatch(/timed out after 20s/);
    expect(error.unansweredRequest).toBe(true);
    expect(robots.api._b01LiveRoomState.get(DUID).consecutiveFailures).toBe(1);
  });
});
