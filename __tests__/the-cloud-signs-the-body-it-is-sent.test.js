"use strict";

/**
 * The Roborock account API signs every request over seven slots, and for as
 * long as this plugin has existed it signed the last two empty. That was
 * right for every request it made — all bodiless — and wrong for every write
 * that carries one: the cloud answers an unsigned body with 401.
 *
 * Measured 5 Sep 2026 on the owner's own account: a JSON body is signed as
 * md5 of the exact bytes sent, a form body as md5 of the sorted `k=v&k=v`
 * string, and both then answer 200. These tests pin that formula against an
 * independent implementation of it (python-roborock's), so the two cannot
 * drift apart without one of them saying so.
 */

const crypto = require("crypto");
const {
  buildHawkAuthorization,
  formBody,
  normalizeRequestBody,
  contentTypeFor,
  signAxiosRequest,
} = require("../roborockLib/lib/hawkSignature");

const RRIOT = {
  u: "user-u",
  s: "session-s",
  h: "hmac-key-h",
  r: { a: "https://api-eu.roborock.com" },
};

/**
 * python-roborock's `_get_hawk_authentication`, transliterated. Kept
 * separate from the module under test on purpose: a test that reused the
 * implementation would prove nothing.
 */
function pythonRoborockMac({ rriot, url, timestamp, nonce, body, formdata }) {
  const md5 = (value) => crypto.createHash("md5").update(value).digest("hex");
  const extra = (values) =>
    values
      ? md5(
          Object.keys(values)
            .sort()
            .map((key) => `${key}=${values[key]}`)
            .join("&")
        )
      : "";
  const payload = body !== undefined ? md5(body) : extra(formdata);
  const prestr = [
    rriot.u,
    rriot.s,
    nonce,
    String(timestamp),
    md5(url),
    /* params */ "",
    payload,
  ].join(":");
  return crypto.createHmac("sha256", rriot.h).update(prestr).digest("base64");
}

function macOf(header) {
  return /mac="([^"]+)"/.exec(header)[1];
}

describe("the Hawk signature covers the body", () => {
  const clock = { timestamp: 1_788_600_000, nonce: "abc123" };

  test("a bodiless request signs the same way it always did", () => {
    const header = buildHawkAuthorization(
      RRIOT,
      "/user/scene/device/duid-1",
      undefined,
      clock
    );

    expect(header).toBe(
      `Hawk id="user-u", s="session-s", ts="1788600000", nonce="abc123", mac="${pythonRoborockMac(
        {
          rriot: RRIOT,
          url: "/user/scene/device/duid-1",
          ...clock,
        }
      )}"`
    );
  });

  test("a JSON body is signed as the md5 of the exact bytes sent", () => {
    const body = JSON.stringify({ triggers: [], action: { type: "S" } });
    const header = buildHawkAuthorization(
      RRIOT,
      "/user/scene/778257/param",
      body,
      clock
    );

    expect(macOf(header)).toBe(
      pythonRoborockMac({
        rriot: RRIOT,
        url: "/user/scene/778257/param",
        body,
        ...clock,
      })
    );
  });

  test("a form body is signed as python-roborock signs formdata", () => {
    const body = formBody({ enabled: false });
    expect(body).toBe("enabled=false");

    const header = buildHawkAuthorization(
      RRIOT,
      "/user/scene/778257/enable",
      body,
      clock
    );

    expect(macOf(header)).toBe(
      pythonRoborockMac({
        rriot: RRIOT,
        url: "/user/scene/778257/enable",
        formdata: { enabled: false },
        ...clock,
      })
    );
  });

  test("a different body gives a different signature", () => {
    const a = buildHawkAuthorization(RRIOT, "/p", '{"enabled":true}', clock);
    const b = buildHawkAuthorization(RRIOT, "/p", '{"enabled":false}', clock);
    expect(macOf(a)).not.toBe(macOf(b));
  });

  test("form fields are sorted by key and refuse anything that would need encoding", () => {
    expect(formBody({ b: 1, a: "x" })).toBe("a=x&b=1");
    expect(() => formBody({ name: "After dinner" })).toThrow(/signature/);
    expect(() => formBody({ "a&b": 1 })).toThrow(/signature/);
  });
});

