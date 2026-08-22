"use strict";

const errorCodes = {
  0: "No error",
  1: "Laser sensor fault",
  2: "Collision sensor fault",
  3: "Wheel floating",
  4: "Cliff sensor fault",
  5: "Main brush blocked",
  6: "Side brush blocked",
  7: "Wheel blocked",
  8: "Device stuck",
  9: "Dust bin missing",
  10: "Filter blocked",
  11: "Magnetic field detected",
  12: "Low battery",
  13: "Charging problem",
  14: "Battery failure",
  15: "Wall sensor fault",
  16: "Uneven surface",
  17: "Side brush failure",
  18: "Suction fan failure",
  19: "Unpowered charging station",
  20: "Unknown Error",
  21: "Laser pressure sensor problem",
  22: "Charge sensor problem",
  23: "Dock problem",
  24: "No-go zone or invisible wall detected",
  254: "Bin full",
  255: "Internal error",
  "-1": "Unknown Error",
};

const stateCodes = {
  0: "Unknown",
  1: "Initiating",
  2: "Sleeping",
  3: "Idle",
  4: "Remote Control",
  5: "Cleaning",
  6: "Returning Dock",
  7: "Manual Mode",
  8: "Charging",
  9: "Charging Error",
  10: "Paused",
  11: "Spot Cleaning",
  12: "In Error",
  13: "Shutting Down",
  14: "Updating",
  15: "Docking",
  16: "Go To",
  17: "Zone Clean",
  18: "Room Clean",
  22: "Empying dust container",
  23: "Washing the mop",
  26: "Going to wash the mop",
  28: "In call",
  29: "Mapping",
  100: "Fully Charged",
};

const dockTypes = {
  0: "Charging dock",
  1: "Auto-Empty Dock",
  2: "Empty Wash Fill Dock",
  3: "Empty Wash Fill (Dry) Dock",
  5: "Auto-Empty Dock (Q8 Max+)",
  7: "Empty Wash Fill Dry Dock (S8 Pro Ultra)",
  8: "Empty Wash Fill Dry Dock (Q Revo)",
  9: "Empty Wash Fill Dry Dock (Q Revo Pro)",
};

const firmwareFeatures = {
  111: "isSupportFDSEndPoint",
  112: "isSupportAutoSplitSegments",
  114: "isSupportOrderSegmentClean",
  116: "isMapSegmentSupported",
  119: "isSupportLedStatusSwitch",
  120: "isMultiFloorSupported",
  122: "isSupportFetchTimerSummary",
  123: "isOrderCleanSupported",
  125: "isRemoteSupported",
};

const commands = {
  app_start: { type: "boolean", defaultState: false },
  app_segment_clean: { type: "boolean", defaultState: false },
  app_stop: { type: "boolean", defaultState: false },
  app_pause: { type: "boolean", defaultState: false },
  app_charge: { type: "boolean", defaultState: false },
  app_spot: { type: "boolean", defaultState: false },
  app_zoned_clean: "json",
  resume_zoned_clean: { type: "boolean", defaultState: false },
  stop_zoned_clean: { type: "boolean", defaultState: false },
  resume_segment_clean: { type: "boolean", defaultState: false },
  stop_segment_clean: { type: "boolean", defaultState: false },
  set_custom_mode: {
    type: "number",
    defaultState: 102,
    states: {
      101: "Quiet",
      102: "Balanced",
      103: "Turbo",
      104: "Max",
      105: "Off",
    },
  },
  find_me: { type: "boolean", defaultState: false },
  app_goto_target: "json",
};

const deviceStates = {
  unsave_map_flag: "number",
  unsave_map_reason: "number",
  dock_error_status: "number",
  debug_mode: "number",
  auto_dust_collection: "number",
  dust_collection_status: "number",
  dock_type: { type: "number", states: dockTypes },
  adbumper_status: "string",
  lock_status: "number",
  is_locating: "number",
  map_status: "number",
  dnd_enabled: "number",
  lab_status: "number",
  in_fresh_state: "number",
  in_returning: "number",
  in_cleaning: "number",
  map_present: "number",
  error_code: { type: "number", states: errorCodes },
  clean_area: { type: "number", unit: "m²", divider: 1000000 },
  clean_time: { type: "number", unit: "min", divider: 60 },
  battery: { type: "number", unit: "%" },
  state: { type: "number", states: stateCodes },
  msg_seq: "number",
  msg_ver: "number",
  fan_power: {
    type: "number",
    name: "Fan power",
    states: {
      101: "Quiet",
      102: "Balanced",
      103: "Turbo",
      104: "Max",
      105: "Off",
    },
  },
  is_exploring: "number",
  events: "string",
  subdivision_sets: "number",
  repeat: "number",
  replenish_mode: "number",
  rdt: "number",
  camera_status: "number",
  distance_off: "number",
  // Reported by the Saros 10 (roborock.vacuum.a144) and siblings. Added from
  // skmzwanke's field report in issue #8, which is exactly the round trip the
  // "no mapping for" log line asks for: 3.4.3 named the nine fields once, he
  // pasted the line, and they are now known.
  //
  // None of them drive behaviour — control, battery, rooms and state come
  // from a model-agnostic path — so mapping them is about not pestering the
  // owner of a brand-new model about fields the plugin simply had not met
  // yet.
  home_sec_status: "number",
  home_sec_enable_password: "number",
  voice_chat_status: "number",
  sterilize_status: "number",
  exit_dock: "number",
  extra_time: "number",
  seq_type: "number",
  rst: "number",
  // An object: {target_segment_id, segment_id, fan_power, water_box_mode, ...}
  // — the same convention as adbumper_status and events, which are also
  // non-scalar.
  cleaning_info: "string",
};

// Shared shape for the work-time consumables that both consumablesInt and
// consumablesString track identically.
const workTimeConsumable = {
  type: "number",
  unit: "h",
  divider: 60 * 60,
  write: false,
};
const sharedWorkTimeConsumables = {
  main_brush_work_time: { ...workTimeConsumable },
  side_brush_work_time: { ...workTimeConsumable },
  filter_work_time: { ...workTimeConsumable },
  filter_element_work_time: { ...workTimeConsumable },
  sensor_dirty_time: { ...workTimeConsumable },
  dust_collection_work_times: { ...workTimeConsumable },
};

const consumablesInt = {
  ...sharedWorkTimeConsumables,
  125: { type: "number", unit: "%", divider: 60 * 60, write: false },
  126: { type: "number", unit: "%", divider: 60 * 60, write: false },
  127: { type: "number", unit: "%", divider: 60 * 60, write: false },
};
const consumablesString = {
  ...sharedWorkTimeConsumables,
  main_brush_life: {
    type: "number",
    unit: "%",
    divider: 60 * 60,
    write: false,
  },
  side_brush_life: {
    type: "number",
    unit: "%",
    divider: 60 * 60,
    write: false,
  },
  filter_life: { type: "number", unit: "%", divider: 60 * 60, write: false },
};

