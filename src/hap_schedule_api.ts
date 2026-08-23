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

interface RoborockRequestOptions {
  preferCloud?: boolean;
  preferLocal?: boolean;
  allowOfflineCloudSend?: boolean;
  requestTimeoutMs?: number;
  waitForResult?: boolean;
  throwOnError?: boolean;
}

interface RoborockScheduleApi {
  getServerTimers: (
    duid: string,
    options?: RoborockRequestOptions
  ) => Promise<unknown>;
  updateServerTimer?: (
    duid: string,
    timerId: string | number,
    enabled: boolean,
    options?: RoborockRequestOptions
  ) => Promise<unknown>;
  startCommand?: (
    duid: string,
    command: string,
    parameters: unknown,
    options?: RoborockRequestOptions
  ) => Promise<unknown>;
  vacuums?: Record<
    string,
    {
      command?: (
        duid: string,
        command: string,
        parameters: unknown,
        options?: RoborockRequestOptions
      ) => Promise<unknown>;
    }
  >;
}

function scheduleRequestOptions(
  options: RoborockRequestOptions = {}
): RoborockRequestOptions {
  return {
    ...options,
    preferCloud: true,
  };
}

export async function getServerTimers(
  api: RoborockScheduleApi,
  duid: string,
  options: RoborockRequestOptions = {}
): Promise<unknown> {
  return api.getServerTimers(duid, scheduleRequestOptions(options));
}

export async function updateServerTimer(
  api: RoborockScheduleApi,
  duid: string,
  timer: string | number | unknown[],
  enabled: boolean,
  options: RoborockRequestOptions = {}
): Promise<unknown> {
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
  const vacuum = api.vacuums?.[duid];
  if (typeof vacuum?.command === "function") {
    return vacuum.command(
      duid,
      "upd_server_timer",
      [[timerId, enabled ? "on" : "off"]],
      requestOptions
    );
  }

  if (typeof api.startCommand === "function") {
    return api.startCommand(
      duid,
      "upd_server_timer",
      [[timerId, enabled ? "on" : "off"]],
      requestOptions
    );
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
export async function updateTimer(
  api: RoborockScheduleApi,
  duid: string,
  timer: string | number | unknown[],
  enabled: boolean,
  options: RoborockRequestOptions = {}
): Promise<unknown> {
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
  const vacuum = api.vacuums?.[duid];

  if (typeof vacuum?.command === "function") {
    return vacuum.command(
      duid,
      "upd_timer",
      [timerId, enabled ? "on" : "off"],
      requestOptions
    );
  }

  if (typeof api.startCommand === "function") {
    return api.startCommand(
      duid,
      "upd_timer",
      [timerId, enabled ? "on" : "off"],
      requestOptions
    );
  }

  throw new Error("Roborock timer command API is unavailable");
}
