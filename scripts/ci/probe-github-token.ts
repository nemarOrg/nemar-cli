#!/usr/bin/env bun
/**
 * probe-github-token.ts
 *
 * Checks whether a GitHub-token secret (a classic or fine-grained PAT stored
 * as a repository secret) is still valid, before something that needs it
 * finds out the hard way. Built for issue #1321: `e2e-upload` has failed on
 * every release since v0.10.0 because `GH_TOKEN` expired, and both failures
 * surfaced as opaque "gh CLI error: gh: Bad credentials (HTTP 401)" test
 * failures instead of a labeled credential problem.
 *
 * Usage:
 *   bun run scripts/ci/probe-github-token.ts <ENV_VAR_NAME> \
 *     --owner <github-login-or-unknown> \
 *     [--require-scopes scope1,scope2] \
 *     [--warn-days 30] \
 *     [--fail-days 14] \
 *     [--issue 1321]
 *
 * <ENV_VAR_NAME> names the environment variable holding the token (e.g.
 * `GH_TOKEN`); the token itself is never taken as a CLI argument, so it
 * cannot land in a process list or shell history.
 *
 * Exit codes:
 *   0  token authenticates, and every requested check passed
 *   1  token is rejected (401), missing a required scope, expiring within
 *      --fail-days, or the probe could not reach the API at all
 *
 * A 200 whose `login` does not match `--owner` (case-insensitively) is a
 * `::warning::`, not a failure: the token still authenticates.
 *
 * The token is never printed, logged, or included in any error message.
 *
 * The pure decision logic lives in `evaluateTokenStatus`: HTTP status plus
 * response headers in, a verdict out. `main()` does the network I/O and
 * argument parsing around it; tests drive the compiled script as a
 * subprocess against a `Bun.serve` stand-in, per this repo's "test the
 * entry point, not the piece" rule (.rules/testing.md).
 */

import { parseArgs } from "node:util";

const DEFAULT_GITHUB_API_BASE = "https://api.github.com";
const DEFAULT_WARN_DAYS = 30;

export interface ProbeHeaders {
  /** Raw `x-oauth-scopes` header value, or null if the header was absent. */
  scopes: string | null;
  /**
   * Raw `github-authentication-token-expiration` header value, or null if
   * the header was absent (no expiry).
   */
  expiration: string | null;
}

export type ProbeStatus = number | "network-error";

export interface ProbeOptions {
  /** Name of the secret / env var being probed, e.g. "GH_TOKEN". */
  secretName: string;
  /** GitHub login that should own the token, or "unknown". */
  owner: string;
  requireScopes: string[];
  warnDays: number;
  /** null means the --fail-days gate is off. */
  failDays: number | null;
  issue?: number;
  /** Injectable for tests; defaults to `new Date()`. */
  now?: Date;
}

export interface ProbeVerdict {
  /** true = probe passed (exit 0); false = probe failed (exit 1). */
  ok: boolean;
  login: string | null;
  scopes: string[] | "unknown";
  expiresAt: Date | null;
  /** Lines to print, in order, including any ::error::/::warning:: annotations. */
  lines: string[];
}

function rotateCommand(secretName: string): string {
  return `gh secret set ${secretName} --repo nemarOrg/nemar-cli`;
}

function issueSuffix(issue?: number): string {
  return issue === undefined ? "" : ` (issue #${issue})`;
}

/**
 * Pure decision logic: HTTP status plus the two headers GitHub returns on
 * `GET /user` in, a verdict out. No network access, no env reads, so tests
 * can hand it every status/header combination directly.
 */
