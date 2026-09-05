"use strict";

/**
 * The three cloud scene calls this plugin makes, and the two conditions on
 * the two that write:
 *
 * - a write is sent only after the route's own `Allow` header has named the
 *   verb (the gate promised in #22, now a runtime check rather than a probe);
 * - each write travels in the exact shape measured on the owner's account —
 *   `param` as a JSON body, `enable` as a form body — because the cloud
 *   answered `400 parameter.error` to the other shape.
 *
 * The client stand-in records every call and refuses anything but the verbs
 * these methods are allowed to use.
 */

const { Roborock } = require("../roborockLib/roborockAPI");

function makeLog() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  return {
    lines,
    debug: (m) => lines.debug.push(String(m)),
    info: (m) => lines.info.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
    error: (m) => lines.error.push(String(m)),
  };
}

function makeAdapter(client) {
  const api = Object.create(Roborock.prototype);
  api.log = makeLog();
  api.config = { debug: false };
  api.api = client;
  api.describeDevice = (duid) => String(duid);
  return api;
}

/**
 * @param {object} options
 * @param {Record<string, unknown>} [options.gets] GET answers by path
 * @param {Record<string, string | undefined>} [options.allows] Allow header by OPTIONS path
 * @param {Record<string, unknown>} [options.writes] PUT/POST answers by path
 */
function makeClient({ gets = {}, allows = {}, writes = {} } = {}) {
  const calls = [];
  const envelope = (result) => ({ data: { success: true, result } });

  return {
    calls,
    async get(path) {
      calls.push({ method: "get", path });
      if (!(path in gets)) throw new Error(`unexpected GET ${path}`);
      const answer = gets[path];
      return typeof answer === "function" ? answer() : answer;
    },
    async options(path) {
      calls.push({ method: "options", path });
      const allow = allows[path];
      return { data: "", headers: allow === undefined ? {} : { allow } };
    },
    async put(path, body, config) {
      calls.push({ method: "put", path, body, config });
      if (!(path in writes)) throw new Error(`unexpected PUT ${path}`);
      const answer = writes[path];
      return typeof answer === "function" ? answer() : answer ?? envelope(null);
    },
    async post(path, body, config) {
      calls.push({ method: "post", path, body, config });
      if (!(path in writes)) throw new Error(`unexpected POST ${path}`);
      const answer = writes[path];
      return typeof answer === "function" ? answer() : answer ?? envelope(null);
    },
    async delete(path) {
      calls.push({ method: "delete", path });
      throw new Error(`this project never DELETEs a scene (${path})`);
    },
  };
}

const DUID = "duid-a144";
const SCENES_PATH = `user/scene/device/${DUID}`;
const SCENE = {
  id: 14303871,
  name: "Saugen+",
  param: JSON.stringify({
    triggers: [
      {
        id: 7033921,
        name: "TIMER",
        type: "TIMER",
        entityId: "",
        param:
          '{"cron": "0 9 * * 3", "type": "NORMAL", "enabled": true, "repeated": true, "timeZoneId": "Europe/Berlin"}',
      },
    ],
    action: { type: "S", items: [] },
  }),
  enabled: true,
  extra: null,
  type: "WORKFLOW",
};

describe("reading a robot's Routines", () => {
  test("returns the cloud's list, objects only", async () => {
    const client = makeClient({
      gets: {
        [SCENES_PATH]: { data: { success: true, result: [SCENE, null, 7] } },
      },
    });
    const api = makeAdapter(client);

    const scenes = await api.getCloudScenes(DUID);

    expect(scenes).toEqual([SCENE]);
    expect(client.calls).toEqual([{ method: "get", path: SCENES_PATH }]);
  });

  test("a refusal in the envelope is an error, never an empty list", async () => {
    const api = makeAdapter(
      makeClient({
        gets: {
          [SCENES_PATH]: {
            data: { success: false, code: "auth.err", msg: "nope" },
          },
        },
      })
    );

    await expect(api.getCloudScenes(DUID)).rejects.toThrow(/auth\.err/);
  });

  test("an answer that is not a list is an error, never an empty list", async () => {
    const api = makeAdapter(
      makeClient({ gets: { [SCENES_PATH]: { data: { result: null } } } })
    );

    await expect(api.getCloudScenes(DUID)).rejects.toThrow(
      /not answer with a list/
    );
  });

  test("no client and no robot are both errors", async () => {
    const api = makeAdapter(null);
    await expect(api.getCloudScenes(DUID)).rejects.toThrow(/not initialised/);

    const withClient = makeAdapter(makeClient());
    await expect(withClient.getCloudScenes("")).rejects.toThrow(/robot id/);
  });
});

