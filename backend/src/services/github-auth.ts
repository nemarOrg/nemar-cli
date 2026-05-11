/**
 * GitHub App authentication for the Worker.
 *
 * Signs short-lived App JWTs, mints per-installation access tokens, and
 * caches them in module scope until they're close to expiry. Exposes a
 * discriminated `GitHubAuth` source so callers can stay agnostic about
 * whether they're talking to GitHub via the legacy user PAT or the new
 * App installation token. Phase 3 of epic #432 rewires every callsite
 * through `getDefaultGitHubAuth`; until then this module is dormant.
 */

import type { Bindings } from "../types/bindings";

const GITHUB_API = "https://api.github.com";

/** Refresh installation tokens this far before they expire. GitHub's
 *  default token lifetime is 60 min; refreshing at 5 min remaining
 *  leaves room for clock drift and a slow round trip. */
const REFRESH_LEAD_MS = 5 * 60 * 1000;

interface CacheEntry {
  token: string;
  expiresAt: number; // epoch ms
  refreshing?: Promise<string>;
}

const installationTokenCache: Map<number, CacheEntry> = new Map();

export function __resetInstallationTokenCacheForTests(): void {
  installationTokenCache.clear();
}

export function __seedInstallationTokenCacheForTests(
  installationId: number,
  token: string,
  expiresAt: number,
): void {
  installationTokenCache.set(installationId, { token, expiresAt });
}

// ---------------------------------------------------------------------
// JWT signing (behavioral mirror of scripts/verify-github-app.ts).
//
// Intentionally duplicated: the standalone script must work without
// pulling in Worker deps, and the Worker must not reach into scripts/.
// test/github-auth.test.ts and test/verify-github-app.test.ts both pin
// the same invariants on their respective copies; divergence is caught.
// ---------------------------------------------------------------------

// base64url per RFC 7515 §2.
function base64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// PKCS#1 is GitHub's default download; Web Crypto only imports PKCS#8.
function pkcs8PemToDer(pem: string): ArrayBuffer {
  const trimmed = pem.replace(/^﻿/, "").trim();
  if (trimmed.includes("BEGIN ENCRYPTED PRIVATE KEY")) {
    throw new Error(
      "GitHub App private key is an encrypted PKCS#8 file. Re-export unencrypted with: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in <in> -out <out>",
    );
  }
  if (trimmed.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "GitHub App private key is PKCS#1, not PKCS#8. Convert with: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in <in> -out <out>",
    );
  }
  const match = trimmed.match(
    /-----BEGIN PRIVATE KEY-----\s*([\s\S]+?)\s*-----END PRIVATE KEY-----/,
  );
  if (!match) {
    throw new Error("Could not find PKCS#8 PEM block in GITHUB_APP_PRIVATE_KEY.");
  }
  const body = match[1].replace(/\s+/g, "");
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der.buffer;
}

/** Sign a 10-minute App JWT (RS256). The 30 s backstep on `iat`
 *  defends against laptop clock skew on the maintainer side; on a
 *  Worker the clock is GitHub-aligned but the skew costs nothing. */
