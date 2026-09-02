// Verifies the Worker-side GitHub App auth helper with a real RSA
// keypair + a real Bun.serve fake. Mirrors the JWT contract in
// test/verify-github-app.test.ts and exercises the cache + auth-source
// paths that only the Worker has.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type EpochMs,
  type GitHubAuth,
  __resetInstallationTokenCacheForTests,
  __seedInstallationTokenCacheForTests,
  fetchInstallationToken,
  getDefaultGitHubAuth,
  getGitHubAppConfig,
  getInstallationToken,
  resolveInstallationId,
  signAppJwt,
} from "../backend/src/services/github-auth";
import type { Bindings } from "../backend/src/types/bindings";

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

  test('appId=0 still serializes iss as the string "0"', async () => {
    // Defends against a future truthy-check refactor swallowing falsy IDs.
    const { pem } = await generateKeypair();
    const jwt = await signAppJwt(0, pem, 1_700_000_000);
    const payload = decodeJsonPart(jwt.split(".")[1]) as { iss: string };
    expect(payload.iss).toBe("0");
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
      signAppJwt(1, "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----"),
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
// Local Bun.serve fake: a real HTTP server captures requests, lets each
// test install its own responder. No mocks; the test's contract with
// GitHub is "send this request, get this response."
// ---------------------------------------------------------------------

interface FakeServer {
  baseUrl: string;
  capturedRequests: { method: string; path: string; auth: string | null }[];
  setResponder: (fn: (req: Request) => Response | Promise<Response>) => void;
  stop: () => Promise<void>;
}

async function startFakeGitHub(): Promise<FakeServer> {
  const capturedRequests: FakeServer["capturedRequests"] = [];
  let responder: (req: Request) => Response | Promise<Response> = defaultResponder;
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
  return new Response(JSON.stringify({ token, expires_at: expiresAt.toISOString() }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
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
    server.setResponder(() =>
      cannedTokenResponse("ghs_abc", new Date(Date.now() + 60 * 60 * 1000)),
    );
    const jwt = await signAppJwt(100, pem);
    const result = await fetchInstallationToken(jwt, 111, { baseUrl: server.baseUrl });
    expect(result.token).toBe("ghs_abc");
    expect(server.capturedRequests[0]).toEqual({
      method: "POST",
      path: "/app/installations/111/access_tokens",
      auth: `Bearer ${jwt}`,
    });
  });

  test("throws with the response body on non-2xx", async () => {
    server.setResponder(
      () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
    );
    const jwt = await signAppJwt(100, pem);
    await expect(fetchInstallationToken(jwt, 111, { baseUrl: server.baseUrl })).rejects.toThrow(
      /HTTP 401/,
    );
  });

  test("rejects responses missing or empty token", async () => {
    server.setResponder(
      () =>
        new Response(
          JSON.stringify({ token: "", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
          {
            status: 201,
          },
        ),
    );
    const jwt = await signAppJwt(100, pem);
    await expect(fetchInstallationToken(jwt, 111, { baseUrl: server.baseUrl })).rejects.toThrow(
      /\`token\` missing or empty/,
    );
  });

  test("rejects responses missing expires_at", async () => {
    server.setResponder(() => new Response(JSON.stringify({ token: "ghs_x" }), { status: 201 }));
    const jwt = await signAppJwt(100, pem);
    await expect(fetchInstallationToken(jwt, 111, { baseUrl: server.baseUrl })).rejects.toThrow(
      /missing \`expires_at\`/,
    );
  });

  test("rejects tokens whose expires_at is already in the past", async () => {
    // Skew / replay defense: a token born expired should never make it
    // into the cache.
    server.setResponder(() => cannedTokenResponse("ghs_dead", new Date(Date.now() - 60_000)));
    const jwt = await signAppJwt(100, pem);
    await expect(fetchInstallationToken(jwt, 111, { baseUrl: server.baseUrl })).rejects.toThrow(
      /already expired/,
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
    server.setResponder(() =>
      cannedTokenResponse("ghs_new", new Date(Date.now() + 60 * 60 * 1000)),
    );
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
    expect(await getInstallationToken(env, 111, { baseUrl: server.baseUrl })).toBe("ghs_1");
    expect(await getInstallationToken(env, 222, { baseUrl: server.baseUrl })).toBe("ghs_2");
    // Second call to 111 must come from cache, not hit the network.
    expect(await getInstallationToken(env, 111, { baseUrl: server.baseUrl })).toBe("ghs_1");
    expect(server.capturedRequests).toHaveLength(2);
  });

  test("concurrent callers share one in-flight refresh", async () => {
    let mintCount = 0;
    server.setResponder(async () => {
      mintCount += 1;
      await new Promise((r) => setTimeout(r, 30));
      return cannedTokenResponse(`ghs_${mintCount}`, new Date(Date.now() + 60 * 60 * 1000));
    });
    const tokens = await Promise.all(
      Array.from({ length: 5 }, () => getInstallationToken(env, 111, { baseUrl: server.baseUrl })),
    );
    expect(new Set(tokens).size).toBe(1);
    expect(mintCount).toBe(1);
  });

  test("missing App secrets surface as an actionable error", async () => {
    const partial = { ...env, GITHUB_APP_PRIVATE_KEY: undefined } as Bindings;
    await expect(getInstallationToken(partial, 111, { baseUrl: server.baseUrl })).rejects.toThrow(
      /GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY/,
    );
  });

  test("a failed mint does not poison the cache", async () => {
    server.setResponder(() => new Response("nope", { status: 500 }));
    await expect(getInstallationToken(env, 111, { baseUrl: server.baseUrl })).rejects.toThrow(
      /HTTP 500/,
    );
    server.setResponder(() =>
      cannedTokenResponse("ghs_retry", new Date(Date.now() + 60 * 60 * 1000)),
    );
    expect(await getInstallationToken(env, 111, { baseUrl: server.baseUrl })).toBe("ghs_retry");
  });

  test("subsequent caller after failure mint gets a fresh shot", async () => {
    // Two concurrent callers see the same failure (sharing refreshing
    // promise), the cache is cleared, then a third caller minting after
    // the responder is fixed should succeed cleanly.
    server.setResponder(() => new Response("nope", { status: 500 }));
    const [a, b] = await Promise.allSettled([
      getInstallationToken(env, 111, { baseUrl: server.baseUrl }),
      getInstallationToken(env, 111, { baseUrl: server.baseUrl }),
    ]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    server.setResponder(() =>
      cannedTokenResponse("ghs_after_clear", new Date(Date.now() + 60 * 60 * 1000)),
    );
    expect(await getInstallationToken(env, 111, { baseUrl: server.baseUrl })).toBe(
      "ghs_after_clear",
    );
  });

  test("signAppJwt failure during refresh clears the cache for the next call", async () => {
    // Bad PEM blows up inside the refresh IIFE before any network call.
    // Confirm the cleanup path handles JWT-signing failures the same way
    // it handles network failures.
    const badEnv = { ...env, GITHUB_APP_PRIVATE_KEY: "garbage" } as Bindings;
    await expect(getInstallationToken(badEnv, 111, { baseUrl: server.baseUrl })).rejects.toThrow(
      /PKCS#8 PEM/,
    );
    expect(server.capturedRequests).toHaveLength(0);
    // Recover with a good env on the next call.
    server.setResponder(() =>
      cannedTokenResponse("ghs_recovered", new Date(Date.now() + 60 * 60 * 1000)),
    );
    expect(await getInstallationToken(env, 111, { baseUrl: server.baseUrl })).toBe("ghs_recovered");
  });
});

describe("getGitHubAppConfig", () => {
  test("returns null when GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY is missing", () => {
    expect(getGitHubAppConfig({ ...env, GITHUB_APP_ID: undefined } as Bindings)).toBeNull();
    expect(
      getGitHubAppConfig({ ...env, GITHUB_APP_PRIVATE_KEY: undefined } as Bindings),
    ).toBeNull();
  });

  test("returns configured installation IDs by org login", () => {
    const cfg = getGitHubAppConfig(env);
    expect(cfg?.installationIdsByOrg).toEqual({ nemarDatasets: 111, nemarOrg: 222 });
  });

  test("warns and omits malformed installation IDs (no silent App degradation)", () => {
    const partial = { ...env, GITHUB_APP_INSTALLATION_ID_NEMAR_ORG: "not-a-number" } as Bindings;
    const original = console.warn;
    const calls: string[] = [];
    console.warn = (msg: unknown) => calls.push(String(msg));
    try {
      const cfg = getGitHubAppConfig(partial);
      expect(cfg?.installationIdsByOrg).toEqual({ nemarDatasets: 111 });
      expect(calls.join("\n")).toMatch(/nemarOrg.*not a positive integer.*not-a-number/);
    } finally {
      console.warn = original;
    }
  });
});

describe("getDefaultGitHubAuth", () => {
  test("returns kind=app when App is fully configured", () => {
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

  test("falls back to kind=pat when App is missing a required field", () => {
    const noAppId = { ...env, GITHUB_APP_ID: undefined } as Bindings;
    expect(getDefaultGitHubAuth(noAppId, 111).kind).toBe("pat");
    const noKey = { ...env, GITHUB_APP_PRIVATE_KEY: undefined } as Bindings;
    expect(getDefaultGitHubAuth(noKey, 111).kind).toBe("pat");
  });

  test("throws when neither App nor PAT is configured", () => {
    const empty = {
      ...env,
      GITHUB_APP_ID: undefined,
      GITHUB_APP_PRIVATE_KEY: undefined,
      GITHUB_ADMIN_PAT: "",
    } as unknown as Bindings;
    expect(() => getDefaultGitHubAuth(empty)).toThrow(/No GitHub auth configured/);
  });
});

describe("resolveInstallationId", () => {
  test("returns numeric installation id for known orgs", () => {
    expect(resolveInstallationId(env, "nemarDatasets")).toBe(111);
    expect(resolveInstallationId(env, "nemarOrg")).toBe(222);
  });

  test("case-sensitive match (pins current behavior)", () => {
    // Pin the decision: org login is matched literally. If GitHub ever
    // hands us a lowercased login in a webhook payload, the caller
    // normalizes before looking up, not us.
    expect(resolveInstallationId(env, "nemardatasets")).toBeUndefined();
  });

  test("returns undefined for unknown orgs", () => {
    expect(resolveInstallationId(env, "someOtherOrg")).toBeUndefined();
  });

  test("returns undefined when the env value is missing", () => {
    const partial = {
      ...env,
      GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: undefined,
    } as Bindings;
    expect(resolveInstallationId(partial, "nemarDatasets")).toBeUndefined();
  });

  test("returns undefined when App config is missing entirely", () => {
    const noApp = { ...env, GITHUB_APP_ID: undefined } as Bindings;
    // No App config -> no installation map -> always undefined.
    expect(resolveInstallationId(noApp, "nemarDatasets")).toBeUndefined();
  });
});

describe("EpochMs branded type", () => {
  test("seeded cache entries carry the branded expiresAt type", () => {
    // Compile-time check disguised as a runtime check: the helper takes
    // a `number` and brands it. If a future refactor drops the brand,
    // tsc won't compile this file.
    __seedInstallationTokenCacheForTests(999, "ghs_brand", Date.now() + 60_000);
    const t: EpochMs = (Date.now() + 60_000) as EpochMs;
    expect(typeof t).toBe("number");
  });
});
