/**
 * The daily sweep of the accounts the live integration tests leave behind (#1789).
 *
 * Real engine throughout: bun:sqlite behind `realD1` with every migration applied, the real
 * sweep, the real tombstone statements, and (for the route that shares them) real Hono dispatch.
 * No mocks.
 *
 * The thing under test is a predicate that is allowed to delete accounts on a database that
 * shares about 600 real people with the test accounts, so most of this file is rows that must
 * NOT move. Each such row is compared whole, before and after, so a sweep that touched any column
 * of it fails here, not only one that tombstoned it.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { maskedDeletedEmail } from "../src/db/user-tombstone";
import { adminRoutes } from "../src/routes/admin";
import { NONPROD_TEST_ACCOUNT } from "../src/services/auth-code";
import {
  GENERATED_TEST_ACCOUNT_EMAIL,
  TEST_ACCOUNT_SWEEP_BATCH,
  TEST_ACCOUNT_SWEEP_MIN_AGE_DAYS,
  sweepCiTestAccounts,
} from "../src/services/test-account-sweep";
import { hashApiKey } from "../src/services/token";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const SEED_SQL = join(import.meta.dir, "../../scripts/seed-dev-db.sql");
const OWNER_KEY = "sweep-owner-key-0123456789abcdef0123456789abcdef";

let db: Database;
let counter = 0;

/** `env()` is a test environment; `env(undefined)` is a Worker whose ENVIRONMENT binding is unset. */
function env(...given: [string | undefined] | []): Pick<Bindings, "DB" | "ENVIRONMENT"> {
  const environment = given.length === 0 ? "test" : given[0];
  return { DB: realD1(db), ENVIRONMENT: environment } as unknown as Pick<
    Bindings,
    "DB" | "ENVIRONMENT"
  >;
}

/** An address of the shape a live test generates: prefix, label, 13-digit clock, 6 base36. */
function generated(prefix: "dcli" | "df" | "pl", label = "full-loop"): string {
  counter++;
  return `${prefix}-${label}-${1_760_000_000_000 + counter}-ab${String(counter).padStart(4, "0")}@nemar.test`;
}

interface SeedOpts {
  kind?: "person" | "service" | "test";
  source?: "web" | "cli";
  role?: "member" | "admin" | "owner";
  status?: "pending" | "verified" | "approved" | "revoked";
  ageDays?: number;
  deleted?: boolean;
  iam?: string | null;
  uploadRequested?: boolean;
  serviceAccess?: boolean;
}

