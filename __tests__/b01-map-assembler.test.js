"use strict";

// A large B01/Q7 map arrives split across protocol-300 parts and a final
// protocol-301 frame, sharing one (random, timestamp) and numbered by seq.
// Until this file's fix, the 300 part was dropped as an unknown protocol and
// the trailing 301 fragment was fed straight to decodeMapPayload, which
// threw "Unexpected encrypted B01 map payload length" (18516 % 16 = 4) on
// every saved-map load, so no rooms ever arrived.

const fs = require("fs");
const os = require("os");
const path = require("path");
const b01 = require("../roborockLib/lib/b01Q7Adapter");
const { Roborock } = require("../roborockLib/roborockAPI");

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function buildFrame(
  payload,
  protocol,
  { seq = 1, random = 2716216127, timestamp = 1794578237 } = {}
) {
  return { protocol, seq, random, timestamp, payload, version: "B01" };
}

describe("createB01MapResponseAssembler (port of python-roborock)", () => {
  test("a complete single-part 301 passes through regardless of seq", () => {
    const assembler = b01.createB01MapResponseAssembler();
    const payload = Buffer.from(
      Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64"),
      "ascii"
    );
    expect(assembler(buildFrame(payload, 301, { seq: 12750 }))).toEqual(
      payload
    );
  });

  test.each([
    ["in order", [0, 1]],
    ["out of order", [1, 0]],
  ])("two-part frame reassembles %s", (_label, order) => {
    const assembler = b01.createB01MapResponseAssembler();
    const full = Buffer.from(
      Buffer.from(Array.from({ length: 48 }, (_, i) => i)).toString("base64"),
      "ascii"
    );
    const messages = [
      buildFrame(full.subarray(0, 32), 300, { seq: 1 }),
      buildFrame(full.subarray(32), 301, { seq: 2 }),
    ];
    expect(assembler(messages[order[0]])).toBeNull();
    expect(assembler(messages[order[1]])).toEqual(full);
  });

  test.each([
    ["in order", [0, 1, 2]],
    ["reverse", [2, 1, 0]],
    ["suffix first", [1, 2, 0]],
  ])("three-part frame waits for seq 1 %s", (_label, order) => {
    const assembler = b01.createB01MapResponseAssembler();
    // 96 raw bytes -> 128 base64 chars; parts 2+3 alone decode to 48 bytes
    // (a multiple of 16), so a block-aligned suffix must not pass as whole.
    const full = Buffer.from(
      Buffer.from(Array.from({ length: 96 }, (_, i) => i)).toString("base64"),
      "ascii"
    );
    const messages = [
      buildFrame(full.subarray(0, 64), 300, { seq: 1 }),
      buildFrame(full.subarray(64, 96), 300, { seq: 2 }),
      buildFrame(full.subarray(96), 301, { seq: 3 }),
    ];
    expect(assembler(messages[order[0]])).toBeNull();
    expect(assembler(messages[order[1]])).toBeNull();
    expect(assembler(messages[order[2]])).toEqual(full);
  });

  test("a lone trailing 301 fragment is buffered, not failed, then completes", () => {
    const assembler = b01.createB01MapResponseAssembler();
    const full = Buffer.from(
      Buffer.from(Array.from({ length: 48 }, (_, i) => i)).toString("base64"),
      "ascii"
    );
    // The fragment alone decodes to a length that is not a multiple of 16:
    // exactly the shape that used to throw in decodeMapPayload.
    const fragment = full.subarray(32);
    expect(assembler(buildFrame(fragment, 301, { seq: 2 }))).toBeNull();
    expect(
      assembler(buildFrame(full.subarray(0, 32), 300, { seq: 1 }))
    ).toEqual(full);
  });

  test("incomplete frames beyond the cap are evicted oldest-first", () => {
    const assembler = b01.createB01MapResponseAssembler();
    const full = Buffer.from(
      Buffer.from(Array.from({ length: 48 }, (_, i) => i)).toString("base64"),
      "ascii"
    );
    const firstPart = full.subarray(0, 32);
    const lastPart = full.subarray(32);
    for (let idx = 0; idx < 5; idx += 1) {
      expect(
        assembler(buildFrame(firstPart, 300, { seq: 1, random: idx }))
      ).toBeNull();
    }
    // random=0 was evicted when random=4 arrived; its trailing fragment
    // buffers anew and returns null rather than joining a lost head.
    expect(
      assembler(buildFrame(lastPart, 301, { seq: 2, random: 0 }))
    ).toBeNull();
    // random=2 is still retained and completes cleanly.
    expect(assembler(buildFrame(lastPart, 301, { seq: 2, random: 2 }))).toEqual(
      full
    );
  });

  test("non-B01, non-map, or empty frames are ignored", () => {
    const assembler = b01.createB01MapResponseAssembler();
    const payload = Buffer.from(
      Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64"),
      "ascii"
    );
    expect(assembler(buildFrame(null, 301))).toBeNull();
    expect(assembler(buildFrame(Buffer.alloc(0), 301))).toBeNull();
    expect(assembler(buildFrame(payload, 102))).toBeNull();
    expect(
      assembler({ ...buildFrame(payload, 301), version: "1.0" })
    ).toBeNull();
  });
});

