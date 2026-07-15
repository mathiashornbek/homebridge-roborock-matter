const { vacuum } = require("../roborockLib/lib/vacuum");

function createAdapter(sendRequest = jest.fn().mockResolvedValue(["ok"])) {
  return {
    log: {
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    messageQueueHandler: {
      sendRequest,
    },
    catchError: jest.fn(),
  };
}

describe("Roborock vacuum command options", () => {
  test("passes per-command transport and timeout options to the request queue", async () => {
    const sendRequest = jest.fn().mockResolvedValue(["ok"]);
    const adapter = createAdapter(sendRequest);
    const robot = new vacuum(adapter, "roborock.vacuum.ss07");

    await robot.command("device-1", "app_start", null, {
      preferCloud: true,
      requestTimeoutMs: 2500,
      throwOnError: true,
    });

    expect(sendRequest).toHaveBeenCalledWith(
      "device-1",
      "app_start",
      [],
      false,
      false,
      {
        preferCloud: true,
        requestTimeoutMs: 2500,
      }
    );
  });

  test("throws command errors when requested by the caller", async () => {
    const error = new Error("Cloud request timed out");
    const adapter = createAdapter(jest.fn().mockRejectedValue(error));
    const robot = new vacuum(adapter, "roborock.vacuum.ss07");

    await expect(
      robot.command("device-1", "app_start", null, {
        throwOnError: true,
      })
    ).rejects.toThrow("Cloud request timed out");

    expect(adapter.catchError).toHaveBeenCalledWith(
      error,
      "app_start",
      "device-1",
      "roborock.vacuum.ss07"
    );
  });

  test("reads and updates server timers using the Roborock schedule contract", async () => {
    const timers = [["timer-1", "on", 123]];
    const sendRequest = jest
      .fn()
      .mockResolvedValueOnce(timers)
      .mockResolvedValueOnce(["ok"]);
    const adapter = createAdapter(sendRequest);
    const robot = new vacuum(adapter, "roborock.vacuum.ss07");

    await expect(robot.getServerTimers("device-1")).resolves.toEqual(timers);
    await robot.updateServerTimer("device-1", "timer-1", false);

    expect(sendRequest).toHaveBeenNthCalledWith(
      1,
      "device-1",
      "get_server_timer",
      []
    );
    expect(sendRequest).toHaveBeenNthCalledWith(
      2,
      "device-1",
      "upd_server_timer",
      ["timer-1", "off"]
    );
  });

  test("surfaces schedule update failures to HomeKit callers", async () => {
    const error = new Error("Timer update failed");
    const adapter = createAdapter(jest.fn().mockRejectedValue(error));
    const robot = new vacuum(adapter, "roborock.vacuum.ss07");

    await expect(
      robot.updateServerTimer("device-1", "timer-1", true)
    ).rejects.toThrow("Timer update failed");
    expect(adapter.catchError).toHaveBeenCalledWith(
      error,
      "upd_server_timer",
      "device-1",
      "roborock.vacuum.ss07"
    );
  });
});
