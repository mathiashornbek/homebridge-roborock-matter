"use strict";

const crypto = require("crypto");

/**
 * Convert a base64url JWK component to the minimal lowercase hex string
 * format the previous node-forge implementation produced (BigInteger
 * .toString(16): no leading zero digits).
 * @param {string} base64url
 * @returns {string}
 */
function jwkComponentToHex(base64url) {
  const hex = Buffer.from(base64url, "base64url").toString("hex");
  return hex.replace(/^0+(?=.)/, "");
}

/**
 * Generate the 2048-bit RSA keypair used by the Roborock protocol's photo
 * security block, via Node's built-in OpenSSL-backed generator (CSPRNG
 * entropy). Output shape and hex formatting match the previous node-forge
 * implementation exactly: n/e/d/p/q/dmp1/dmq1/coeff as minimal hex strings.
 */
function generateRsaKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = privateKey.export({ format: "jwk" });
  void publicKey;

  return {
    public: {
      n: jwkComponentToHex(jwk.n),
      e: jwkComponentToHex(jwk.e),
    },
    private: {
      n: jwkComponentToHex(jwk.n),
      e: jwkComponentToHex(jwk.e),
      d: jwkComponentToHex(jwk.d),
      p: jwkComponentToHex(jwk.p),
      q: jwkComponentToHex(jwk.q),
      dmp1: jwkComponentToHex(jwk.dp),
      dmq1: jwkComponentToHex(jwk.dq),
      coeff: jwkComponentToHex(jwk.qi),
    },
  };
}

function md5bin(str) {
  return crypto.createHash("md5").update(str).digest();
}

function md5hex(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}

function encodeTimestamp(timestamp) {
  const hex = timestamp.toString(16).padStart(8, "0").split("");
  return [5, 6, 3, 7, 1, 2, 0, 4].map((idx) => hex[idx]).join("");
}

module.exports = {
  generateRsaKeyPair,
  md5bin,
  md5hex,
  encodeTimestamp,
};
