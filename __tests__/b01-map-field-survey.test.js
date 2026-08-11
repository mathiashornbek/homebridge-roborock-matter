"use strict";

// Both Q7s reported a position of exactly (1100.0, 1100.0) while cleaning:
// the same value on two robots, two maps, and twelve minutes apart. A
// constant is not a position, so whatever field 8 carries on this firmware,
// it is not where the robot is.
//
// Guessing a replacement field number would be the third guess in a row on
// this code path, so the parser now surveys the payload instead: the size of
// every top-level field, and every scalar in the small ones. Two consecutive
// log lines are then a diff — the scalar that moved while the robot drove is
// the position, and the submessage that grew is the trail behind it.
//
// The survey has to survive being pointed at bytes whose schema nobody has,
// which is most of what these tests are about.

const b01 = require("../roborockLib/lib/b01Q7Adapter");

function varint(value) {
  const out = [];
  let remaining = value;
  while (remaining > 127) {
    out.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  out.push(remaining);
  return Buffer.from(out);
}

function tag(fieldNumber, wireType) {
  return varint(fieldNumber * 8 + wireType);
}

function varintField(fieldNumber, value) {
  return Buffer.concat([tag(fieldNumber, 0), varint(value)]);
}

function floatField(fieldNumber, value) {
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(value);
  return Buffer.concat([tag(fieldNumber, 5), buf]);
}

function submessage(fieldNumber, body) {
  return Buffer.concat([tag(fieldNumber, 2), varint(body.length), body]);
}

// DeviceCurrentPoseInfo: poseId=1, update=2, x=3, y=4, phi=5
function poseMessage({ poseId = 123, update = 1, x, y }) {
  return Buffer.concat([
    varintField(1, poseId),
    varintField(2, update),
    floatField(3, x),
    floatField(4, y),
    floatField(5, 1.57),
  ]);
}

describe("a live-room miss reports what the payload actually contains", () => {
  test("the size of every top-level field is recorded, including repeats", () => {
    const buffer = Buffer.concat([
      varintField(1, 0),
      submessage(8, poseMessage({ x: 1100, y: 1100 })),
      submessage(12, varintField(1, 42)),
      submessage(12, varintField(1, 7)),
    ]);

    const { rawSurvey } = b01.parseScMapLiveState(buffer);

    // Field 12 appears twice and the byte counts add up, so a field that
    // grows between two log lines is visible as growth rather than as a
    // number that happens to differ.
    expect(rawSurvey.fields).toEqual([
      { field: 1, count: 1, bytes: 0 },
      { field: 8, count: 1, bytes: 19 },
      { field: 12, count: 2, bytes: 4 },
    ]);
    expect(rawSurvey.truncated).toBe(false);
  });

  test("varints are surveyed, not just floats", () => {
    const buffer = submessage(8, poseMessage({ update: 0, x: 1100, y: 1100 }));

    const { rawSurvey } = b01.parseScMapLiveState(buffer);

    // This is the point of the whole exercise. DeviceCurrentPoseInfo carries
    // an `update` flag, and a float-only dump would have shown two plausible
    // coordinates and hidden the field saying they are stale.
    expect(rawSurvey.scalars["8.2"]).toBe(0);
    expect(rawSurvey.scalars["8.3"]).toBe(1100);
    expect(rawSurvey.scalars["8.4"]).toBe(1100);
  });

  test("a bare scalar on the map itself is seen at all", () => {
    const buffer = Buffer.concat([floatField(2, 4.25), varintField(20, 9)]);

    const { rawSurvey } = b01.parseScMapLiveState(buffer);

    // The parse loop only ever descended into submessages, so a position
    // stored as a plain float on RobotMap would have been invisible.
    expect(rawSurvey.scalars["2"]).toBeCloseTo(4.25, 5);
    expect(rawSurvey.scalars["20"]).toBe(9);
  });

  test("the last point of a pose trail survives as the current position", () => {
    // historyPose (field 6): a count, then repeated points. The robot is at
    // the end of the trail by construction, so a survey that stops at the top
    // level of field 6 would report the count and miss the position.
    const trail = Buffer.concat([
      varintField(1, 3),
      submessage(2, Buffer.concat([floatField(2, 0.1), floatField(3, 0.2)])),
      submessage(2, Buffer.concat([floatField(2, 0.5), floatField(3, 0.6)])),
      submessage(2, Buffer.concat([floatField(2, 1.25), floatField(3, 2.5)])),
    ]);

    const { rawSurvey } = b01.parseScMapLiveState(submessage(6, trail));

    expect(rawSurvey.scalars["6.1"]).toBe(3);
    expect(rawSurvey.scalars["6.2.2"]).toBeCloseTo(1.25, 5);
    expect(rawSurvey.scalars["6.2.3"]).toBeCloseTo(2.5, 5);
  });

  test("the occupancy grid is measured, not walked", () => {
    // Tens of kilobytes of raw cells are not protobuf. Reading them as if
    // they were produces nonsense at best and throws at worst, and either way
    // buries the handful of scalars that matter.
    const grid = Buffer.alloc(20000, 0xff);
    const buffer = Buffer.concat([
      submessage(4, grid),
      submessage(8, poseMessage({ x: 1100, y: 1100 })),
    ]);

    const { rawSurvey } = b01.parseScMapLiveState(buffer);

    expect(rawSurvey.fields).toContainEqual({
      field: 4,
      count: 1,
      bytes: 20000,
    });
    expect(Object.keys(rawSurvey.scalars).some((k) => k.startsWith("4"))).toBe(
      false
    );
    expect(rawSurvey.scalars["8.3"]).toBe(1100);
  });

  test("bytes that are not protobuf cannot take live-room tracking down", () => {
    // Wire types 3, 4, 6 and 7 make skipField throw, and a short submessage
    // of arbitrary bytes will hit one eventually. The survey is a diagnostic;
    // it must never be the reason a robot stops reporting its room.
    const garbage = Buffer.from([0x3c, 0x01, 0x02, 0x3f, 0xff, 0x7e]);
    const buffer = Buffer.concat([
      submessage(9, garbage),
      submessage(8, poseMessage({ x: 1100, y: 1100 })),
    ]);

    let parsed;
    expect(() => {
      parsed = b01.parseScMapLiveState(buffer);
    }).not.toThrow();

    expect(parsed.rawSurvey.truncated).toBe(true);
    // And the fields after the bad one are still parsed normally.
    expect(parsed.pose).toEqual({ x: 1100, y: 1100 });
    expect(parsed.rawSurvey.scalars["8.3"]).toBe(1100);
  });

  test("the line cannot grow without bound", () => {
    const many = [];
    for (let field = 1; field <= 200; field += 1) {
      many.push(varintField(field, field));
    }

    const { rawSurvey } = b01.parseScMapLiveState(Buffer.concat(many));

    expect(rawSurvey.truncated).toBe(true);
    expect(Object.keys(rawSurvey.scalars).length).toBeLessThanOrEqual(48);
    expect(rawSurvey.fields.length).toBeLessThanOrEqual(48);
  });

  test("the real decoder still returns everything it did before", () => {
    // The survey rides along with the existing parse; it must not have
    // displaced head, pose, rooms or outlines.
    const head = Buffer.concat([
      varintField(2, 500),
      varintField(3, 500),
      floatField(4, -8),
      floatField(5, -8),
      floatField(8, 0.05),
    ]);
    const room = Buffer.concat([
      varintField(1, 16),
      submessage(2, Buffer.from("Stue", "utf8")),
    ]);
    const chain = Buffer.concat([
      varintField(1, 16),
      submessage(2, Buffer.concat([varintField(1, 10), varintField(2, 10)])),
      submessage(2, Buffer.concat([varintField(1, 40), varintField(2, 10)])),
      submessage(2, Buffer.concat([varintField(1, 40), varintField(2, 40)])),
    ]);

    const parsed = b01.parseScMapLiveState(
      Buffer.concat([
        submessage(3, head),
        submessage(8, poseMessage({ x: 1.5, y: 1.5 })),
        submessage(12, room),
        submessage(14, chain),
      ])
    );

    expect(parsed.head).toMatchObject({ minX: -8, minY: -8, sizeX: 500 });
    expect(parsed.pose).toEqual({ x: 1.5, y: 1.5 });
    expect(parsed.rooms).toEqual([{ roomId: 16, roomName: "Stue" }]);
    expect(parsed.roomChains).toHaveLength(1);
    expect(parsed.roomChains[0].points).toHaveLength(3);
  });
});
