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

/** The live-room paths claim both legs before sending; stand in for that. */
function govern(api, duid, method) {
  api.unansweredMethods.govern(duid, method);
}

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
    govern(api, "duid-q7", UPLOAD);
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
    govern(api, "duid-q7", UPLOAD);
    govern(api, "duid-q7", "get_map_list");
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
    govern(api, "duid-q7", UPLOAD);
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

describe("the live-room fetch keeps the two legs apart", () => {
  const uploadTimeout = () =>
    Object.assign(
      new Error("B01 map request timed out after 20s for Robot duid-q7."),
      { unansweredRequest: true, transportWasUp: true }
    );

  /** A cleaning Q7 whose list leg answers and whose upload leg is silent. */
  function q7WithSilentUpload() {
    const { api } = createApi();
    api.getProductAttribute = jest.fn(() => "roborock.vacuum.sc05");
    api._b01StatusState = new Map([["duid-q7", { lastKnownV1State: 5 }]]);
    const order = [];
    const answered = api.noteMethodAnswered.bind(api);
    api.noteMethodAnswered = jest.fn((duid, method) => {
      order.push(`answered ${method}`);
      return answered(duid, method);
    });
    api.messageQueueHandler = {
      sendRequest: jest.fn(async (duid, method) => {
        order.push(`sent ${method}`);
        return { map_list: [{ id: 1, cur: true }] };
      }),
    };
    api.sendB01MapRequest = jest.fn(async () => {
      order.push("sent upload");
      throw uploadTimeout();
    });
    async function attempt() {
      const live = api._b01LiveRoomState?.get("duid-q7");
      if (live) {
        live.lastAttemptAt = 0;
        live.consecutiveFailures = 0;
      }
      await api.refreshB01LiveRoom("duid-q7");
    }
    return { api, order, attempt };
  }

  test("get_map_list is acknowledged before the upload leg is attempted", async () => {
    const { order, attempt } = q7WithSilentUpload();
    await attempt();
    expect(order.slice(0, 3)).toEqual([
      "sent get_map_list",
      "answered get_map_list",
      "sent upload",
    ]);
  });

  test("the upload leg's silence is recorded against the upload", async () => {
    const { api, attempt } = q7WithSilentUpload();
    for (let index = 0; index < 6; index += 1) {
      await attempt();
    }
    expect(api.unansweredMethods.shouldSkip("duid-q7", UPLOAD)).toBe(true);
    expect(api.unansweredMethods.shouldSkip("duid-q7", "get_map_list")).toBe(
      false
    );
  });

  test("a closed upload leg also skips the fetch, so leg 1 is not spent for nothing", async () => {
    const { api, attempt } = q7WithSilentUpload();
    for (let index = 0; index < 6; index += 1) {
      await attempt();
    }
    api._b01MapIds?.clear();
    api.messageQueueHandler.sendRequest.mockClear();
    await attempt();
    expect(api.messageQueueHandler.sendRequest).not.toHaveBeenCalled();
  });
});
