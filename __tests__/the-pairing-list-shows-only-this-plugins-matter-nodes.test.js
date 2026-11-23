"use strict";

/**
 * The Matter Pairing panel lists this plugin's Matter nodes, not every one on
 * the Homebridge.
 *
 * It read every `<storage>/matter/<id>/commissioning.json` and called each
 * node whose serial was not a robot's "Matter Roborock Bridge". On the
 * maintainer's server that is three bridges for one child bridge: the
 * Roborock bridge, another plugin's Matter bridge, and a node left over from
 * an earlier setup. A user in #41 saw the same "THREE matter bridges" after
 * re-pairing his one robot.
 *
 * The plugin's own bridge is the node named after its bridge's username (its
 * child bridge, or the main bridge when it has none), as Homebridge names the
 * storage folder. Robots are matched by serial, as before. Anything else is
 * counted, not listed. Without a readable config the panel cannot tell, and
 * lists everything as it always did.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { RoborockUiServer } = require("../src/ui/index");

const ROBOROCK_BRIDGE = "0E:72:2E:E6:6E:31";
const OTHER_PLUGIN_BRIDGE = "0E:DD:DA:2C:EE:DB";
const MAIN_BRIDGE = "0E:59:28:D7:8B:3F";

function storage({
  config,
  robots = [{ duid: "duid-a70", sn: "RSN-A70", name: "Stueetage" }],
  nodes,
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pairing-list-"));
  if (config !== undefined) {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  }
  fs.writeFileSync(
    path.join(dir, "roborock.HomeData"),
    JSON.stringify({
      val: JSON.stringify({ devices: robots, receivedDevices: [] }),
      ack: true,
    })
  );
  for (const [id, serialNumber] of Object.entries(nodes)) {
    fs.mkdirSync(path.join(dir, "matter", id), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "matter", id, "commissioning.json"),
      JSON.stringify({
        serialNumber,
        commissioned: true,
        fabricCount: 1,
        passcode: 20202021,
        discriminator: 3840,
        manualPairingCode: "3497-011-2332",
        qrCode: "MT:Y.K90AFN00KA0648G00",
      })
    );
  }
  return dir;
}

function pairing(dir) {
  const handlers = new Map();
  class UiHost {
    constructor() {
      this.homebridgeStoragePath = dir;
    }
    onRequest(route, handler) {
      handlers.set(route, handler);
    }
    ready() {}
  }
  new RoborockUiServer(UiHost);
  return handlers.get("/matter/pairing")({});
}

const id = (username) => username.replace(/:/g, "");

const serverNodes = {
  [id(ROBOROCK_BRIDGE)]: id(ROBOROCK_BRIDGE),
  [id(OTHER_PLUGIN_BRIDGE)]: id(OTHER_PLUGIN_BRIDGE),
  "0E5EA14F132C": "0E5EA14F132C", // left over from an earlier setup
  "6D119416BCE3": "RSN-A70", // the robot
};

test("a child bridge's panel lists its own bridge and its robot, and counts the rest", async () => {
  const result = await pairing(
    storage({
      config: {
        bridge: { username: MAIN_BRIDGE },
        platforms: [
          {
            platform: "RoborockVacuumPlatform",
            _bridge: { username: ROBOROCK_BRIDGE, matter: { port: 5530 } },
          },
          {
            platform: "SaveeyeMatterPlatform",
            _bridge: { username: OTHER_PLUGIN_BRIDGE, matter: { port: 5531 } },
          },
        ],
      },
      nodes: serverNodes,
    })
  );

  expect(result.ok).toBe(true);
  expect(
    result.entries.map((entry) => [entry.kind, entry.id, entry.name])
  ).toEqual([
    ["bridge", id(ROBOROCK_BRIDGE), "Matter Roborock Bridge"],
    ["vacuum", "6D119416BCE3", "Stueetage"],
  ]);
  expect(result.otherMatterNodes).toBe(2);
});

test("a plugin on the main bridge owns the main bridge's node", async () => {
  const result = await pairing(
    storage({
      config: {
        bridge: { username: MAIN_BRIDGE },
        platforms: [{ platform: "RoborockVacuumPlatform" }],
      },
      nodes: {
        [id(MAIN_BRIDGE)]: id(MAIN_BRIDGE),
        [id(OTHER_PLUGIN_BRIDGE)]: id(OTHER_PLUGIN_BRIDGE),
        "6D119416BCE3": "RSN-A70",
      },
    })
  );

  expect(result.entries.map((entry) => [entry.kind, entry.id])).toEqual([
    ["bridge", id(MAIN_BRIDGE)],
    ["vacuum", "6D119416BCE3"],
  ]);
  expect(result.otherMatterNodes).toBe(1);
});

test("the platform is found under its full name as well", async () => {
  const result = await pairing(
    storage({
      config: {
        bridge: { username: MAIN_BRIDGE },
        platforms: [
          {
            platform: "homebridge-roborock-matter.RoborockVacuumPlatform",
            _bridge: { username: ROBOROCK_BRIDGE.toLowerCase() },
          },
        ],
      },
      nodes: serverNodes,
    })
  );

  expect(
    result.entries
      .filter((entry) => entry.kind === "bridge")
      .map((entry) => entry.id)
  ).toEqual([id(ROBOROCK_BRIDGE)]);
});

test("every robot of the account stays listed, whichever node it is on", async () => {
  const result = await pairing(
    storage({
      config: {
        platforms: [
          {
            platform: "RoborockVacuumPlatform",
            _bridge: { username: ROBOROCK_BRIDGE },
          },
        ],
      },
      robots: [
        { duid: "duid-a70", sn: "RSN-A70", name: "Stueetage" },
        { duid: "duid-q7", sn: "RSN-Q7", name: "Garage" },
      ],
      nodes: {
        "6D119416BCE3": "RSN-A70",
        "9E4AC9A0C159": "RSN-Q7",
      },
    })
  );

  expect(result.entries.map((entry) => entry.name)).toEqual([
    "Garage",
    "Stueetage",
  ]);
  expect(result.otherMatterNodes).toBe(0);
});

test("without a readable config the panel cannot tell, and lists every node as before", async () => {
  const result = await pairing(storage({ nodes: serverNodes }));

  expect(result.entries).toHaveLength(4);
  expect(result.otherMatterNodes).toBe(0);
});
