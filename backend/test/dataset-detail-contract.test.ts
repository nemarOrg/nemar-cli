/**
 * Wire-contract coverage for the fields that stopped being stored columns in
 * #1182 (migration 0071) and are now derived at read time: the six flat
 * attestation_* fields (exploded from the JSON `attestation` column),
 * `num_citations` (sum of the two stored addends), and `file_size_formatted`
 * (formatFileSize over file_size — binary/1024, NOT services/s3.ts's decimal
 * formatBytes).
 *
 * Entry point, not helpers (per .rules/testing.md): the dataset is created
 * THROUGH the real POST /datasets route (resume branch — its attestation
 * write lands before the request fails closed at the S3 carve-out, same
 * no-mocks pattern as attestation-endpoint.test.ts), and the assertions read
 * the real GET /datasets/:id and GET /datasets responses, parsed with the
 * shared contract schemas.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  catalogItemSchema,
  datasetDetailEnvelopeSchema,
  datasetListEnvelopeSchema,
} from "../../shared/contract/dataset";
import { datasetRoutes } from "../src/routes/datasets";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const USER_KEY = "detail-user-key-0123456789abcdef0123456789abcdef";
const DATASET_ID = "xx090042";
const DATASET_NAME = "Detail Contract Fixture";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let userId: number;

async function seedUser(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access, sandbox_completed)
     VALUES ('detailer', 'detailer@example.org', 'x', 'approved', 'member', 1, 1, 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='detailer'").get();
  if (!u) throw new Error("seed: user insert failed");
  userId = u.id;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(USER_KEY),
    USER_KEY.slice(0, 8),
  );
}

function env(): Bindings {
  // No S3/GitHub bindings: the resume branch persists the attestation and
  // manifest seed, then fails closed at the S3 carve-out (unchanged
  // fail-closed behavior; the 500 is expected below).
  return { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${USER_KEY}`,
    "Content-Type": "application/json",
    "X-CLI-Version": "99.0.0",
  };
}

/** Create the dataset through the real route (resume branch). */
async function createThroughRoute(): Promise<void> {
  // Incomplete row so POST /datasets takes the resume branch.
  db.query(
    `INSERT INTO datasets (dataset_id, name, description, owner_user_id, github_repo, is_sandbox, visibility)
     VALUES (?, ?, NULL, ?, 'nemarDatasets/fixture', 1, 'private')`,
  ).run(DATASET_ID, DATASET_NAME, userId);
  const res = await app.request(
    "/datasets",
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        name: DATASET_NAME,
        sandbox: true,
        attestation: {
          deposit_type: "redistribution",
          key_status: "retained",
          deidentified: true,
          no_duplicate: true,
          upstream_source: "https://openneuro.org/datasets/ds000123",
        },
        // 700000 + 150000 + 500 = 850500 bytes, 2 subjects (manifest seed).
        files: [
          { path: "sub-001/eeg/a.set", size: 700_000, type: "data" },
          { path: "sub-002/eeg/b.set", size: 150_000, type: "data" },
          { path: "dataset_description.json", size: 500, type: "metadata" },
        ],
      }),
    },
    env(),
  );
  expect(res.status).toBe(500); // fails closed at S3 AFTER the writes we need
  // Citation addends are sweep-written in production; arrange them directly
  // so the served num_citations must be their sum, not either addend alone.
  db.query(
    "UPDATE datasets SET num_dataset_citations = 3, num_datapaper_citations = 4 WHERE dataset_id = ?",
  ).run(DATASET_ID);
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
  await seedUser();
  await createThroughRoute();
});

describe("GET /datasets/:id detail contract", () => {
  test("serves the six attestation fields, num_citations, and file_size_formatted with contract types", async () => {
    const res = await app.request(`/datasets/${DATASET_ID}`, { headers: authHeaders() }, env());
    expect(res.status).toBe(200);
    const raw = (await res.json()) as { dataset: Record<string, unknown> };
    // Pre-existing contract quirk, out of scope for #1182: the schema's
    // optional `id: string` describes the LIST branch's `dataset_id AS id`
    // alias, but the detail's `d.*` passes through the raw INTEGER primary
    // key (it did before the rebuild too). Drop the optional key rather
    // than teach the schema a union here.
    const { id: _rawIntegerId, ...detailWire } = raw.dataset;
    const body = datasetDetailEnvelopeSchema.parse({ ...raw, dataset: detailWire });
    const d = body.dataset;

    // Field-exact attestation, exploded from the stored JSON. Assert VALUES,
    // not just presence: the optional contract fields would also parse if
    // the explode were dropped entirely.
    expect(d.attestation_deposit_type).toBe("redistribution");
    expect(d.attestation_key_status).toBe("retained");
    expect(d.attestation_deidentified).toBe(1);
    expect(d.attestation_no_duplicate).toBe(1);
    expect(d.attestation_upstream_source).toBe("https://openneuro.org/datasets/ds000123");
    expect(d.attestation_accepted_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // The raw JSON column does not leak alongside the flat fields.
    expect("attestation" in d).toBe(false);

    // Sum of the two addends, not either one alone.
    expect(d.num_citations).toBe(7);

    // Binary formatting: 850500 bytes -> "831 KB" (formatFileSize). The
    // decimal formatBytes would say "850.5 KB" — this literal is the tripwire
    // against swapping formatters.
    expect(d.file_size_formatted).toBe("831 KB");
  });
});

describe("GET /datasets list contract", () => {
  test("?mine=true rows carry the derived num_citations and file_size_formatted", async () => {
    const res = await app.request("/datasets?mine=true", { headers: authHeaders() }, env());
    expect(res.status).toBe(200);
    const body = datasetListEnvelopeSchema.parse(await res.json());
    const row = body.datasets.find((r) => r.dataset_id === DATASET_ID);
    expect(row).toBeDefined();
    const item = catalogItemSchema.parse(row);
    expect(item.num_citations).toBe(7);
    expect(item.file_size_formatted).toBe("831 KB");
  });

  test("the public branch serves the same derived values", async () => {
    // Arrange the row into public-catalog visibility; the route reads state
    // from D1 and the public branch has its own projection to cover.
    db.query("UPDATE datasets SET visibility = 'public', is_sandbox = 0 WHERE dataset_id = ?").run(
      DATASET_ID,
    );
    const res = await app.request("/datasets", {}, env());
    expect(res.status).toBe(200);
    const body = datasetListEnvelopeSchema.parse(await res.json());
    const row = body.datasets.find((r) => r.dataset_id === DATASET_ID);
    expect(row).toBeDefined();
    const item = catalogItemSchema.parse(row);
    expect(item.num_citations).toBe(7);
    expect(item.file_size_formatted).toBe("831 KB");
  });
});
