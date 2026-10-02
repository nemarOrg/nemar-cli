/**
 * A hand-written mutation battery for the Neurobagel writer (epic #1586, phase 4; ADR 0084).
 *
 *   bun run scripts/neurobagel/writer-mutation-battery.ts             # every mutant
 *   bun run scripts/neurobagel/writer-mutation-battery.ts predicate   # one layer
 *   bun run scripts/neurobagel/writer-mutation-battery.ts --check-anchors
 *
 * Each mutant makes ONE plausible mistake in the eligibility predicate, the two anonymity
 * guards, removal, write order, the index, the read route's authentication and its re-check,
 * the hooks or the cron fence.
 * The tests that exist for the area are then run against it, and the mutant is KILLED if any
 * fails and has SURVIVED if none does.
 * A mutant that survives its own layer's tests is run once more against every Neurobagel
 * writer test, so the report can say whether the guard exists somewhere else or not at all.
 * A survivor is either a test that is missing or a mutant that changes nothing observable;
 * `equivalent` below says which one the author believes, and why.
 *
 * The script edits a source file in place and restores it in `finally`.
 * Run it on a clean tree, alone: it is not part of the test suite.
 * A mutant whose anchor text is not found exactly as often as declared is an ERROR, never a
 * pass, so a refactor that moves the code cannot turn a mutant into a no-op unnoticed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");

type Layer =
  | "predicate"
  | "guards"
  | "removal"
  | "order"
  | "index"
  | "auth"
  | "route"
  | "hooks"
  | "admin";

interface Mutant {
  id: string;
  layer: Layer;
  file: string;
  find: string;
  count?: number;
  replace: string;
  note: string;
  /** The test files that should kill it (default: the whole writer suite). */
  tests?: string[];
  /** Set when the mutant changes nothing observable; the reason. */
  equivalent?: string;
}

const SVC = "backend/src/services";
const ROUTES = "backend/src/routes";
const T = "backend/test";

const ALL_TESTS = [
  `${T}/neurobagel-eligibility.test.ts`,
  `${T}/neurobagel-writer.test.ts`,
  `${T}/neurobagel-curation.test.ts`,
  `${T}/neurobagel-read-route.test.ts`,
  `${T}/neurobagel-admin-routes.test.ts`,
  `${T}/neurobagel-hooks.test.ts`,
  `${T}/neurobagel-source-scan.test.ts`,
  `${T}/neurobagel-host-routing.test.ts`,
  `${T}/neurobagel-route-inventory.test.ts`,
  `${T}/rate-limit-buckets.test.ts`,
  `${T}/cron-sweep-wiring.test.ts`,
  "test/admin-neurobagel-cli.test.ts",
];

const ELIGIBILITY = `${SVC}/neurobagel-eligibility.ts`;
const WRITER = `${SVC}/neurobagel-writer.ts`;
const HOOKS = `${SVC}/neurobagel-hooks.ts`;
const GATHER = `${SVC}/neurobagel-gather.ts`;
const STORE = `${SVC}/neurobagel-store.ts`;
const PLAN = `${SVC}/neurobagel-plan.ts`;
const FINGERPRINT = `${SVC}/neurobagel-fingerprint.ts`;
const ROUTE = `${ROUTES}/neurobagel.ts`;
const ADMIN = `${ROUTES}/admin/neurobagel.ts`;