const resetConsumables = [
  "main_brush_work_time",
  "side_brush_work_time",
  "filter_work_time",
  "filter_element_work_time",
  "sensor_dirty_time",
  "dust_collection_work_times",
];

const cleaningRecordsInt = {
  0: { type: "string", name: "cleaningRecord_begin" },
  1: { type: "string", name: "cleaningRecord_end" },
  2: { type: "number", name: "cleaningRecord_duration", unit: "min" },
  3: { type: "number", name: "cleaningRecord_area", unit: "m²" },
  4: { type: "number", name: "cleaningRecord_error" },
  5: { type: "number", name: "cleaningRecord_complete" },
  6: { type: "number", name: "cleaningRecord_start_type" },
  7: { type: "number", name: "cleaningRecord_finish_reason" },
  8: { type: "number", name: "cleaningRecord_dust_collection_status" },
};
const cleaningRecordsString = {
  begin: { type: "string", name: "cleaningRecord_begin" },
  end: { type: "string", name: "cleaningRecord_end" },
  duration: { type: "number", name: "cleaningRecord_duration", unit: "min" },
  area: { type: "number", name: "cleaningRecord_area", unit: "m²" },
  error: { type: "number", name: "cleaningRecord_error" },
  complete: { type: "number", name: "cleaningRecord_complete" },
  start_type: { type: "number", name: "cleaningRecord_start_type" },
  clean_type: { type: "number", name: "cleaningRecord_clean_type" },
  finish_reason: { type: "number", name: "cleaningRecord_finish_reason" },
  dust_collection_status: {
    type: "number",
    name: "cleaningRecord_dust_collection_status",
  },
  manual_replenish: { type: "number", name: "cleaningRecord_manual_replenish" },
  dirty_replenish: { type: "number", name: "cleaningRecord_dirty_replenish" },
  clean_times: { type: "number", name: "cleaningRecord_clean_times" },
};

const cleaningInfoInt = {
  0: { name: "cleaningInfo_clean_time", type: "number", unit: "h" },
  1: { name: "cleaningInfo_clean_area", type: "number", unit: "m²" },
  2: { name: "cleaningInfo_clean_count", type: "number" },
};
const cleaningInfoString = {
  clean_time: { name: "cleaningInfo_clean_time", type: "number", unit: "h" },
  clean_area: { name: "cleaningInfo_clean_area", type: "number", unit: "m²" },
  clean_count: { name: "cleaningInfo_clean_count", type: "number" },
  dust_collection_count: {
    name: "cleaningInfo_dust_collection_count",
    type: "number",
  },
};

// Every action below is invoked as `action(this)` from processSupportedFeatures,
// so `context` is the deviceFeatures instance being set up. They must write to
// the instance's own tables, never to the module-level baselines above — see
// the note in the constructor.
const actions = {
  setConsumablesInt: async (context) => {
    context.consumables = context.consumablesInt;
  },
  setConsumablesString: async (context) => {
    context.consumables = context.consumablesString;
  },
  setCleaningRecordsInt: async (context) => {
    context.cleaningRecords = context.cleaningRecordsInt;
    context.cleaningInfo = context.cleaningInfoInt;
  },
  setCleaningRecordsString: async (context) => {
    context.cleaningRecords = context.cleaningRecordsString;
    context.cleaningInfo = context.cleaningInfoString;
  },
  setCleaningRecordsMixed: async (context) => {
    // this is a special case some olders robots
    context.cleaningRecords = context.cleaningRecordsString;
    context.cleaningInfo = context.cleaningInfoInt;
  },
  set_charge_status: async (context) => {
    context.deviceStates.charge_status = "number";
  },
  set_clean_percent: async (context) => {
    context.deviceStates.clean_percent = "number";
  },
  set_common_status: (context) => {
    context.deviceStates.common_status = "number";
  },
  set_rss: (context) => {
    context.deviceStates.rss = "number";
  },
  set_dss: (context) => {
    context.deviceStates.dss = "number";
  },
  set_kct: (context) => {
    context.deviceStates.kct = "number";
  },
  set_in_warmup: (context) => {
    context.deviceStates.in_warmup = "number";
  },
  set_last_clean_t: (context) => {
    context.deviceStates.last_clean_t = "string";
  },
  set_wash_count: (context) => {
    context.cleaningRecordsString.wash_count = {
      type: "number",
      name: "cleaning_record_wash_count",
    };
  },
  set_map_flag: (context) => {
    context.deviceStates.map_flag = "number";
    context.cleaningRecords.map_flag = {
      type: "number",
      name: "cleaningRecord_map_flag",
    };
  },
  set_back_type: (context) => {
    context.deviceStates.back_type = "number";
  },
  set_rdt: (context) => {
    context.deviceStates.rdt = "number";
  },
  set_replenish_mode: (context) => {
    context.cleaningRecordsString.manual_replenish = {
      type: "number",
      name: "cleaning_record_manual_replenish",
    };
    context.cleaningRecordsString.dirty_replenish = {
      type: "number",
      name: "cleaning_record_dirty_replenish",
    };
    context.deviceStates.replenish_mode = "number";
  },
  set_repeat: (context) => {
    context.deviceStates.repeat = "number";
  },
  set_cleaned_area: (context) => {
    context.cleaningRecordsString.cleaned_area = {
      type: "number",
      name: "cleaning_record_cleaned_area",
      unit: "m²",
      divider: 1000000,
    };
  },
  set_clean_times: (context) => {
    context.cleaningRecordsString.clean_times = {
      type: "number",
      name: "cleaning_record_clean_times",
    };
  },
  set_switch_status: (context) => {
    context.deviceStates.switch_status = "number";
  },
  set_task_id: (context) => {
    context.cleaningRecordsString.task_id = {
      type: "number",
      name: "cleaning_record_task_id",
    };
  },
  set_monitor_status: (context) => {
    context.deviceStates.monitor_status = "number";
  },
  set_clean_fluid: (context) => {
    context.deviceStates.clean_fluid = "number";
  },
};

class deviceFeatures {
  constructor(adapter, features, featuresStr, duid) {
    this.adapter = adapter;
    this.features = features;
    this.featuresStr = featuresStr;
    this.duid = duid;
    this.cleaningInfo = {};
    this.cleaningRecords = {};
    this.consumables = {};

    // Capability detection writes into these tables, so every instance needs
    // its own copies and the module-level tables above stay pristine
    // baselines. createDevices() walks the robots sequentially through this
    // one shared module, so writing to the module tables handed robot N
    // everything robots 1..N-1 had switched on: an S4 Max set up after an
    // S8 Pro Ultra was given app_start_collect_dust and friends despite
    // having no auto-empty dock. It is not only a setup-time concern either —
    // vacuum.js calls hasDeviceStatusAttribute()/getStatusDivider() on every
    // get_status poll and processDockType() can re-run capability detection,
    // so shared tables made a robot's runtime behaviour depend on which robot
    // was set up last.
    //
    // A shallow copy is enough: the nested descriptor objects ({ type,
    // states, unit, divider }) are only ever read or replaced wholesale,
    // never mutated in place.
    this.commands = { ...commands };
    this.deviceStates = { ...deviceStates };
    this.resetConsumables = [...resetConsumables];
    this.consumablesInt = { ...consumablesInt };
    this.consumablesString = { ...consumablesString };
    this.cleaningRecordsInt = { ...cleaningRecordsInt };
    this.cleaningRecordsString = { ...cleaningRecordsString };
    this.cleaningInfoInt = { ...cleaningInfoInt };
    this.cleaningInfoString = { ...cleaningInfoString };
  }

