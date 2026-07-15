const RoborockPlatform = require("../src/platform").default;

function createPlatformHarness() {
  const platform = Object.create(RoborockPlatform.prototype);
  platform.log = {
    debug: jest.fn(),
  };
  platform.roborockAPI = {
    recordRoborockDiagnosticMessage: jest.fn(),
    getVacuumList: jest.fn(() => [{ duid: "device-1" }, { duid: "device-2" }]),
  };
  platform.matterVacuums = new Map([
    [
      "device-1",
      { notifyDeviceUpdater: jest.fn().mockResolvedValue(undefined) },
    ],
    [
      "device-2",
      { notifyDeviceUpdater: jest.fn().mockResolvedValue(undefined) },
    ],
  ]);

  return platform;
}

describe("Roborock platform device update dispatch (Matter-only)", () => {
  test("routes device-scoped live messages only to the matching Matter vacuum", () => {
    const platform = createPlatformHarness();
    const message = { duid: "device-1", payload: [{ state: 5 }] };

    platform.dispatchDeviceUpdate("CloudMessage", message);

    expect(
      platform.matterVacuums.get("device-1").notifyDeviceUpdater
    ).toHaveBeenCalledWith("CloudMessage", message);
    expect(
      platform.matterVacuums.get("device-2").notifyDeviceUpdater
    ).not.toHaveBeenCalled();
  });

  test("drops unscoped live arrays when multiple vacuums are configured", () => {
    const platform = createPlatformHarness();

    platform.dispatchDeviceUpdate("CloudMessage", [{ state: 5 }]);

    expect(
      platform.matterVacuums.get("device-1").notifyDeviceUpdater
    ).not.toHaveBeenCalled();
    expect(
      platform.matterVacuums.get("device-2").notifyDeviceUpdater
    ).not.toHaveBeenCalled();
    expect(platform.log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring unscoped CloudMessage update")
    );
  });

  test("still broadcasts unscoped HomeData snapshots to every Matter vacuum", () => {
    const platform = createPlatformHarness();
    const message = { devices: [{ duid: "device-1" }] };

    platform.dispatchDeviceUpdate("HomeData", message);

    expect(
      platform.matterVacuums.get("device-1").notifyDeviceUpdater
    ).toHaveBeenCalledWith("HomeData", message);
    expect(
      platform.matterVacuums.get("device-2").notifyDeviceUpdater
    ).toHaveBeenCalledWith("HomeData", message);
  });
});
