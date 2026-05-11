#!/usr/bin/env bun
/**
 * verify-github-app.ts
 *
 * Validates a GitHub App: signs an RS256 JWT, lists installations, mints
 * per-install tokens, and prints visible repo counts. Exits non-zero
 * with a distinct code per failure class so CI can react.
 *
 * Exit codes:
 *   0  OK
 *   1  unexpected runtime failure
 *   2  bad CLI args
 *   3  auth (401 from GitHub, often clock skew, wrong App ID, or wrong key)
 *   4  network (fetch threw)
 *   5  missing expected installations
 *
 * Usage:
 *   bun run scripts/verify-github-app.ts --app-id <N> --private-key <PATH>
 *
 * The private key must be PKCS#8 PEM. GitHub downloads PKCS#1 by default;
 * convert with:
 *   openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in <in> -out <out>
 */

const GITHUB_API = "https://api.github.com";

// Default to the two production orgs; override via env for testing or org renames.
const EXPECTED_LOGINS = (process.env.NEMAR_VERIFY_LOGINS ?? "nemarOrg,nemarDatasets")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

interface Installation {
  id: number;
  account: { login: string; type?: string } | null;
  target_type?: string;
}

interface Repo {
  name: string;
}

interface InstallationRepos {
  total_count: number;
  repositories: Repo[];
}

class AuthError extends Error {}
class NetworkError extends Error {}

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
      "Private key is an encrypted PKCS#8 file. Re-export unencrypted with:\n  openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in <in> -out <out>",
    );
  }
  if (trimmed.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "Private key is PKCS#1, not PKCS#8. Convert with:\n  openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in <in> -out <out>",
    );
  }
  const match = trimmed.match(
    /-----BEGIN PRIVATE KEY-----\s*([\s\S]+?)\s*-----END PRIVATE KEY-----/,
  );
  if (!match) {
    throw new Error("Could not find PKCS#8 PEM block in private key file.");
  }
  const body = match[1].replace(/\s+/g, "");
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der.buffer;
}

/**
 * Sign a 10-minute App JWT (RS256). Exported so unit tests can verify
 * the signature offline and Phase 2 can lift this into the Worker.
 */
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

  // Subtract 30 s; GitHub rejects future iat under clock skew.
  const iat = nowSeconds - 30;
  const exp = iat + 600;
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat, exp, iss: String(appId) };

  const encoded = `${base64url(new TextEncoder().encode(JSON.stringify(header)))}.${base64url(
    new TextEncoder().encode(JSON.stringify(payload)),
  )}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(encoded),
  );
  return `${encoded}.${base64url(sig)}`;
}

async function ghRequest(
  method: "GET" | "POST",
  path: string,
  token: string,
  scheme: "Bearer" | "token",
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        Authorization: `${scheme} ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "nemar-verify-github-app",
      },
    });
  } catch (e) {
    throw new NetworkError(`${method} ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 401) {
    throw new AuthError(`${method} ${path} -> HTTP 401: ${await res.text()}`);
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function listInstallations(jwt: string): Promise<Installation[]> {
  const body = await ghRequest("GET", "/app/installations", jwt, "Bearer");
  if (!Array.isArray(body)) {
    throw new Error(`GET /app/installations: expected array, got: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body as Installation[];
}

async function mintInstallationToken(jwt: string, installationId: number): Promise<string> {
  const body = await ghRequest(
    "POST",
    `/app/installations/${installationId}/access_tokens`,
    jwt,
    "Bearer",
  );
  const t = (body as { token?: unknown }).token;
  if (typeof t !== "string" || t.length === 0) {
    throw new Error(
      `POST /app/installations/${installationId}/access_tokens: response missing string \`token\`: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  return t;
}

async function listInstallationRepos(token: string): Promise<InstallationRepos> {
  const body = await ghRequest(
    "GET",
    "/installation/repositories?per_page=1",
    token,
    "token",
  );
  const count = (body as { total_count?: unknown }).total_count;
  const repos = (body as { repositories?: unknown }).repositories;
  if (typeof count !== "number" || !Array.isArray(repos)) {
    throw new Error(
      `GET /installation/repositories: response missing \`total_count\` or \`repositories\`: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  return { total_count: count, repositories: repos as Repo[] };
}

function parseArgs(argv: string[]): { appId: string; privateKeyPath: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--app-id") out.appId = argv[++i];
    else if (arg === "--private-key") out.privateKeyPath = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  if (!out.appId || !out.privateKeyPath) {
    printUsage();
    process.exit(2);
  }
  return { appId: out.appId, privateKeyPath: out.privateKeyPath };
}

function printUsage(): void {
  console.error(
    "Usage: bun run scripts/verify-github-app.ts --app-id <N> --private-key <PATH>",
  );
  console.error("");
  console.error("  --app-id        Numeric GitHub App ID from the App settings page.");
  console.error("  --private-key   Path to PKCS#8 PEM file (see docs/guides/github-app-setup.md).");
  console.error("");
  console.error("Override expected orgs via NEMAR_VERIFY_LOGINS=org1,org2 (case-insensitive).");
}

async function main(): Promise<void> {
  const { appId, privateKeyPath } = parseArgs(process.argv.slice(2));
  const pem = await Bun.file(privateKeyPath).text();
  const jwt = await signAppJwt(appId, pem);

  console.log("Listing installations...");
  const installations = await listInstallations(jwt);
  if (installations.length === 0) {
    throw new Error(
      "App has no installations. Install on both expected orgs per the runbook.",
    );
  }
  for (const inst of installations) {
    const login = inst.account?.login ?? "(unknown)";
    console.log(
      `  installation_id=${inst.id} account=${login} target_type=${inst.target_type ?? inst.account?.type ?? "?"}`,
    );
  }

  console.log("");
  console.log("Minting installation tokens and listing repositories...");
  const foundLogins = new Set<string>();
  for (const inst of installations) {
    const login = inst.account?.login ?? "(unknown)";
    foundLogins.add(login.toLowerCase());
    const token = await mintInstallationToken(jwt, inst.id);
    const repos = await listInstallationRepos(token);
    const first = repos.repositories[0]?.name ?? "(none)";
    console.log(
      `  installation_id=${inst.id} account=${login} repos=${repos.total_count} first_repo=${first}`,
    );
  }

  const missing = EXPECTED_LOGINS.filter((l) => !foundLogins.has(l));
  if (missing.length > 0) {
    console.error("");
    console.error(
      `FAIL: missing installations for: ${missing.join(", ")}. Install the App on each org with "All repositories" scope.`,
    );
    process.exit(5);
  }

  console.log("");
  console.log("OK: expected installations validated.");
}

// Guard so importers (tests) don't trigger CLI/network.
if (import.meta.main) {
  main().catch((err) => {
    if (err instanceof AuthError) {
      console.error(`FAIL: ${err.message}`);
      console.error(
        `\nLocal clock now: ${new Date().toISOString()}. Compare against \`date -u\` to rule out skew (>30 s drift breaks JWT iat). Also double-check the App ID and private key.`,
      );
      process.exit(3);
    }
    if (err instanceof NetworkError) {
      console.error(`FAIL: network error: ${err.message}`);
      process.exit(4);
    }
    console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
