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
import {
  RECORDED,
  type UpstreamStandin,
  startUpstreamStandin,
} from "../backend/test/helpers/neurobagel-upstream";
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
// The verification sweep reads upstream's public API: a local server with the real recorded
// answers, so the command line is driven end to end without reaching the internet.
let upstream: UpstreamStandin;
/** Every request the server received, `METHOD /path`, so a test can say what was NOT sent. */
let requests: string[] = [];

beforeAll(async () => {
  h = await startHarness();
  upstream = startUpstreamStandin();
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
  upstream.stop();
  await h.dispose();
});

beforeEach(async () => {
  await h.reset();
  envOverrides = {};
  requests = [];
  upstream.answers = { ...RECORDED };
  upstream.requests.length = 0;
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
    // A verification record exists (the daily sweep ran), so nothing about it is unknown.
    await runCli(["admin", "neurobagel", "verify"]);
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
    await runCli(["admin", "neurobagel", "verify"]);
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

describe("nemar admin neurobagel verify", () => {
  const movedUpstream = () => {
    upstream.answers = {
      ...upstream.answers,
      "/repos/neurobagel/api/releases/latest": {
        ...(upstream.answers["/repos/neurobagel/api/releases/latest"] as object),
        tag_name: "v0.12.0",
      },
    };
  };

  test("prints each check's verdict as itself, and an unconfigured check as unchecked, with exit 0", async () => {
    seedSynthetic(h, "nm000950");
    const result = await runCli(["admin", "neurobagel", "verify"]);
    expect(result.exitCode).toBe(0);
    expect(result.all).toMatch(/Verification\s+healthy/);
    expect(result.all).toMatch(/store\s+healthy/);
    expect(result.all).toMatch(/node\s+unchecked\s+NEUROBAGEL_NODE_URL is not set/);
    expect(result.all).toMatch(/registration\s+unchecked/);
    expect(result.all).toMatch(/drift\s+healthy/);
    expect(requests).toContain("POST /admin/neurobagel/verify");
  });

  test("an alarm exits 1 and says what moved", async () => {
    movedUpstream();
    const result = await runCli(["admin", "neurobagel", "verify"]);
    expect(result.exitCode).toBe(1);
    expect(result.all).toMatch(/Verification\s+alarm/);
    expect(result.all).toContain("node API v0.11.0 -> v0.12.0");
  });

  test("a check that could not be answered exits 2, printed as unknown and never as healthy", async () => {
    const node = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 500 }) });
    try {
      envOverrides = { NEUROBAGEL_NODE_URL: `http://127.0.0.1:${node.port}` };
      const result = await runCli(["admin", "neurobagel", "verify"]);
      expect(result.exitCode).toBe(2);
      expect(result.all).toMatch(/Verification\s+unknown/);
      expect(result.all).toMatch(
        /node\s+unknown\s+The node did not answer the datasets query \(HTTP 500\)/,
      );
    } finally {
      node.stop(true);
    }
  });

  test("a writer that is on with no bucket bound is an alarm for verify, and for status", async () => {
    envOverrides = { NEUROBAGEL: undefined };
    const verify = await runCli(["admin", "neurobagel", "verify"]);
    expect(verify.exitCode).toBe(1);
    expect(verify.all).toMatch(
      /store\s+alarm\s+The writer is switched on but no NEUROBAGEL bucket is bound/,
    );
    const status = await runCli(["admin", "neurobagel", "status"]);
    expect(status.exitCode).toBe(1);
    expect(status.all).toContain("store_unconfigured");
    // And the same state with the writer off is nothing to judge, for both.
    envOverrides = { NEUROBAGEL: undefined, NEUROBAGEL_WRITER_ENABLED: undefined };
    expect((await runCli(["admin", "neurobagel", "verify"])).exitCode).toBe(0);
  });

  test("--json is the server's document", async () => {
    const result = await runCli(["admin", "neurobagel", "verify", "--json"]);
    const parsed = JSON.parse(result.stdout) as {
      overall: string;
      heartbeat_written: boolean;
      checks: Record<string, { verdict: string }>;
    };
    expect(parsed.heartbeat_written).toBe(true);
    expect(parsed.checks.node?.verdict).toBe("unchecked");
  });

  test("a member's key is refused with the server's own answer", async () => {
    h.db.run("UPDATE users SET role = 'member' WHERE username = 'nbcliadmin'");
    const result = await runCli(["admin", "neurobagel", "verify"]);
    expect(result.exitCode).not.toBe(0);
    expect(upstream.requests).toEqual([]);
  });
});