describe("the Allow gate", () => {
  test("parses the header as a list of whole tokens", () => {
    const api = makeAdapter(makeClient());
    expect(api.allowHeaderNames("PUT,OPTIONS", "PUT")).toBe(true);
    expect(api.allowHeaderNames("PUT, OPTIONS", "options")).toBe(true);
    expect(api.allowHeaderNames("PUT,OPTIONS", "UT")).toBe(false);
    expect(api.allowHeaderNames("DELETE,OPTIONS", "PUT")).toBe(false);
    expect(api.allowHeaderNames(undefined, "PUT")).toBe(false);
    expect(api.allowHeaderNames("", "PUT")).toBe(false);
  });

  test("asks once per route per session when the answer is yes", async () => {
    const client = makeClient({
      allows: { "user/scene/1/param": "PUT,OPTIONS" },
    });
    const api = makeAdapter(client);

    const first = await api.cloudSceneRouteAllows(1, "param", "PUT");
    const second = await api.cloudSceneRouteAllows(2, "param", "PUT");

    expect(first).toEqual({ allowed: true, allow: "PUT,OPTIONS" });
    expect(second).toEqual({ allowed: true, allow: "PUT,OPTIONS" });
    // The second scene did not cost a second question: the header is per
    // route, and the servlet maps the route once.
    expect(client.calls.filter((c) => c.method === "options")).toHaveLength(1);
  });

  test("does not cache a no, so a transient failure to answer is asked again", async () => {
    const client = makeClient({ allows: {} });
    const api = makeAdapter(client);

    expect(await api.cloudSceneRouteAllows(1, "enable", "PUT")).toEqual({
      allowed: false,
      allow: undefined,
    });
    expect(await api.cloudSceneRouteAllows(1, "enable", "PUT")).toEqual({
      allowed: false,
      allow: undefined,
    });
    expect(client.calls.filter((c) => c.method === "options")).toHaveLength(2);
  });

  test("reads the header off a refusal too", async () => {
    const client = makeClient();
    client.options = async (path) => {
      client.calls.push({ method: "options", path });
      const error = new Error("Request failed with status code 405");
      error.response = { status: 405, headers: { allow: "PUT,OPTIONS" } };
      throw error;
    };
    const api = makeAdapter(client);

    expect(await api.cloudSceneRouteAllows(1, "param", "PUT")).toEqual({
      allowed: true,
      allow: "PUT,OPTIONS",
    });
  });
});

describe("switching a schedule through the scene's param", () => {
  const PARAM_PATH = "user/scene/14303871/param";

  test("is refused, with no PUT sent, when the route does not offer PUT", async () => {
    const client = makeClient({
      allows: { [PARAM_PATH]: "DELETE,OPTIONS" },
      writes: { [PARAM_PATH]: undefined },
    });
    const api = makeAdapter(client);

    await expect(
      api.updateCloudSceneParam(14303871, { triggers: [], action: {} })
    ).rejects.toThrow(
      /does not offer PUT on user\/scene\/\{id\}\/param \(Allow: DELETE,OPTIONS\)/
    );

    expect(client.calls.some((c) => c.method === "put")).toBe(false);
  });

  test("sends the param object as a JSON body, declared as JSON", async () => {
    const client = makeClient({
      allows: { [PARAM_PATH]: "PUT,OPTIONS" },
      writes: { [PARAM_PATH]: undefined },
    });
    const api = makeAdapter(client);
    const param = JSON.parse(SCENE.param);

    await api.updateCloudSceneParam(14303871, param);

    const put = client.calls.find((c) => c.method === "put");
    expect(put.path).toBe(PARAM_PATH);
    expect(put.body).toBe(JSON.stringify(param));
    expect(put.config.headers["Content-Type"]).toBe("application/json");
  });

  test("a 200 whose envelope says success:false is still a failure", async () => {
    const client = makeClient({
      allows: { [PARAM_PATH]: "PUT,OPTIONS" },
      writes: {
        [PARAM_PATH]: {
          data: { success: false, code: "scene.err", msg: "not yours" },
        },
      },
    });
    const api = makeAdapter(client);

    await expect(
      api.updateCloudSceneParam(14303871, { triggers: [] })
    ).rejects.toThrow(/scene\.err/);
  });

  test("refuses to send anything but an object", async () => {
    const api = makeAdapter(makeClient());
    await expect(api.updateCloudSceneParam(1, "{}")).rejects.toThrow(/object/);
    await expect(api.updateCloudSceneParam(1, [1])).rejects.toThrow(/object/);
  });
});

describe("switching a scene at scene level", () => {
  const ENABLE_PATH = "user/scene/14303871/enable";

  test("sends a form body, because a JSON body is answered 400 parameter.error", async () => {
    const client = makeClient({
      allows: { [ENABLE_PATH]: "PUT,OPTIONS" },
      writes: { [ENABLE_PATH]: undefined },
    });
    const api = makeAdapter(client);

    await api.setCloudSceneEnabled(14303871, false);

    const put = client.calls.find((c) => c.method === "put");
    expect(put.path).toBe(ENABLE_PATH);
    expect(put.body).toBe("enabled=false");
    expect(put.config.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );
  });

  test("is refused when the route does not offer PUT", async () => {
    const client = makeClient({ allows: {} });
    const api = makeAdapter(client);

    await expect(api.setCloudSceneEnabled(14303871, true)).rejects.toThrow(
      /does not offer PUT on user\/scene\/\{id\}\/enable/
    );
    expect(client.calls.some((c) => c.method === "put")).toBe(false);
  });
});

describe("running a Routine", () => {
  test("posts to execute, the route every open-source client agrees on", async () => {
    const client = makeClient({
      writes: { "user/scene/14303871/execute": undefined },
    });
    const api = makeAdapter(client);

    await api.executeCloudScene(14303871);

    expect(client.calls).toEqual([
      {
        method: "post",
        path: "user/scene/14303871/execute",
        body: undefined,
        config: undefined,
      },
    ]);
  });

  test("a refusal in the envelope is an error", async () => {
    const api = makeAdapter(
      makeClient({
        writes: {
          "user/scene/1/execute": {
            data: { success: false, msg: "device offline" },
          },
        },
      })
    );

    await expect(api.executeCloudScene(1)).rejects.toThrow(/device offline/);
  });
});

describe("what this project never sends", () => {
  test("no method here issues DELETE, however plainly the resource offers it", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "roborockLib", "roborockAPI.js"),
      "utf8"
    );
    const start = source.indexOf("  allowHeaderNames(allow, verb) {");
    const end = source.indexOf("  assertCloudWriteSucceeded(response, path) {");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const sceneWrites = source.slice(start, end);
    expect(sceneWrites).not.toMatch(/this\.api\.delete\(/);
    expect(sceneWrites).not.toMatch(/["'`]delete["'`]/i);
  });
});
