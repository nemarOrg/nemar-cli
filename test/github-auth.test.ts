// Worker-side GitHub App auth tests. Mirrors the JWT contract in
// test/verify-github-app.test.ts and exercises the cache + discriminated
// source code paths that only the Worker has.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type GitHubAuth,
  __resetInstallationTokenCacheForTests,
  __seedInstallationTokenCacheForTests,
  fetchInstallationToken,
  getDefaultGitHubAuth,
  getInstallationToken,
  resolveInstallationId,
  signAppJwt,
} from "../backend/src/services/github-auth";
import type { Bindings } from "../backend/src/types/bindings";

// ---------------------------------------------------------------------
// Real-keypair fixtures (no mocks).
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// JWT helper: contract must match the standalone script.
// ---------------------------------------------------------------------

describe("signAppJwt", () => {
  test("produces a three-part RS256 JWT", async () => {
    const { pem } = await generateKeypair();
    const jwt = await signAppJwt(1234, pem);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const header = decodeJsonPart(parts[0]) as { alg: string; typ: string };
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");
  });

  test("encodes iss as a string with 10-minute window and -30s iat", async () => {
    const { pem } = await generateKeypair();
    const now = 1_700_000_000;
    const jwt = await signAppJwt(987654, pem, now);
    const payload = decodeJsonPart(jwt.split(".")[1]) as { iat: number; exp: number; iss: string };
    expect(payload.iat).toBe(now - 30);
    expect(payload.exp).toBe(payload.iat + 600);
    expect(payload.iss).toBe("987654");
  });

  test("signature verifies against the matching public key", async () => {
    const { pem, publicKey } = await generateKeypair();
    const jwt = await signAppJwt(42, pem);
    const [headerPart, payloadPart, sigPart] = jwt.split(".");
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      base64urlToBytes(sigPart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
    expect(ok).toBe(true);
  });

  test("rejects PKCS#1 and encrypted PKCS#8 with actionable messages", async () => {
    await expect(
      signAppJwt(
        1,
        "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----",
      ),
    ).rejects.toThrow(/PKCS#1/);
    await expect(
      signAppJwt(
        1,
        "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----",
      ),
    ).rejects.toThrow(/-nocrypt/);
  });
});

// ---------------------------------------------------------------------
// fetchInstallationToken + getInstallationToken: real Bun.serve fake.
// ---------------------------------------------------------------------

interface FakeServer {
  baseUrl: string;
  capturedRequests: { method: string; path: string; auth: string | null }[];
  setResponder: (fn: (req: Request) => Response | Promise<Response>) => void;
  stop: () => Promise<void>;
}

async function startFakeGitHub(initialResponder?: (req: Request) => Response | Promise<Response>): Promise<FakeServer> {
  const capturedRequests: FakeServer["capturedRequests"] = [];
  let responder: (req: Request) => Response | Promise<Response> = initialResponder ?? defaultResponder;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      capturedRequests.push({
        method: req.method,
        path: url.pathname,
        auth: req.headers.get("Authorization"),
      });
      return responder(req);
    },
  });
  return {
    baseUrl: `http://localhost:${server.port}`,
    capturedRequests,
    setResponder: (fn) => {
      responder = fn;
    },
    stop: async () => {
      await server.stop();
    },
  };
}

function defaultResponder(_req: Request): Response {
  return cannedTokenResponse("ghs_test_default", new Date(Date.now() + 60 * 60 * 1000));
}

function cannedTokenResponse(token: string, expiresAt: Date): Response {
  return new Response(
    JSON.stringify({ token, expires_at: expiresAt.toISOString() }),
    { status: 201, headers: { "Content-Type": "application/json" } },
  );
}

let server: FakeServer;
let pem: string;
let env: Bindings;

beforeEach(async () => {
  __resetInstallationTokenCacheForTests();
  server = await startFakeGitHub();
  pem = (await generateKeypair()).pem;
  env = {
    GITHUB_ADMIN_PAT: "pat-fallback-value",
    GITHUB_APP_ID: "100",
    GITHUB_APP_PRIVATE_KEY: pem,
    GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: "111",
    GITHUB_APP_INSTALLATION_ID_NEMAR_ORG: "222",
  } as Bindings;
});

afterEach(async () => {
  await server.stop();
});

describe("fetchInstallationToken", () => {
  test("POSTs the App JWT and parses the canned response", async () => {
    server.setResponder(() => cannedTokenResponse("ghs_abc", new Date(2026, 5, 11, 10, 0, 0)));
    const jwt = await signAppJwt(100, pem);
    const result = await fetchInstallationToken(jwt, 111, { baseUrl: server.baseUrl });
    expect(result.token).toBe("ghs_abc");
    expect(result.expiresAt).toBe(new Date(2026, 5, 11, 10, 0, 0).getTime());
    expect(server.capturedRequests).toHaveLength(1);
    expect(server.capturedRequests[0]).toEqual({
      method: "POST",
      path: "/app/installations/111/access_tokens",
      auth: `Bearer ${jwt}`,
    });
  });

  test("throws with the response body on non-2xx", async () => {
    server.setResponder(
      () =>
        new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
    );
    const jwt = await signAppJwt(100, pem);
    await expect(fetchInstallationToken(jwt, 111, { baseUrl: server.baseUrl })).rejects.toThrow(/HTTP 401/);
  });

  test("rejects responses missing token or expires_at", async () => {
    server.setResponder(() => new Response(JSON.stringify({ token: "x" }), { status: 201 }));
    const jwt = await signAppJwt(100, pem);
    await expect(fetchInstallationToken(jwt, 111, { baseUrl: server.baseUrl })).rejects.toThrow(
      /malformed response/,
    );
  });
});

