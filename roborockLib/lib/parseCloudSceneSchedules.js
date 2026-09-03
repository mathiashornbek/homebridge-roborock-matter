"use strict";

/**
 * Decode Roborock's `user/scene/device/{duid}` answer into schedule facts.
 *
 * Issue #22, fourth act. The 3.23.0 probe asked two candidate cloud routes
 * where a Saros 10R (`roborock.vacuum.a144`) keeps the three daily schedules
 * its owner demonstrably has, and the answer was unambiguous:
 * `user/devices/{duid}/jobs` returned `[]`, and `user/scene/device/{duid}`
 * returned all three, cron and timezone included.
 *
 * The probe printed that answer through `compactDiagnosticPayload`, which
 * truncates any string at 500 characters and any array at 8 entries. That is
 * right for an envelope nobody has mapped, and it cost us real ground on this
 * one. Measured on the answer we actually received: the cron survived, because
 * `triggers` happens to serialise ahead of `action`, but every one of the three
 * scenes was cut mid-task — the log said when each schedule fires and never
 * what it does. An account with more than eight schedules loses the rest of
 * them outright to the array cap.
 *
 * So the payload is decoded BEFORE it is compacted, from the raw answer, and
 * the facts are logged as facts. The compaction stays as it is: it is the
 * right default for a shape we do not know, and this decoder is what makes the
 * shape we do know legible.
 *
 * This module is deliberately pure: no network, no writes, no state. It
 * describes what the cloud said. Mapping these into HomeKit switches needs a
 * write route that nobody has measured yet, and guessing one against a live
 * account is not a thing this project does.
 */

/** Weekday names in cron's own numbering, where both 0 and 7 mean Sunday. */
const CRON_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Roborock nests JSON inside JSON: a scene's `param` is a string holding
 * `{triggers, action}`, each trigger's `param` is a string holding the cron,
 * and each action item's `param` is a string holding the device method.
 *
 * A field that is already an object is returned as-is, because two firmware
 * generations have disagreed about that before and neither shape is wrong.
 *
 * @param {unknown} value string of JSON, or an already-parsed object
 * @returns {Record<string, unknown> | null} the object, or null when it is neither
 */
function parseNestedJson(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return /** @type {Record<string, unknown>} */ (value);
  }

  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    // A payload we cannot parse is a measurement we do not have. It is never
    // a reason to fail the poll this rides on.
    return null;
  }
}

/**
 * Expand one cron day-of-week field into weekday names.
 *
 * Supports the two forms Roborock's app actually emits — a single day and a
 * comma list — plus simple ranges, and gives up on everything else rather
 * than inventing a reading. `*` means every day.
 *
 * @param {string} field cron day-of-week field
 * @returns {string|null} human weekday list, or null when unrecognised
 */
function describeCronWeekdays(field) {
  if (field === "*") return "daily";

  /** @type {number[]} */
  const days = [];
  for (const part of field.split(",")) {
    const range = part.match(/^(\d)-(\d)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to) return null;
      for (let day = from; day <= to; day += 1) days.push(day);
      continue;
    }

    if (!/^\d$/.test(part)) return null;
    days.push(Number(part));
  }

  if (days.length === 0) return null;

  const names = days.map((day) => CRON_WEEKDAYS[day === 7 ? 0 : day]);
  if (names.some((name) => name === undefined)) return null;

  return [...new Set(names)].join(", ");
}

/**
 * Render a cron expression as a time and a set of weekdays.
 *
 * Only the shape Roborock's schedule screen produces is rendered — a fixed
 * minute and hour on given weekdays. Anything else (step values, a day of
 * month, a month) returns null, and the caller falls back to printing the
 * cron verbatim. A half-understood rendering would be worse than the raw
 * string, because it reads as if we understood it.
 *
 * @param {unknown} cron cron expression from the trigger payload
 * @returns {string|null} e.g. `09:00 on Wed`, or null when not rendered
 */
function describeCron(cron) {
  if (typeof cron !== "string") return null;

  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (dayOfMonth !== "*" || month !== "*") return null;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;

  const minuteValue = Number(minute);
  const hourValue = Number(hour);
  if (minuteValue > 59 || hourValue > 23) return null;

  const weekdays = describeCronWeekdays(dayOfWeek);
  if (!weekdays) return null;

  const time = `${String(hourValue).padStart(2, "0")}:${String(
    minuteValue
  ).padStart(2, "0")}`;

  return weekdays === "daily" ? `${time} daily` : `${time} on ${weekdays}`;
}

