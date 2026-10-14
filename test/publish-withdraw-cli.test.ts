/**
 * `nemar dataset publish withdraw`, and how a withdrawal reads in
 * `publish status` and `admin publish list`, through the real CLI entry point.
 *
 * Same harness as test/identifier-screen-cli.test.ts: a real subprocess pointed
 * at a local HTTP server that answers with the backend's response shape. The
 * backend's own rules (who may withdraw, when it is too late) are tested
 * against the real route in backend/test/publish-withdraw.test.ts; what is
 * asserted here is what the CLI sends and what a person reads.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const REPO_ROOT = join(import.meta.dir, "..");

interface Route {
  status?: number;
  body: unknown;
}

function startServer(routes: Record<string, Route>) {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      seen.push(`${req.method} ${url.pathname}`);
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json(route.body, { status: route.status ?? 200 });
    },
  });
  return { url: `http://localhost:${server.port}`, seen, stop: () => server.stop(true) };
}

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-withdraw-cli-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ activeAccount: "wdcli", accounts: { wdcli: { apiKey: "k" } } }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

async function runCli(args: string[], apiUrl: string) {
  const env = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: apiUrl,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  env.FORCE_COLOR = undefined;
  env.CLICOLOR_FORCE = undefined;
  const proc = spawn({
    cmd: ["bun", "run", join(REPO_ROOT, "src/index.ts"), ...args],
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

const WITHDRAW = "POST /datasets/nm000104/publish/withdraw";

describe("nemar dataset publish withdraw", () => {
  test("--yes withdraws and says how to request again", async () => {
    const server = startServer({
      [WITHDRAW]: { body: { message: "Publication request withdrawn", dataset_id: "nm000104" } },
    });
    try {
      const r = await runCli(["dataset", "publish", "withdraw", "nm000104", "--yes"], server.url);
      expect(r.exitCode).toBe(0);
      expect(server.seen).toEqual(["POST /datasets/nm000104/publish/withdraw"]);
      expect(r.stdout + r.stderr).toContain("Publication request withdrawn for nm000104");
      expect(r.stdout).toContain("nemar dataset publish request nm000104");
    } finally {
      server.stop();
    }
  });

  test("--no sends nothing", async () => {
    const server = startServer({ [WITHDRAW]: { body: {} } });
    try {
      const r = await runCli(["dataset", "publish", "withdraw", "nm000104", "--no"], server.url);
      expect(r.exitCode).toBe(0);
      expect(server.seen).toEqual([]);
      expect(r.stdout).toContain("Skipped");
    } finally {
      server.stop();
    }
  });

  test("too late: the backend's words reach the terminal and the exit code is 1", async () => {
    const server = startServer({
      [WITHDRAW]: {
        status: 409,
        body: {
          error: "An administrator has already started publishing this dataset.",
          code: "withdraw_too_late",
        },
      },
    });
    try {
      const r = await runCli(["dataset", "publish", "withdraw", "nm000104", "--yes"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.stdout + r.stderr).toContain("already started publishing");
    } finally {
      server.stop();
    }
  });

  test("no active request: says so and exits 1", async () => {
    const server = startServer({
      [WITHDRAW]: { status: 404, body: { error: "No active publication request found" } },
    });
    try {
      const r = await runCli(["dataset", "publish", "withdraw", "nm000104", "--yes"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.stdout + r.stderr).toContain("There is no active publication request");
    } finally {
      server.stop();
    }
  });
});

describe("how a withdrawal reads", () => {
  test("publish status says withdrawn and how to request again", async () => {
    const server = startServer({
      "GET /datasets/nm000104/publish/status": {
        body: {
          dataset_id: "nm000104",
          status: "denied",
          withdrawn: true,
          withdrawn_at: "2026-10-14 18:00:00",
          denied_reason: null,
          requested_at: "2026-10-14 12:00:00",
          requested_by: "alice",
          steps_completed: [],
          current_step: null,
          last_error: null,
          anonymous: false,
        },
      },
    });
    try {
      const r = await runCli(["dataset", "publish", "status", "nm000104"], server.url);
      expect(r.stdout).toContain("Status: withdrawn");
      expect(r.stdout).not.toContain("Status: denied");
      expect(r.stdout).toContain("nemar dataset publish request nm000104");
    } finally {
      server.stop();
    }
  });

  test("an ordinary denial still reads as denied, with its reason", async () => {
    const server = startServer({
      "GET /datasets/nm000104/publish/status": {
        body: {
          dataset_id: "nm000104",
          status: "denied",
          withdrawn: false,
          denied_reason: "incomplete",
          steps_completed: [],
        },
      },
    });
    try {
      const r = await runCli(["dataset", "publish", "status", "nm000104"], server.url);
      expect(r.stdout).toContain("Status: denied");
      expect(r.stdout).toContain("incomplete");
    } finally {
      server.stop();
    }
  });

  test("admin publish list shows a withdrawn request as withdrawn", async () => {
    const server = startServer({
      "GET /admin/publish/requests": {
        body: {
          count: 2,
          requests: [
            {
              id: 1,
              dataset_id: "nm000104",
              status: "denied",
              withdrawn_at: "2026-10-14 18:00:00",
              requested_at: "2026-10-14 12:00:00",
              requested_by_username: "alice",
              requested_by_email: "alice@example.org",
              steps_completed: [],
              current_step: null,
              last_error: null,
            },
            {
              id: 2,
              dataset_id: "nm000105",
              status: "denied",
              withdrawn_at: null,
              requested_at: "2026-10-14 12:00:00",
              requested_by_username: "bob",
              requested_by_email: "bob@example.org",
              steps_completed: [],
              current_step: null,
              last_error: null,
            },
          ],
        },
      },
    });
    try {
      const r = await runCli(["admin", "publish", "list"], server.url);
      expect(r.stdout).toMatch(/nm000104\s+withdrawn/);
      expect(r.stdout).toMatch(/nm000105\s+denied/);
    } finally {
      server.stop();
    }
  });
});