  isWashThenChargeCmdSupported() {
    this.commands.app_start_wash = { type: "boolean", defaultState: false };
    this.commands.app_stop_wash = { type: "boolean", defaultState: false };

    this.cleaningRecords.wash_count = {
      type: "number",
      name: "cleaning_record_wash_count",
    };

    this.commands.set_wash_towel_mode = {
      type: "json",
      defaultState: '{"wash_mode":2}',
      states: {
        '{"wash_mode":0}': "Eco",
        '{"wash_mode":1}': "Medium",
        '{"wash_mode":2}': "Intense",
      },
    };
    this.commands.set_smart_wash_params = {
      type: "json",
      defaultState: '{"smart_wash":0,"wash_interval":1800}',
      states: {
        '{"smart_wash":0,"wash_interval":600}': "10 Min",
        '{"smart_wash":0,"wash_interval":900}': "15 Min",
        '{"smart_wash":0,"wash_interval":1200}': "20 Min",
        '{"smart_wash":0,"wash_interval":1500}': "25 Min",
        '{"smart_wash":0,"wash_interval":1800}': "30 Min",
        '{"smart_wash":0,"wash_interval":2100}': "35 Min",
        '{"smart_wash":0,"wash_interval":2400}': "40 Min",
        '{"smart_wash":0,"wash_interval":2700}': "45 Min",
        '{"smart_wash":0,"wash_interval":3000}': "50 Min",
        '{"smart_wash":1,"wash_interval":1200}': "Per room",
      },
    };
    this.deviceStates.wash_phase = "number";
    this.deviceStates.wash_ready = "number";
    this.deviceStates.back_type = "number";
    this.deviceStates.wash_status = "number";

    this.consumablesString.strainer_work_times = {
      type: "number",
      unit: null,
      divider: null,
    };
    this.consumablesString.cleaning_brush_work_times = {
      type: "number",
      unit: null,
      divider: null,
    };

    this.resetConsumables.push("strainer_work_times");
    this.resetConsumables.push("cleaning_brush_work_times");
  }

  isDustCollectionSettingSupported() {
    this.commands.app_start_collect_dust = {
      type: "boolean",
      defaultState: false,
    };
    this.commands.app_stop_collect_dust = {
      type: "boolean",
      defaultState: false,
    };
    this.commands.set_dust_collection_switch_status = {
      type: "json",
      defaultState: '{"status":1}',
      states: { '{"status":0}': "Off", '{"status":1}': "On" },
    };
    this.commands.set_dust_collection_mode = {
      type: "json",
      defaultState: '{"mode":0}',
      states: {
        '{"mode":0}': "Smart",
        '{"mode":1}': "Low",
        '{"mode":2}': "Medium",
        '{"mode":4}': "Max",
      },
    };
  }

  isSupportedDrying() {
    this.commands.app_set_dryer_status = {
      type: "string",
      defaultState: '{"status": 0}',
      states: { '{"status": 1}': "On", '{"status": 0}': "Off" },
    };
    this.commands.app_set_dryer_setting = {
      type: "json",
      defaultState: '{"on":{"dry_time":10800},"status":0}',
      states: {
        '{"on":{"dry_time":10800},"status":0}': "Off",
        '{"on":{"dry_time":7200},"status":1}': "2h",
        '{"on":{"dry_time":10800},"status":1}': "3h",
        '{"on":{"dry_time":14400},"status":1}': "4h",
      },
    };

    this.deviceStates.dry_status = "number";
  }

  isSupportedWaterMode() {
    this.commands.set_mop_mode = {
      type: "number",
      defaultState: 300,
      states: { 300: "Standard", 301: "Deep", 303: "Deep+" },
    };
    this.commands.set_water_box_custom_mode = {
      type: "number",
      defaultState: 201,
      states: { 200: "Off", 201: "Mild", 202: "Moderate", 203: "Intense" },
    };

    this.deviceStates.water_box_custom_mode = {
      type: "number",
      states: { 200: "Off", 201: "Mild", 202: "Moderate", 203: "Intense" },
    };
  }

  isShakeMopSetSupported() {
    this.isSupportedWaterMode();
  }

  isElectronicWaterBoxSupported() {
    this.isSupportedWaterMode();
  }

  isCarpetSupported() {
    // nothing for now
  }

  isCleanRouteFastModeSupported() {
    this.commands.set_mop_mode = {
      type: "number",
      defaultState: 300,
      states: { 300: "Standard", 301: "Deep", 303: "Deep+", 304: "Fast" },
    };
    this.deviceStates.mop_mode = {
      type: "number",
      states: { 300: "Standard", 301: "Deep", 303: "Deep+", 304: "Fast" },
    };
  }

  isAvoidCollisionSupported() {
    this.deviceStates.collision_avoid_status = "number";
    this.deviceStates.avoid_count = "number";

    this.cleaningRecords.avoid_count = {
      type: "number",
      name: "cleaning_record_avoid_count",
    };
  }

  isCornerCleanModeSupported() {
    this.deviceStates.corner_clean_mode = "number";
  }

  isCameraSupported() {
    this.deviceStates.distance_off = "number";
    this.deviceStates.camera_status = "number";
  }

  isVideoLiveCallSupported() {
    this.deviceStates.home_sec_enable_password = "number";
    this.deviceStates.home_sec_status = "number";
    const ip = this.adapter.config.hostname_ip;
    const streamTypes = {
      stream_html: `http://${ip}:1984/stream.html?src=${this.duid}`,
      webrtc_html: `http://${ip}:1984/webrtc.html?src=${this.duid}&media=video`,
      stream_mp4: `http://${ip}:1984/api/stream.mp4?src=${this.duid}`,
      rtsp: `rtsp://${ip}:8554/${this.duid}?video`,
    };

    for (const [name, stream_uri] of Object.entries(streamTypes)) {
      this.adapter.setObjectAsync(`Devices.${this.duid}.camera.${name}`, {
        type: "state",
        common: {
          name: name,
          type: "string",
          role: "value",
          read: true,
          write: false,
          def: stream_uri,
        },
        native: {},
      });
    }
  }

  isVoiceControlSupported() {
    this.deviceStates.voice_chat_status = "number";
  }

  isSupportSetSwitchMapMode() {
    this.deviceStates.switch_map_mode = "number";
  }

  isMopForbiddenSupported() {
    this.deviceStates.mop_forbidden_enable = "number";
  }

