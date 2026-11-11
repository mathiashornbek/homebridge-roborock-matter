"use strict";
/**
 * Small HAP-only adapter around the shared Roborock API.
 *
 * These calls intentionally live outside roborockAPI.js. Mathias's Matter
 * implementation owns that file; keeping the HAP schedule integration here
 * makes upstream updates much easier to consume.
 *
 * Server timers use the cloud-preferred Roborock contract. The underlying
 * vacuum API expects the timer id plus the desired status; the full timer
 * tuple is retained by the HAP accessory for verification/state tracking.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLOUD_SCENE_ID_PREFIX = void 0;
exports.getServerTimers = getServerTimers;
exports.updateServerTimer = updateServerTimer;
exports.updateTimer = updateTimer;
exports.isCloudSceneScheduleId = isCloudSceneScheduleId;
exports.cloudSceneIdFromScheduleId = cloudSceneIdFromScheduleId;
exports.getCloudScenes = getCloudScenes;
exports.setCloudSceneScheduleEnabled = setCloudSceneScheduleEnabled;
exports.executeCloudScene = executeCloudScene;
exports.cloudSceneSwitchPosition = cloudSceneSwitchPosition;
function scheduleRequestOptions(options = {}) {
    return {
        ...options,
        preferCloud: true,
    };
}
async function getServerTimers(api, duid, options = {}) {
    return api.getServerTimers(duid, scheduleRequestOptions(options));
}
async function updateServerTimer(api, duid, timer, enabled, options = {}) {
    var _a;
    const timerId = Array.isArray(timer) ? timer[0] : timer;
    if (typeof timerId !== "string" && typeof timerId !== "number") {
        throw new Error(`Invalid Roborock schedule ID: ${String(timerId)}`);
    }
    const requestOptions = scheduleRequestOptions({
        ...options,
        waitForResult: true,
        throwOnError: true,
    });
    // Roborock's `upd_server_timer` contract expects the timer tuple as the
    // first (and only) command parameter: [[timerId, "on"|"off"]]. The shared
    // vacuum API's historical updateServerTimer helper flattened that tuple to
    // [timerId, status], which is accepted by some paths but does not update the
    // schedule in the Roborock app. Keep the HAP schedule integration isolated
    // from that upstream helper and send the exact cloud command shape here.
    const vacuum = (_a = api.vacuums) === null || _a === void 0 ? void 0 : _a[duid];
    if (typeof (vacuum === null || vacuum === void 0 ? void 0 : vacuum.command) === "function") {
        return vacuum.command(duid, "upd_server_timer", [[timerId, enabled ? "on" : "off"]], requestOptions);
    }
    if (typeof api.startCommand === "function") {
        return api.startCommand(duid, "upd_server_timer", [[timerId, enabled ? "on" : "off"]], requestOptions);
    }
    if (typeof api.updateServerTimer === "function") {
        return api.updateServerTimer(duid, timerId, enabled, requestOptions);
    }
    throw new Error("Roborock schedule command API is unavailable");
}
/**
 * Fallback for robots that expose the standard timer endpoint rather than
 * applying upd_server_timer. This deliberately calls the underlying vacuum's
 * command method rather than a broad platform command wrapper: vacuum.command
 * supports throwOnError, so a failed fallback cannot be mistaken for success.
 */
