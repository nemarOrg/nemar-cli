/**
 * A hand-written mutation battery for the Neurobagel verification sweep
 * (epic #1586, phase 6; ADR 0067's amendment).
 *
 *   bun run scripts/neurobagel/verification-mutation-battery.ts             # every mutant
 *   bun run scripts/neurobagel/verification-mutation-battery.ts store       # one layer
 *   bun run scripts/neurobagel/verification-mutation-battery.ts --check-anchors
 *
 * Each mutant makes ONE plausible mistake in the verdict rules, the 48-hour edge, the rule that an
 * unconfigured check is `unchecked`, the anonymity invariant, the heartbeat, the cron fence or the
 * weekly report's counting. The tests for the area are then run against it, and the mutant is
 * KILLED only if a test fails on an assertion (the writer battery's reading of a log, reused: a
 * run that exits non-zero with no failing assertion is run again, then reported inconclusive and
 * never counted as a kill). A mutant that survives its own tests is run once more against every
 * test of the phase, so the report can say whether the guard exists somewhere else or nowhere.
 *
 * The script edits a source file in place and restores it in `finally`; run it on a clean tree,
 * alone. A mutant whose anchor is not found exactly as often as declared is an ERROR, never a
 * pass. Its soundness (every anchor still applies and changes the source) is checked without
 * running it by `backend/test/neurobagel-verify-battery.test.ts`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Mutant as WriterMutant,
  mutate as applyMutant,
  runTests,
} from "./writer-mutation-battery";

/** A mutant of this phase: the writer battery's shape, with this phase's own layers. */
export interface Mutant extends Omit<WriterMutant, "layer"> {
  layer: "verify" | "drift" | "run" | "anonymity" | "weekly" | "cli" | "contract";
}

/** The writer battery's rule: the anchor must match exactly as often as declared. */
export function mutate(source: string, m: Mutant): string {
  return applyMutant(source, m as unknown as WriterMutant);
}

const ROOT = join(import.meta.dir, "../..");
const SVC = "backend/src/services";
const T = "backend/test";

const CHECKS = `${T}/neurobagel-verify-checks.test.ts`;
const VERIFY_T = `${T}/neurobagel-verify.test.ts`;
const ANON_T = `${T}/neurobagel-anonymity-store.test.ts`;
const WEEKLY_PURE = `${T}/import-weekly-summary-decisions.test.ts`;
const WEEKLY_SWEEP = `${T}/import-weekly-summary-sweep.test.ts`;
const SCAN = `${T}/neurobagel-source-scan.test.ts`;
const WIRING = `${T}/cron-sweep-wiring.test.ts`;
const CLI_NB = "test/admin-neurobagel-cli.test.ts";
const CLI_WEEKLY = "test/import-weekly-cli.test.ts";

/** Every test the phase added or changed, run for a mutant that survives its own. */
export const ALL_TESTS = [
  CHECKS,
  VERIFY_T,
  ANON_T,
  WEEKLY_PURE,
  WEEKLY_SWEEP,
  SCAN,
  WIRING,
  CLI_NB,
  CLI_WEEKLY,
];

const VERIFY = `${SVC}/neurobagel-verify.ts`;
const DRIFT = `${SVC}/neurobagel-drift.ts`;
const ANON = `${SVC}/anonymity-sweep.ts`;
const STATUS = `${SVC}/neurobagel-status.ts`;
const WEEKLY_SVC = `${SVC}/import-weekly-summary.ts`;
const WEEKLY_GATHER = `${SVC}/import-weekly-summary-sweep.ts`;
const INDEX = "backend/src/index.ts";
const CONTRACT = "shared/contract/neurobagel-admin.ts";
const ATTENTION = "shared/contract/weekly-attention.ts";
const CLI = "src/commands/admin.ts";

const UNIT = [CHECKS, VERIFY_T];