/** Insert a user shaped like a live-test account unless told otherwise. */
function seedUser(email: string, o: SeedOpts = {}): number {
  const status = o.status ?? "verified";
  db.run(
    `INSERT INTO users (email, status, signup_source, role, account_kind, aws_iam_username,
                        upload_access_requested_at, service_access, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?))`,
    [
      email,
      status,
      o.source ?? "web",
      o.role ?? "member",
      o.kind ?? "person",
      o.iam ?? null,
      o.uploadRequested ? "2026-01-01 00:00:00" : null,
      o.serviceAccess ? 1 : 0,
      o.deleted ? "2026-01-02 00:00:00" : null,
      `-${o.ageDays ?? 30} days`,
      `-${o.ageDays ?? 30} days`,
    ],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error(`seed failed for ${email}`);
  return row.id;
}

function snapshot(id: number): string {
  return JSON.stringify(db.query("SELECT * FROM users WHERE id = ?").get(id));
}

function isTombstoned(id: number): boolean {
  const row = db
    .query<{ deleted_at: string | null }, [number]>("SELECT deleted_at FROM users WHERE id = ?")
    .get(id);
  return row?.deleted_at != null;
}

function count(sql: string, ...params: number[]): number {
  return db.query<{ n: number }, number[]>(sql).get(...params)?.n ?? 0;
}

beforeEach(() => {
  db = freshDb();
  counter = 0;
});

describe("what the sweep tombstones", () => {
  test("every generated shape, with the same masking and cascade as the owner-only delete", async () => {
    const dcli = seedUser(generated("dcli", "full-loop"));
    const df = seedUser(generated("df", "pending-confirm"));
    const pl = seedUser(generated("pl", "cookie572-bearerwins"));
    const target = seedUser(generated("pl", "happy"));
    const email = db
      .query<{ email: string }, [number]>("SELECT email FROM users WHERE id = ?")
      .get(target)?.email as string;

    // The credentials the tombstone has to end, all of them.
    await db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(target, await hashApiKey("k".repeat(40)), "kkkkkkkk");
    await issueSession(env() as Bindings, target, false, "agent", "127.0.0.1", "email_code");
    db.run(
      "INSERT INTO docs_grants (code_hash, user_id, expires_at) VALUES ('g', ?, datetime('now', '+1 hour'))",
      [target],
    );
    db.run(
      "INSERT INTO private_grants (code_hash, user_id, state_hash, expires_at) VALUES ('p', ?, 's', datetime('now', '+1 hour'))",
      [target],
    );
    db.run(
      "INSERT INTO user_s3_permissions (user_id, s3_prefix, permission) VALUES (?, 'nm099999/', 'read')",
      [target],
    );
    db.run(
      "INSERT INTO auth_codes (email, code_hash, expires_at) VALUES (?, 'c', datetime('now', '+1 hour'))",
      [email],
    );

    const result = await sweepCiTestAccounts(env());

    expect(result).toEqual({ ran: true, examined: 4, tombstoned: 4, skipped: 0, errors: 0 });
    for (const id of [dcli, df, pl, target]) {
      const row = db
        .query<{ email: string; status: string; deleted_at: string | null }, [number]>(
          "SELECT email, status, deleted_at FROM users WHERE id = ?",
        )
        .get(id);
      expect(row?.email).toBe(maskedDeletedEmail(id));
      expect(row?.status).toBe("revoked");
      expect(row?.deleted_at).not.toBeNull();
    }
    expect(
      count("SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND revoked_at IS NULL", target),
    ).toBe(0);
    expect(
      count(
        "SELECT COUNT(*) AS n FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL",
        target,
      ),
    ).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM docs_grants WHERE user_id = ?", target)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM private_grants WHERE user_id = ?", target)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM user_s3_permissions WHERE user_id = ?", target)).toBe(
      0,
    );
    expect(
      db
        .query<{ used_at: string | null }, [string]>(
          "SELECT used_at FROM auth_codes WHERE email = ?",
        )
        .get(email)?.used_at,
    ).not.toBeNull();
  });

  test("an account still holding a live key is tombstoned: revocation is the point", async () => {
    const id = seedUser(generated("df"));
    await db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(id, await hashApiKey("z".repeat(40)), "zzzzzzzz");
    const result = await sweepCiTestAccounts(env());
    expect(result.tombstoned).toBe(1);
    expect(
      count("SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND revoked_at IS NULL", id),
    ).toBe(0);
  });

  test("a test-kind account with a generated address is swept too", async () => {
    const id = seedUser(generated("pl"), { kind: "test" });
    expect((await sweepCiTestAccounts(env())).tombstoned).toBe(1);
    expect(isTombstoned(id)).toBe(true);
  });

  test("an account just over the age floor is swept, and just under it is not", async () => {
    const over = seedUser(generated("pl"), { ageDays: TEST_ACCOUNT_SWEEP_MIN_AGE_DAYS + 1 });
    const under = seedUser(generated("pl"), { ageDays: TEST_ACCOUNT_SWEEP_MIN_AGE_DAYS - 1 });
    const before = snapshot(under);
    await sweepCiTestAccounts(env());
    expect(isTombstoned(over)).toBe(true);
    expect(snapshot(under)).toBe(before);
  });
});

