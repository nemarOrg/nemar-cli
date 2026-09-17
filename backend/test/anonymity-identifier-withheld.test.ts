/**
 * A concealed deposit's reserved identifier does not reach a public surface.
 *
 * `withheldWhileAnonymous` (services/anonymity.ts) was declared as "the same
 * rule for the catalog projections" and then written by hand three more times.
 * Predictably, the fourth and fifth surfaces never got a copy: all three search
 * tiers and both MCP tools projected `d.concept_doi` with no anonymity
 * predicate, so any unauthenticated caller could read the reserved DOI of a
 * dataset whose whole point is that nobody knows whose it is.
 *
 * It is not the depositor's NAME -- `authors` is correctly the blinded label on
 * every one of these. What escapes is the identifier that ADR 0065 says "does
 * not resolve and must not be cited", and MCP's `describe-dataset` composes it
 * into a ready-made `citation` string. The epic's own approval email warns
 * about exactly this: "a depositor mid-submission would paste a dead identifier
 * into a blinded manuscript."
 *
 * Driven through the real exported functions against a real migrated database,
 * because the previous guarantee was a comment.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { dataRoutes } from "../src/routes/data";
import { datasetRoutes } from "../src/routes/datasets";
import { hydrateDatasetsByIds } from "../src/services/dataset-search";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const REAL_DOI = "10.82901/nemar.nm000103";

function seed(db: Database, datasetId: string, anonymous: number): void {
  db.run(
    `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
     VALUES (71, 'depositor', 'dep@example.org', 'x', 'approved', 'member', 1)
     ON CONFLICT(id) DO NOTHING`,
  );
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                           concept_doi, anonymous, authors)
     VALUES (?, 'A sufficiently descriptive dataset title', 71, 'active', 'public', 0, ?, ?, ?)`,
  ).run(
    datasetId,
    REAL_DOI,
    anonymous,
    anonymous === 1 ? "Anonymous (withheld until publication)" : "Lovelace, Ada",
  );
}

describe("search does not hand out a reserved identifier", () => {
  test("an anonymous deposit's DOI is withheld from the hydrated search row", async () => {
    const db = freshDb();
    seed(db, "nm000870", 1);
    const rows = await hydrateDatasetsByIds(realD1(db), ["nm000870"]);
    expect(rows.length).toBe(1);
    // `toResult` normalizes an absent value to "", the same shape it uses for
    // every other missing field. The property under test is that the reserved
    // identifier is not there, not which spelling of empty it uses.
    expect(rows[0].doi).toBeFalsy();
    expect(rows[0].doi).not.toContain("10.82901");
    // The row is still SERVED -- withholding the identifier is not hiding the
    // dataset. A blinded deposit is public and searchable on purpose.
    expect(rows[0].id).toBe("nm000870");
    db.close();
  });

  test("an ordinary dataset keeps its DOI", async () => {
    // The control. Without it, deleting the projection entirely would pass.
    const db = freshDb();
    seed(db, "nm000871", 0);
    const rows = await hydrateDatasetsByIds(realD1(db), ["nm000871"]);
    expect(rows.length).toBe(1);
    expect(rows[0].doi).toBe(REAL_DOI);
    db.close();
  });

  test("the depositor's name never appears either way", async () => {
    const db = freshDb();
    seed(db, "nm000872", 1);
    const rows = await hydrateDatasetsByIds(realD1(db), ["nm000872"]);
    expect(JSON.stringify(rows)).not.toContain("Lovelace");
    db.close();
  });
});

/**
 * The two surfaces the release review of v0.10.4 found still open, both of
 * them the same shape: a query that selects a whole row, and a withholding
 * rule applied to the FIELDS rather than to the row.
 */
