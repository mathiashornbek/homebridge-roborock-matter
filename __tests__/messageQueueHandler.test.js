const {
  messageQueueHandler,
  getRequestTimeout,
  DEFAULT_REQUEST_TIMEOUT,
} = require("../roborockLib/lib/messageQueueHandler");

function createAdapter(overrides = {}) {
  const adapter = {
    isRemoteDevice: jest.fn().mockResolvedValue(false),
    getRobotVersion: jest.fn().mockResolvedValue("1.0"),
    onlineChecker: jest.fn().mockResolvedValue(true),
    rr_mqtt_connector: {
      isConnected: jest.fn().mockReturnValue(true),
      sendMessage: jest.fn(),
    },
    config: {},
    localConnector: {
      isConnected: jest.fn().mockReturnValue(false),
      sendMessage: jest.fn(),
      clearChunkBuffer: jest.fn(),
    },
    message: {
      buildPayload: jest.fn().mockResolvedValue("payload"),
      buildRoborockMessage: jest.fn().mockResolvedValue(Buffer.from("message")),
    },
    getRequestId: jest.fn().mockReturnValue(42),
    pendingRequests: new Map(),
    setTimeout: jest.fn((callback) => setTimeout(callback, 5000)),
    clearTimeout: jest.fn((timeout) => clearTimeout(timeout)),
    log: {
      info: jest.fn(),
      debug: jest.fn(),
    },
    updateTransportDiagnostics: jest.fn().mockResolvedValue(undefined),
    catchError: jest.fn(),
    ...overrides,
  };

  return adapter;
}

describe("messageQueueHandler request timeouts", () => {
  test("gives slow map switches a longer timeout than the default", () => {
    expect(getRequestTimeout("load_multi_map")).toBe(30000);
    expect(getRequestTimeout("load_multi_map")).toBeGreaterThan(
      DEFAULT_REQUEST_TIMEOUT
    );
  });

  test("uses the default timeout for ordinary commands", () => {
    expect(getRequestTimeout("get_status")).toBe(DEFAULT_REQUEST_TIMEOUT);
    expect(getRequestTimeout("app_start")).toBe(DEFAULT_REQUEST_TIMEOUT);
  });

  test("honors a positive per-request timeout override", () => {
    expect(getRequestTimeout("app_start", 2000)).toBe(2000);
    expect(getRequestTimeout("load_multi_map", 1500)).toBe(1500);
  });
});

