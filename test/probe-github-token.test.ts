/**
 * Tests for scripts/ci/probe-github-token.ts (issue #1321).
 *
 * Drives the REAL script entry point as a subprocess against a local
 * `Bun.serve` stand-in for `api.github.com` (`test/helpers/fetch-counter`),
 * per this repo's "test the entry point, not the piece" rule
 * (.rules/testing.md): calling `evaluateTokenStatus` directly would not
 * catch a regression in argument parsing, env-var handling, or how `main()`
 * wires the fetch into the decision function.
 *
 * The stand-in's base URL is passed via `GITHUB_API_BASE_URL`, a name this
 * repo's CI tier grep does not recognize as a live-backend marker, so this
 * file is auto-classified as a pure/offline test (see the `unit-pure` and
 * `integration-dev` job bodies in `.github/workflows/test.yml`). Do not add
 * this suite's server-selection env var, or literally spell out the three
 * marker names those jobs grep for, anywhere in this file: doing so moves
 * it to the live tier even though it never touches a real backend.
 */

import { describe, expect, test } from "bun:test";
import { json, startFakeGithub } from "./helpers/fetch-counter";

const SCRIPT = new URL("../scripts/ci/probe-github-token.ts", import.meta.url).pathname;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runProbe(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("probe-github-token", () => {
  test("401 fails with a labeled error naming the secret, owner, scopes, and rotation command", async () => {
    const fake = startFakeGithub({
      "GET /user": () => json(401, { message: "Bad credentials" }),
    });
    try {
      const result = await runProbe(
        [
          "GH_TOKEN",
          "--owner",
          "nemarAdmin",
          "--require-scopes",
          "repo,workflow",
          "--issue",
          "1321",
        ],
        { GH_TOKEN: "fake-token", GITHUB_API_BASE_URL: fake.url },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("::error::");
      expect(result.stdout).toContain("GH_TOKEN");
      expect(result.stdout).toContain("nemarAdmin");
      expect(result.stdout).toContain("repo, workflow");
      expect(result.stdout).toContain("gh secret set GH_TOKEN --repo nemarOrg/nemar-cli");
      expect(result.stdout).toContain("#1321");
      // Never echo the token itself.
      expect(result.stdout).not.toContain("fake-token");
    } finally {
      fake.stop();
    }
  });

  test("200 with scopes and a near expiry warns but passes", async () => {
    const nearExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const fake = startFakeGithub({
      "GET /user": () =>
        new Response(JSON.stringify({ login: "nemarAdmin" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-oauth-scopes": "repo, workflow",
            "github-authentication-token-expiration": nearExpiry,
          },
        }),
    });
    try {
      const result = await runProbe(
        [
          "GH_TOKEN",
          "--owner",
          "nemarAdmin",
          "--require-scopes",
          "repo,workflow",
          "--warn-days",
          "30",
        ],
        { GH_TOKEN: "fake-token", GITHUB_API_BASE_URL: fake.url },
      );
      expect(result.stdout).toContain("authenticated as nemarAdmin");
      expect(result.stdout).toContain("scopes = repo, workflow");
      expect(result.stdout).toContain("::warning::");
      expect(result.stdout).not.toContain("::error::");
      expect(result.exitCode).toBe(0);
    } finally {
      fake.stop();
    }
  });

  test("200 missing a required scope fails even though the token authenticates", async () => {
    const fake = startFakeGithub({
      "GET /user": () =>
        new Response(JSON.stringify({ login: "nemarAdmin" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-oauth-scopes": "repo",
          },
        }),
    });
    try {
      const result = await runProbe(
        ["GH_TOKEN", "--owner", "nemarAdmin", "--require-scopes", "repo,workflow"],
        { GH_TOKEN: "fake-token", GITHUB_API_BASE_URL: fake.url },
      );
      expect(result.stdout).toContain("::error::");
      expect(result.stdout).toContain("missing required scope(s): workflow");
      expect(result.exitCode).toBe(1);
    } finally {
      fake.stop();
    }
  });

  test("200 with no expiry header reports no expiry and passes", async () => {
    const fake = startFakeGithub({
      "GET /user": () =>
        new Response(JSON.stringify({ login: "docs-bot" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-oauth-scopes": "repo",
          },
        }),
    });
    try {
      const result = await runProbe(["DOCS_READ_TOKEN", "--owner", "unknown"], {
        DOCS_READ_TOKEN: "fake-token",
        GITHUB_API_BASE_URL: fake.url,
      });
      expect(result.stdout).toContain("no expiry (token does not expire)");
      expect(result.stdout).not.toContain("::error::");
      expect(result.stdout).not.toContain("::warning::");
      expect(result.exitCode).toBe(0);
    } finally {
      fake.stop();
    }
  });

  test("500 fails and says it could not verify, never a pass", async () => {
    const fake = startFakeGithub({
      "GET /user": () => json(500, { message: "internal error" }),
    });
    try {
      const result = await runProbe(["GH_TOKEN", "--owner", "nemarAdmin"], {
        GH_TOKEN: "fake-token",
        GITHUB_API_BASE_URL: fake.url,
      });
      expect(result.stdout).toContain("::error::");
      expect(result.stdout.toLowerCase()).toContain("could not verify");
      expect(result.stdout.toLowerCase()).toContain("http 500");
      expect(result.exitCode).toBe(1);
    } finally {
      fake.stop();
    }
  });
});
