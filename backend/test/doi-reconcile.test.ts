/**
 * DOI version-mint reconcile helpers and the sweep itself (epic #896, #900).
 *
 * The first half pins the pure DOI-parsing used to select and route candidates
 * (prod vs sandbox shoulder, version, rotation window).
 *
 * The second half drives `reconcileReservedVersionDois` end to end, which this
 * file used to skip on the grounds that "the reconcile sweep itself hits EZID +
 * D1". Both are now reachable in a test: real migrated SQLite behind `realD1`,
 * and a local `Bun.serve()` standing in for EZID via `NEMAR_EZID_API_URL`. The
 * reason it became worth doing is #1447: this sweep completes stuck-`reserved`
 * version DOIs, and since an anonymous release reserves ON PURPOSE, a sweep
 * that cannot tell the two apart publishes a concealed deposit's identifier
 * with its blinded attribution, permanently, on a cron, with nobody having
 * asked. That is a property of what the sweep sends to the registrar, so that
 * is what is asserted.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { classifyExistingVersionDoi } from "../src/services/doi";
import {
  DOI_RECONCILE_BATCH,
  isEzidNemarDoi,
  isSandboxDoi,
  reconcileReservedVersionDois,
  rotationOffset,
  versionFromVersionDoi,
} from "../src/services/doi-reconcile";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

describe("versionFromVersionDoi", () => {
  test("extracts the semver from a NEMAR version DOI", () => {
    expect(versionFromVersionDoi("10.82901/NEMAR.NM000104.V1.0.0")).toBe("1.0.0");
    expect(versionFromVersionDoi("10.5072/FK2NM000104.V2.3.4")).toBe("2.3.4");
    expect(versionFromVersionDoi("10.82901/NEMAR.NM000104.V1.0.0-rc1")).toBe("1.0.0-rc1");
  });

  test("returns null for a concept DOI (no .V suffix) or garbage", () => {
    expect(versionFromVersionDoi("10.82901/NEMAR.NM000104")).toBeNull();
    expect(versionFromVersionDoi("not-a-doi")).toBeNull();
  });
});

describe("shoulder classification", () => {
  test("isSandboxDoi", () => {
    expect(isSandboxDoi("10.5072/FK2NM000104.V1.0.0")).toBe(true);
    expect(isSandboxDoi("10.82901/NEMAR.NM000104.V1.0.0")).toBe(false);
  });

  test("isEzidNemarDoi accepts both shoulders, rejects others", () => {
    expect(isEzidNemarDoi("10.82901/NEMAR.NM000104.V1.0.0")).toBe(true);
    expect(isEzidNemarDoi("10.5072/FK2NM000104.V1.0.0")).toBe(true);
    expect(isEzidNemarDoi("10.5281/zenodo.123456")).toBe(false); // Zenodo
    expect(isEzidNemarDoi("")).toBe(false);
  });
});

describe("classifyExistingVersionDoi (already-exists branch)", () => {
  test("public -> return early (idempotent)", () => {
    expect(classifyExistingVersionDoi("public")).toBe("return_public");
  });
  test("reserved -> complete the transition", () => {
    expect(classifyExistingVersionDoi("reserved")).toBe("complete_reserved");
  });
  test("unavailable (tombstoned) -> error, never silently resurrect", () => {
    expect(classifyExistingVersionDoi("unavailable")).toBe("error");
  });
});

describe("rotationOffset (guaranteed full coverage)", () => {
  test("zero/empty total -> offset 0", () => {
    expect(rotationOffset(0, 123456789)).toBe(0);
  });

  test("rotates through every bucket over consecutive days, covering all rows", () => {
    const total = DOI_RECONCILE_BATCH * 3 + 7; // 4 buckets
    const buckets = Math.ceil(total / DOI_RECONCILE_BATCH);
    const seen = new Set<number>();
    for (let day = 0; day < buckets; day++) {
      seen.add(rotationOffset(total, day * 86_400_000));
    }
    // Every bucket start is visited exactly once across a full cycle.
    expect(seen.size).toBe(buckets);
    expect([...seen].sort((a, b) => a - b)).toEqual(
      Array.from({ length: buckets }, (_, i) => i * DOI_RECONCILE_BATCH),
    );
    // Highest offset never exceeds the last full bucket start.
    expect(Math.max(...seen)).toBeLessThan(total);
  });

  test("single-bucket total always offset 0", () => {
    expect(rotationOffset(5, 0)).toBe(0);
    expect(rotationOffset(5, 999 * 86_400_000)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The sweep, end to end
// ---------------------------------------------------------------------------

/** Sandbox shoulder, so `isSandboxDoi` routes to the sandbox credentials. */
const STUCK_DOI = "10.5072/FK2NM099820.V1.0.0";
const CONCEALED_DOI = "10.5072/FK2NM099821.V1.0.0";

