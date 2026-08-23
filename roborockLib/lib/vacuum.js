"use strict";

const rrMessage = require("./message").message;
const RRMapParser = require("./RRMapParser");
const fs = require("fs");
const zlib = require("zlib");
const { describeDevice } = require("./describeDevice");

// Minimum spacing between periodic (non-forced) get_status polls per robot.
// MQTT push remains the primary live channel; this is the safety net that
// catches a dropped push long before the 3-minute full refresh would.
const STATUS_POLL_MIN_INTERVAL_MS = 60 * 1000;

// Longest rendering of a single unmapped attribute value in the report line
// below. `cleaning_info` is an object, and one robot's status can carry a
// nested blob big enough to bury the rest of the message.
const MAX_REPORTED_STATUS_VALUE_LENGTH = 60;

/**
 * The one list of caller options that travel with a request to the queue.
 *
 * Both `command` and `getParameter` derive theirs here on purpose. A
 * hand-written copy of a list like this in two places is the fault shape this
 * project keeps finding: the copies drift, and the one nobody looked at goes
 * on sending requests the caller never asked for.
 *
 * @param {{ preferCloud?: boolean, preferLocal?: boolean, allowOfflineCloudSend?: boolean, requestTimeoutMs?: number }} [options]
 * @returns {{ preferCloud?: boolean, preferLocal?: boolean, allowOfflineCloudSend?: boolean, requestTimeoutMs?: number }}
 */
function buildForwardedRequestOptions(options = {}) {
  /** @type {{ preferCloud?: boolean, preferLocal?: boolean, allowOfflineCloudSend?: boolean, requestTimeoutMs?: number }} */
  const requestOptions = {};

  if (options.preferCloud) {
    requestOptions.preferCloud = true;
  }
  if (options.preferLocal) {
    requestOptions.preferLocal = true;
  }
  if (options.allowOfflineCloudSend) {
    requestOptions.allowOfflineCloudSend = true;
  }
  // A non-positive or non-finite timeout is not an override to
  // messageQueueHandler — it silently restores that layer's ten-second
  // default. Only a usable budget is forwarded.
  if (
    typeof options.requestTimeoutMs === "number" &&
    Number.isFinite(options.requestTimeoutMs) &&
    options.requestTimeoutMs > 0
  ) {
    requestOptions.requestTimeoutMs = options.requestTimeoutMs;
  }

  return requestOptions;
}

