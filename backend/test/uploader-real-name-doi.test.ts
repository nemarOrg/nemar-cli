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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { datasetRoutes } from "../src/routes/datasets";
import { bidsToDataCite, buildDataCiteXml } from "../src/services/datacite";
import { buildOrcidEnrichment } from "../src/services/doi";
import { hashApiKey } from "../src/services/token";
import {
  OWNER_NAME_MISSING_MESSAGE,
  OWNER_NAME_MISSING_REASON,
  refreshWouldStripAttribution,
  requiresUploaderName,
  resolveOwnerIdentity,
} from "../src/services/uploader-identity";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { mainRefAnswer, markDatasetScreensClean } from "./helpers/identifier-screen";

const OWNER_KEY = "realname-owner-key-0123456789abcdef0123456789ab";
const ADMIN_KEY = "realname-admin-key-0123456789abcdef0123456789ab";
/** Deliberately unmistakable: a substring check for it cannot false-positive
 *  on ordinary DataCite boilerplate. */
const OWNER_USERNAME = "zqxuploader7";
const DATASET_ID = "nm000281";
const ORCID = "0000-0002-1825-0097";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
/** Extra bindings for one describe block (the approve gate's GitHub read). */
let extraEnv: Partial<Bindings> = {};
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
  return { DB: realD1(db), ENVIRONMENT: "test", ...extraEnv } as Bindings;
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

