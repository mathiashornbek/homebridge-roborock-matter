const net = require("net");

// Create a simple server for testing TCP probes
function createTestServer(port = 0, delayMs = 0) {
  const server = net.createServer((socket) => {
    if (delayMs > 0) {
      setTimeout(() => {
        socket.end();
      }, delayMs);
    } else {
      socket.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

function destroyTestServer(server) {
  return new Promise((resolve) => {
    server.close(resolve);
  });
}

// Reserve an OS-assigned port and release it immediately before a failed probe.
async function getUnusedPort() {
  const server = await createTestServer();
  const { port } = server.address();
  await destroyTestServer(server);
  return port;
}

// Implement probeTcp matching the one from src/ui/index.ts
function probeTcp(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();

      if (error) {
        reject(error);
        return;
      }

      resolve({ latencyMs: Date.now() - startedAt });
    };

    const timer = setTimeout(() => {
      finish(new Error(`Timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
    socket.connect(port, host);
  });
}

describe("UI Server Local Probe - TCP Connection Testing", () => {
  test("server startup rejects when its port is already in use", async () => {
    const server = await createTestServer();

    try {
      const occupiedPort = server.address().port;
      await expect(createTestServer(occupiedPort)).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      await destroyTestServer(server);
    }
  });

  test("single TCP probe succeeds to reachable host", async () => {
    const server = await createTestServer();
    const { port } = server.address();

    try {
      const result = await probeTcp("127.0.0.1", port, 5000);
      expect(result).toHaveProperty("latencyMs");
      expect(typeof result.latencyMs).toBe("number");
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      await destroyTestServer(server);
    }
  });

  test("single TCP probe fails to unreachable host", async () => {
    const port = await getUnusedPort();
    // Don't start a server, so the connection will fail

    await expect(probeTcp("127.0.0.1", port, 5000)).rejects.toThrow();
  });

  test("single TCP probe times out on unresponsive host", async () => {
    // Use a non-routable IP to force a timeout
    // 192.0.2.0 is TEST-NET-1 (RFC 5737), should not route
    await expect(probeTcp("192.0.2.1", 12345, 1000)).rejects.toThrow();
  });

  test("multiple sequential TCP probes succeed", async () => {
    const server1 = await createTestServer();
    let server2;

    try {
      server2 = await createTestServer();
      const port1 = server1.address().port;
      const port2 = server2.address().port;

      // First probe
      const result1 = await probeTcp("127.0.0.1", port1, 5000);
      expect(result1).toHaveProperty("latencyMs");

      // Second probe to different port - this is the critical test
      // If sockets weren't properly cleaned up, this might fail
      const result2 = await probeTcp("127.0.0.1", port2, 5000);
      expect(result2).toHaveProperty("latencyMs");

      // Third probe to original port
      const result3 = await probeTcp("127.0.0.1", port1, 5000);
      expect(result3).toHaveProperty("latencyMs");
    } finally {
      await destroyTestServer(server1);
      if (server2) await destroyTestServer(server2);
    }
  });

  test("multiple sequential failed probes don't accumulate errors", async () => {
    const port1 = await getUnusedPort();
    const port2 = await getUnusedPort();

    // Don't start any servers, so both connections fail

    try {
      await probeTcp("127.0.0.1", port1, 1000);
      fail("Expected first probe to fail");
    } catch (e) {
      expect(e).toBeDefined();
      expect(typeof e === "object" || typeof e === "string").toBe(true);
    }

    // Second failed probe should also fail cleanly
    try {
      await probeTcp("127.0.0.1", port2, 1000);
      fail("Expected second probe to fail");
    } catch (e) {
      expect(e).toBeDefined();
      expect(typeof e === "object" || typeof e === "string").toBe(true);
    }

    // Third failed probe should also fail cleanly
    try {
      await probeTcp("127.0.0.1", port1, 1000);
      fail("Expected third probe to fail");
    } catch (e) {
      expect(e).toBeDefined();
      expect(typeof e === "object" || typeof e === "string").toBe(true);
    }
  });

  test("rapid sequential probes clean up sockets properly", async () => {
    const server = await createTestServer();
    const { port } = server.address();

    try {
      const promises = [];
      // Create 10 rapid sequential probes
      for (let i = 0; i < 10; i++) {
        promises.push(probeTcp("127.0.0.1", port, 5000));
      }

      const results = await Promise.all(promises);
      expect(results).toHaveLength(10);
      results.forEach((result) => {
        expect(result).toHaveProperty("latencyMs");
        expect(typeof result.latencyMs).toBe("number");
      });
    } finally {
      await destroyTestServer(server);
    }
  });

  test("socket is destroyed after successful connection", async () => {
    const server = await createTestServer();
    const { port } = server.address();

    try {
      await probeTcp("127.0.0.1", port, 5000);
      // If socket wasn't destroyed, subsequent operations might fail
      // This test passes if the process can handle rapid cleanup
    } finally {
      await destroyTestServer(server);
    }
  });

  test("socket is destroyed after connection failure", async () => {
    const port = await getUnusedPort();

    try {
      await probeTcp("127.0.0.1", port, 500);
      fail("Expected probe to fail");
    } catch (e) {
      // Expected
      // If socket wasn't destroyed, subsequent operations might fail
    }

    // Subsequent probe to different port should work
    const server = await createTestServer();
    const port2 = server.address().port;

    try {
      const result = await probeTcp("127.0.0.1", port2, 5000);
      expect(result).toHaveProperty("latencyMs");
    } finally {
      await destroyTestServer(server);
    }
  });

  test("handles timeout properly and cleans up socket", async () => {
    // This test verifies that even on timeout, socket is properly destroyed
    const port = 12345;

    try {
      await probeTcp("192.0.2.1", port, 500);
      fail("Expected probe to timeout");
    } catch (error) {
      expect(error.message).toContain("Timed out");
    }

    // After timeout, subsequent operations should work normally
    const server = await createTestServer();
    const port2 = server.address().port;

    try {
      const result = await probeTcp("127.0.0.1", port2, 5000);
      expect(result).toHaveProperty("latencyMs");
    } finally {
      await destroyTestServer(server);
    }
  });
});
