"use strict";

/**
 * A Q10's rooms come from the current-map packet it pushes, so its room clean
 * is reachable from Apple Home.
 *
 * The room-clean command for a Q10 shipped in 3.19.0, but nothing ever filled
 * a Q10's room list: the Q7 room fetch is refused for it, so the Service Area
 * exposed zero rooms and the command had no caller (#19). python-roborock
 * reads a Q10's rooms from the protocol-301 current-map packet (`01 01`) the
 * robot pushes after dpRequestDps — an LZ4 block holding the grid followed by
 * 47-byte room records (b01_q10_map_parser.py) — and cleans them with
 * `{"201":{"cmd":2,"clean_paramters":[id]}}`, misspelling included,
 * "verified live against ss07 hardware".
 *
 * The packets are built to that layout (test-support buildQ10MapPacket);
 * python-roborock's own parser was checked to read the same rooms from them.
 */

jest.mock(
  "mqtt",
  () => require("../test-support/b01-robot-on-a-fake-broker").fakeMqttModule
);

const {
  createB01Robots,
  buildQ10MapPacket,
  Q10_MODEL,
} = require("../test-support/b01-robot-on-a-fake-broker");

const DUID = "duid-q10";
const ROOMS = [
  { id: 9, name: "rr_living_room" },
  { id: 3, name: "Køkken" },
];

describe("a Q10's rooms come from the map it pushes", () => {
  let robots;
  beforeEach(async () => {
    robots = await createB01Robots({
      robots: [{ duid: DUID, name: "Kitchen Q10", model: Q10_MODEL }],
    });
  });
  afterEach(() => robots.api.clearTimersAndIntervals());

  test("a current-map push fills the room list the Service Area reads", async () => {
    await robots.mapPacket(DUID, buildQ10MapPacket({ rooms: ROOMS }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(robots.api.getRoomMappingsForDevice(DUID)).toEqual([
      { segmentId: 9, mapId: 0, name: "Living Room" },
      { segmentId: 3, mapId: 0, name: "Køkken" },
    ]);
    const lines = robots.log.info.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith("B01 rooms for Kitchen Q10"));
    expect(lines).toEqual([
      "B01 rooms for Kitchen Q10: Living Room (9), Køkken (3).",
    ]);
  });

  test("the same rooms pushed again are not rewritten or re-announced", async () => {
    await robots.mapPacket(DUID, buildQ10MapPacket({ rooms: ROOMS }));
    await robots.mapPacket(DUID, buildQ10MapPacket({ rooms: ROOMS }));
    await new Promise((resolve) => setImmediate(resolve));
    const lines = robots.log.info.mock.calls.filter(([line]) =>
      String(line).startsWith("B01 rooms for")
    );
    expect(lines).toHaveLength(1);
  });

  test("a room clean of those rooms goes out as the firmware expects it", async () => {
    await robots.mapPacket(DUID, buildQ10MapPacket({ rooms: ROOMS }));
    await robots.api.messageQueueHandler.sendRequest(
      DUID,
      "app_segment_clean",
      [{ segments: [9, 3], repeat: 1 }]
    );
    expect(robots.sentTo(DUID)).toEqual([
      { dps: { 201: { cmd: 2, clean_paramters: [9, 3] } } },
    ]);
  });

  test("other packets and a broken one leave the rooms alone", async () => {
    await robots.mapPacket(DUID, buildQ10MapPacket({ rooms: ROOMS }));
    // A trace packet (`02 01`) and a current-map packet cut short.
    await robots.mapPacket(DUID, Buffer.from([2, 1, 0, 0, 0, 0, 0, 0]));
    const broken = buildQ10MapPacket({ rooms: ROOMS }).subarray(0, 40);
    await robots.mapPacket(DUID, broken);
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      robots.api.getRoomMappingsForDevice(DUID).map((room) => room.segmentId)
    ).toEqual([9, 3]);
    expect(robots.log.warn).not.toHaveBeenCalled();
    expect(robots.log.error).not.toHaveBeenCalled();
  });

  test("a Q10 with no rooms yet is asked to push its map", async () => {
    await robots.api.refreshB01Rooms(DUID, { force: true });
    expect(robots.sentTo(DUID)).toEqual([{ dps: { 102: {} } }]);
  });
});
