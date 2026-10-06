"use strict";

// Why the live cache keeps ONE freshness stamp (3.35.0 tried one per field and
// review caught this). Real inputs only: DSimeone1989's a144
// replies and dps pushes from test-support/issue-22-a144-captures.json
// (RM_log_without_both.txt / RM_log_without_cloud_only.txt, 30 Sept).
//
// The a144's own replies prove `error_code` says nothing about the tanks:
// every reply with the clean tank empty (dss clean-water 1, dock_error_status
// 38 or 39) carries `error_code: 0`. Yet when the tank fields age out of the
// live cache, getMatterFault() takes the HomeData `error_code: 0` as an
// affirmative "fine" and publishes NoError over a standing WaterTankEmpty (68),
// while the HAP Water Tank Empty sensor (refresh(null) is a no-op) stays Closed.
// (The robot's real HomeData snapshots at 18:23:39-18:35:39, while this tank
// was empty, also read 120 = 0; the harness's HomeData error_code 0 is that.)
// The next status reply raises 68 again: a fresh 0 -> 68 edge, which is the
// OperationalError event Apple Home notifies on (#9/#26).
//
// With the single stamp the battery pushes keep the tank reading live, so
// the fault stands and nothing re-notifies. Only the pushes' spacing is
// re-based onto the docked reply's time; the frames themselves are verbatim.

const {
  CAPTURES,
  createA144Vacuum,
  loggedAtToMs,
} = require("../test-support/a144-vacuum-harness");

const WATER_TANK_EMPTY = 68;

// RM_log_without_cloud_only.txt:7974, 30/09/2026 18:43:54, verbatim: the a144
// back in its dock after run 2, clean tank still empty (dock_error_status 38,
// dss 2212 -> clean-water 1). Not in the captures file, so embedded here.
const DOCKED_TANK_EMPTY_1843 = [
  {
    msg_ver: 2,
    msg_seq: 1851,
    state: 8,
    battery: 70,
    clean_time: 1879,
    clean_area: 27042500,
    error_code: 0,
    map_present: 1,
    in_cleaning: 0,
    in_returning: 0,
    in_fresh_state: 1,
    lab_status: 1,
    water_box_status: 1,
    fan_power: 110,
    dnd_enabled: 0,
    map_status: 3,
    is_locating: 0,
    lock_status: 0,
    water_box_mode: 209,
    distance_off: 0,
    water_box_carriage_status: 1,
    mop_forbidden_enable: 1,
    camera_status: 11685,
    is_exploring: 0,
    home_sec_status: 0,
    voice_chat_status: 0,
    home_sec_enable_password: 1,
    monitor_status: 0,
    adbumper_status: [0, 0, 0],
    water_shortage_status: 0,
    dock_type: 16,
    dust_collection_status: 0,
    auto_dust_collection: 2,
    avoid_count: 55,
    mop_mode: 306,
    in_warmup: 0,
    back_type: -1,
    wash_phase: 0,
    wash_ready: 1,
    wash_status: 512,
    debug_mode: 0,
    collision_avoid_status: 0,
    switch_map_mode: 0,
    dock_error_status: 38,
    charge_status: 1,
    unsave_map_reason: 0,
    unsave_map_flag: 0,
    dry_status: 1,
    rdt: 7200,
    clean_percent: 0,
    extra_time: 1121,
    rss: 2,
    dss: 2212,
    common_status: 2,
    repeat: 1,
    kct: 0,
    sterilize_status: 0,
    rst: 0,
    events: [],
    switch_status: 27,
    last_clean_t: 1790786247,
    replenish_mode: 0,
    subdivision_sets: 0,
    cleaning_info: {
      target_segment_id: -1,
      segment_id: -1,
      fan_power: 102,
      water_box_status: 235,
      mop_mode: 306,
    },
    exit_dock: 0,
    seq_type: 0,
  },
];

function errorWrites(matterUpdates) {
  return matterUpdates
    .filter(
      (u) =>
        u.cluster === "rvcOperationalState" &&
        u.attributes &&
        u.attributes.operationalError
    )
    .map((u) => u.attributes.operationalError.errorStateId);
}

afterEach(() => jest.useRealTimers());

test("battery pushes while docked do not withdraw, then re-raise, the tank fault", async () => {
  // Every a144 reply with an empty clean tank says error_code 0.
  for (const name of [
    "run1_1731_dirtyFullMasksCleanEmpty",
    "run1_1748_dockedBothTanksFlagged",
    "run2_1820_cleanEmptyOnly",
  ]) {
    const reply = CAPTURES[name].reply[0];
    expect((reply.dss >> 2) & 3).toBe(1);
    expect(reply.error_code).toBe(0);
  }

  const docked = () =>
    rocky.push(JSON.parse(JSON.stringify(DOCKED_TANK_EMPTY_1843)));
  expect(DOCKED_TANK_EMPTY_1843[0]).toMatchObject({
    state: 8,
    dock_error_status: 38,
    dss: 2212,
    error_code: 0,
  });

  const t0 = loggedAtToMs("30/09/2026, 18:43:54");
  jest.useFakeTimers({ now: t0, doNotFake: ["nextTick", "setImmediate"] });

  const rocky = createA144Vacuum();
  await docked(); // docked, state 8, a cloud reply delivered as the connector does
  expect(errorWrites(rocky.matterUpdates).at(-1)).toBe(WATER_TANK_EMPTY);
  expect(rocky.sensor("waterTankEmpty")).toBe(true);

  // The real 122 pushes (captured 18:22-18:37 mid-run; their values are
  // irrelevant here), keeping their own ~100 s spacing.
  const firstPush = loggedAtToMs(CAPTURES.batteryPushes[0].loggedAt);
  let now = t0;
  for (const { loggedAt, push } of CAPTURES.batteryPushes) {
    now = t0 + 60 * 1000 + (loggedAtToMs(loggedAt) - firstPush);
    jest.setSystemTime(now);
    await rocky.push(push);
  }
  expect(now - t0).toBeGreaterThan(15 * 60 * 1000);

  // Nothing has said the tank was refilled. The fault must not be withdrawn.
  expect(errorWrites(rocky.matterUpdates)).not.toContain(0);

  // The poll answers again with the same empty tank: no second 0 -> 68 edge.
  jest.setSystemTime(now + 60 * 1000);
  await docked();
  const writes = errorWrites(rocky.matterUpdates);
  const raises = writes.filter(
    (id, i) => id === WATER_TANK_EMPTY && writes[i - 1] !== WATER_TANK_EMPTY
  );
  expect(raises).toHaveLength(1);
});
