"use strict";

/**
 * Issue #22, fourth act — the measurement came back and it was decisive.
 *
 * The 3.23.0 probe asked both candidate cloud routes on the reporter's Saros
 * 10R. `user/devices/{duid}/jobs` answered `[]`. `user/scene/device/{duid}`
 * answered with all three of his 09:00 schedules — cron, timezone, enable
 * flag and the room task, exactly as his screenshots showed them.
 *
 * The fixture below is that answer, with the duid and account-shaped values
 * replaced. It is kept structurally faithful on purpose: Roborock nests JSON
 * inside JSON three deep here, and a decoder written against a tidied-up
 * shape would pass its tests and fail on the real thing.
 *
 * What these tests pin:
 *
 * - the cron is read from where it actually lives, two string-encoded levels
 *   in, not from a field anyone hoped would be there;
 * - the decode happens on the RAW answer, so the diagnostic's own caps — 500
 *   characters per string, 8 entries per array — cannot take the reading with
 *   them; on the real answer they cut every scene mid-task;
 * - a scene with no timer is a Routine, not a schedule, and is counted rather
 *   than silently dropped;
 * - a scene switched off is reported as off, at whichever of the two levels
 *   the app switched it off;
 * - and nothing in here can throw, because it rides on a live poll.
 */

const {
  parseCloudSceneSchedules,
  summariseCloudSceneSchedules,
  describeCron,
} = require("../roborockLib/lib/parseCloudSceneSchedules");

const DUID = "duid-a144";

/**
 * Build a scene the way the cloud builds one: `param` is a JSON string, the
 * trigger's `param` is another, and the action item's `param` is a third.
 */
function makeScene({
  id,
  name,
  cron,
  enabled = true,
  timerEnabled = true,
  segments = [2, 11, 12],
  rooms = "Schlafzimmer Esszimmer Küche",
  type = "WORKFLOW",
}) {
  const triggers =
    cron === null
      ? []
      : [
          {
            id: 6841731,
            name: "TIMER",
            type: "TIMER",
            entityId: "",
            param: JSON.stringify({
              cron,
              type: "NORMAL",
              enabled: timerEnabled,
              repeated: true,
              timeZoneId: "Europe/Berlin",
            }),
          },
        ];

  return {
    id,
    name,
    param: JSON.stringify({
      triggers,
      action: {
        type: "S",
        items: [
          {
            id: 1,
            type: "CMD",
            name: rooms,
            entityId: DUID,
            param: JSON.stringify({
              id: 1,
              method: "do_scenes_segments",
              params: {
                data: [
                  {
                    tid: "1786680804759",
                    segs: segments.map((sid) => ({ sid })),
                  },
                ],
              },
            }),
          },
        ],
      },
    }),
    enabled,
    extra: null,
    type,
  };
}

/** The reporter's three schedules, as the route returned them. */
const REPORTED_SCENES = [
  makeScene({ id: 14303871, name: "Saugen+", cron: "0 9 * * 3" }),
  makeScene({ id: 11435521, name: "Hinten", cron: "0 9 * * 2,4" }),
  makeScene({ id: 11435492, name: "Vorne", cron: "0 9 * * 1,5" }),
];

