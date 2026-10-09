/**
 * `nemar admin users --search`, `show` and `edit` (ADR 0093), driven through the
 * real entry point (`bun run src/index.ts ...`).
 *
 * END TO END, NOT STUBBED. Unlike test/admin-kind-cli.test.ts, which answers
 * from a canned HTTP server, this one serves the REAL backend admin router
 * (authMiddleware, adminMiddleware, the search SQL, the edit rules) over a real
 * migrated bun:sqlite database, with real hashed API keys. The CLI and the
 * backend therefore cannot drift apart without this file noticing, and what is
 * asserted about the database afterwards is the database's own answer.
 *
 * The CLI is a subprocess against that server via TEST_API_URL with an isolated
 * NEMAR_CONFIG_DIR, as the sibling CLI tests do.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { adminRoutes } from "../backend/src/routes/admin";
import { hashApiKey } from "../backend/src/services/token";
import type { Bindings } from "../backend/src/types/bindings";
import { freshDb, realD1 } from "../backend/test/helpers/d1";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

const OWNER_KEY = "cli-edit-owner-key-0123456789abcdef0123456789";
const ADMIN_KEY = "cli-edit-admin-key-0123456789abcdef0123456789";
const SECRET_HASH = "SECRET-PASSWORD-HASH-DO-NOT-PRINT";

let configDir: string;
let db: Database;
let server: ReturnType<typeof Bun.serve>;

function useKey(apiKey: string): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ activeAccount: "tester", accounts: { tester: { apiKey } } }),
  );
}

async function seedActor(username: string, role: "owner" | "admin", apiKey: string): Promise<void> {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1)`,
  ).run(username, `${username}@example.org`, role);
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error("seed: actor insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(apiKey),
    apiKey.slice(0, 8),
  );
}

function seedUser(
  username: string | null,
  fields: Partial<{
    email: string;
    given: string;
    family: string;
    affiliation: string;
    orcid: string;
    orcidVerified: number;
    deleted: boolean;
  }> = {},
): number {
  const email = fields.email ?? `${username ?? "web"}@example.org`;
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name, affiliation, orcid, orcid_verified, deleted_at)
     VALUES (?, ?, ?, 'verified', 'member', 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    username,
    email,
    SECRET_HASH,
    fields.given ?? null,
    fields.family ?? null,
    fields.affiliation ?? null,
    fields.orcid ?? null,
    fields.orcidVerified ?? 0,
    fields.deleted ? "2026-01-01 00:00:00" : null,
  );
  return db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email)
    ?.id as number;
}

function column(id: number, name: string): unknown {
  return (db.query(`SELECT ${name} FROM users WHERE id = ?`).get(id) as Record<string, unknown>)[
    name
  ];
}

function auditCount(): number {
  return db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin_user_edited'",
    )
    .get()?.n as number;
}

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-admin-users-cli-"));
  db = freshDb();
  await seedActor("cliowner", "owner", OWNER_KEY);
  await seedActor("cliadmin", "admin", ADMIN_KEY);

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      // The two unauthenticated calls the CLI makes around any command.
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      if (!url.pathname.startsWith("/admin/")) {
        return Response.json({ error: "Not Found", message: "no such route" }, { status: 404 });
      }
      // adminRoutes is mounted at /admin by the app; serve it directly.
      const inner = new URL(url.pathname.slice("/admin".length) + url.search, url.origin);
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
      return adminRoutes.fetch(
        new Request(inner, { method: req.method, headers: req.headers, body }),
        {
          DB: realD1(db),
          ENVIRONMENT: "test",
        } as Bindings,
      );
    },
  });
});

afterEach(() => {
  server.stop(true);
  rmSync(configDir, { recursive: true, force: true });
});

async function runCli(args: string[]) {
  const env = {
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

describe("nemar admin users --search", () => {
  test("finds an account by a field the listing does not print, and says which field matched", async () => {
    useKey(ADMIN_KEY);
    seedUser("alovelace", { given: "Ada", family: "Lovelace", affiliation: "UC San Diego" });
    seedUser("cbabbage", { given: "Charles", family: "Babbage", affiliation: "Cambridge" });

    const result = await runCli(["admin", "users", "--search", "san diego"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("alovelace");
    expect(result.stdout).not.toContain("cbabbage");
    expect(result.stdout).toContain("Matched: affiliation");
    expect(result.stdout).toContain('search="san diego"');
    // The id is printed on every row of a search: show and edit take it.
    expect(result.stdout).toMatch(/alovelace.*\(id \d+\)/);
  });

  test("a search combines with a filter", async () => {
    useKey(ADMIN_KEY);
    seedUser("alovelace", { given: "Ada", family: "Lovelace" });
    seedUser("ada-test", { given: "Ada", family: "Persona" });
    db.query("UPDATE users SET account_kind = 'test' WHERE username = 'ada-test'").run();

    const result = await runCli(["admin", "users", "-s", "ada", "--kind", "test"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ada-test");
    expect(result.stdout).not.toContain("alovelace");
  });

  test("an empty --search is refused before any request, not answered with everyone", async () => {
    useKey(ADMIN_KEY);
    seedUser("alovelace");
    const result = await runCli(["admin", "users", "--search", "   "]);
    expect(result.exitCode).not.toBe(0);
    expect(result.all).toContain("--search needs at least one word");
    expect(result.stdout).not.toContain("alovelace");
  });

  test("a stray word is an error, never a silent listing of every account", async () => {
    useKey(ADMIN_KEY);
    seedUser("alovelace");
    const result = await runCli(["admin", "users", "lovelace"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("NEMAR Users");
    expect(result.all.toLowerCase()).toContain("too many arguments");
  });

  test("no match is said plainly", async () => {
    useKey(ADMIN_KEY);
    const result = await runCli(["admin", "users", "--search", "zzznobodyzzz"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No users found");
  });
});

describe("nemar admin users show", () => {
  test("prints the details and never a credential", async () => {
    useKey(ADMIN_KEY);
    seedUser("alovelace", {
      given: "Ada",
      family: "Lovelace",
      affiliation: "UC San Diego",
      orcid: "0000-0002-1825-0097",
      orcidVerified: 1,
    });
    const result = await runCli(["admin", "users", "show", "alovelace"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Ada Lovelace");
    expect(result.stdout).toContain("UC San Diego");
    expect(result.stdout).toContain("0000-0002-1825-0097");
    expect(result.stdout).toContain("(verified)");
    expect(result.all).not.toContain(SECRET_HASH);
  });

  test("an exact username wins over longer names that contain it", async () => {
    useKey(ADMIN_KEY);
    seedUser("ada", { given: "Ada", family: "One" });
    seedUser("adalovelace", { given: "Ada", family: "Two" });
    const result = await runCli(["admin", "users", "show", "ada"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Ada One");
    expect(result.stdout).not.toContain("adalovelace");
    // Exact, so no "found by searching" caveat.
    expect(result.stdout).not.toContain("Found by searching");
  });

  test("an ambiguous query lists the candidates and shows none", async () => {
    useKey(ADMIN_KEY);
    seedUser("alovelace", { given: "Ada", family: "Lovelace" });
    seedUser("blovelace", { given: "Byron", family: "Lovelace" });
    const result = await runCli(["admin", "users", "show", "lovelace"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("2 accounts match");
    expect(result.stdout).toContain("alovelace");
    expect(result.stdout).toContain("blovelace");
    expect(result.stdout).not.toContain("Upload access");
  });

  test("no match exits non-zero", async () => {
    useKey(ADMIN_KEY);
    const result = await runCli(["admin", "users", "show", "zzznobodyzzz"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("No account matches");
  });

  test("a single partial match is shown with a note that it was not exact", async () => {
    useKey(ADMIN_KEY);
    seedUser("alovelace", { given: "Ada", family: "Lovelace" });
    const result = await runCli(["admin", "users", "show", "lovel"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Ada Lovelace");
    expect(result.stdout).toContain("Found by searching");
  });

  test("reaches an account with no username by its numeric id", async () => {
    useKey(ADMIN_KEY);
    const id = seedUser(null, { email: "orcidonly@example.org", given: "Web", family: "Person" });
    const result = await runCli(["admin", "users", "show", String(id)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("orcidonly@example.org");
    expect(result.stdout).toContain("(no username)");
  });

  test("--include-deleted is honoured after the subcommand name", async () => {
    useKey(ADMIN_KEY);
    seedUser("gone", { given: "Gone", family: "Person", deleted: true });
    const without = await runCli(["admin", "users", "show", "gone"]);
    expect(without.exitCode).toBe(1);
    expect(without.stdout).toContain("No account matches");

    const withFlag = await runCli(["admin", "users", "show", "gone", "--include-deleted"]);
    expect(withFlag.exitCode).toBe(0);
    expect(withFlag.stdout).toContain("tombstoned");
  });
});

describe("nemar admin users edit", () => {
  test("an admin edits the affiliation; the report is the server's, and it is audited", async () => {
    useKey(ADMIN_KEY);
    const id = seedUser("alovelace", { given: "Ada", family: "Lovelace", affiliation: "Old Lab" });
    const result = await runCli([
      "admin",
      "users",
      "edit",
      "alovelace",
      "--affiliation",
      "UC San Diego",
      "-y",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("affiliation");
    expect(result.stdout).toContain("Old Lab");
    expect(result.stdout).toContain("UC San Diego");
    expect(column(id, "affiliation")).toBe("UC San Diego");
    expect(auditCount()).toBe(1);
  });

  test('--affiliation "" clears it', async () => {
    useKey(ADMIN_KEY);
    const id = seedUser("alovelace", { affiliation: "Old Lab" });
    const result = await runCli(["admin", "users", "edit", "alovelace", "--affiliation", "", "-y"]);
    expect(result.exitCode).toBe(0);
    expect(column(id, "affiliation")).toBeNull();
    expect(result.stdout).toContain("(cleared)");
  });

  test("an admin who is not an owner cannot change an email, and is told why", async () => {
    useKey(ADMIN_KEY);
    const id = seedUser("alovelace", { email: "ada@lab.org" });
    const result = await runCli([
      "admin",
      "users",
      "edit",
      "alovelace",
      "--email",
      "new@lab.org",
      "-y",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.all).toContain("only an owner can do it");
    // Not the generic hint, which would be wrong: this person IS an admin.
    expect(result.all).not.toContain("requires admin privileges");
    // A refusal is the server's answer, not a crash: no invitation to file a bug.
    expect(result.all).not.toContain("--debug");
    expect(column(id, "email")).toBe("ada@lab.org");
    expect(auditCount()).toBe(0);
  });

  test("an owner changes the email; it is lower-cased, marked unconfirmed, and the CLI says so", async () => {
    useKey(OWNER_KEY);
    const id = seedUser("alovelace", { email: "ada@lab.org" });
    const result = await runCli([
      "admin",
      "users",
      "edit",
      "alovelace",
      "--email",
      "New.Ada@Lab.ORG",
      "-y",
    ]);
    expect(result.exitCode).toBe(0);
    expect(column(id, "email")).toBe("new.ada@lab.org");
    expect(column(id, "email_verified")).toBe(0);
    expect(result.stdout).toContain("unconfirmed");
    expect(result.stdout).toContain("No message was sent");
  });

  test("an address another account holds is refused naming the holder", async () => {
    useKey(OWNER_KEY);
    seedUser("holder", { email: "taken@lab.org" });
    const id = seedUser("alovelace", { email: "ada@lab.org" });
    const result = await runCli([
      "admin",
      "users",
      "edit",
      "alovelace",
      "--email",
      "taken@lab.org",
      "-y",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.all).toContain("holder");
    expect(column(id, "email")).toBe("ada@lab.org");
  });

  test("a name on an ORCID-verified account is refused with the reason", async () => {
    useKey(ADMIN_KEY);
    const id = seedUser("orcidperson", {
      given: "Real",
      family: "Name",
      orcid: "0000-0002-1825-0097",
      orcidVerified: 1,
    });
    const result = await runCli([
      "admin",
      "users",
      "edit",
      "orcidperson",
      "--given-name",
      "X",
      "-y",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.all).toContain("ORCID");
    expect(column(id, "given_name")).toBe("Real");
  });

  test("-y is refused when the text only half-names the account", async () => {
    useKey(ADMIN_KEY);
    // "ada" is a given name, not any account's username, id, email or handle,
    // yet it matches exactly one account by search.
    const id = seedUser("alovelace", { given: "Ada", family: "Lovelace", affiliation: "Old Lab" });
    const result = await runCli(["admin", "users", "edit", "ada", "--city", "Paris", "-y"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.all).toContain("by search, not by an exact");
    expect(column(id, "city")).toBeNull();
    expect(auditCount()).toBe(0);
  });

  test("with no flag there is nothing to do, and no request is made", async () => {
    useKey(ADMIN_KEY);
    seedUser("alovelace");
    const result = await runCli(["admin", "users", "edit", "alovelace"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.all).toContain("Nothing to change. Pass at least one of");
    expect(result.all).toContain("--given-name");
    expect(result.all).toContain("--github");
  });

  test("a value the account already has is reported as nothing to change", async () => {
    useKey(ADMIN_KEY);
    seedUser("alovelace", { affiliation: "Same Lab" });
    const result = await runCli([
      "admin",
      "users",
      "edit",
      "alovelace",
      "--affiliation",
      "Same Lab",
      "-y",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Nothing to change");
    expect(auditCount()).toBe(0);
  });

  test("without --yes and without a terminal the edit is not applied", async () => {
    useKey(ADMIN_KEY);
    const id = seedUser("alovelace");
    const result = await runCli(["admin", "users", "edit", "alovelace", "--city", "Paris"]);
    expect(result.all).toContain("use --yes or --no");
    expect(column(id, "city")).toBeNull();
  });

  test("--no previews the change and declines it", async () => {
    useKey(ADMIN_KEY);
    const id = seedUser("alovelace");
    const result = await runCli(["admin", "users", "edit", "alovelace", "--city", "Paris", "--no"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("city");
    expect(result.stdout).toContain("Paris");
    expect(result.stdout).toContain("Skipped");
    expect(column(id, "city")).toBeNull();
  });

  test("an ambiguous account is not edited", async () => {
    useKey(ADMIN_KEY);
    const a = seedUser("alovelace", { given: "Ada", family: "Lovelace" });
    const b = seedUser("blovelace", { given: "Byron", family: "Lovelace" });
    const result = await runCli(["admin", "users", "edit", "lovelace", "--city", "Paris", "-y"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("2 accounts match");
    expect(column(a, "city")).toBeNull();
    expect(column(b, "city")).toBeNull();
  });
});

describe("nemar admin users --search behaves like a normal search", () => {
  test("an exact hit goes straight to that account, with the other matches beneath it", async () => {
    useKey(ADMIN_KEY);
    seedUser("ada", { given: "Ada", family: "One", affiliation: "Exact Lab" });
    seedUser("adalovelace", { given: "Ada", family: "Lovelace" });
    const result = await runCli(["admin", "users", "--search", "ada"]);
    expect(result.exitCode).toBe(0);
    // The account's detail view, not the listing.
    expect(result.stdout).toContain("Upload access");
    expect(result.stdout).toContain("Exact Lab");
    expect(result.stdout).not.toContain("NEMAR Users");
    // The rest, below it.
    expect(result.stdout).toContain('1 other account also match "ada"');
    expect(result.stdout).toContain("adalovelace");
  });

  test("a pasted @handle is an exact hit even though it is not stored that way", async () => {
    useKey(ADMIN_KEY);
    const id = seedUser("someone", { given: "Some", family: "One" });
    db.query("UPDATE users SET github_username = 'octo-cat' WHERE id = ?").run(id);
    const result = await runCli(["admin", "users", "--search", "@octo-cat"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Upload access");
    expect(result.stdout).toContain("@octo-cat");
  });

  test("partial text still lists, best match first", async () => {
    useKey(ADMIN_KEY);
    seedUser("inside", { given: "Gil", family: "Glovelle" });
    seedUser("namer", { given: "Nia", family: "Love" });
    const result = await runCli(["admin", "users", "--search", "love"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("NEMAR Users");
    expect(result.stdout.indexOf("namer")).toBeGreaterThan(-1);
    expect(result.stdout.indexOf("namer")).toBeLessThan(result.stdout.indexOf("inside"));
  });

  test("a typo gets the closest account, labelled as a near miss", async () => {
    useKey(ADMIN_KEY);
    seedUser("alovelace", { given: "Ada", family: "Lovelace" });
    const result = await runCli(["admin", "users", "--search", "lovelase"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No exact matches for "lovelase"');
    expect(result.stdout).toContain("alovelace");
    expect(result.stdout).not.toContain("NEMAR Users");
  });

  test("an accent-less spelling finds the accented name", async () => {
    useKey(ADMIN_KEY);
    seedUser("swedishprof", { given: "Åsa", family: "Ekström" });
    const result = await runCli(["admin", "users", "--search", "ekstrom"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("swedishprof");
    expect(result.stdout).toContain('No exact matches for "ekstrom"');
  });

  test("nothing close is said plainly", async () => {
    useKey(ADMIN_KEY);
    seedUser("alovelace", { given: "Ada", family: "Lovelace" });
    const result = await runCli(["admin", "users", "--search", "qqqqqqqq"]);
    expect(result.stdout).toContain("No users found");
    expect(result.stdout).not.toContain("alovelace");
  });
});

describe("show and edit with a near miss", () => {
  test("show offers the closest account and says it is not an exact match", async () => {
    useKey(ADMIN_KEY);
    seedUser("alovelace", { given: "Ada", family: "Lovelace" });
    const result = await runCli(["admin", "users", "show", "lovelase"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Ada Lovelace");
    expect(result.stdout).toContain("closest one");
  });

  test("several near misses are listed as 'did you mean', and none is shown", async () => {
    useKey(ADMIN_KEY);
    seedUser("alovelace", { given: "Ada", family: "Lovelace" });
    seedUser("blovelace", { given: "Byron", family: "Lovelace" });
    const result = await runCli(["admin", "users", "show", "lovelase"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Did you mean one of these");
    expect(result.stdout).toContain("alovelace");
    expect(result.stdout).toContain("blovelace");
    expect(result.stdout).not.toContain("Upload access");
  });

  test("edit -y never changes an account found only by a near miss", async () => {
    useKey(ADMIN_KEY);
    const id = seedUser("alovelace", { given: "Ada", family: "Lovelace" });
    const result = await runCli(["admin", "users", "edit", "lovelase", "--city", "Paris", "-y"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.all).toContain("closest is alovelace");
    expect(column(id, "city")).toBeNull();
    expect(auditCount()).toBe(0);
  });

  test("edit without -y shows the near miss and asks the admin to check it", async () => {
    useKey(ADMIN_KEY);
    const id = seedUser("alovelace", { given: "Ada", family: "Lovelace" });
    const result = await runCli(["admin", "users", "edit", "lovelase", "--city", "Paris", "--no"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("check this is the one you meant");
    expect(result.stdout).toContain("Paris");
    expect(column(id, "city")).toBeNull();
  });
});
