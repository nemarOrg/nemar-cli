/**
 * Real-name DOI attribution (#1255, epic #1250).
 *
 * Two things are pinned here, both about the same rule: a DOI cites the
 * person who deposited the dataset by their RESEARCHER NAME, and a NEMAR
 * username is never emitted into DataCite, EZID, or Zenodo metadata.
 *
 * 1. THE XML. The composition that every DOI path funnels through --
 *    owner row -> resolveOwnerIdentity -> buildOrcidEnrichment ->
 *    bidsToDataCite -> buildDataCiteXml -- is driven from a REAL owner row
 *    read out of a real SQLite database with the production schema, so the
 *    fixture cannot quietly disagree with the columns production selects.
 *    The username in that row is a distinctive string, and the assertion is
 *    that it appears nowhere in the document EZID would receive.
 *
 * 2. THE PRECONDITION. The two mint entry points -- POST
 *    /datasets/:id/publish/request and POST /admin/datasets/:id/doi/concept
 *    -- are driven as real Hono routes against that same database, with real
 *    auth middleware and real hashed tokens. Both asserted paths return
 *    before any GitHub/EZID call, so nothing here touches the network
 *    (no-mocks policy).
 *
 * The interesting negative case is deliberately a HALF-filled name (family
 * present, given NULL): "has a name" is not the same question as "has a
 * citable name", and a half name used to be the shape most likely to slip
 * through as `undefined, Doe`.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { datasetRoutes } from "../src/routes/datasets";
import { bidsToDataCite, buildDataCiteXml } from "../src/services/datacite";
import { buildOrcidEnrichment } from "../src/services/doi";
import { hashApiKey } from "../src/services/token";
import { OWNER_NAME_MISSING_REASON, resolveOwnerIdentity } from "../src/services/uploader-identity";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const OWNER_KEY = "realname-owner-key-0123456789abcdef0123456789ab";
const ADMIN_KEY = "realname-admin-key-0123456789abcdef0123456789ab";
/** Deliberately unmistakable: a substring check for it cannot false-positive
 *  on ordinary DataCite boilerplate. */
const OWNER_USERNAME = "zqxuploader7";
const DATASET_ID = "nm000281";
const ORCID = "0000-0002-1825-0097";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let ownerId: number;

interface NameSeed {
  given?: string | null;
  family?: string | null;
  orcid?: string | null;
}

async function seedOwner({ given = "Jane", family = "Doe", orcid = ORCID }: NameSeed = {}) {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        service_access, sandbox_completed, given_name, family_name, orcid)
     VALUES (?, ?, 'x', 'approved', 'member', 1, 1, 1, ?, ?, ?)`,
  ).run(OWNER_USERNAME, `${OWNER_USERNAME}@example.org`, given, family, orcid);
  const u = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(OWNER_USERNAME);
  if (!u) throw new Error("seed: owner insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(OWNER_KEY),
    OWNER_KEY.slice(0, 8),
  );
  ownerId = u.id;
  return u.id;
}

async function seedAdmin() {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('realnameadmin', 'realnameadmin@example.org', 'x', 'approved', 'admin', 1)`,
  ).run();
  const u = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='realnameadmin'")
    .get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