describe("what the sweep must never touch", () => {
  /** Each row is untouched whole: a changed `updated_at` counts. */
  function untouched(label: string, make: () => number): [string, () => number] {
    return [label, make];
  }

  const cases: Array<[string, () => number]> = [
    untouched("a real-looking address", () => seedUser("jane.doe@example.org")),
    untouched("a real address that starts like a generated one", () =>
      seedUser("dcli-full-loop-1760000000001-abcdef@example.com"),
    ),
    untouched("a generated shape at a lookalike domain", () =>
      seedUser("dcli-full-loop-1760000000002-abcdef@nemar.test.example.org"),
    ),
    untouched("a generated shape at a subdomain", () =>
      seedUser("dcli-full-loop-1760000000003-abcdef@sub.nemar.test"),
    ),
    untouched("a generated shape at the real org domain", () =>
      seedUser("df-full-loop-1760000000004-abcdef@nemar.org"),
    ),
    untouched("the prefix appearing later in the string", () =>
      seedUser("x-dcli-full-loop-1760000000005-abcdef@nemar.test"),
    ),
    untouched("the prefix as part of the local part of a longer address", () =>
      seedUser("jane.pl-full-loop-1760000000006-abcdef@nemar.test"),
    ),
    untouched("an upper-case rendering of a generated address", () =>
      seedUser("DCLI-FULL-LOOP-1760000000007-ABCDEF@NEMAR.TEST"),
    ),
    untouched("a fixed fixture address that merely starts with a prefix", () =>
      seedUser("pl-profile-patch@nemar.test"),
    ),
    untouched("a generated shape with a short clock", () =>
      seedUser("pl-happy-17600000000-abcdef@nemar.test"),
    ),
    untouched("a generated shape with a second at-sign", () =>
      seedUser("pl-happy-1760000000008-ab@cdef@nemar.test"),
    ),
    untouched("the seeded fixture test-user", () =>
      seedUser("test-user@nemar.test", { kind: "test", status: "approved", serviceAccess: true }),
    ),
    untouched("the shared QA account", () =>
      seedUser(NONPROD_TEST_ACCOUNT, { status: "approved", serviceAccess: true }),
    ),
    untouched("a service account with a generated address", () =>
      seedUser(generated("dcli"), { kind: "service" }),
    ),
    untouched("an account that signed up from the CLI", () =>
      seedUser(generated("dcli"), { source: "cli" }),
    ),
    untouched("an admin with a generated address", () =>
      seedUser(generated("pl"), { role: "admin" }),
    ),
    untouched("an owner with a generated address", () =>
      seedUser(generated("pl"), { role: "owner" }),
    ),
    untouched("an account younger than the age floor", () =>
      seedUser(generated("pl"), { ageDays: 1 }),
    ),
    untouched("an account with legacy IAM credentials", () =>
      seedUser(generated("pl"), { iam: "legacy-iam-user" }),
    ),
    untouched("an account with an open upload-access request", () =>
      seedUser(generated("pl"), { uploadRequested: true }),
    ),
    untouched("an account holding upload access", () =>
      seedUser(generated("pl"), { status: "approved", serviceAccess: true }),
    ),
    untouched("an account that owns a dataset", () => {
      const id = seedUser(generated("pl"));
      db.run(
        "INSERT INTO datasets (dataset_id, name, owner_user_id, status) VALUES ('xx090123', 't', ?, 'active')",
        [id],
      );
      return id;
    }),
    untouched("an account that collaborates on a dataset", () => {
      const owner = seedUser("owner@example.org", { ageDays: 1 });
      const id = seedUser(generated("pl"));
      db.run(
        "INSERT INTO datasets (dataset_id, name, owner_user_id, status) VALUES ('xx090124', 't', ?, 'active')",
        [owner],
      );
      db.run(
        "INSERT INTO dataset_collaborators (dataset_id, user_id, access_type) SELECT id, ?, 'invited' FROM datasets WHERE dataset_id = 'xx090124'",
        [id],
      );
      return id;
    }),
    untouched("an account with a publication request", () => {
      const id = seedUser(generated("pl"));
      db.run("INSERT INTO publication_requests (dataset_id, requested_by) VALUES ('xx090125', ?)", [
        id,
      ]);
      return id;
    }),
    untouched("an account with a pending access request", () => {
      const owner = seedUser("owner2@example.org", { ageDays: 1 });
      const id = seedUser(generated("pl"));
      db.run(
        "INSERT INTO datasets (dataset_id, name, owner_user_id, status) VALUES ('xx090126', 't', ?, 'active')",
        [owner],
      );
      db.run(
        "INSERT INTO access_requests (dataset_id, user_id, status) SELECT id, ?, 'pending' FROM datasets WHERE dataset_id = 'xx090126'",
        [id],
      );
      return id;
    }),
    untouched("an already tombstoned account", () =>
      seedUser(generated("pl"), { deleted: true, status: "revoked" }),
    ),
  ];

  for (const [label, make] of cases) {
    test(label, async () => {
      const id = make();
      const before = snapshot(id);
      const result = await sweepCiTestAccounts(env());
      expect(snapshot(id)).toBe(before);
      expect(isTombstoned(id)).toBe(label === "an already tombstoned account");
      expect(result.tombstoned).toBe(0);
    });
  }

  test("none of the seeded fixture accounts, however old", async () => {
    db.exec(readFileSync(SEED_SQL, "utf-8"));
    db.run("UPDATE users SET created_at = datetime('now', '-400 days')");
    const before = JSON.stringify(db.query("SELECT * FROM users ORDER BY id").all());
    expect(
      count("SELECT COUNT(*) AS n FROM users WHERE username LIKE 'test-%'"),
    ).toBeGreaterThanOrEqual(7);

    const result = await sweepCiTestAccounts(env());

    expect(result.tombstoned).toBe(0);
    expect(JSON.stringify(db.query("SELECT * FROM users ORDER BY id").all())).toBe(before);
  });

  test("a real account and a swept one side by side: only the swept one moves", async () => {
    const real = seedUser("someone.real@university.edu", {
      status: "approved",
      serviceAccess: true,
    });
    const synthetic = seedUser(generated("df"));
    const before = snapshot(real);
    const result = await sweepCiTestAccounts(env());
    expect(result.tombstoned).toBe(1);
    expect(snapshot(real)).toBe(before);
    expect(isTombstoned(synthetic)).toBe(true);
  });
});

