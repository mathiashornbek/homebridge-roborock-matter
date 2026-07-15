const { localConnector } = require("../roborockLib/lib/localConnector");

function createAdapter() {
  return {
    log: {
      debug: jest.fn(),
    },
    remoteDevices: new Set(),
    updateTransportDiagnostics: jest.fn().mockResolvedValue(undefined),
  };
}

describe("localConnector transport recovery", () => {
  test("clears stale remote fallback marker after local TCP reconnects", async () => {
    const adapter = createAdapter();
    adapter.remoteDevices.add("device-1");
    const connector = new localConnector(adapter);

    await connector.markLocalConnected("device-1");

    expect(adapter.remoteDevices.has("device-1")).toBe(false);
    expect(adapter.log.debug).toHaveBeenCalledWith(
      "Local TCP connected for device-1; clearing remote fallback marker."
    );
    expect(adapter.updateTransportDiagnostics).toHaveBeenCalledWith(
      "device-1",
      {
        tcpConnectionState: "connected",
        isRemote: false,
        remoteReason: null,
        lastTransport: "local",
        lastTransportReason: "tcp-connected",
      }
    );
  });
});