export const MUTANTS: Mutant[] = [
  // The predicate: each term in SQL and in TypeScript.
  {
    id: "P01-active-sql",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `sql: "d.status = 'active'",`,
    replace: `sql: "1 = 1",`,
    note: "an archived or deleted row is selected",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P02-active-ts",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `holds: (row) => row.status === "active",`,
    replace: "holds: () => true,",
    note: "the re-check lets an archived row through",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P03-public-sql",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `sql: "d.visibility = 'public'",`,
    replace: `sql: "d.visibility IS NOT NULL",`,
    note: "a private dataset is selected",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P04-public-ts",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `holds: (row) => row.visibility === "public",`,
    replace: "holds: () => true,",
    note: "the re-check lets a private row through",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P05-anonymous-sql-null-is-false",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `sql: "d.anonymous = 0",`,
    replace: `sql: "COALESCE(d.anonymous, 0) = 0",`,
    note: "an unknown anonymous value reads as not anonymous",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
    equivalent:
      "datasets.anonymous is NOT NULL, so no row can carry an unknown value and both forms select the same rows; the TypeScript form (P07) is the one that can see it",
  },
  {
    id: "P06-anonymous-sql-dropped",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `sql: "d.anonymous = 0",`,
    replace: `sql: "1 = 1",`,
    note: "the anonymous term is gone (the schema triggers are then the only guard)",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P07-anonymous-ts-null-is-false",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "holds: (row) => row.anonymous === 0,",
    replace: "holds: (row) => row.anonymous !== 1,",
    note: "the re-check reads an unknown anonymous value as not anonymous",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P08-first-published-sql",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `sql: "d.first_published_at IS NOT NULL",`,
    replace: `sql: "1 = 1",`,
    note: "an unpublished dataset is selected",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P09-first-published-ts",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "holds: (row) => row.first_published_at !== null && row.first_published_at !== undefined,",
    replace: "holds: () => true,",
    note: "the re-check lets an unpublished row through",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P10-withdrawn-sql",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `sql: "d.withdrawn_at IS NULL",`,
    replace: `sql: "1 = 1",`,
    note: "a withdrawn dataset is selected",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P11-withdrawn-ts",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "holds: (row) => row.withdrawn_at === null || row.withdrawn_at === undefined,",
    replace: "holds: () => true,",
    note: "the re-check lets a withdrawn row through",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P12-version-sql",
    layer: "predicate",
    file: ELIGIBILITY,
    find: `    sql: "EXISTS (SELECT 1 FROM dataset_versions dv WHERE dv.dataset_id = d.dataset_id)",`,
    replace: `    sql: "1 = 1",`,
    note: "a dataset with no published version is selected",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P13-version-ts",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "holds: (row) => row.has_version === 1,",
    replace: "holds: () => true,",
    note: "the re-check lets a versionless row through",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P14-ceiling-sql",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "AND d.dataset_id < '${NEUROBAGEL_REAL_NM_CEILING}')",
    replace: "AND d.dataset_id <= '${NEUROBAGEL_REAL_NM_CEILING}')",
    note: "nm099900, the first reserved fixture id, is federated",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P15-ceiling-ts",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "NM_ID.test(row.dataset_id) && row.dataset_id < NEUROBAGEL_REAL_NM_CEILING",
    replace: "NM_ID.test(row.dataset_id)",
    note: "every nm id, the fixtures included, passes the re-check",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P16-on-mirrors-excluded-sql",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "          OR d.dataset_id GLOB '${ON_GLOB}')",
    replace: "          )",
    note: "OpenNeuro mirrors are dropped (the owner decided to include them)",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P17-on-mirrors-excluded-ts",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "        ON_ID.test(row.dataset_id)) &&",
    replace: "        false) &&",
    note: "the re-check drops OpenNeuro mirrors",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P18-xx-ids-admitted-sql",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "          OR d.dataset_id GLOB '${ON_GLOB}')",
    replace: "          OR d.dataset_id GLOB '${ON_GLOB}' OR d.dataset_id GLOB 'xx*')",
    note: "an `xx` id (a sandbox, an exemplar) is selected: the store cannot hold it",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P19-xx-ids-admitted-ts",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "        ON_ID.test(row.dataset_id)) &&",
    replace: "        ON_ID.test(row.dataset_id) || row.dataset_id.startsWith('xx')) &&",
    note: "the re-check admits an `xx` id",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },
  {
    id: "P20-exemplar-fleet-admitted-staging",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "  return ON_ID.test(datasetId);",
    replace: "  return ON_ID.test(datasetId) || /^xx0999\\d{2}$/.test(datasetId);",
    note: "a hook schedules a write for an exemplar id",
    tests: [`${T}/neurobagel-eligibility.test.ts`, `${T}/neurobagel-hooks.test.ts`],
  },
  {
    id: "P21-sandbox-flag-dropped-sql",
    layer: "predicate",
    file: ELIGIBILITY,
    find: "        AND COALESCE(d.is_sandbox, 0) = 0 AND COALESCE(d.is_exemplar, 0) = 0\n",
    replace: "",
    note: "a sandbox or exemplar flag on a real id no longer excludes it",
    tests: [`${T}/neurobagel-eligibility.test.ts`],
  },

  // The two anonymity guards.
  {
    id: "G01-metadata-guard-unknown-is-false",
    layer: "guards",
    file: GATHER,
    find: "if (doc.anonymous !== false) {",
    replace: "if (doc.anonymous === true) {",
    note: "a metadata document with no anonymous value is trusted",
    tests: [`${T}/neurobagel-writer.test.ts`],
    equivalent:
      "the data plane always writes the field, so only the guard's own contract differs; the test reaches it only through a true value",
  },
  {
    id: "G02-metadata-guard-removed",
    layer: "guards",
    file: GATHER,
    find: "if (doc.anonymous !== false) {",
    replace: "if (false) {",
    note: "the second guard is gone: the row is the only line",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "G03-degraded-metadata-accepted",
    layer: "guards",
    file: GATHER,
    find: "doc.extensions?.nemar?.bids_index === null ||",
    replace: "false ||",
    note: "a metadata document built while the manifest was unreadable replaces a good artifact",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "G04-recheck-before-write",
    layer: "guards",
    file: WRITER,
    find: `if (!fresh.eligible) return { id, outcome: "refused", code: "no_longer_eligible" };`,
    replace: "",
    note: "a dataset that stopped being eligible between the plan and the write is written",
    equivalent:
      "the plan and the write read D1 microseconds apart; no test can change a row between them without a hook in the plan query, and removal still follows from the listing",
  },
  {
    id: "G05-transform-backstop-not-anonymity",
    layer: "guards",
    file: WRITER,
    find: `if (err.code === "anonymous_not_false") return refuse(rc, id, "anonymity_disagreement");`,
    replace: "",
    note: "the transform's own refusal is filed as an ordinary refusal",
    equivalent:
      "unreachable: the gather guard refuses first, so the transform never sees a non-false value; the line is a backstop behind a backstop",
  },
  {
    id: "G06-curation-failure-falls-through",
    layer: "guards",
    file: WRITER,
    find: `  if (curation.kind === "failed") {\n    return refuse(rc, id, "curation_unavailable", clip(curation.reason));\n  }`,
    replace: "",
    note: "a failed curation lookup converts the dataset with no entry",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "G07-curation-hash-not-in-fingerprint",
    layer: "guards",
    file: WRITER,
    find: `const curationHash = curation.kind === "entry" ? curation.hash : null;`,
    replace: "const curationHash = null;",
    note: "a changed curation entry does not change the fingerprint",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "G08-stale-manifest-copy-kept",
    layer: "guards",
    file: WRITER,
    find: `if (copyEtag === currentEtag) return "current";`,
    replace: `return "current";`,
    note: "artifacts are built from a manifest copy older than the ETag they are stamped with",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "G09-manifest-etag-not-in-fingerprint",
    layer: "guards",
    file: WRITER,
    find: "fingerprint: await inputFingerprint(rowFp, head.etag),",
    replace: `fingerprint: await inputFingerprint(rowFp, ""),`,
    note: "a manifest rewrite in place is invisible to the fingerprint",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "G10-any-404-is-an-absent-file",
    layer: "guards",
    file: GATHER,
    find: `return body.error === "File not found";`,
    replace: "return true;",
    note: "a manifest the data plane could not read is passed to the transform as an absent table",
    tests: [`${T}/neurobagel-writer.test.ts`],
    equivalent:
      "the data plane answers a different 404 body only when the manifest cannot be read, and then metadata.json is degraded and refused earlier in the same gather",
  },

  // Removal.
  {
    id: "R01-delete-without-index",
    layer: "removal",
    file: WRITER,
    find: "if (index.written || !index.changed) {",
    replace: "if (true) {",
    note: "artifacts are deleted even when the index could not be updated first",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "R02-removal-ignores-scope",
    layer: "removal",
    file: WRITER,
    find: ".filter((id) => !indexable.has(id) && (only === undefined || only.includes(id)))",
    replace: ".filter((id) => !indexable.has(id) && true)",
    note: "a run for one dataset deletes the others' objects",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "R03-ineligible-not-removed",
    layer: "removal",
    file: WRITER,
    find: "const eligibleNow = await eligibleAmong(env.DB, [...fresh.datasets.keys()]);",
    replace: "const eligibleNow = new Set(fresh.datasets.keys());",
    note: "a dataset that stopped being eligible keeps its artifacts and its place in the index",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "R04-anonymity-refusal-not-removed",
    layer: "removal",
    file: WRITER,
    find: "(id) => !rc.anonymityRefused.has(id) && !droppedWhileExamining.has(id),",
    replace: "(id) => !droppedWhileExamining.has(id),",
    note: "a dataset whose data said anonymous keeps what the store held",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "R05-index-not-filtered-by-eligibility",
    layer: "removal",
    file: STORE,
    find: "    if (!eligibleIds.has(id)) continue;\n",
    replace: "",
    note: "the index lists a dataset that left",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "R06-ledger-written-every-run",
    layer: "removal",
    file: PLAN,
    find: "if (sameLabel(ledger.get(datasetId)?.label, label)) return false;",
    replace: "",
    note: "a standing finding is recorded on every run",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },

  // Order and idempotency.
  {
    id: "O01-jsonld-not-last",
    layer: "order",
    file: WRITER,
    find: `    { kind: "dictionary", text: files[names.dictionary] as string },\n    { kind: "description", text: files[names.datasetDescription] as string },\n    { kind: "jsonld", text: files[names.jsonld] as string },`,
    replace: `    { kind: "jsonld", text: files[names.jsonld] as string },\n    { kind: "dictionary", text: files[names.dictionary] as string },\n    { kind: "description", text: files[names.datasetDescription] as string },`,
    note: "the commit marker is written first, so an interrupted run leaves a stamped set that is not whole",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "O02-companions-always-rewritten",
    layer: "order",
    file: WRITER,
    find: `if (kind !== "jsonld" && existing?.sha256 === sha) continue;`,
    replace: "",
    note: "identical companion bytes are written again",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "O03-fingerprint-never-matches",
    layer: "order",
    file: WRITER,
    find: "storedFp === prepared.fingerprint",
    replace: "false",
    note: "a second run rewrites everything",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "O04-incomplete-set-counts-as-complete",
    layer: "order",
    file: PLAN,
    find: " && stored.dictionary && stored.description",
    replace: "",
    note: "a set missing its companions is not rewritten",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "O05-rotation-never-moves",
    layer: "order",
    file: PLAN,
    find: "const start = (day * Math.max(1, limit)) % rest.length;",
    replace: "const start = 0;",
    note: "the same datasets are examined every day and the rest never are",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "O06-limit-ignored",
    layer: "order",
    file: PLAN,
    find: "const taken = work.slice(0, Math.max(0, limit));",
    replace: "const taken = work;",
    note: "a tick examines every dataset it finds",
    tests: [`${T}/neurobagel-writer.test.ts`, `${T}/neurobagel-admin-routes.test.ts`],
  },
  {
    id: "O07-stale-before-missing",
    layer: "order",
    file: PLAN,
    find: `      ...missing.map((id) => ({ id, class: "missing" as const })),\n      ...stale.map((id) => ({ id, class: "stale" as const })),`,
    replace: `      ...stale.map((id) => ({ id, class: "stale" as const })),\n      ...missing.map((id) => ({ id, class: "missing" as const })),`,
    note: "datasets with nothing in the store wait behind ones that merely changed",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },

  // The index.
  {
    id: "I01-index-write-unconditional",
    layer: "index",
    file: WRITER,
    find: "...(previous.etag ? { onlyIf: { etagMatches: previous.etag } } : {}),",
    replace: "",
    note: "a run that read a stale index overwrites a newer one",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "I02-index-always-changed",
    layer: "index",
    file: STORE,
    find: "const unchanged = matchesPrevious ||",
    replace: "const unchanged = false &&",
    note: "an unchanged index is written on every run",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "I03-empty-first-index-written",
    layer: "index",
    file: STORE,
    find: "(previous === null && entries.length === 0)",
    replace: "false",
    note: "a store with nothing eligible gets an empty index nobody reads",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },
  {
    id: "I04-unstamped-set-indexed",
    layer: "index",
    file: STORE,
    find: "if (!jsonld || !jsonld.meta[META.fingerprint]) return null;",
    replace: "if (!jsonld) return null;",
    note: "a JSON-LD the writer did not stamp as complete is indexed",
    tests: [`${T}/neurobagel-writer.test.ts`],
  },

  // Authentication and the read route.
  {
    id: "A01-token-not-checked",
    layer: "auth",
    file: ROUTE,
    find: "if (!match || !timingSafeEqual(match[1] as string, token)) return unauthorized();",
    replace: "",
    note: "the route answers anyone",
    tests: [`${T}/neurobagel-read-route.test.ts`],
  },
  {
    id: "A02-token-compared-with-equals",
    layer: "auth",
    file: ROUTE,
    find: "!timingSafeEqual(match[1] as string, token)",
    replace: "match[1] !== token",
    note: "the token is compared with !==, which is not constant time",
    tests: [`${T}/neurobagel-source-scan.test.ts`],
  },
  {
    id: "A03-unconfigured-route-answers",
    layer: "auth",
    file: ROUTE,
    find: "if (!token || !c.env.NEUROBAGEL) return notFound();",
    replace: "if (!c.env.NEUROBAGEL) return notFound();",
    note: "with no token configured the route challenges instead of not existing",
    tests: [`${T}/neurobagel-read-route.test.ts`],
  },
  {
    id: "A04-artifact-recheck-removed",
    layer: "route",
    file: ROUTE,
    find: "if (!eligible) return notFound();",
    replace: "",
    note: "an artifact of a dataset that went private is still served",
    tests: [`${T}/neurobagel-read-route.test.ts`],
  },
  {
    id: "A05-index-not-filtered",
    layer: "route",
    file: ROUTE,
    find: "document.datasets.filter((d) => eligible.has(d.id))",
    replace: "document.datasets",
    note: "the served index still names a dataset that went private",
    tests: [`${T}/neurobagel-read-route.test.ts`],
  },
  {
    id: "A06-unstamped-object-served",
    layer: "route",
    file: ROUTE,
    find: "if (!object || object.customMetadata?.[META.kind] !== parsed.kind) return notFound();",
    replace: "if (!object) return notFound();",
    note: "an object that only has an artifact-shaped name is served",
    tests: [`${T}/neurobagel-read-route.test.ts`],
  },
  {
    id: "A07-cacheable",
    layer: "route",
    file: ROUTE,
    find: `"Cache-Control": "no-store",`,
    replace: `"Cache-Control": "public, max-age=3600",`,
    note: "an answer that depends on a check made now is cacheable for an hour",
    tests: [`${T}/neurobagel-read-route.test.ts`],
  },
  {
    id: "A08-name-pattern-unanchored",
    layer: "route",
    file: STORE,
    find: "`^(${DATASET_ID})(\\\\.jsonld|_annotated\\\\.json|_dataset_description\\\\.json)$`,",
    replace: "`(${DATASET_ID})(\\\\.jsonld|_annotated\\\\.json|_dataset_description\\\\.json)$`,",
    note: "any name that ENDS like an artifact name is parsed as one",
    tests: [`${T}/neurobagel-read-route.test.ts`],
    equivalent:
      "the captured id and the object key are still checked against D1 and the bucket, so a name with a prefix reaches a 404 either way; nothing observable changes",
  },
  {
    id: "A09-own-rate-bucket-removed",
    layer: "route",
    file: "backend/src/middleware/rateLimit.ts",
    find: "if (NEUROBAGEL_PATH_RE.test(path)) {",
    replace: "if (false) {",
    note: "rotating made-up bearers mint a bucket each, and reach the token lookup",
    tests: [`${T}/rate-limit-buckets.test.ts`],
  },

  // Hooks and cron.
  {
    id: "H01-hook-ignores-the-switch",
    layer: "hooks",
    file: HOOKS,
    find: `    if (mode === "disabled") return;`,
    replace: "",
    note: "the hooks run with the writer off",
    tests: [`${T}/neurobagel-hooks.test.ts`],
  },
  {
    id: "H02-switch-is-truthy",
    layer: "hooks",
    file: WRITER,
    find: `if (env.NEUROBAGEL_WRITER_ENABLED !== "1") return "disabled";`,
    replace: `if (!env.NEUROBAGEL_WRITER_ENABLED) return "disabled";`,
    note: "any non-empty value, such as 0 or false, turns the writer on",
    tests: [`${T}/neurobagel-writer.test.ts`, `${T}/neurobagel-hooks.test.ts`],
  },
  {
    id: "H03-cron-runs-outside-production",
    layer: "hooks",
    file: HOOKS,
    find: '  if (isNonProductionEnv(env)) {\n    console.log("[neurobagel] reconcile skipped (non-production)");',
    replace: '  if (false) {\n    console.log("[neurobagel] reconcile skipped (non-production)");',
    note: "the dev worker's reconcile runs",
    tests: [`${T}/neurobagel-hooks.test.ts`],
  },
  {
    id: "H04-hook-awaits-nothing-but-throws",
    layer: "hooks",
    file: HOOKS,
    find: "    if (waitUntil) waitUntil(work);\n  } catch (err) {",
    replace: `    if (waitUntil) waitUntil(work);\n    throw new Error("scheduling failed");\n  } catch (err) {\n    throw err;`,
    note: "a failure while scheduling reaches the flow",
    tests: [`${T}/neurobagel-hooks.test.ts`],
  },
  {
    id: "H05-import-hook-on-every-status",
    layer: "hooks",
    file: `${ROUTES}/callbacks/import-state.ts`,
    find: `    if (status === "complete") {\n      scheduleNeurobagelSync(`,
    replace: "    if (true) {\n      scheduleNeurobagelSync(",
    note: "an import still in flight is federated",
    tests: [`${T}/neurobagel-hooks.test.ts`],
  },
  {
    id: "H06-version-hook-not-after-refresh",
    layer: "hooks",
    file: `${ROUTES}/callbacks/manifest.ts`,
    find: "        { after: refreshed },",
    replace: "",
    note: "the writer reads D1 before the metadata refresh has written it",
    tests: [`${T}/neurobagel-source-scan.test.ts`],
  },
  {
    id: "H07-hook-awaited-in-callback",
    layer: "hooks",
    file: `${ROUTES}/callbacks/manifest.ts`,
    find: "      scheduleNeurobagelSync(\n        c.env,",
    replace: "      await scheduleNeurobagelSync(\n        c.env,",
    note: "the callback waits for the hook",
    tests: [`${T}/neurobagel-source-scan.test.ts`],
  },

  // The admin route.
  {
    id: "D01-execute-by-default",
    layer: "admin",
    file: ADMIN,
    find: "const execute = body.execute === true;",
    replace: "const execute = body.execute !== false;",
    note: "an empty body writes",
    tests: [`${T}/neurobagel-admin-routes.test.ts`],
  },
  {
    id: "D02-disabled-gate-removed",
    layer: "admin",
    file: ADMIN,
    find: `if (execute && neurobagelWriterMode(c.env) !== "enabled") {`,
    replace: "if (false) {",
    note: "execute with the writer disabled answers 200 instead of 409",
    tests: [`${T}/neurobagel-admin-routes.test.ts`],
  },
  {
    id: "D03-loose-body",
    layer: "admin",
    file: ADMIN,
    find: "  .strict();",
    replace: "  .passthrough();",
    note: "a misspelled key is a silent dry run",
    tests: [`${T}/neurobagel-admin-routes.test.ts`],
  },
  {
    id: "D04-cli-always-executes",
    layer: "admin",
    file: "src/commands/admin.ts",
    find: "...(execute ? { execute: true } : {}),",
    replace: "execute: true,",
    note: "the CLI writes without --execute",
    tests: ["test/admin-neurobagel-cli.test.ts"],
  },
];