function seedDataset(overrides: { source?: string | null; is_exemplar?: number } = {}) {
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, is_sandbox,
                           visibility, status, source, is_exemplar)
     VALUES (?, 'Real Name Attribution Fixture', ?, ?, 0, 'private', 'active', ?, ?)`,
  ).run(
    DATASET_ID,
    ownerId,
    `nemarDatasets/${DATASET_ID}`,
    overrides.source ?? null,
    overrides.is_exemplar ?? 0,
  );
}

/** The owner row exactly as every DOI-minting query aliases it. */
function ownerRow() {
  const row = db
    .query<
      {
        owner_username: string;
        owner_given_name: string | null;
        owner_family_name: string | null;
        owner_orcid: string | null;
      },
      [string]
    >(
      `SELECT u.username as owner_username, u.given_name as owner_given_name,
              u.family_name as owner_family_name, u.orcid as owner_orcid
       FROM datasets d JOIN users u ON d.owner_user_id = u.id
       WHERE d.dataset_id = ?`,
    )
    .get(DATASET_ID);
  if (!row) throw new Error("fixture: owner row missing");
  return row;
}

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
}

function post(path: string, key: string, body?: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-CLI-Version": "99.0.0",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env(),
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
  app.route("/admin", adminRoutes);
});

describe("DataCite XML built from a real owner row", () => {
  const bids = { Name: "A study of something", Authors: ["Smith, John"] };

  test("cites the uploader by real name and never by username", async () => {
    await seedOwner();
    seedDataset();

    const enrichment = buildOrcidEnrichment(bids, resolveOwnerIdentity(ownerRow()));
    const xml = buildDataCiteXml(
      bidsToDataCite(DATASET_ID, "10.82901/NEMAR.NM000281", bids, enrichment),
    );

    expect(xml).toContain('<contributor contributorType="DataCurator">');
    expect(xml).toContain('<contributorName nameType="Personal">Doe, Jane</contributorName>');
    expect(xml).toContain("<givenName>Jane</givenName>");
    expect(xml).toContain("<familyName>Doe</familyName>");
    expect(xml).toContain(ORCID);
    // The whole point of #1255.
    expect(xml).not.toContain(OWNER_USERNAME);
  });

  test("emits no DataCurator at all when the owner's name is half-filled", async () => {
    // given_name NULL: not citable. The old code would have fallen back to
    // the username here, which is exactly what must not happen.
    await seedOwner({ given: null });
    seedDataset();

    const enrichment = buildOrcidEnrichment(bids, resolveOwnerIdentity(ownerRow()));
    const metadata = bidsToDataCite(DATASET_ID, "10.82901/NEMAR.NM000281", bids, enrichment);
    const xml = buildDataCiteXml(metadata);

    expect(metadata.contributors?.filter((c) => c.contributorType === "DataCurator")).toHaveLength(
      0,
    );
    expect(xml).not.toContain(OWNER_USERNAME);
    expect(xml).not.toContain("DataCurator");
    // The hosting institution is still there: dropping the curator must not
    // drop the rest of the contributors block.
    expect(xml).toContain("HostingInstitution");
  });
});

describe("POST /datasets/:id/publish/request name precondition", () => {
  test("blocks with owner_name_missing when the owner has no given name", async () => {
    await seedOwner({ given: null });
    seedDataset();

    const res = await post(`/datasets/${DATASET_ID}/publish/request`, OWNER_KEY);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { block_reason: string; message: string };
    expect(body.block_reason).toBe(OWNER_NAME_MISSING_REASON);
    expect(body.message).toContain("ORCID");
    expect(body.message).toContain("Settings");

    // Persisted, so GET /publish/status later says the same thing.
    const row = db
      .query<{ status: string; block_reason: string | null }, [string]>(
        "SELECT status, block_reason FROM publication_requests WHERE dataset_id = ?",
      )
      .get(DATASET_ID);
    expect(row?.status).toBe("blocked");
    expect(row?.block_reason).toBe(OWNER_NAME_MISSING_REASON);
  });

  test("blocks when the owner has no family name either", async () => {
    await seedOwner({ family: null });
    seedDataset();

    const res = await post(`/datasets/${DATASET_ID}/publish/request`, OWNER_KEY);
    expect(res.status).toBe(422);
    expect((await res.json()).block_reason).toBe(OWNER_NAME_MISSING_REASON);
  });

  test("treats a whitespace-only name as missing", async () => {
    await seedOwner({ given: "   " });
    seedDataset();

    const res = await post(`/datasets/${DATASET_ID}/publish/request`, OWNER_KEY);
    expect(res.status).toBe(422);
    expect((await res.json()).block_reason).toBe(OWNER_NAME_MISSING_REASON);
  });

  test("an OpenNeuro import is exempt (its owner is a service account)", async () => {
    await seedOwner({ given: null, family: null });
    seedDataset({ source: "openneuro" });

    const res = await post(`/datasets/${DATASET_ID}/publish/request`, OWNER_KEY);
    // Not the name block. It proceeds into the CI readiness checks, which
    // fail closed without GitHub auth configured -- a DIFFERENT reason.
    const body = (await res.json()) as { block_reason?: string };
    expect(body.block_reason).not.toBe(OWNER_NAME_MISSING_REASON);
  });

  test("an exemplar is exempt", async () => {
    await seedOwner({ given: null, family: null });
    seedDataset({ is_exemplar: 1 });

    const res = await post(`/datasets/${DATASET_ID}/publish/request`, OWNER_KEY);
    const body = (await res.json()) as { block_reason?: string };
    expect(body.block_reason).not.toBe(OWNER_NAME_MISSING_REASON);
  });

  test("a named owner is not blocked on the name", async () => {
    await seedOwner();
    seedDataset();

    const res = await post(`/datasets/${DATASET_ID}/publish/request`, OWNER_KEY);
    const body = (await res.json()) as { block_reason?: string };
    expect(body.block_reason).not.toBe(OWNER_NAME_MISSING_REASON);
  });
});

describe("POST /admin/publish/:id/approve name precondition", () => {
  beforeEach(async () => {
    await seedAdmin();
  });

  function seedRequest() {
    db.query(
      "INSERT INTO publication_requests (dataset_id, requested_by, status) VALUES (?, ?, 'requested')",
    ).run(DATASET_ID, ownerId);
  }

  test("refuses to approve, and walks the request back to blocked", async () => {
    await seedOwner({ given: null });
    seedDataset();
    seedRequest();

    const res = await post(`/admin/publish/${DATASET_ID}/approve`, ADMIN_KEY, {});
    expect(res.status).toBe(422);
    const body = (await res.json()) as { block_reason: string };
    expect(body.block_reason).toBe(OWNER_NAME_MISSING_REASON);

    // Not left at 'approving': the owner has to be able to re-request after
    // fixing their name, and POST /publish/request 409s on a non-blocked
    // active request.
    const row = db
      .query<{ status: string; block_reason: string | null }, [string]>(
        "SELECT status, block_reason FROM publication_requests WHERE dataset_id = ?",
      )
      .get(DATASET_ID);
    expect(row?.status).toBe("blocked");
    expect(row?.block_reason).toBe(OWNER_NAME_MISSING_REASON);
  });

  test("a named owner gets past the name gate", async () => {
    await seedOwner();
    seedDataset();
    seedRequest();

    const res = await post(`/admin/publish/${DATASET_ID}/approve`, ADMIN_KEY, {});

    // Not the 422: the run got past the name gate and went on to resolve a
    // GitHub token, which is unconfigured here and throws. That 500 is the
    // shape of "past the gate" for a test that refuses to touch the network;
    // what matters is that the request row was NOT walked back to blocked.
    expect(res.status).not.toBe(422);
    const row = db
      .query<{ status: string; block_reason: string | null }, [string]>(
        "SELECT status, block_reason FROM publication_requests WHERE dataset_id = ?",
      )
      .get(DATASET_ID);
    expect(row?.status).toBe("approving");
    expect(row?.block_reason).toBeNull();
  });
});

describe("POST /admin/datasets/:id/doi/concept name precondition", () => {
  beforeEach(async () => {
    await seedAdmin();
  });

  test("refuses to mint a concept DOI for a nameless owner", async () => {
    await seedOwner({ given: null });
    seedDataset();

    const res = await post(`/admin/datasets/${DATASET_ID}/doi/concept`, ADMIN_KEY, {
      sandbox: true,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { block_reason: string; message: string };
    expect(body.block_reason).toBe(OWNER_NAME_MISSING_REASON);
    expect(body.message).toContain("ORCID");

    // No DOI was recorded.
    const row = db
      .query<{ concept_doi: string | null }, [string]>(
        "SELECT concept_doi FROM datasets WHERE dataset_id = ?",
      )
      .get(DATASET_ID);
    expect(row?.concept_doi).toBeNull();
  });

  test("gets past the name gate for a named owner", async () => {
    await seedOwner();
    seedDataset();

    const res = await post(`/admin/datasets/${DATASET_ID}/doi/concept`, ADMIN_KEY, {
      sandbox: true,
    });
    // Stops at the NEXT gate (enrichment has not run), not the name gate.
    const body = (await res.json()) as { block_reason?: string; error?: string };
    expect(body.block_reason).toBeUndefined();
    expect(body.error).toMatch(/[Mm]etadata pipeline/);
  });
});
