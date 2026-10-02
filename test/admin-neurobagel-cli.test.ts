/**
 * `nemar admin neurobagel regenerate|status` (epic #1586, phase 4; ADR 0084), driven
 * through the real entry point (`bun run src/index.ts ...`), the way its sibling admin
 * CLI suites are, but against the REAL backend worker rather than a canned server: a
 * local HTTP server hands every request to `worker.fetch` with a real D1 (every
 * production migration), the R2 simulator `wrangler dev` runs, and the real data plane.
 * So the command, the HTTP contract and the writer are exercised together, and an
 * output line a person reads is a statement about what the store actually holds.
 *
 * Isolated NEMAR_CONFIG_DIR, no mocks.
 *
 * CI TIER: this file runs in the integration tier, not `unit-pure`, because the workflows
 * route a test by a text match on `TEST_API_URL` and the CLI spawn helper, as they route every
 * CLI suite that starts the binary against a local server (admin-keys-cli, admin-kind-cli, ...):
 * `TEST_API_URL` is the only API override the CLI reads. It touches no live backend and holds no
 * secret, so it also passes offline, which is how it is run here; moving it is a change to
 * that routing, not to this test.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import worker from "../backend/src/index";
import { hashApiKey } from "../backend/src/services/token";
import type { Bindings } from "../backend/src/types/bindings";
import {
  type Harness,
  seedSynthetic,
  startHarness,
  storeKeys,
} from "../backend/test/helpers/neurobagel-harness";
import { NEUROBAGEL_REGENERATE_MAX } from "../shared/contract/neurobagel-admin";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const ADMIN_KEY = "nb-cli-admin-key-0123456789abcdef0123456789abcdef";
const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

let h: Harness;
let configDir: string;
let server: ReturnType<typeof Bun.serve>;
let envOverrides: Partial<Bindings> = {};
/** Every request the server received, `METHOD /path`, so a test can say what was NOT sent. */
let requests: string[] = [];

beforeAll(async () => {
  h = await startHarness();
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      requests.push(`${req.method} ${new URL(req.url).pathname}`);
      return worker.fetch(req, h.env(envOverrides), ctx);
    },
  });
});
afterAll(async () => {
  server.stop(true);
  await h.dispose();
});

beforeEach(async () => {
  await h.reset();
  envOverrides = {};
  requests = [];
  configDir = mkdtempSync(join(tmpdir(), "nemar-admin-neurobagel-cli-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "nbcliadmin",
      accounts: { nbcliadmin: { apiKey: ADMIN_KEY } },
    }),
  );
  h.db
    .query(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access)
       VALUES ('nbcliadmin', 'nbcliadmin@example.org', 'x', 'approved', 'admin', 1, 1)`,
    )
    .run();
  const row = h.db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'nbcliadmin'")
    .get();
  h.db
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(row?.id ?? 0, await hashApiKey(ADMIN_KEY), ADMIN_KEY.slice(0, 8));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

async function runCli(args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: `http://localhost:${server.port}`,
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
  return { stdout, stderr, exitCode, all: `${stdout}${stderr}` };
}

