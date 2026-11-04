/**
 * `nemar admin oidc` (epic #2014 phase #2016; ADR 0119, decision 8), driven through the real entry
 * point against the REAL Worker: its middleware stack, its admin router behind real authentication,
 * and the OpenID Connect owner routes, over real SQLite carrying every migration, served on a
 * loopback port and reached through TEST_API_URL. Nothing is canned: what the command prints is what
 * `/admin/oidc/...` answered.
 *
 * The Worker's issuer is its own `API_BASE_URL`, set to the loopback origin the CLI calls, so the
 * owner routes' host rule is the production one and not bypassed.
 *
 * The properties, each with a test of its own:
 *  - an owner adds a client, lists it, shows it, rotates its secret and disables it; the secret is
 *    printed once, on `add` and `rotate-secret`, and never by `list` or `show`;
 *  - `--json` writes pure JSON to standard output and every sentence to standard error, on success
 *    and on failure;
 *  - signing keys list and rotate, the 24-hour rule refuses and `--force` overrides it, and no
 *    private member is ever printed;
 *  - every refusal exits 1 and prints only the failure: not signed in, not the owner, a bad
 *    argument, a refusal of the registry, and a Worker with the provider off (404, said plainly);
 *  - every command has a help block with "Exit codes:".
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import worker from "../backend/src/index";
import type { Bindings } from "../backend/src/types/bindings";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import {
  ADMIN_KEY,
  MEMBER_KEY,
  OIDC_TEST_SECRET,
  OWNER_KEY,
  seedUser,
} from "../backend/test/helpers/oidc-harness";
import { help } from "./help-output";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

let db: Database;
let configDir: string;
let extraEnv: Partial<Bindings> = {};
let requests: Array<{ method: string; path: string }> = [];
let dbHandle: D1Database;

const server = Bun.serve({
  port: 0,
  fetch: (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/notices") requests.push({ method: req.method, path: url.pathname });
    const env = {
      DB: dbHandle,
      ENVIRONMENT: "development",
      API_BASE_URL: API,
      APP_BASE_URL: "https://app.nemar.org",
      OIDC_SECRET: OIDC_TEST_SECRET,
      ...extraEnv,
    } as unknown as Bindings;
    return worker.fetch(req, env, ctx);
  },
});
const API = `http://127.0.0.1:${server.port}`;

afterAll(() => server.stop(true));

beforeEach(async () => {
  db = freshDb();
  dbHandle = realD1(db);
  extraEnv = {};
  requests = [];
  configDir = mkdtempSync(join(tmpdir(), "nemar-oidc-cli-"));
  await seedUser(db, "oidcowner", "owner", OWNER_KEY);
  await seedUser(db, "oidcadmin", "admin", ADMIN_KEY);
  await seedUser(db, "oidcmember", "member", MEMBER_KEY);
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function signIn(key: string, account = "oidccliuser"): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ activeAccount: account, accounts: { [account]: { apiKey: key } } }),
  );
}

async function runCli(
  args: string[],
  extra: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: API,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
    ...extra,
  };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "admin", "oidc", ...args],
    cwd: REPO_ROOT,
    env: clean,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

/** The flags that make a valid registration, with extras. */
function addArgs(extra: string[] = []): string[] {
  return [
    "clients",
    "add",
    "--name",
    "Example client",
    "--redirect-uri",
    "https://client.example.org/callback",
    "--scopes",
    "openid,profile,email",
    "--grants",
    "authorization_code,refresh_token",
    "--sign-in-rule",
    "active_account",
    "--audience",
    "https://api.example.org",
    ...extra,
  ];
}

interface AddJson {
  client: { client_id: string; name: string; first_party: boolean; status: string };
  client_secret: string;
}

async function addClient(extra: string[] = []): Promise<AddJson> {
  const r = await runCli([...addArgs(extra), "--json"]);
  expect(r.exitCode, r.stdout + r.stderr).toBe(0);
  return JSON.parse(r.stdout) as AddJson;
}

/**
 * Run a command that must fail, both ways: as typed (the sentence is printed, where the CLI prints
 * its failures) and with --json (standard output stays EMPTY, so a script reading it never reads a
 * sentence, and standard error holds the sentence). Returns the sentence of each.
 */
