"use strict";

const crypto = require("crypto");
const forge = require("node-forge");

function generateRsaKeyPair() {
  const keypair = forge.pki.rsa.generateKeyPair(2048);
  const keys = {
    public: { n: null, e: null },
    private: {
      n: null,
      e: null,
      d: null,
      p: null,
      q: null,
      dmp1: null,
      dmq1: null,
      coeff: null,
    },
  };

  // Convert the keys to the desired format
  keys.public.n = keypair.publicKey.n.toString(16);
  keys.public.e = keypair.publicKey.e.toString(16);
  keys.private.n = keypair.privateKey.n.toString(16);
  keys.private.e = keypair.privateKey.e.toString(16);
  keys.private.d = keypair.privateKey.d.toString(16);
  keys.private.p = keypair.privateKey.p.toString(16);
  keys.private.q = keypair.privateKey.q.toString(16);
  keys.private.dmp1 = keypair.privateKey.dP.toString(16);
  keys.private.dmq1 = keypair.privateKey.dQ.toString(16);
  keys.private.coeff = keypair.privateKey.qInv.toString(16);

  return keys;
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
