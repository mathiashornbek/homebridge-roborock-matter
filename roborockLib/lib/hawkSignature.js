"use strict";

/**
 * Roborock's Hawk-style request signature, in one place and measured.
 *
 * Every request to the account API (`rriot.r.a`) carries
 *
 *   Authorization: Hawk id="u", s="s", ts="<unix seconds>", nonce="<6 chars>", mac="<base64>"
 *
 * where the MAC is HMAC-SHA256 over seven colon-joined slots:
 *
 *   u : s : nonce : ts : md5(path) : <query slot> : <body slot>
 *
 * For years this plugin signed the last two slots empty, which is correct for
 * every request it made — all of them bodiless GETs and POSTs — and quietly
 * ruled out every request that carries a body: the server answers a body it
 * did not sign for with `401 auth.err.invalid.token`.
 *
 * The body slot was measured on 5 Sep 2026 against the owner's own account,
 * on both shapes a scene write needs:
 *
 * - a JSON body is signed as `md5(<the exact bytes sent>)`, with
 *   `Content-Type: application/json` (`PUT user/scene/{id}/param` → 200);
 * - a form body is signed as `md5("k=v&k=v")` over the fields sorted by key,
 *   raw values, and sent as exactly that string with
 *   `Content-Type: application/x-www-form-urlencoded`
 *   (`PUT user/scene/{id}/enable` with `enabled=true` → 200).
 *
 * Both agree with python-roborock's `_get_hawk_authentication` and with the
 * Hawk verifier in `Python-roborock/local_roborock_server`, which is why the
 * formula is trusted beyond the two routes it was measured on.
 *
 * The QUERY slot is deliberately left empty and query strings deliberately
 * unused: the same-day measurement of `md5("enabled=true")` in that slot for
 * `PUT …/enable?enabled=true` came back `401`, so whatever the app puts there,
 * it is not what the two open-source implementations assume, and this plugin
 * has no route that needs a query string. A body does the same job and is
 * measured.
 */

const crypto = require("crypto");

/**
 * Six characters of URL-safe randomness, the way the plugin has always made
 * its nonces (the server accepts any short token; python-roborock uses
 * `secrets.token_urlsafe(6)`).
 *
 * @returns {string}
 */
function hawkNonce() {
  return crypto
    .randomBytes(6)
    .toString("base64")
    .substring(0, 6)
    .replace("+", "X")
    .replace("/", "Y");
}

/**
 * @param {string | Buffer} value
 * @returns {string} lowercase hex md5
 */
function md5hex(value) {
  return crypto.createHash("md5").update(value).digest("hex");
}

/**
 * Serialise form fields the one way the signature and the wire agree on:
 * keys sorted, raw values, `&`-joined. The string is both what is hashed into
 * the body slot and what is sent, so the two can never drift apart.
 *
 * Values are limited to what a form field can carry without encoding, so a
 * value that would need percent-encoding is refused rather than sent in a
 * shape the signature would not cover.
 *
 * @param {Record<string, string | number | boolean>} fields
 * @returns {string} e.g. `enabled=true`
 */
function formBody(fields) {
  return Object.keys(fields)
    .sort()
    .map((key) => {
      const value = String(fields[key]);
      if (/[&=%+#?\s]/.test(key) || /[&=%+#?\s]/.test(value)) {
        throw new Error(
          `Form field ${key} carries a character the Roborock signature does not cover.`
        );
      }
      return `${key}=${value}`;
    })
    .join("&");
}

/**
 * Reduce whatever an axios caller put in `config.data` to the exact bytes
 * that will go on the wire, so the signature is computed over those bytes and
 * nothing else.
 *
 * - nothing → `undefined` (bodiless request, empty body slot);
 * - a string → itself (JSON or form, the caller already serialised it);
 * - a Buffer → itself;
 * - an object or array → compact `JSON.stringify`, which is also what axios
 *   would have sent, made explicit so the two cannot disagree.
 *
 * @param {unknown} data
 * @returns {string | Buffer | undefined}
 */
function normalizeRequestBody(data) {
  if (data === undefined || data === null || data === "") {
    return undefined;
  }
  if (typeof data === "string" || Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof URLSearchParams) {
    // Through formBody rather than toString(): the signature wants the
    // fields sorted and raw, and toString() gives insertion order, encoded.
    /** @type {Record<string, string>} */
    const fields = {};
    for (const [key, value] of data.entries()) {
      fields[key] = value;
    }
    return formBody(fields);
  }
  return JSON.stringify(data);
}

/**
 * The content type a normalised body should travel with when the caller did
 * not say: JSON when it looks like JSON, a form otherwise.
 *
 * @param {string | Buffer} body
 * @returns {string}
 */
function contentTypeFor(body) {
  const text = Buffer.isBuffer(body) ? body.toString("utf8", 0, 1) : body;
  return text.startsWith("{") || text.startsWith("[")
    ? "application/json"
    : "application/x-www-form-urlencoded";
}

/**
 * Build the `Authorization` header value for one request.
 *
 * @param {{u: string, s: string, h: string}} rriot the account's rriot block
 * @param {string} pathname request path, e.g. `/user/scene/1/param`
 * @param {string | Buffer | undefined} body the exact body bytes, if any
 * @param {{timestamp?: number, nonce?: string}} [clock] fixed values for tests
 * @returns {string}
 */
function buildHawkAuthorization(rriot, pathname, body, clock = {}) {
  const timestamp = clock.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = clock.nonce ?? hawkNonce();
  const prestr = [
    rriot.u,
    rriot.s,
    nonce,
    timestamp,
    md5hex(pathname),
    /* query slot — see the module comment */ "",
    body === undefined ? "" : md5hex(body),
  ].join(":");
  const mac = crypto
    .createHmac("sha256", rriot.h)
    .update(prestr)
    .digest("base64");

  return `Hawk id="${rriot.u}", s="${rriot.s}", ts="${timestamp}", nonce="${nonce}", mac="${mac}"`;
}

/**
 * Sign one axios request in place: normalise its body, set the content type
 * it will actually travel with, and attach the `Authorization` header.
 *
 * `pathname` is passed in rather than derived, because deriving it needs the
 * axios instance (`api.getUri(config)`), which the caller has and this module
 * does not.
 *
 * @param {{u: string, s: string, h: string}} rriot
 * @param {string} pathname
 * @param {{data?: unknown, headers: Record<string, unknown>}} config axios request config
 * @returns {void}
 */
function signAxiosRequest(rriot, pathname, config) {
  const body = normalizeRequestBody(config.data);

  if (body !== undefined) {
    config.data = body;
    const headers = config.headers;
    const hasContentType = Object.keys(headers).some(
      (key) => key.toLowerCase() === "content-type" && headers[key]
    );
    if (!hasContentType) {
      headers["Content-Type"] = contentTypeFor(body);
    }
  }

  config.headers["Authorization"] = buildHawkAuthorization(
    rriot,
    pathname,
    body
  );
}

module.exports = {
  hawkNonce,
  formBody,
  normalizeRequestBody,
  contentTypeFor,
  buildHawkAuthorization,
  signAxiosRequest,
};