describe("the raw columns a whole-row select carries", () => {
  function env(db: Database): Bindings {
    return { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
  }

  function app(
    routes: typeof dataRoutes | typeof datasetRoutes,
  ): Hono<{ Bindings: Bindings; Variables: Variables }> {
    const hono = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    hono.route("/", routes);
    return hono;
  }

  /** What the anonymity sweep writes, and the only place it writes it. */
  function stampAVerdict(db: Database, datasetId: string): void {
    db.query(
      `UPDATE datasets SET sweep_stamps = json_set(
         COALESCE(sweep_stamps, '{}'),
         '$.anonymity_checked_at', datetime('now'),
         '$.anonymity_status', 'findings',
         '$.anonymity_findings', json(?)
       ) WHERE dataset_id = ?`,
    ).run(
      JSON.stringify([
        {
          check: "self_identifier",
          severity: "deposit",
          file: "README",
          detail: "README contains your own name, username, GitHub handle or email address.",
        },
      ]),
      datasetId,
    );
  }

  test("a public read of an anonymous deposit carries no anonymity verdict at all", async () => {
    const db = freshDb();
    seed(db, "nm000873", 1);
    stampAVerdict(db, "nm000873");

    const res = await app(datasetRoutes).request("/nm000873", {}, env(db));
    expect(res.status).toBe(200);
    const raw = await res.text();

    // The four flat fields were already nulled for this viewer. The column
    // they are READ OUT OF was not, so the verdict shipped anyway -- telling
    // a public reader that the concealment is leaking, and which file to
    // fetch to break it. Asserted on the serialized body, because the leak
    // was one level down inside a JSON string and a key-level check missed
    // it; asserted on the VERDICT rather than on the field names, because the
    // four aliases are meant to be present-and-null for this viewer.
    expect(raw).not.toContain("sweep_stamps");
    expect(raw).not.toContain("self_identifier");
    expect(raw).not.toContain("README contains your own name");

    const shaped = JSON.parse(raw).dataset;
    expect(shaped.dataset_id).toBe("nm000873");
    expect(shaped.anonymity_status).toBeNull();
    expect(shaped.anonymity_findings).toBeNull();
    db.close();
  });

  test("an ordinary dataset's read is unchanged by that withholding", async () => {
    // The control: `sweep_stamps` is withheld from everyone, not just from an
    // anonymous row, so this proves the route still works rather than that
    // the row vanished.
    const db = freshDb();
    seed(db, "nm000874", 0);
    stampAVerdict(db, "nm000874");

    const res = await app(datasetRoutes).request("/nm000874", {}, env(db));
    const body = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(body.dataset.dataset_id).toBe("nm000874");
    expect(body.dataset.doi ?? body.dataset.concept_doi).toBe(REAL_DOI);
    db.close();
  });

  test("the data plane's root catalog does not advertise a reserved DOI", async () => {
    const db = freshDb();
    seed(db, "nm000875", 1);
    seed(db, "nm000876", 0);
    db.run("UPDATE datasets SET is_exemplar = 0");
    // Both carry a version DOI: the column is NOT NULL, and the point under
    // test is the CONCEPT doi on `datasets`, which is what the index renders.
    db.query(
      `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
       VALUES ('nm000875', '1.0.0', ?, 'ezid', datetime('now')),
              ('nm000876', '1.0.0', ?, 'ezid', datetime('now'))`,
    ).run(`${REAL_DOI}.v1`, `${REAL_DOI}.v1`);

    const res = await app(dataRoutes).request("/?format=json", {}, env(db));
    const body = await res.text();

    expect(res.status).toBe(200);
    const listed = JSON.parse(body).datasets as Array<{ id: string; doi: string | null }>;
    // Listed, because a blinded deposit is public on purpose...
    expect(listed.find((r) => r.id === "nm000875")).toBeDefined();
    // ...but its concept DOI is `reserved` at EZID and does not resolve, so
    // rendering it as a citation hands a reader a ready-made dead link.
    expect(listed.find((r) => r.id === "nm000875")?.doi).toBeFalsy();
    // The control, without which dropping the column entirely would pass.
    expect(listed.find((r) => r.id === "nm000876")?.doi).toBe(REAL_DOI);
    db.close();
  });

  test("metadata.json does not advertise a reserved VERSION doi (#1447)", async () => {
    // The version array was necessarily empty for a concealed deposit until
    // #1447 let the release mint a reserved version identifier, so this line
    // was unreachable and the withholding next to `dataset_doi` was never
    // extended to it. Now it is reachable.
    const db = freshDb();
    seed(db, "nm000877", 1);
    seed(db, "nm000878", 0);
    db.query(
      `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
       VALUES ('nm000877', '1.0.0', ?, 'ezid', datetime('now')),
              ('nm000878', '1.0.0', ?, 'ezid', datetime('now'))`,
    ).run(`${REAL_DOI}.v1.0.0`, `${REAL_DOI}.v1.0.0`);

    const blinded = await app(dataRoutes).request("/nm000877/metadata.json", {}, env(db));
    const named = await app(dataRoutes).request("/nm000878/metadata.json", {}, env(db));
    expect(blinded.status).toBe(200);
    expect(named.status).toBe(200);

    const blindedVersions = (await blinded.json()).extensions.nemar.versions as Array<{
      version: string;
      doi: string | null;
    }>;
    const namedVersions = (await named.json()).extensions.nemar.versions as Array<{
      version: string;
      doi: string | null;
    }>;

    // The version is still ANNOUNCED -- the data is public and downloadable,
    // which is the whole point of an anonymous release...
    expect(blindedVersions.map((v) => v.version)).toEqual(["v1.0.0"]);
    // ...and its identifier is not, because it is reserved at EZID.
    expect(blindedVersions[0].doi).toBeNull();
    // The control, without which nulling the field unconditionally would pass.
    expect(namedVersions[0].doi).toBe(`${REAL_DOI}.v1.0.0`);
    db.close();
  });

  test("the detail route withholds latest_version_doi from a concealed deposit (#1447)", async () => {
    const db = freshDb();
    seed(db, "nm000879", 1);
    seed(db, "nm000880", 0);
    db.query("UPDATE datasets SET latest_version_doi = ? WHERE dataset_id IN (?, ?)").run(
      `${REAL_DOI}.v1.0.0`,
      "nm000879",
      "nm000880",
    );

    const blinded = await app(datasetRoutes).request("/nm000879", {}, env(db));
    const named = await app(datasetRoutes).request("/nm000880", {}, env(db));
    expect(blinded.status).toBe(200);
    expect(named.status).toBe(200);

    // `SELECT d.*` carries the column without naming it anywhere, which is why
    // the rule is applied over the assembled payload.
    expect((await blinded.json()).dataset.latest_version_doi).toBeNull();
    expect((await named.json()).dataset.latest_version_doi).toBe(`${REAL_DOI}.v1.0.0`);
    db.close();
  });
});
