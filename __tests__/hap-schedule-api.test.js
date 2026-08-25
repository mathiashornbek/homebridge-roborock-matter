const {
  updateServerTimer,
  updateTimer,
} = require("../src/hap_schedule_api.ts");

describe("HAP schedule API", () => {
  test("sends upd_server_timer with the nested Roborock timer tuple", async () => {
    const command = jest.fn().mockResolvedValue("ok");
    const api = {
      vacuums: {
        "device-1": { command },
      },
      getServerTimers: jest.fn(),
    };

    await updateServerTimer(api, "device-1", "timer-1", true, {
      requestTimeoutMs: 10000,
    });

    expect(command).toHaveBeenCalledWith(
      "device-1",
      "upd_server_timer",
      [["timer-1", "on"]],
      {
        requestTimeoutMs: 10000,
        preferCloud: true,
        waitForResult: true,
        throwOnError: true,
      }
    );
  });

  test("sends upd_timer through vacuum.command before startCommand", async () => {
    const command = jest.fn().mockResolvedValue("ok");
    const startCommand = jest.fn().mockResolvedValue("unexpected");

    const api = {
      vacuums: {
        "device-1": { command },
      },
      startCommand,
      getServerTimers: jest.fn(),
    };

    await updateTimer(api, "device-1", "timer-1", false, {
      requestTimeoutMs: 10000,
    });

    expect(command).toHaveBeenCalledWith(
      "device-1",
      "upd_timer",
      ["timer-1", "off"],
      {
        requestTimeoutMs: 10000,
        preferCloud: true,
        waitForResult: true,
        throwOnError: true,
      }
    );

    expect(startCommand).not.toHaveBeenCalled();
  });
  test("drops server timer metadata from the write payload", async () => {
    const command = jest.fn().mockResolvedValue("ok");
    const api = {
      vacuums: {
        "device-1": { command },
      },
      getServerTimers: jest.fn(),
    };
    const timer = ["timer-complex", "off", 1];

    await updateServerTimer(api, "device-1", timer, true, {
      requestTimeoutMs: 10000,
    });

    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith(
      "device-1",
      "upd_server_timer",
      [["timer-complex", "on"]],
      {
        requestTimeoutMs: 10000,
        preferCloud: true,
        waitForResult: true,
        throwOnError: true,
      }
    );
    expect(timer).toEqual(["timer-complex", "off", 1]);
  });
});
