/**
 * The Worker's record of a merge it is about to send, `WORKER_MERGE_SENT_SQL` (epic #1046 phase 7,
 * #1913; ADR 0111, its Phase 7g amendment), on Miniflare's D1, the implementation
 * `wrangler d1 --local` runs, rather than bun:sqlite.
 *
 * The statement runs only while both automatic re-pull switches are on, and a merge is sent only if
 * it writes its audit row: one INSERT ... SELECT that applies while the record is still the
 * automatic one, at the revision and under the claim the Worker read, fewer than the bound of sends
 * are recorded and, for a send again, the claim is young.
 * `upstream-repull-worker-merge.test.ts` proves the whole merge on bun:sqlite; this runs the
 * statement itself with the nine parameters `sendUnderClaim` binds, and each refusal differs from
 * the matching send in one input alone. In-process only: no `wrangler dev` and no server of the
 * Worker's own.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { SYSTEM_USER_ID } from "../src/lib/constants";
import {
  WORKER_MERGES_MAX,
  WORKER_MERGE_ACTION,
  WORKER_MERGE_ANSWER_ACTION,
  WORKER_MERGE_SENT_SQL,
} from "../src/services/upstream-repull-merge";
import { HELD_CLAIM_MAX_AGE_MINUTES } from "../src/services/upstream-repull-verified";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";
import { type Row, SHA, rowAt } from "./helpers/repull-rows";

const DATASET = "on004362";
/** The revision the claim's own write left, which a send must still find. */
const REVISION = 4;
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
/** Claim ages, in minutes, a minute either side of the bound a send again is held to. */
const JUST_INSIDE = HELD_CLAIM_MAX_AGE_MINUTES - 1;
const JUST_PAST = HELD_CLAIM_MAX_AGE_MINUTES + 1;

let mf: Miniflare;
let d1: D1Database;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: ["DB"],
  });
  d1 = await mf.getD1Database("DB");
  await applyMigrations(d1, migrationFiles());
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
}, 30_000);

beforeEach(async () => {
  await d1.prepare("DELETE FROM upstream_repulls").run();
  await d1.prepare("DELETE FROM audit_log").run();
});

interface Claim {
  id: number;
  /** The claim's Worker-stamped time, as the row holds it and as `?6` must carry it. */
  claimedAt: string;
}

/** D1's own clock `minutes` ago, in the form a claim is stamped with (`datetime('now')`). */
async function minutesAgo(minutes: number): Promise<string> {
  const row = await d1
    .prepare("SELECT datetime('now', ?1) AS stamped")
    .bind(`-${minutes} minutes`)
    .first<{ stamped: string }>();
  if (!row) throw new Error("D1 returned no clock reading");
  return row.stamped;
}