  isShakeMopStrengthSupported() {
    this.isSupportedWaterMode();
  }

  isWaterBoxSupported() {
    this.deviceStates.water_box_carriage_status = "number";
    this.deviceStates.water_box_mode = {
      type: "number",
      states: { 200: "Off", 201: "Mild", 202: "Moderate", 203: "Intense" },
    };
    this.deviceStates.water_box_status = "number";
    this.deviceStates.water_shortage_status = "number";

    this.deviceStates.mop_mode = {
      type: "number",
      states: { 300: "Standard", 301: "Deep", 303: "Deep+" },
    };
  }

  isCustomWaterBoxDistanceSupported() {
    // in this special case, create the command directly instead of the usual way
    this.adapter.setObjectAsync(
      `Devices.${this.duid}.commands.set_water_box_distance_off`,
      {
        type: "state",
        common: {
          name: this.adapter.translations.set_water_box_distance_off,
          type: "number",
          role: "value",
          read: true,
          write: true,
          def: 1,
          min: 1,
          max: 30,
        },
        native: {},
      }
    );
  }

  isBackChargeAutoWashSupported() {
    // this means the robot can stay reversed into the dock and still charge
    // nothing for now
  }

  isAvoidCarpetSupported() {
    this.deviceStates.carpet_mode = {
      type: "string",
      states: {
        '[{"enable":0,"stall_time":10,"current_low":400,"current_high":500,"current_integral":450}]':
          "off",
        '[{"enable":1,"stall_time":10,"current_low":400,"current_high":500,"current_integral":450}]':
          "on",
      },
    };
    this.deviceStates.carpet_clean_mode = {
      type: "string",
      states: {
        '{"carpet_clean_mode":0}': "Avoid",
        '{"carpet_clean_mode":1}': "Rise",
        '{"carpet_clean_mode":2}': "Ignore",
      },
    };
  }

  // the functions below are used for processing the firmware features from get_fw_features
  isSupportFDSEndPoint() {
    // nothing for now
  }
  isSupportAutoSplitSegments() {
    // nothing for now
  }
  isSupportOrderSegmentClean() {
    // nothing for now
  }
  isMapSegmentSupported() {
    // nothing for now
  }
  isSupportLedStatusSwitch() {
    // nothing for now
  }
  isMultiFloorSupported() {
    const features = ["max_multi_map", "max_bak_map", "multi_map_count"];

    for (const [, feature] of Object.entries(features)) {
      this.adapter.setObjectAsync(`Devices.${this.duid}.floors.${feature}`, {
        type: "state",
        common: {
          name: feature,
          type: "number",
          role: "value",
          read: true,
          write: false,
        },
        native: {},
      });
    }
  }
  isSupportFetchTimerSummary() {
    // nothing for now
  }
  isOrderCleanSupported() {
    // nothing for now
  }
  isRemoteSupported() {
    // nothing for now
  }

