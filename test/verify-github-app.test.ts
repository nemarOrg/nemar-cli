/**
 * Unit tests for the signAppJwt helper exported from
 * scripts/verify-github-app.ts. The helper is the prototype that Phase 2
 * of epic #432 lifts into backend/src/services/github-auth.ts; locking
 * its behavior here lets that migration be a copy rather than a
 * re-implementation.
 *
 * Project rule: no mocks. We generate a real RSA keypair on the spot,
 * sign with the helper, and verify with crypto.subtle.verify against
 * the matching public key.
 */

import { describe, expect, test } from "bun:test";
import { signAppJwt } from "../scripts/verify-github-app";

function base64urlToBytes(s: string): Uint8Array {
  const pad = (s + "===".slice((s.length + 3) % 4)).replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeJsonPart(s: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64urlToBytes(s)));
}

async function exportPkcs8Pem(key: CryptoKey): Promise<string> {
  const buf = await crypto.subtle.exportKey("pkcs8", key);
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

async function generateKeypair(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pem = await exportPkcs8Pem(pair.privateKey);
  return { pem, publicKey: pair.publicKey };
}

describe("signAppJwt", () => {
  test("produces a three-part base64url JWT", async () => {
    const { pem } = await generateKeypair();
    const jwt = await signAppJwt(1234, pem);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    // base64url alphabet only — no '+', '/', or '=' allowed
    for (const part of parts) {
      expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  test("header is RS256 + JWT", async () => {
    const { pem } = await generateKeypair();
    const jwt = await signAppJwt(1234, pem);
    const [headerPart] = jwt.split(".");
    const header = decodeJsonPart(headerPart) as { alg: string; typ: string };
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");
  });

  test("payload encodes iss as a string and uses a 10-minute window", async () => {
    const { pem } = await generateKeypair();
    const now = 1_700_000_000;
    const jwt = await signAppJwt(987654, pem, now);
    const [, payloadPart] = jwt.split(".");
    const payload = decodeJsonPart(payloadPart) as { iat: number; exp: number; iss: string };
    // 30 s safety margin shaves iat backward so GitHub never sees a future iat
    expect(payload.iat).toBe(now - 30);
    expect(payload.exp).toBe(payload.iat + 600);
    // GitHub requires `iss` as a string even when the App ID is numeric
    expect(payload.iss).toBe("987654");
  });

  test("signature verifies against the matching public key", async () => {
    const { pem, publicKey } = await generateKeypair();
    const jwt = await signAppJwt(42, pem);
    const [headerPart, payloadPart, sigPart] = jwt.split(".");
    const signingInput = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    const signature = base64urlToBytes(sigPart);
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      signature,
      signingInput,
    );
    expect(ok).toBe(true);
  });

  test("rejects PKCS#1 private keys with an actionable error", async () => {
    const pkcs1 = `-----BEGIN RSA PRIVATE KEY-----
MIIBOQIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu
KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQJAIJLixBy2qpFoS4DSmoEm
o3qGy0t6z09AIJtH+5OeRV1be+N4cDYJKffGzDa88vQENZiRm0GRq6a+HPGQMd2k
TQIhAKMSvzIBnni7ot/OSie2TmJLY4SwTQAevXysE2RbFDYdAiEBCUEaRQnMnbp7
9mxDXDjnZjPP6BBwhVYBdoVTQEqDQOECIEpEqUtVZelEPv7+M2qg/2hf4yMm/i9P
m+r3FwAH3GZNAiEAtrXxlsVZGsRLN8lhqYjk5LWNu/AfsLY2BbcwlS40dl0CIQCK
4QPHKQYJWG+pPTtA1Bs7Iy/8/sNo7VPmifoEz0i9MA==
-----END RSA PRIVATE KEY-----
`;
    await expect(signAppJwt(1, pkcs1)).rejects.toThrow(/PKCS#1/);
  });

  test("rejects garbage with a clear error", async () => {
    await expect(signAppJwt(1, "not a pem at all")).rejects.toThrow(/PKCS#8 PEM/);
  });
});