function mutate(source: string, m: Mutant): string {
  const expected = m.count ?? 1;
  const found = source.split(m.find).length - 1;
  if (found !== expected) {
    throw new Error(
      `${m.id}: anchor appears ${found} time(s) in ${m.file}, expected ${expected}; the mutant no longer applies`,
    );
  }
  const at = source.indexOf(m.find);
  return source.slice(0, at) + m.replace + source.slice(at + m.find.length);
}

async function runTests(files: string[]): Promise<{ passed: boolean; failed: string[] }> {
  const proc = Bun.spawn(["bun", "test", "--timeout", "60000", ...files], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character IS what is stripped
  const text = `${out}\n${err}`.replace(/\u001b\[[0-9;]*m/g, "");
  const failed = [...text.matchAll(/^(?:\(fail\)|✗) (.+?)(?: \[[\d.]+ms\])?$/gm)].map((m) => m[1]);
  return { passed: code === 0, failed };
}

async function main(): Promise<void> {
  if (process.argv.includes("--check-anchors")) {
    let broken = 0;
    for (const m of MUTANTS) {
      try {
        mutate(readFileSync(join(ROOT, m.file), "utf8"), m);
      } catch (error) {
        broken++;
        console.log((error as Error).message);
      }
    }
    console.log(`${MUTANTS.length} mutants, ${broken} whose anchor no longer applies`);
    process.exit(broken === 0 ? 0 : 1);
  }
  const only = process.argv.slice(2).find((a) => !a.startsWith("--")) as Layer | undefined;
  const selected = MUTANTS.filter((m) => only === undefined || m.layer === only);
  const baseline = await runTests(ALL_TESTS);
  if (!baseline.passed) {
    console.error("the unmutated tests do not pass; fix them before measuring mutants");
    process.exit(2);
  }
  let killed = 0;
  const survivors: Mutant[] = [];
  for (const m of selected) {
    const path = join(ROOT, m.file);
    const original = readFileSync(path, "utf8");
    try {
      writeFileSync(path, mutate(original, m));
      const focused = await runTests(m.tests ?? ALL_TESTS);
      if (!focused.passed) {
        killed++;
        console.log(
          `killed   ${m.id}  by ${focused.failed.length} test(s), for example: ${focused.failed[0] ?? "(a suite failed to load)"}`,
        );
        continue;
      }
      // Survived its own tests: does any other writer test notice?
      const wide = m.tests === undefined ? focused : await runTests(ALL_TESTS);
      if (!wide.passed) {
        killed++;
        console.log(
          `killed   ${m.id}  only by the wider suite (${wide.failed[0] ?? "a suite failed to load"}); its own tests missed it`,
        );
      } else {
        survivors.push(m);
        console.log(
          `SURVIVED ${m.id}  (${m.note})${m.equivalent ? `\n         believed equivalent: ${m.equivalent}` : "\n         NOT believed equivalent: a test is missing"}`,
        );
      }
    } finally {
      writeFileSync(path, original);
    }
  }
  const equivalent = survivors.filter((s) => s.equivalent).length;
  console.log(
    `\n${selected.length} mutants: ${killed} killed, ${survivors.length} survived (${equivalent} believed equivalent, ${survivors.length - equivalent} real gaps)`,
  );
  if (survivors.length - equivalent > 0) process.exit(1);
}

if (import.meta.main) await main();
