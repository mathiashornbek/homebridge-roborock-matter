"use strict";

/**
 * A classic robot's live room is read from its map the way the reference
 * parser reads it.
 *
 * python-roborock hands RRMaps to vacuum-map-parser-roborock, whose
 * `get_room_at_pixel` counts a pixel as a room only when its low three bits
 * are 7, and never 0xFF (floor no room has claimed) or 0x07 (scanned). It
 * reads the robot's y at data+4 whether or not an angle follows, and rounds
 * `x/50 - left`. The plugin read 0xFF as room 31, any pixel with low bits 2-6
 * as a room, y at the x offset on an 8-byte position block, and floored.
 *
 * Every expected room below is what vacuum-map-parser-roborock 0.1.5 answers
 * for the identical buffer (testdata/rrmap-room-by-reference.py).
 */

const RRMapParser = require("../roborockLib/lib/RRMapParser");
const {
  imageBlock,
  robotPositionBlock,
  rrMap,
  roomPixel,
} = require("../test-support/rrmap-builder");

// Deliberately asymmetric origin, so x and y cannot be swapped unnoticed.
const WIDTH = 10;
const HEIGHT = 8;
const TOP = 200;
const LEFT = 100;

function mapWith(pixelAt, [x, y], options) {
  const pixels = [];
  for (let row = 0; row < HEIGHT; row += 1) {
    for (let column = 0; column < WIDTH; column += 1) {
      pixels.push(pixelAt(column, row));
    }
  }
  return rrMap([
    imageBlock({ top: TOP, left: LEFT, width: WIDTH, height: HEIGHT, pixels }),
    robotPositionBlock(x, y, options),
  ]);
}

/** A robot 10 mm into pixel (column, row): unambiguous under any rounding. */
const inPixel = (column, row) => [
  (LEFT + column) * 50 + 10,
  (TOP + row) * 50 + 10,
];

// [name, pixel layout, robot position, position options, reference answer]
const CASES = [
  [
    "a room pixel",
    (column) => roomPixel(column < 5 ? 16 : 17),
    inPixel(2, 3),
    {},
    16,
  ],
  [
    "floor no room has claimed (0xFF)",
    (column) => (column === 4 ? 0xff : roomPixel(16)),
    inPixel(4, 3),
    {},
    null,
  ],
  [
    "a scanned pixel (0x07)",
    (column) => (column === 4 ? 0x07 : roomPixel(16)),
    inPixel(4, 3),
    {},
    null,
  ],
  [
    "an obstacle pixel inside a room",
    (column) => (column === 4 ? (16 << 3) | 1 : roomPixel(16)),
    inPixel(4, 3),
    {},
    null,
  ],
  [
    "a pixel whose low bits are not 7",
    (column) => (column === 4 ? (5 << 3) | 2 : roomPixel(16)),
    inPixel(4, 3),
    {},
    null,
  ],
  [
    "an 8-byte position block (no angle)",
    (column, row) => roomPixel(row === 6 ? 17 : 16),
    inPixel(2, 6),
    { withAngle: false },
    17,
  ],
  [
    "a position past the middle of a pixel rounds to the next one",
    (column) => roomPixel(column < 4 ? 16 : 17),
    [(LEFT + 3) * 50 + 30, (TOP + 3) * 50 + 10],
    {},
    17,
  ],
  [
    "a position exactly between two pixels goes to the even one, as Python rounds",
    (column) => roomPixel(column < 3 ? 16 : 17),
    [(LEFT + 2) * 50 + 25, (TOP + 3) * 50 + 10],
    {},
    16,
  ],
];

describe("the live room is read as vacuum-map-parser-roborock reads it", () => {
  test.each(CASES)("%s", (_name, pixelAt, position, options, room) => {
    expect(
      RRMapParser.resolveLiveSegmentFromMapBuffer(
        mapWith(pixelAt, position, options)
      )
    ).toBe(room);
  });
});
