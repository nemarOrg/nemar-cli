/**
 * The per-dataset Zarr re-conversion signal, end to end (#1409, epic #1406).
 *
 * De-anonymizing a deposit changes neither its dataset version nor the global
 * engine stamp, which were the conversion queue's only two triggers, so its
 * stores kept serving the blinded citation forever. `sweep_stamps.$.zarr_requeue_at`
 * is the lever that fixes that, and it only works if three links hold: the
 * orchestrator WRITES it, the catalog PROJECTS it, and `zarr_queue.reconcile`
 * READS it. The Python half is covered in `scripts/zarr/test_zarr_queue.py`;
 * this file covers the two TypeScript links, which were previously asserted
 * only by an index-of scan over the orchestrator's source text -- a check that
 * stayed green when the write was wrapped in `if (false)`, nulled, or pointed
 * at the wrong row.
 */

import { describe, expect, test } from "bun:test";
import { stampZarrRequeue } from "../src/services/publication-orchestrator";
import { freshDb, realD1 } from "./helpers/d1";

function seedPublished(
  db: ReturnType<typeof freshDb>,
  datasetId: string,
  opts: { anonymousRequest: boolean },
): void {
  db.run(
    `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
     VALUES (41, 'depositor', 'dep@example.org', 'x', 'approved', 'member', 1)
     ON CONFLICT(id) DO NOTHING`,
  );
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, github_repo, anonymous)
     VALUES (?, 'A sufficiently descriptive dataset title', 41, 'active', 'public', ?, 0)`,
  ).run(datasetId, `nemarDatasets/${datasetId}`);
  db.query(
    `INSERT INTO publication_requests (dataset_id, requested_by, status, anonymous)
     VALUES (?, 41, 'published', ?)`,
  ).run(datasetId, opts.anonymousRequest ? 1 : 0);
}

function requeueStamp(db: ReturnType<typeof freshDb>, datasetId: string): string | null {
  const row = db
    .query<{ v: string | null }, [string]>(
      "SELECT json_extract(sweep_stamps, '$.zarr_requeue_at') AS v FROM datasets WHERE dataset_id = ?",
    )
    .get(datasetId);
  return row?.v ?? null;
}

describe("the flip asks for a rebuild", () => {
  test("a dataset that was anonymous gets a requeue stamp", async () => {
    const db = freshDb();
    seedPublished(db, "nm000801", { anonymousRequest: true });
    expect(requeueStamp(db, "nm000801")).toBeNull();
    const warning = await stampZarrRequeue(realD1(db), "nm000801", false);
    expect(warning).toBeUndefined();
    // A real timestamp on the real row, not merely "some source line exists".
    expect(requeueStamp(db, "nm000801")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    db.close();
  });

  test("a dataset that was never anonymous asks for nothing", async () => {
    // The control. Every ordinary publication would otherwise buy a full
    // reconversion of its stores for no reason.
    const db = freshDb();
    seedPublished(db, "nm000802", { anonymousRequest: false });
    await stampZarrRequeue(realD1(db), "nm000802", false);
    expect(requeueStamp(db, "nm000802")).toBeNull();
    db.close();
  });

  test("an anonymous RELEASE asks for nothing: blinded stores are correct then", async () => {
    // The release is anonymity ARRIVING. Its stores should carry the blinded
    // label, so there is nothing to rebuild.
    const db = freshDb();
    seedPublished(db, "nm000803", { anonymousRequest: true });
    await stampZarrRequeue(realD1(db), "nm000803", true);
    expect(requeueStamp(db, "nm000803")).toBeNull();
    db.close();
  });

  test("the stamp lands on the named dataset and no other", async () => {
    const db = freshDb();
    seedPublished(db, "nm000804", { anonymousRequest: true });
    seedPublished(db, "nm000805", { anonymousRequest: true });
    await stampZarrRequeue(realD1(db), "nm000804", false);
    expect(requeueStamp(db, "nm000804")).not.toBeNull();
    expect(requeueStamp(db, "nm000805")).toBeNull();
    db.close();
  });

  test("a write that fails is REPORTED, because nothing else re-checks it", async () => {
    // The anonymity sweep selects `anonymous = 1`; by this point the row is
    // `anonymous = 0`, so a missed stamp has left the only pool that would
    // have caught it. Swallowing this meant a public dataset serving a blinded
    // citation forever with one line in a Worker log.
    const db = freshDb();
    seedPublished(db, "nm000806", { anonymousRequest: true });
    const broken = {
      prepare(sql: string) {
        const real = realD1(db).prepare(sql);
        if (!sql.includes("zarr_requeue_at")) return real;
        return {
          bind: () => ({
            run: async () => {
              throw new Error("D1_ERROR: database is locked");
            },
          }),
        };
      },
    } as unknown as D1Database;
    const warning = await stampZarrRequeue(broken, "nm000806", false);
    expect(warning).toContain("nm000806");
    expect(warning).toContain("database is locked");
    // And the failure is durable, not only returned.
    const audit = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'zarr_requeue_request_failed'",
      )
      .get();
    expect(audit?.n).toBe(1);
    db.close();
  });
});

describe("the catalog carries the request to the converter", () => {
  // `zarr_queue.py` reads `zarr_requeue_at` off the public catalog row -- the
  // conversion queue's state is SQLite on the Hallu node, so this field is the
  // ONLY channel the backend has for "re-convert this one dataset". Deleting
  // the projection left the whole TypeScript suite green and would have made
  // every request invisible forever, so it is asserted through the real route.
  test("GET /datasets projects zarr_requeue_at from sweep_stamps", async () => {
    const { Hono } = await import("hono");
    const { registerCatalogRoutes } = await import("../src/routes/datasets/catalog");
    const db = freshDb();
    db.query(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox, sweep_stamps)
       VALUES (?, 'Requested', -1, 'active', 'public', 0, ?)`,
    ).run("nm000810", JSON.stringify({ zarr_requeue_at: "2026-09-16 04:00:00" }));
    db.query(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox)
       VALUES (?, 'Not requested', -1, 'active', 'public', 0)`,
    ).run("nm000811");

    const app = new Hono();
    registerCatalogRoutes(app as never);
    const res = await app.request("/?limit=50", {}, {
      DB: realD1(db),
      ENVIRONMENT: "development",
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      datasets: { dataset_id: string; zarr_requeue_at?: string | null }[];
    };
    const byId = new Map(body.datasets.map((d) => [d.dataset_id, d.zarr_requeue_at ?? null]));
    expect(byId.get("nm000810")).toBe("2026-09-16 04:00:00");
    // The control: a dataset nobody asked about must not carry a stamp, or the
    // converter would rebuild the entire archive on the next tick.
    expect(byId.get("nm000811")).toBeNull();
    db.close();
  });
});