/** Identifier -> status, as the stand-in registrar holds it. */
let ezid: Map<string, string>;
/** Every write the sweep made, oldest first: `identifier -> new status`. */
let ezidWrites: { identifier: string; status: string | undefined }[];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const identifier = decodeURIComponent(new URL(req.url).pathname.replace(/^\/id\//, ""));
      const status = ezid.get(identifier);
      if (status === undefined) return new Response("error: bad request - no such identifier");
      if (req.method === "GET") {
        return new Response(
          [
            `success: ${identifier}`,
            `_status: ${status}`,
            "_target: https://nemar.example/x",
            "_profile: datacite",
          ].join("\n"),
        );
      }
      // POST: EZID's update. `makePublic` sends `_status` and `_target`.
      const fields: Record<string, string> = {};
      for (const line of (await req.text()).split("\n")) {
        const idx = line.indexOf(": ");
        if (idx !== -1) fields[line.slice(0, idx)] = decodeURIComponent(line.slice(idx + 2));
      }
      ezidWrites.push({ identifier, status: fields._status });
      if (fields._status) ezid.set(identifier, fields._status);
      return new Response(`success: ${identifier}`);
    },
  });
  (globalThis as { NEMAR_EZID_API_URL?: string }).NEMAR_EZID_API_URL =
    `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  (globalThis as { NEMAR_EZID_API_URL?: string }).NEMAR_EZID_API_URL = undefined;
});

beforeEach(() => {
  ezid = new Map();
  ezidWrites = [];
});

/**
 * Production ENVIRONMENT on purpose: the sweep's first act is to refuse to run
 * outside production, so a test that leaves it unset asserts nothing about the
 * logic below that guard. Both DOIs sit on the sandbox shoulder, so the
 * credentials resolved are the sandbox pair and the stand-in answers either way.
 */
function env(db: Database): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    EZID_SANDBOX_USERNAME: "apitest",
    EZID_SANDBOX_PASSWORD: "apitest",
    EZID_USERNAME: "unused",
    EZID_PASSWORD: "unused",
    FRONTEND_URL: "https://nemar.example",
  } as unknown as Bindings;
}

function seedDataset(db: Database, datasetId: string, doi: string, anonymous: number): void {
  db.run(
    `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
     VALUES (82, 'depositor', 'dep@example.org', 'x', 'approved', 'member', 1)
     ON CONFLICT(id) DO NOTHING`,
  );
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                           latest_version_doi, anonymous)
     VALUES (?, 'A sufficiently descriptive dataset title', 82, 'active', 'public', 0, ?, ?)`,
  ).run(datasetId, doi, anonymous);
}

describe("the sweep completes a crash-stranded version DOI", () => {
  test("a reserved identifier on an ordinary dataset is made public", async () => {
    // The control, and the sweep's whole reason to exist (#900). Without it,
    // a sweep that skipped everything would satisfy the test below.
    const db = freshDb();
    seedDataset(db, "nm099820", STUCK_DOI, 0);
    ezid.set(`doi:${STUCK_DOI}`, "reserved");

    await reconcileReservedVersionDois(env(db));

    expect(ezidWrites).toEqual([{ identifier: `doi:${STUCK_DOI}`, status: "public" }]);
    expect(ezid.get(`doi:${STUCK_DOI}`)).toBe("public");
    db.close();
  });

  test("an already-public identifier is left alone", async () => {
    const db = freshDb();
    seedDataset(db, "nm099820", STUCK_DOI, 0);
    ezid.set(`doi:${STUCK_DOI}`, "public");

    await reconcileReservedVersionDois(env(db));

    expect(ezidWrites).toEqual([]);
    db.close();
  });

  test("a tombstoned identifier is left alone", async () => {
    // services/withdraw.ts sets `unavailable` deliberately; resurrecting it
    // would undo an admin's withdrawal on a cron.
    const db = freshDb();
    seedDataset(db, "nm099820", STUCK_DOI, 0);
    ezid.set(`doi:${STUCK_DOI}`, "unavailable");

    await reconcileReservedVersionDois(env(db));

    expect(ezidWrites).toEqual([]);
    expect(ezid.get(`doi:${STUCK_DOI}`)).toBe("unavailable");
    db.close();
  });
});

