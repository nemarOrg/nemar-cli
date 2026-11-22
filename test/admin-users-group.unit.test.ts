/**
 * The `admin users` group (ADR 0135): `users` is both a listing with its own options and the
 * parent of the account commands moved under it (approve, revoke, role, verify, kind, kind-check,
 * keys, email-preferences, duplicates, backfill-usernames). This checks that the two do not
 * collide: a word after `users` that names a subcommand reaches it, an option value that happens
 * to be a subcommand's name (`--search approve`, `--kind test`) stays the listing's value, and the
 * listing and `users show` keep working. Each assertion is on what reached a recording Bun.serve
 * stand-in, not only on what was printed.
 *
 * CI TIER: unit-pure. Hermetic: the CLI is spawned with an environment built from nothing.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { startIsolatedCli } from "./helpers/isolated-cli";

setDefaultTimeout(30_000);

const cli = startIsolatedCli();
afterAll(() => cli.stop());
beforeEach(() => cli.reset());

const writes = () => cli.requests.filter((q) => q.method !== "GET");
const listing = () => cli.requests.filter((q) => q.method === "GET" && q.path === "/admin/users");

describe("the users listing keeps working beside its new subcommands", () => {
  test("bare admin users lists every account", async () => {
    await cli.run(["admin", "users"]);
    expect(listing()).toHaveLength(1);
    expect(writes()).toEqual([]);
  });

  test.each([
    [["--search", "approve"], "q=approve"],
    [["-s", "revoke"], "q=revoke"],
    [["--role", "admin"], "role=admin"],
    [["--kind", "test"], "kind=test"],
  ])("admin users %p is the listing, not a subcommand", async (args, expected) => {
    const r = await cli.run(["admin", "users", ...(args as string[])]);
    expect(r.stdout + r.stderr).not.toContain("Approving user");
    expect(r.stdout + r.stderr).not.toContain("Revoking");
    expect(listing()).toHaveLength(1);
    expect(listing()[0].query).toContain(expected as string);
    expect(writes()).toEqual([]);
  });

  test("admin users show approve looks up the account named approve", async () => {
    const r = await cli.run(["admin", "users", "show", "approve"]);
    expect(r.stdout).not.toContain("Approving user");
    expect(cli.requests.some((q) => q.path.startsWith("/admin/users"))).toBe(true);
    expect(writes()).toEqual([]);
  });
});

describe("a word after users that names a subcommand reaches it", () => {
  test("admin users approve bob is the approval, declined before any write", async () => {
    const r = await cli.run(["admin", "users", "approve", "bob", "--no"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Approving user: bob");
    expect(r.stdout).toContain("Skipped");
    expect(listing()).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test("admin users approve with no account is the approval's own usage error", async () => {
    const r = await cli.run(["admin", "users", "approve"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("provide a username or --id");
    expect(cli.requests).toEqual([]);
  });

  test.each([
    [["revoke", "bob", "--no"]],
    [["kind", "bob", "test", "--no"]],
    [["verify", "80", "--no"]],
  ])("admin users %p reaches the subcommand and writes nothing when declined", async (args) => {
    const r = await cli.run(["admin", "users", ...args]);
    expect(r.stdout + r.stderr).not.toContain("unknown command");
    expect(r.stdout + r.stderr).not.toContain("too many arguments");
    expect(listing()).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test("admin users keys list bob asks for that account's keys", async () => {
    await cli.run(["admin", "users", "keys", "list", "bob"]);
    expect(cli.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /admin/users/bob/keys"]);
  });

  test("admin users kind-check reads the operational accounts, one by one", async () => {
    await cli.run(["admin", "users", "kind-check"]);
    expect(cli.requests.length).toBeGreaterThan(0);
    for (const q of cli.requests) {
      expect(q.method).toBe("GET");
      expect(q.path).toMatch(/^\/admin\/users\/[^/]+$/);
    }
  });

  test.each([
    "approve",
    "revoke",
    "role",
    "verify",
    "kind",
    "kind-check",
    "keys",
    "email-preferences",
    "duplicates",
    "backfill-usernames",
  ])("admin users %s --help is that command's help", async (name) => {
    const r = await cli.run(["admin", "users", name, "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`Usage: nemar admin users ${name} `);
    expect(cli.requests).toEqual([]);
  });
});