  getFeatureList() {
    const robotModel = this.adapter.getProductAttribute(this.duid, "model");

    return {
      isWashThenChargeCmdSupported:
        ((this.features / Math.pow(2, 32)) >> 5) & 1,
      isDustCollectionSettingSupported: !!(33554432 & this.features),
      isSupportedDrying: ((this.features / Math.pow(2, 32)) >> 15) & 1,
      isShakeMopSetSupported: !!(262144 & this.features),
      isVideoMonitorSupported: !!(8 & this.features), // I tested this for S7 MaxV, S8 MaxV
      isVideoSettingSupported: !!(64 & this.features), // I tested this for S7 MaxV, S8 MaxV
      isCarpetSupported: !!(512 & this.features),
      isPhotoUploadSupported: !!(65536 & this.features),
      isAvoidCollisionSupported: !!(134217728 & this.features),
      isCornerCleanModeSupported: !!(2147483648 & this.features),
      // isCameraSupported: [p.Products.TanosV_CN, p.Products.TanosV_CE, p.Products.TopazSV_CN, p.Products.TopazSV_CE, p.Products.TanosSV].hasElement(p.DMM.currentProduct),
      isCameraSupported: !![
        "roborock.vacuum.a10",
        "roborock.vacuum.a27",
        "roborock.vacuum.a51",
        "roborock.vacuum.a87",
      ].includes(robotModel),
      isSupportSetSwitchMapMode: !!(268435456 & this.features),
      // isMopForbiddenSupported: !!(p.DMM.isTanosV || p.DMM.isTanos || p.DMM.isTopazSV || p.DMM.isPearlPlus) || !![p.Products.TanosE, p.Products.TanosSL, p.Products.TanosS, p.Products.TanosSPlus, p.Products.TanosSMax, p.Products.Ultron, p.Products.UltronLite, p.Products.Pearl, p.Products.RubysLite].hasElement(p.DMM.currentProduct),
      isMopForbiddenSupported: [
        "roborock.vacuum.s6", // S6
        "roborock.vacuum.a10", // S6 MaxV
        "roborock.vacuum.a40", // Q7
        "roborock.vacuum.s5e", // S5 Max
        "roborock.vacuum.a38", // Q7 Max
        "roborock.vacuum.a72", // Q5 Pro
        "roborock.vacuum.a73", // Q8 Max
        "roborock.vacuum.a75", // Q Revo
        "roborock.vacuum.a15", // S7
        "roborock.vacuum.a51", // S8
        "roborock.vacuum.a70", // S8 Pro Ultra
        "roborock.vacuum.a62", // S7 Pro Ultra
        "roborock.vacuum.a65", // S7 Max Ultra
        "roborock.vacuum.a27", // S7 MaxV (Ultra)
        "roborock.vacuum.a87", // Qrevo MaxV
        "roborock.vacuum.a101", // Q Revo Pro
        "roborock.vacuum.a97", // S8 MaxV (Ultra)
        "roborock.vacuum.a104", // Roborock Qrevo S
        "roborock.vacuum.a135", // Qrevo Curv
        "roborock.vacuum.a117", // Qrevo Master
        "roborock.vacuum.a21", // Qrevo Slim
        "roborock.vacuum.a144", // Saros 10R
        "roborock.vacuum.a147", // Saros 10
        "roborock.vacuum.a140",
        "roborock.vacuum.a95",
        "roborock.vacuum.a159",
        "roborock.vacuum.ss07",
      ].includes(robotModel),
      // isShakeMopStrengthSupported: p.DMM.currentProduct == p.Products.TanosS || p.DMM.currentProduct == p.Products.TanosSPlus || p.DMM.isGarnet || p.DMM.isTopazSV || p.DMM.isPearlPlus || p.DMM.isCoral || p.DMM.isTopazS || p.DMM.isTopazSPlus || p.DMM.isTopazSC || p.DMM.isTopazSV || p.DMM.isPearlPlus || p.DMM.isTanosSMax || p.DMM.isUltron || p.DMM.isUltronSPlus || p.DMM.isUltronSMop || p.DMM.isUltronSV || p.DMM.isPearl
      isShakeMopStrengthSupported: [
        "roborock.vacuum.a08", // S6 Pure
        "roborock.vacuum.a10", // S6 MaxV
        "roborock.vacuum.a62", // S7 Pro Ultra
        "roborock.vacuum.a51", // S8
        "roborock.vacuum.a15", // S7
        "roborock.vacuum.a27", // S7 MaxV (Ultra)
        "roborock.vacuum.a19", // S4 Max
        "roborock.vacuum.a40", // Q7
        "roborock.vacuum.a65", // S7 Max Ultra
        "roborock.vacuum.a38", // Q7 Max
        "roborock.vacuum.a73", // Q8 Max
        "roborock.vacuum.a75", // Q Revo
        "roborock.vacuum.a70", // S8 Pro Ultra
        "roborock.vacuum.s5e", // S5 Max
        "roborock.vacuum.a87", // Qrevo MaxV
        "roborock.vacuum.a101", // Q Revo Pro
        "roborock.vacuum.a144", // Saros 10R
        "roborock.vacuum.a147", // Saros 10
        "roborock.vacuum.a140",
        "roborock.vacuum.a95",
        "roborock.vacuum.a159",
        "roborock.vacuum.ss07",
      ].includes(robotModel),
      // isWaterBoxSupported: [p.Products.Tanos_CE, p.Products.Tanos_CN].hasElement(p.DMM.currentProduct)
      isWaterBoxSupported: [
        "roborock.vacuum.s5e", // S5 Max
        "roborock.vacuum.s6", // S6
        "roborock.vacuum.a08", // S6 Pure
        "roborock.vacuum.a10", // S6 MaxV
        "roborock.vacuum.a15", // S7
        "roborock.vacuum.a27", // S7 MaxV (Ultra)
        "roborock.vacuum.a38", // Q7 Max
        "roborock.vacuum.a40", // Q7
        "roborock.vacuum.a51", // S8
        "roborock.vacuum.a62", // S7 Pro Ultra
        "roborock.vacuum.a65", // S7 Max Ultra
        "roborock.vacuum.a70", // S8 Pro Ultra
        "roborock.vacuum.a72", // Q5 Pro
        "roborock.vacuum.a73", // Q8 Max
        "roborock.vacuum.a75", // Q Revo
        "roborock.vacuum.a87", // Qrevo MaxV
        "roborock.vacuum.a101", // Q Revo Pro
        "roborock.vacuum.a97", // S8 MaxV (Ultra)
        "roborock.vacuum.a104", // Roborock Qrevo S
        "roborock.vacuum.a135", // Qrevo Curv
        "roborock.vacuum.a117", // Qrevo Master
        "roborock.vacuum.a21", // Qrevo Slim
        "roborock.vacuum.a144", // Saros 10R
        "roborock.vacuum.a147", // Saros 10
        "roborock.vacuum.a140",
        "roborock.vacuum.a95",
        "roborock.vacuum.a159",
        "roborock.vacuum.ss07",
      ].includes(robotModel),
      isCustomWaterBoxDistanceSupported: !!(2147483648 & this.features),
      isBackChargeAutoWashSupported:
        this.featuresStr &&
        !!(4096 & parseInt("0x" + this.featuresStr.slice(-8))),
      isAvoidCarpetSupported: [
        "roborock.vacuum.a10", // S6 MaxV
        "roborock.vacuum.a40", // Q7
        "roborock.vacuum.s6", // S6
        "roborock.vacuum.a73", // Q8 Max
        "roborock.vacuum.a38", // Q7 Max
        "roborock.vacuum.a51", // S8
        "roborock.vacuum.a75", // Q Revo
        "roborock.vacuum.a27", // S7 MaxV (Ultra)
        "roborock.vacuum.a15", // S7
        "roborock.vacuum.a70", // S8 Pro Ultra
        "roborock.vacuum.a62", // S7 Pro Ultra
        "roborock.vacuum.a65", // S7 Max Ultra
        "roborock.vacuum.a87", // Qrevo MaxV
        "roborock.vacuum.a101", // Q Revo Pro
        "roborock.vacuum.a97", // S8 MaxV (Ultra)
        "roborock.vacuum.a104", // Roborock Qrevo S
        "roborock.vacuum.a135", // Qrevo Curv
        "roborock.vacuum.a117", // Qrevo Master
        "roborock.vacuum.a144", // Saros 10R
        "roborock.vacuum.a147", // Saros 10
        "roborock.vacuum.a140",
        "roborock.vacuum.a95",
        "roborock.vacuum.a159",
        "roborock.vacuum.ss07",
      ].includes(robotModel),
      // this isn't the correct way to use this. This code must be from a different robot
      // isVoiceControlSupported: !!(parseInt(`0x${this.featuresStr || "0"}`.slice(-10, -9)) & 2),
      // These two were written as bare arrays while every other model list in
      // this object ends in `.includes(robotModel)`. An array is truthy in JS
      // — an EMPTY array included — and the gate below is
      // `if (featureList[feature])`, so both were unconditionally true for
      // every robot. isElectronicWaterBoxSupported feeds isSupportedWaterMode,
      // which is what makes canMop and canControlWater true, so Apple Home
      // offered Mop and Vacuum + Mop plus a water-level control on dry-only
      // robots (S4, S4 Max, S5, S6 Pure) and fired set_water_box_custom_mode
      // at hardware with no tank. The three model allowlists above exist
      // precisely to prevent that.
      isVoiceControlSupported: [
        "roborock.vacuum.a27", // S7 MaxV (Ultra)
      ].includes(robotModel),
      // No model is known to need this yet. Add models to the array and keep
      // the .includes(robotModel) call if that changes.
      isElectronicWaterBoxSupported: [].includes(robotModel),
      isCleanRouteFastModeSupported:
        this.featuresStr &&
        !!(256 & parseInt("0x" + this.featuresStr.slice(-8))),
      isVideoLiveCallSupported: [
        "roborock.vacuum.a10", // S6 MaxV
        "roborock.vacuum.a27", // S7 MaxV (Ultra)
        "roborock.vacuum.a97", // S8 MaxV (Ultra)
        "roborock.vacuum.a87", // Qrevo MaxV
        "roborock.vacuum.a135", // Qrevo Curv
        "roborock.vacuum.a117", // Qrevo Master
        "roborock.vacuum.a21", // Qrevo Slim
      ].includes(robotModel),
    };
  }

