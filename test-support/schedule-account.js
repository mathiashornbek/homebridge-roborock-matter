"use strict";

// The pieces schedule and Routine tests share: a cloud scene in the shape
// measured on the reporter's account in #22, a stand-in for the account's
// schedule calls whose writes change what the next read returns, and HAP
// built from Homebridge's own hap-nodejs and PlatformAccessory.

const path = require("path");

const homebridgeDir = path.dirname(require.resolve("homebridge/package.json"));
const hap = require(require.resolve("hap-nodejs", { paths: [homebridgeDir] }));
const { PlatformAccessory } = require(
  path.join(homebridgeDir, "lib", "platformAccessory")
);

/** A TIMER trigger with the nested flag the app flips (#22). */
function trigger(enabled, cron = "0 9 * * 3") {
  return {
    id: 7033921,
    name: "TIMER",
    type: "TIMER",
    entityId: "",
    param: `{"cron": "${cron}", "type": "NORMAL", "enabled": ${enabled}, "repeated": true, "timeZoneId": "Europe/Berlin"}`,
  };
}

/** One Routine as `user/scene/device/{duid}` lists it. */
function scene({
  id,
  name,
  duid,
  timerEnabled = true,
  sceneEnabled = true,
  timer = true,
}) {
  return {
    id,
    name,
    param: JSON.stringify({
      triggers: timer ? [trigger(timerEnabled)] : [],
      action: {
        type: "S",
        items: [
          {
            id: 1,
            type: "CMD",
            name: "Schlafzimmer",
            entityId: duid,
            param:
              '{"id":1,"method":"do_scenes_segments","params":{"data":[{"tid":"1","segs":[{"sid":2}]}],"source":101}}',
            finishDpIds: [130],
          },
        ],
      },
    }),
    enabled: sceneEnabled,
    extra: null,
    type: "WORKFLOW",
  };
}

/**
 * The account's schedule calls, with the cloud's scenes and the robot's
 * timers as state. `serverTimers` is a list, an Error to throw, or a function.
 */
function makeScheduleAccount({ duid, scenes = [], serverTimers = [] }) {
  const state = { scenes: scenes.map((s) => ({ ...s })), serverTimers };
  const api = {
    state,
    getServerTimers: jest.fn(async () => {
      const value = state.serverTimers;
      if (value instanceof Error) throw value;
      return typeof value === "function" ? value() : value;
    }),
    getCloudScenes: jest.fn(async () => state.scenes.map((s) => ({ ...s }))),
    updateCloudSceneParam: jest.fn(async (sceneId, param) => {
      const target = state.scenes.find((s) => String(s.id) === String(sceneId));
      target.param = JSON.stringify(param);
    }),
    setCloudSceneEnabled: jest.fn(async (sceneId, enabled) => {
      const target = state.scenes.find((s) => String(s.id) === String(sceneId));
      target.enabled = enabled;
    }),
    executeCloudScene: jest.fn(async () => undefined),
    vacuums: { [duid]: { command: jest.fn(async () => ["ok"]) } },
  };
  return api;
}

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

/** What the schedule coordinator needs of the platform, with real HAP. */
function makeSchedulePlatform(roborockAPI) {
  return {
    Service: hap.Service,
    Characteristic: hap.Characteristic,
    roborockAPI,
    api: {
      hap,
      updatePlatformAccessories: jest.fn(),
    },
    log: createLog(),
  };
}

/** The Switch services in an accessory, by subtype. */
function switchSubtypes(accessory) {
  return accessory.services
    .filter((service) => service.UUID === hap.Service.Switch.UUID)
    .map((service) => service.subtype);
}

module.exports = {
  PlatformAccessory,
  createLog,
  hap,
  makeScheduleAccount,
  makeSchedulePlatform,
  scene,
  switchSubtypes,
  trigger,
};