describe("nemar admin neurobagel regenerate", () => {
  test("a dry run by default: says so, reports what would change, writes nothing", async () => {
    seedSynthetic(h, "nm000950");
    const result = await runCli(["admin", "neurobagel", "regenerate"]);
    expect(result.exitCode).toBe(0);
    expect(result.all).toContain("DRY RUN");
    expect(result.all).toContain("would write");
    expect(result.all).toContain("nm000950");
    expect(await storeKeys(h.bucket)).toEqual([]);
  });

  test("--execute writes the store, and the next run reports it unchanged", async () => {
    seedSynthetic(h, "nm000950");
    seedSynthetic(h, "on000950");
    const first = await runCli(["admin", "neurobagel", "regenerate", "--execute"]);
    expect(first.exitCode).toBe(0);
    expect(first.all).not.toContain("DRY RUN");
    expect(first.all).toMatch(/written\s+nm000950/);
    expect(first.all).toMatch(/written\s+on000950/);
    expect(await storeKeys(h.bucket)).toContain("index.json");

    const second = await runCli(["admin", "neurobagel", "regenerate", "--execute"]);
    expect(second.exitCode).toBe(0);
    expect(second.all).toMatch(/unchanged\s+nm000950/);
    expect(second.all).toContain("index_written=false");
  });

  test("--dataset and --limit are sent, and honored", async () => {
    for (const id of ["nm000950", "nm000951", "nm000952"]) seedSynthetic(h, id);
    const named = await runCli([
      "admin",
      "neurobagel",
      "regenerate",
      "--execute",
      "--dataset",
      "nm000952",
      "nm000950",
    ]);
    expect(named.exitCode).toBe(0);
    expect(await storeKeys(h.bucket)).toContain("nm000950.jsonld");
    expect(await storeKeys(h.bucket)).not.toContain("nm000951.jsonld");

    const limited = await runCli([
      "admin",
      "neurobagel",
      "regenerate",
      "--execute",
      "--limit",
      "1",
    ]);
    expect(limited.all).toContain("limit=1");
    expect(limited.all).toContain("examined=1");
  });

  test("--json prints the server's result untouched", async () => {
    seedSynthetic(h, "nm000950");
    const result = await runCli(["admin", "neurobagel", "regenerate", "--json"]);
    const parsed = JSON.parse(result.stdout) as { dry_run: boolean; results: { id: string }[] };
    expect(parsed.dry_run).toBe(true);
    expect(parsed.results[0]?.id).toBe("nm000950");
  });

  test("--execute while the writer is disabled fails with the server's reason and a hint", async () => {
    seedSynthetic(h, "nm000950");
    envOverrides = { NEUROBAGEL_WRITER_ENABLED: undefined };
    const result = await runCli(["admin", "neurobagel", "regenerate", "--execute"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.all).toMatch(/disabled/i);
    expect(result.all).toContain("NEUROBAGEL_WRITER_ENABLED");
    expect(await storeKeys(h.bucket)).toEqual([]);
  });

  test("a bad --limit is refused by the CLI itself, before ANY request reaches the server", async () => {
    // The server refuses these too, so the exit code alone proves nothing about WHO refused:
    // the log of requests does. A value the client lets through is a request the log shows.
    for (const limit of ["0", "-2", "abc", "1.5", "5x", "1e2", "51", "200", "100000"]) {
      requests = [];
      const result = await runCli(["admin", "neurobagel", "regenerate", "--limit", limit]);
      expect(result.exitCode, limit).not.toBe(0);
      expect(
        requests.filter((r) => r.includes("/admin/neurobagel")),
        `--limit ${limit}`,
      ).toEqual([]);
    }
  });

  test("an over-ceiling --limit says what the ceiling is and to run again", async () => {
    const result = await runCli(["admin", "neurobagel", "regenerate", "--limit", "51"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.all).toContain(`at most ${NEUROBAGEL_REGENERATE_MAX} per call`);
    expect(result.all).toContain("run the command again to continue");
  });

  test("the control: the ceiling itself, 50, is sent", async () => {
    requests = [];
    const result = await runCli(["admin", "neurobagel", "regenerate", "--limit", "50"]);
    expect(result.exitCode).toBe(0);
    expect(requests.filter((r) => r.includes("/admin/neurobagel"))).toEqual([
      "POST /admin/neurobagel/regenerate",
    ]);
  });

  test("a run that spends its operation budget says so, says to run again, and the next call finishes", async () => {
    // About 22 operations a dataset against a budget of 400 (less what the run holds back to
    // finish with): 30 first-time datasets cannot all be done in one call, whatever --limit says.
    const ids = Array.from({ length: 30 }, (_, i) => `nm${String(970 + i).padStart(6, "0")}`);
    for (const id of ids) seedSynthetic(h, id);
    const first = await runCli(["admin", "neurobagel", "regenerate", "--execute", "--limit", "50"]);
    expect(first.exitCode).toBe(0);
    expect(first.all).toContain("spent its operation budget");
    expect(first.all).toContain("run the same command again to continue");
    expect(first.all).toMatch(/ops=\d+\/400/);
    const writtenFirst = (await storeKeys(h.bucket)).filter((k) => k.endsWith(".jsonld")).length;
    expect(writtenFirst).toBeGreaterThan(0);
    expect(writtenFirst).toBeLessThan(30);

    for (let again = 0; again < 5; again++) {
      const next = await runCli([
        "admin",
        "neurobagel",
        "regenerate",
        "--execute",
        "--limit",
        "50",
      ]);
      expect(next.exitCode).toBe(0);
      if (!next.all.includes("spent its operation budget")) break;
    }
    expect((await storeKeys(h.bucket)).filter((k) => k.endsWith(".jsonld"))).toHaveLength(30);
  });

  test("an anonymity-class refusal exits non-zero and names no dataset in the summary line", async () => {
    seedSynthetic(h, "nm000950");
    // The row is eligible when the plan is made and anonymous by the time the data plane
    // builds its metadata (see neurobagel-writer.test.ts).
    const { wrapD1 } = await import("../backend/test/helpers/d1");
    let flipped = false;
    envOverrides = {
      DB: wrapD1(h.env().DB, (sql) => {
        if (!flipped && sql.includes("SELECT dataset_id, name, description, github_repo")) {
          flipped = true;
          h.db.run(
            "UPDATE datasets SET anonymous = 1, first_published_at = NULL WHERE dataset_id = 'nm000950'",
          );
        }
      }),
    };
    const result = await runCli(["admin", "neurobagel", "regenerate", "--execute"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.all).toContain("anonymity_findings=1");
    expect(result.all).toContain("neurobagel_anonymity_finding");
    expect(await storeKeys(h.bucket)).not.toContain("nm000950.jsonld");
  });
});

describe("nemar admin neurobagel status", () => {
  test("an empty system reads as such, with a zero where it is known", async () => {
    const result = await runCli(["admin", "neurobagel", "status"]);
    expect(result.exitCode).toBe(0);
    expect(result.all).toContain("enabled");
    expect(result.all).toContain("eligible=0 written=0");
    expect(result.all).toContain("not written yet");
  });

  test("it shows what was written, and what waits on a person", async () => {
    seedSynthetic(h, "nm000950");
    seedSynthetic(h, "nm000951", {
      tsv: "participant_id\tage\nsub-01\t21\nsub-02\t22\nsub-09\t23\n",
    });
    await runCli(["admin", "neurobagel", "regenerate", "--execute"]);
    const result = await runCli(["admin", "neurobagel", "status"]);
    expect(result.exitCode).toBe(0);
    expect(result.all).toContain("eligible=2 written=2");
    expect(result.all).toContain("Needs review (1)");
    expect(result.all).toContain("nm000951");
    expect(result.all).toContain("partial_join");
  });

  test("unknown is printed as unknown, never as zero, and an unbound bucket exits non-zero", async () => {
    seedSynthetic(h, "nm000950");
    envOverrides = { NEUROBAGEL: undefined };
    const result = await runCli(["admin", "neurobagel", "status"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.all).toContain("store_unconfigured");
    expect(result.all).toContain("written=unknown");
    expect(result.all).not.toContain("written=0");
  });

  test("--json is the server's document, and never carries the read token", async () => {
    envOverrides = { NEUROBAGEL_READ_TOKEN: "cli-test-secret-read-token-value" };
    const result = await runCli(["admin", "neurobagel", "status", "--json"]);
    expect(result.stdout).not.toContain("cli-test-secret-read-token-value");
    const parsed = JSON.parse(result.stdout) as { read_route: { token_configured: boolean } };
    expect(parsed.read_route.token_configured).toBe(true);
  });
});

describe("the command group", () => {
  test("is listed under admin, with both subcommands", async () => {
    const result = await runCli(["admin", "neurobagel", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.all).toContain("regenerate");
    expect(result.all).toContain("status");
  });
});