/**
 * @typedef {object} CloudSceneTrigger
 * @property {string|null} id trigger id as the cloud reported it
 * @property {string} type trigger type, e.g. `TIMER`
 * @property {string|null} cron cron expression, when the trigger carries one
 * @property {string|null} schedule human rendering of `cron`, when recognised
 * @property {boolean} enabled whether the trigger itself is switched on
 * @property {boolean} repeated whether the cloud marked it as repeating
 * @property {string|null} timeZoneId IANA zone the cron is evaluated in
 */

/**
 * @typedef {object} CloudSceneAction
 * @property {string|null} method device method the scene runs
 * @property {number|null} segmentCount rooms in the task, when countable
 */

/**
 * Which of the two enable flags the app actually uses is MEASURED, not
 * assumed, and it matters to anything that would ever write one back.
 *
 * The reporter in issue #22 switched two of his three schedules off in the
 * Roborock app and sent the probe's reading. Every scene-level `enabled`
 * stayed `true`; the flag that changed was `enabled` inside each TIMER
 * trigger's own nested `param` string. So the app toggles the TRIGGER, and a
 * schedule switch would have to rewrite that nested JSON rather than the
 * scene's own field.
 *
 * Both flags are still modelled, because a scene disabled at scene level is a
 * state the cloud can express and `active` has to account for it.
 *
 * @typedef {object} CloudSceneSchedule
 * @property {string} id scene id
 * @property {string|null} name scene name as shown in the app
 * @property {string|null} type scene type, e.g. `WORKFLOW`
 * @property {boolean} enabled scene-level enable flag — measured to stay
 *   `true` when the app switches a schedule off
 * @property {boolean} active scene enabled AND at least one timer enabled
 * @property {CloudSceneTrigger[]} triggers timer triggers on the scene
 * @property {CloudSceneAction[]} actions device actions the scene performs
 */

/**
 * Read one trigger.
 *
 * @param {unknown} raw trigger entry from the scene payload
 * @returns {CloudSceneTrigger|null} the trigger, or null when unreadable
 */
function parseTrigger(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const entry = /** @type {Record<string, unknown>} */ (raw);
  const type =
    typeof entry.type === "string" && entry.type
      ? entry.type
      : typeof entry.name === "string" && entry.name
        ? entry.name
        : null;
  if (!type) return null;

  const param = parseNestedJson(entry.param) ?? {};
  const cron = typeof param.cron === "string" ? param.cron.trim() : null;

  return {
    id: entry.id === undefined || entry.id === null ? null : String(entry.id),
    type,
    cron: cron || null,
    schedule: describeCron(cron),
    // The cloud omits `enabled` on some entries; a trigger that exists and
    // says nothing is on, which is what the app shows.
    enabled: param.enabled !== false,
    repeated: param.repeated === true,
    timeZoneId:
      typeof param.timeZoneId === "string" && param.timeZoneId
        ? param.timeZoneId
        : null,
  };
}

/**
 * Read the device methods a scene performs, so a decoded line says what the
 * schedule actually does and not merely when it fires.
 *
 * Room names and `entityId` are deliberately not carried out of here: the
 * duid is already redacted everywhere else the plugin logs, and the room
 * names are printed by the room map at startup. A count is what is missing.
 *
 * @param {Record<string, unknown>} sceneParam parsed scene `param`
 * @returns {CloudSceneAction[]} one entry per device command
 */
function parseActions(sceneParam) {
  const action = parseNestedJson(sceneParam.action);
  const items = action && Array.isArray(action.items) ? action.items : [];

  /** @type {CloudSceneAction[]} */
  const actions = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;

    const param = parseNestedJson(
      /** @type {Record<string, unknown>} */ (item).param
    );
    if (!param) continue;

    const method = typeof param.method === "string" ? param.method : null;
    if (!method) continue;

    let segmentCount = null;
    const params = parseNestedJson(param.params);
    const data = params && Array.isArray(params.data) ? params.data : null;
    if (data) {
      let counted = 0;
      let sawSegments = false;
      for (const entry of data) {
        if (!entry || typeof entry !== "object") continue;
        const segs = /** @type {Record<string, unknown>} */ (entry).segs;
        if (Array.isArray(segs)) {
          sawSegments = true;
          counted += segs.length;
        }
      }
      if (sawSegments) segmentCount = counted;
    }

    actions.push({ method, segmentCount });
  }

  return actions;
}