describe("the sweep never de-anonymizes a concealed deposit", () => {
  test("a reserved identifier on an anonymous deposit is not touched", async () => {
    // The bug this prevents: `reserved` on an anonymous deposit is the DESIRED
    // state (#1447, ADR 0065 A6), not an interrupted publish. Completing it
    // publishes the identifier AND freezes the record it was reserved with,
    // whose creator is the blinded label -- so the cron would break the
    // concealment and permanently misattribute the version in one step.
    //
    // The refusal must run BEFORE the registrar is consulted, so the assertion
    // is on ALL traffic, not just writes: no GET either.
    const db = freshDb();
    seedDataset(db, "nm099821", CONCEALED_DOI, 1);
    ezid.set(`doi:${CONCEALED_DOI}`, "reserved");

    await reconcileReservedVersionDois(env(db));

    expect(ezidWrites).toEqual([]);
    expect(ezid.get(`doi:${CONCEALED_DOI}`)).toBe("reserved");
    db.close();
  });

  test("one concealed deposit does not stop the sweep reaching the others", async () => {
    // `continue`, not `return`. A batch is 25 rows and the rotation window is
    // the only thing guaranteeing every row is eventually visited, so an early
    // exit on the first anonymous row would starve every candidate ordered
    // after it -- silently, and for as long as that row exists.
    const db = freshDb();
    seedDataset(db, "nm099821", CONCEALED_DOI, 1); // orders first by dataset_id
    seedDataset(db, "nm099822", STUCK_DOI, 0);
    ezid.set(`doi:${CONCEALED_DOI}`, "reserved");
    ezid.set(`doi:${STUCK_DOI}`, "reserved");

    await reconcileReservedVersionDois(env(db));

    expect(ezidWrites).toEqual([{ identifier: `doi:${STUCK_DOI}`, status: "public" }]);
    expect(ezid.get(`doi:${CONCEALED_DOI}`)).toBe("reserved");
    db.close();
  });

  test("the candidate query does not hide the anonymous row from the check", async () => {
    // The exclusion is `isAnonymous(row)` in the loop, deliberately NOT a
    // predicate in the WHERE clause: the sibling sweeps all key off
    // `latest_version_doi`, which an anonymous release leaves NULL, so a
    // reasonable widening of the candidate query (see #1447 review item I5)
    // must not be able to route around the refusal. This pins that the row
    // DOES arrive and IS refused, rather than never arriving -- the two are
    // indistinguishable from the outcome alone.
    const db = freshDb();
    seedDataset(db, "nm099821", CONCEALED_DOI, 1);
    ezid.set(`doi:${CONCEALED_DOI}`, "reserved");

    const candidates = db
      .query(
        "SELECT dataset_id FROM datasets WHERE latest_version_doi IS NOT NULL AND latest_version_doi != ''",
      )
      .all() as { dataset_id: string }[];
    expect(candidates.map((c) => c.dataset_id)).toEqual(["nm099821"]);

    await reconcileReservedVersionDois(env(db));
    expect(ezidWrites).toEqual([]);
    db.close();
  });
});

describe("the sweep refuses to run outside production", () => {
  test("a dev environment touches nothing", async () => {
    // Making an identifier public is one-way and the shoulder decides the
    // credentials, so a real 10.82901 DOI sitting in dev D1 would resolve to
    // PRODUCTION EZID auth. The daily cron already excludes this outside
    // production; the guard is repeated in the function so a future caller
    // inherits it.
    //
    // `"development"` and not `"dev"`: that is the literal
    // `backend/wrangler-sccn.toml` sets on the dev worker, and
    // `isNonProductionEnv` matches an explicit set rather than a prefix, so an
    // unrecognized value deliberately reads as production.
    const db = freshDb();
    seedDataset(db, "nm099820", STUCK_DOI, 0);
    ezid.set(`doi:${STUCK_DOI}`, "reserved");

    await reconcileReservedVersionDois({ ...env(db), ENVIRONMENT: "development" } as Bindings);

    expect(ezidWrites).toEqual([]);
    expect(ezid.get(`doi:${STUCK_DOI}`)).toBe("reserved");
    db.close();
  });
});
