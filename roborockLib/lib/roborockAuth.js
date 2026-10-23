"use strict";

const crypto = require("crypto");
const axios = require("axios");

const API_V1_URL_BY_EMAIL = "api/v1/getUrlByEmail";
const API_V3_AGREEMENT = "api/v3/app/agreement/latest";
const API_V3_SIGN = "api/v3/key/sign";
const API_V4_LOGIN_CODE = "api/v4/auth/email/login/code";
const API_V4_LOGIN_PASSWORD = "api/v4/auth/email/login/pwd";
const API_V4_EMAIL_CODE = "api/v4/email/code/send";

// The agreement version a login sends when none is looked up.
const FALLBACK_AGREEMENT = Object.freeze({ majorVersion: 14, minorVersion: 0 });

// How long any request to Roborock's REST servers may take. Without one,
// axios waits forever on a server that never answers (a half-open TCP
// connection), and one such request wedged the account-wide queue every
// Routine and schedule switch goes through until Homebridge restarted.
// python-roborock relies on aiohttp's 300 s default; Roborock answers in well
// under a second, so 30 s only ever cuts off a request that is not coming.
const CLOUD_REQUEST_TIMEOUT_MS = 30_000;

const DEFAULT_HEADERS = {
  header_appversion: "4.54.02",
  header_clientlang: "en",
  header_phonemodel: "Pixel 7",
  header_phonesystem: "Android",
};

function normalizeBaseURL(baseURL) {
  if (!baseURL) {
    return "usiot.roborock.com";
  }
  return baseURL.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function parseHostname(baseURL) {
  try {
    return new URL(
      `https://${normalizeBaseURL(baseURL)}`
    ).hostname.toLowerCase();
  } catch {
    return normalizeBaseURL(baseURL).split("/")[0].split(":")[0].toLowerCase();
  }
}

/**
 * The custom server URL from the plugin settings, checked and reduced to
 * `https://host[:port]`, or an Error saying what is wrong with it.
 *
 * For a self-hosted Roborock server such as local_roborock_server (#43): the
 * login and the account API go there instead of a Roborock region, and
 * everything after the login follows the URLs the server's login answer
 * carries (`rriot.r.a` for the IoT API, `rriot.r.m` for MQTT), as for
 * Roborock's own servers. HTTPS only, with full certificate checks: the login
 * sends the account's email and PIN, and the answer is the session. A server
 * with a private certificate authority is trusted the Node way
 * (NODE_EXTRA_CA_CERTS), never by turning verification off.
 *
 * @param {unknown} value
 * @returns {string}
 */
function parseServerURL(value) {
  const text = typeof value === "string" ? value.trim() : "";
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(
      `The custom server URL "${text}" is not a URL. Enter it as https://host or https://host:port.`
    );
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `The custom server URL must start with https:// (got "${url.protocol}//"). The login sends your email and PIN, so it never goes over plain HTTP.`
    );
  }
  if (!url.hostname) {
    throw new Error("The custom server URL has no host name.");
  }
  if (url.username || url.password) {
    throw new Error(
      "The custom server URL must not contain a user name or password."
    );
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error(
      `The custom server URL must be just the server (https://host or https://host:port), without "${url.pathname}${url.search}${url.hash}".`
    );
  }
  return `https://${url.host}`;
}

function getRegionConfig(baseURL) {
  const hostname = parseHostname(baseURL);
  const labels = hostname.split(".").filter(Boolean);
  if (labels.includes("euiot")) {
    return { country: "DE", countryCode: "49" };
  }
  if (labels.includes("usiot")) {
    return { country: "US", countryCode: "1" };
  }
  if (labels.includes("cniot")) {
    return { country: "CN", countryCode: "86" };
  }
  if (labels.includes("ruiot")) {
    return { country: "RU", countryCode: "7" };
  }
  if (hostname === "api.roborock.com") {
    return { country: "SG", countryCode: "65" };
  }
  return { country: "US", countryCode: "1" };
}

function encryptPassword(password, k) {
  const derivedKey = k.slice(4) + k.slice(0, 4);
  const cipher = crypto.createCipheriv(
    "aes-128-ecb",
    Buffer.from(derivedKey, "utf-8"),
    null
  );
  cipher.setAutoPadding(true);
  let encrypted = cipher.update(password, "utf8", "base64");
  encrypted += cipher.final("base64");
  return encrypted;
}

