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
 * NOTE (#898 foundation): the Zod checks are HARD asserts. The FULL neuroschema
 * JSON-Schema conformance check on the data-plane metadata is WARN-only here
 * because current rows may still carry known drift; phase 4 (#899) fixes the
 * drift and flips it to a hard assert.
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

d("live wire contract", () => {
  test("GET /datasets matches the list envelope", async () => {
    const { status, body } = await getJson("/datasets?limit=5");
    expect(status).toBe(200);
    const r = datasetListEnvelopeSchema.safeParse(body);
    if (!r.success)
      throw new Error(`/datasets drift: ${JSON.stringify(r.error.issues.slice(0, 6))}`);
    expect(r.success).toBe(true);

    // #899: the WIRE value must already be the canonical vX.Y.Z tag, not merely
    // tag-shaped after the schema's coercion. Assert the RAW value (pre-coercion)
    // with the non-coercing strict schema so a dropped withCanonicalLatestVersion
    // call site fails here. (The envelope schema above coerces, so it can't.)
    const rawRows = (body as { datasets?: Array<{ latest_version?: unknown }> }).datasets ?? [];
    for (const row of rawRows) {
      if (typeof row.latest_version === "string" && row.latest_version) {
        expect(strictVersionTagSchema.safeParse(row.latest_version).success).toBe(true);
      }
    }
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

  test("data-plane metadata conforms to the neuroschema dataset shape (warn-only)", async () => {
    const { status, body } = await getJson(`/data/${TEST_DATASET}/metadata.json`);
    if (status === 404) return; // not published; skip
    expect(status).toBe(200);
    // WARN-only in #898: an un-classified dataset can legitimately still carry
    // known drift (e.g. recording_modality: [] before modality classification),
    // which the canonical schema rejects by design. Phase 4 (#899) fixes the
    // drift and flips BOTH checks to hard asserts. We assert only that the
    // response is a JSON object here; the shape gaps are surfaced as warnings.
    expect(typeof body).toBe("object");
    const r = neuroschemaDatasetSchema.safeParse(body);
    if (!r.success) {
      console.warn(
        `[contract] neuroschema envelope gaps (fix in #899): ${JSON.stringify(r.error.issues.slice(0, 6))}`,
      );
    }
    const validate = compileNeuroschemaDatasetValidator();
    if (!validate(body)) {
      console.warn(
        `[contract] neuroschema conformance gaps (fix in #899): ${formatAjvErrors(validate)}`,
      );
    }
  });
});
