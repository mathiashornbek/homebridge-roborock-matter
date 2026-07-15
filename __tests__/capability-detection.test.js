const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");
const { vacuum } = require("../roborockLib/lib/vacuum");

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createApi(options = {}) {
  return new Roborock({
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "capability-")),
    ...options,
  });
}

describe("self-healing unsupported poll detection", () => {
  test("remembers unsupported-class answers once and skips the command afterwards", () => {
    const api = createApi();
    api.getProductAttribute = jest.fn(() => "roborock.vacuum.a999");

    const unsupported = new Error("unknown_method");
    expect(
      api.rememberUnsupportedPollCommand(
        "duid-1",
        "get_carpet_mode",
        unsupported
      )
    ).toBe(true);
    expect(api.isPollCommandUnsupported("duid-1", "get_carpet_mode")).toBe(
      true
    );
    expect(api.log.info).toHaveBeenCalledTimes(1);

    // Remembering again does not log twice; other commands/devices unaffected.
    expect(
      api.rememberUnsupportedPollCommand(
        "duid-1",
        "get_carpet_mode",
        unsupported
      )
    ).toBe(true);
    expect(api.log.info).toHaveBeenCalledTimes(1);
    expect(api.isPollCommandUnsupported("duid-1", "get_timer")).toBe(false);
    expect(api.isPollCommandUnsupported("duid-2", "get_carpet_mode")).toBe(
      false
    );
  });

  test("timeouts and transport errors are never treated as unsupported", () => {
    const api = createApi();
    const timeout = new Error(
      "get_carpet_mode request timed out after 10 seconds"
    );
    expect(
      api.rememberUnsupportedPollCommand("duid-1", "get_carpet_mode", timeout)
    ).toBe(false);
    expect(api.isPollCommandUnsupported("duid-1", "get_carpet_mode")).toBe(
      false
    );
  });

  test("vacuum.getParameter stops asking after a definitive unsupported answer", async () => {
    const adapter = createApi();
    adapter.getProductAttribute = jest.fn(() => "roborock.vacuum.a999");
    adapter.messageQueueHandler = {
      sendRequest: jest.fn(async () => {
        throw new Error("unsupported method: get_carpet_mode");
      }),
    };
    adapter.catchError = jest.fn();

    const robot = new vacuum(adapter, "roborock.vacuum.a999");
    await robot.getParameter("duid-1", "get_carpet_mode");
    expect(adapter.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(1);
    // The unsupported answer is remembered, not logged as an error.
    expect(adapter.catchError).not.toHaveBeenCalled();

    await robot.getParameter("duid-1", "get_carpet_mode");
    expect(adapter.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(1);
  });
});

describe("capability-derived poll profile for unknown models", () => {
  function createHarness({ featureList }) {
    const api = createApi();
    api.getProductAttribute = jest.fn(() => "roborock.vacuum.a999");
    api.checkForNewFirmware = jest.fn(async () => undefined);
    api.vacuums["duid-x"] = featureList
      ? { features: { getFeatureList: () => featureList } }
      : {};
    const robot = { getParameter: jest.fn(async () => undefined) };
    return { api, robot };
  }

  test("skips carpet polls when the capability bitmask says no carpet support", async () => {
    const { api, robot } = createHarness({
      featureList: { isCarpetSupported: false },
    });
    await api.updateDataMinimumData("duid-x", robot, "roborock.vacuum.a999");

    const polled = robot.getParameter.mock.calls.map((call) => call[1]);
    expect(polled).not.toContain("get_carpet_mode");
    expect(polled).not.toContain("get_carpet_clean_mode");
    expect(polled).toContain("get_water_box_custom_mode");
    // The chosen profile is announced exactly once.
    const profileLogs = api.log.info.mock.calls.filter(([msg]) =>
      String(msg).includes("No dedicated poll profile")
    );
    expect(profileLogs).toHaveLength(1);

    await api.updateDataMinimumData("duid-x", robot, "roborock.vacuum.a999");
    const profileLogsAfter = api.log.info.mock.calls.filter(([msg]) =>
      String(msg).includes("No dedicated poll profile")
    );
    expect(profileLogsAfter).toHaveLength(1);
  });

  test("keeps carpet polls when the bitmask reports support, and without capability data", async () => {
    const withCarpet = createHarness({
      featureList: { isCarpetSupported: true },
    });
    await withCarpet.api.updateDataMinimumData(
      "duid-x",
      withCarpet.robot,
      "roborock.vacuum.a999"
    );
    expect(
      withCarpet.robot.getParameter.mock.calls.map((call) => call[1])
    ).toContain("get_carpet_mode");

    const noData = createHarness({ featureList: null });
    await noData.api.updateDataMinimumData(
      "duid-x",
      noData.robot,
      "roborock.vacuum.a999"
    );
    expect(
      noData.robot.getParameter.mock.calls.map((call) => call[1])
    ).toContain("get_carpet_mode");
  });

  test("a non-vacuum model string logs a clear mismatch warning and polls nothing", async () => {
    const { api, robot } = createHarness({ featureList: null });
    await api.updateDataMinimumData("duid-x", robot, "not.a.vacuum");
    expect(robot.getParameter).not.toHaveBeenCalled();
    expect(api.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Model lookup mismatch")
    );
  });
});