describe("getInstallationToken (caching)", () => {
  test("cached token is returned without a network call", async () => {
    __seedInstallationTokenCacheForTests(111, "ghs_seeded", Date.now() + 60 * 60 * 1000);
    const token = await getInstallationToken(env, 111, { baseUrl: server.baseUrl });
    expect(token).toBe("ghs_seeded");
    expect(server.capturedRequests).toHaveLength(0);
  });

  test("expiring-soon entry triggers a refresh", async () => {
    // entryIsFresh threshold is 5 min; seed with 4 min remaining.
    __seedInstallationTokenCacheForTests(111, "ghs_old", Date.now() + 4 * 60 * 1000);
    server.setResponder(() => cannedTokenResponse("ghs_new", new Date(Date.now() + 60 * 60 * 1000)));
    const token = await getInstallationToken(env, 111, { baseUrl: server.baseUrl });
    expect(token).toBe("ghs_new");
    expect(server.capturedRequests).toHaveLength(1);
  });

  test("tokens for two installations stay isolated", async () => {
    let counter = 0;
    server.setResponder(() => {
      counter += 1;
      return cannedTokenResponse(`ghs_${counter}`, new Date(Date.now() + 60 * 60 * 1000));
    });
    const t1 = await getInstallationToken(env, 111, { baseUrl: server.baseUrl });
    const t2 = await getInstallationToken(env, 222, { baseUrl: server.baseUrl });
    expect(t1).toBe("ghs_1");
    expect(t2).toBe("ghs_2");
    expect(server.capturedRequests).toHaveLength(2);
    // Second call to 111 must come from cache, not hit the network.
    const t1Again = await getInstallationToken(env, 111, { baseUrl: server.baseUrl });
    expect(t1Again).toBe("ghs_1");
    expect(server.capturedRequests).toHaveLength(2);
  });

  test("concurrent callers share one in-flight refresh", async () => {
    let mintCount = 0;
    server.setResponder(async () => {
      mintCount += 1;
      // Small delay so all callers attach to the same in-flight promise.
      await new Promise((r) => setTimeout(r, 30));
      return cannedTokenResponse(`ghs_${mintCount}`, new Date(Date.now() + 60 * 60 * 1000));
    });
    const tokens = await Promise.all([
      getInstallationToken(env, 111, { baseUrl: server.baseUrl }),
      getInstallationToken(env, 111, { baseUrl: server.baseUrl }),
      getInstallationToken(env, 111, { baseUrl: server.baseUrl }),
      getInstallationToken(env, 111, { baseUrl: server.baseUrl }),
      getInstallationToken(env, 111, { baseUrl: server.baseUrl }),
    ]);
    expect(new Set(tokens).size).toBe(1);
    expect(mintCount).toBe(1);
    expect(server.capturedRequests).toHaveLength(1);
  });

  test("missing App secrets surface as an actionable error", async () => {
    const partial = { ...env, GITHUB_APP_PRIVATE_KEY: undefined } as Bindings;
    await expect(
      getInstallationToken(partial, 111, { baseUrl: server.baseUrl }),
    ).rejects.toThrow(/GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY/);
  });

  test("a failed mint does not poison the cache", async () => {
    server.setResponder(() => new Response("nope", { status: 500 }));
    await expect(
      getInstallationToken(env, 111, { baseUrl: server.baseUrl }),
    ).rejects.toThrow(/HTTP 500/);
    // Next call gets a fresh shot — no lingering empty-string token.
    server.setResponder(() => cannedTokenResponse("ghs_retry", new Date(Date.now() + 60 * 60 * 1000)));
    const token = await getInstallationToken(env, 111, { baseUrl: server.baseUrl });
    expect(token).toBe("ghs_retry");
  });
});

describe("getDefaultGitHubAuth", () => {
  test("returns kind=app when all App fields and installationId are set", () => {
    const auth: GitHubAuth = getDefaultGitHubAuth(env, 111);
    expect(auth.kind).toBe("app");
    if (auth.kind === "app") {
      expect(auth.installationId).toBe(111);
      expect(typeof auth.getToken).toBe("function");
    }
  });

  test("falls back to kind=pat when installationId is undefined", () => {
    const auth = getDefaultGitHubAuth(env);
    expect(auth.kind).toBe("pat");
    if (auth.kind === "pat") expect(auth.token).toBe("pat-fallback-value");
  });

  test("falls back to kind=pat when GITHUB_APP_ID is missing", () => {
    const partial = { ...env, GITHUB_APP_ID: undefined } as Bindings;
    const auth = getDefaultGitHubAuth(partial, 111);
    expect(auth.kind).toBe("pat");
  });

  test("falls back to kind=pat when GITHUB_APP_PRIVATE_KEY is missing", () => {
    const partial = { ...env, GITHUB_APP_PRIVATE_KEY: undefined } as Bindings;
    const auth = getDefaultGitHubAuth(partial, 111);
    expect(auth.kind).toBe("pat");
  });
});

describe("resolveInstallationId", () => {
  test("returns numeric installation id for known orgs", () => {
    expect(resolveInstallationId(env, "nemarDatasets")).toBe(111);
    expect(resolveInstallationId(env, "nemarOrg")).toBe(222);
  });

  test("returns undefined for unknown orgs", () => {
    expect(resolveInstallationId(env, "someOtherOrg")).toBeUndefined();
  });

  test("returns undefined when the env value is missing or non-numeric", () => {
    const partial = {
      ...env,
      GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: undefined,
      GITHUB_APP_INSTALLATION_ID_NEMAR_ORG: "not-a-number",
    } as Bindings;
    expect(resolveInstallationId(partial, "nemarDatasets")).toBeUndefined();
    expect(resolveInstallationId(partial, "nemarOrg")).toBeUndefined();
  });
});
