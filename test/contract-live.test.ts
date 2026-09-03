/**
 * Live wire-contract drift guard (epic #896, #898).
 *
 * Fetches real responses from a deployed backend (TEST_API_URL) and validates
 * them against the shared Zod contract + the vendored neuroschema bundle, so a
 * silent shape drift (the getCurrentUser / file_size / latest_version class of
 * bug) fails CI loudly instead of shipping.
 *
 * Integration tier (hits the live dev backend). Skips when TEST_API_URL is
 * unset, and guards against pointing at prod unless TEST_ALLOW_PROD=1.
 *
 * NOTE: every Zod check here is a HARD assert, including the two that were
 * warn-only while the shapes they describe were still in flight (#937 item 4):
 * the canonical vX.Y.Z `latest_version` on the catalog, and the neuroschema
 * envelope on the data-plane metadata. Both were measured clean against the
 * deployed dev backend before being flipped.
 *
 * The one remaining WARN-only check is FULL neuroschema JSON-Schema
 * conformance on the data-plane metadata, which has live failures with three
 * concrete causes in the served data (publish_date format, signal_defaults
 * type, bare ORCIDs against format: uri). Those are tracked in #1247; flip it
 * when that closes.
 */

import { describe, expect, test } from "bun:test";
import "./setup";
import {
  datasetDetailEnvelopeSchema,
  datasetListEnvelopeSchema,
  datasetSearchEnvelopeSchema,
  neuroschemaDatasetSchema,
  strictVersionTagSchema,
  userMeResponseSchema,
} from "../shared/contract/index.js";
import { getCurrentUser } from "../src/lib/api/auth.js";
import { setConfig } from "../src/lib/config.js";
import {
  compileNeuroschemaDatasetValidator,
  formatAjvErrors,
} from "./contract/neuroschema-validator.js";
import { TEST_CONFIG } from "./setup";

const API = TEST_CONFIG.apiUrl;
const TEST_DATASET = process.env.TEST_DATA_DATASET ?? "nm099999";
const headers: Record<string, string> = TEST_CONFIG.bypassToken
  ? { "X-Test-Bypass": TEST_CONFIG.bypassToken }
  : {};
const POINTS_AT_PROD = API.includes("api.nemar.org") || API.includes("data.nemar.org");
const ACTIVE = !!process.env.TEST_API_URL && !(POINTS_AT_PROD && !process.env.TEST_ALLOW_PROD);
const d = ACTIVE ? describe : describe.skip;

