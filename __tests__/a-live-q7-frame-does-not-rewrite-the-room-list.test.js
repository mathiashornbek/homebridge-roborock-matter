"use strict";

/**
 * A Q7's rooms come from its saved map; a live map frame says where the robot
 * is now (onB01MapFrame). Every live frame that carried rooms used to be
 * written over the persisted room list and to postpone the saved-map read by
 * six hours, so a live frame naming only this run's room shrank the Service
 * Area mid-run, and one without names renamed every room "Room 10" — and
 * either stayed so after the run.
 *
 * Frames serialized with python-roborock 7.13.0's own b01_scmap_pb2
 * (testdata/make-b01-live-frames-with-partial-rooms.py), on the geometry of
 * b01_scmap_frames.json.
 */

jest.mock(
  "mqtt",
  () => require("../test-support/b01-robot-on-a-fake-broker").fakeMqttModule
);

const fs = require("fs");
const path = require("path");
const {
  createB01Robots,
  scMapFrames,
  Q7_MODEL,
} = require("../test-support/b01-robot-on-a-fake-broker");

const DUID = "duid-1sal";
const { frames } = scMapFrames();
const partial = Object.fromEntries(
  Object.entries(
    JSON.parse(
      fs.readFileSync(
        path.join(
          __dirname,
          "testdata",
          "b01_live_frames_with_partial_rooms.json"
        ),
        "utf8"
      )
    )
  ).map(([name, hex]) => [name, Buffer.from(hex, "hex")])
);

const roomNames = (robots) =>
  robots.api.getRoomMappingsForDevice(DUID).map((room) => room.name);

describe("a live Q7 frame does not rewrite the room list", () => {
  let robots;
  afterEach(() => robots?.api.clearTimersAndIntervals());

  async function cleaningQ7(savedRooms) {
    robots = await createB01Robots({
      robots: [{ duid: DUID, name: "1. Sal", model: Q7_MODEL }],
    });
    robots.api.setDeviceNotify(jest.fn());
    if (savedRooms) {
      // The room list as the saved map (upload_by_mapid) gave it.
      await robots.api.setB01RoomCache(DUID, savedRooms);
    }
    robots.api.rememberB01LiveStatus(DUID, { state: 5, battery: 80 });
  }

  const SAVED = [
    { roomId: 10, roomName: "Stue" },
    { roomId: 11, roomName: "Gæsteværelse" },
  ];

  test("a live frame with the full named list changes nothing", async () => {
    await cleaningQ7(SAVED);
    await robots.q7MapFrame(DUID, frames.liveInStue);
    expect(robots.api.getB01LiveRoomForDevice(DUID)).toMatchObject({
      segmentId: 10,
    });
    expect(roomNames(robots)).toEqual(["Stue", "Gæsteværelse"]);
  });

  test("a live frame naming only this run's room keeps the whole list", async () => {
    await cleaningQ7(SAVED);
    await robots.q7MapFrame(DUID, partial.liveInStueOnlyStue);
    expect(robots.api.getB01LiveRoomForDevice(DUID)).toMatchObject({
      segmentId: 10,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(roomNames(robots)).toEqual(["Stue", "Gæsteværelse"]);
  });

  test("a live frame without room names keeps the names", async () => {
    await cleaningQ7(SAVED);
    await robots.q7MapFrame(DUID, partial.liveInStueNoNames);
    await new Promise((resolve) => setImmediate(resolve));
    expect(roomNames(robots)).toEqual(["Stue", "Gæsteværelse"]);
  });

  /** The scheduled room refresh asks the robot for its saved map. */
  async function expectTheSavedMapToBeRead() {
    const before = robots.sentTo(DUID).length;
    const refresh = robots.api.refreshB01Rooms(DUID).catch(() => undefined);
    await robots.waitForSent(DUID, before + 1);
    const request = await robots.q7Answers(DUID, {}, { code: -1 });
    await refresh;
    expect(request.method).toMatch(/get_map_list/);
  }

  test("a live frame does not postpone the saved-map read", async () => {
    await cleaningQ7(SAVED);
    await robots.q7MapFrame(DUID, frames.liveInStue);
    await new Promise((resolve) => setImmediate(resolve));
    await expectTheSavedMapToBeRead();
  });

  test("a robot with no rooms yet takes them from a live frame until its saved map is read", async () => {
    await cleaningQ7(null);
    await robots.q7MapFrame(DUID, frames.liveInStue);
    await new Promise((resolve) => setImmediate(resolve));
    expect(roomNames(robots)).toEqual(["Stue", "Gæsteværelse"]);
    await expectTheSavedMapToBeRead();
  });
});
