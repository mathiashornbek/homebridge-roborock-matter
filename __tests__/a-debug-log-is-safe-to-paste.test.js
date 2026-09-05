"use strict";

/**
 * A debug log is something users are asked to paste into a public issue, so
 * it must not carry what an attacker on their LAN could use. Until 3.29.0 the
 * `HomeData notifyDeviceUpdater:` line printed the cloud's home data whole,
 * localKey and serial number included — and three such logs were public in
 * #22 before anyone noticed. These tests pin the redaction, including the
 * part that matters most: Roborock nests the sensitive JSON inside a string.
 */

const fs = require("fs");
const path = require("path");
const { redactSecrets, REDACTED } = require("../roborockLib/lib/redactSecrets");

const HOME_DATA = {
  id: 7949644,
  name: "My Home",
  devices: [
    {
      duid: "1MDui2ShbOBYXSlXbr6r94",
      name: "Rocky",
      localKey: "Ou8zmVYF6jHmkz96",
      sn: "RANMED45000924",
      fv: "02.52.86",
      online: true,
      featureSet: "4499197267967999",
      tuyaUuid: null,
    },
  ],
  rooms: [{ id: 1, name: "Küche" }],
};

describe("redacting a debug payload", () => {
  test("masks the robot's local key and serial and keeps everything else", () => {
    const out = redactSecrets(HOME_DATA);

    expect(out.devices[0].localKey).toBe(REDACTED);
    expect(out.devices[0].sn).toBe(REDACTED);
    expect(out.devices[0].duid).toBe("1MDui2ShbOBYXSlXbr6r94");
    expect(out.devices[0].fv).toBe("02.52.86");
    expect(out.devices[0].featureSet).toBe("4499197267967999");
    expect(out.rooms).toEqual([{ id: 1, name: "Küche" }]);
    expect(out.name).toBe("My Home");
  });

  test("a null secret stays null, so a missing field still reads as missing", () => {
    expect(redactSecrets(HOME_DATA).devices[0].tuyaUuid).toBeNull();
  });

  test("looks inside JSON carried as a string, the way HomeData actually arrives", () => {
    const state = { val: JSON.stringify(HOME_DATA), ack: true };

    const out = redactSecrets(state);

    expect(out.ack).toBe(true);
    const inner = JSON.parse(out.val);
    expect(inner.devices[0].localKey).toBe(REDACTED);
    expect(inner.devices[0].sn).toBe(REDACTED);
    expect(inner.devices[0].name).toBe("Rocky");
    expect(JSON.stringify(out)).not.toContain("Ou8zmVYF6jHmkz96");
    expect(JSON.stringify(out)).not.toContain("RANMED45000924");
  });

  test("the account's token and signing material never appear", () => {
    const out = redactSecrets({
      token: "abc.def",
      rriot: { u: "u", s: "s", h: "hmac", k: "mqtt", r: { a: "https://x" } },
      password: "hunter2",
      encryptedToken: "eyJ...",
      email: "someone@example.com",
    });

    expect(out.token).toBe(REDACTED);
    expect(out.rriot).toBe(REDACTED);
    expect(out.password).toBe(REDACTED);
    expect(out.encryptedToken).toBe(REDACTED);
    expect(out.email).toBe("someone@example.com");
  });

  test("key matching ignores case", () => {
    expect(redactSecrets({ LocalKey: "x", SN: "y" })).toEqual({
      LocalKey: REDACTED,
      SN: REDACTED,
    });
  });

  test("does not mutate its input", () => {
    const input = { devices: [{ localKey: "k" }] };
    redactSecrets(input);
    expect(input.devices[0].localKey).toBe("k");
  });

  test("leaves ordinary strings, numbers, arrays and odd inputs alone", () => {
    expect(redactSecrets("just a message")).toBe("just a message");
    expect(redactSecrets("{not json")).toBe("{not json");
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets([1, { sn: "x" }])).toEqual([1, { sn: REDACTED }]);
  });

  test("gives up gracefully on absurd depth rather than looping", () => {
    let nested = { sn: "deep" };
    for (let i = 0; i < 40; i++) nested = { child: nested };
    expect(() => redactSecrets(nested)).not.toThrow();
  });
});

describe("the platform uses it on the line people paste", () => {
  test("HomeData notifyDeviceUpdater goes through redactSecrets", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "platform.ts"),
      "utf8"
    );
    expect(source).toContain(
      "notifyDeviceUpdater:${JSON.stringify(redactSecrets(homeData))}"
    );
    expect(source).not.toMatch(
      /notifyDeviceUpdater:\$\{JSON\.stringify\(homeData\)\}/
    );
  });
});
