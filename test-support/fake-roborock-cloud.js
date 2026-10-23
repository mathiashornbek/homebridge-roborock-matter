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
//   POST api/v1/getUrlByEmail, POST api/v3/key/sign, POST
//   api/v4/email/code/send, POST api/v4/auth/email/login/code, POST
//   api/v4/auth/email/login/pwd and GET api/v1/getHomeDetail (token in
//   `Authorization`);
// - IoT API (`rriot.r.a`, Hawk-signed): GET [v2/]user/homes/{id}, GET
//   user/scene/device/{duid}, GET user/deviceshare/query/{duid}/rooms.
//
// The user-agreement lookup is Roborock's, not the server's: with
// `agreement` set, GET api/v3/app/agreement/latest names that version and a
// login carrying another is refused with 3006, as Roborock's servers do. Left
// unset, the fake is local_roborock_server, whose v3 route is not public — it
// falls under the token rule like every other non-public /api/ route — and
// whose login reads no version. (Its one agreement handler,
// /api/v4/app/agreement/latest, is token-protected too and names the app's
// documents, not a login version.)
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

/** The app's password encryption, reversed: AES-128-ECB keyed by the signed k. */
function decryptPassword(encrypted, k) {
  try {
    const decipher = crypto.createDecipheriv(
      "aes-128-ecb",
      Buffer.from(k.slice(4) + k.slice(0, 4), "utf8"),
      null
    );
    return (
      decipher.update(encrypted, "base64", "utf8") + decipher.final("utf8")
    );
  } catch {
    return null;
  }
}

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
    agreement: null,
    passwordLogin: "unsupported",
    ...options,
  };

  /** Every request, in order, for assertions. */
  const requests = [];
  /** Requests being answered, and when anything last happened. */
  const activity = { inFlight: 0, at: process.hrtime.bigint() };
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
    activity.inFlight -= 1;
    activity.at = process.hrtime.bigint();
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
    activity.inFlight += 1;
    activity.at = process.hrtime.bigint();

    const queue = scripted.get(pathname);
    if (queue && queue.length > 0) {
      const next = queue.shift();
      if (next.delayMs) {
        // Answer normally, later: a slow server.
        setTimeout(
          () => answer(req, res, body, pathname, parsed, form),
          next.delayMs
        );
        return;
      }
      if (next.hang || next.destroy) {
        activity.inFlight -= 1;
      }
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

    return answer(req, res, body, pathname, parsed, form);
  }

  /** The server's own answer to one request. */
  function answer(req, res, body, pathname, parsed, form) {
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
        // local_roborock_server: a non-public route under the token rule.
        return send(res, 401, { code: 2010, msg: "invalid_credentials" });
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
        ? decryptPassword(form.get("password"), k) === config.password
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
    // local_roborock_server serves the home under /, /v2, /v3 and /v4.
    const home = pathname.match(/^\/(?:v[234]\/)?user\/homes\/(\d+)$/);
    if (req.method === "GET" && home && Number(home[1]) === config.homeId) {
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
    /** Queue one-shot answers for a path: `{status, body}`, `{delayMs}`, `{hang}` or `{destroy}`. */
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
    /**
     * Wait (real time) until nothing has reached or left this server for a
     * moment, so the I/O a fired timer started has finished.
     */
    async quiet(idleMs = 50, maxMs = 3000) {
      const start = process.hrtime.bigint();
      const idle = BigInt(idleMs) * 1_000_000n;
      while (process.hrtime.bigint() - start < BigInt(maxMs) * 1_000_000n) {
        // Idle since the later of the last request and this call: whatever
        // fired just before is given time to send its first request.
        const since = activity.at > start ? activity.at : start;
        if (activity.inFlight <= 0 && process.hrtime.bigint() - since > idle) {
          return;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
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
