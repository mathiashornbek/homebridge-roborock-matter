"use strict";

/**
 * A Matter vacuum accessory wired the way DSimeone1989's Saros 10R (a144,
 * issue #22) reaches it on 3.34.0: every status arrives as a cloud reply to
 * `get_prop ["get_status"]`, delivered as `{ duid, payload }`, and HomeData
 * holds only the dps snapshot the cloud keeps for the product schema.
 *
 * The HomeData snapshot below is the robot's own, from the first
 * `HomeData notifyDeviceUpdater:` line of RM_log_without_both.txt (schema ids
 * 120/121/122/123/124/133 translated to their codes). It carries no tank field
 * at all, which is the point: anything the accessory knows about a tank it
 * learned from a live frame.
 */

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const CAPTURES = require("./issue-22-a144-captures.json");

const DUID = "device-a144";

const HOMEDATA_SNAPSHOT = {
  error_code: 0,
  state: 8,
  battery: 100,
  fan_power: 110,
  water_box_mode: 209,
  charge_status: 1,
};

function createA144Vacuum() {
  const matterUpdates = [];
  const platform = {
    platformConfig: {
      enableMatter: true,
      enableMatterCleanMode: true,
      enableMatterExtendedOperationalStates: true,
      enableMatterChargingDockedStates: true,
    },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => ({
      updateAccessoryState: jest.fn(async (uuid, cluster, attributes) => {
        matterUpdates.push({ cluster, attributes });
      }),
    }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Rocky" : "",
      getProductAttribute: () => "roborock.vacuum.a144",
      getVacuumDeviceStatus: (duid, property) =>
        HOMEDATA_SNAPSHOT[property] ?? "",
      getRoomMappingsForDevice: () => [],
      getMapListForDevice: () => [],
      getCurrentMapIdForDevice: () => null,
      getMatterCleanModeCapabilities: () => ({
        canVacuum: true,
        canMop: true,
        canControlFanPower: true,
        canMaxPlusFanPower: false,
        canControlWater: true,
      }),
      getStatus: jest.fn().mockResolvedValue(undefined),
    },
  };

  const accessory = { UUID: "uuid-a144", context: { duid: DUID } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: DUID },
    true
  );

  return {
    vacuum,
    matterUpdates,
    /** A captured `get_status` reply, delivered exactly as the connector does. */
    async reply(captureName) {
      const capture = CAPTURES[captureName];
      if (!capture) {
        throw new Error(`no capture named ${captureName}`);
      }
      // A deep copy: the accessory must not be able to edit the fixture.
      const payload = JSON.parse(JSON.stringify(capture.reply));
      await vacuum.notifyDeviceUpdater("CloudMessage", { duid: DUID, payload });
    },
    /** An unsolicited dps push, as roborock_mqtt_connector forwards it. */
    async push(frame) {
      await vacuum.notifyDeviceUpdater("CloudMessage", {
        duid: DUID,
        payload: JSON.parse(JSON.stringify(frame)),
      });
    },
    sensor: (key) => vacuum.getHomeKitStateSensorValue(key),
  };
}

/** "30/09/2026, 17:18:45" -> epoch ms, as the robot's own clock logged it. */
function loggedAtToMs(loggedAt) {
  const match = /^(\d\d)\/(\d\d)\/(\d{4}), (\d\d):(\d\d):(\d\d)$/.exec(
    loggedAt
  );
  if (!match) {
    throw new Error(`unparseable log timestamp ${loggedAt}`);
  }
  const [, dd, mm, yyyy, hh, mi, ss] = match.map(Number);
  return Date.UTC(yyyy, mm - 1, dd, hh, mi, ss);
}

module.exports = { CAPTURES, createA144Vacuum, loggedAtToMs };