/** An automatic re-pull at gates_clear holding the claim of SHA, made `age` minutes ago. */
async function seedClaim(age = 3, over: Row = {}): Promise<Claim> {
  const claimedAt = await minutesAgo(age);
  const row = rowAt("gates_clear", {
    dataset_id: DATASET,
    origin: "automatic",
    planner: 2,
    merge_claim_sha: SHA,
    merge_claimed_at: claimedAt,
    revision: REVISION,
    ...over,
  });
  const cols = Object.keys(row);
  const inserted = await d1
    .prepare(
      `INSERT INTO upstream_repulls (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    )
    .bind(...cols.map((c) => row[c]))
    .run();
  return { id: Number(inserted.meta.last_row_id), claimedAt };
}

interface Send {
  revision: number;
  sha: string;
  claimedAt: string;
  young: 0 | 1;
  attempt: number;
}

/**
 * Run the statement through the D1 binding with the nine parameters `sendUnderClaim` binds, in its
 * order, and return the rows it changed: the number the Worker reads to decide whether to send.
 * Without `over`, the send is the one the claim describes.
 */
async function send(claim: Claim, over: Partial<Send> = {}): Promise<number> {
  const s: Send = {
    revision: REVISION,
    sha: SHA,
    claimedAt: claim.claimedAt,
    young: 0,
    attempt: 1,
    ...over,
  };
  const ran = await d1
    .prepare(WORKER_MERGE_SENT_SQL)
    .bind(
      SYSTEM_USER_ID,
      claim.id,
      JSON.stringify({
        dataset_id: DATASET,
        pr: "n0",
        sha: s.sha,
        claimed_at: s.claimedAt,
        attempt: s.attempt,
      }),
      s.revision,
      s.sha,
      s.claimedAt,
      s.young,
      WORKER_MERGES_MAX,
      String(claim.id),
    )
    .run();
  return ran.meta.changes;
}

interface AuditRow {
  id: number;
  user_id: number | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  id_type: string;
  details: string | null;
}

/** Every row of the audit log, as it is stored: the statement writes nothing else. */
async function auditRows(): Promise<AuditRow[]> {
  return (
    await d1
      .prepare(
        `SELECT id, user_id, action, resource_type, resource_id, typeof(resource_id) AS id_type,
                details
           FROM audit_log ORDER BY id`,
      )
      .all<AuditRow>()
  ).results;
}

/** The statement reports no change to its caller and leaves the audit log empty. */
async function expectNothingRecorded(claim: Claim, over: Partial<Send> = {}): Promise<void> {
  expect(await send(claim, over)).toBe(0);
  expect(await auditRows()).toEqual([]);
}

/**
 * Audit rows the bound's count must not take, as many of each kind as the bound, so a count that
 * took any one kind would refuse the first send. Each kind differs from the rows the count is
 * meant to take in one column alone: the merges of another re-pull (`resource_id`), the answers
 * to this re-pull's merges (`action`), and this re-pull's id with the merge action under another
 * kind of resource (`resource_type`). Returns the id of the last row seeded, so the rows after it
 * are the ones the statement wrote.
 */
async function seedDecoys(claim: Claim): Promise<number> {
  const kinds = [
    { action: WORKER_MERGE_ACTION, type: "upstream_repull", id: String(claim.id + 1) },
    { action: WORKER_MERGE_ANSWER_ACTION, type: "upstream_repull", id: String(claim.id) },
    { action: WORKER_MERGE_ACTION, type: "dataset", id: String(claim.id) },
  ];
  for (const kind of kinds) {
    for (let attempt = 1; attempt <= WORKER_MERGES_MAX; attempt++) {
      await d1
        .prepare(
          `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          SYSTEM_USER_ID,
          kind.action,
          kind.type,
          kind.id,
          JSON.stringify({
            dataset_id: DATASET,
            pr: "n0",
            sha: SHA,
            claimed_at: claim.claimedAt,
            attempt,
          }),
        )
        .run();
    }
  }
  const last = await d1.prepare("SELECT MAX(id) AS id FROM audit_log").first<{ id: number }>();
  if (!last) throw new Error("D1 returned no audit rows after the decoys were seeded");
  return last.id;
}

/** The rows the statement wrote: every audit row after `id`, the last decoy. */
async function rowsAfter(id: number): Promise<AuditRow[]> {
  return (await auditRows()).filter((r) => r.id > id);
}

describe("a send the row's claim allows, on D1", () => {
  test("a send under the claim the row holds records one audit row for the system user", async () => {
    const claim = await seedClaim();
    expect(await send(claim)).toBe(1);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // SYSTEM_USER_ID: the seeded nemar-system user, which the audit log's foreign key needs.
      user_id: -1,
      action: "repull_auto_merge",
      resource_type: "upstream_repull",
      resource_id: String(claim.id),
      id_type: "text",
    });
    expect(JSON.parse(String(rows[0]?.details))).toEqual({
      dataset_id: DATASET,
      pr: "n0",
      sha: SHA,
      claimed_at: claim.claimedAt,
      attempt: 1,
    });
  });

  test(`a send again under a claim ${JUST_INSIDE} minutes old is recorded (?7 = 1, inside the bound)`, async () => {
    const claim = await seedClaim(JUST_INSIDE);
    // The first send, then the send again under the same claim that a lost answer leads to.
    expect(await send(claim)).toBe(1);
    expect(await send(claim, { young: 1, attempt: 2 })).toBe(1);
    expect(await auditRows()).toHaveLength(2);
  });

  test(`a first send under a claim ${JUST_PAST} minutes old is recorded (age is read only when ?7 = 1)`, async () => {
    const claim = await seedClaim(JUST_PAST);
    expect(await send(claim)).toBe(1);
    expect(await auditRows()).toHaveLength(1);
  });
});