describe("nemar admin neurobagel status prints the verification", () => {
  test("before any run, with the writer on, it is unknown and exits 2: nothing proves the sweep ever ran", async () => {
    const result = await runCli(["admin", "neurobagel", "status"]);
    expect(result.all).toMatch(/Verification\s+unknown\s+none recorded/);
    expect(result.all).toContain("unknown and not healthy");
    expect(result.all).not.toMatch(/Verification\s+healthy/);
    expect(result.exitCode).toBe(2);
  });

  test("before any run, with the writer off, it stays quiet and exits 0: nothing here is maintained", async () => {
    envOverrides = { NEUROBAGEL_WRITER_ENABLED: undefined };
    const result = await runCli(["admin", "neurobagel", "status"]);
    expect(result.all).toMatch(
      /Verification\s+none recorded; the writer is off, so none is expected/,
    );
    expect(result.exitCode).toBe(0);
  });

  test("a healthy record older than 36 hours is unknown and exits 2; a fresh one is healthy and exits 0", async () => {
    await runCli(["admin", "neurobagel", "verify"]);
    const fresh = await runCli(["admin", "neurobagel", "status"]);
    expect(fresh.all).toMatch(/Verification\s+healthy/);
    expect(fresh.exitCode).toBe(0);

    const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();
    h.db.run(
      "UPDATE audit_log SET details = json_set(details, '$.at', ?) WHERE action = 'neurobagel_verification'",
      [hoursAgo(40)],
    );
    const stale = await runCli(["admin", "neurobagel", "status"]);
    expect(stale.all).toMatch(/Verification\s+unknown\s+the last record is 4\d hours old/);
    expect(stale.exitCode).toBe(2);

    // Inside the 36 hours it is still believed.
    h.db.run(
      "UPDATE audit_log SET details = json_set(details, '$.at', ?) WHERE action = 'neurobagel_verification'",
      [hoursAgo(30)],
    );
    expect((await runCli(["admin", "neurobagel", "status"])).exitCode).toBe(0);
  });

  test("after a run it prints the latest verdicts, and an alarm makes the exit code non-zero", async () => {
    await runCli(["admin", "neurobagel", "verify"]);
    const ok = await runCli(["admin", "neurobagel", "status"]);
    expect(ok.all).toMatch(/Verification\s+healthy/);
    expect(ok.all).toMatch(/registration\s+unchecked/);

    upstream.answers = {
      ...upstream.answers,
      "/repos/neurobagel/query-tool/releases/latest": { tag_name: "v1.0.0" },
    };
    await runCli(["admin", "neurobagel", "verify"]);
    const alarming = await runCli(["admin", "neurobagel", "status"]);
    expect(alarming.all).toMatch(/Verification\s+alarm/);
    expect(alarming.exitCode).toBe(1);
  });
});

describe("nemar admin neurobagel status exit code for an unanswerable verification", () => {
  test("an unknown verdict exits 2, like `verify`: unknown is not healthy and not an alarm", async () => {
    const node = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 500 }) });
    try {
      envOverrides = { NEUROBAGEL_NODE_URL: `http://127.0.0.1:${node.port}` };
      await runCli(["admin", "neurobagel", "verify"]);
      const status = await runCli(["admin", "neurobagel", "status"]);
      expect(status.all).toMatch(/Verification\s+unknown/);
      // The same family as `verify`: 2, could not be determined.
      expect(status.exitCode).toBe(2);
    } finally {
      node.stop(true);
    }
  });
});

describe("the exit codes are stated in the help of both commands", () => {
  test("status and verify say the same three codes in their ordinary help, and the long form says when", async () => {
    for (const command of ["status", "verify"]) {
      const help = await runCli(["admin", "neurobagel", command, "--help"]);
      expect(help.exitCode, command).toBe(0);
      expect(help.all, command).toMatch(/exit\s+0\s+healthy,\s+1\s+alarm,\s+2\s+unknown/);
      const long = await runCli(["admin", "neurobagel", command, "--help-all"]);
      expect(long.all, command).toMatch(
        /Exit codes: 0 healthy or nothing to check, 1 an alarm, 2 could not be determined/,
      );
    }
    const status = await runCli(["admin", "neurobagel", "status", "--help-all"]);
    expect(status.all).toContain("36 hours");
  });
});

describe("the command group", () => {
  test("is listed under admin, with every subcommand", async () => {
    const result = await runCli(["admin", "neurobagel", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.all).toContain("regenerate");
    expect(result.all).toContain("status");
    expect(result.all).toContain("verify");
  });
});