async function failsBothWays(args: string[]): Promise<{ plain: string; json: string }> {
  const typed = await runCli(args);
  expect(typed.exitCode, `${args.join(" ")} (as typed)`).toBe(1);
  const asJson = await runCli([...args, "--json"]);
  expect(asJson.exitCode, `${args.join(" ")} --json`).toBe(1);
  expect(asJson.stdout, `${args.join(" ")} --json: standard output`).toBe("");
  return { plain: typed.stdout + typed.stderr, json: asJson.stderr };
}

const clientRows = () =>
  db.query("SELECT * FROM oidc_clients").all() as Array<Record<string, unknown>>;

// ---------------------------------------------------------------------------------------------

describe("nemar admin oidc clients add", () => {
  test("registers the client, prints its id and its secret once, and the database holds the hash", async () => {
    signIn(OWNER_KEY);
    const r = await runCli(addArgs());
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    const id = /oc_[0-9a-f]{24}/.exec(r.stdout)?.[0];
    expect(id).toBeDefined();
    expect(r.stdout).toContain("Example client");
    const secret = /secret[^\n]*:\s*([A-Za-z0-9_-]{43})\b/i.exec(r.stdout)?.[1];
    expect(secret, r.stdout).toBeDefined();
    expect(r.stdout).toMatch(/shown (this )?once/i);
    expect(clientRows()).toHaveLength(1);
    const row = clientRows()[0] as Record<string, unknown>;
    expect(row.client_id).toBe(id);
    expect(row.secret_hash).not.toBe(secret);
    expect(JSON.stringify(row)).not.toContain(secret as string);
  });

  test("--json: standard output is the answer and nothing else, standard error holds the sentences", async () => {
    signIn(OWNER_KEY);
    // A first-party client needs NEMAR redirect addresses, so this one is refused...
    const refused = await failsBothWays(addArgs(["--first-party"]));
    expect(refused.json).toContain("first-party");
    expect(refused.plain).toContain("first-party");
    // ...and a valid one prints pure JSON.
    const ok = await runCli([...addArgs(), "--json"]);
    expect(ok.exitCode, ok.stderr).toBe(0);
    const parsed = JSON.parse(ok.stdout) as AddJson;
    expect(parsed.client.status).toBe("active");
    expect(parsed.client_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(JSON.parse(ok.stdout)).sort()).toEqual(["client", "client_secret"]);
  });

  test("every flag reaches the registry", async () => {
    signIn(OWNER_KEY);
    const r = await runCli([
      "clients",
      "add",
      "--name",
      "First party",
      "--redirect-uri",
      "https://app.nemar.org/oauth/callback",
      "--redirect-uri",
      "https://nemar.org/other",
      "--scopes",
      "openid,profile,compute.read",
      "--grants",
      "authorization_code",
      "--sign-in-rule",
      "person_proven_orcid",
      "--audience",
      "https://api.nemar.org",
      "--consent-mode",
      "always",
      "--first-party",
      "--logout-uri",
      "https://app.nemar.org/logout",
      "--introspection-audiences",
      "https://rs.example.org,https://rs2.example.org",
      "--cap-open-reservations",
      "4",
      "--cap-su-per-day",
      "1000",
      "--json",
    ]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    const row = clientRows().find((x) => x.name === "First party") as Record<string, unknown>;
    expect(row).toMatchObject({
      first_party: 1,
      consent_mode: "always",
      sign_in_rule: "person_proven_orcid",
      backchannel_logout_uri: "https://app.nemar.org/logout",
      audience: "https://api.nemar.org",
      cap_open_reservations: 4,
      cap_su_per_day: 1000,
    });
    expect(JSON.parse(row.redirect_uris as string)).toEqual([
      "https://app.nemar.org/oauth/callback",
      "https://nemar.org/other",
    ]);
    expect(JSON.parse(row.allowed_scopes as string)).toEqual(["openid", "profile", "compute.read"]);
    expect(JSON.parse(row.introspection_audiences as string)).toEqual([
      "https://rs.example.org",
      "https://rs2.example.org",
    ]);
  });

  test("the registry's refusal is printed as the Worker said it, exits 1, and writes nothing", async () => {
    signIn(OWNER_KEY);
    const refused = await failsBothWays(addArgs(["--redirect-uri", "http://example.org/cb"]));
    expect(refused.plain).toContain("redirect_uris");
    expect(refused.json).toContain("redirect_uris");
    expect(clientRows()).toHaveLength(0);
  });

  test("a missing required flag exits 1 and sends nothing", async () => {
    signIn(OWNER_KEY);
    for (const drop of ["--name", "--scopes", "--grants", "--sign-in-rule", "--audience"]) {
      const args = addArgs();
      const i = args.indexOf(drop);
      args.splice(i, 2);
      const r = await runCli(args);
      expect(r.exitCode, drop).toBe(1);
      expect(r.stderr, drop).toContain(drop);
    }
    const noRedirect = addArgs();
    noRedirect.splice(noRedirect.indexOf("--redirect-uri"), 2);
    const refused = await failsBothWays(noRedirect);
    expect(refused.plain).toMatch(/redirect-uri/);
    expect(refused.json).toMatch(/redirect-uri/);
    expect(requests.filter((q) => q.method === "POST")).toHaveLength(0);
  });

  test("a word that is not one is refused before anything is sent", async () => {
    signIn(OWNER_KEY);
    const r = await runCli(addArgs(["--consent-mode", "never"]));
    expect(r.exitCode).toBe(1);
    const bad = await runCli(addArgs(["--cap-su-per-day", "-3"]));
    expect(bad.exitCode).toBe(1);
    const alpha = await runCli(addArgs(["--cap-open-reservations", "many"]));
    expect(alpha.exitCode).toBe(1);
    expect(requests.filter((q) => q.method === "POST")).toHaveLength(0);
  });
});

describe("nemar admin oidc clients list and show", () => {
  test("list shows every client, without a secret, and --json is the contract's list", async () => {
    signIn(OWNER_KEY);
    const a = await addClient();
    const b = await addClient(["--name", "Second client"]);
    const text = await runCli(["clients", "list"]);
    expect(text.exitCode, text.stderr).toBe(0);
    expect(text.stdout).toContain(a.client.client_id);
    expect(text.stdout).toContain(b.client.client_id);
    expect(text.stdout).not.toContain(a.client_secret);
    expect(text.stdout).not.toContain(b.client_secret);
    const json = await runCli(["clients", "list", "--json"]);
    const parsed = JSON.parse(json.stdout) as { clients: Array<{ client_id: string }> };
    expect(parsed.clients.map((c) => c.client_id)).toEqual([
      a.client.client_id,
      b.client.client_id,
    ]);
    expect(json.stdout).not.toContain("client_secret");
    expect(json.stdout).not.toContain("secret_hash");
    expect(json.stdout).not.toContain(a.client_secret);
  });

  test("an empty registry says so", async () => {
    signIn(OWNER_KEY);
    const r = await runCli(["clients", "list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/no clients/i);
  });

  test("show prints one client in full, with no secret, and an unknown or malformed id exits 1", async () => {
    signIn(OWNER_KEY);
    const a = await addClient();
    const r = await runCli(["clients", "show", a.client.client_id]);
    expect(r.exitCode, r.stderr).toBe(0);
    for (const word of [
      "Example client",
      "https://client.example.org/callback",
      "openid",
      "authorization_code",
      "active_account",
      "https://api.example.org",
    ]) {
      expect(r.stdout).toContain(word);
    }
    expect(r.stdout).not.toContain(a.client_secret);
    expect(r.stdout).not.toContain("secret_hash");
    const json = await runCli(["clients", "show", a.client.client_id, "--json"]);
    expect((JSON.parse(json.stdout) as { client: { client_id: string } }).client.client_id).toBe(
      a.client.client_id,
    );
    const missing = await failsBothWays(["clients", "show", "oc_000000000000000000000000"]);
    expect(missing.plain).toMatch(/no client/i);
    const malformed = await failsBothWays(["clients", "show", "nope"]);
    expect(malformed.plain).toMatch(/not a client id/i);
  });
});

describe("nemar admin oidc clients rotate-secret", () => {
  test("prints the new secret once, keeps the old one for the grace, and show reports the grace", async () => {
    signIn(OWNER_KEY);
    const a = await addClient();
    const r = await runCli(["clients", "rotate-secret", a.client.client_id, "--grace-hours", "2"]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    const fresh = /([A-Za-z0-9_-]{43})\b/.exec(r.stdout.replace(a.client.client_id, ""))?.[1];
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(a.client_secret);
    expect(r.stdout).toMatch(/shown (this )?once/i);
    expect(r.stdout).toMatch(/2 hours?/);
    expect(r.stdout).not.toContain(a.client_secret);
    const row = clientRows()[0] as Record<string, unknown>;
    expect(row.previous_secret_hash).not.toBeNull();
    const shown = await runCli(["clients", "show", a.client.client_id]);
    expect(shown.stdout).toMatch(/previous secret/i);
    expect(shown.stdout).not.toContain(fresh as string);
  });

  test("--json prints the contract's rotate answer; --grace-hours 0 leaves no previous secret", async () => {
    signIn(OWNER_KEY);
    const a = await addClient();
    const r = await runCli([
      "clients",
      "rotate-secret",
      a.client.client_id,
      "--grace-hours",
      "0",
      "--json",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout) as { client_secret: string; grace_hours: number };
    expect(parsed.grace_hours).toBe(0);
    expect(parsed.client_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((clientRows()[0] as Record<string, unknown>).previous_secret_hash).toBeNull();
  });

  test("a grace the Worker refuses, an unknown client and a disabled one exit 1", async () => {
    signIn(OWNER_KEY);
    const a = await addClient();
    expect(
      (await runCli(["clients", "rotate-secret", a.client.client_id, "--grace-hours", "999"]))
        .exitCode,
    ).toBe(1);
    expect(
      (await runCli(["clients", "rotate-secret", a.client.client_id, "--grace-hours", "x"]))
        .exitCode,
    ).toBe(1);
    expect(
      (await runCli(["clients", "rotate-secret", "oc_000000000000000000000000"])).exitCode,
    ).toBe(1);
    await runCli(["clients", "disable", a.client.client_id, "--yes"]);
    const disabled = await runCli(["clients", "rotate-secret", a.client.client_id]);
    expect(disabled.exitCode).toBe(1);
    expect(disabled.stderr + disabled.stdout).toMatch(/disabled/);
  });
});

describe("nemar admin oidc clients disable", () => {
  test("with --yes it disables, says so, and a second run says it already was", async () => {
    signIn(OWNER_KEY);
    const a = await addClient();
    const r = await runCli(["clients", "disable", a.client.client_id, "--yes"]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/disabled/i);
    expect((clientRows()[0] as Record<string, unknown>).status).toBe("disabled");
    const again = await runCli(["clients", "disable", a.client.client_id, "--yes", "--json"]);
    expect(again.exitCode).toBe(0);
    expect((JSON.parse(again.stdout) as { changed: boolean }).changed).toBe(false);
  });

  test("without --yes and with no terminal it asks, cannot, and disables nothing", async () => {
    signIn(OWNER_KEY);
    const a = await addClient();
    const r = await runCli(["clients", "disable", a.client.client_id]);
    expect(r.exitCode).toBe(1);
    expect((clientRows()[0] as Record<string, unknown>).status).toBe("active");
    expect(requests.filter((q) => q.path.endsWith("/disable"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("nemar admin oidc keys", () => {
  test("list on an empty table says there are no keys; the first rotate makes a current and a next", async () => {
    signIn(OWNER_KEY);
    const empty = await runCli(["keys", "list"]);
    expect(empty.exitCode, empty.stderr).toBe(0);
    expect(empty.stdout).toMatch(/no signing keys/i);
    const first = await runCli(["keys", "rotate"]);
    expect(first.exitCode, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toMatch(/current/);
    expect(first.stdout).toMatch(/next/);
    const list = await runCli(["keys", "list", "--json"]);
    const keys = (JSON.parse(list.stdout) as { keys: Array<{ kid: string; state: string }> }).keys;
    expect(keys.map((k) => k.state).sort()).toEqual(["current", "next"]);
    const text = await runCli(["keys", "list"]);
    for (const k of keys) expect(text.stdout).toContain(k.kid);
  });

  test("a second rotate inside 24 hours is refused with the time, and --force rotates", async () => {
    signIn(OWNER_KEY);
    await runCli(["keys", "rotate"]);
    const early = await failsBothWays(["keys", "rotate"]);
    expect(early.plain).toMatch(/24 hours/);
    expect(early.plain).toMatch(/--force/);
    expect(early.json).toMatch(/24 hours/);
    const forced = await runCli(["keys", "rotate", "--force", "--json"]);
    expect(forced.exitCode, forced.stderr).toBe(0);
    const parsed = JSON.parse(forced.stdout) as { action: string; keys: unknown[] };
    expect(parsed.action).toBe("rotated");
    expect(parsed.keys).toHaveLength(3);
  });

  test("nothing the command prints holds a private member", async () => {
    signIn(OWNER_KEY);
    const rotated = await runCli(["keys", "rotate", "--json"]);
    const listed = await runCli(["keys", "list", "--json"]);
    const rows = db
      .query<{ private_jwk_encrypted: string }, []>(
        "SELECT private_jwk_encrypted FROM oidc_signing_keys",
      )
      .all();
    for (const out of [rotated.stdout, rotated.stderr, listed.stdout, listed.stderr]) {
      for (const row of rows) expect(out).not.toContain(row.private_jwk_encrypted);
      expect(out).not.toContain('"d"');
      expect(out).not.toContain(OIDC_TEST_SECRET);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("who may run it", () => {
  const COMMANDS: string[][] = [
    ["clients", "list"],
    ["clients", "show", "oc_000000000000000000000000"],
    ["clients", "rotate-secret", "oc_000000000000000000000000"],
    ["clients", "disable", "oc_000000000000000000000000", "--yes"],
    ["keys", "list"],
    ["keys", "rotate"],
    addArgs(),
  ];

  test("not signed in: exit 1, nothing sent", async () => {
    for (const args of COMMANDS) {
      const refused = await failsBothWays(args);
      expect(refused.plain).toContain("Not authenticated");
      expect(refused.json).toContain("Not authenticated");
    }
    expect(requests).toHaveLength(0);
  });

  test("an administrator who is not the owner and a member: exit 1, the owner role named", async () => {
    for (const key of [ADMIN_KEY, MEMBER_KEY]) {
      signIn(key);
      for (const args of COMMANDS) {
        const refused = await failsBothWays(args);
        expect(refused.plain).toMatch(/owner/i);
        expect(refused.json).toMatch(/owner/i);
      }
    }
    expect(clientRows()).toHaveLength(0);
    expect(db.query("SELECT COUNT(*) AS n FROM oidc_signing_keys").get()).toEqual({ n: 0 });
  });

  test("a Worker with the provider off answers 404, and the command says why instead of calling it a bug", async () => {
    signIn(OWNER_KEY);
    extraEnv = { OIDC_SECRET: undefined };
    for (const args of [["keys", "list"], ["clients", "list"], addArgs()]) {
      const refused = await failsBothWays(args);
      expect(refused.plain).toMatch(/OIDC_SECRET/);
      expect(refused.json).toMatch(/OIDC_SECRET/);
      // Not the "this backend does not support this command yet" of a server that predates it.
      expect(refused.plain).toMatch(/provider is off/);
    }
    expect(clientRows()).toHaveLength(0);
  });
});

describe("help", () => {
  test("every command has an Exit codes block, shown with --help-all", async () => {
    for (const path of [
      ["admin", "oidc", "clients", "add"],
      ["admin", "oidc", "clients", "list"],
      ["admin", "oidc", "clients", "show"],
      ["admin", "oidc", "clients", "rotate-secret"],
      ["admin", "oidc", "clients", "disable"],
      ["admin", "oidc", "keys", "list"],
      ["admin", "oidc", "keys", "rotate"],
    ]) {
      const out = await help([...path, "--help-all"]);
      expect(out, path.join(" ")).toContain("Exit codes:");
      expect(out).toContain("--json");
    }
  });

  test("the group lists its subgroups, and admin lists the group", async () => {
    const group = await help(["admin", "oidc", "--help"]);
    expect(group).toContain("clients");
    expect(group).toContain("keys");
    const admin = await help(["admin", "--help-all"]);
    expect(admin).toContain("oidc");
  });
});