function createLoginApi({
  baseURL,
  username,
  clientID,
  language,
  timeout = CLOUD_REQUEST_TIMEOUT_MS,
}) {
  return axios.create({
    baseURL: `https://${normalizeBaseURL(baseURL)}`,
    timeout,
    headers: {
      header_clientid: crypto
        .createHash("md5")
        .update(username)
        .update(clientID)
        .digest()
        .toString("base64"),
      header_clientlang: language || DEFAULT_HEADERS.header_clientlang,
      header_appversion: DEFAULT_HEADERS.header_appversion,
      header_phonemodel: DEFAULT_HEADERS.header_phonemodel,
      header_phonesystem: DEFAULT_HEADERS.header_phonesystem,
    },
  });
}

/**
 * getHomeDetail's answer for a session Roborock no longer accepts. It is the
 * one answer python-roborock reads as RoborockInvalidCredentials, and Home
 * Assistant re-authenticates on it instead of retrying.
 */
const SESSION_REJECTED_CODE = 2010;

/** @param {{msg?: unknown} | undefined} envelope */
function sessionRejectedError(envelope) {
  const detail = typeof envelope?.msg === "string" ? `, "${envelope.msg}"` : "";
  const error = /** @type {Error & {code: number, sessionRejected: true}} */ (
    new Error(
      `Roborock no longer accepts the saved login session (code ${SESSION_REJECTED_CODE}${detail})`
    )
  );
  error.code = SESSION_REJECTED_CODE;
  error.sessionRejected = true;
  return error;
}

/** @param {unknown} error */
function isSessionRejected(error) {
  return Boolean(
    error && /** @type {{sessionRejected?: unknown}} */ (error).sessionRejected
  );
}

/**
 * The account's home id from `api/v1/getHomeDetail`, read the way
 * python-roborock reads it: the envelope's `code` decides, and 2010 means the
 * session is dead rather than the network being down. Roborock answers in a
 * 200; local_roborock_server sends the same envelope with HTTP 401, which
 * axios throws, so the envelope is read from either.
 *
 * @param {import("axios").AxiosInstance} loginApi with the session token set
 * @returns {Promise<string | number>}
 */
async function getHomeId(loginApi) {
  let envelope;
  try {
    envelope = (await loginApi.get("api/v1/getHomeDetail")).data;
  } catch (error) {
    envelope = /** @type {any} */ (error)?.response?.data;
    if (!envelope || typeof envelope !== "object" || !("code" in envelope)) {
      throw error;
    }
  }
  if (envelope?.code === SESSION_REJECTED_CODE) {
    throw sessionRejectedError(envelope);
  }
  const homeId = envelope?.data?.rrHomeId;
  if (envelope?.code !== 200 || homeId === undefined || homeId === null) {
    const refusal = describeLoginRefusal(envelope);
    throw new Error(
      `Roborock answered the home details with ${JSON.stringify(envelope)}${refusal ? `. ${refusal.hint}` : ""}`
    );
  }
  return homeId;
}

async function signRequest(loginApi, s) {
  const res = await loginApi.post(`${API_V3_SIGN}?s=${s}`);
  return res.data && res.data.data ? res.data.data : null;
}

