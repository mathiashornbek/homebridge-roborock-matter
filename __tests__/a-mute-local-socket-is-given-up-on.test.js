"use strict";

// A successful TCP handshake proves that a port is reachable. It does not
// prove that the robot answers on it.
//
// skmzwanke (#8) runs Homebridge on a NAS in a trusted VLAN and his Saros 10
// in an untrusted one. Port 58867 is reachable across that boundary, so the
// local client connects and `Local connect state: true` is recorded — and then
// every single request dies of silence ten seconds later. get_prop on both
// startups, app_segment_clean, app_pause, app_start: all of them, forever.
//
// The plugin only ever gave up on the LAN when the *connect* failed
// (`marked-remote-after-connect-failure`). A socket that connected and then
// answered nothing was retried for the life of the process, so every poll and
// every user command paid a ten-second timeout before falling back — which is
// also why he saw a get_prop timeout at every restart.
//
// The rule is about the class of failure, not about his firewall: a local
// transport that has been proven mute must stop being chosen, whatever made it
// mute. Intermittent timeouts must NOT trip it, because a single lost frame on
// a healthy LAN is normal and permanently exiling that robot to the cloud
// would be a worse bug than the one being fixed.

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  Roborock,
  LOCAL_MUTE_REMOTE_REASON,
  LOCAL_MUTE_TIMEOUT_LIMIT,
} = require("../roborockLib/roborockAPI");

const DUID = "Jdd4QeBp6UbxuCjuDN8R";

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createRoborock() {
  return new Roborock({
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "roborock-mute-")),
  });
}

async function seedHomeData(api, duid) {
  await api.setStateAsync("HomeData", {
    val: JSON.stringify({
      devices: [{ duid, name: "Weebo", online: true }],
      receivedDevices: [],
      products: [],
    }),
    ack: true,
  });
}

describe("a local socket that connects but answers nothing is given up on", () => {
  test("the limit is a small number greater than one", () => {
    // One timeout is noise. Exiling a robot to the cloud on the first lost
    // frame is the regression this bound exists to prevent.
    expect(LOCAL_MUTE_TIMEOUT_LIMIT).toBeGreaterThan(1);
    expect(LOCAL_MUTE_TIMEOUT_LIMIT).toBeLessThanOrEqual(5);
  });

  test("consecutive local timeouts mark the robot remote, and the reason names the real cause", async () => {
    const api = createRoborock();
    await seedHomeData(api, DUID);

    expect(await api.isRemoteDevice(DUID)).toBe(false);

    for (let attempt = 1; attempt < LOCAL_MUTE_TIMEOUT_LIMIT; attempt += 1) {
      await api.noteLocalRequestTimedOut(DUID, "get_prop");
      // Still under the limit: the LAN has not been written off yet.
      expect(await api.isRemoteDevice(DUID)).toBe(false);
    }

    await api.noteLocalRequestTimedOut(DUID, "get_prop");

    expect(await api.isRemoteDevice(DUID)).toBe(true);
    expect(api.getRemoteDeviceReason(DUID)).toBe(LOCAL_MUTE_REMOTE_REASON);
  });

  test("the reason is explained in words instead of echoed as a slug", () => {
    const api = createRoborock();
    const explained = api.describeTransportReason(LOCAL_MUTE_REMOTE_REASON);

    expect(explained).not.toBe(LOCAL_MUTE_REMOTE_REASON);
    // The distinction that matters to a reader chasing a firewall: the socket
    // opened. Saying only "local failed" is what sent #7 on a nine-day hunt.
    expect(explained.toLowerCase()).toContain("connected");
  });

  test("the give-up is announced once, not on every later timeout", async () => {
    const api = createRoborock();
    await seedHomeData(api, DUID);

    for (
      let attempt = 0;
      attempt < LOCAL_MUTE_TIMEOUT_LIMIT + 4;
      attempt += 1
    ) {
      await api.noteLocalRequestTimedOut(DUID, "get_prop");
    }

    const warnings = api.log.warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("Weebo"));

    expect(warnings).toHaveLength(1);
    // A user reading this has to learn that the port is open, so that he stops
    // rewriting firewall rules that were never the problem.
    expect(warnings[0]).toMatch(/connect/i);
  });

  test("a local reply resets the count, so intermittent timeouts never exile the robot", async () => {
    const api = createRoborock();
    await seedHomeData(api, DUID);

    for (let round = 0; round < 6; round += 1) {
      for (let attempt = 1; attempt < LOCAL_MUTE_TIMEOUT_LIMIT; attempt += 1) {
        await api.noteLocalRequestTimedOut(DUID, "get_prop");
      }
      // One answer proves the socket is alive again.
      api.noteLocalRequestSucceeded(DUID);
    }

    expect(await api.isRemoteDevice(DUID)).toBe(false);
    expect(api.log.warn).not.toHaveBeenCalled();
  });

  test("the local timeout path reports the mute socket instead of only rejecting", () => {
    // Enumerates the rule rather than the one call site: the handler that
    // builds the "Local request ... timed out" rejection is the only place
    // that learns a local request died, so that is where the count has to be
    // fed. A future rewrite that keeps the message and drops the bookkeeping
    // would restore the original bug silently.
    const handler = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "roborockLib",
        "lib",
        "messageQueueHandler.js"
      ),
      "utf8"
    );

    expect(handler).toContain("Local request with id");
    expect(handler).toContain("noteLocalRequestTimedOut");
  });

  test("the local reply path clears the count", () => {
    const connector = fs.readFileSync(
      path.join(__dirname, "..", "roborockLib", "lib", "localConnector.js"),
      "utf8"
    );

    expect(connector).toContain("noteLocalRequestSucceeded");
  });
});
