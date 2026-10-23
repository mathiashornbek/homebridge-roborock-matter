"use strict";

const crypto = require("crypto");
const axios = require("axios");

const API_V3_SIGN = "api/v3/key/sign";
const API_V4_LOGIN_CODE = "api/v4/auth/email/login/code";
const API_V4_LOGIN_PASSWORD = "api/v4/auth/email/login/pwd";
const API_V4_EMAIL_CODE = "api/v4/email/code/send";

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

function createLoginApi({ baseURL, username, clientID, language }) {
  return axios.create({
    baseURL: `https://${normalizeBaseURL(baseURL)}`,
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
    throw new Error(
      `Roborock answered the home details with ${JSON.stringify(envelope)}`
    );
  }
  return homeId;
}

async function signRequest(loginApi, s) {
  const res = await loginApi.post(`${API_V3_SIGN}?s=${s}`);
  return res.data && res.data.data ? res.data.data : null;
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
  { email, code, country, countryCode, k, s }
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
    majorVersion: "14",
    minorVersion: "0",
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

async function loginByPassword(loginApi, { email, password, k, s }) {
  const headers = {
    "x-mercy-k": k,
    "x-mercy-ks": s,
  };

  const params = new URLSearchParams({
    email,
    password: encryptPassword(password, k),
    majorVersion: "14",
    minorVersion: "0",
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
  SESSION_REJECTED_CODE,
  getHomeId,
  isSessionRejected,
  createLoginApi,
  getRegionConfig,
  signRequest,
  requestEmailCode,
  loginWithCode,
  loginByPassword,
};