  async processSupportedFeatures() {
    const robotModel = this.adapter.getProductAttribute(this.duid, "model");
    const productCategory = this.adapter.getProductAttribute(
      this.duid,
      "category"
    );

    if (productCategory == "robot.vacuum.cleaner") {
      // Shared action list for models with identical processSupportedFeatures config
      // (Saros 10, and related a140/a95/a159/ss07 models)
      const saros10ActionSet = [
        "setCleaningRecordsString",
        "setConsumablesInt",
        "set_common_status",
        "set_dss",
        "set_rss",
        "set_kct",
        "set_in_warmup",
        "set_last_clean_t",
        "set_map_flag",
        "set_back_type",
        "set_charge_status",
        "set_clean_percent",
        "set_cleaned_area",
        "set_switch_status",
      ];

      // process states etc. depending on model
      const modelConfig = {
        // S6 Pure
        "roborock.vacuum.a08": ["setCleaningRecordsMixed", "setConsumablesInt"],
        // S6 MaxV
        "roborock.vacuum.a10": ["setCleaningRecordsMixed", "setConsumablesInt"],
        // S7
        "roborock.vacuum.a15": [
          "setCleaningRecordsString",
          "setConsumablesInt",
        ],
        // S7 MaxV (Ultra)
        "roborock.vacuum.a27": [
          "setCleaningRecordsString",
          "setConsumablesInt",
          "set_map_flag",
          "set_back_type",
          "set_charge_status",
          "set_clean_percent",
          "set_switch_status",
        ],
        // Q7 Max
        "roborock.vacuum.a38": [
          "setCleaningRecordsString",
          "setConsumablesInt",
          "set_map_flag",
          "set_charge_status",
        ],
        // Q7
        "roborock.vacuum.a40": [
          "setCleaningRecordsString",
          "setConsumablesInt",
          "set_map_flag",
          "set_charge_status",
        ],
        // S8
        "roborock.vacuum.a51": [
          "setCleaningRecordsString",
          "setConsumablesInt",
          "set_dss",
          "set_rss",
          "set_last_clean_t",
          "set_map_flag",
          "set_charge_status",
          "set_clean_percent",
          "set_switch_status",
          "set_cleaned_area",
        ],
        // S7 Pro Ultra
        "roborock.vacuum.a62": [
          "setCleaningRecordsString",
          "setConsumablesInt",
          "set_dss",
          "set_rss",
          "set_map_flag",
          "set_charge_status",
          "set_clean_percent",
        ],
        // S7 Max Ultra
        "roborock.vacuum.a65": [
          "setCleaningRecordsString",
          "setConsumablesInt",
          "set_dss",
          "set_rss",
          "set_map_flag",
          "set_back_type",
          "set_charge_status",
          "set_clean_percent",
          "set_switch_status",
          "set_clean_fluid",
          "set_cleaned_area",
        ],
        // S8 Pro Ultra
        "roborock.vacuum.a70": [
          "setCleaningRecordsString",
          "setConsumablesInt",
          "set_common_status",
          "set_dss",
          "set_rss",
          "set_last_clean_t",
          "set_map_flag",
          "set_back_type",
          "set_charge_status",
          "set_switch_status",
          "set_clean_percent",
          "set_custom_mode_max_plus",
        ],
        // Q5 Pro
        "roborock.vacuum.a72": [
          "setCleaningRecordsString",
          "setConsumablesInt",
          "set_dss",
          "set_rss",
          "set_last_clean_t",
          "set_map_flag",
          "set_back_type",
          "set_charge_status",
          "set_clean_percent",
          "set_cleaned_area",
          "set_switch_status",
          "set_common_status",
          "set_in_warmup",
        ],
        // Q5 Max+
        "roborock.vacuum.a125": [
          "setCleaningRecordsInt",
          "setConsumablesString",
        ],
        // S4 Max
        "roborock.vacuum.a19": ["setCleaningRecordsInt", "setConsumablesInt"],
        // Q8 Max
        "roborock.vacuum.a73": [
          "setCleaningRecordsString",
          "setConsumablesInt",
          "set_common_status",
          "set_dss",
          "set_rss",
          "set_in_warmup",
          "set_last_clean_t",
          "set_map_flag",
          "set_charge_status",
          "set_clean_percent",
          "set_switch_status",
        ],
        // Q Revo
        "roborock.vacuum.a75": [
          "setCleaningRecordsString",
          "setConsumablesInt",
          "set_common_status",
          "set_dss",
          "set_rss",
          "set_kct",
          "set_in_warmup",
          "set_last_clean_t",
          "set_map_flag",
          "set_back_type",
          "set_charge_status",
          "set_clean_percent",
          "set_rdt",
          "set_switch_status",
          "set_cleaned_area",
        ],
        // S5 Max
        "roborock.vacuum.s5e": ["setCleaningRecordsMixed", "setConsumablesInt"],
        // S6
        "roborock.vacuum.s6": [
          "setCleaningRecordsMixed",
          "setConsumablesString",
        ],
        // Qrevo MaxV
        "roborock.vacuum.a87": [
          "setCleaningRecordsString",
          "setConsumablesInt",
          "set_in_warmup",
          "set_charge_status",
          "set_clean_percent",
          "set_rss",
          "set_common_status",
          "set_last_clean_t",
          "set_kct",
          "set_map_flag",
          "set_replenish_mode",
          "set_repeat",
          "set_rdt",
          "set_cleaned_area",
          "set_clean_times",
          "set_switch_status",
        ],
        // Q Revo Pro
        "roborock.vacuum.a101": [
          "setCleaningRecordsString",
          "setConsumablesInt",
          "set_common_status",
          "set_dss",
          "set_rss",
          "set_kct",
          "set_in_warmup",
          "set_last_clean_t",
          "set_map_flag",
          "set_back_type",
          "set_charge_status",
          "set_clean_percent",
          "set_cleaned_area",
          "set_switch_status",
        ],
        // S8 MaxV (Ultra)
        "roborock.vacuum.a97": [
          "setCleaningRecordsString",
          "setConsumablesInt",
          "set_cleaned_area",
          "set_last_clean_t",
          "set_switch_status",
          "set_monitor_status",
          "set_kct",
          "set_common_status",
          "set_rss",
          "set_clean_percent",
          "set_charge_status",
          "set_in_warmup",
          "set_map_flag",
          "set_task_id",
          "set_dss",
        ],
        // Roborock Qrevo S
        "roborock.vacuum.a104": [
          "setCleaningRecordsString",
          "setConsumablesInt",
          "set_in_warmup",
          "set_charge_status",
          "set_clean_percent",
          "set_rss",
          "set_dss",
          "set_common_status",
          "set_kct",
          "set_switch_status",
          "set_map_flag",
          "set_cleaned_area",
        ],
        // Roborock Qrevo Curv
        "roborock.vacuum.a135": [
          "setCleaningRecordsString",
          "setConsumablesInt",
          "set_monitor_status",
          "set_in_warmup",
          "set_clean_percent",
          "set_extra_time",
          "set_rss",
          "set_common_status",
          "set_kct",
          "set_switch_status",
          "set_last_clean_t",
          "set_cleaning_info",
          "set_exit_dock",
          "set_charge_status",
          "set_map_flag",
          "set_cleaned_area",
          "set_task_id",
          "set_dss",
        ],
        // Roborock Qrevo Master
        "roborock.vacuum.a117": [
          "setCleaningRecordsString",
          "setConsumablesInt",
          "set_last_clean_t",
          "set_switch_status",
          "set_kct",
          "set_common_status",
          "set_dss",
          "set_rss",
          "set_clean_percent",
          "set_charge_status",
          "set_in_warmup",
          "set_monitor_status",
          "set_task_id",
          "set_cleaned_area",
          "set_map_flag",
        ],
        // Roborock Qrevo Slim
        "roborock.vacuum.a21": [
          "setCleaningRecordsString",
          "setConsumablesInt",
          "set_map_flag",
          "set_cleaned_area",
          "set_replenish_mode",
          "set_clean_times",
          "set_task_id",
          "set_monitor_status",
          "set_in_warmup",
          "set_charge_status",
          "set_clean_percent",
          "set_dss",
          "set_rss",
          "set_common_status",
          "set_kct",
          "set_switch_status",
          "set_last_clean_t",
        ],
        // Saros 10R
        "roborock.vacuum.a144": [
          "setCleaningRecordsString",
          "setConsumablesInt",
          "set_map_flag",
          "set_cleaned_area",
          "set_replenish_mode",
          "set_clean_times",
          "set_task_id",
          "set_monitor_status",
          "set_in_warmup",
          "set_charge_status",
          "set_clean_percent",
          "set_dss",
          "set_rss",
          "set_common_status",
          "set_kct",
          "set_switch_status",
          "set_last_clean_t",
        ],
        // Saros 10
        "roborock.vacuum.a147": saros10ActionSet,
        "roborock.vacuum.a140": saros10ActionSet,
        "roborock.vacuum.a95": saros10ActionSet,
        "roborock.vacuum.a159": saros10ActionSet,
        "roborock.vacuum.ss07": saros10ActionSet,
      };

      // process modelConfig
      const configActions = modelConfig[robotModel];
      if (configActions) {
        for (const actionName of configActions) {
          const action = actions[actionName];
          if (action) {
            await action(this);
          }
        }
      } else if (
        this.adapter.getVacuumDeviceInfo?.(this.duid, "pv") === "B01"
      ) {
        // B01/Q7-series robots are fully supported through the dedicated B01
        // adapter (commands, status, rooms, clean modes); the v1 per-model
        // feature tables simply do not apply to them.
        this.adapter.log.debug(
          `Model ${robotModel} is a B01/Q7-series robot; using the B01 adapter feature set.`
        );
      } else {
        // Not an error: core controls (start/stop/dock/battery/rooms) and the
        // Matter capabilities derived from the cloud schema all work without a
        // per-model entry. The model just lacks extra diagnostic state setup.
        // Warn was wrong for something the same sentence calls harmless, and
        // naming only the model printed it twice for two robots of one model.
        this.adapter.log.debug(
          `${this.adapter.describeDevice?.(this.duid) || "This robot"} (${robotModel}) has no per-model feature table; using generic defaults. Start/stop/dock, battery, rooms and every Matter capability are unaffected — only extra diagnostic states are missing. To have the model added, open a model report issue on GitHub with a diagnostics export from the plugin settings.`
        );
      }

      this.adapter.createBaseRobotObjects(this.duid);

      // v1 feature probes (get_timer, carpet mode, water box, ...) have no
      // B01 equivalents; skipping them keeps startup fast and the log clean.
      const isB01Device =
        this.adapter.getVacuumDeviceInfo?.(this.duid, "pv") === "B01";

      const featureList = isB01Device ? {} : this.getFeatureList();
      this.adapter.log.debug(
        `Supported features of robot ${this.duid} - ${robotModel}: ${JSON.stringify(featureList)}`
      );
      Object.keys(featureList).forEach((feature) => {
        if (featureList[feature]) {
          if (typeof this[feature] === "function") {
            this[feature]();
          }
        }
      });

      // process commands
      for (const [command, type] of Object.entries(this.commands)) {
        if (typeof type == "string") {
          await this.adapter.createCommand(this.duid, command, type);
        } else {
          await this.adapter.createCommand(
            this.duid,
            command,
            type.type,
            type.defaultState,
            type.states
          );
        }
      }

      // process device states
      for (const [state, type] of Object.entries(this.deviceStates)) {
        if (typeof type == "string") {
          await this.adapter.createDeviceStatus(this.duid, state, type);
        } else {
          await this.adapter.createDeviceStatus(
            this.duid,
            state,
            type.type,
            type.states,
            type.unit
          );
        }
      }

      // process consumables
      for (const [consumable, object] of Object.entries(this.consumables)) {
        await this.adapter.createConsumable(
          this.duid,
          consumable,
          object.type,
          object.states,
          object.unit
        );
      }
      // process reset of consumables
      for (const [, resetConsumable] of Object.entries(this.resetConsumables)) {
        await this.adapter.createResetConsumables(this.duid, resetConsumable);
      }

      // process cleaning info
      for (const [cleaningInfoKey, cleaningInfoEntry] of Object.entries(
        this.cleaningInfo
      )) {
        await this.adapter.createCleaningInfo(
          this.duid,
          cleaningInfoKey,
          cleaningInfoEntry
        );
      }

      // process cleaning records
      for (const [cleaningRecord, object] of Object.entries(
        this.cleaningRecords
      )) {
        await this.adapter.createCleaningRecord(
          this.duid,
          cleaningRecord,
          object.type,
          object.states,
          object.unit
        );
      }
    } else if (productCategory == "roborock.vacuum") {
      // vacuum (not sure if it's actually roborock.vacuum. Might be something else. Haven't testet)
      this.adapter.createBasicVacuumObjects(this.duid);
    } else if (productCategory == "roborock.wm") {
      // washing machine
      this.adapter.createBasicWashingMachineObjects(this.duid);
    }
  }