export const MUTANTS: Mutant[] = [
  // The overall verdict.
  {
    id: "V01-overall-alarm-not-first",
    layer: "verify",
    file: VERIFY,
    find: '  if (verdicts.includes("alarm")) return "alarm";\n',
    replace: "",
    note: "an alarm among other verdicts is reported as unknown or healthy",
    tests: UNIT,
  },
  {
    id: "V02-overall-unknown-dropped",
    layer: "verify",
    file: VERIFY,
    find: '  if (verdicts.includes("unknown")) return "unknown";\n',
    replace: "",
    note: "a check that could not be answered leaves the overall healthy",
    tests: UNIT,
  },

  // The store verdict.
  {
    id: "S01-grace-edge-inclusive",
    layer: "verify",
    file: VERIFY,
    find: "since.getTime() > MISSING_GRACE_MS;",
    replace: "since.getTime() >= MISSING_GRACE_MS;",
    note: "a dataset missing for exactly 48 hours is already an alarm",
    tests: UNIT,
  },
  {
    id: "S02-grace-doubled",
    layer: "verify",
    file: VERIFY,
    find: "since.getTime() > MISSING_GRACE_MS;",
    replace: "since.getTime() > MISSING_GRACE_MS * 2;",
    note: "the grace is four days, not two",
    tests: UNIT,
  },
  {
    id: "S03-origin-takes-the-earlier",
    layer: "verify",
    file: VERIFY,
    find: "Math.max(published.getTime(), obs.origin.getTime())",
    replace: "Math.min(published.getTime(), obs.origin.getTime())",
    note: "a dataset eligible long before the writer was switched on counts as missing for months",
    tests: UNIT,
  },
  {
    id: "S04-unreadable-date-is-young",
    layer: "verify",
    file: VERIFY,
    find: "      published === null\n        ? obs.origin\n",
    replace: "      published === null\n        ? now\n",
    note: "a publication time that cannot be read is shown young, so nothing ever alarms",
    tests: UNIT,
  },
  {
    id: "S05-every-residue-persists",
    layer: "verify",
    file: VERIFY,
    find: ": obs.residue.filter((d) => obs.previousResidue?.has(d)).length;",
    replace: ": obs.residue.length;",
    note: "residue first seen today is counted as having survived a day",
    tests: UNIT,
  },
  {
    id: "S06-residue-cap-inclusive",
    layer: "verify",
    file: VERIFY,
    find: "const tooMuch = obs.residue.length > RESIDUE_MEMORY_CAP;",
    replace: "const tooMuch = obs.residue.length >= RESIDUE_MEMORY_CAP;",
    note: "exactly as much residue as the sweep can follow is already an alarm",
    tests: UNIT,
  },
  {
    id: "S07-one-overdue-is-tolerated",
    layer: "verify",
    file: VERIFY,
    find: "  if (overdue > 0) {",
    replace: "  if (overdue > 1) {",
    note: "a single dataset missing for days is not an alarm",
    tests: UNIT,
  },
  {
    id: "S08-persistence-age-zero",
    layer: "verify",
    file: VERIFY,
    find: "export const PERSISTENCE_MIN_AGE_MS = 20 * 60 * 60 * 1000;",
    replace: "export const PERSISTENCE_MIN_AGE_MS = 0;",
    note: "an on-demand run an hour later counts as the next day, so every takedown alarms",
    tests: UNIT,
  },
  {
    id: "S09-writer-off-is-judged",
    layer: "verify",
    file: VERIFY,
    find: '  if (mode === "disabled" || !env.NEUROBAGEL) {',
    replace: "  if (false) {",
    note: "a store nobody maintains is judged, and alarms for datasets nobody is writing",
    tests: UNIT,
  },
  {
    id: "S10-origin-is-always-now",
    layer: "verify",
    file: VERIFY,
    find: "const origin = firstWriterRun ?? previous.origin ?? now;",
    replace: "const origin = now;",
    note: "the clock never starts, so a writer that is enabled and never runs never alarms",
    tests: UNIT,
  },
  {
    id: "S11-index-residue-not-read",
    layer: "verify",
    file: VERIFY,
    find: "  for (const id of indexIds) if (!eligibleIds.has(id)) residueIds.add(id);\n",
    replace: "",
    note: "an index entry for a dataset that is no longer eligible is not residue",
    tests: UNIT,
  },
  {
    id: "S12-written-without-index",
    layer: "verify",
    file: VERIFY,
    find: "hasCompleteSet(listing.datasets.get(row.dataset_id)) && indexIds.has(row.dataset_id)",
    replace: "hasCompleteSet(listing.datasets.get(row.dataset_id)) || indexIds.has(row.dataset_id)",
    note: "a dataset with artifacts but no index entry, or an entry but no artifacts, counts as written",
    tests: UNIT,
  },

  // The node.
  {
    id: "N01-not-a-list-is-unknown",
    layer: "verify",
    file: VERIFY,
    find: '      result: verdict(\n        "alarm",\n        "The node answered the datasets query with something that is not a list.",',
    replace:
      '      result: verdict(\n        "unknown",\n        "The node answered the datasets query with something that is not a list.",',
    note: "a node that answers with the wrong shape is not an alarm",
    tests: UNIT,
  },
  {
    id: "N02-ineligible-not-counted",
    layer: "verify",
    file: VERIFY,
    find: "    if (!obs.eligible.has(iri)) ineligible++;",
    replace: "    if (false) ineligible++;",
    note: "a served dataset that is no longer eligible is not found",
    tests: UNIT,
  },
  {
    id: "N03-anonymous-not-recognised",
    layer: "verify",
    file: VERIFY,
    find: "    if (obs.anonymous.has(iri)) anonymousServed.push(iri);\n",
    replace: "",
    note: "a served anonymous deposit is not recorded in the audit log",
    tests: UNIT,
  },
  {
    id: "N04-protection-inverted",
    layer: "verify",
    file: VERIFY,
    find: "if (r.records_protected === false) unprotected++;",
    replace: "if (r.records_protected === true) unprotected++;",
    note: "an unprotected record passes and every protected one is flagged",
    tests: UNIT,
  },
  {
    id: "N05-unconfigured-node-is-healthy",
    layer: "verify",
    file: VERIFY,
    find: 'result: verdict("unchecked", "NEUROBAGEL_NODE_URL is not set, so the node is not probed."),',
    replace:
      'result: verdict("healthy", "NEUROBAGEL_NODE_URL is not set, so the node is not probed."),',
    note: "a node nobody probed reads as healthy",
    tests: UNIT,
  },
  {
    id: "N06-node-asked-with-the-wrong-method",
    layer: "verify",
    file: VERIFY,
    find: '        method: "POST",\n        headers: {',
    replace: '        method: "PUT",\n        headers: {',
    note: "the probe asks a different question from the one the federation asks",
    tests: UNIT,
  },

  // Registration.
  {
    id: "R01-diagnoses-always-asked",
    layer: "verify",
    file: VERIFY,
    find: "  if (nemarListed(nodes.value) !== true) return judgeRegistration(nodes.value, null);\n",
    replace: "",
    note: "the federation's heavy diagnoses fan-out is requested when NEMAR is not even listed",
    tests: UNIT,
  },
  {
    id: "R02-node-error-ignored",
    layer: "verify",
    file: VERIFY,
    find: "  const failing = errors.some((e) =>\n    same((e as { node_name?: unknown } | null)?.node_name, NEMAR_NODE_NAME),\n  );",
    replace: "  const failing = false;",
    note: "a listed node the federation cannot reach is healthy",
    tests: UNIT,
  },
  {
    id: "R03-unconfigured-registration-is-healthy",
    layer: "verify",
    file: VERIFY,
    find: '    return verdict(\n      "unchecked",\n      "NEUROBAGEL_FEDERATION_URL is not set, so registration is not checked.",',
    replace:
      '    return verdict(\n      "healthy",\n      "NEUROBAGEL_FEDERATION_URL is not set, so registration is not checked.",',
    note: "a registration nobody checked reads as healthy",
    tests: UNIT,
  },

  // Upstream drift.
  {
    id: "D01-tag-drift-ignored",
    layer: "drift",
    file: DRIFT,
    find: "  if (tag !== pin.tag) tally.drifted.push(",
    replace: "  if (false) tally.drifted.push(",
    note: "a release tag that has moved is not noticed",
    tests: UNIT,
  },
  {
    id: "D02-vocabulary-drift-ignored",
    layer: "drift",
    file: DRIFT,
    find: "    else if (now !== sha) tally.drifted.push(",
    replace: "    else if (false) tally.drifted.push(",
    note: "a vocabulary file whose blob has changed is not noticed",
    tests: UNIT,
  },
  {
    id: "D03-failed-reads-are-healthy",
    layer: "drift",
    file: DRIFT,
    find: '  if (tally.failed.length > 0) {\n    return {\n      verdict: "unknown",',
    replace: '  if (tally.failed.length > 0) {\n    return {\n      verdict: "healthy",',
    note: "a rate limit or an unreachable upstream reads as no drift",
    tests: UNIT,
  },
  {
    id: "D04-failed-read-hides-drift",
    layer: "drift",
    file: DRIFT,
    find: "  if (tally.drifted.length > 0) {",
    replace: "  if (tally.drifted.length > 0 && tally.failed.length === 0) {",
    note: "drift that was found is reported as unknown because another read failed",
    tests: UNIT,
  },
  {
    id: "D05-credential-sent-upstream",
    layer: "drift",
    file: DRIFT,
    find: 'headers: { "User-Agent": UPSTREAM_USER_AGENT, Accept: "application/vnd.github+json" },',
    replace:
      'headers: { "User-Agent": UPSTREAM_USER_AGENT, Accept: "application/vnd.github+json", Authorization: "Bearer x" },',
    note: "a credential rides along on a read of somebody else's repository",
    tests: [VERIFY_T, SCAN],
  },

  // The run, the heartbeat and the fence.
  {
    id: "H01-throw-not-contained",
    layer: "run",
    file: VERIFY,
    find: "    verification = failedVerification(now, trigger, err);",
    replace: "    throw err;",
    note: "a sweep that throws leaves no heartbeat and surfaces as a crashed cron",
    tests: UNIT,
  },
  {
    id: "H02-heartbeat-not-written",
    layer: "run",
    file: VERIFY,
    find: "    await writeHeartbeat(env.DB, verification, memory);\n    heartbeatWritten = true;",
    replace: "    heartbeatWritten = true;",
    note: "the heartbeat is reported as written and is not",
    tests: UNIT,
  },
  {
    id: "H03-cron-fence-off",
    layer: "run",
    file: VERIFY,
    find: '  if (isNonProductionEnv(env)) {\n    console.log("[neurobagel] verification skipped (non-production)");',
    replace:
      '  if (false) {\n    console.log("[neurobagel] verification skipped (non-production)");',
    note: "the daily wrapper runs on the dev worker",
    tests: UNIT,
  },
  {
    id: "H04-raw-sweep-in-the-cron",
    layer: "run",
    file: INDEX,
    find: "        runNeurobagelVerificationSweepCron(env)\n          .then((r) => {\n            if (!r) return;\n            const line = verificationLogLine(r);",
    replace:
      "        runNeurobagelVerificationSweep(env)\n          .then((r) => {\n            if (!r) return;\n            const line = verificationLogLine(r);",
    note: "the cron calls the unguarded sweep and skips the production fence",
    tests: [SCAN, WIRING],
  },
  {
    id: "H05-on-the-dev-allowlist",
    layer: "run",
    file: INDEX,
    find: '  "fetchAndSyncDataPapers",\n] as const;',
    replace: '  "fetchAndSyncDataPapers",\n  "runNeurobagelVerificationSweepCron",\n] as const;',
    note: "the verification cron is declared safe for the dev worker",
    tests: [SCAN, WIRING],
  },
  {
    id: "H06-admin-run-recorded-as-daily",
    layer: "run",
    file: VERIFY,
    find: '  const trigger = opts.trigger ?? "admin";',
    replace: '  const trigger = opts.trigger ?? "cron";',
    note: "an on-demand run counts as the daily job being alive",
    tests: [VERIFY_T, WEEKLY_SWEEP],
  },

  // The anonymity invariant.
  {
    id: "A01-store-not-checked",
    layer: "anonymity",
    file: ANON,
    find: "      if (held?.has(row.dataset_id)) {",
    replace: "      if (false) {",
    note: "a deposit in the store is never found",
    tests: [ANON_T],
  },
  {
    id: "A02-unlistable-store-is-silent",
    layer: "anonymity",
    file: ANON,
    find: '      unchecked.push("neurobagel_store");',
    replace: "      void 0;",
    note: "a store that could not be listed leaves the deposit verified",
    tests: [ANON_T],
  },
  {
    id: "A03-store-listed-per-deposit",
    layer: "anonymity",
    file: ANON,
    find: "      storeIds ??= readStoreIds();",
    replace: "      storeIds = readStoreIds();",
    note: "the store is listed once for every deposit, not once for the pass",
    tests: [ANON_T],
  },
  {
    id: "A04-finding-is-not-an-invariant",
    layer: "anonymity",
    file: ANON,
    find: '          check: NEUROBAGEL_STORE_CHECK,\n          severity: "invariant",',
    replace: '          check: NEUROBAGEL_STORE_CHECK,\n          severity: "deposit",',
    note: "NEMAR's own broken guarantee is reported as the depositor's file",
    tests: [ANON_T],
  },
  {
    id: "A05-unrecognised-objects-skipped",
    layer: "anonymity",
    file: STATUS,
    find: "  for (const key of listing.unexpected) {\n    for (const m of key.matchAll(DATASET_ID_IN_TEXT)) ids.add(m[0]);\n  }\n",
    replace: "",
    note: "an object the writer did not stamp hides a deposit",
    tests: [ANON_T],
  },
  {
    id: "A06-index-text-not-read",
    layer: "anonymity",
    file: STATUS,
    find: "  if (index) {\n    for (const m of (await index.text()).matchAll(DATASET_ID_IN_TEXT)) ids.add(m[0]);\n  }\n",
    replace: "",
    note: "an index that names a deposit, parseable or not, is not read",
    tests: [ANON_T],
  },

  // The weekly report.
  {
    id: "W01-admin-run-counted-as-daily",
    layer: "weekly",
    file: WEEKLY_GATHER,
    find: '      if (v.trigger !== "cron") continue;\n',
    replace: "",
    note: "an on-demand run is counted among the daily runs",
    tests: [WEEKLY_SWEEP],
  },
  {
    id: "W02-unreadable-audit-row-is-low",
    layer: "weekly",
    file: WEEKLY_GATHER,
    find: "    if (unreadable > 0) {",
    replace: "    if (false) {",
    note: "an audit row that cannot be read leaves the anonymity count low instead of unknown",
    tests: [WEEKLY_SWEEP],
  },
  {
    id: "W03-alarm-days-hidden",
    layer: "contract",
    file: ATTENTION,
    find: '    if (n.days.alarm > 0 && n.latest.overall !== "alarm") {',
    replace: "    if (false) {",
    note: "a week with an alarm and a healthy last run reads as a clean week",
    tests: [WEEKLY_PURE, WEEKLY_SWEEP],
  },

  // Review changes: the id scan of the store.
  {
    id: "R01-id-boundary-after-the-id",
    layer: "anonymity",
    file: STATUS,
    find: "const DATASET_ID_IN_TEXT = /(?<![A-Za-z0-9])(?:nm|on)\\d{6}(?!\\d)/g;",
    replace: "const DATASET_ID_IN_TEXT = /\\b(?:nm|on)\\d{6}\\b/g;",
    note: "an id followed by an underscore is not found, so a deposit's copy under `<id>_annotated.json` reads as a clean store",
    tests: [ANON_T],
  },
  {
    id: "R02-id-longer-number-matches",
    layer: "anonymity",
    file: STATUS,
    find: "(?:nm|on)\\d{6}(?!\\d)/g;",
    replace: "(?:nm|on)\\d{6}/g;",
    note: "a longer number that begins with a deposit's id is taken for the deposit",
    tests: [ANON_T],
  },
  {
    id: "R03-id-inside-a-word-matches",
    layer: "anonymity",
    file: STATUS,
    find: "/(?<![A-Za-z0-9])(?:nm|on)",
    replace: "/(?:nm|on)",
    note: "an id inside a longer word is taken for the deposit",
    tests: [ANON_T],
  },

  // Review changes: the weekly findings.
  {
    id: "R04-weekly-ledger-not-read",
    layer: "weekly",
    file: WEEKLY_GATHER,
    find: '      if (entry.label.state === "anonymity") datasets.add(entry.dataset_id);\n',
    replace: "",
    note: "the writer's standing finding is missing from the weekly count while status shows it",
    tests: [WEEKLY_SWEEP],
  },
  {
    id: "R05-weekly-counts-rows",
    layer: "weekly",
    file: WEEKLY_GATHER,
    find: "const key = r.resource_id ?? `row-${i}`;",
    replace: "const key = `row-${i}`;",
    note: "a finding repeated on every daily run is counted once per run, not once",
    tests: [WEEKLY_SWEEP],
  },
  {
    id: "R06-weekly-findings-need-a-run",
    layer: "weekly",
    file: ATTENTION,
    find: "  } else if (f.neurobagelFindings > 0) {",
    replace: "  } else if (f.neurobagelFindings > 0 && n !== null) {",
    note: "findings are ignored in a week the daily sweep wrote no row",
    tests: [WEEKLY_PURE],
  },
  {
    id: "R07-weekly-text-names-the-kind",
    layer: "weekly",
    file: WEEKLY_SVC,
    find: "Findings that need a person, over the window",
    replace: "Anonymity-class findings, over the window",
    note: "the public report says what kind of finding a count is",
    tests: [WEEKLY_PURE, SCAN],
  },
  {
    id: "R08-node-reason-names-the-kind",
    layer: "verify",
    file: VERIFY,
    find: "are for datasets that are not eligible; the node may",
    replace: "are for datasets that are not eligible (some anonymity-class); the node may",
    note: "a reason that reaches the weekly report says what kind of dataset a record belongs to",
    tests: [VERIFY_T, SCAN],
  },

  // Review changes: what the week asks attention for.
  {
    id: "R09-missed-runs-ignored",
    layer: "contract",
    file: ATTENTION,
    find: "    if (missed > NEUROBAGEL_MISSED_RUNS_TOLERATED) {",
    replace: "    if (false) {",
    note: "a cron that died on day two is not noticed",
    tests: [WEEKLY_PURE, CLI_WEEKLY],
  },
  {
    id: "R10-missed-runs-tolerance-two",
    layer: "contract",
    file: ATTENTION,
    find: "export const NEUROBAGEL_MISSED_RUNS_TOLERATED = 1;",
    replace: "export const NEUROBAGEL_MISSED_RUNS_TOLERATED = 2;",
    note: "two missing daily runs are tolerated, not one",
    tests: [WEEKLY_PURE],
  },
  {
    id: "R11-unknown-days-ignored",
    layer: "contract",
    file: ATTENTION,
    find: '    if (n.days.unknown > 0 && n.latest.overall !== "unknown") {',
    replace: "    if (false) {",
    note: "days on which the sweep could not determine anything are not noticed once the latest run is fine",
    tests: [WEEKLY_PURE, CLI_WEEKLY],
  },
  {
    id: "R12-failed-runs-ignored",
    layer: "contract",
    file: ATTENTION,
    find: "    if (n.failedRuns > 0) {",
    replace: "    if (false) {",
    note: "a sweep that failed outright is not noticed",
    tests: [WEEKLY_PURE, CLI_WEEKLY],
  },
  {
    id: "R13-one-unchecked-day-not-said",
    layer: "contract",
    file: ATTENTION,
    find: "WEEKLY_NEUROBAGEL_CHECKS.filter((c) => n.checkDays[c].unchecked > 0);",
    replace: "WEEKLY_NEUROBAGEL_CHECKS.filter((c) => n.checkDays[c].unchecked > 1);",
    note: "a single day on which a check did not run is covered by 'all look normal'",
    tests: [WEEKLY_PURE],
  },
  {
    id: "R14-headline-claims-all-ran",
    layer: "weekly",
    file: WEEKLY_SVC,
    find: "    const neurobagel =\n      notChecked.length > 0\n",
    replace: "    const neurobagel =\n      false\n",
    note: "the headline says all four checks ran when some did not",
    tests: [WEEKLY_PURE],
  },
  {
    id: "R33-weekly-cli-restates-the-rule",
    layer: "cli",
    file: CLI,
    find: "  return weeklyAttention(f).attention;",
    replace: '  return f.coverageStatus === "alarm" || f.errors.length > 0;',
    note: "the command's exit code stops following the report's own rule, as it once did",
    tests: [CLI_WEEKLY],
  },

  // Review changes: the overall verdict, the unconfigured writer, and the memory.
  {
    id: "R15-drift-alone-makes-healthy",
    layer: "verify",
    file: VERIFY,
    find: '  return lookedAtNemar ? "healthy" : "unchecked";',
    replace: '  return "healthy";',
    note: "a sweep that looked at nothing of NEMAR's reads as healthy",
    tests: UNIT,
  },
  {
    id: "R16-drift-counts-as-looking",
    layer: "verify",
    file: VERIFY,
    find: '(["store", "node", "registration"] as const).some(',
    replace: '(["store", "node", "registration", "drift"] as const).some(',
    note: "upstream drift counts as a check of NEMAR's own",
    tests: UNIT,
  },
  {
    id: "R17-writer-on-no-bucket-is-quiet",
    layer: "verify",
    file: VERIFY,
    find: '      result: verdict(\n        "alarm",\n        "The writer is switched on but no NEUROBAGEL bucket is bound',
    replace:
      '      result: verdict(\n        "unchecked",\n        "The writer is switched on but no NEUROBAGEL bucket is bound',
    note: "a production misconfiguration reads as a normal week",
    tests: UNIT,
  },
  {
    id: "R18-residue-memory-reset-by-a-blip",
    layer: "verify",
    file: VERIFY,
    find: "    residue: store.memory?.residue ?? before.residue,",
    replace: "    residue: store.memory?.residue ?? [],",
    note: "one failed read of the store forgets the residue it was following",
    tests: [VERIFY_T],
  },
  {
    id: "R19-origin-reset-by-a-blip",
    layer: "verify",
    file: VERIFY,
    find: "    origin: store.memory ? store.memory.origin : before.origin,",
    replace: "    origin: store.memory ? store.memory.origin : null,",
    note: "one failed read of the store restarts the clock a never-run writer was aging on",
    tests: [VERIFY_T],
  },
  {
    id: "R20-node-behind-reset-by-a-blip",
    layer: "verify",
    file: VERIFY,
    find: "  const nodeBehind = node.nodeBehind ?? before.nodeBehind;",
    replace: "  const nodeBehind = node.nodeBehind;",
    note: "a day on which the node could not be asked forgets that it was behind",
    tests: [VERIFY_T],
  },
  {
    id: "R21-unreadable-index-is-empty",
    layer: "verify",
    file: VERIFY,
    find: "  if (index.etag !== null && index.document === null) {",
    replace: "  if (false) {",
    note: "an index that cannot be read is judged as an empty one",
    tests: [VERIFY_T],
  },
  {
    id: "R22-node-gap-alarms-at-once",
    layer: "verify",
    file: VERIFY,
    find: "  if (behind === true && obs.previousBehind === true) {",
    replace: "  if (behind === true) {",
    note: "a node that has not reloaded yet is an alarm on the first sweep",
    tests: UNIT,
  },
  {
    id: "R23-node-gap-never-alarms",
    layer: "verify",
    file: VERIFY,
    find: "  if (behind === true && obs.previousBehind === true) {",
    replace: "  if (false) {",
    note: "a stale or empty node is healthy for ever",
    tests: UNIT,
  },

  // Review changes: requests.
  {
    id: "R24-node-redirect-followed",
    layer: "verify",
    file: VERIFY,
    find: '        body: "{}",\n        redirect: "manual",',
    replace: '        body: "{}",\n        redirect: "follow",',
    note: "the node probe follows a redirect to an address nobody configured",
    tests: [VERIFY_T, SCAN],
  },
  {
    id: "R24b-federation-redirect-followed",
    layer: "verify",
    file: VERIFY,
    find: '        headers: { "User-Agent": AGENT, Accept: "application/json" },\n        redirect: "manual",',
    replace:
      '        headers: { "User-Agent": AGENT, Accept: "application/json" },\n        redirect: "follow",',
    note: "the federation reads follow a redirect to an address nobody configured",
    tests: [VERIFY_T, SCAN],
  },
  {
    id: "R25-drift-redirect-followed",
    layer: "drift",
    file: DRIFT,
    find: '        redirect: "manual",',
    replace: '        redirect: "follow",',
    note: "the upstream reads follow a redirect",
    tests: [VERIFY_T, SCAN],
  },
  {
    id: "R26-redirect-not-named",
    layer: "drift",
    file: DRIFT,
    find: '    if (res.status >= 300 && res.status < 400) return { ok: false, reason: "redirected" };\n',
    replace: "",
    note: "a redirect is reported as a plain HTTP failure, with no hint that the address has moved",
    tests: [VERIFY_T],
  },
  {
    id: "R27-answer-cap-doubled",
    layer: "drift",
    file: DRIFT,
    find: "      if (total > maxBytes) {",
    replace: "      if (total > maxBytes * 2) {",
    note: "an answer twice its cap is still read whole",
    tests: [VERIFY_T],
  },
  {
    id: "R28-answer-cap-exclusive",
    layer: "drift",
    file: DRIFT,
    find: "      if (total > maxBytes) {",
    replace: "      if (total >= maxBytes) {",
    note: "an answer of exactly its cap is refused",
    tests: [VERIFY_T],
  },

  // Review changes: the status command's exit codes.
  {
    id: "R29-stale-edge-inclusive",
    layer: "contract",
    file: CONTRACT,
    find: "age > NEUROBAGEL_VERIFICATION_STALE_MS",
    replace: "age >= NEUROBAGEL_VERIFICATION_STALE_MS",
    note: "a record exactly 36 hours old is already unknown",
    tests: [CHECKS],
  },
  {
    id: "R30-writer-off-none-recorded-is-unknown",
    layer: "contract",
    file: CONTRACT,
    find: '    return writerMode === "enabled"',
    replace: "    return true",
    note: "a deployment that does not run the writer is told its verification is unknown",
    tests: [CHECKS, CLI_NB],
  },
  {
    id: "R31-unknown-exits-one",
    layer: "contract",
    file: CONTRACT,
    find: '  return v === "alarm" ? 1 : v === "unknown" ? 2 : 0;',
    replace: '  return v === "alarm" || v === "unknown" ? 1 : 0;',
    note: "status and verify stop telling an alarm from an unknown",
    tests: [CHECKS, CLI_NB],
  },
  {
    id: "R32-status-ignores-the-verification",
    layer: "cli",
    file: CLI,
    find: "    process.exitCode = alarming ? 1 : neurobagelVerdictExitCode(verification.verdict);",
    replace: "    process.exitCode = alarming ? 1 : 0;",
    note: "status exits 0 on no record, and on a stale healthy one",
    tests: [CLI_NB],
  },
];

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
  const only = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const selected = MUTANTS.filter((m) => only === undefined || m.layer === only);
  const baseline = await runTests(ALL_TESTS);
  if (!baseline.passed) {
    console.error(
      `the unmutated tests do not pass${baseline.failures.length > 0 ? ` (${baseline.failures.map((f) => f.name).join("; ")})` : " (no failing test: a suite did not load or the infrastructure failed)"}; fix them before measuring mutants`,
    );
    process.exit(2);
  }
  let killed = 0;
  const survivors: Mutant[] = [];
  const inconclusive: Mutant[] = [];
  for (const m of selected) {
    const path = join(ROOT, m.file);
    const original = readFileSync(path, "utf8");
    try {
      writeFileSync(path, mutate(original, m));
      const focused = await runTests(m.tests ?? ALL_TESTS);
      if (!focused.passed && focused.asserted.length === 0) {
        inconclusive.push(m);
        console.log(`INCONCLUSIVE ${m.id}  (failed twice without a failing assertion)`);
        continue;
      }
      if (!focused.passed) {
        killed++;
        console.log(
          `killed   ${m.id}  by ${focused.asserted.length} test(s), for example: ${focused.asserted[0]?.name}`,
        );
        continue;
      }
      const wide = m.tests === undefined ? focused : await runTests(ALL_TESTS);
      if (!wide.passed && wide.asserted.length > 0) {
        killed++;
        console.log(
          `killed   ${m.id}  only by the wider suite (${wide.asserted[0]?.name}); its own tests missed it`,
        );
      } else if (!wide.passed) {
        inconclusive.push(m);
        console.log(`INCONCLUSIVE ${m.id}  (the wider suite failed without a failing assertion)`);
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
    `\n${selected.length} mutants: ${killed} killed, ${survivors.length} survived (${equivalent} believed equivalent, ${survivors.length - equivalent} real gaps), ${inconclusive.length} inconclusive`,
  );
  if (survivors.length - equivalent > 0 || inconclusive.length > 0) process.exit(1);
}

if (import.meta.main) await main();
