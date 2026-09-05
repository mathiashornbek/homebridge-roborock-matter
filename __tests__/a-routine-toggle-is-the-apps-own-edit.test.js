"use strict";

/**
 * Issue #22, the write.
 *
 * Three releases measured where a robot that refuses `get_server_timer`
 * keeps its schedules (as timer-driven Routines on the account), which flag
 * the app flips when its owner switches one off (the TIMER trigger's nested
 * `enabled`, not the scene's own), and which verbs the routes take (`Allow`
 * headers, with controls). What remained was the payload, and that was
 * measured on the owner's own account on 5 Sep 2026:
 *
 *   PUT user/scene/{id}/param  ← the scene's param object, as JSON
 *
 * answered `success:true`, replaced the triggers (new ids), re-serialised
 * every nested param in the server's own style, kept the action byte for
 * byte and dropped `matchType`. Flipping the nested flag in that object is
 * therefore the app's own edit, reproduced — and because the write REPLACES
 * the param, everything else must go back exactly as it came.
 *
 * The fixtures are the two timer-driven Routines from that account, ids and
 * device replaced, shapes kept: one trigger param carries `type: NORMAL`, the
 * other does not; one trigger `entityId` is `"TIMER"`, the newer ones `""`.
 */

const {
  buildSceneParamWithTimersEnabled,
  cloudSceneScheduleIsActive,
  parseCloudSceneSchedules,
} = require("../roborockLib/lib/parseCloudSceneSchedules");

const DUID = "duid-a70";

const ACTION_ZONES = JSON.stringify({
  id: 1,
  method: "do_scenes_zones",
  params: {
    data: [
      {
        tid: "1733606333615",
        zones: [
          { zid: 4, repeat: 1 },
          { zid: 5, repeat: 1 },
          { zid: 6, repeat: 1 },
        ],
        map_flag: 0,
        fan_power: 103,
        water_box_mode: 200,
        mop_mode: 300,
        mop_template_id: 300,
        repeat: 1,
        clean_order_mode: 1,
        auto_dry: 1,
        auto_dustCollection: 1,
        region_num: 0,
      },
    ],
    source: 101,
  },
});

/** "Køkken & Entré": Wednesday 09:30, trigger param in the server's spaced style. */
function kitchenScene({ timerEnabled = true, sceneEnabled = true } = {}) {
  const triggerParam = `{"cron": "30 9 * * 3", "type": "NORMAL", "enabled": ${timerEnabled}, "repeated": true, "timeZoneId": "Europe/Copenhagen"}`;
  return {
    id: 778257,
    name: "Køkken & Entré",
    param: JSON.stringify({
      triggers: [
        {
          id: 4765171,
          name: "TIMER",
          type: "TIMER",
          entityId: "TIMER",
          param: triggerParam,
        },
      ],
      action: {
        type: "S",
        items: [
          {
            id: 1,
            type: "CMD",
            name: "",
            entityId: DUID,
            param: ACTION_ZONES,
            finishDpIds: [130],
          },
        ],
      },
      matchType: "NONE",
    }),
    enabled: sceneEnabled,
    extra: null,
    type: "WORKFLOW",
  };
}

/** "Fuld rengøring": Mon+Fri, older trigger param without `type`, two actions. */
function fullCleanScene() {
  return {
    id: 778271,
    name: "Fuld rengøring",
    param: JSON.stringify({
      triggers: [
        {
          id: 2152919,
          name: "TIMER",
          type: "TIMER",
          entityId: "TIMER",
          param:
            '{"cron": "30 9 * * 1,5", "enabled": true, "repeated": true, "timeZoneId": "Europe/Copenhagen"}',
        },
      ],
      action: {
        type: "S",
        items: [
          {
            id: 1,
            type: "CMD",
            name: "",
            entityId: DUID,
            param:
              '{"id":1,"method":"do_scenes_app_start","params":[{"fan_power":102,"water_box_mode":200,"mop_mode":300,"mop_template_id":300,"repeat":0,"source":101}]}',
            finishDpIds: [130],
          },
          {
            id: 2,
            type: "CMD",
            name: "",
            entityId: DUID,
            param:
              '{"id":2,"method":"do_scenes_app_start","params":[{"fan_power":105,"water_box_mode":202,"mop_mode":301,"mop_template_id":301,"repeat":0,"source":101}]}',
            finishDpIds: [130],
          },
        ],
      },
      matchType: "NONE",
    }),
    enabled: true,
    extra: null,
    type: "WORKFLOW",
  };
}

/** "Støvsug over alt": a manually run Routine, no trigger at all. */
function manualScene() {
  return {
    id: 5653732,
    name: "Støvsug over alt",
    param: JSON.stringify({
      triggers: [],
      action: {
        type: "S",
        items: [
          {
            id: 1,
            type: "CMD",
            name: "",
            entityId: DUID,
            param:
              '{"id":1,"method":"do_scenes_app_start","params":[{"fan_power":104,"water_box_mode":200,"mop_mode":300,"mop_template_id":300,"repeat":0,"auto_dustCollection":1,"source":101}]}',
            finishDpIds: [130],
          },
        ],
      },
      matchType: "NONE",
      tagId: "1002",
    }),
    enabled: true,
    extra: null,
    type: "WORKFLOW",
  };
}

