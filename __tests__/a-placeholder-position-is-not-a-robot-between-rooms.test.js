"use strict";

// Measured on Mathias' own Q7 on 19 August, during a 47-minute clean, with
// 227 live-room fetches:
//
//   226 of them placed the robot at cell 22280,22100 — the same cell every
//   time — while the room outlines spanned 38-293 x 90-227 and the map raster
//   was 500 cells wide. The underlying pose was exactly (1100, 1100), the same
//   constant two other Q7s reported on 11 August.
//
//   The remaining fetches resolved Stue, then Gang, then Soveværelse, in the
//   order the robot actually moved.
//
// So the robot does send a true position — it just serves a placeholder on
// most fetches, and every one of those was being reported as "the robot's
// position did not fall inside any known room outline (it may be between
// rooms)". That sentence is wrong twice: the robot was not between rooms, and
// there was nothing for the user to do about it. It also inflated the miss
// counter, producing "after 46 unresolved position(s)" for a robot that had
// been cleaning one room the entire time.
//
// The rule below is about geometry, not about the number 1100. A constant
// picked by Roborock can change; a position outside the map the robot itself
// built cannot become valid.

const b01 = require("../roborockLib/lib/b01Q7Adapter");

/** 500x500 cells at 5 cm, origin at 0,0 — the shape the field maps have. */
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

const ROOMS = [squareRoom(10, 12, 8, 40), squareRoom(13, 60, 8, 40)];

describe("a position off the map is not a miss the user can act on", () => {
  test("the field placeholder is recognised for what it is", () => {
    const result = b01.describeLiveRoomResolution({
      head: HEAD,
      pose: { x: 1100, y: 1100 },
      roomChains: ROOMS,
    });

    expect(result.reason).toBe("pose-placeholder");
    expect(result.cell).toEqual({ x: 22000, y: 22000 });
    expect(result.roomId).toBeNull();
  });

  test("a robot merely outside every room still counts as a real miss", () => {
    // The case that must survive: a doorway, a hallway nobody named, a strip
    // of floor the outlines do not cover. Outside every outline, inside the
    // map. Collapsing this into the placeholder class would hide the one
    // diagnosis the miss line exists for.
    for (const cell of [
      { x: 55, y: 20 }, // between the two rooms
      { x: 5, y: 5 }, // short of both
      { x: 480, y: 480 }, // far corner of the raster, still on it
      { x: 400, y: 400 },
    ]) {
      const result = b01.describeLiveRoomResolution({
        head: HEAD,
        pose: { x: cell.x * 0.05, y: cell.y * 0.05 },
        roomChains: ROOMS,
      });

      expect({ cell, reason: result.reason }).toEqual({
        cell,
        reason: "pose-outside-outlines",
      });
    }
  });

  test("a real position still resolves, and now says where it was", () => {
    // The cell rides along on a hit as well as on a miss. Before this, the log
    // could show what a FAILING position looked like but never a succeeding
    // one, so the two could not be compared — which is why it took a second
    // field session to work out that both kinds were arriving in one run.
    const result = b01.describeLiveRoomResolution({
      head: HEAD,
      pose: { x: 20 * 0.05, y: 20 * 0.05 },
      roomChains: ROOMS,
    });

    expect(result.reason).toBe("resolved");
    expect(result.roomId).toBe(10);
    expect(result.cell).toEqual({ x: 20, y: 20 });
  });

  test("the rule is geometry, not the constant 1100", () => {
    // If Roborock ships a different placeholder tomorrow this must still hold,
    // and a hard-coded 1100 would not. Anything far enough off the raster is
    // the same class of non-answer.
    for (const pose of [
      { x: 1100, y: 1100 },
      { x: 5000, y: 5000 },
      { x: -900, y: -900 },
      { x: 1100, y: 12 }, // one axis is enough
    ]) {
      const result = b01.describeLiveRoomResolution({
        head: HEAD,
        pose,
        roomChains: ROOMS,
      });

      expect({ pose, reason: result.reason }).toEqual({
        pose,
        reason: "pose-placeholder",
      });
    }
  });

  test("a header without a raster size falls back to the outlines", () => {
    // Older or partial map payloads carry no size. There is nothing better to
    // compare against then, so the outline span is used with a wide margin —
    // wide enough that a doorway is never mistaken for a placeholder.
    const headless = { minX: 0, minY: 0, resolution: 0.05 };

    expect(
      b01.describeLiveRoomResolution({
        head: headless,
        pose: { x: 1100, y: 1100 },
        roomChains: ROOMS,
      }).reason
    ).toBe("pose-placeholder");

    expect(
      b01.describeLiveRoomResolution({
        head: headless,
        pose: { x: 55 * 0.05, y: 20 * 0.05 },
        roomChains: ROOMS,
      }).reason
    ).toBe("pose-outside-outlines");
  });
});
