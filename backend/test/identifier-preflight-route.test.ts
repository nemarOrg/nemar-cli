/**
 * The uploader's identifier preflight, as the Worker takes it in and stores it (epic #1610
 * phase 3, ADR 0087): inside the `datasets.attestation` JSON, through POST /datasets and
 * PUT /datasets/:id/attestation.
 *
 * Real engine: bun:sqlite behind realD1, the real auth middleware with a seeded user and token,
 * the real routes through Hono's app.request(). The POST cases ride the create route's resume
 * branch, whose attestation write runs before the S3 carve-out fails closed (no S3 bindings here,
 * as in attestation-endpoint.test.ts), so what is asserted is the stored row.
 *
 * The door: a record the report contract accepts is stored as it parsed; one it refuses is not
 * stored, never fails the request, and is named by the parser's fixed word, which never quotes
 * the input. Nothing about it is served on the dataset detail route.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { datasetRoutes } from "../src/routes/datasets";
import {
  PREFLIGHT_WITHOUT_ATTESTATION,
  preflightRecording,
  readRecordedPreflight,
  takePreflight,
} from "../src/services/identifier-preflight";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const OWNER_KEY = "preflight-owner-key-0123456789abcdef0123456789ab";
const OTHER_KEY = "preflight-other-key-0123456789abcdef0123456789ab";
const ADMIN_KEY = "preflight-admin-key-0123456789abcdef0123456789ab";
const NAME = "Preflight Fixture Dataset";
const ATTESTATION = { deposit_type: "owner", key_status: "destroyed", deidentified: true };
/** A made-up surname that must never reach the database or a response. */
const HOSTILE = 'Quillfeather O\'Brien "Mary"';

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let ownerId: number;

