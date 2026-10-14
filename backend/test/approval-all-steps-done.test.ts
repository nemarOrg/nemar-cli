/**
 * An approval whose steps are all complete (ADR 0103, decisions 12 and 13; issue #1730).
 *
 * `runPublicationApproval` has a branch for a run that has nothing left to do: a web run that died
 * after its last step and is resumed, or the retry its own warnings ask for. The branch runs the two
 * tail jobs of a de-anonymization (the Zarr rebuild stamp and the completion of the version
 * identifiers a concealed release left reserved), then ends the run with the write every approval
 * ends with. Three things are pinned here, each with real rows:
 *
 *   1. A tail job that warns tells the administrator to "approve the request again to retry", so
 *      the request must stay `approving` for that to be true: closing it would make the retry a
 *      404. Only a run with no warning closes the request.
 *   2. A request that is not `approving` (a `requested` row that carries the steps of an earlier
 *      life, or an owner-name `blocked` one) is refused BEFORE the tail jobs, so a refusal that
 *      reads as "nothing happened" has written no stamp and published no identifier.
 *   3. The call that closes the request writes the `dataset_published` audit row, naming the
 *      account that finished it, and only that call: a concurrent finisher or a second resume
 *      writes none.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real auth
 * middleware and routes. No external service is reached: the tail job that warns does so because
 * the dataset has no concept identifier to relate a reserved version to, which is decided from
 * rows alone.
 *
 * CI TIER: unit-pure. Hermetic: an in-process Worker over a local database.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { APPROVAL_CLOSED_DURING_RUN_MESSAGE } from "../../shared/contract/publication";
import { OWNER_NAME_MISSING_REASON, PUBLICATION_STEPS } from "../../shared/publication-steps";
import { adminRoutes } from "../src/routes/admin";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { WEB_CLAIM_SECRET, seedScreenedRequest, seedUser } from "./helpers/publication-review";

const TERMINAL_KEY = "all-done-terminal-0123456789abcdef0123456789abcdef";
const DATASET = "nm098771";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedUser(db, "allDoneTerminal", "admin", TERMINAL_KEY);
});

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_all_done_test",
    PRESCREEN_CALLBACK_SECRET: WEB_CLAIM_SECRET,
    ...over,
  } as Bindings;
}

function approve(o: { key?: string; bindings?: Bindings } = {}): Promise<Response> {
  return app.request(
    `/admin/publish/${DATASET}/approve`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${o.key ?? TERMINAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ resume: true }),
    },
    o.bindings ?? env(),
  );
}

/** A request with every step done, in `status`. */
function seedAllDone(
  status: "requested" | "approving" | "blocked" = "approving",
  blockReason: string | null = null,
): number {
  const { requestId } = seedScreenedRequest(db, {
    datasetId: DATASET,
    requestStatus: status,
    blockReason,
  });
  db.run("UPDATE publication_requests SET steps_completed = ? WHERE id = ?", [
    JSON.stringify(PUBLICATION_STEPS),
    requestId,
  ]);
  return requestId;
}

/**
 * Give the dataset a concealed era whose completion warns: an earlier request for the blind, and a
 * recorded version with no concept identifier to relate it to. Both tail jobs then have something
 * to do, the Zarr stamp writes `sweep_stamps` and the version job warns (and writes an audit row),
 * with no network.
 */
function seedConcealedEraWithWarning(): void {
  db.run(
    `INSERT INTO publication_requests (dataset_id, requested_by, status, anonymous, requested_at)
     VALUES (?, (SELECT owner_user_id FROM datasets WHERE dataset_id = ?), 'denied', 1,
             datetime('now', '-10 days'))`,
    [DATASET, DATASET],
  );
  db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
    DATASET,
    "10.5072/FK2all-done",
  ]);
}

/** The concealed era's warning is gone: the recorded version is repaired by hand. */
function repairConcealedEra(): void {
  db.run("DELETE FROM dataset_versions WHERE dataset_id = ?", [DATASET]);
}

type Row = Record<string, unknown>;