  processDockType(dockType) {
    switch (dockType) {
      case 0: // Charging dock
        // nothing to do here
        break;
      case 1: // Auto-Empty Dock - Onyx: S7+/S7Plus (Empty Dock)
        this.isDustCollectionSettingSupported();
        break;
      case 2: // Empty Wash Fill Dock - Onyx2: G10
        this.isWashThenChargeCmdSupported();
        break;
      case 5: // Onyx-C: S8, S8 Plus, Q8, Q8 Max
        this.isDustCollectionSettingSupported();
        break;
      case 3: // Empty Wash Fill (Dry) Dock - Onyx3: S7 Pro, MaxV Ultra
      case 6: // Onyx3 Plus: S7 Max Ultra
      case 7: // Onyx4: S8 Pro Ultra
      case 8: // PEARL: Q Revo, P10
      // Not much info on this one. Might be missing some features
      case 9: // Unknown codename for now: Q Revo Pro
        this.isDustCollectionSettingSupported();
        this.isWashThenChargeCmdSupported();
        this.isSupportedDrying();
        break;
      default:
        break;
    }
  }

  getDivider(table, key) {
    return table[key]?.divider || false;
  }

  getConsumablesDivider(consumable) {
    const robotModel = this.adapter.getProductAttribute(this.duid, "model");
    const consumables =
      robotModel == "roborock.vacuum.s4"
        ? this.consumablesInt
        : this.consumablesString;

    return this.getDivider(consumables, consumable);
  }