async function updateTimer(api, duid, timer, enabled, options = {}) {
    var _a;
    const timerId = Array.isArray(timer) ? timer[0] : timer;
    if (typeof timerId !== "string" && typeof timerId !== "number") {
        throw new Error(`Invalid Roborock schedule ID: ${String(timerId)}`);
    }
    const requestOptions = scheduleRequestOptions({
        ...options,
        waitForResult: true,
        throwOnError: true,
    });
    // Prefer the underlying vacuum command path because upd_timer is not
    // included in SIMPLE_VACUUM_COMMANDS and startCommand can therefore
    // resolve without actually sending the command.
    const vacuum = (_a = api.vacuums) === null || _a === void 0 ? void 0 : _a[duid];
    if (typeof (vacuum === null || vacuum === void 0 ? void 0 : vacuum.command) === "function") {
        return vacuum.command(duid, "upd_timer", [timerId, enabled ? "on" : "off"], requestOptions);
    }
    if (typeof api.startCommand === "function") {
        return api.startCommand(duid, "upd_timer", [timerId, enabled ? "on" : "off"], requestOptions);
    }
    throw new Error("Roborock timer command API is unavailable");
}
/*
 * ---------------------------------------------------------------------------
 * Cloud scenes — the app's Routines, and the schedules some robots keep there.
 * ---------------------------------------------------------------------------
 *
 * A Saros 10R (`roborock.vacuum.a144`) refuses `get_server_timer` with
 * `-10007 "Not FCC robot"` and answers `get_timer` with `[]`, while its owner
 * has three daily schedules in the app (#22). Those live on the account, as
 * timer-driven scenes under `user/scene/device/{duid}`, and so do every
 * robot's manually run Routines. The shared API exposes them raw; this layer
 * gives the HAP accessories the four calls they need, in the same shape as
 * the server-timer calls above.
 */
const { parseCloudSceneSchedules, buildSceneParamWithTimersEnabled, cloudSceneScheduleIsActive, } = require("../roborockLib/lib/parseCloudSceneSchedules");
/** Prefix that keeps a scene's switch id apart from a server timer's. */
exports.CLOUD_SCENE_ID_PREFIX = "scene:";
function isCloudSceneScheduleId(id) {
    return id.startsWith(exports.CLOUD_SCENE_ID_PREFIX);
}
function cloudSceneIdFromScheduleId(id) {
    return isCloudSceneScheduleId(id)
        ? id.slice(exports.CLOUD_SCENE_ID_PREFIX.length)
        : id;
}
/**
 * Read a robot's scenes and decode the timer-driven ones.
 *
 * Throws when the API is missing or the read fails; a failed read is never
 * an empty list, because callers remove switches on an empty list.
 */
async function getCloudScenes(api, duid) {
    if (typeof api.getCloudScenes !== "function") {
        throw new Error("Roborock cloud scene API is unavailable");
    }
    const raw = await api.getCloudScenes(duid);
    if (!Array.isArray(raw)) {
        throw new Error(`user/scene/device answered with ${typeof raw}`);
    }
    const scenes = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            continue;
        const record = entry;
        if (record.id === undefined || record.id === null)
            continue;
        const [schedule] = parseCloudSceneSchedules([record]);
        const id = String(record.id);
        scenes.push({
            id,
            name: typeof record.name === "string" && record.name.trim()
                ? record.name.trim()
                : `Routine ${id}`,
            raw: record,
            schedule: schedule !== null && schedule !== void 0 ? schedule : null,
        });
    }
    return scenes;
}
/**
 * Switch a timer-driven scene's schedule on or off, the way the app does.
 *
 * Off: rewrite the scene's param with every TIMER trigger's nested `enabled`
 * false — the flag the reporter's app flipped, measured in #22. On: the same
 * with `true`, and if the scene itself had been disabled at scene level (a
 * state the app can produce and the cloud can express), enable it too, since
 * a scene disabled there never fires. Each write is gated by the shared API
 * on the route's own `Allow` header.
 */
async function setCloudSceneScheduleEnabled(api, scene, enabled) {
    if (typeof api.updateCloudSceneParam !== "function" ||
        typeof api.setCloudSceneEnabled !== "function") {
        throw new Error("Roborock cloud scene API is unavailable");
    }
    const param = buildSceneParamWithTimersEnabled(scene.raw, enabled);
    if (!param) {
        throw new Error(`Routine "${scene.name}" has no timer to switch; it can only be run.`);
    }
    await api.updateCloudSceneParam(scene.id, param);
    if (enabled && scene.raw.enabled === false) {
        await api.setCloudSceneEnabled(scene.id, true);
    }
}
/** Run a scene now. */
async function executeCloudScene(api, sceneId) {
    if (typeof api.executeCloudScene !== "function") {
        throw new Error("Roborock cloud scene API is unavailable");
    }
    await api.executeCloudScene(sceneId);
}
/** The switch position a timer-driven scene shows, or null when it has no timer. */
function cloudSceneSwitchPosition(scene) {
    return cloudSceneScheduleIsActive(scene.raw);
}
//# sourceMappingURL=hap_schedule_api.js.map