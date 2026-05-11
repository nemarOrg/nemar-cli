#!/usr/bin/env bun
/**
 * verify-github-app.ts
 *
 * Validates a freshly-created GitHub App from epic #432 Phase 1. Signs a
 * 10-minute RS256 JWT with the App's private key, lists installations,
 * mints a 60-minute access token for each, and prints the repository
 * count visible under each installation.
 *
 * The JWT-signing logic here is the prototype that Phase 2 (#437) will
 * lift into `backend/src/services/github-auth.ts`. The unit test in
 * `test/verify-github-app.test.ts` covers the helper exhaustively;
 * the CLI wrapper below is intentionally a thin shell around it.
 *
 * Usage:
 *   bun run scripts/verify-github-app.ts --app-id <N> --private-key <PATH>
 *
 * The private key must be PKCS#8 PEM. GitHub downloads PKCS#1 by default;
 * convert with:
 *   openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in <in> -out <out>
 */

const EXPECTED_LOGINS = ["nemarOrg", "nemarDatasets"];
const GITHUB_API = "https://api.github.com";

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

/** Encode a Uint8Array or ArrayBuffer as URL-safe base64 (RFC 7515 §2). */
function base64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Strip the PKCS#8 PEM header/footer and base64-decode the body to raw
 * DER bytes suitable for `crypto.subtle.importKey({ format: "pkcs8", ... })`.
 *
 * Rejects PKCS#1 ("BEGIN RSA PRIVATE KEY"). The GitHub UI hands out PKCS#1
 * by default; the runbook tells the maintainer to convert with
 * `openssl pkcs8 -topk8`. We surface a clear error rather than silently
 * trying — Web Crypto's importKey would reject anyway, but with an opaque
 * "DataError" message.
 */
function pkcs8PemToDer(pem: string): ArrayBuffer {
  const trimmed = pem.trim();
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
 * Sign a 10-minute App JWT (RS256) per
 * https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app.
 *
 * Exported so the unit test in `test/verify-github-app.test.ts` can
 * verify the signature against the matching public key without going
 * over the network.
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

  // GitHub rejects JWTs whose `iat` is in the future even by a second of
  // clock skew. Subtract 30 s as a safety margin.
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

async function ghGet<T>(path: string, token: string, scheme: "Bearer" | "token"): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `${scheme} ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "nemar-verify-github-app",
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} -> HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function ghPost<T>(path: string, token: string, scheme: "Bearer" | "token"): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `${scheme} ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "nemar-verify-github-app",
    },
  });
  if (!res.ok) {
    throw new Error(`POST ${path} -> HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
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
}

async function main(): Promise<void> {
  const { appId, privateKeyPath } = parseArgs(process.argv.slice(2));

  const pem = await Bun.file(privateKeyPath).text();
  const jwt = await signAppJwt(appId, pem);

  console.log("Listing installations...");
  const installations = await ghGet<Installation[]>("/app/installations", jwt, "Bearer");
  if (installations.length === 0) {
    throw new Error(
      "App has no installations. Install on both nemarOrg and nemarDatasets per the runbook.",
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
    foundLogins.add(login);
    const tokenResponse = await ghPost<{ token: string }>(
      `/app/installations/${inst.id}/access_tokens`,
      jwt,
      "Bearer",
    );
    const repos = await ghGet<InstallationRepos>(
      "/installation/repositories?per_page=1",
      tokenResponse.token,
      "token",
    );
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
    process.exit(1);
  }

  console.log("");
  console.log("OK: both expected installations validated.");
}

// Only run main() when executed directly. Importing the module for tests
// (which pull in `signAppJwt`) must not trigger CLI parsing or network.
if (import.meta.main) {
  main().catch((err) => {
    console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
