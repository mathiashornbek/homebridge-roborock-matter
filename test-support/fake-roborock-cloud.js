"use strict";

// A fake Roborock account server on 127.0.0.1, over real HTTPS, so the
// plugin's own axios clients, Hawk signer and login code run unmodified
// against it.
//
// Its routes and answers follow Python-roborock/local_roborock_server, which
// emulates the cloud closely enough for Home Assistant and python-roborock to
// log in against it (see the research notes on issue #43):
//
// - account/login API (the region server, or the custom server URL):
//   POST api/v1/getUrlByEmail, POST api/v3/key/sign, GET
//   api/v3/app/agreement/latest, POST api/v4/email/code/send, POST
//   api/v4/auth/email/login/code, POST api/v4/auth/email/login/pwd and GET
//   api/v1/getHomeDetail (token in `Authorization`);
// - IoT API (`rriot.r.a`, Hawk-signed): GET v2/user/homes/{id}, GET
//   user/scene/device/{duid}, GET user/deviceshare/query/{duid}/rooms.
//
// Failure answers are the server's own: a wrong email or PIN, and a token it
// no longer knows, are HTTP 401 `{"code":2010,"msg":"invalid_credentials"}`;
// a Hawk header that does not verify — wrong MAC, a timestamp more than 300 s
// off, or a nonce seen in the last 600 s — is HTTP 401 `{"code":40101}`.
//
// The certificate is a self-signed test-only one for localhost/127.0.0.1.
// The plugin keeps full TLS verification; a test trusts this certificate by
// adding it to the CA list of Node's global HTTPS agent (`trust()`), which is
// what NODE_EXTRA_CA_CERTS does for a real self-hosted server.

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");

const CERT = fs.readFileSync(
  path.join(__dirname, "local-roborock-server", "test-only-cert.pem")
);
const KEY = fs.readFileSync(
  path.join(__dirname, "local-roborock-server", "test-only-key.pem")
);

const md5hex = (value) => crypto.createHash("md5").update(value).digest("hex");
const hex = (bytes) => crypto.randomBytes(bytes).toString("hex");

/**
 * @param {{
 *   email?: string,
 *   pin?: string,
 *   password?: string,
 *   homeId?: number,
 *   homeData?: object,
 *   scenes?: Record<string, object[]>,
 *   sharedRooms?: Record<string, object[]>,
 *   country?: string | null,
 *   countryCode?: string | null,
 *   agreement?: {majorVersion: number, minorVersion: number} | null,
 *   passwordLogin?: "supported" | "unsupported",
 * }} [options]
 */