async function getJson(path: string, auth?: string): Promise<{ status: number; body: unknown }> {
  const h = { ...headers, ...(auth ? { Authorization: `Bearer ${auth}` } : {}) };
  const res = await fetch(`${API}${path}`, { headers: h });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

/**
 * A dataset whose `metadata.json` the DEPLOYED backend actually serves.
 *
 * `TEST_DATASET` (nm099999 by default) is the E2E fixture, created on demand
 * and torn down, so its data plane is usually absent: measured on
 * api-test.nemar.org, `/data/nm099999/metadata.json` is a 404 while the
 * exemplar fleet serves 200. The data-plane check below used to skip silently
 * on that 404, which meant it validated nothing at all in CI and would have
 * kept reporting success however far the served shape drifted (#937 item 4).
 *
 * Resolution order: an explicit `TEST_DATA_DATASET`, else the first id the
 * anonymous catalog returns (anonymous callers only ever see public rows, so
 * this cannot pick something unreadable), else `TEST_DATASET` so the caller
 * still gets the old behaviour rather than an exception.
 */
async function resolveDataPlaneDataset(): Promise<string> {
  if (process.env.TEST_DATA_DATASET) return process.env.TEST_DATA_DATASET;
  const { status, body } = await getJson("/datasets?limit=1");
  if (status === 200) {
    const first = (body as { datasets?: Array<{ dataset_id?: unknown }> }).datasets?.[0]?.dataset_id;
    if (typeof first === "string" && first) return first;
  }
  return TEST_DATASET;
}

d("live wire contract", () => {
  test("GET /datasets matches the list envelope", async () => {
    const { status, body } = await getJson("/datasets?limit=5");
    expect(status).toBe(200);
    const r = datasetListEnvelopeSchema.safeParse(body);
    if (!r.success)
      throw new Error(`/datasets drift: ${JSON.stringify(r.error.issues.slice(0, 6))}`);
    expect(r.success).toBe(true);

    // #899: the WIRE value should be the canonical vX.Y.Z tag, not merely
    // tag-shaped after the schema's coercion. Check the RAW value (pre-coercion)
    // with the non-coercing strict schema.
    //
    // HARD assert since #937 item 4. It was warn-only while #899 was in flight,
    // because the deployed dev backend still served bare "1.0.0" and a hard
    // assert would have redded integration-dev during the very PR that shipped
    // the fix. That deploy has long since landed: measured against
    // api-test.nemar.org on 2026-09-03, all 7 catalog rows serve canonical
    // vX.Y.Z and none are bare. So the warn had nothing left to report and was
    // only costing us the next regression.
    const rawRows = (body as { datasets?: Array<{ latest_version?: unknown }> }).datasets ?? [];
    const bareVersions = rawRows
      .map((r) => r.latest_version)
      .filter((v): v is string => typeof v === "string" && !!v)
      .filter((v) => !strictVersionTagSchema.safeParse(v).success);
    expect(bareVersions).toEqual([]);
  });

  test("GET /datasets/:id matches the detail envelope (list/search parity)", async () => {
    const { status, body } = await getJson(`/datasets/${TEST_DATASET}`);
    if (status === 404) return; // test dataset not present; skip gracefully
    expect(status).toBe(200);
    const r = datasetDetailEnvelopeSchema.safeParse(body);
    if (!r.success)
      throw new Error(`/datasets/:id drift: ${JSON.stringify(r.error.issues.slice(0, 6))}`);
    expect(r.success).toBe(true);
  });

  test("GET /datasets/search matches the search envelope", async () => {
    const { status, body } = await getJson("/datasets/search?q=eeg&limit=5");
    expect(status).toBe(200);
    const r = datasetSearchEnvelopeSchema.safeParse(body);
    if (!r.success)
      throw new Error(`/datasets/search drift: ${JSON.stringify(r.error.issues.slice(0, 6))}`);
    expect(r.success).toBe(true);
  });

  test("getCurrentUser() unwraps the envelope to a flat user (#899)", async () => {
    if (!TEST_CONFIG.adminApiKey) return; // no key configured; skip
    // setup.ts isolates NEMAR_CONFIG_DIR to a temp dir, so writing the key here
    // does not touch the developer's real config.
    setConfig("apiKey", TEST_CONFIG.adminApiKey);
    const user = await getCurrentUser();
    // Flat field access must work — the bug returned the {user,token} envelope,
    // so these reads were all undefined at runtime.
    expect(typeof user.email).toBe("string");
    expect(user.role).toBeTruthy();
    // And it must be the unwrapped user, not the nested envelope.
    expect("user" in (user as Record<string, unknown>)).toBe(false);
  });

  test("GET /users/me matches the {user, token} envelope", async () => {
    if (!TEST_CONFIG.adminApiKey) return; // no key configured; skip
    const { status, body } = await getJson("/users/me", TEST_CONFIG.adminApiKey);
    expect(status).toBe(200);
    const r = userMeResponseSchema.safeParse(body);
    if (!r.success)
      throw new Error(`/users/me drift: ${JSON.stringify(r.error.issues.slice(0, 6))}`);
    expect(r.success).toBe(true);
  });

  test("data-plane metadata matches the neuroschema envelope", async () => {
    const dataset = await resolveDataPlaneDataset();
    const { status, body } = await getJson(`/data/${dataset}/metadata.json`);
    // A 404 is no longer a silent pass: if the resolver could not find a
    // dataset with a served data plane, say so, because that is the state in
    // which this test proves nothing (#937 item 4).
    if (status === 404) {
      throw new Error(
        `no served data plane to validate: /data/${dataset}/metadata.json is 404 on ${API}. ` +
          "Set TEST_DATA_DATASET to a dataset whose metadata.json is published.",
      );
    }
    expect(status).toBe(200);
    expect(typeof body).toBe("object");

    // HARD assert since #937 item 4: the Zod envelope passes against every
    // dataset the deployed dev backend serves (measured 2026-09-03 on
    // api-test.nemar.org across xx099900/901/903/905), so a failure here is a
    // real regression rather than known drift.
    const r = neuroschemaDatasetSchema.safeParse(body);
    if (!r.success)
      throw new Error(
        `data-plane metadata drift: ${JSON.stringify(r.error.issues.slice(0, 6))}`,
      );
    expect(r.success).toBe(true);

    // Still WARN-only: the FULL JSON-Schema conformance check. Unlike the
    // envelope above, this one has live failures with concrete causes, all of
    // them in the served data rather than in this test -- publish_date is not
    // RFC 3339 date-time, signal_defaults is not always an object, and ORCIDs
    // are served bare where neuroschema declares format: uri. Those are
    // tracked in #1247; flip this to a hard assert when it closes. Kept as a
    // warning rather than deleted so the drift stays visible in CI logs.
    const validate = compileNeuroschemaDatasetValidator();
    if (!validate(body)) {
      console.warn(
        `[contract] neuroschema conformance gaps for ${dataset} (tracked in #1247): ${formatAjvErrors(validate)}`,
      );
    }
  });
});