async function seedUser(username: string, role: string, key: string): Promise<number> {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access, sandbox_completed)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1, 1)`,
  ).run(username, `${username}@example.org`, role);
  const u = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!u) throw new Error("seed: user insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  return u.id;
}

function seedDataset(datasetId: string, visibility = "private"): void {
  db.query(
    `INSERT INTO datasets (dataset_id, name, description, owner_user_id, github_repo, is_sandbox, visibility)
     VALUES (?, ?, NULL, ?, 'nemarDatasets/fixture', 1, ?)`,
  ).run(datasetId, NAME, ownerId, visibility);
}

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
}

function call(method: string, path: string, key: string, body?: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method,
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

function storedAttestation(datasetId: string): string | null {
  return (
    db
      .query<{ attestation: string | null }, [string]>(
        "SELECT attestation FROM datasets WHERE dataset_id = ?",
      )
      .get(datasetId)?.attestation ?? null
  );
}

/** A preflight in the shape the CLI sends: a recording format the scanner cannot read, acknowledged. */
function preflight(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    scanner: "nemar-cli@0.10.13-dev1",
    scan: {
      scanned_at: "2026-10-06T12:00:00.000Z",
      status: "not-screened",
      incomplete: false,
      incomplete_reasons: [],
      files: { total: 5, edf_bdf: 0, header_read: 0, header_read_failed: 0 },
      findings_by_kind: {},
      edf_bdf_files_flagged: 0,
      unscreened_formats: { ".vhdr": 1, ".eeg": 1 },
      read_failures: {},
    },
    acknowledged_via: "flag",
    ...over,
  };
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
  ownerId = await seedUser("preflighter", "member", OWNER_KEY);
  await seedUser("bystander", "member", OTHER_KEY);
  await seedUser("curator", "admin", ADMIN_KEY);
});

describe("POST /datasets stores the preflight inside the attestation", () => {
  test("a record the contract accepts is stored as it parsed, and reads back", async () => {
    seedDataset("xx090101");
    const res = await call("POST", "/datasets", OWNER_KEY, {
      name: NAME,
      sandbox: true,
      attestation: ATTESTATION,
      identifier_preflight: preflight(),
    });
    expect(res.status).toBe(500); // the S3 carve-out, after the write under test
    const raw = storedAttestation("xx090101");
    const doc = JSON.parse(raw ?? "null");
    expect(doc.deposit_type).toBe("owner");
    expect(doc.identifier_preflight).toEqual(preflight());
    expect(readRecordedPreflight(raw)).toEqual({ state: "recorded", preflight: preflight() });
  });

  test("a fresh create's claim INSERT carries it too (no dedup row to resume)", async () => {
    // No dataset to resume, so the route allocates an id and claims it with an INSERT that
    // carries the attestation. With no GitHub credential bound, the next line (the token read)
    // throws and the request fails with the claimed row still in place, which is what makes
    // the INSERT observable here; if that path ever learns to clean up after itself, this test
    // needs another window onto the INSERT, not deleting.
    const res = await call("POST", "/datasets", OWNER_KEY, {
      name: NAME,
      sandbox: true,
      attestation: ATTESTATION,
      identifier_preflight: preflight(),
    });
    expect(res.status).toBe(500);
    const row = db
      .query<{ dataset_id: string; attestation: string | null }, []>(
        "SELECT dataset_id, attestation FROM datasets",
      )
      .all();
    expect(row).toHaveLength(1);
    expect(readRecordedPreflight(row[0]?.attestation)).toEqual({
      state: "recorded",
      preflight: preflight(),
    });
  });

  test("a record the contract refuses is not stored, and the attestation still is", async () => {
    seedDataset("xx090102");
    const hostile = preflight({ note: HOSTILE });
    const res = await call("POST", "/datasets", OWNER_KEY, {
      name: NAME,
      sandbox: true,
      attestation: ATTESTATION,
      identifier_preflight: hostile,
    });
    // Not a 400: a bookkeeping field never fails the create.
    expect(res.status).toBe(500);
    const raw = storedAttestation("xx090102") ?? "";
    expect(JSON.parse(raw).deposit_type).toBe("owner");
    expect("identifier_preflight" in JSON.parse(raw)).toBe(false);
    expect(raw).not.toContain("Quillfeather");
    expect(readRecordedPreflight(raw)).toEqual({ state: "absent" });
  });

  test("a preflight without an attestation has nowhere to go", async () => {
    seedDataset("xx090103");
    await call("POST", "/datasets", OWNER_KEY, {
      name: NAME,
      sandbox: true,
      identifier_preflight: preflight(),
    });
    expect(storedAttestation("xx090103")).toBeNull();
  });
});

describe("PUT /datasets/:id/attestation records both on a resumed upload", () => {
  test("the owner records the attestation and the preflight", async () => {
    seedDataset("xx090111");
    const res = await call("PUT", "/datasets/xx090111/attestation", OWNER_KEY, {
      attestation: ATTESTATION,
      identifier_preflight: preflight(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true, identifier_preflight_recorded: true });
    const raw = storedAttestation("xx090111");
    expect(JSON.parse(raw ?? "null").key_status).toBe("destroyed");
    expect(readRecordedPreflight(raw)).toEqual({ state: "recorded", preflight: preflight() });
  });

  test("a refused record is named by a fixed word, never quoted, and not stored", async () => {
    seedDataset("xx090112");
    const res = await call("PUT", "/datasets/xx090112/attestation", OWNER_KEY, {
      attestation: ATTESTATION,
      identifier_preflight: preflight({ scanner: `nemar-cli@1.0.0 ${HOSTILE}` }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      recorded: true,
      identifier_preflight_recorded: false,
      identifier_preflight_refused: "preflight-scanner",
    });
    for (const part of ["Quillfeather", "Brien", "Mary"]) expect(text).not.toContain(part);
    expect(readRecordedPreflight(storedAttestation("xx090112"))).toEqual({ state: "absent" });
  });

  test("an acknowledgment the verdict does not need is refused at the door", async () => {
    seedDataset("xx090113");
    const clean = preflight({
      scan: {
        ...(preflight().scan as Record<string, unknown>),
        status: "no-recordings",
        unscreened_formats: {},
      },
    });
    const res = await call("PUT", "/datasets/xx090113/attestation", OWNER_KEY, {
      attestation: ATTESTATION,
      identifier_preflight: clean,
    });
    expect((await res.json()).identifier_preflight_refused).toBe("preflight-ack");
  });

  test("an attestation with no preflight is recorded, and says none was", async () => {
    seedDataset("xx090114");
    const res = await call("PUT", "/datasets/xx090114/attestation", OWNER_KEY, {
      attestation: ATTESTATION,
    });
    expect(await res.json()).toEqual({ recorded: true, identifier_preflight_recorded: false });
  });

  test("only the owner or an admin", async () => {
    seedDataset("xx090115");
    const body = { attestation: ATTESTATION, identifier_preflight: preflight() };
    expect((await call("PUT", "/datasets/xx090115/attestation", OTHER_KEY, body)).status).toBe(403);
    expect(storedAttestation("xx090115")).toBeNull();
    expect((await call("PUT", "/datasets/xx090115/attestation", ADMIN_KEY, body)).status).toBe(200);
  });

  test("never on a dataset that is public or was ever published", async () => {
    const body = { attestation: ATTESTATION, identifier_preflight: preflight() };
    seedDataset("xx090116", "public");
    expect((await call("PUT", "/datasets/xx090116/attestation", OWNER_KEY, body)).status).toBe(409);
    seedDataset("xx090117");
    db.query("UPDATE datasets SET first_published_at = datetime('now') WHERE dataset_id = ?").run(
      "xx090117",
    );
    expect((await call("PUT", "/datasets/xx090117/attestation", OWNER_KEY, body)).status).toBe(409);
    expect(storedAttestation("xx090116")).toBeNull();
    expect(storedAttestation("xx090117")).toBeNull();
    expect((await call("PUT", "/datasets/xx090199/attestation", OWNER_KEY, body)).status).toBe(404);
  });

  test("the attestation itself is validated as on create", async () => {
    seedDataset("xx090118");
    const res = await call("PUT", "/datasets/xx090118/attestation", OWNER_KEY, {
      attestation: { ...ATTESTATION, deidentified: false },
      identifier_preflight: preflight(),
    });
    expect(res.status).toBe(400);
    expect(storedAttestation("xx090118")).toBeNull();
  });
});

describe("the stored preflight is not served", () => {
  test("the dataset detail route serves the attestation fields and nothing of the preflight", async () => {
    seedDataset("xx090121");
    await call("PUT", "/datasets/xx090121/attestation", OWNER_KEY, {
      attestation: ATTESTATION,
      identifier_preflight: preflight(),
    });
    const res = await call("GET", "/datasets/xx090121", OWNER_KEY);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).dataset.attestation_deposit_type).toBe("owner");
    for (const part of ["identifier_preflight", "unscreened_formats", "not-screened", ".vhdr"]) {
      expect(text).not.toContain(part);
    }
  });
});

describe("readRecordedPreflight: absent and unreadable are never clean", () => {
  test("each stored shape reads as what it is", () => {
    expect(readRecordedPreflight(null)).toEqual({ state: "absent" });
    expect(readRecordedPreflight(JSON.stringify(ATTESTATION))).toEqual({ state: "absent" });
    expect(readRecordedPreflight("not json")).toEqual({ state: "unreadable" });
    expect(readRecordedPreflight("[1]")).toEqual({ state: "unreadable" });
    expect(
      readRecordedPreflight(
        JSON.stringify({ ...ATTESTATION, identifier_preflight: preflight({ version: 2 }) }),
      ),
    ).toEqual({ state: "unreadable" });
    expect(
      readRecordedPreflight(JSON.stringify({ ...ATTESTATION, identifier_preflight: preflight() })),
    ).toEqual({ state: "recorded", preflight: preflight() });
  });
});

describe("takePreflight", () => {
  test("none sent, sent without an attestation, refused, and accepted", () => {
    expect(takePreflight(undefined, true)).toEqual({ preflight: null, refused: null });
    expect(takePreflight(preflight(), false)).toEqual({
      preflight: null,
      refused: PREFLIGHT_WITHOUT_ATTESTATION,
    });
    expect(takePreflight(preflight({ version: 9 }), true)).toEqual({
      preflight: null,
      refused: "preflight-version",
    });
    expect(takePreflight(preflight(), true)).toEqual({ preflight: preflight(), refused: null });
  });
});

describe("preflightRecording", () => {
  test("recorded only when a parsed record was stored; a refusal is named", () => {
    const accepted = takePreflight(preflight(), true);
    expect(preflightRecording(accepted, true)).toEqual({ identifier_preflight_recorded: true });
    // The write that would have carried it failed: not recorded, whatever parsed.
    expect(preflightRecording(accepted, false)).toEqual({ identifier_preflight_recorded: false });
    const refused = takePreflight(preflight({ version: 9 }), true);
    expect(preflightRecording(refused, true)).toEqual({
      identifier_preflight_recorded: false,
      identifier_preflight_refused: "preflight-version",
    });
  });
});
