"use strict";

// Mathias' two Q7-generation robots (1. Sal and Garage, roborock.vacuum.sc05)
// logged an "unsupported method" notice on every restart, one per robot, for
// get_water_box_custom_mode. The robot was never the problem: the B01 send
// choke point in messageQueueHandler rejects v1-only requests itself, before
// anything goes on the wire, and the poller then remembered that rejection as
// if the robot had answered it.
//
// The narrow fix would be to add the one method to NEUTRAL_RESPONSES. This
// tests the class instead: for a B01 robot, the periodic poller may not ask
// for ANY method the dialect cannot answer — including probes added later,
// which is how the previous two of these bugs got in.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");
const b01Q7Adapter = require("../roborockLib/lib/b01Q7Adapter");

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createHarness({ protocolVersion, model = "roborock.vacuum.sc05" }) {
  const api = new Roborock({
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-poll-")),
  });
  api.getProductAttribute = jest.fn(() => model);
  api.getRobotVersion = jest.fn(async () => protocolVersion);
  api.refreshMatterServiceAreaRoomMappings = jest.fn(async () => false);
  api.vacuums["duid-q7"] = {
    features: { getFeatureList: () => ({ isCarpetSupported: true }) },
  };
  const robot = { getParameter: jest.fn(async () => undefined) };
  return { api, robot };
}

async function polledMethods({ protocolVersion, model }) {
  const { api, robot } = createHarness({ protocolVersion, model });
  await api.updateDataMinimumData(
    "duid-q7",
    robot,
    model || "roborock.vacuum.sc05"
  );
  return {
    api,
    methods: robot.getParameter.mock.calls.map((call) => call[1]),
  };
}

describe("canAnswerV1Method mirrors the B01 send choke point", () => {
  // An explicit answer per method. This used to recompute the predicate's own
  // body (neutral response || translation) and compare it with the predicate,
  // which could not fail unless that two-line body changed.
  test("each polled method's answer is the one the choke point gives", () => {
    const expected = {
      get_status: true,
      get_consumable: true,
      get_room_mapping: true,
      get_server_timer: true,
      get_multi_maps_list: true,
      get_carpet_mode: true,
      get_custom_mode: true,
      get_clean_summary: true,
      get_network_info: true,
      get_map_list: true,
      // Translated only with ["get_status"] as its params; the poller never
      // sends it with those.
      get_prop: false,
      get_timer: false,
      get_carpet_clean_mode: false,
      get_water_box_custom_mode: false,
      get_dust_collection_switch_status: false,
      get_wash_towel_mode: false,
      app_get_dryer_setting: false,
      get_fw_features: false,
    };
    for (const [method, answerable] of Object.entries(expected)) {
      expect([method, b01Q7Adapter.canAnswerV1Method(method)]).toEqual([
        method,
        answerable,
      ]);
    }
  });

  test("the v1-only methods that caused the noise are not answerable", () => {
    expect(b01Q7Adapter.canAnswerV1Method("get_water_box_custom_mode")).toBe(
      false
    );
    expect(b01Q7Adapter.canAnswerV1Method("get_timer")).toBe(false);
    expect(b01Q7Adapter.canAnswerV1Method("get_carpet_clean_mode")).toBe(false);
    // And the ones the dialect does handle stay pollable.
    expect(b01Q7Adapter.canAnswerV1Method("get_consumable")).toBe(true);
    expect(b01Q7Adapter.canAnswerV1Method("get_status")).toBe(true);
  });
});

describe("periodic polling respects the robot's dialect", () => {
  test("a B01 robot is never asked for a method the dialect cannot answer", async () => {
    const { methods } = await polledMethods({ protocolVersion: "B01" });

    // The class rule, not a list of the three known names.
    const impossible = methods.filter(
      (method) => !b01Q7Adapter.canAnswerV1Method(method)
    );
    expect(impossible).toEqual([]);

    // And it actually polled something, so the assertion above is not vacuous.
    expect(methods).toContain("get_consumable");
    expect(methods).not.toContain("get_water_box_custom_mode");
    expect(methods).not.toContain("get_timer");
    expect(methods).not.toContain("get_carpet_clean_mode");
  });

  test("the skip is explained once per robot and method, at debug level", async () => {
    const { api, robot } = createHarness({ protocolVersion: "B01" });
    await api.updateDataMinimumData("duid-q7", robot, "roborock.vacuum.sc05");
    await api.updateDataMinimumData("duid-q7", robot, "roborock.vacuum.sc05");

    const skipLines = api.log.debug.mock.calls.filter(([message]) =>
      String(message).includes("the Q7/B01 dialect has no equivalent request")
    );
    expect(skipLines).toHaveLength(
      new Set(
        skipLines.map(([message]) => String(message).match(/'([^']+)'/)?.[1])
      ).size
    );
    expect(skipLines.length).toBeGreaterThan(0);

    // Not a warning or an error: nothing is wrong, and it is not the robot's
    // doing. The old path logged an info line blaming the robot.
    const blame = api.log.info.mock.calls.filter(([message]) =>
      String(message).includes("answered")
    );
    expect(blame).toEqual([]);
  });

  test("the profile announcement stops promising a water-box probe on B01", async () => {
    const { api } = await polledMethods({ protocolVersion: "B01" });
    const [line] = api.log.info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("No dedicated poll profile"));

    expect(line).toContain("water-box probe=no");
  });

  test("classic v1 robots keep the full poll chain", async () => {
    const { methods } = await polledMethods({
      protocolVersion: "1.0",
      model: "roborock.vacuum.a999",
    });

    expect(methods).toContain("get_water_box_custom_mode");
    expect(methods).toContain("get_timer");
    expect(methods).toContain("get_carpet_clean_mode");
    expect(methods).toContain("get_carpet_mode");
  });
});