describe("messageQueueHandler transport selection", () => {
  test("falls back to cloud when local transport is unavailable", async () => {
    const adapter = createAdapter();
    adapter.rr_mqtt_connector.sendMessage.mockImplementation(() => {
      const pending = adapter.pendingRequests.get(42);
      adapter.clearTimeout(pending.timeout);
      adapter.pendingRequests.delete(42);
      pending.resolve(["ok"]);
    });

    const handler = new messageQueueHandler(adapter);
    await expect(
      handler.sendRequest("device-1", "get_status", [])
    ).resolves.toEqual(["ok"]);

    expect(adapter.log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Falling back to cloud connection")
    );
    expect(adapter.updateTransportDiagnostics).toHaveBeenCalledWith(
      "device-1",
      expect.objectContaining({
        lastTransport: "cloud",
        lastCommandMethod: "get_status",
      })
    );
  });

  test("uses local transport when the local socket is connected", async () => {
    const adapter = createAdapter({
      localConnector: {
        isConnected: jest.fn().mockReturnValue(true),
        sendMessage: jest.fn(),
        clearChunkBuffer: jest.fn(),
      },
    });
    adapter.localConnector.sendMessage.mockImplementation(() => {
      const pending = adapter.pendingRequests.get(42);
      adapter.clearTimeout(pending.timeout);
      adapter.pendingRequests.delete(42);
      pending.resolve(["ok"]);
    });

    const handler = new messageQueueHandler(adapter);
    await expect(
      handler.sendRequest("device-1", "get_clean_record", [1])
    ).resolves.toEqual(["ok"]);

    expect(adapter.localConnector.sendMessage).toHaveBeenCalled();
    expect(adapter.updateTransportDiagnostics).toHaveBeenCalledWith(
      "device-1",
      expect.objectContaining({
        lastTransport: "local",
        lastCommandMethod: "get_clean_record",
      })
    );
  });

  test("uses per-request timeout overrides when sending a request", async () => {
    const adapter = createAdapter({
      setTimeout: jest.fn((callback, timeout) => setTimeout(callback, timeout)),
    });
    adapter.rr_mqtt_connector.sendMessage.mockImplementation(() => {
      const pending = adapter.pendingRequests.get(42);
      adapter.clearTimeout(pending.timeout);
      adapter.pendingRequests.delete(42);
      pending.resolve(["ok"]);
    });

    const handler = new messageQueueHandler(adapter);
    await expect(
      handler.sendRequest("device-1", "app_start", [], false, false, {
        requestTimeoutMs: 2000,
      })
    ).resolves.toEqual(["ok"]);

    expect(adapter.setTimeout).toHaveBeenCalledWith(expect.any(Function), 2000);
  });

  test("attempts a local reconnect for preferred-local commands", async () => {
    let localConnected = false;
    const localConnector = {
      isConnected: jest.fn(() => localConnected),
      sendMessage: jest.fn(),
      clearChunkBuffer: jest.fn(),
    };
    const adapter = createAdapter({
      localConnector,
      ensureLocalConnection: jest.fn().mockImplementation(async () => {
        localConnected = true;
        return true;
      }),
    });
    localConnector.sendMessage.mockImplementation(() => {
      const pending = adapter.pendingRequests.get(42);
      adapter.clearTimeout(pending.timeout);
      adapter.pendingRequests.delete(42);
      pending.resolve(["ok"]);
    });

    const handler = new messageQueueHandler(adapter);
    await expect(
      handler.sendRequest("device-1", "app_start", [], false, false, {
        preferLocal: true,
      })
    ).resolves.toEqual(["ok"]);

    expect(adapter.ensureLocalConnection).toHaveBeenCalledWith("device-1");
    expect(localConnector.sendMessage).toHaveBeenCalled();
    expect(adapter.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
    expect(adapter.updateTransportDiagnostics).toHaveBeenCalledWith(
      "device-1",
      expect.objectContaining({
        lastTransport: "local",
        lastTransportReason: "local-request",
        lastCommandMethod: "app_start",
      })
    );
  });

  test("uses local transport when HomeData is stale offline but the local socket is connected", async () => {
    const adapter = createAdapter({
      onlineChecker: jest.fn().mockResolvedValue(false),
      localConnector: {
        isConnected: jest.fn().mockReturnValue(true),
        sendMessage: jest.fn(),
        clearChunkBuffer: jest.fn(),
      },
    });
    adapter.localConnector.sendMessage.mockImplementation(() => {
      const pending = adapter.pendingRequests.get(42);
      adapter.clearTimeout(pending.timeout);
      adapter.pendingRequests.delete(42);
      pending.resolve(["ok"]);
    });

    const handler = new messageQueueHandler(adapter);
    await expect(
      handler.sendRequest("device-1", "app_segment_clean", [[18]])
    ).resolves.toEqual(["ok"]);

    expect(adapter.localConnector.sendMessage).toHaveBeenCalled();
    expect(adapter.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
    expect(adapter.updateTransportDiagnostics).toHaveBeenCalledWith(
      "device-1",
      expect.objectContaining({
        lastTransport: "local",
        lastTransportReason: "local-request",
        lastCommandMethod: "app_segment_clean",
      })
    );
  });

  test("prefers cloud transport when requested and cloud is connected", async () => {
    const adapter = createAdapter({
      localConnector: {
        isConnected: jest.fn().mockReturnValue(true),
        sendMessage: jest.fn(),
        clearChunkBuffer: jest.fn(),
      },
    });
    adapter.rr_mqtt_connector.sendMessage.mockImplementation(() => {
      const pending = adapter.pendingRequests.get(42);
      adapter.clearTimeout(pending.timeout);
      adapter.pendingRequests.delete(42);
      pending.resolve(["ok"]);
    });

    const handler = new messageQueueHandler(adapter);
    await expect(
      handler.sendRequest("device-1", "app_start", [], false, false, {
        preferCloud: true,
      })
    ).resolves.toEqual(["ok"]);

    expect(adapter.rr_mqtt_connector.sendMessage).toHaveBeenCalled();
    expect(adapter.localConnector.sendMessage).not.toHaveBeenCalled();
    expect(adapter.updateTransportDiagnostics).toHaveBeenCalledWith(
      "device-1",
      expect.objectContaining({
        lastTransport: "cloud",
        lastTransportReason: "preferred-cloud-command",
        lastCommandMethod: "app_start",
      })
    );
  });

  test("can send cloud commands when HomeData is stale offline and explicitly allowed", async () => {
    const adapter = createAdapter({
      onlineChecker: jest.fn().mockResolvedValue(false),
    });
    adapter.rr_mqtt_connector.sendMessage.mockImplementation(() => {
      const pending = adapter.pendingRequests.get(42);
      adapter.clearTimeout(pending.timeout);
      adapter.pendingRequests.delete(42);
      pending.resolve(["ok"]);
    });

    const handler = new messageQueueHandler(adapter);
    await expect(
      handler.sendRequest("device-1", "app_start", [], false, false, {
        preferLocal: true,
        allowOfflineCloudSend: true,
      })
    ).resolves.toEqual(["ok"]);

    expect(adapter.rr_mqtt_connector.sendMessage).toHaveBeenCalled();
    expect(adapter.localConnector.sendMessage).not.toHaveBeenCalled();
    expect(adapter.log.debug).toHaveBeenCalledWith(
      expect.stringContaining("explicitly allows offline cloud delivery")
    );
    expect(adapter.updateTransportDiagnostics).toHaveBeenCalledWith(
      "device-1",
      expect.objectContaining({
        lastTransport: "cloud",
        lastTransportReason: "offline-cloud-command",
        lastCommandMethod: "app_start",
      })
    );
  });

  test("uses cloud transport in cloud-only mode even when local is connected", async () => {
    const adapter = createAdapter({
      config: { cloudOnlyMode: true },
      localConnector: {
        isConnected: jest.fn().mockReturnValue(true),
        sendMessage: jest.fn(),
        clearChunkBuffer: jest.fn(),
      },
    });
    adapter.rr_mqtt_connector.sendMessage.mockImplementation(() => {
      const pending = adapter.pendingRequests.get(42);
      adapter.clearTimeout(pending.timeout);
      adapter.pendingRequests.delete(42);
      pending.resolve(["ok"]);
    });

    const handler = new messageQueueHandler(adapter);
    await expect(
      handler.sendRequest("device-1", "get_status", [])
    ).resolves.toEqual(["ok"]);

    expect(adapter.rr_mqtt_connector.sendMessage).toHaveBeenCalled();
    expect(adapter.localConnector.sendMessage).not.toHaveBeenCalled();
    expect(adapter.updateTransportDiagnostics).toHaveBeenCalledWith(
      "device-1",
      expect.objectContaining({
        lastTransport: "cloud",
        lastTransportReason: "cloud-only-mode",
        lastCommandMethod: "get_status",
      })
    );
  });

  test("does not fall back to local when cloud-only mode has no MQTT connection", async () => {
    const adapter = createAdapter({
      config: { cloudOnlyMode: true },
      rr_mqtt_connector: {
        isConnected: jest.fn().mockReturnValue(false),
        sendMessage: jest.fn(),
      },
      localConnector: {
        isConnected: jest.fn().mockReturnValue(true),
        sendMessage: jest.fn(),
        clearChunkBuffer: jest.fn(),
      },
    });

    const handler = new messageQueueHandler(adapter);
    await expect(
      handler.sendRequest("device-1", "get_status", [])
    ).rejects.toThrow("Cloud connection not available");

    expect(adapter.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
    expect(adapter.localConnector.sendMessage).not.toHaveBeenCalled();
    expect(adapter.updateTransportDiagnostics).toHaveBeenCalledWith(
      "device-1",
      expect.objectContaining({
        lastTransport: "cloud",
        lastTransportReason: "cloud-only-mqtt-unavailable",
        lastCommandMethod: "get_status",
      })
    );
  });
});