describe("a send the statement does not record, on D1", () => {
  test("a send at another revision than the claim left records nothing (revision = ?4)", async () => {
    const claim = await seedClaim();
    await expectNothingRecorded(claim, { revision: REVISION + 1 });
  });

  test("a send for another claim sha records nothing (merge_claim_sha = ?5)", async () => {
    const claim = await seedClaim();
    await expectNothingRecorded(claim, { sha: OTHER_SHA });
  });

  test("a send for another claim time records nothing (merge_claimed_at = ?6)", async () => {
    const claim = await seedClaim();
    await expectNothingRecorded(claim, { claimedAt: await minutesAgo(10) });
  });

  test("an administrator's re-pull records nothing (origin = 'automatic')", async () => {
    const claim = await seedClaim(3, { origin: "administrator" });
    await expectNothingRecorded(claim);
  });

  test(`a send past the bound of ${WORKER_MERGES_MAX} records nothing, counting only this re-pull's merge rows (COUNT(*) < ?8)`, async () => {
    const claim = await seedClaim();
    // The log already holds the bound's count of look-alike rows of three kinds (`seedDecoys`).
    // None is this re-pull's merge, so none may count toward the bound or take a send's place.
    const lastDecoy = await seedDecoys(claim);
    // The sends up to the bound are each recorded: the first as a send, the rest as sends again.
    for (let attempt = 1; attempt <= WORKER_MERGES_MAX; attempt++) {
      const young = attempt === 1 ? 0 : 1;
      expect([attempt, await send(claim, { attempt, young })]).toEqual([attempt, 1]);
    }
    expect(await rowsAfter(lastDecoy)).toHaveLength(WORKER_MERGES_MAX);
    // The next is refused, and the rows the statement counted are still the only ones it wrote.
    expect(await send(claim, { attempt: WORKER_MERGES_MAX + 1, young: 1 })).toBe(0);
    const rows = await rowsAfter(lastDecoy);
    expect(rows.map((r) => JSON.parse(String(r.details)).attempt)).toEqual(
      Array.from({ length: WORKER_MERGES_MAX }, (_, i) => i + 1),
    );
  });

  test(`a send again under a claim ${JUST_PAST} minutes old records nothing (?7 = 1, past the bound)`, async () => {
    const claim = await seedClaim(JUST_PAST);
    await expectNothingRecorded(claim, { young: 1 });
  });

  // The next three start from the matching row and change the one column their predicate reads,
  // with the same matching send, so each refuses for that predicate alone.
  test("a re-pull no longer at gates_clear records nothing (status = 'gates_clear')", async () => {
    const claim = await seedClaim();
    // pr_open is a stage a record can return to from gates_clear, and it needs no other column.
    await d1
      .prepare("UPDATE upstream_repulls SET status = 'pr_open' WHERE id = ?")
      .bind(claim.id)
      .run();
    await expectNothingRecorded(claim);
  });

  test("a re-pull with a merge already recorded records nothing (merge_sha IS NULL)", async () => {
    const claim = await seedClaim();
    await d1
      .prepare("UPDATE upstream_repulls SET merge_sha = ? WHERE id = ?")
      .bind(SHA, claim.id)
      .run();
    await expectNothingRecorded(claim);
  });

  test("a send for an id the row does not have records nothing (id = ?2)", async () => {
    const claim = await seedClaim();
    await d1
      .prepare("UPDATE upstream_repulls SET id = ? WHERE id = ?")
      .bind(claim.id + 1000, claim.id)
      .run();
    await expectNothingRecorded(claim);
  });
});
