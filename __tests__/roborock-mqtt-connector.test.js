const {
  parsePhotoPayload,
  parseProtocol301Header,
  payloadStartsWith,
} = require("../roborockLib/lib/roborock_mqtt_connector");

describe("Roborock MQTT connector payload parsing", () => {
  test("does not parse truncated protocol 301 headers", () => {
    expect(parseProtocol301Header(Buffer.alloc(23))).toBeNull();
    expect(parseProtocol301Header(Buffer.alloc(0))).toBeNull();
    expect(parseProtocol301Header("not-a-buffer")).toBeNull();
  });

  test("parses complete protocol 301 headers", () => {
    const payload = Buffer.alloc(24);
    payload.write("endpoint", 0, "utf8");
    payload.writeUInt8(1, 15);
    payload.writeUInt16LE(42, 16);

    expect(parseProtocol301Header(payload)).toEqual(
      expect.objectContaining({
        endpoint: "endpoint",
        id: 42,
      })
    );
  });

  test("does not parse truncated Roborock photo headers", () => {
    expect(parsePhotoPayload(Buffer.from("ROBOROC"))).toBeNull();
    expect(parsePhotoPayload(Buffer.from("ROBOROCK"))).toBeNull();
    expect(parsePhotoPayload(Buffer.from("not-photo"))).toBeNull();
  });

  test("recognizes payload prefixes without relying on Buffer coercion", () => {
    expect(payloadStartsWith(Buffer.from("ROBOROCK-data"), "ROBOROCK")).toBe(
      true
    );
    expect(payloadStartsWith(Buffer.from("OTHER-data"), "ROBOROCK")).toBe(
      false
    );
  });
});