describe("the scenes route carries the schedules the robot denies having", () => {
  test("all three of the reporter's schedules are decoded", () => {
    const schedules = parseCloudSceneSchedules(REPORTED_SCENES);

    expect(schedules).toHaveLength(3);
    expect(schedules.map((schedule) => schedule.name)).toEqual([
      "Saugen+",
      "Hinten",
      "Vorne",
    ]);
    expect(schedules.map((schedule) => schedule.id)).toEqual([
      "14303871",
      "11435521",
      "11435492",
    ]);
  });

  test("the cron is read from two string-encoded levels in", () => {
    const [first] = parseCloudSceneSchedules(REPORTED_SCENES);

    expect(first.triggers).toHaveLength(1);
    expect(first.triggers[0]).toMatchObject({
      type: "TIMER",
      cron: "0 9 * * 3",
      enabled: true,
      repeated: true,
      timeZoneId: "Europe/Berlin",
    });
  });

  test("cron becomes a time and weekdays, matching the app's own screens", () => {
    const schedules = parseCloudSceneSchedules(REPORTED_SCENES);

    expect(schedules.map((schedule) => schedule.triggers[0].schedule)).toEqual([
      "09:00 on Wed",
      "09:00 on Tue, Thu",
      "09:00 on Mon, Fri",
    ]);
  });

  test("the task the schedule runs is decoded, rooms counted not named", () => {
    const [first] = parseCloudSceneSchedules(REPORTED_SCENES);

    expect(first.actions).toEqual([
      { method: "do_scenes_segments", segmentCount: 3 },
    ]);
  });

  test("neither the duid nor the room names leave the decoder", () => {
    const decoded = JSON.stringify(parseCloudSceneSchedules(REPORTED_SCENES));

    expect(decoded).not.toContain(DUID);
    expect(decoded).not.toContain("Schlafzimmer");
  });
});

describe("the decode reads the whole answer, however large", () => {
  /**
   * The diagnostic's own compaction cuts any string at 500 characters, and on
   * the real answer that landed mid-task on all three scenes: the log said
   * when each schedule fires and never what it does. The decoder runs on the
   * raw answer, so size is not a limit here.
   */
  test("a payload well past the 500-char cap still yields the whole task", () => {
    const longRooms = "Schlafzimmer Esszimmer Küche Wohnzimmer ".repeat(40);
    const scene = makeScene({
      id: 14303871,
      name: "Saugen+",
      cron: "0 9 * * 3",
      rooms: longRooms,
      segments: Array.from({ length: 24 }, (_, index) => index + 1),
    });

    expect(scene.param.length).toBeGreaterThan(500);

    const [decoded] = parseCloudSceneSchedules([scene]);
    expect(decoded.triggers[0].schedule).toBe("09:00 on Wed");
    expect(decoded.actions[0]).toEqual({
      method: "do_scenes_segments",
      segmentCount: 24,
    });
  });

  test("a payload that arrives already truncated yields nothing, not a guess", () => {
    const scene = makeScene({ id: 1, name: "Saugen+", cron: "0 9 * * 3" });
    const truncated = { ...scene, param: `${scene.param.slice(0, 120)}...` };

    expect(parseCloudSceneSchedules([truncated])).toEqual([]);
  });

  test("a ninth schedule is decoded, where the array cap would have dropped it", () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      makeScene({ id: 100 + index, name: `Plan ${index}`, cron: "0 9 * * 1" })
    );

    expect(parseCloudSceneSchedules(many)).toHaveLength(9);
  });
});

describe("a scene without a timer is a Routine, not a schedule", () => {
  test("it is excluded from the schedules", () => {
    const scenes = [
      ...REPORTED_SCENES,
      makeScene({ id: 555, name: "Manual clean", cron: null }),
    ];

    const schedules = parseCloudSceneSchedules(scenes);
    expect(schedules).toHaveLength(3);
    expect(schedules.map((schedule) => schedule.name)).not.toContain(
      "Manual clean"
    );
  });

  test("it is counted in the summary rather than dropped silently", () => {
    const scenes = [
      ...REPORTED_SCENES,
      makeScene({ id: 555, name: "Manual clean", cron: null }),
    ];

    const [headline] = summariseCloudSceneSchedules(scenes);
    expect(headline).toBe("3 of 4 scene(s) are timer-driven");
  });

  test("with nothing but Routines the summary says nothing at all", () => {
    const scenes = [makeScene({ id: 555, name: "Manual clean", cron: null })];

    expect(summariseCloudSceneSchedules(scenes)).toEqual([]);
  });
});