describe("GET /datasets/:id/publish/status: an unrecognised block reason", () => {
  function get(path: string, key: string): Promise<Response> {
    return app.request(path, { headers: { Authorization: `Bearer ${key}` } }, env());
  }

  /** A blocked request carrying `reason` verbatim. `block_reason` is free TEXT
   *  (migration 0015), so any string can genuinely be in there. */
  function seedBlockedRequest(reason: string): void {
    db.query(
      `INSERT INTO publication_requests (dataset_id, status, requested_at, requested_by,
                                         block_reason, updated_at)
       VALUES (?, 'blocked', datetime('now'), ?, ?, datetime('now'))`,
    ).run(DATASET_ID, ownerId, reason);
  }

  test("a reason named after an Object prototype member degrades to text", async () => {
    // `BLOCK_MESSAGES[reason]` on a plain object literal also finds
    // Object.prototype's members, so a row reading "constructor" returned a
    // FUNCTION where the caller expects a sentence -- and `??` cannot rescue
    // it, because a function is not nullish. Caught by the website's copy of
    // this table (nemarOrg/website#306).
    await seedOwner();
    seedDataset();
    seedBlockedRequest("constructor");

    const body = await (await get(`/datasets/${DATASET_ID}/publish/status`, OWNER_KEY)).json();
    expect(body.message).toBe("Publication request blocked.");
    expect(typeof body.message).toBe("string");
  });

  test("the same holds for toString", async () => {
    await seedOwner();
    seedDataset();
    seedBlockedRequest("toString");

    const body = await (await get(`/datasets/${DATASET_ID}/publish/status`, OWNER_KEY)).json();
    expect(body.message).toBe("Publication request blocked.");
  });

  test("a real reason still renders its own message", async () => {
    // Guards the fix against being a blanket fallback: the lookup must still
    // find the entries the table actually owns.
    await seedOwner();
    seedDataset();
    seedBlockedRequest(OWNER_NAME_MISSING_REASON);

    const body = await (await get(`/datasets/${DATASET_ID}/publish/status`, OWNER_KEY)).json();
    expect(body.message).toBe(OWNER_NAME_MISSING_MESSAGE);
  });
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
    // The advice must name a route that exists today: PATCH /auth/profile
    // rejects name edits until #1253, so "type it into Settings" would be a
    // dead end (#1255 review item 18).
    expect(body.message).not.toMatch(/Add a given name and family name in Settings/);

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

describe("refreshWouldStripAttribution (the enrichment DOI sync's guard)", () => {
  // The enrichment pipeline's DOI sync (services/enrich-dataset.ts) evaluates
  // this one line above its updateIdentifier call, and it is what stops an
  // automatic re-sync from deleting a DataCurator off a permanent record.
  //
  // WHY NOT THE FULL enrichDataset ENTRY POINT: that function begins with a
  // Claude API call, so driving it offline would mean standing up the whole
  // multi-stage LLM pipeline as a fixture -- and the identical rule IS driven
  // through a real route, with the EZID payload captured, in
  // doi-attribution-routes.test.ts ("a nameless owner SKIPS the refresh").
  // These fill in the enrichment path's own inputs, read from real rows.
  test("blocks the sync for a published dataset whose owner has no name", async () => {
    await seedOwner({ given: null });
    seedDataset();
    const row = ownerRow();
    expect(
      refreshWouldStripAttribution({ source: null, is_exemplar: 0 }, resolveOwnerIdentity(row)),
    ).toBe(true);
  });

  test("allows the sync once the owner has a citable name", async () => {
    await seedOwner();
    seedDataset();
    expect(
      refreshWouldStripAttribution(
        { source: null, is_exemplar: 0 },
        resolveOwnerIdentity(ownerRow()),
      ),
    ).toBe(false);
  });

  test("allows it for an exempt deposit even with no name", async () => {
    await seedOwner({ given: null, family: null });
    seedDataset({ source: "openneuro" });
    expect(
      refreshWouldStripAttribution(
        { source: "openneuro", is_exemplar: 0 },
        resolveOwnerIdentity(ownerRow()),
      ),
    ).toBe(false);
  });
});

describe("requiresUploaderName", () => {
  // The exemption is a policy statement, and it decides whether a permanent
  // DOI may be minted unattributed, so it gets an assertion of its own rather
  // than only being observed through two routes.
  test("a researcher deposit requires a name", () => {
    expect(requiresUploaderName({ source: "nemar", is_exemplar: 0 })).toBe(true);
    expect(requiresUploaderName({ source: null, is_exemplar: null })).toBe(true);
  });

  test("an OpenNeuro import does not", () => {
    expect(requiresUploaderName({ source: "openneuro", is_exemplar: 0 })).toBe(false);
  });

  test("an exemplar does not, whatever its source", () => {
    expect(requiresUploaderName({ source: "nemar", is_exemplar: 1 })).toBe(false);
    expect(requiresUploaderName({ source: "openneuro", is_exemplar: 1 })).toBe(false);
  });
});

describe("POST /admin/publish/:id/approve name precondition", () => {
  // The identifier screen gate (epic #1610 phase 4) runs before the name gate,
  // so each request carries a clean screen of the commit this stand-in reports
  // as `main`, and the gate's one read needs a credential. Every other GitHub
  // call answers 404, which the steps after the name gate fail on, as the
  // missing token did before.
  let github: Server;
  beforeEach(async () => {
    await seedAdmin();
    github = Bun.serve({
      port: 0,
      fetch: (req) => mainRefAnswer(req) ?? new Response("not found", { status: 404 }),
    });
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
      `http://127.0.0.1:${github.port}`;
    extraEnv = { GITHUB_ADMIN_PAT: "ghp_realname_test" } as Partial<Bindings>;
  });

  afterEach(() => {
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
    github.stop(true);
    extraEnv = {};
  });

  function seedRequest() {
    db.query(
      "INSERT INTO publication_requests (dataset_id, requested_by, status) VALUES (?, ?, 'requested')",
    ).run(DATASET_ID, ownerId);
    markDatasetScreensClean(db, DATASET_ID);
  }

  /**
   * Past the screen gate AND the name gate, the run starts its first step,
   * `ci_check`, which fails on the stand-in's 404 for the repository. Only a run
   * that got through both gates produces this answer: a refusal by either is a
   * 409 or a 422 that names its gate, and never reaches a step.
   */
  async function expectRunReachedFirstStep(res: Response): Promise<void> {
    expect(res.status).toBe(500);
    expect(((await res.json()) as { step?: string }).step).toBe("ci_check");
    const row = db
      .query<{ current_step: string | null }, [string]>(
        "SELECT current_step FROM publication_requests WHERE dataset_id = ?",
      )
      .get(DATASET_ID);
    expect(row?.current_step).toBe("ci_check");
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

  test("the walk-back also ends a web run's claim, so the re-requested row is not 'running' (ADR 0080)", async () => {
    // A web approval claims the request (`approval_requested_by`,
    // `approval_dispatched_at`) and dispatches a run. This gate ends that run, so
    // the claim must go with it: left on the blocked row, it reads as live for
    // the rest of the 15 minute lease once the owner re-requests, showing
    // "running" with nothing running.
    await seedOwner({ given: null });
    seedDataset();
    seedRequest();
    db.run(
      "UPDATE publication_requests SET approval_requested_by = ?, approval_dispatched_at = datetime('now') WHERE dataset_id = ?",
      [ownerId, DATASET_ID],
    );

    const res = await post(`/admin/publish/${DATASET_ID}/approve`, ADMIN_KEY, {});
    expect(res.status).toBe(422);

    const row = db
      .query<
        {
          status: string;
          approval_requested_by: number | null;
          approval_dispatched_at: string | null;
        },
        [string]
      >(
        "SELECT status, approval_requested_by, approval_dispatched_at FROM publication_requests WHERE dataset_id = ?",
      )
      .get(DATASET_ID);
    expect(row?.status).toBe("blocked");
    expect(row?.approval_requested_by).toBeNull();
    expect(row?.approval_dispatched_at).toBeNull();
  });

  test("an OpenNeuro import is exempt from the approve gate", async () => {
    await seedOwner({ given: null, family: null });
    seedDataset({ source: "openneuro" });
    seedRequest();

    const res = await post(`/admin/publish/${DATASET_ID}/approve`, ADMIN_KEY, {});
    await expectRunReachedFirstStep(res);
    const row = db
      .query<{ status: string }, [string]>(
        "SELECT status FROM publication_requests WHERE dataset_id = ?",
      )
      .get(DATASET_ID);
    expect(row?.status).toBe("approving");
  });

  test("an exemplar is exempt from the approve gate", async () => {
    await seedOwner({ given: null, family: null });
    seedDataset({ is_exemplar: 1 });
    seedRequest();

    const res = await post(`/admin/publish/${DATASET_ID}/approve`, ADMIN_KEY, {});
    await expectRunReachedFirstStep(res);
  });

  test("a named owner gets past the name gate", async () => {
    await seedOwner();
    seedDataset();
    seedRequest();

    const res = await post(`/admin/publish/${DATASET_ID}/approve`, ADMIN_KEY, {});

    // Not the 422: the run got past the name gate and went on to its first
    // step, whose GitHub calls the stand-in answers 404. What matters is that
    // the request row was NOT walked back to blocked.
    await expectRunReachedFirstStep(res);
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

  test("an OpenNeuro import mints without a name", async () => {
    await seedOwner({ given: null, family: null });
    seedDataset({ source: "openneuro" });

    const res = await post(`/admin/datasets/${DATASET_ID}/doi/concept`, ADMIN_KEY, {
      sandbox: true,
    });
    const body = (await res.json()) as { block_reason?: string; error?: string };
    expect(body.block_reason).toBeUndefined();
    // Stops at the enrichment gate, not the name gate.
    expect(body.error).toMatch(/[Mm]etadata pipeline/);
  });

  test("an exemplar mints without a name", async () => {
    await seedOwner({ given: null, family: null });
    seedDataset({ is_exemplar: 1 });

    const res = await post(`/admin/datasets/${DATASET_ID}/doi/concept`, ADMIN_KEY, {
      sandbox: true,
    });
    expect(((await res.json()) as { block_reason?: string }).block_reason).toBeUndefined();
  });

  test("an already-minted dataset reports the no-op, not the name error", async () => {
    // Ordering (review item 23): a nameless owner on a dataset that already
    // has a DOI must hear "it already has one", not be sent to fix a name
    // that would change nothing.
    await seedOwner({ given: null });
    seedDataset();
    db.query("UPDATE datasets SET concept_doi = ? WHERE dataset_id = ?").run(
      "10.82901/NEMAR.NM000281",
      DATASET_ID,
    );

    const res = await post(`/admin/datasets/${DATASET_ID}/doi/concept`, ADMIN_KEY, {
      sandbox: true,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; block_reason?: string };
    expect(body.error).toContain("already has a concept DOI");
    expect(body.block_reason).toBeUndefined();
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
