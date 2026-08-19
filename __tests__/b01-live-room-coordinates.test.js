"use strict";

// Mathias started both Q7s at 09:16 on 11 Aug and the live-room miss line
// finally carried numbers:
//
//   Garage:  position cell 22160,22160  (1 room outline in the map)
//   1. Sal:  position cell 22280,22100  (4 room outlines)
//
// A Roborock map is a couple of thousand cells across at most, so neither
// robot is "between rooms" — the computed position is nowhere near the map at
// all. Garage reporting x exactly equal to y is the tell: that is arithmetic,
// not a place a robot stood.
//
// The likely cause is a unit mismatch — a pose in millimetres divided by a
// resolution in metres is off by exactly 1000, and 1108 mm / 0.05 gives
// 22160 — but "likely" is not "measured". The position alone cannot separate
// a unit error from a wrong origin. What settles it is the range the outlines
// occupy, so the miss line now carries that too. This test pins the
// measurement, not the hypothesis: the fix comes after the next log says
// which one it is.

const b01 = require("../roborockLib/lib/b01Q7Adapter");

const HEAD = { minX: 0, minY: 0, resolution: 0.05, sizeX: 500, sizeY: 500 };

function squareRoom(roomId, x0, y0, size) {
  return {
    roomId,
    points: [
      { x: x0, y: y0 },
      { x: x0 + size, y: y0 },
      { x: x0 + size, y: y0 + size },
      { x: x0, y: y0 + size },
    ],
  };
}

describe("a miss reports where the outlines actually are", () => {
  test("the outline range and the map origin ride along", () => {
    const result = b01.describeLiveRoomResolution({
      head: HEAD,
      // 1108 mm read as metres, divided by a 0.05 m resolution: the exact
      // shape of the field report.
      pose: { x: 1108, y: 1108 },
      roomChains: [squareRoom(10, 12, 8, 40)],
    });

    // Reclassified in 3.11.0, and the change is the whole point of this file
    // having existed: when it was written, 22160 could not be told apart from
    // a robot standing between two rooms, so it was filed as one. A 47-minute
    // measurement later settled it — 226 of 227 fetches returned exactly this
    // shape while the same robot resolved real rooms on the other fetches —
    // and a position 44 map-widths outside the raster now says so.
    expect(result.reason).toBe("pose-placeholder");
    expect(result.cell).toEqual({ x: 22160, y: 22160 });
    // Without this, the log says "not inside any room" and leaves the reader
    // unable to tell a doorway from a broken transform.
    expect(result.outlineBounds).toEqual({
      minX: 12,
      minY: 8,
      maxX: 52,
      maxY: 48,
    });
    expect(result.head).toEqual({ minX: 0, minY: 0, resolution: 0.05 });
  });

  test("the numbers make the mismatch self-evident", () => {
    const result = b01.describeLiveRoomResolution({
      head: HEAD,
      pose: { x: 1108, y: 1108 },
      roomChains: [squareRoom(10, 12, 8, 40)],
    });

    // Three orders of magnitude between the position and the map is not a
    // robot in a doorway. Whoever reads the next log should not have to work
    // that out — the two ranges sit side by side.
    const span = result.outlineBounds.maxX - result.outlineBounds.minX;
    expect(result.cell.x / span).toBeGreaterThan(100);
  });

  test("a resolved position is unaffected and stays cheap", () => {
    const result = b01.describeLiveRoomResolution({
      head: HEAD,
      pose: { x: 1, y: 1 }, // cell 20,20 — inside the room
      roomChains: [squareRoom(10, 12, 8, 40)],
    });

    expect(result).toMatchObject({ roomId: 10, reason: "resolved" });
    // The bounding box is only computed on the failure path; a run that
    // resolves every position must not pay for the diagnostic.
    expect(result.outlineBounds).toBeUndefined();
  });

  test("an empty outline set cannot produce a bogus range", () => {
    const result = b01.describeLiveRoomResolution({
      head: HEAD,
      pose: { x: 1, y: 1 },
      roomChains: [],
    });

    expect(result.reason).toBe("no-room-outlines");
    expect(result.outlineBounds).toBeUndefined();
  });
});