describe("onB01MapFrame with a split saved map (the reported failure)", () => {
  const MAP_FIXTURE = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "testdata", "b01_q7_map_fixture.json"),
      "utf8"
    )
  );

  function createApi() {
    const api = new Roborock({
      log: createLog(),
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-map-assembler-")),
    });
    api.getVacuumDeviceInfo = jest.fn((duid, attr) =>
      attr === "sn" ? MAP_FIXTURE.serial : ""
    );
    api.getProductAttribute = jest.fn(() => MAP_FIXTURE.model);
    return api;
  }

  test("a split fixture map settles the pending request with its rooms", async () => {
    const api = createApi();
    const full = Buffer.from(MAP_FIXTURE.payloadBase64, "ascii");
    // Split the base64 string in half: the trailing fragment decodes to 55
    // bytes (55 % 16 = 7), the same shape as the reported 18516-byte one.
    const half = Math.floor(full.length / 2);
    const random = 424242;
    const timestamp = 1794578237;

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    api.pendingB01MapRequests = new Map([
      ["duid-q7", { resolve, reject, timeout: undefined, liveFrames: 0 }],
    ]);

    expect(
      api.onB01MapFrame("duid-q7", full.subarray(0, half), {
        protocol: 300,
        seq: 1,
        random,
        timestamp,
        version: "B01",
      })
    ).toBe(false);
    expect(
      api.onB01MapFrame("duid-q7", full.subarray(half), {
        protocol: 301,
        seq: 2,
        random,
        timestamp,
        version: "B01",
      })
    ).toBe(true);

    const parsed = await promise;
    expect(parsed.rooms).toEqual(MAP_FIXTURE.expectedRooms);
    // The room cache is written by an async persist kicked off before the
    // request settled; give it a tick, as the live-room tests do.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(api.getB01RoomCache("duid-q7")).toEqual(MAP_FIXTURE.expectedRooms);
  });

  test("a trailing 301 that arrives first is buffered, not a decode error", async () => {
    const api = createApi();
    const full = Buffer.from(MAP_FIXTURE.payloadBase64, "ascii");
    const half = Math.floor(full.length / 2);
    const random = 777;
    const timestamp = 1794578237;

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    api.pendingB01MapRequests = new Map([
      ["duid-q7", { resolve, reject, timeout: undefined, liveFrames: 0 }],
    ]);

    // The fragment alone used to reject the request with "Unexpected
    // encrypted B01 map payload length". Now it waits for its head.
    expect(
      api.onB01MapFrame("duid-q7", full.subarray(half), {
        protocol: 301,
        seq: 2,
        random,
        timestamp,
        version: "B01",
      })
    ).toBe(false);
    expect(api.pendingB01MapRequests.has("duid-q7")).toBe(true);

    expect(
      api.onB01MapFrame("duid-q7", full.subarray(0, half), {
        protocol: 300,
        seq: 1,
        random,
        timestamp,
        version: "B01",
      })
    ).toBe(true);

    const parsed = await promise;
    expect(parsed.rooms).toEqual(MAP_FIXTURE.expectedRooms);
  });

  test("an unsplit 301 still works when called the old way (no frame info)", async () => {
    const api = createApi();
    expect(
      api.onB01MapFrame(
        "duid-q7",
        Buffer.from(MAP_FIXTURE.payloadBase64, "ascii")
      )
    ).toBe(false); // no request waiting; the frame itself decoded fine
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(api.getB01RoomCache("duid-q7")).toEqual(MAP_FIXTURE.expectedRooms);
  });

  test("two robots' split maps interleave without mixing parts", async () => {
    const api = createApi();
    const full = Buffer.from(MAP_FIXTURE.payloadBase64, "ascii");
    const half = Math.floor(full.length / 2);
    // Same (random, timestamp) on both robots: if the assemblers were
    // shared instead of one per duid, the parts would collide into one
    // frame and neither map would complete.
    const random = 5150;
    const timestamp = 1794578237;

    const promises = {};
    api.pendingB01MapRequests = new Map(
      ["duid-q7-a", "duid-q7-b"].map((duid) => {
        let resolve;
        let reject;
        promises[duid] = new Promise((res, rej) => {
          resolve = res;
          reject = rej;
        });
        return [duid, { resolve, reject, timeout: undefined, liveFrames: 0 }];
      })
    );

    const frame = (duid, payload, protocol, seq) =>
      api.onB01MapFrame(duid, payload, {
        protocol,
        seq,
        random,
        timestamp,
        version: "B01",
      });

    expect(frame("duid-q7-a", full.subarray(0, half), 300, 1)).toBe(false);
    expect(frame("duid-q7-b", full.subarray(0, half), 300, 1)).toBe(false);
    expect(frame("duid-q7-a", full.subarray(half), 301, 2)).toBe(true);
    expect(frame("duid-q7-b", full.subarray(half), 301, 2)).toBe(true);

    await expect(promises["duid-q7-a"]).resolves.toMatchObject({
      rooms: MAP_FIXTURE.expectedRooms,
    });
    await expect(promises["duid-q7-b"]).resolves.toMatchObject({
      rooms: MAP_FIXTURE.expectedRooms,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(api.getB01RoomCache("duid-q7-a")).toEqual(MAP_FIXTURE.expectedRooms);
    expect(api.getB01RoomCache("duid-q7-b")).toEqual(MAP_FIXTURE.expectedRooms);
  });
});