describe("the predicate itself", () => {
  test("accepts exactly the three generated shapes", () => {
    for (const p of ["dcli", "df", "pl"] as const) {
      expect(GENERATED_TEST_ACCOUNT_EMAIL.test(generated(p, "a"))).toBe(true);
      expect(GENERATED_TEST_ACCOUNT_EMAIL.test(generated(p, "cookie572-bearerwins"))).toBe(true);
    }
    for (const bad of [
      "ab-full-loop-1760000000001-abcdef@nemar.test",
      "dcli--1760000000001-abcdef@nemar.test",
      "dcli-full-loop-1760000000001-@nemar.test",
      "dcli-full-loop-1760000000001-abcdefg@nemar.test",
      "dcli-full-loop-1760000000001-abcdef@nemar.test\n",
      "\ndcli-full-loop-1760000000001-abcdef@nemar.test",
      "dcli-full-loop-1760000000001-abcdef@nemar.test.evil.com",
      "dcli-full.loop-1760000000001-abcdef@nemar.test",
    ]) {
      expect(GENERATED_TEST_ACCOUNT_EMAIL.test(bad)).toBe(false);
    }
  });
});

describe("the batch bound", () => {
  test("a run takes the oldest accounts up to the bound, and the next run takes the rest", async () => {
    const total = TEST_ACCOUNT_SWEEP_BATCH + 7;
    const ids: number[] = [];
    for (let i = 0; i < total; i++) ids.push(seedUser(generated("pl", "bulk")));

    const first = await sweepCiTestAccounts(env());
    expect(first.tombstoned).toBe(TEST_ACCOUNT_SWEEP_BATCH);
    expect(ids.slice(0, TEST_ACCOUNT_SWEEP_BATCH).every(isTombstoned)).toBe(true);
    expect(ids.slice(TEST_ACCOUNT_SWEEP_BATCH).some(isTombstoned)).toBe(false);

    const second = await sweepCiTestAccounts(env());
    expect(second.tombstoned).toBe(7);
    expect(ids.every(isTombstoned)).toBe(true);

    const third = await sweepCiTestAccounts(env());
    expect(third.tombstoned).toBe(0);
  });

  test("rows the pattern rejects do not starve the batch", async () => {
    // Rows the SQL prefilter admits (it is looser than the pattern) but the pattern rejects: an
    // upper-case label. Enough of them, and OLDER than every real candidate, so a scan that
    // stopped at the first page of rejects would never reach the generated accounts behind them.
    for (let i = 0; i < TEST_ACCOUNT_SWEEP_BATCH + 20; i++) {
      seedUser(`pl-UPPER${i}-${1_760_000_100_000 + i}-abcdef@nemar.test`, { ageDays: 90 });
    }
    const target = seedUser(generated("pl"), { ageDays: 10 });
    const result = await sweepCiTestAccounts(env());
    expect(isTombstoned(target)).toBe(true);
    expect(result.tombstoned).toBe(1);
    expect(result.skipped).toBe(TEST_ACCOUNT_SWEEP_BATCH + 20);
  });
});