/**
 * Render a `get_status` value for a log line. The old per-attribute warning
 * interpolated the raw value, so an object arrived as the useless
 * `[object Object]` — visible in skmzwanke's log for `cleaning_info`, which is
 * the one field where the shape was the interesting part.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describeStatusValue(value) {
  let text;

  if (value === null || typeof value !== "object") {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = "[unserialisable]";
    }
  }

  return text.length > MAX_REPORTED_STATUS_VALUE_LENGTH
    ? `${text.slice(0, MAX_REPORTED_STATUS_VALUE_LENGTH)}…`
    : text;
}

const mappedCleanSummary = {
  0: "clean_time",
  1: "clean_area",
  2: "clean_count",
  3: "records",
};

const mappedCleaningRecordAttribute = {
  0: "begin",
  1: "end",
  2: "duration",
  3: "area",
  4: "error",
  5: "complete",
  6: "start_type",
  7: "clean_type",
  8: "finish_reason",
  9: "dust_collection_status",
};

class vacuum {
  constructor(adapter, robotModel) {
    this.adapter = adapter;

    this.adapter.log.debug(`Robot key: ${robotModel}`);
    this.robotModel = robotModel;

    this.message = new rrMessage(this.adapter);

    this.mapParser = new RRMapParser(this.adapter);

    this.parameterFolders = {
      get_mop_mode: "deviceStatus",
      get_water_box_mode: "deviceStatus",
      get_water_box_custom_mode: "deviceStatus",
      get_network_info: "networkInfo",
      get_consumable: "consumables",
      get_fw_features: "firmwareFeatures",
      get_carpet_mode: "deviceStatus",
      get_carpet_clean_mode: "deviceStatus",
      get_carpet_cleaning_mode: "deviceStatus",
    };

    /** @type {Map<string, number>} last periodic status poll, per duid */
    this.lastStatusPollAt = new Map();

    /**
     * `get_status` attributes with no mapping in the robot's feature profile
     * that have already been reported, per duid. The set of unmapped fields a
     * given robot sends is fixed by its firmware, so reporting it once says
     * everything a repeat would; a time-based throttle would still bring the
     * message back forever, which is the complaint, not the fix.
     *
     * @type {Map<string, Set<string>>}
     */
    this.reportedUnmappedStatusAttributes = new Map();
  }

  /**
   * Record that an unmapped `get_status` attribute is about to be reported for
   * a robot, and say whether this is the initial sighting.
   *
   * @param {string} duid
   * @param {string} attribute
   * @returns {boolean} true only the one time the pair has not been seen before
   */
  rememberUnmappedStatusAttribute(duid, attribute) {
    let reported = this.reportedUnmappedStatusAttributes.get(duid);

    if (!reported) {
      reported = new Set();
      this.reportedUnmappedStatusAttributes.set(duid, reported);
    }

    if (reported.has(attribute)) {
      return false;
    }

    reported.add(attribute);
    return true;
  }

  /**
   * True when this robot's periodic status poll is due again.
   * @param {string} duid
   */
  shouldPollStatusNow(duid) {
    const last = this.lastStatusPollAt.get(duid);
    return (
      last === undefined || Date.now() - last >= STATUS_POLL_MIN_INTERVAL_MS
    );
  }

  /** @param {string} duid */
  markStatusPolled(duid) {
    this.lastStatusPollAt.set(duid, Date.now());
  }

  async updateDiagnosticSnapshot(duid, key, payload) {
    if (typeof this.adapter.updateRoborockDiagnostics !== "function") {
      return;
    }

    await this.adapter.updateRoborockDiagnostics(duid, key, {
      capturedAt: new Date().toISOString(),
      payload,
    });
  }

  async command(duid, parameter, value, options = {}) {
    try {
      const requestOptions = buildForwardedRequestOptions(options);
      const hasRequestOptions = Object.keys(requestOptions).length > 0;
      const sendCommandRequest = (method, params) =>
        hasRequestOptions
          ? this.adapter.messageQueueHandler.sendRequest(
              duid,
              method,
              params,
              false,
              false,
              requestOptions
            )
          : this.adapter.messageQueueHandler.sendRequest(duid, method, params);

      switch (parameter) {
        case "app_segment_clean": {
          this.adapter.log.debug("Start room cleaning");

          const roomList = {};
          roomList.segments = [];
          const roomFloor = await this.adapter.getStateAsync(
            `Devices.${duid}.deviceStatus.map_status`
          );
          const mappedRoomList = await sendCommandRequest(
            "get_room_mapping",
            []
          );

          if (mappedRoomList) {
            const roomStates = await Promise.all(
              Object.keys(mappedRoomList).map((mappedRoom) =>
                this.adapter.getStateAsync(
                  `Devices.${duid}.floors.${roomFloor.val}.${mappedRoomList[mappedRoom][0]}`
                )
              )
            );

            Object.keys(mappedRoomList).forEach((mappedRoom, index) => {
              if (roomStates[index].val) {
                roomList.segments.push(mappedRoomList[mappedRoom][0]);
              }
            });
          }

          const cleanCount = await this.adapter.getStateAsync(
            `Devices.${duid}.floors.cleanCount`
          );
          roomList["repeat"] = cleanCount.val;

          const result = await sendCommandRequest("app_segment_clean", [
            roomList,
          ]);
          this.adapter.log.debug(
            `app_segment_clean with roomIDs: ${JSON.stringify(roomList)} result: ${result}`
          );
          this.adapter.setStateAsync(`Devices.${duid}.floors.cleanCount`, {
            val: 1,
            ack: true,
          });

          break;
        }
        case "app_segment_clean_by_ids": {
          const requestedSegments =
            value && Array.isArray(value.segments) ? value.segments : [];
          const segments = Array.from(
            new Set(
              requestedSegments
                .map((segment) => Number(segment))
                .filter((segment) => Number.isInteger(segment) && segment >= 0)
            )
          );
          const repeat = Number(value && value.repeat);
          const roomList = {
            segments,
            repeat: Number.isInteger(repeat) && repeat > 0 ? repeat : 1,
          };

          if (roomList.segments.length === 0) {
            this.adapter.log.warn(
              `No room segments supplied for app_segment_clean_by_ids on ${describeDevice(this.adapter, duid)}.`
            );
            break;
          }

          const result = await sendCommandRequest("app_segment_clean", [
            roomList,
          ]);
          this.adapter.log.debug(
            `app_segment_clean_by_ids with roomIDs: ${JSON.stringify(roomList)} result: ${result}`
          );

          break;
        }
        case "reset_consumable":
          await sendCommandRequest(parameter, [value]);
          this.adapter.log.info(`Consumable ${parameter} successfully reset.`);

          break;

        case "app_set_dryer_status": {
          const result = await sendCommandRequest(parameter, JSON.parse(value));
          this.adapter.log.debug(`Command: ${parameter} result: ${result}`);

          break;
        }
        case "app_goto_target":
        case "app_zoned_clean": {
          const result = await sendCommandRequest(parameter, value);
          this.adapter.log.debug(
            `Command: ${parameter} with value: ${JSON.stringify(value)} result: ${result}`
          );

          break;
        }
        case "load_multi_map": {
          const mapId = Number(value);
          if (!Number.isInteger(mapId) || mapId < 0) {
            this.adapter.log.warn(
              `Invalid map id '${value}' supplied for load_multi_map on ${describeDevice(this.adapter, duid)}.`
            );
            break;
          }

          const result = await sendCommandRequest(parameter, [mapId]);
          this.adapter.log.debug(
            `Command: ${parameter} with value: ${mapId} result: ${result}`
          );
          // The caller is waiting for this mapping, so it stays awaited — but
          // it is still the caller's request and carries the caller's options.
          return await this.getParameter(
            duid,
            "get_room_mapping",
            undefined,
            options
          );
        }
        case "set_water_box_distance_off": {
          const mappedValue = ((value - 1) / (30 - 1)) * (60 - 205) + 205;
          const parameterValue = { distance_off: mappedValue };

          const result = await sendCommandRequest(parameter, parameterValue);
          this.adapter.log.debug(
            `Command: ${parameter} with value: ${JSON.stringify(parameterValue)} result: ${result}`
          );
          break;
        }
        default:
          if (value && typeof value !== "boolean") {
            const valueType = typeof value;

            if (valueType === "string") {
              value = await JSON.parse(value);
            } else if (valueType === "number") {
              value = [value];
            }

            // await is important here!!! Wait for the command to finish before sending the request to update deviceConfig!!!
            const result = await sendCommandRequest(parameter, value);
            this.adapter.log.debug(
              `Command: ${parameter} with value: ${JSON.stringify(value)} result: ${result}`
            );

            this.refreshStateAfterCommand(duid, parameter, options);
            return result;
          } else {
            const result = await sendCommandRequest(parameter, []);
            this.adapter.log.debug(`Command: ${parameter} result: ${result}`);
            return result;
          }
      }
    } catch (error) {
      this.adapter.catchError(error, parameter, duid, this.robotModel);
      if (options.throwOnError) {
        throw error;
      }
    }
  }

  /**
   * Refresh this plugin's own state cache after a `set_*` command. Bookkeeping,
   * not part of the command.
   *
   * A command is finished when the robot acknowledges it. The paired `get_*`
   * that follows only updates state objects on this side — but it used to be
   * awaited inside the caller's latency budget AND issued with no options at
   * all, so it reverted to the local transport and the ten-second default no
   * matter what the caller had asked for.
   *
   * skmzwanke's 3.4.14 log (#8) is that arithmetic in the field. His water
   * command was acknowledged over the cloud in about a tenth of a second
   * inside a 2500 ms clean-mode window; the refresh then went out over a LAN
   * he had configured the plugin away from and hung for ten seconds. The
   * window closed, the start command overtook his "Vacuum" choice, and the
   * fallback water command was never tried — all of it spent on a read nobody
   * was waiting for. Two rounds of fixes had sized the *commands* against the
   * window while this read sat outside the accounting entirely.
   *
   * So it inherits the caller's transport, never the caller's deadline, is not
   * awaited, and cannot fail the command.
   *
   * @param {string} duid
   * @param {string} parameter The command that was just acknowledged.
   * @param {object} options The caller's command options.
   */
  refreshStateAfterCommand(duid, parameter, options) {
    const getCommand = parameter.replace("set", "get");
    // Nothing to read back: a command with no `set` in its name would other-
    // wise be re-sent to the robot as its own "refresh".
    if (getCommand === parameter) {
      return;
    }

    // The deadline is dropped on purpose: it was the caller's budget for the
    // command, and the refresh is no longer inside it.
    const { requestTimeoutMs, ...transport } =
      buildForwardedRequestOptions(options);
    void requestTimeoutMs;

    Promise.resolve()
      .then(() => this.getParameter(duid, getCommand, undefined, transport))
      .catch((error) => {
        this.adapter.log.debug(
          `State refresh ${getCommand} after ${parameter} failed for ${describeDevice(this.adapter, duid)}; the command itself was acknowledged. ${error?.message || error}`
        );
      });
  }

  async getServerTimers(duid, options = {}) {
    try {
      const requestOptions = buildForwardedRequestOptions(options);

      return await this.adapter.messageQueueHandler.sendRequest(
        duid,
        "get_server_timer",
        [],
        false,
        false,
        requestOptions
      );
    } catch (error) {
      this.adapter.catchError(error, "get_server_timer", duid, this.robotModel);
      throw error;
    }
  }

  async updateServerTimer(duid, timerId, enabled, options = {}) {
    try {
      const requestOptions = buildForwardedRequestOptions(options);

      return await this.adapter.messageQueueHandler.sendRequest(
        duid,
        "upd_server_timer",
        [timerId, enabled ? "on" : "off"],
        false,
        false,
        requestOptions
      );
    } catch (error) {
      this.adapter.catchError(error, "upd_server_timer", duid, this.robotModel);
      throw error;
    }
  }

  async getParameter(duid, parameter, attribute, options = {}) {
    if (this.adapter.isPollCommandUnsupported?.(duid, parameter)) {
      return;
    }
    let mode;

    // Every request below is issued on the caller's behalf, so it carries the
    // caller's transport and timeout. Until 3.4.15 only the `get_status` branch
    // did, by hand, and every other branch reverted to the local transport and
    // the ten-second default however the caller had been configured (#8).
    const requestOptions = buildForwardedRequestOptions(options);
    /**
     * @param {string} method
     * @param {unknown} params
     * @param {boolean} [secure]
     * @param {boolean} [photo]
     */
    const sendParameterRequest = (
      method,
      params,
      secure = false,
      photo = false
    ) =>
      this.adapter.messageQueueHandler.sendRequest(
        duid,
        method,
        params,
        secure,
        photo,
        requestOptions
      );

    try {
      if (parameter == "get_network_info") {
        mode = parameter;
        const networkInfo = await sendParameterRequest(parameter, []);

        for (const attribute in networkInfo) {
          if (
            attribute == "ip" &&
            !this.adapter.isCloudOnlyModeEnabled?.() &&
            !(await this.adapter.isRemoteDevice(duid))
          ) {
            this.adapter.localDevices[duid] = networkInfo[attribute];
          }
          this.adapter.setStateAsync(
            `Devices.${duid}.networkInfo.${attribute}`,
            { val: networkInfo[attribute], ack: true }
          );
        }
      } else if (parameter == "get_consumable") {
        const consumables = (
          await sendParameterRequest("get_consumable", [])
        )[0];

        for (const consumable in consumables) {
          const divider =
            this.adapter.vacuums[duid].features.getConsumablesDivider(
              consumable
            );
          if (divider) {
            const consumable_val = divider
              ? Math.round(consumables[consumable] / divider)
              : consumables[consumable];

            this.adapter.setStateAsync(
              `Devices.${duid}.consumables.${consumable}`,
              { val: consumable_val, ack: true }
            );
          }
        }
      } else if (parameter == "get_status") {
        const force = attribute == "force";

        // Periodic status refresh, throttled per robot.
        //
        // The inherited gate here read `config.updateInterval` (a key this
        // plugin never sets) and `adapter.socket` (permanently null), so the
        // expression was `NaN == 0` — always false. The refresh the comment
        // promised has therefore never run: classic robots relied entirely on
        // MQTT push plus the slow 3-minute full poll, and a silently dropped
        // push left Apple Home stale for minutes. An explicit elapsed-time
        // throttle restores the safety net, and being relative rather than
        // aligned to wall-clock seconds also stops every robot in a fleet
        // from polling in the same instant.
        if (force || this.shouldPollStatusNow(duid)) {
          this.markStatusPolled(duid);

          // const deviceStatus = await sendParameterRequest("get_status", []);
          const deviceStatus = await sendParameterRequest("get_prop", [
            "get_status",
          ]);

          await this.updateDiagnosticSnapshot(duid, "lastStatus", {
            method: "get_status",
            status: deviceStatus[0] || null,
          });

          // Collected across the whole poll and reported as one line. Eight
          // separate warnings, once a minute, was ~11,500 identical requests a
          // day to contact the dev about the same eight fields (#8).
          /** @type {string[]} */
          const newlyUnmappedAttributes = [];

          for (const attribute in deviceStatus[0]) {
            const isCleaning = this.adapter.isCleaning(
              deviceStatus[0]["state"]
            );

            if (
              !(await this.adapter.getObjectAsync(
                `Devices.${duid}.deviceStatus.${attribute}`
              ))
            ) {
              const isKnownStatusAttribute =
                typeof this.adapter.vacuums[duid].features
                  .hasDeviceStatusAttribute === "function" &&
                this.adapter.vacuums[duid].features.hasDeviceStatusAttribute(
                  attribute
                );

              // A known attribute is skipped in silence. The line that used
              // to be written here dated from this library's ioBroker origins,
              // where `getObjectAsync` returns a state object that exists;
              // under Homebridge it never exists, so the branch fired for
              // EVERY known attribute on EVERY poll and said only that the
              // plugin is not ioBroker. Measured on three robots with debug
              // on: fifty lines a minute, and the log ring — the thing you
              // need when something real goes wrong — held ninety minutes.
              //
              // The distinction below is the part that carries information
              // and it is untouched: an attribute nobody has mapped yet is
              // still reported once, by name and value.
              if (
                !isKnownStatusAttribute &&
                this.rememberUnmappedStatusAttribute(duid, attribute)
              ) {
                newlyUnmappedAttributes.push(
                  `${attribute}=${describeStatusValue(deviceStatus[0][attribute])}`
                );
              } else if (!isKnownStatusAttribute) {
                this.adapter.log.debug(
                  `Unmapped get_status attribute ${attribute}=${describeStatusValue(deviceStatus[0][attribute])} for ${describeDevice(this.adapter, duid)}; already reported, not repeating.`
                );
              }
              continue; // skip unsupported attributes
            }

            const divider =
              this.adapter.vacuums[duid].features.getStatusDivider(attribute);
            if (divider) {
              deviceStatus[0][attribute] = Math.round(
                deviceStatus[0][attribute] / divider
              );
            }

            if (typeof deviceStatus[0][attribute] == "object") {
              deviceStatus[0][attribute] = JSON.stringify(
                deviceStatus[0][attribute]
              );
            }

            switch (attribute) {
              case "dock_type":
                this.adapter.vacuums[duid].features.processDockType(attribute);
                break;
              case "dss":
                await this.adapter.createDockingStationObject(duid);
                const dockingStationStatus =
                  await this.parseDockingStationStatus(
                    deviceStatus[0][attribute]
                  );

                for (const state in dockingStationStatus) {
                  this.adapter.setStateAsync(
                    `Devices.${duid}.dockingStationStatus.${state}`,
                    { val: parseInt(dockingStationStatus[state]), ack: true }
                  );
                }
                break;
              case "map_status": {
                deviceStatus[0][attribute] =
                  deviceStatus[0][attribute] >> 2 ?? -1; // to get the currently selected map perform bitwise right shift

                if (isCleaning) {
                  this.adapter.startMapUpdater(duid);
                } else if (!isCleaning) {
                  this.adapter.stopMapUpdater(duid);
                } else {
                  const mapCount = await this.adapter.getStateAsync(
                    `Devices.${duid}.floors.multi_map_count`
                  );

                  // don't process load_multi_map for single level configuration
                  if (mapCount) {
                    // sometimes mapCount is not available shortly after first start of adapter
                    if (mapCount.val > 1) {
                      const currentMap = deviceStatus[0][attribute];
                      const mapFromCommand = await this.adapter.getState(
                        `Devices.${duid}.commands.load_multi_map`
                      );

                      if (mapFromCommand && mapFromCommand.val != currentMap) {
                        await this.adapter.setStateAsync(
                          `Devices.${duid}.commands.load_multi_map`,
                          currentMap,
                          true
                        );
                      }
                    }
                  }
                }

                break;
              }
              case "state": {
                if (this.adapter.socket) {
                  const sendValue = {
                    duid: duid,
                    command: "get_status",
                    parameters: { isCleaning: isCleaning },
                  };
                  this.adapter.socket.send(JSON.stringify(sendValue));
                }

                break;
              }
              case "last_clean_t":
                deviceStatus[0][attribute] = new Date(
                  deviceStatus[0][attribute]
                ).toString();

                break;
            }
            this.adapter.setStateChangedAsync(
              `Devices.${duid}.deviceStatus.${attribute}`,
              { val: deviceStatus[0][attribute], ack: true }
            );
          }

          if (newlyUnmappedAttributes.length > 0) {
            this.adapter.log.warn(
              `${describeDevice(this.adapter, duid)} (${this.robotModel}) sends ${newlyUnmappedAttributes.length} get_status field(s) this plugin has no mapping for: ${newlyUnmappedAttributes.join(", ")}. Control, battery, rooms and state come from a model-agnostic path and do not depend on them, so nothing is broken — but a model report issue on GitHub quoting this line is how they get added. Logged once per field per robot, so it will not repeat.`
            );
          }

          this.adapter.manageDeviceIntervals(duid);
        }
      } else if (parameter == "get_room_mapping") {
        const deviceStatus = await sendParameterRequest("get_status", []);
        const mapStatus = Array.isArray(deviceStatus)
          ? deviceStatus[0]?.["map_status"]
          : undefined;
        // to get the currently selected map perform bitwise right shift
        const roomFloor = typeof mapStatus === "number" ? mapStatus >> 2 : -1;
        const mappedRooms = await sendParameterRequest("get_room_mapping", []);
        if (typeof this.adapter.updateRoomMappingCache === "function") {
          this.adapter.updateRoomMappingCache(duid, roomFloor, mappedRooms);
        }

        // if no rooms have been named, processing them can't work
        if (!Array.isArray(mappedRooms) || mappedRooms.length < 1) {
          this.adapter.log.info(
            `No room mappings returned for ${describeDevice(this.adapter, duid)}. Room-based controls will stay unavailable until the Roborock app exposes named rooms.`
          );
        } else {
          let unnamedRooms = 0;
          for (const mappedRoom of mappedRooms) {
            const roomID = mappedRoom[1];
            const roomName = this.adapter.roomIDs[roomID] || `Room ${roomID}`;

            if (!this.adapter.roomIDs[roomID]) {
              unnamedRooms++;
            }

            this.adapter.log.debug(
              `Mapped room matched: ${roomID} with name: ${roomName}`
            );
            const objectString = `Devices.${duid}.floors.${roomFloor}.${mappedRoom[0]}`;
            await this.adapter.createStateObjectHelper(
              objectString,
              roomName,
              "boolean",
              null,
              true,
              "value",
              true,
              true
            );
          }

          if (unnamedRooms > 0) {
            this.adapter.log.info(
              `${unnamedRooms} room(s) for ${describeDevice(this.adapter, duid)} were missing names from HomeData. Using fallback labels like 'Room <id>' until the Roborock app syncs names.`
            );
          }
        }

        const objectString = `Devices.${duid}.floors.cleanCount`;
        await this.adapter.createStateObjectHelper(
          objectString,
          "Clean count",
          "number",
          null,
          1,
          "value",
          true,
          true
        );

        return mappedRooms;
      } else if (parameter == "get_multi_maps_list") {
        const mapList = await sendParameterRequest("get_multi_maps_list", []);
        const mapInfo = mapList[0]?.map_info || [];
        const maps = {};

        if (typeof this.adapter.updateMapListCache === "function") {
          this.adapter.updateMapListCache(duid, mapInfo);
        }

        // Set states for numeric parameters
        for (const mapParameter in mapList[0] || {}) {
          if (typeof mapList[0][mapParameter] === "number") {
            const statePath = `Devices.${duid}.floors.${mapParameter}`;
            this.adapter.setStateAsync(statePath, {
              val: mapList[0][mapParameter],
              ack: true,
            });
          }
        }

        // Create map folders
        for (const map in mapInfo) {
          const roomFloor = mapInfo[map]["mapFlag"];
          const mapName = mapInfo[map]["name"];
          maps[roomFloor] = mapName;

          const objectPath = `Devices.${duid}.floors.${roomFloor}`;
          this.adapter.setObjectAsync(objectPath, {
            type: "folder",
            common: {
              name: mapName,
            },
            native: {},
          });
        }

        // Handle the load_multi_map command
        const commandPath = `Devices.${duid}.commands.load_multi_map`;
        if ((mapList[0]?.max_multi_map || 0) > 1) {
          await this.adapter.createStateObjectHelper(
            commandPath,
            "Load map",
            "number",
            null,
            0,
            "value",
            true,
            true,
            maps
          );
        } else {
          this.adapter.delObjectAsync(commandPath);
        }

        return mapInfo;
      } else if (parameter == "get_fw_features") {
        const firmwareFeatures = await sendParameterRequest(parameter, []);
        for (const firmwareFeature in firmwareFeatures) {
          const featureID = firmwareFeatures[firmwareFeature];

          const objectString = `Devices.${duid}.firmwareFeatures.${firmwareFeature}`;
          await this.adapter.createStateObjectHelper(
            objectString,
            featureID.toString(),
            "string",
            null,
            null,
            "value",
            true,
            false
          );

          const featureName =
            this.adapter.vacuums[duid].features.getFirmwareFeature(featureID);

          // this dynamically processes robot features by ID if they are supported
          if (
            typeof this.adapter.vacuums[duid].features[featureName] ===
            "function"
          ) {
            this.adapter.vacuums[duid].features[featureName]();
          }

          this.adapter.setStateAsync(objectString, {
            val: featureName,
            ack: true,
          });
        }
      } else if (parameter == "get_server_timer") {
        if (this.adapter.config.debug) {
          const serverTimers = await sendParameterRequest(parameter, []);
          await this.updateDiagnosticSnapshot(duid, "lastServerTimer", {
            method: parameter,
            response: serverTimers,
          });
          this.adapter.log.debug(
            `Roborock ${parameter} diagnostic for ${duid}: ${JSON.stringify(this.adapter.compactDiagnosticPayload(serverTimers))}`
          );
        }
      } else if (parameter == "get_timer") {
        if (this.adapter.config.debug) {
          const timers = await sendParameterRequest(parameter, []);
          await this.updateDiagnosticSnapshot(duid, "lastTimer", {
            method: parameter,
            response: timers,
          });
          this.adapter.log.debug(
            `Roborock ${parameter} diagnostic for ${duid}: ${JSON.stringify(this.adapter.compactDiagnosticPayload(timers))}`
          );
        }
      } else if (parameter == "get_photo") {
        const photoresponse = await sendParameterRequest(
          "get_photo",
          attribute,
          true,
          true
        );

        if (this.isGZIP(photoresponse)) {
          this.adapter.log.debug(`gzipped photo found.`);
          this.adapter.log.debug(JSON.stringify(photoresponse));

          this.unzipBuffer(photoresponse, (error, photoData) => {
            if (error) {
              this.adapter.catchError(
                error,
                "get_photo",
                duid,
                this.robotModel
              );

              if (
                this.adapter.supportsFeature &&
                this.adapter.supportsFeature("PLUGINS")
              ) {
                if (this.adapter.sentryInstance) {
                  this.adapter.sentryInstance
                    .getSentryObject()
                    .captureException(
                      `Failed to extract gzip: ${JSON.stringify(error)}`
                    );
                }
              }
            } else {
              const extractedPhoto = this.extractPhoto(photoData);

              if (extractedPhoto) {
                const photo = {};
                photo.duid = duid;
                photo.command = "get_photo";
                photo.image = `data:image/jpeg;base64,${extractedPhoto.toString("base64")}`;

                if (this.adapter.socket) {
                  this.adapter.socket.send(JSON.stringify(photo));
                }
              }
            }
          });
        }
      } else if (
        parameter == "get_dust_collection_switch_status" ||
        parameter == "get_wash_towel_mode" ||
        parameter == "get_smart_wash_params" ||
        parameter == "get_dust_collection_mode"
      ) {
        const attribute_val = JSON.stringify(
          await sendParameterRequest(parameter, {})
        );
        this.adapter.setStateAsync(
          `Devices.${duid}.commands.${parameter.replace("get", "set")}`,
          { val: attribute_val, ack: true }
        );
      } else if (parameter == "app_get_dryer_setting") {
        const attribute_val = await sendParameterRequest(parameter, {});
        const actualVal = JSON.stringify({
          on: { dry_time: attribute_val.on.dry_time },
          status: attribute_val.status,
        });
        this.adapter.setStateAsync(
          `Devices.${duid}.commands.${parameter.replace("get", "set")}`,
          { val: actualVal, ack: true }
        );
      } else if (this.parameterFolders[parameter]) {
        mode = parameter.substring(4);
        const attribute_val = await sendParameterRequest(parameter, []);

        if (typeof attribute_val[0] == "object") {
          attribute_val[0] = JSON.stringify(attribute_val[0]);
        }
        const targetFolder = this.parameterFolders[parameter];
        this.adapter.setStateAsync(`Devices.${duid}.${targetFolder}.${mode}`, {
          val: attribute_val[0],
          ack: true,
        });
      } else {
        // unknown parameter
        const unknown_parameter_val = await sendParameterRequest(parameter, []);

        // this.adapter.setStateAsync("Devices." + duid + "." + targetFolder + "." + mode, { val: attribute_val[0], ack: true });
        if (typeof unknown_parameter_val == "object") {
          if (typeof unknown_parameter_val[0] != "number") {
            this.adapter.catchError(
              `Unknown parameter: ${JSON.stringify(unknown_parameter_val)}`,
              parameter,
              duid,
              this.robotModel
            );
          }
        } else {
          this.adapter.catchError(
            `Unknown parameter: ${unknown_parameter_val}`,
            parameter,
            duid,
            this.robotModel
          );
        }
      }
    } catch (error) {
      if (
        this.adapter.rememberUnsupportedPollCommand?.(duid, parameter, error)
      ) {
        return;
      }
      this.adapter.catchError(error, parameter, duid, this.robotModel);
    }
  }

  async setUpObjects(duid) {
    await this.adapter.setObjectAsync("Devices." + duid, {
      type: "device",
      common: {
        name: this.adapter.vacuums[duid].name,
        statusStates: {
          onlineId: `${this.adapter.name}.${this.adapter.instance}.Devices.${duid}.deviceInfo.online`,
        },
      },
      native: {},
    });
  }

  async parseDockingStationStatus(dss) {
    return {
      cleanFluidStatus: (dss >> 10) & 0b11,
      waterBoxFilterStatus: (dss >> 8) & 0b11,
      dustBagStatus: (dss >> 6) & 0b11,
      dirtyWaterBoxStatus: (dss >> 4) & 0b11,
      clearWaterBoxStatus: (dss >> 2) & 0b11,
      isUpdownWaterReady: dss & 0b11,
    };
  }

  calculateCleaningValue(attribute, value) {
    switch (attribute) {
      case "clean_time":
        return Math.round(value / 60 / 60);
      case "clean_area":
        return Math.round(value / 1000 / 1000);
      default:
        return value;
    }
  }

  calculateRecordValue(attribute, value) {
    switch (attribute) {
      case "begin":
      case "end":
        return new Date(value * 1000).toString();
      case "duration":
        return Math.round(value / 60);
      case "area":
        return Math.round(value / 1000 / 1000);
      default:
        return value;
    }
  }

  unzipBuffer(buffer, callback) {
    zlib.gunzip(buffer, callback);
  }

  isGZIP(buffer) {
    return buffer.length >= 2 && buffer[0] == 31 && buffer[1] == 139;
  }
  extractPhoto(buffer) {
    // Verify that the buffer is long enough to hold the header
    if (buffer.length < 10) {
      return false;
    }

    // Check the signature
    if (
      buffer[26] == 74 &&
      buffer[27] == 70 &&
      buffer[28] == 73 &&
      buffer[29] == 70
    ) {
      return buffer.slice(20);
    } else if (
      buffer[42] == 74 &&
      buffer[43] == 70 &&
      buffer[44] == 73 &&
      buffer[45] == 70
    ) {
      return buffer.slice(36);
    }

    return false;
  }
}

module.exports = {
  vacuum,
};