export async function signAppJwt(
  appId: number | string,
  privateKeyPem: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const der = pkcs8PemToDer(privateKeyPem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const iat = nowSeconds - 30;
  const exp = iat + 600;
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat, exp, iss: String(appId) };
  const encoded = `${base64url(new TextEncoder().encode(JSON.stringify(header)))}.${base64url(
    new TextEncoder().encode(JSON.stringify(payload)),
  )}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(encoded));
  return `${encoded}.${base64url(sig)}`;
}

// ---------------------------------------------------------------------
// Installation tokens
// ---------------------------------------------------------------------

interface InstallationTokenResponse {
  token: string;
  expires_at: string; // ISO 8601
}

export interface InstallationToken {
  token: string;
  expiresAt: number; // epoch ms
}

export interface FetchInstallationTokenOptions {
  /** Inject for tests. Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  /** Base URL override for tests; defaults to https://api.github.com. */
  baseUrl?: string;
}

/** POST /app/installations/:id/access_tokens with the signed App JWT.
 *  Throws on any non-2xx with the raw response body, which is the
 *  caller's hint at what went wrong (401 → key/clock/App ID mismatch;
 *  404 → installation not visible to this App). */
export async function fetchInstallationToken(
  jwt: string,
  installationId: number,
  options: FetchInstallationTokenOptions = {},
): Promise<InstallationToken> {
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = options.baseUrl ?? GITHUB_API;
  const res = await fetchFn(`${baseUrl}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "nemar-worker",
    },
  });
  if (!res.ok) {
    throw new Error(
      `POST /app/installations/${installationId}/access_tokens -> HTTP ${res.status}: ${await res.text()}`,
    );
  }
  const body = (await res.json()) as Partial<InstallationTokenResponse>;
  if (typeof body.token !== "string" || typeof body.expires_at !== "string") {
    throw new Error(
      `POST /app/installations/${installationId}/access_tokens: malformed response: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  const expiresAt = Date.parse(body.expires_at);
  if (Number.isNaN(expiresAt)) {
    throw new Error(
      `POST /app/installations/${installationId}/access_tokens: invalid expires_at "${body.expires_at}"`,
    );
  }
  return { token: body.token, expiresAt };
}

function entryIsFresh(entry: CacheEntry, now: number): boolean {
  return now < entry.expiresAt - REFRESH_LEAD_MS;
}

/** Return a valid installation token for `installationId`, hitting the
 *  module-level cache when possible. Concurrent callers during a
 *  refresh share one in-flight `refreshing` promise so we never mint
 *  N tokens for N parallel orchestrator steps. */
export async function getInstallationToken(
  env: Bindings,
  installationId: number,
  options: FetchInstallationTokenOptions = {},
): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error(
      "GitHub App credentials missing: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set.",
    );
  }

  const now = Date.now();
  const cached = installationTokenCache.get(installationId);
  if (cached) {
    if (entryIsFresh(cached, now)) return cached.token;
    if (cached.refreshing) return cached.refreshing;
  }

  const refreshing = (async () => {
    const jwt = await signAppJwt(env.GITHUB_APP_ID as string, env.GITHUB_APP_PRIVATE_KEY as string);
    const { token, expiresAt } = await fetchInstallationToken(jwt, installationId, options);
    installationTokenCache.set(installationId, { token, expiresAt });
    return token;
  })();

  // Stash the in-flight promise so concurrent callers attach instead of
  // spawning their own mints. Whether we had a stale cache entry or no
  // entry at all, the right thing to do is to record the refresh.
  installationTokenCache.set(installationId, {
    token: cached?.token ?? "",
    expiresAt: cached?.expiresAt ?? 0,
    refreshing,
  });

  try {
    return await refreshing;
  } catch (err) {
    // Drop the failed entry so the next call re-attempts a clean mint
    // rather than serving a stale token (or worse, an empty string).
    if (!cached || !entryIsFresh(cached, Date.now())) {
      installationTokenCache.delete(installationId);
    } else {
      // We had a still-fresh stale entry; preserve it without the
      // failed refresh promise.
      installationTokenCache.set(installationId, {
        token: cached.token,
        expiresAt: cached.expiresAt,
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------
// Discriminated source for the orchestrator + webhooks (Phase 3 wires).
// ---------------------------------------------------------------------

export type GitHubAuth =
  | { kind: "pat"; token: string }
  | { kind: "app"; installationId: number; getToken: () => Promise<string> };

/** Pick the right auth source for an operation targeting `installationId`.
 *  Returns App auth when all three of GITHUB_APP_ID,
 *  GITHUB_APP_PRIVATE_KEY, and `installationId` are available; otherwise
 *  falls back to the legacy `GITHUB_ADMIN_PAT`. The fallback is what
 *  keeps dev environments without the App secrets working until they
 *  set them. */
export function getDefaultGitHubAuth(env: Bindings, installationId?: number): GitHubAuth {
  if (installationId !== undefined && env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
    return {
      kind: "app",
      installationId,
      getToken: () => getInstallationToken(env, installationId),
    };
  }
  return { kind: "pat", token: env.GITHUB_ADMIN_PAT };
}

/** Map an org login to the configured installation ID, or `undefined` if
 *  the env doesn't have it. The helper exists so Phase 3 callsites can
 *  do `getDefaultGitHubAuth(env, resolveInstallationId(env, "nemarDatasets"))`
 *  and stay decoupled from the exact env variable names. */
export function resolveInstallationId(env: Bindings, orgLogin: string): number | undefined {
  let raw: string | undefined;
  if (orgLogin === "nemarDatasets") raw = env.GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS;
  else if (orgLogin === "nemarOrg") raw = env.GITHUB_APP_INSTALLATION_ID_NEMAR_ORG;
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
