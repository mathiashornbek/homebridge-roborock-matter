"use strict";

// The Q7 map decoder reads only the RobotMap fields python-roborock's
// b01_scmap.proto names for what the plugin needs (map type, head, pose,
// rooms, outlines) and steps over everything else by its length, including
// bytes inside fields it does not read.
//
// This file used to test a raw field survey that logged every scalar of a
// map, built to find which field carried the pose while the (1100, 1100)
// placeholder was unexplained. The schema answers that, and the live-room
// line now names the map type and the pose's update flag instead.

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

describe("the map decoder reads what it needs and steps over the rest", () => {
  test("bytes that are not protobuf inside an unread field do not stop the decode", () => {
    const garbage = Buffer.from([0x3c, 0x01, 0x02, 0x3f, 0xff, 0x7e]);
    const parsed = b01.parseScMapLiveState(
      Buffer.concat([
        submessage(9, garbage),
        submessage(8, poseMessage({ x: 1100, y: 1100 })),
      ])
    );
    expect(parsed.pose).toEqual({ x: 1100, y: 1100, update: 1 });
  });

  test("the real decoder still returns everything it did before", () => {
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
    expect(parsed.pose).toEqual({ x: 1.5, y: 1.5, update: 1 });
    expect(parsed.rooms).toEqual([{ roomId: 16, roomName: "Stue" }]);
    expect(parsed.roomChains).toHaveLength(1);
    expect(parsed.roomChains[0].points).toHaveLength(3);
  });
});
