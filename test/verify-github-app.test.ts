// Verifies signAppJwt with a real RSA keypair (no mocks).
// Locks the JWT shape that downstream code will reuse.

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
  const b64 = btoa(bin)
    .match(/.{1,64}/g)!
    .join("\n");
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
    expect(payload.iat).toBe(now - 30);
    expect(payload.exp).toBe(payload.iat + 600);
    // GitHub requires `iss` as a string even when the App ID is numeric
    expect(payload.iss).toBe("987654");
  });

  test("accepts appId as a numeric string and emits the same iss", async () => {
    const { pem } = await generateKeypair();
    const now = 1_700_000_000;
    const fromNumber = await signAppJwt(987654, pem, now);
    const fromString = await signAppJwt("987654", pem, now);
    const issFrom = (jwt: string) => (decodeJsonPart(jwt.split(".")[1]) as { iss: string }).iss;
    expect(issFrom(fromNumber)).toBe("987654");
    expect(issFrom(fromString)).toBe("987654");
  });

  test('appId=0 still serializes iss as the string "0"', async () => {
    const { pem } = await generateKeypair();
    const jwt = await signAppJwt(0, pem, 1_700_000_000);
    const payload = decodeJsonPart(jwt.split(".")[1]) as { iss: string };
    // Defends against a future truthy-check refactor swallowing falsy IDs.
    expect(payload.iss).toBe("0");
  });

  test("signature verifies against the matching public key", async () => {
    const { pem, publicKey } = await generateKeypair();
    const jwt = await signAppJwt(42, pem);
    const [headerPart, payloadPart, sigPart] = jwt.split(".");
    const signingInput = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    const signature = base64urlToBytes(sigPart);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, signingInput);
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

  test("rejects encrypted PKCS#8 with a hint at -nocrypt", async () => {
    const encrypted =
      "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n";
    await expect(signAppJwt(1, encrypted)).rejects.toThrow(/-nocrypt/);
  });

  test("rejects garbage with a clear error", async () => {
    await expect(signAppJwt(1, "not a pem at all")).rejects.toThrow(/PKCS#8 PEM/);
  });

  test("accepts PEM with Windows CRLF line endings", async () => {
    // 1Password export / Windows clipboard reality.
    const { pem } = await generateKeypair();
    const crlf = pem.replace(/\n/g, "\r\n");
    const jwt = await signAppJwt(1, crlf, 1_700_000_000);
    expect(jwt.split(".")).toHaveLength(3);
  });
});

describe("module side-effects", () => {
  test("importing the module does not invoke main() or hit the network", async () => {
    // Sentinel: replace globalThis.fetch with one that records calls.
    // If a future maintainer hoists main() out of the import.meta.main
    // guard, this test catches it.
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.reject(new Error("fetch should not be called during import"));
    }) as typeof fetch;
    try {
      // Re-import via dynamic import to exercise the module-load path.
      // `?t=` query busts Bun's module cache so the top-level code re-runs.
      await import(`../scripts/verify-github-app?t=${Date.now()}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toEqual([]);
  });
});