describe("an off switch is reported at the level the app flipped it", () => {
  test("a scene disabled at scene level is not active", () => {
    const scene = makeScene({
      id: 1,
      name: "Vorne",
      cron: "0 9 * * 1,5",
      enabled: false,
    });

    const [decoded] = parseCloudSceneSchedules([scene]);
    expect(decoded.enabled).toBe(false);
    expect(decoded.active).toBe(false);
    expect(decoded.triggers[0].enabled).toBe(true);
  });

  test("a scene whose timer is switched off is not active either", () => {
    const scene = makeScene({
      id: 1,
      name: "Vorne",
      cron: "0 9 * * 1,5",
      timerEnabled: false,
    });

    const [decoded] = parseCloudSceneSchedules([scene]);
    expect(decoded.enabled).toBe(true);
    expect(decoded.triggers[0].enabled).toBe(false);
    expect(decoded.active).toBe(false);
    expect(summariseCloudSceneSchedules([scene])[1]).toContain(
      "disabled at the timer"
    );
  });
});

describe("a cron we do not understand is printed, not guessed", () => {
  test("the shapes the schedule screen produces are rendered", () => {
    expect(describeCron("0 9 * * 3")).toBe("09:00 on Wed");
    expect(describeCron("30 7 * * 1-5")).toBe(
      "07:30 on Mon, Tue, Wed, Thu, Fri"
    );
    expect(describeCron("0 22 * * *")).toBe("22:00 daily");
    expect(describeCron("0 9 * * 0")).toBe("09:00 on Sun");
    expect(describeCron("0 9 * * 7")).toBe("09:00 on Sun");
  });

  test("anything else renders as nothing, and the raw cron is logged instead", () => {
    expect(describeCron("*/15 * * * *")).toBeNull();
    expect(describeCron("0 9 1 * *")).toBeNull();
    expect(describeCron("0 9 * 3 *")).toBeNull();
    expect(describeCron("0 99 * * 1")).toBeNull();
    expect(describeCron("not a cron")).toBeNull();

    const scene = makeScene({ id: 1, name: "Odd", cron: "*/15 * * * *" });
    expect(summariseCloudSceneSchedules([scene])[1]).toContain(
      "cron */15 * * * *"
    );
  });
});

describe("the decoder cannot break the poll it rides on", () => {
  test("malformed nested JSON is skipped without throwing", () => {
    const scene = { id: 1, name: "Broken", param: "{not json", enabled: true };

    expect(() => parseCloudSceneSchedules([scene])).not.toThrow();
    expect(parseCloudSceneSchedules([scene])).toEqual([]);
  });

  test("answers that are not arrays decode to nothing", () => {
    for (const payload of [null, undefined, {}, "", 0, { result: [] }]) {
      expect(parseCloudSceneSchedules(payload)).toEqual([]);
      expect(summariseCloudSceneSchedules(payload)).toEqual([]);
    }
  });

  test("junk entries inside a good answer do not take the good ones down", () => {
    const scenes = [null, "nonsense", 42, [], ...REPORTED_SCENES];

    expect(parseCloudSceneSchedules(scenes)).toHaveLength(3);
  });

  test("an already-parsed param object is read as readily as a string", () => {
    const scene = makeScene({ id: 1, name: "Vorne", cron: "0 9 * * 1,5" });
    const preParsed = { ...scene, param: JSON.parse(scene.param) };

    const [decoded] = parseCloudSceneSchedules([preParsed]);
    expect(decoded.triggers[0].cron).toBe("0 9 * * 1,5");
  });

  test("a scene with no action still decodes its schedule", () => {
    const scene = {
      id: 7,
      name: "Timer only",
      enabled: true,
      param: JSON.stringify({
        triggers: [
          {
            id: 1,
            type: "TIMER",
            param: JSON.stringify({ cron: "0 6 * * 1" }),
          },
        ],
      }),
    };

    const [decoded] = parseCloudSceneSchedules([scene]);
    expect(decoded.actions).toEqual([]);
    expect(decoded.triggers[0].schedule).toBe("06:00 on Mon");
    // A trigger that says nothing about `enabled` is on, as the app shows it.
    expect(decoded.active).toBe(true);
  });
});