export function evaluateTokenStatus(
  status: ProbeStatus,
  headers: ProbeHeaders,
  body: unknown,
  options: ProbeOptions,
): ProbeVerdict {
  const rotate = rotateCommand(options.secretName);
  const suffix = issueSuffix(options.issue);

  if (status === "network-error") {
    return {
      ok: false,
      login: null,
      scopes: "unknown",
      expiresAt: null,
      lines: [
        `::error::Could not verify ${options.secretName}: network error contacting the GitHub API. Treating this as a failed probe, not a pass.`,
      ],
    };
  }

  if (status === 401) {
    return {
      ok: false,
      login: null,
      scopes: "unknown",
      expiresAt: null,
      lines: [
        `::error::${options.secretName} is rejected by the GitHub API (401 Bad credentials). ` +
          `It should be a token owned by ${options.owner} with scope(s): ` +
          `${options.requireScopes.length > 0 ? options.requireScopes.join(", ") : "(none declared)"}. ` +
          `Rotate it with: ${rotate}.${suffix}`,
      ],
    };
  }

  if (status !== 200) {
    return {
      ok: false,
      login: null,
      scopes: "unknown",
      expiresAt: null,
      lines: [
        `::error::Could not verify ${options.secretName}: GitHub API returned HTTP ${status} for GET /user, expected 200 or 401. Treating this as a failed probe, not a pass.`,
      ],
    };
  }

  // status === 200: authenticated. Report identity, scopes, and expiry, and
  // only fail on a missing required scope or an imminent/expired --fail-days.
  const login =
    body !== null && typeof body === "object" && "login" in body && typeof body.login === "string"
      ? body.login
      : null;
  const scopes: string[] | "unknown" =
    headers.scopes === null
      ? "unknown"
      : headers.scopes
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

  const lines: string[] = [];
  lines.push(`${options.secretName}: authenticated as ${login ?? "(login not reported)"}`);
  lines.push(
    `${options.secretName}: scopes = ${
      scopes === "unknown"
        ? "unknown (fine-grained PAT or header absent)"
        : scopes.join(", ") || "(none)"
    }`,
  );

  let ok = true;

  // A mismatch here is a warning, not a failure: the token still authenticates
  // and may still be perfectly usable (e.g. rotated onto a different but still
  // authorized account). It is worth flagging because a probe configured with
  // `--owner nemarAdmin` that quietly starts passing as a different account
  // would otherwise go unnoticed until that account loses access.
  if (
    login !== null &&
    options.owner.toLowerCase() !== "unknown" &&
    login.toLowerCase() !== options.owner.toLowerCase()
  ) {
    lines.push(
      `::warning::${options.secretName} authenticated as ${login}, but --owner expected ` +
        `${options.owner}. Update --owner if this account change is intentional.`,
    );
  }

  if (scopes !== "unknown" && options.requireScopes.length > 0) {
    const missing = options.requireScopes.filter((s) => !scopes.includes(s));
    if (missing.length > 0) {
      ok = false;
      lines.push(
        `::error::${options.secretName} is missing required scope(s): ${missing.join(", ")}. ` +
          `Rotate it with: ${rotate}.${suffix}`,
      );
    }
  }

  let expiresAt: Date | null = null;
  if (headers.expiration === null) {
    lines.push(`${options.secretName}: no expiry (token does not expire)`);
  } else {
    const parsed = new Date(headers.expiration);
    if (Number.isNaN(parsed.getTime())) {
      lines.push(
        `${options.secretName}: expiry header present but unparseable ("${headers.expiration}")`,
      );
    } else {
      expiresAt = parsed;
      const now = options.now ?? new Date();
      const daysLeft = (parsed.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
      const rounded = daysLeft.toFixed(1);
      lines.push(
        `${options.secretName}: expires ${headers.expiration} (${rounded} day(s) from now)`,
      );

      if (options.failDays !== null && daysLeft <= options.failDays) {
        ok = false;
        lines.push(
          `::error::${options.secretName} expires in ${rounded} day(s), at or below --fail-days ` +
            `${options.failDays}. Rotate it with: ${rotate}.${suffix}`,
        );
      } else if (daysLeft <= options.warnDays) {
        lines.push(
          `::warning::${options.secretName} expires in ${rounded} day(s), at or below --warn-days ` +
            `${options.warnDays}. Consider rotating soon: ${rotate}.`,
        );
      }
    }
  }

  return { ok, login, scopes, expiresAt, lines };
}

interface CliArgs {
  envVarName: string;
  owner: string;
  requireScopes: string[];
  warnDays: number;
  failDays: number | null;
  issue?: number;
}

function usage(): string {
  return (
    "Usage: bun run scripts/ci/probe-github-token.ts <ENV_VAR_NAME> " +
    "--owner <login> [--require-scopes a,b] [--warn-days N] [--fail-days N] [--issue N]"
  );
}

export function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      owner: { type: "string", default: "unknown" },
      "require-scopes": { type: "string", default: "" },
      "warn-days": { type: "string", default: String(DEFAULT_WARN_DAYS) },
      "fail-days": { type: "string" },
      issue: { type: "string" },
    },
  });

  const envVarName = positionals[0];
  if (!envVarName) {
    throw new Error(usage());
  }

  const warnDays = Number(values["warn-days"]);
  if (!Number.isFinite(warnDays)) {
    throw new Error(`--warn-days must be a number, got: ${values["warn-days"]}`);
  }

  let failDays: number | null = null;
  if (values["fail-days"] !== undefined) {
    failDays = Number(values["fail-days"]);
    if (!Number.isFinite(failDays)) {
      throw new Error(`--fail-days must be a number, got: ${values["fail-days"]}`);
    }
  }

  let issue: number | undefined;
  if (values.issue !== undefined) {
    issue = Number(values.issue);
    if (!Number.isFinite(issue)) {
      throw new Error(`--issue must be a number, got: ${values.issue}`);
    }
  }

  return {
    envVarName,
    owner: values.owner ?? "unknown",
    requireScopes: (values["require-scopes"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    warnDays,
    failDays,
    issue,
  };
}

async function fetchUser(
  base: string,
  token: string,
): Promise<{ status: ProbeStatus; headers: ProbeHeaders; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${base}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "nemar-cli-credential-probe",
      },
    });
  } catch {
    return { status: "network-error", headers: { scopes: null, expiration: null }, body: null };
  }

  const headers: ProbeHeaders = {
    scopes: response.headers.get("x-oauth-scopes"),
    expiration: response.headers.get("github-authentication-token-expiration"),
  };

  let body: unknown = null;
  if (response.status === 200) {
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  }

  return { status: response.status, headers, body };
}

/** Runs the probe end to end; returns the process exit code. Never throws. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const token = process.env[args.envVarName];
  if (!token) {
    console.log(
      `::error::Environment variable ${args.envVarName} is not set; cannot verify the token it ` +
        `should hold. Set it with: ${rotateCommand(args.envVarName)}.${issueSuffix(args.issue)}`,
    );
    return 1;
  }

  const base = process.env.GITHUB_API_BASE_URL || DEFAULT_GITHUB_API_BASE;
  const { status, headers, body } = await fetchUser(base, token);

  const verdict = evaluateTokenStatus(status, headers, body, {
    secretName: args.envVarName,
    owner: args.owner,
    requireScopes: args.requireScopes,
    warnDays: args.warnDays,
    failDays: args.failDays,
    issue: args.issue,
  });

  for (const line of verdict.lines) {
    console.log(line);
  }

  return verdict.ok ? 0 : 1;
}

// Guarded so importing this module for tests never hits the network.
if (import.meta.main) {
  main().then((code) => process.exit(code));
}