/** Sixteen random characters for `api/v3/key/sign`, as the app sends. */
function loginNonce() {
  return crypto
    .randomBytes(12)
    .toString("base64")
    .substring(0, 16)
    .replace(/\+/g, "X")
    .replace(/\//g, "Y");
}

/**
 * One login, the same for the plugin and the settings page: a fresh
 * `api/v3/key/sign` signature (python-roborock signs every login; reusing
 * one across attempts was finding 12), the account's country from the login
 * server, then the code login or the password login with the agreement
 * version for that country.
 *
 * Only Roborock's servers are asked for that version. local_roborock_server
 * (`customServer`) serves no such lookup — its v3 route sits behind the
 * session-token rule and answers a login with 2010 — and its login reads no
 * version, so the fallback goes out without asking.
 *
 * @param {import("axios").AxiosInstance} loginApi
 * @param {{email: string, server: string | undefined, customServer?: boolean, code?: string, password?: string}} credentials
 * @returns {Promise<Record<string, any>>} Roborock's answer envelope
 */
async function signedLogin(
  loginApi,
  { email, server, customServer = false, code, password }
) {
  const s = loginNonce();
  const signData = await signRequest(loginApi, s);
  if (!signData || !signData.k) {
    throw new Error("Failed to create login signature.");
  }
  const region = await getLoginRegion(loginApi, email, server);
  const agreement = customServer
    ? FALLBACK_AGREEMENT
    : await getAgreementVersion(loginApi, region.country);
  return code !== undefined
    ? loginWithCode(loginApi, {
        email,
        code,
        country: region.country,
        countryCode: region.countryCode,
        agreement,
        k: signData.k,
        s,
      })
    : loginByPassword(loginApi, {
        email,
        password,
        agreement,
        k: signData.k,
        s,
      });
}

/**
 * The account's country and phone country code, as python-roborock's
 * `_get_iot_login_info` reads them from `api/v1/getUrlByEmail` on the server
 * the login goes to. Guessing them from the host name made every EU account
 * German. Falls back to that guess when the server does not know the account
 * or does not answer, so this lookup can never be what stops a login.
 *
 * @param {import("axios").AxiosInstance} loginApi
 * @param {string} email
 * @param {string | undefined} baseURL
 * @returns {Promise<{country: string, countryCode: string}>}
 */
async function getLoginRegion(loginApi, email, baseURL) {
  const guess = getRegionConfig(baseURL);
  try {
    const query = new URLSearchParams({ email, needtwostepauth: "false" });
    const res = await loginApi.post(`${API_V1_URL_BY_EMAIL}?${query}`);
    const data = res?.data?.code === 200 ? res.data.data : null;
    if (data && (data.country || data.countrycode)) {
      return {
        country: String(data.country || guess.country),
        countryCode: String(data.countrycode || guess.countryCode),
      };
    }
  } catch {
    // The guess below.
  }
  return guess;
}

/**
 * The user-agreement version the server currently wants for this country.
 *
 * A login that sends an older one is refused with 3006 "user agreement
 * version is not up-to-date" — what the hard-coded 14.0 started doing in
 * September 2026 (python-roborock PR #960: euiot wants 15.1, ruiot 15.0,
 * usiot 16.0 for US accounts). Looked up per login, as python-roborock
 * 7.8.2+ does, with 14.0 kept only for a lookup that fails.
 *
 * @param {import("axios").AxiosInstance} loginApi
 * @param {string} country two-letter code
 * @returns {Promise<{majorVersion: number, minorVersion: number}>}
 */
async function getAgreementVersion(loginApi, country) {
  try {
    const res = await loginApi.get(API_V3_AGREEMENT, { params: { country } });
    const data = res?.data?.code === 200 ? res.data.data : null;
    if (
      Number.isInteger(data?.majorVersion) &&
      Number.isInteger(data?.minorVersion)
    ) {
      return {
        majorVersion: data.majorVersion,
        minorVersion: data.minorVersion,
      };
    }
  } catch {
    // The fallback below.
  }
  return FALLBACK_AGREEMENT;
}

/**
 * Login refusals that asking again cannot change, and what the user can do
 * about each. Codes from python-roborock 7.13.0 (`web_api.py`) and the field
 * reports collected for issue #43. `later` marks a block that lifts by
 * itself: it is waited out, never retried on the short loop, because every
 * attempt counts against the limit that caused it.
 *
 * @type {Record<number, {hint: string, later?: true, credentials?: true}>}
 */
const LOGIN_REFUSALS = {
  2003: {
    hint: "Roborock does not accept the email address as written. Check it in the plugin settings.",
    credentials: true,
  },
  2008: {
    hint: "Roborock has no account with this email address on the selected region's server. Check the email and the Region in the plugin settings.",
    credentials: true,
  },
  2010: {
    hint: "The server rejected the login. Check the email and the password or code in the plugin settings (for a custom server, the PIN it was set up with).",
    credentials: true,
  },
  2012: {
    hint: "Roborock rejected the email or password. Check them in the plugin settings.",
    credentials: true,
  },
  2018: {
    hint: "The verification code is wrong or has expired. Request a new one in the plugin settings.",
    credentials: true,
  },
  2031: {
    hint: "Roborock requires an emailed verification code for this account. Log in with the code in the plugin settings.",
  },
  3006: {
    hint: "Roborock asks for the user agreement to be accepted again: in the Roborock app, revoke and accept the user agreement (Profile, About, User Agreement), then log in again. A Mi Home account cannot be used here.",
  },
  3009: {
    hint: "Accept the user agreement in the Roborock app first, then log in again.",
  },
  3039: {
    hint: "This account does not exist on the selected region's server. Choose the region the account was created in, in the plugin settings.",
    credentials: true,
  },
  9002: {
    hint: "Too many verification codes were requested. Wait before requesting another one.",
    later: true,
  },
  9004: {
    hint: "Roborock has blocked sign-in for this account for a while after too many attempts.",
    later: true,
  },
  // local_roborock_server (HTTP 412 cloud_user_data_required): its one-time
  // import of the Roborock account has not been done.
  41201: {
    hint: "The custom server has no data from your Roborock account yet. Run its one-time cloud import first (in the server's admin page, sign in to your Roborock account and fetch the cloud data), then log in again.",
  },
};

/**
 * The refusal behind a login answer, or null when the answer is not one of
 * the known refusals.
 *
 * @param {{code?: unknown, msg?: unknown} | null | undefined} envelope
 */
function describeLoginRefusal(envelope) {
  const refusal = LOGIN_REFUSALS[Number(envelope?.code)];
  return refusal
    ? { code: Number(envelope?.code), msg: envelope?.msg, ...refusal }
    : null;
}

/**
 * An Error for a refused login that keeps Roborock's answer in its message
 * and the classification on `refusal`.
 *
 * @param {Record<string, unknown> | null | undefined} envelope
 */
function loginRefusedError(envelope) {
  const error = /** @type {Error & {code?: number, refusal?: any}} */ (
    new Error(`Login failed: ${JSON.stringify(envelope)}`)
  );
  const refusal = describeLoginRefusal(envelope);
  if (refusal) {
    error.code = refusal.code;
    error.refusal = refusal;
  }
  return error;
}

async function requestEmailCode(loginApi, email) {
  const params = new URLSearchParams();
  params.append("type", "login");
  params.append("email", email);
  params.append("platform", "");

  try {
    const res = await loginApi.post(API_V4_EMAIL_CODE, params.toString());
    if (res.data && res.data.code !== 200) {
      throw new Error(
        `Send code failed: ${res.data.msg || "Unknown error"} (Code: ${res.data.code})`
      );
    }
    return res.data;
  } catch (error) {
    if (error.response && error.response.data) {
      throw new Error(
        `Send code failed: ${JSON.stringify(error.response.data)}`
      );
    }
    throw error;
  }
}

async function loginWithCode(
  loginApi,
  { email, code, country, countryCode, agreement, k, s }
) {
  const headers = {
    "x-mercy-k": k,
    "x-mercy-ks": s,
  };

  const params = new URLSearchParams({
    country,
    countryCode,
    email,
    code,
    majorVersion: String(agreement.majorVersion),
    minorVersion: String(agreement.minorVersion),
  });

  try {
    const res = await loginApi.post(API_V4_LOGIN_CODE, params.toString(), {
      headers,
    });
    return res.data;
  } catch (error) {
    if (error.response && error.response.data) {
      return error.response.data;
    }
    throw error;
  }
}

async function loginByPassword(loginApi, { email, password, agreement, k, s }) {
  const headers = {
    "x-mercy-k": k,
    "x-mercy-ks": s,
  };

  const params = new URLSearchParams({
    email,
    password: encryptPassword(password, k),
    majorVersion: String(agreement.majorVersion),
    minorVersion: String(agreement.minorVersion),
  });

  try {
    const res = await loginApi.post(API_V4_LOGIN_PASSWORD, params.toString(), {
      headers,
    });
    return res.data;
  } catch (error) {
    if (error.response && error.response.data) {
      return error.response.data;
    }
    throw error;
  }
}

module.exports = {
  CLOUD_REQUEST_TIMEOUT_MS,
  SESSION_REJECTED_CODE,
  getHomeId,
  isSessionRejected,
  createLoginApi,
  describeLoginRefusal,
  getAgreementVersion,
  getLoginRegion,
  getRegionConfig,
  loginRefusedError,
  parseServerURL,
  signedLogin,
  signRequest,
  requestEmailCode,
  loginWithCode,
  loginByPassword,
};
