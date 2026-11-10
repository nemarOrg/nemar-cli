/**
 * `nemar compute request-access` and `nemar admin compute access list|grant|deny|suspend|revoke` (epic
 * #2021 phase D1, #2022; ADR 0118, the compute-access addendum), driven through the real entry point
 * against the REAL routes: the Worker's `userRoutes` and admin router behind their real authentication,
 * over real SQLite carrying every migration, served by `Bun.serve` on a loopback port and reached through
 * TEST_API_URL. What a command prints is what the route answers. Resend is a local server (the Worker runs
 * in this process, so the mail fence and the templates are the real ones); nothing is stood in for.
 *
 * The properties, each with a test of its own:
 *  - a request is recorded and the administrators are mailed; asking twice does not mail twice; a refusal
 *    exits 1 and prints each missing field with where to set it, in the website's words; a missing
 *    --purpose or --accept-terms, with no terminal to prompt on, exits 1 and sends nothing;
 *  - in the exact production environment the request exits 1 with the terms-unpublished sentence;
 *  - every decision works by username and by --id, prints the states and (for a grant) what the default
 *    allocation opened, and exits 1 on a refusal, a member's key, or arguments that are not valid;
 *  - EVERY command's `--json` keeps standard output pure JSON (a single document, nothing else) and puts
 *    sentences on standard error.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { putPolicy } from "../backend/src/services/compute-policy";
import { hashApiKey } from "../backend/src/services/token";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  computeEnv,
  makeComputeApp,
  seedComputeUsers,
} from "../backend/test/helpers/compute-app";
import { freshDb } from "../backend/test/helpers/d1";
import { realD1 } from "../backend/test/helpers/d1";
import { sendsTo, withFakeResend } from "../backend/test/helpers/resend";
import { DEFAULT_COMPUTE_POLICY } from "../shared/contract/compute";
import { COMPUTE_TERMS_VERSION } from "../shared/contract/compute-terms";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const handle = makeComputeApp();
const PERSON_KEY = "cmpcli-person-key-0123456789abcdef0123456789abcd";
const PERSON_EMAIL = "cmpcli-person@nemar.test";
const PURPOSE = "Run ICA decompositions on public EEG datasets for a methods comparison.";

let db: Database;
let ids: Record<ComputeWho, number>;
let personId: number;
let configDir: string;
let workerEnv: Record<string, unknown> = {};

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/notices") return Response.json({ notices: [] });
    return handle(req, computeEnv(db, workerEnv as never));
  },
});
const API = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
});

beforeEach(async () => {
  db = freshDb();
  ids = await seedComputeUsers(db);
  // The Worker the command talks to: a development one (the production one refuses requests while the
  // terms are unpublished), whose admin mail is opted in and whose allow-list covers the test inboxes.
  workerEnv = {
    ENVIRONMENT: "test",
    DEV_ADMIN_NOTIFICATIONS: "1",
    DEV_EMAIL_ALLOWLIST: "@nemar.test,@example.org",
    RESEND_API_KEY: "fake-resend-key",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    APP_BASE_URL: "https://app.example.test",
  };
  personId = await seedPerson({ primary: true });
  configDir = mkdtempSync(join(tmpdir(), "nemar-compute-access-cli-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

interface PersonOverrides {
  affiliation?: string | null;
  compute_access?: string;
  identity?: boolean;
  username?: string | null;
  /** The person the CLI signs in as: the one with PERSON_KEY and PERSON_EMAIL. */
  primary?: boolean;
}