/**
 * Decode the scenes route into the timer-driven ones.
 *
 * Scenes without a timer trigger are the app's manually run Routines. They
 * are real, and they are not schedules, so they are left out here and counted
 * separately by {@link summariseCloudSceneSchedules} rather than dropped
 * silently.
 *
 * Never throws: this decodes a diagnostic that rides on a live poll.
 *
 * @param {unknown} payload unwrapped answer from `user/scene/device/{duid}`
 * @returns {CloudSceneSchedule[]} timer-driven scenes, in cloud order
 */
function parseCloudSceneSchedules(payload) {
  if (!Array.isArray(payload)) return [];

  /** @type {CloudSceneSchedule[]} */
  const schedules = [];

  for (const raw of payload) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;

    const scene = /** @type {Record<string, unknown>} */ (raw);
    if (scene.id === undefined || scene.id === null) continue;

    const sceneParam = parseNestedJson(scene.param);
    if (!sceneParam) continue;

    const rawTriggers = Array.isArray(sceneParam.triggers)
      ? sceneParam.triggers
      : [];

    const triggers = rawTriggers.map(parseTrigger).filter(
      /** @returns {trigger is CloudSceneTrigger} */
      (trigger) => trigger !== null && trigger.cron !== null
    );

    if (triggers.length === 0) continue;

    const enabled = scene.enabled !== false;

    schedules.push({
      id: String(scene.id),
      name: typeof scene.name === "string" && scene.name ? scene.name : null,
      type: typeof scene.type === "string" && scene.type ? scene.type : null,
      enabled,
      active: enabled && triggers.some((trigger) => trigger.enabled),
      triggers,
      actions: parseActions(sceneParam),
    });
  }

  return schedules;
}

/**
 * Render one decoded schedule as a single log line.
 *
 * @param {CloudSceneSchedule} schedule decoded scene
 * @returns {string} one line, safe to log
 */
function describeCloudSceneSchedule(schedule) {
  const parts = [];

  for (const trigger of schedule.triggers) {
    const when = trigger.schedule ?? `cron ${trigger.cron}`;
    const zone = trigger.timeZoneId ? ` (${trigger.timeZoneId})` : "";
    parts.push(`${when}${zone}${trigger.enabled ? "" : " [timer off]"}`);
  }

  const actions = schedule.actions
    .map((action) =>
      action.segmentCount === null
        ? action.method
        : `${action.method} over ${action.segmentCount} segment(s)`
    )
    .join(", ");

  const name = schedule.name ? `"${schedule.name}"` : "unnamed";
  const state = schedule.active
    ? "enabled"
    : schedule.enabled
      ? "disabled at the timer"
      : "disabled";

  return `${name} (scene ${schedule.id}) — ${parts.join("; ")}, ${state}${
    actions ? `, runs ${actions}` : ""
  }`;
}

/**
 * Summarise the whole answer, headline first.
 *
 * Returns an empty array when the route carried no timer-driven scene, so a
 * caller can stay silent rather than announce an absence.
 *
 * @param {unknown} payload unwrapped answer from `user/scene/device/{duid}`
 * @returns {string[]} log lines, or an empty array when there is nothing to say
 */
function summariseCloudSceneSchedules(payload) {
  const schedules = parseCloudSceneSchedules(payload);
  if (schedules.length === 0) return [];

  const total = Array.isArray(payload) ? payload.length : schedules.length;
  const headline =
    total === schedules.length
      ? `${schedules.length} timer-driven scene(s)`
      : `${schedules.length} of ${total} scene(s) are timer-driven`;

  return [headline, ...schedules.map(describeCloudSceneSchedule)];
}

module.exports = {
  parseCloudSceneSchedules,
  describeCloudSceneSchedule,
  summariseCloudSceneSchedules,
  describeCron,
};