function requestRow(id: number): Row {
  return db.query("SELECT * FROM publication_requests WHERE id = ?").get(id) as Row;
}

function sweepStamps(): unknown {
  return (
    db
      .query<{ sweep_stamps: string | null }, [string]>(
        "SELECT sweep_stamps FROM datasets WHERE dataset_id = ?",
      )
      .get(DATASET)?.sweep_stamps ?? null
  );
}

function auditRows(action: string): { user_id: number | null; details: Record<string, unknown> }[] {
  return (
    db.query("SELECT user_id, details FROM audit_log WHERE action = ? ORDER BY id").all(action) as {
      user_id: number | null;
      details: string;
    }[]
  ).map((r) => ({ user_id: r.user_id, details: JSON.parse(r.details) }));
}

describe("a tail job that warns leaves the request approving, so approving again is the retry it asks for", () => {
  test("the warning is returned, the request stays approving, nothing is recorded as published, and a repaired run closes it", async () => {
    const id = seedAllDone("approving");
    seedConcealedEraWithWarning();

    const first = await approve();
    expect(first.status).toBe(200);
    const body = (await first.json()) as { status: string; message: string; warnings?: string[] };
    expect(body.message).toBe("All steps already completed");
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings?.[0]).toContain("Approve the request again to retry");
    expect(requestRow(id).status).toBe("approving");
    expect(requestRow(id).approved_at).toBeNull();
    expect(auditRows("dataset_published")).toHaveLength(0);

    // The remedy the warning names is real: approving again finds the request (a published one
    // would be a 404), runs the tail jobs again, and warns again while the cause stands.
    const again = await approve();
    expect(again.status).toBe(200);
    expect(((await again.json()) as { warnings?: string[] }).warnings).toHaveLength(1);
    expect(requestRow(id).status).toBe("approving");

    // Once the cause is repaired, the next approval has nothing to warn about and closes the request.
    repairConcealedEra();
    const closing = await approve();
    expect(closing.status).toBe(200);
    expect(await closing.json()).toEqual({
      message: "All steps already completed",
      dataset_id: DATASET,
      status: "published",
    });
    expect(requestRow(id).status).toBe("published");
    expect(requestRow(id).approved_at).not.toBeNull();
  });
});

describe("a closed request is refused before the tail jobs write anything", () => {
  for (const [name, status, reason] of [
    ["a requested request that carries every step", "requested", null],
    [
      "an owner-name blocked request resumed with every step done",
      "blocked",
      OWNER_NAME_MISSING_REASON,
    ],
  ] as const) {
    test(`${name}: 409 approval_closed_during_run, no stamp, no version identifier work, one audit row`, async () => {
      const id = seedAllDone(status, reason);
      seedConcealedEraWithWarning();
      const stampsBefore = sweepStamps();
      const requestBefore = requestRow(id);

      const res = await approve();

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "approval_closed_during_run",
        message: APPROVAL_CLOSED_DURING_RUN_MESSAGE,
      });
      // The refusal reads as "nothing was published", and so nothing the tail jobs do was done.
      expect(sweepStamps()).toEqual(stampsBefore);
      expect(auditRows("concealed_era_version_doi_incomplete")).toHaveLength(0);
      expect(auditRows("zarr_requeue_request_failed")).toHaveLength(0);
      expect(auditRows("dataset_published")).toHaveLength(0);
      expect(requestRow(id)).toEqual(requestBefore);
      const refused = auditRows("approval_finished_on_closed_request");
      expect(refused).toHaveLength(1);
      expect(refused[0].details).toEqual({ request_id: id, request_status: status });
    });
  }

  test("the control: the same concealed era on an approving request does run the tail jobs", async () => {
    seedAllDone("approving");
    seedConcealedEraWithWarning();
    expect(sweepStamps()).toBeNull();

    const res = await approve();

    expect(res.status).toBe(200);
    expect(sweepStamps()).not.toBeNull();
    expect(auditRows("concealed_era_version_doi_incomplete")).toHaveLength(1);
  });
});
