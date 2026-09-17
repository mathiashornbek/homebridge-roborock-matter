"use strict";

/**
 * The B01/Q7 live-room fetch is two requests, not one:
 *
 *   1. `get_map_list`                    — cheap, 10s timeout
 *   2. `service.upload_by_mapid`         — the heavy map payload, 20s timeout
 *
 * 3.30.0 wrapped both in one try, called `noteMethodAnswered("get_map_list")`
 * only after leg 2 had been fetched, decoded and cached, and recorded every
 * failure — including leg 2's own `B01 map request timed out after 20s`
 * rejection — against `get_map_list`.
 *
 * So a robot that answers `get_map_list` in 200 ms every single time, but
 * whose map-upload channel is silent, had its `get_map_list` counter climb to
 * six and the whole live-room fetch suppressed for six hours. Worse, the
 * diagnostics export then named `get_map_list` — pointing whoever reads it at
 * the one channel that was working perfectly.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");
const b01Q7Adapter = require("../roborockLib/lib/b01Q7Adapter");

function createApi() {
  const log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const api = new Roborock({
    log,
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "blame-")),
  });
  api.describeDevice = (duid) => `Robot ${duid}`;
  return { api, log };
}

const UPLOAD = b01Q7Adapter.B01_MAP_UPLOAD_METHOD;

describe("each request is blamed for its own silence", () => {
  test("the map-upload timeout is not recorded against get_map_list", () => {
    const { api } = createApi();
    const error = new Error(
      "B01 map request timed out after 20s for Robot duid-q7."
    );

    api.noteMethodUnanswered("duid-q7", UPLOAD, error);

    expect(
      api.unansweredMethods.describeOpen().map((entry) => entry.method)
    ).not.toContain("get_map_list");
  });

  test("six upload timeouts close the upload leg, not the list leg", () => {
    const { api } = createApi();
    const error = () =>
      new Error("B01 map request timed out after 20s for Robot duid-q7.");

    for (let i = 0; i < 6; i += 1) {
      api.noteMethodUnanswered("duid-q7", UPLOAD, error());
    }

    expect(api.unansweredMethods.shouldSkip("duid-q7", UPLOAD)).toBe(true);
    expect(api.unansweredMethods.shouldSkip("duid-q7", "get_map_list")).toBe(
      false
    );
  });

  test("the diagnostics name the request that actually went unanswered", () => {
    const { api } = createApi();
    for (let i = 0; i < 6; i += 1) {
      api.noteMethodUnanswered(
        "duid-q7",
        UPLOAD,
        new Error("B01 map request timed out after 20s for Robot duid-q7.")
      );
    }

    const open = api.unansweredMethods.describeOpen();
    expect(open).toHaveLength(1);
    expect(open[0].method).toBe(UPLOAD);
  });

  test("a B01 map-upload timeout counts as no answer at all", () => {
    const {
      isUnansweredRequest,
    } = require("../roborockLib/lib/unansweredMethodBreaker");
    // It carries no connection state, so nothing excludes it — but it must
    // still be recognised as a timeout rather than falling through silently.
    expect(
      isUnansweredRequest(
        new Error("B01 map request timed out after 20s for Robot duid-q7.")
      )
    ).toBe(true);
  });
});

describe("the source keeps the two legs apart", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "roborockLib", "roborockAPI.js"),
    "utf8"
  );

  /** Just the B01 live-room fetch, so a second get_map_list caller elsewhere
   * in the file cannot satisfy or break these. */
  const liveRoomFetch = (() => {
    const start = source.indexOf("liveState.inflight = (async () => {");
    return source.slice(start, start + 4000);
  })();

  test("get_map_list is acknowledged before the upload leg is attempted", () => {
    const listCall = liveRoomFetch.indexOf('"get_map_list"');
    const ack = liveRoomFetch.indexOf(
      'this.noteMethodAnswered(duid, "get_map_list");'
    );
    const upload = liveRoomFetch.indexOf(
      "await this.sendB01MapRequest(duid, mapId)"
    );
    expect(listCall).toBeGreaterThan(-1);
    expect(ack).toBeGreaterThan(listCall);
    expect(upload).toBeGreaterThan(ack);
  });

  test("the upload leg has its own catch, naming its own method", () => {
    const uploadAt = liveRoomFetch.indexOf(
      "rawPayload = await this.sendB01MapRequest"
    );
    const region = liveRoomFetch.slice(
      uploadAt,
      liveRoomFetch.indexOf("const serial = this.getVacuumDeviceInfo(duid,")
    );
    expect(uploadAt).toBeGreaterThan(-1);
    expect(region).toMatch(/B01_MAP_UPLOAD_METHOD/);
    expect(region).not.toMatch(/"get_map_list"/);
  });

  test("a closed upload leg also skips the fetch, so leg 1 is not spent for nothing", () => {
    expect(source).toMatch(
      /shouldSkip\(duid, "get_map_list"\)\s*\|\|[\s\S]{0,120}B01_MAP_UPLOAD_METHOD/
    );
  });
});
