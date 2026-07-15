const crypto = require("crypto");
const {
  generateRsaKeyPair,
  md5hex,
  encodeTimestamp,
} = require("../roborockLib/lib/roborockCrypto");

function hexToBase64url(hex) {
  const padded = hex.length % 2 === 1 ? `0${hex}` : hex;
  return Buffer.from(padded, "hex").toString("base64url");
}

describe("generateRsaKeyPair (Node crypto, node-forge removed)", () => {
  const keys = generateRsaKeyPair();

  test("produces the exact legacy node-forge output shape and hex format", () => {
    expect(Object.keys(keys)).toEqual(["public", "private"]);
    expect(Object.keys(keys.public)).toEqual(["n", "e"]);
    expect(Object.keys(keys.private)).toEqual([
      "n",
      "e",
      "d",
      "p",
      "q",
      "dmp1",
      "dmq1",
      "coeff",
    ]);

    for (const value of [
      ...Object.values(keys.public),
      ...Object.values(keys.private),
    ]) {
      // minimal lowercase hex, exactly like forge's BigInteger.toString(16)
      expect(value).toMatch(/^[0-9a-f]+$/);
      expect(value.startsWith("0")).toBe(false);
    }

    // 2048-bit modulus: MSB set, so always exactly 512 hex digits
    expect(keys.public.n).toHaveLength(512);
    expect(keys.public.n).toBe(keys.private.n);
    // standard public exponent 65537, forge-style minimal hex
    expect(keys.public.e).toBe("10001");
  });

  test("components reconstruct a working RSA keypair (encrypt/decrypt roundtrip)", () => {
    const publicKey = crypto.createPublicKey({
      key: {
        kty: "RSA",
        n: hexToBase64url(keys.public.n),
        e: hexToBase64url(keys.public.e),
      },
      format: "jwk",
    });
    const privateKey = crypto.createPrivateKey({
      key: {
        kty: "RSA",
        n: hexToBase64url(keys.private.n),
        e: hexToBase64url(keys.private.e),
        d: hexToBase64url(keys.private.d),
        p: hexToBase64url(keys.private.p),
        q: hexToBase64url(keys.private.q),
        dp: hexToBase64url(keys.private.dmp1),
        dq: hexToBase64url(keys.private.dmq1),
        qi: hexToBase64url(keys.private.coeff),
      },
      format: "jwk",
    });

    const message = Buffer.from("roborock-matter roundtrip", "utf8");
    const decrypted = crypto.privateDecrypt(
      privateKey,
      crypto.publicEncrypt(publicKey, message)
    );
    expect(decrypted.equals(message)).toBe(true);
  });

  test("helper functions keep their contracts", () => {
    expect(md5hex("test")).toBe("098f6bcd4621d373cade4e832627b4f6");
    // fixed shuffle [5,6,3,7,1,2,0,4] of the zero-padded hex timestamp
    expect(encodeTimestamp(0x12345678)).toBe("67482315");
    expect(encodeTimestamp(0x12345678)).toHaveLength(8);
  });
});