describe("normalising what axios was handed", () => {
  test("nothing, null and the empty string are bodiless", () => {
    expect(normalizeRequestBody(undefined)).toBeUndefined();
    expect(normalizeRequestBody(null)).toBeUndefined();
    expect(normalizeRequestBody("")).toBeUndefined();
  });

  test("strings and buffers pass through untouched", () => {
    expect(normalizeRequestBody("enabled=true")).toBe("enabled=true");
    const buffer = Buffer.from("x");
    expect(normalizeRequestBody(buffer)).toBe(buffer);
  });

  test("objects become the compact JSON axios would have sent", () => {
    expect(normalizeRequestBody({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}');
  });

  test("URLSearchParams become the sorted raw form string", () => {
    const params = new URLSearchParams();
    params.append("z", "1");
    params.append("a", "true");
    expect(normalizeRequestBody(params)).toBe("a=true&z=1");
  });

  test("the content type follows the body's shape", () => {
    expect(contentTypeFor('{"a":1}')).toBe("application/json");
    expect(contentTypeFor("[1]")).toBe("application/json");
    expect(contentTypeFor("enabled=true")).toBe(
      "application/x-www-form-urlencoded"
    );
  });
});

describe("signing an axios request in place", () => {
  test("sets Authorization and leaves a bodiless GET bodiless", () => {
    const config = { headers: {} };
    signAxiosRequest(RRIOT, "/user/homes/1", config);

    expect(config.headers.Authorization).toMatch(/^Hawk id="user-u"/);
    expect(config.data).toBeUndefined();
    expect(config.headers["Content-Type"]).toBeUndefined();
  });

  test("serialises an object body once and declares it as JSON", () => {
    const config = { headers: {}, data: { enabled: true } };
    signAxiosRequest(RRIOT, "/user/scene/1/param", config);

    expect(config.data).toBe('{"enabled":true}');
    expect(config.headers["Content-Type"]).toBe("application/json");
  });

  test("declares a form string as a form and respects a content type already set", () => {
    const form = { headers: {}, data: "enabled=true" };
    signAxiosRequest(RRIOT, "/user/scene/1/enable", form);
    expect(form.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );

    const explicit = {
      headers: { "content-type": "application/json; charset=utf-8" },
      data: "enabled=true",
    };
    signAxiosRequest(RRIOT, "/user/scene/1/enable", explicit);
    expect(explicit.headers["content-type"]).toBe(
      "application/json; charset=utf-8"
    );
    expect(explicit.headers["Content-Type"]).toBeUndefined();
  });

  test("the signature is over the bytes that will actually be sent", () => {
    const config = { headers: {}, data: { enabled: false } };
    signAxiosRequest(RRIOT, "/user/scene/1/param", config);

    const ts = /ts="(\d+)"/.exec(config.headers.Authorization)[1];
    const nonce = /nonce="([^"]+)"/.exec(config.headers.Authorization)[1];
    expect(macOf(config.headers.Authorization)).toBe(
      pythonRoborockMac({
        rriot: RRIOT,
        url: "/user/scene/1/param",
        body: config.data,
        timestamp: Number(ts),
        nonce,
      })
    );
  });
});

describe("through a real axios instance", () => {
  const axios = require("axios");

  function makeApi() {
    const sent = [];
    const api = axios.create({
      baseURL: "https://api-eu.roborock.com",
      adapter: async (config) => {
        sent.push(config);
        return {
          data: { success: true },
          status: 200,
          statusText: "OK",
          headers: {},
          config,
        };
      },
    });
    api.interceptors.request.use((config) => {
      const url = new URL(api.getUri(config));
      signAxiosRequest(RRIOT, url.pathname, config);
      return config;
    });
    return { api, sent };
  }

  test("a JSON PUT reaches the adapter as the signed bytes with the JSON content type", async () => {
    const { api, sent } = makeApi();
    const body = JSON.stringify({ triggers: [], action: { type: "S" } });

    await api.put("user/scene/778257/param", body, {
      headers: { "Content-Type": "application/json" },
    });

    const [config] = sent;
    expect(config.data).toBe(body);
    expect(String(config.headers["Content-Type"])).toMatch(/application\/json/);
    const ts = /ts="(\d+)"/.exec(config.headers.Authorization)[1];
    const nonce = /nonce="([^"]+)"/.exec(config.headers.Authorization)[1];
    expect(macOf(config.headers.Authorization)).toBe(
      pythonRoborockMac({
        rriot: RRIOT,
        url: "/user/scene/778257/param",
        body,
        timestamp: Number(ts),
        nonce,
      })
    );
  });

  test("a form PUT keeps its form content type and its exact string", async () => {
    const { api, sent } = makeApi();

    await api.put("user/scene/778257/enable", formBody({ enabled: false }), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    const [config] = sent;
    expect(config.data).toBe("enabled=false");
    expect(String(config.headers["Content-Type"])).toMatch(
      /application\/x-www-form-urlencoded/
    );
  });

  test("a GET is signed with an empty body slot, as every reader always was", async () => {
    const { api, sent } = makeApi();
    await api.get("user/scene/device/duid-1");

    const [config] = sent;
    expect(config.data).toBeUndefined();
    const ts = /ts="(\d+)"/.exec(config.headers.Authorization)[1];
    const nonce = /nonce="([^"]+)"/.exec(config.headers.Authorization)[1];
    expect(macOf(config.headers.Authorization)).toBe(
      pythonRoborockMac({
        rriot: RRIOT,
        url: "/user/scene/device/duid-1",
        timestamp: Number(ts),
        nonce,
      })
    );
  });
});
