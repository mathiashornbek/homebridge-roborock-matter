"use strict";

// 3.4.3 replaced a per-poll warning storm with one line per unknown field,
// and that line asks the owner to paste it into a model report. skmzwanke did
// exactly that for his Saros 10 (`roborock.vacuum.a144`) in issue #8:
//
//   Weebo (roborock.vacuum.a144) sends 9 get_status field(s) this plugin has
//   no mapping for: home_sec_status=0, voice_chat_status=0,
//   home_sec_enable_password=1, extra_time=0, sterilize_status=0, rst=0,
//   cleaning_info={"target_segment_id":-1,...}, exit_dock=0, seq_type=0
//
// The round trip only pays off if the fields actually get added, so this test
// pins that they stay added — and pins the shape of the report loop itself,
// because the next model will arrive the same way.

const { deviceFeatures } = require("../roborockLib/lib/deviceFeatures");

/** The nine fields exactly as the field report named them. */
const SAROS_10_FIELDS = [
  "home_sec_status",
  "voice_chat_status",
  "home_sec_enable_password",
  "extra_time",
  "sterilize_status",
  "rst",
  "cleaning_info",
  "exit_dock",
  "seq_type",
];

function createFeatures() {
  return new deviceFeatures(
    {},
    undefined,
    "roborock.vacuum.a144",
    "duid-saros10",
    { log: { debug() {}, info() {}, warn() {}, error() {} } }
  );
}

describe("Saros 10 status fields from issue #8", () => {
  test.each(SAROS_10_FIELDS)("%s is a known status field", (field) => {
    expect(createFeatures().hasDeviceStatusAttribute(field)).toBe(true);
  });

  test("a genuinely unknown field is still reported", () => {
    // The point of mapping known fields is to make the remaining warning
    // meaningful. If everything were silently accepted, the next new model
    // would tell us nothing.
    expect(
      createFeatures().hasDeviceStatusAttribute("some_field_nobody_has_seen")
    ).toBe(false);
  });

  test("the table is per-instance, so one robot cannot teach another", () => {
    // Module-level tables previously made a robot's behaviour depend on which
    // robot was set up last; the constructor copies them for this reason.
    const a = createFeatures();
    const b = createFeatures();

    a.deviceStates.invented_by_robot_a = "number";

    expect(b.hasDeviceStatusAttribute("invented_by_robot_a")).toBe(false);
  });
});
