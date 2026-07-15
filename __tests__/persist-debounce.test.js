const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createApi() {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "persist-"));
  const api = new Roborock({ log: createLog(), storagePath });
  return { api, storagePath };
}

describe("debounced persistence for chatty diagnostic states", () => {
  test("diagnostic updates hit memory immediately but disk at most once per window", async () => {
    const { api } = createApi();

    // Ten rapid-fire diagnostic messages, like a robot pushing live updates.
    for (let i = 0; i < 10; i++) {
      await api.updateRoborockDiagnostics("duid-1", "lastCloudMessage", {
        seq: i,
      });
    }

    // Memory is current...
    const inMemory = JSON.parse(api.states["RoborockDiagnostics"].val);
    expect(inMemory["duid-1"].lastCloudMessage.seq).toBe(9);

    // ...but the disk file does not exist yet (flush pending, not 10 writes).
    const persistPath = api.getPersistPath("RoborockDiagnostics");
    expect(fs.existsSync(persistPath)).toBe(false);
    expect(api._pendingPersistFlushes.size).toBe(1);

    // Shutdown flushes the LATEST value exactly once.
    await api.stopService();
    expect(fs.existsSync(persistPath)).toBe(true);
    const onDisk = JSON.parse(
      JSON.parse(fs.readFileSync(persistPath, "utf8")).val
    );
    expect(onDisk["duid-1"].lastCloudMessage.seq).toBe(9);
    expect(api._pendingPersistFlushes.size).toBe(0);
  });

  test("critical states still persist to disk immediately", async () => {
    const { api } = createApi();
    await api.setB01RoomCache("duid-1", [{ roomId: 1, roomName: "Stue" }]);

    const persistPath = api.getPersistPath("B01Rooms");
    expect(fs.existsSync(persistPath)).toBe(true);
    expect(fs.readFileSync(persistPath, "utf8")).toContain("Stue");
  });

  test("transport diagnostics ride the same debounce", async () => {
    const { api } = createApi();
    await api.setStateAsync("TransportDiagnostics", {
      val: JSON.stringify({ x: 1 }),
      ack: true,
    });
    expect(fs.existsSync(api.getPersistPath("TransportDiagnostics"))).toBe(
      false
    );
    api.flushPendingPersistedStates();
    expect(fs.existsSync(api.getPersistPath("TransportDiagnostics"))).toBe(
      true
    );
  });
});