describe("it cannot run in production", () => {
  for (const environment of ["production", "prod", "", "Production-Mirror", undefined]) {
    test(`ENVIRONMENT ${JSON.stringify(environment)} does nothing`, async () => {
      const id = seedUser(generated("dcli"));
      const before = snapshot(id);
      const result = await sweepCiTestAccounts(env(environment));
      expect(result).toEqual({ ran: false, examined: 0, tombstoned: 0, skipped: 0, errors: 0 });
      expect(snapshot(id)).toBe(before);
    });
  }

  for (const environment of ["development", "staging", "test"]) {
    test(`ENVIRONMENT ${environment} runs`, async () => {
      seedUser(generated("dcli"));
      expect((await sweepCiTestAccounts(env(environment))).ran).toBe(true);
    });
  }
});

describe("the owner-only delete route shares the tombstone", () => {
  test("the route and the sweep leave the same row and the same cascade", async () => {
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.route("/admin", adminRoutes);
    db.run(
      `INSERT INTO users (username, email, status, role, email_verified, account_kind)
       VALUES ('sweepowner', 'sweepowner@nemar.test', 'approved', 'owner', 1, 'service')`,
    );
    const ownerId = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'sweepowner'")
      .get()?.id as number;
    await db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(ownerId, await hashApiKey(OWNER_KEY), OWNER_KEY.slice(0, 8));

    const viaRoute = seedUser(generated("pl", "route"));
    const viaSweep = seedUser(generated("pl", "sweep"));
    for (const id of [viaRoute, viaSweep]) {
      await db
        .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
        .run(id, await hashApiKey(`key-${id}`.padEnd(40, "x")), `key-${id}`.padEnd(8, "x"));
      db.run(
        "INSERT INTO docs_grants (code_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))",
        [`g${id}`, id],
      );
    }

    const res = await app.request(
      `/admin/users/by-id/${viaRoute}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${OWNER_KEY}` } },
      {
        DB: realD1(db),
        ENVIRONMENT: "test",
        RESEND_API_KEY: "",
      } as unknown as Bindings,
    );
    expect(res.status).toBe(200);
    await sweepCiTestAccounts(env());

    const shape = (id: number) => {
      const u = db.query("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown>;
      // Fields that legitimately differ between two rows.
      const { id: _id, email, created_at: _c, updated_at: _u, deleted_at, revoked_at, ...rest } = u;
      return JSON.stringify({
        ...rest,
        masked: email === maskedDeletedEmail(id),
        deleted: deleted_at != null,
        revoked: revoked_at != null,
        tokens: count(
          "SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND revoked_at IS NULL",
          id,
        ),
        grants: count("SELECT COUNT(*) AS n FROM docs_grants WHERE user_id = ?", id),
      });
    };
    expect(shape(viaSweep)).toBe(shape(viaRoute));
    expect(JSON.parse(shape(viaRoute)).masked).toBe(true);
  });
});