  getStatusDivider(attribute) {
    return this.getDivider(this.deviceStates, attribute);
  }

  hasDeviceStatusAttribute(attribute) {
    return Object.prototype.hasOwnProperty.call(this.deviceStates, attribute);
  }

  getFirmwareFeature(featureID) {
    const feature = firmwareFeatures[featureID];

    if (feature) {
      return feature;
    } else {
      return "unknown feature";
    }
  }
}

// Classic v1 models whose upstream-vetted per-model action list includes
// `set_custom_mode_max_plus` — the verified signal that the robot's firmware
// accepts the Max+ suction level (v1 fan power 108). Keep this in sync with
// the modelConfig action lists in processSupportedFeatures above; models are
// only added here once the upstream feature data (or a field report with a
// diagnostics export) confirms the level.
const MAX_PLUS_FAN_POWER_MODELS = new Set([
  "roborock.vacuum.a70", // S8 Pro Ultra
]);

/** @param {string} model */
function supportsMaxPlusFanPower(model) {
  return MAX_PLUS_FAN_POWER_MODELS.has(model);
}

// Marketing names for the model codes the robot reports, so a controller shows
// "Roborock Qrevo S" where it used to show "roborock.vacuum.a104" (#10).
//
// DISPLAY ONLY. Every poll profile, feature lookup, capability branch and
// `isSupportedDevice` call in this codebase keys on the raw code, and a name
// resolved anywhere a model is *compared* would break model detection silently
// — a robot whose name we happen to know would stop matching its own profile.
// `__tests__/the-model-row-is-a-name-not-a-code.test.js` enforces both halves.
//
// Every entry is upstream copystring/ioBroker.roborock's own
// `VacuumProfile.name` from `src/lib/features/vacuum/<model>_features.ts`, with
// upstream's trailing "(a104)" bookkeeping suffix removed, cross-checked
// against this file's model comments. Models with no upstream profile are
// deliberately absent — Mathias' own sc05 among them — because a wrong
// marketing name is worse than a code: the code is at least unambiguous.
const MODEL_MARKETING_NAMES = Object.freeze(
  Object.assign(Object.create(null), {
    "roborock.vacuum.s4": "Roborock S4",
    "roborock.vacuum.s5e": "Roborock S5 Max",
    "roborock.vacuum.s6": "Roborock S6",
    "roborock.vacuum.sc01": "Roborock Q7 L5",
    "roborock.vacuum.a08": "Roborock S6 Pure",
    "roborock.vacuum.a10": "Roborock S6 MaxV",
    "roborock.vacuum.a15": "Roborock S7",
    "roborock.vacuum.a19": "Roborock S4 Max",
    "roborock.vacuum.a21": "Roborock Qrevo Slim",
    "roborock.vacuum.a27": "Roborock S7 MaxV (Pro/Ultra)",
    "roborock.vacuum.a38": "Roborock Q7 Max",
    "roborock.vacuum.a40": "Roborock Q7",
    "roborock.vacuum.a51": "Roborock S8",
    "roborock.vacuum.a62": "Roborock S7 Pro Ultra",
    "roborock.vacuum.a65": "Roborock S7 Max Ultra",
    "roborock.vacuum.a70": "Roborock S8 Pro Ultra",
    "roborock.vacuum.a72": "Roborock Q5 Pro",
    "roborock.vacuum.a73": "Roborock Q8 Max",
    "roborock.vacuum.a75": "Roborock Q Revo",
    "roborock.vacuum.a87": "Roborock Qrevo MaxV",
    "roborock.vacuum.a97": "Roborock S8 MaxV Ultra",
    "roborock.vacuum.a101": "Roborock Q Revo Pro",
    "roborock.vacuum.a104": "Roborock Qrevo S",
    "roborock.vacuum.a117": "Roborock Qrevo Master",
    "roborock.vacuum.a135": "Roborock Qrevo Curv",
    "roborock.vacuum.a144": "Roborock Saros 10R",
    "roborock.vacuum.a147": "Roborock Saros 10",
    "roborock.vacuum.a156": "Roborock Qrevo Edge",
    "roborock.vacuum.a159": "Roborock Qrevo Curv Series",
    "roborock.vacuum.a168": "Roborock Qrevo L",
    "roborock.vacuum.a179": "Roborock Saros Z70",
    "roborock.vacuum.a187": "Roborock Qrevo Edge Series",
    "roborock.vacuum.a288": "Roborock Saros 20",
    "roborock.vacuum.a298": "Roborock Qrevo Edge 2",
  })
);

/**
 * The human-readable model name for a reported model code, or null when we
 * cannot source one. Callers must fall back to the code, never to a guess.
 *
 * @param {unknown} model
 * @returns {string|null}
 */
function getModelMarketingName(model) {
  if (typeof model !== "string" || !model) {
    return null;
  }

  // The table has a null prototype, so an inherited `toString` cannot be
  // mistaken for an entry — but read it defensively anyway, because this is
  // called with whatever the cloud reported.
  const name = MODEL_MARKETING_NAMES[model];
  return typeof name === "string" && name ? name : null;
}

/**
 * The Model row as it should read beside a Manufacturer row that already says
 * "Roborock": "Qrevo S", not "Roborock Qrevo S" (#10).
 *
 * The table above deliberately keeps the brand and must keep it — every entry
 * is upstream's `VacuumProfile.name` verbatim, and the cross-check test that
 * catches a name hung on the wrong robot compares against upstream in that
 * form. So the de-branding happens here, at the display edge, not in the data.
 *
 * Why de-brand at all, when 3.15.0 argued the opposite ("a name that does not
 * start with the brand reads as a bare SKU"): there is no surface where this
 * string appears without the manufacturer beside it. Apple Home's accessory
 * details, the Homebridge UI and the HAP sensors' Model characteristic are all
 * fed from `accessory.manufacturer` and `accessory.model` together, and the
 * first is unconditionally "Roborock". The reporter of #10 asked for exactly
 * these two rows and read the result as a duplicate, which settles it.
 *
 * Returns null for an unknown model, exactly like getModelMarketingName, so
 * the caller falls back to the raw reported code. That code must never be
 * rewritten: `roborock.vacuum.sc05` is the robot's own string, not a name we
 * composed, and shortening it would invent a model that does not exist.
 *
 * @param {unknown} model
 * @returns {string|null}
 */
function getModelNameWithoutBrand(model) {
  const name = getModelMarketingName(model);
  if (!name) {
    return null;
  }

  // Anchored and whitespace-delimited, so this only ever removes the brand as
  // a whole word. If a name were ever nothing but the brand, keep it rather
  // than return an empty Model row.
  const unbranded = name.replace(/^Roborock\s+/, "").trim();
  return unbranded || name;
}

module.exports = {
  deviceFeatures,
  errorCodes,
  supportsMaxPlusFanPower,
  getModelMarketingName,
  getModelNameWithoutBrand,
  MODEL_MARKETING_NAMES,
};