async function seedPerson(o: PersonOverrides = {}): Promise<number> {
  const n = (db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  const first = o.primary === true;
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified,
                        given_name, family_name, affiliation, city, country, orcid, orcid_verified,
                        account_kind, compute_access, compute_access_requested_at, compute_purpose,
                        compute_terms_version, compute_terms_accepted_at)
     VALUES (?, ?, 'x', 'verified', 'member', 'web', 1, 'Ada', 'Rivers', ?, 'San Diego', 'USA',
             ?, 1, 'person', ?, ?, ?, ?, ?)`,
    [
      o.username === undefined ? `cliperson${n}` : o.username,
      first ? PERSON_EMAIL : `cmpcli-p${n}@nemar.test`,
      o.affiliation === undefined ? "Swartz Center" : o.affiliation,
      `0000-0002-${String(1000 + n).padStart(4, "0")}-0000`,
      o.compute_access ?? "none",
      o.compute_access && o.compute_access !== "none" ? "2026-11-01 00:00:00" : null,
      o.compute_access && o.compute_access !== "none" ? PURPOSE : null,
      o.compute_access && o.compute_access !== "none" ? COMPUTE_TERMS_VERSION : null,
      o.compute_access && o.compute_access !== "none" ? "2026-11-01 00:00:00" : null,
    ],
  );
  const id = (db.query("SELECT id FROM users ORDER BY id DESC LIMIT 1").get() as { id: number }).id;
  if (first) {
    db.run("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)", [
      id,
      await hashApiKey(PERSON_KEY),
      PERSON_KEY.slice(0, 8),
    ]);
  }
  if (o.identity !== false) {
    db.run(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
      [id, `0000-0002-${String(id).padStart(4, "0")}-0000`],
    );
  }
  return id;
}

interface Ran {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** `who`: a seeded key, "person", or null for an unsigned CLI. */
async function runCli(who: ComputeWho | "person" | null, args: string[]): Promise<Ran> {
  if (who === null) {
    rmSync(join(configDir, "config.json"), { force: true });
  } else {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        activeAccount: "computecli",
        accounts: {
          computecli: { apiKey: who === "person" ? PERSON_KEY : COMPUTE_KEYS[who] },
        },
      }),
    );
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: API,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  })) {
    if (v !== undefined) env[k] = v;
  }
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
  return { stdout, stderr, exitCode: await proc.exited };
}

const request = (who: ComputeWho | "person" | null, extra: string[] = []) =>
  runCli(who, ["compute", "request-access", ...extra]);
const admin = (who: ComputeWho | null, args: string[]) =>
  runCli(who, ["admin", "compute", "access", ...args]);

/** Standard output is exactly one JSON document. */
function jsonOf(r: Ran): Record<string, any> {
  expect(r.stdout.trim().startsWith("{")).toBe(true);
  return JSON.parse(r.stdout);
}

const row = (id = personId) =>
  db.query("SELECT * FROM users WHERE id = ?").get(id) as Record<string, any>;
const GOOD = ["--purpose", PURPOSE, "--accept-terms"];

describe("nemar compute request-access", () => {
  test("records the request, mails the admins, and says what happens next", async () => {
    const calls = await withFakeResend(async (captured) => {
      const r = await request("person", GOOD);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Your compute request is with an admin");
      expect(r.stdout).toContain("We’ll email you when there’s a decision");
      return captured;
    });
    expect(row().compute_access).toBe("requested");
    expect(row().compute_terms_version).toBe(COMPUTE_TERMS_VERSION);
    expect(calls.filter((c) => c.path === "/emails").length).toBeGreaterThanOrEqual(1);
    expect(sendsTo(calls, "cmp-admin@example.org").length).toBe(1);
  });

  test("asking twice exits 0, says it is already open and mails nobody again", async () => {
    await withFakeResend(() => request("person", GOOD));
    const calls = await withFakeResend(async (captured) => {
      const r = await request("person", GOOD);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("An admin is reviewing your request.");
      return captured;
    });
    expect(calls.filter((c) => c.path === "/emails")).toHaveLength(0);
  });

  test("--json prints one JSON document on standard output and nothing on standard error", async () => {
    const r = await withFakeResend(() => request("person", [...GOOD, "--json"]));
    expect(r.exitCode).toBe(0);
    expect(r.stderr.trim()).toBe("");
    expect(jsonOf(r)).toMatchObject({ ok: true, already_requested: false, email_sent: true });
  });

  test("a refusal exits 1 and names each missing field with where to set it, in the shared words", async () => {
    db.run("UPDATE users SET affiliation = NULL, city = NULL WHERE id = ?", [personId]);
    const r = await request("person", GOOD);
    expect(r.exitCode).toBe(1);
    const all = r.stdout + r.stderr;
    expect(all).toContain("Complete your profile before requesting compute access");
    expect(all).toContain(
      "City is missing: needed to request compute access. Set it in Settings or run `nemar auth profile set-location`.",
    );
    expect(all).toContain(
      "Affiliation is missing: needed to request compute access. Set it in Settings or run `nemar auth profile set-affiliation`.",
    );
    expect(row().compute_access).toBe("none");
  });

  test("an unproven ORCID iD is named, with the compute block and the link command", async () => {
    db.run("DELETE FROM oauth_identities WHERE user_id = ?", [personId]);
    const r = await request("person", GOOD);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain(
      "Verified ORCID iD is missing: needed to request compute access. Set it in Settings or run `nemar auth profile orcid link`.",
    );
  });

  test("--json on a refusal puts the sentence on standard error and nothing on standard output", async () => {
    db.run("UPDATE users SET affiliation = NULL WHERE id = ?", [personId]);
    const r = await request("person", [...GOOD, "--json"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout.trim()).toBe("");
    expect(r.stderr).toContain("Complete your profile before requesting compute access");
  });

  test("no terminal and no --purpose: exit 1, naming the flag, and nothing is sent", async () => {
    const r = await request("person", ["--accept-terms"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("Provide --purpose");
    expect(row().compute_access).toBe("none");
  });

  test("no terminal and no --accept-terms: exit 1, naming the flag and the version, and nothing is sent", async () => {
    const r = await request("person", ["--purpose", PURPOSE]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("Pass --accept-terms");
    expect(r.stdout + r.stderr).toContain(COMPUTE_TERMS_VERSION);
    expect(row().compute_access).toBe("none");
  });

  test("a purpose that is too short is refused before anything is sent", async () => {
    const r = await request("person", ["--purpose", "too short", "--accept-terms"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("at least 20 characters");
    expect(row().compute_access).toBe("none");
  });

  test("a request that was answered cannot be asked again: exit 1 with the closed sentence", async () => {
    for (const state of ["denied", "revoked"]) {
      db.run("UPDATE users SET compute_access = ? WHERE id = ?", [state, personId]);
      const r = await request("person", GOOD);
      expect([state, r.exitCode]).toEqual([state, 1]);
      expect(r.stdout + r.stderr).toContain("cannot be asked again");
    }
  });

  test("a suspended account is told its access is paused, not that its request was answered", async () => {
    db.run("UPDATE users SET compute_access = 'suspended' WHERE id = ?", [personId]);
    const r = await request("person", GOOD);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("Your compute access is paused");
    expect(r.stdout + r.stderr).not.toContain("cannot be asked again");
  });

  test("an active account is told it already has access, and exits 1", async () => {
    db.run("UPDATE users SET compute_access = 'active' WHERE id = ?", [personId]);
    const r = await request("person", GOOD);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("already has compute access");
  });

  test("in the exact production environment, while the terms are unpublished, the request exits 1 and says so", async () => {
    workerEnv = { ...workerEnv, ENVIRONMENT: "production" };
    const r = await request("person", GOOD);
    expect(r.exitCode).toBe(1);
    expect((r.stdout + r.stderr).toLowerCase()).toContain("terms are not published");
    expect(row().compute_access).toBe("none");
  });

  test("no key exits 1", async () => {
    const r = await request(null, GOOD);
    expect(r.exitCode).toBe(1);
  });
});

describe("nemar admin compute access", () => {
  test("list shows the queue with the purpose, --json is one document, and a member is refused", async () => {
    const asked = await seedPerson({ compute_access: "requested" });
    await seedPerson({ compute_access: "active" });
    const human = await admin("admin", ["list", "--state", "requested"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain(String(asked));
    expect(human.stdout).toContain("requested");
    expect(human.stdout).toContain(PURPOSE);
    expect(human.stdout).not.toContain("active");

    const asJson = await admin("admin", ["list", "--json"]);
    expect(asJson.exitCode).toBe(0);
    expect(asJson.stderr.trim()).toBe("");
    expect(jsonOf(asJson).accounts.map((a: { id: number }) => a.id)).toContain(asked);

    const empty = await admin("admin", ["list", "--state", "denied"]);
    expect(empty.stdout).toContain("No account is denied.");

    expect((await admin("member", ["list"])).exitCode).toBe(1);
    expect((await admin(null, ["list"])).exitCode).toBe(1);
  });

  test("list refuses options that are not valid, before sending anything", async () => {
    for (const args of [
      ["list", "--state", "none"],
      ["list", "--state", "granted"],
      ["list", "--limit", "0"],
      ["list", "--limit", "abc"],
      ["list", "--after", "-1"],
    ]) {
      const r = await admin("admin", args);
      expect([args.join(" "), r.exitCode]).toEqual([args.join(" "), 1]);
    }
  });

  test("grant by username prints the states and the default allocation", async () => {
    await putPolicy(
      realD1(db),
      ids.owner,
      { ...DEFAULT_COMPUTE_POLICY, defaultGrantMilli: { cpu: 12_500, gpu: 0 } },
      "test",
    );
    const asked = await seedPerson({ compute_access: "requested" });
    const username = row(asked).username as string;
    const r = await withFakeResend(() =>
      admin("admin", ["grant", username, "--reason", "reviewed"]),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`Compute access granted for ${username}`);
    expect(r.stdout).toContain("requested -> active");
    expect(r.stdout).toContain("Default allocation opened: cpu 12.5 SU, gpu 0 SU.");
    expect(row(asked).compute_access).toBe("active");
  });

  test("a grant under a zero default says nothing was opened and how to give SU", async () => {
    const asked = await seedPerson({ compute_access: "requested" });
    const r = await withFakeResend(() => admin("admin", ["grant", "--id", String(asked)]));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("No allocation opened: the owner policy's default is zero");
  });

  test("a re-grant after a suspension says the default was opened before", async () => {
    await putPolicy(
      realD1(db),
      ids.owner,
      { ...DEFAULT_COMPUTE_POLICY, defaultGrantMilli: { cpu: 1_000, gpu: 0 } },
      "test",
    );
    const asked = await seedPerson({ compute_access: "requested" });
    await withFakeResend(async () => {
      await admin("admin", ["grant", "--id", String(asked)]);
      await admin("admin", ["suspend", "--id", String(asked)]);
      const again = await admin("admin", ["grant", "--id", String(asked)]);
      expect(again.exitCode).toBe(0);
      expect(again.stdout).toContain("the default was opened by an earlier grant");
    });
  });

  for (const [decision, from, to] of [
    ["deny", "requested", "denied"],
    ["suspend", "active", "suspended"],
    ["revoke", "active", "revoked"],
    ["grant", "requested", "active"],
  ] as const) {
    test(`${decision} works by --id for an account with no username and by username, with --json pure`, async () => {
      const webOnly = await seedPerson({ compute_access: from, username: null });
      const byId = await withFakeResend(() => admin("admin", [decision, "--id", String(webOnly)]));
      expect(byId.exitCode).toBe(0);
      expect(byId.stdout).toContain(`${from} -> ${to}`);
      expect(byId.stdout).toContain(`(no username, id ${webOnly})`);
      expect(row(webOnly).compute_access).toBe(to);

      const named = await seedPerson({ compute_access: from });
      const username = row(named).username as string;
      const asJson = await withFakeResend(() => admin("admin", [decision, username, "--json"]));
      expect(asJson.exitCode).toBe(0);
      expect(asJson.stderr.trim()).toBe("");
      expect(jsonOf(asJson)).toMatchObject({ decision, from, to });
      expect(row(named).compute_access).toBe(to);
    });
  }

  test("a refusal exits 1 with the Worker's sentence, on standard error under --json", async () => {
    const none = await seedPerson({ compute_access: "none" });
    const human = await admin("admin", ["grant", "--id", String(none)]);
    expect(human.exitCode).toBe(1);
    expect(human.stdout + human.stderr).toContain("no open compute access request");
    const asJson = await admin("admin", ["suspend", "--id", String(none), "--json"]);
    expect(asJson.exitCode).toBe(1);
    expect(asJson.stdout.trim()).toBe("");
    expect(asJson.stderr).toContain("does not hold compute access");
    expect(row(none).compute_access).toBe("none");
  });

  test("a member's key and no key exit 1 on every decision", async () => {
    const asked = await seedPerson({ compute_access: "requested" });
    for (const decision of ["grant", "deny", "suspend", "revoke"]) {
      expect((await admin("member", [decision, "--id", String(asked)])).exitCode).toBe(1);
      expect((await admin(null, [decision, "--id", String(asked)])).exitCode).toBe(1);
    }
    expect(row(asked).compute_access).toBe("requested");
  });

  test("the account must be named exactly once, and the arguments must be valid", async () => {
    const asked = await seedPerson({ compute_access: "requested" });
    for (const args of [
      ["grant"],
      ["grant", "someone", "--id", String(asked)],
      ["grant", "--id", "0"],
      ["grant", "--id", "abc"],
      ["grant", "--id", String(asked), "--reason", "x".repeat(501)],
    ]) {
      const r = await admin("admin", args);
      expect([args.join(" "), r.exitCode]).toEqual([args.join(" "), 1]);
    }
    expect(row(asked).compute_access).toBe("requested");
  });
});

describe("the groups are reachable", () => {
  test("`nemar compute --help` lists request-access, and `nemar admin compute access --help` lists the five", async () => {
    const user = await runCli(null, ["compute", "--help"]);
    expect(user.stdout).toContain("request-access");
    const adminHelp = await runCli(null, ["admin", "compute", "access", "--help"]);
    for (const name of ["list", "grant", "deny", "suspend", "revoke"]) {
      expect(adminHelp.stdout).toContain(name);
    }
  });
});