describe("building the param a schedule write sends", () => {
  test("switching off flips the TIMER trigger's nested flag and nothing else", () => {
    const scene = kitchenScene();
    const original = JSON.parse(scene.param);

    const param = buildSceneParamWithTimersEnabled(scene, false);

    expect(param).not.toBeNull();
    // The one change.
    const [trigger] = param.triggers;
    expect(JSON.parse(trigger.param)).toEqual({
      cron: "30 9 * * 3",
      type: "NORMAL",
      enabled: false,
      repeated: true,
      timeZoneId: "Europe/Copenhagen",
    });
    // The trigger's own identity is carried through; the cloud re-issues the
    // id anyway, but it is not ours to drop.
    expect(trigger.id).toBe(4765171);
    expect(trigger.name).toBe("TIMER");
    expect(trigger.entityId).toBe("TIMER");
    // The action is byte for byte what came in.
    expect(param.action).toEqual(original.action);
    expect(param.action.items[0].param).toBe(ACTION_ZONES);
    // Fields this plugin knows nothing about travel back too — the write
    // replaces the param, so anything left out here would be gone.
    expect(param.matchType).toBe("NONE");
  });

  test("switching on sets the flag true, whichever style the trigger param came in", () => {
    const param = buildSceneParamWithTimersEnabled(fullCleanScene(), true);

    expect(JSON.parse(param.triggers[0].param)).toEqual({
      cron: "30 9 * * 1,5",
      enabled: true,
      repeated: true,
      timeZoneId: "Europe/Copenhagen",
    });
    expect(param.action.items).toHaveLength(2);
  });

  test("the input is never mutated", () => {
    const scene = kitchenScene();
    const before = scene.param;

    buildSceneParamWithTimersEnabled(scene, false);

    expect(scene.param).toBe(before);
    expect(JSON.parse(scene.param).triggers[0].param).toContain(
      '"enabled": true'
    );
  });

  test("the built object round-trips as the compact JSON the cloud accepted", () => {
    const param = buildSceneParamWithTimersEnabled(kitchenScene(), false);
    const wire = JSON.stringify(param);

    // Nested JSON stays a string inside the string, exactly as the cloud
    // stores it — three levels of quoting, not a parsed object.
    const parsed = JSON.parse(wire);
    expect(typeof parsed.triggers[0].param).toBe("string");
    expect(typeof parsed.action.items[0].param).toBe("string");
    expect(JSON.parse(parsed.action.items[0].param).method).toBe(
      "do_scenes_zones"
    );
  });

  test("a Routine without a timer has nothing to switch and gets no param", () => {
    expect(buildSceneParamWithTimersEnabled(manualScene(), false)).toBeNull();
  });

  test("a trigger of another type is carried through untouched and does not count", () => {
    const scene = kitchenScene();
    const param = JSON.parse(scene.param);
    param.triggers.push({
      id: 9,
      name: "DEVICE",
      type: "DEVICE",
      entityId: DUID,
      param: '{"dp":130}',
    });
    scene.param = JSON.stringify(param);

    const built = buildSceneParamWithTimersEnabled(scene, false);

    expect(built.triggers).toHaveLength(2);
    expect(built.triggers[1]).toEqual(param.triggers[1]);
    expect(JSON.parse(built.triggers[0].param).enabled).toBe(false);
  });

  test("a trigger identified only by name is still a timer", () => {
    const scene = kitchenScene();
    const param = JSON.parse(scene.param);
    delete param.triggers[0].type;
    scene.param = JSON.stringify(param);

    const built = buildSceneParamWithTimersEnabled(scene, false);
    expect(JSON.parse(built.triggers[0].param).enabled).toBe(false);
  });

  test("a param that already arrived parsed is accepted as-is", () => {
    const scene = kitchenScene();
    scene.param = JSON.parse(scene.param);

    const built = buildSceneParamWithTimersEnabled(scene, false);
    expect(JSON.parse(built.triggers[0].param).enabled).toBe(false);
  });

  test("anything unreadable yields no param rather than a partial write", () => {
    expect(buildSceneParamWithTimersEnabled(null, true)).toBeNull();
    expect(buildSceneParamWithTimersEnabled("scene", true)).toBeNull();
    expect(buildSceneParamWithTimersEnabled({ id: 1 }, true)).toBeNull();
    expect(
      buildSceneParamWithTimersEnabled({ id: 1, param: "not json" }, true)
    ).toBeNull();
    expect(
      buildSceneParamWithTimersEnabled(
        { id: 1, param: JSON.stringify({ triggers: "nope" }) },
        true
      )
    ).toBeNull();
    // A TIMER trigger whose own param has no cron is not a schedule.
    expect(
      buildSceneParamWithTimersEnabled(
        {
          id: 1,
          param: JSON.stringify({
            triggers: [{ type: "TIMER", param: '{"enabled":true}' }],
          }),
        },
        true
      )
    ).toBeNull();
  });
});

describe("the switch position a Routine's schedule shows", () => {
  test("on when the scene and its timer are both enabled", () => {
    expect(cloudSceneScheduleIsActive(kitchenScene())).toBe(true);
  });

  test("off when the app switched the timer off", () => {
    expect(
      cloudSceneScheduleIsActive(kitchenScene({ timerEnabled: false }))
    ).toBe(false);
  });

  test("off when the scene itself is disabled, even with the timer on", () => {
    expect(
      cloudSceneScheduleIsActive(kitchenScene({ sceneEnabled: false }))
    ).toBe(false);
  });

  test("no position at all for a Routine without a timer", () => {
    expect(cloudSceneScheduleIsActive(manualScene())).toBeNull();
  });

  test("agrees with the decoder used for the log lines", () => {
    const [decoded] = parseCloudSceneSchedules([
      kitchenScene({ timerEnabled: false }),
    ]);
    expect(decoded.active).toBe(false);
    expect(decoded.enabled).toBe(true);
    expect(decoded.triggers[0].enabled).toBe(false);
  });
});
