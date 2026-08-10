"use strict";

// A day of field logs from a three-robot house produced 51 copies of "the
// robot's position did not fall inside any known room outline" — a sentence
// that names exactly one cause. The resolver returns null for four reasons:
// no map header, no robot position in the payload, no room outlines in the
// payload, and a position genuinely outside every outline. Three of those
// four were being reported as the fourth, which sends every investigation
// down the same wrong path.
//
// The same logs showed the failure line printing a raw 22-character duid
// while the success line right next to it printed the robot's name — so the
// one message written to identify a misbehaving robot was the unreadable one.

const fs = require("fs");
const os = require("os");
const path = require("path");
const b01 = require("../roborockLib/lib/b01Q7Adapter");
const { Roborock } = require("../roborockLib/roborockAPI");

/** A square room outline in map-cell coordinates. */
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

const HEAD = { minX: 0, minY: 0, resolution: 0.05, sizeX: 500, sizeY: 500 };

describe("a failed live-room lookup says which of the four things went wrong", () => {
  test("a resolved position reports the room and says so", () => {
    const result = b01.describeLiveRoomResolution({
      head: HEAD,
      pose: { x: 1, y: 1 }, // cell 20,20
      roomChains: [squareRoom(42, 0, 0, 100)],
    });

    expect(result).toMatchObject({ roomId: 42, reason: "resolved" });
  });

  test("a payload with no robot position is not called 'between rooms'", () => {
    const result = b01.describeLiveRoomResolution({
      head: HEAD,
      pose: null,
      roomChains: [squareRoom(42, 0, 0, 100)],
    });

    // This is the case that matters most: it means the map channel answered
    // but carried no pose, which is a completely different problem from a
    // robot standing in a doorway.
    expect(result.reason).toBe("no-pose");
    expect(result.roomId).toBeNull();
  });

  test("a payload with no room outlines is distinguished from a bad position", () => {
    const result = b01.describeLiveRoomResolution({
      head: HEAD,
      pose: { x: 1, y: 1 },
      roomChains: [],
    });

    expect(result.reason).toBe("no-room-outlines");
    expect(result.outlineCount).toBe(0);
  });

  test("a missing map header is its own cause", () => {
    const result = b01.describeLiveRoomResolution({
      head: null,
      pose: { x: 1, y: 1 },
      roomChains: [squareRoom(42, 0, 0, 100)],
    });

    expect(result.reason).toBe("no-map-header");
  });

  test("a position genuinely outside every outline keeps the original meaning", () => {
    const result = b01.describeLiveRoomResolution({
      head: HEAD,
      pose: { x: 20, y: 20 }, // cell 400,400 — well outside the room
      roomChains: [squareRoom(42, 0, 0, 100)],
    });

    expect(result.reason).toBe("pose-outside-outlines");
    // The cell coordinates ride along so a coordinate-transform bug is
    // visible in the log instead of needing a debug build to find.
    expect(result.cell).toEqual({ x: 400, y: 400 });
  });

  test("the old boolean-ish entry point still behaves exactly as before", () => {
    const chains = [squareRoom(7, 0, 0, 100)];

    expect(
      b01.resolveLiveRoomId({
        head: HEAD,
        pose: { x: 1, y: 1 },
        roomChains: chains,
      })
    ).toBe(7);
    expect(
      b01.resolveLiveRoomId({ head: HEAD, pose: null, roomChains: chains })
    ).toBeNull();
    expect(
      b01.resolveLiveRoomId({
        head: HEAD,
        pose: { x: 1, y: 1 },
        roomChains: [],
      })
    ).toBeNull();
  });
});

describe("log lines name the robot, not its duid", () => {
  function createApi(name) {
    const api = new Roborock({
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "describe-device-")),
    });
    api.getVacuumDeviceInfo = jest.fn((duid, property) =>
      property === "name" ? name : ""
    );
    return api;
  }

  test("a named robot is described by its name", () => {
    expect(createApi("1. Sal").describeDevice("6LfhmydLLig0C1Oorp768U")).toBe(
      "1. Sal"
    );
  });

  test("an unnamed robot still gets an identifier rather than 'undefined'", () => {
    expect(createApi("").describeDevice("6LfhmydLLig0C1Oorp768U")).toBe(
      "6LfhmydLLig0C1Oorp768U"
    );
  });
});

describe("the B01 cadence the log announces is the cadence the code uses", () => {
  test("the startup line is derived from the constants, not written by hand", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "roborockLib", "roborockAPI.js"),
      "utf8"
    );

    // 3.2.0 changed the idle gap from 45s to 25s and left the startup line
    // announcing 45s, so the log contradicted the code for anyone reading it
    // to work out why a run took so long to show up. The message must not
    // contain hand-written numbers at all.
    const startupLine =
      /Starting the dedicated B01\/Q7 status loop \(([^)]*)\)/.exec(source)[1];

    // Strip the interpolations; whatever literal text is left must not quote
    // a cadence of its own.
    const literalText = startupLine.replace(/\$\{[^}]*\}/g, "");
    expect(literalText).not.toMatch(/\d/);

    expect(startupLine).toContain("B01_STATUS_TICK_MS");
    expect(startupLine).toContain("B01_STATUS_ACTIVE_GAP_MS");
    expect(startupLine).toContain("B01_STATUS_IDLE_GAP_MS");

    // And the gap selection must use the same constants rather than literals.
    expect(source).toMatch(
      /options\.force\s*\?\s*B01_STATUS_FORCED_GAP_MS\s*:\s*isActive\s*\?\s*B01_STATUS_ACTIVE_GAP_MS\s*:\s*B01_STATUS_IDLE_GAP_MS/
    );
  });
});
