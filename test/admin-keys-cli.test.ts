/**
 * CLI `nemar admin keys create|list|revoke` (epic #1272 phase 4, #1284;
 * ADR 0048), driven through the real entry point
 * (`bun run src/index.ts admin keys ...`).
 *
 * Harness mirrors test/admin-approve-tier-cli.test.ts: a real subprocess CLI
 * invocation against a real local HTTP server via TEST_API_URL, isolated
 * NEMAR_CONFIG_DIR, no mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

let configDir: string;

function seedAuthenticatedConfig(): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "keyscliowner",
      accounts: { keyscliowner: { apiKey: "test-owner-key" } },
    }),
  );
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-admin-keys-cli-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

interface CaptureServer {
  url: string;
  requests: { method: string; url: URL }[];
  stop: () => void;
}

function startServer(body: unknown, status = 200): CaptureServer {
  const requests: { method: string; url: URL }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      requests.push({ method: req.method, url });
      return Response.json(body, { status });
    },
  });
  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) };
}

async function runCli(args: string[], testApiUrl: string) {
  const env = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: testApiUrl,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  env.FORCE_COLOR = undefined;
  env.CLICOLOR_FORCE = undefined;
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode, combined: `${stdout}${stderr}` };
}

describe("nemar admin keys create", () => {
  test("prints the minted key once and the sign-in hint", async () => {
    seedAuthenticatedConfig();
    const server = startServer({
      api_key: "nm_mintedkeyforservice0123456789abcdef",
      key: {
        id: 5,
        name: "svc-job",
        prefix: "nm_minte...",
        created_at: "2026-09-01",
        last_used_at: null,
        current: false,
      },
    });
    try {
      const result = await runCli(
        ["admin", "keys", "create", "svc-account", "svc-job"],
        server.url,
      );
      expect(result.exitCode).toBe(0);
      expect(result.combined).toContain("nm_mintedkeyforservice0123456789abcdef");
      expect(result.combined).toContain("nemar auth login --key");
      expect(
        server.requests.some(
          (r) => r.method === "POST" && r.url.pathname === "/admin/users/svc-account/keys",
        ),
      ).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("a 403 person_account refusal surfaces the hint", async () => {
    seedAuthenticatedConfig();
    const server = startServer(
      {
        error: "person_account",
        message:
          "A person creates their own keys with `nemar auth login` or in Settings on nemar.org.",
      },
      403,
    );
    try {
      const result = await runCli(["admin", "keys", "create", "a-person", "x"], server.url);
      expect(result.combined).toContain("person_account");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin keys list", () => {
  test("lists the target account's keys", async () => {
    seedAuthenticatedConfig();
    const server = startServer({
      keys: [
        {
          id: 1,
          name: "svc-job",
          prefix: "nm_abcd...",
          created_at: "2026-09-01T00:00:00Z",
          last_used_at: null,
          current: false,
        },
      ],
    });
    try {
      const result = await runCli(["admin", "keys", "list", "svc-account"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("svc-job");
      expect(result.stdout).toContain("nm_abcd...");
      expect(
        server.requests.some(
          (r) => r.method === "GET" && r.url.pathname === "/admin/users/svc-account/keys",
        ),
      ).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("an empty list says so rather than printing nothing", async () => {
    seedAuthenticatedConfig();
    const server = startServer({ keys: [] });
    try {
      const result = await runCli(["admin", "keys", "list", "svc-account"], server.url);
      expect(result.stdout).toContain("No live keys");
    } finally {
      server.stop();
    }
  });
});

describe("nemar admin keys revoke", () => {
  test("revokes by id and confirms", async () => {
    seedAuthenticatedConfig();
    const server = startServer({ ok: true });
    try {
      const result = await runCli(["admin", "keys", "revoke", "svc-account", "5"], server.url);
      expect(result.exitCode).toBe(0);
      expect(result.combined).toContain("revoked");
      expect(
        server.requests.some(
          (r) => r.method === "DELETE" && r.url.pathname === "/admin/users/svc-account/keys/5",
        ),
      ).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("an invalid id is refused before any request", async () => {
    seedAuthenticatedConfig();
    const server = startServer({ ok: true });
    try {
      const result = await runCli(
        ["admin", "keys", "revoke", "svc-account", "notanumber"],
        server.url,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.combined).toContain("Invalid key id");
      expect(server.requests).toHaveLength(0);
    } finally {
      server.stop();
    }
  });

  test("a 404 key_not_found surfaces the hint", async () => {
    seedAuthenticatedConfig();
    const server = startServer({ error: "key_not_found", message: "not found" }, 404);
    try {
      const result = await runCli(["admin", "keys", "revoke", "svc-account", "999"], server.url);
      expect(result.combined).toContain("User or key not found");
    } finally {
      server.stop();
    }
  });
});