async function startFakeRoborockCloud(options = {}) {
  const config = {
    email: "owner@example.com",
    pin: "123456",
    password: null,
    homeId: 4242,
    homeData: { products: [], devices: [], receivedDevices: [], rooms: [] },
    scenes: {},
    sharedRooms: {},
    country: "DE",
    countryCode: "49",
    agreement: { majorVersion: 15, minorVersion: 1 },
    passwordLogin: "unsupported",
    ...options,
  };

  /** Every request, in order, for assertions. */
  const requests = [];
  /** Sessions this server has issued and not revoked, by token. */
  const sessions = new Map();
  const signedKeys = new Map();
  const seenNonces = new Map();
  /** One-shot answers queued per route, e.g. a 500 or a 2010. */
  const scripted = new Map();
  let url = "";

  function issueSession() {
    const userData = {
      uid: 1234,
      rruid: "rr-fake-user",
      token: `rr${hex(16)}`,
      region: "eu",
      countrycode: config.countryCode,
      country: config.country,
      nickname: "Fake",
      rriot: {
        u: hex(11),
        s: hex(6),
        h: hex(16),
        k: hex(16),
        r: {
          r: "EU",
          a: url,
          m: "ssl://localhost:8881",
          l: url,
        },
      },
    };
    sessions.set(userData.token, userData);
    return userData;
  }

  function send(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  function verifyHawk(req, pathname, body) {
    const header = String(req.headers.authorization || "");
    const fields = Object.fromEntries(
      [...header.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]])
    );
    const session = [...sessions.values()].find(
      (candidate) =>
        candidate.rriot.u === fields.id && candidate.rriot.s === fields.s
    );
    if (!header.startsWith("Hawk ") || !session) {
      return { ok: false, reason: "unknown_hawk_id" };
    }
    const ts = Number(fields.ts);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
      return { ok: false, reason: "hawk_clock_skew" };
    }
    const nonceKey = `${fields.id}:${fields.nonce}`;
    const seenAt = seenNonces.get(nonceKey);
    if (seenAt !== undefined && Date.now() - seenAt < 600_000) {
      return { ok: false, reason: "replayed_hawk_nonce" };
    }
    const prestr = [
      session.rriot.u,
      session.rriot.s,
      fields.nonce,
      fields.ts,
      md5hex(pathname),
      "",
      body.length ? md5hex(body) : "",
    ].join(":");
    const mac = crypto
      .createHmac("sha256", session.rriot.h)
      .update(prestr)
      .digest("base64");
    if (mac !== fields.mac) {
      return { ok: false, reason: "invalid_hawk_mac" };
    }
    seenNonces.set(nonceKey, Date.now());
    return { ok: true, session };
  }

  function route(req, res, body) {
    const parsed = new URL(req.url, url);
    const pathname = parsed.pathname;
    const form = new URLSearchParams(body.toString("utf8"));
    const record = {
      method: req.method,
      path: pathname,
      query: Object.fromEntries(parsed.searchParams),
      form: Object.fromEntries(form),
      headers: req.headers,
    };
    requests.push(record);

    const queue = scripted.get(pathname);
    if (queue && queue.length > 0) {
      const next = queue.shift();
      if (next.hang) {
        // Never answers: what a stuck cloud looks like to the client.
        return;
      }
      if (next.destroy) {
        req.socket.destroy();
        return;
      }
      return send(res, next.status ?? 200, next.body);
    }

    if (req.method === "POST" && pathname === "/api/v1/getUrlByEmail") {
      return send(res, 200, {
        code: 200,
        msg: "success",
        data: {
          url,
          country: config.country,
          countrycode: config.countryCode,
        },
      });
    }
    if (req.method === "POST" && pathname === "/api/v3/key/sign") {
      const k = hex(8);
      signedKeys.set(k, parsed.searchParams.get("s"));
      return send(res, 200, { code: 200, msg: "success", data: { k } });
    }
    if (req.method === "GET" && pathname === "/api/v3/app/agreement/latest") {
      if (!config.agreement) {
        return send(res, 200, { code: 500, msg: "unavailable", data: null });
      }
      return send(res, 200, {
        code: 200,
        msg: "success",
        data: config.agreement,
      });
    }
    if (req.method === "POST" && pathname === "/api/v4/email/code/send") {
      return send(res, 200, {
        code: 200,
        msg: "success",
        data: { sent: true, validForSec: 300 },
      });
    }
    if (
      req.method === "POST" &&
      (pathname === "/api/v4/auth/email/login/code" ||
        pathname === "/api/v4/auth/email/login/pwd")
    ) {
      const isPassword = pathname.endsWith("/pwd");
      if (isPassword && config.passwordLogin !== "supported") {
        // Not a public route on local_roborock_server: it falls under the
        // token rule and is refused as invalid credentials.
        return send(res, 401, { code: 2010, msg: "invalid_credentials" });
      }
      const k = req.headers["x-mercy-k"];
      if (!k || signedKeys.get(k) !== req.headers["x-mercy-ks"]) {
        return send(res, 200, { code: 2002, msg: "sign error", data: null });
      }
      // A signature is good for one login, as the app uses it.
      signedKeys.delete(k);
      if (
        config.agreement &&
        (Number(form.get("majorVersion")) !== config.agreement.majorVersion ||
          Number(form.get("minorVersion")) !== config.agreement.minorVersion)
      ) {
        return send(res, 200, {
          code: 3006,
          msg: "user agreement version is not up-to-date",
          data: null,
        });
      }
      if (form.get("email") !== config.email) {
        return send(res, 401, {
          code: 2010,
          msg: "invalid_credentials",
          data: { reason: "invalid_login_email" },
        });
      }
      const secretOk = isPassword
        ? Boolean(config.password) && form.get("password")
        : form.get("code") === config.pin;
      if (!secretOk) {
        return send(res, 401, {
          code: 2010,
          msg: "invalid_credentials",
          data: { reason: "invalid_login_pin" },
        });
      }
      return send(res, 200, {
        code: 200,
        msg: "success",
        data: issueSession(),
      });
    }
    if (req.method === "GET" && pathname === "/api/v1/getHomeDetail") {
      const token = String(req.headers.authorization || "").replace(
        /^Bearer /,
        ""
      );
      if (!sessions.has(token)) {
        return send(res, 401, { code: 2010, msg: "invalid_credentials" });
      }
      return send(res, 200, {
        code: 200,
        msg: "success",
        data: { rrHomeId: config.homeId, deviceListOrder: null },
      });
    }

    const hawk = verifyHawk(req, pathname, body);
    if (!hawk.ok) {
      return send(res, 401, {
        code: 40101,
        msg: "authentication_required",
        data: { reason: hawk.reason },
      });
    }
    if (
      req.method === "GET" &&
      pathname === `/v2/user/homes/${config.homeId}`
    ) {
      return send(res, 200, { success: true, result: config.homeData });
    }
    const scenes = pathname.match(/^\/user\/scene\/device\/([^/]+)$/);
    if (req.method === "GET" && scenes) {
      return send(res, 200, {
        success: true,
        result: config.scenes[scenes[1]] || [],
      });
    }
    const shared = pathname.match(
      /^\/user\/deviceshare\/query\/([^/]+)\/rooms$/
    );
    if (req.method === "GET" && shared) {
      return send(res, 200, {
        success: true,
        result: config.sharedRooms[shared[1]] || [],
      });
    }
    return send(res, 200, {
      success: true,
      result: { ok: true, route: pathname },
    });
  }

  const server = https.createServer({ cert: CERT, key: KEY }, (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => route(req, res, Buffer.concat(chunks)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  url = `https://localhost:${port}`;

  const previousCa = https.globalAgent.options.ca;

  return {
    url,
    host: `localhost:${port}`,
    requests,
    config,
    /** Requests to one path, in order. */
    requestsTo: (pathname) => requests.filter((r) => r.path === pathname),
    /** Queue one-shot answers for a path: `{status, body}`, `{hang}` or `{destroy}`. */
    script(pathname, ...answers) {
      scripted.set(pathname, [...(scripted.get(pathname) || []), ...answers]);
    },
    /** A valid session, as a completed login in the settings would store it. */
    issueSession,
    /** Forget every session, as Roborock does when a session is invalidated. */
    revokeAllSessions() {
      sessions.clear();
    },
    sessionCount: () => sessions.size,
    /** Trust this server's test certificate for the rest of the test file. */
    trust() {
      https.globalAgent.options.ca = [CERT];
    },
    async close() {
      https.globalAgent.options.ca = previousCa;
      https.globalAgent.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startFakeRoborockCloud };
