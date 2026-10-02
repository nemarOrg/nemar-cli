/**
 * A hand-written mutation battery for curation (epic #1586, phase 5; ADR 0084).
 *
 *   bun run scripts/neurobagel/mutation-battery.ts            # run every mutant
 *   bun run scripts/neurobagel/mutation-battery.ts loader     # one layer
 *
 * Each mutant makes ONE plausible mistake in the loader, the binder, the transform's use of an
 * entry, or the upstream converter: a check removed, a boundary moved by one, a condition
 * inverted, an ordering dropped.
 * The unit tests that exist for the area are then run against it, and the mutant is KILLED if any
 * fails and has SURVIVED if none does.
 * A survivor is either a test that is missing or a mutant that changes nothing observable, and
 * the report says which one it believes.
 *
 * The script edits a source file in place and restores it in `finally`.
 * Run it on a clean tree, alone: it is not part of the test suite.
 * A mutant whose anchor text is not found exactly as often as declared is an ERROR, never a
 * pass, so a refactor that moves the code cannot turn a mutant into a no-op unnoticed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");

type Layer = "loader" | "binder" | "transform" | "validate" | "upstream";

interface Mutant {
  id: string;
  layer: Layer;
  file: string;
  /** The text to change; it must occur `count` times (default 1). */
  find: string;
  /** Which occurrence to change (1-based, default 1). */
  occurrence?: number;
  count?: number;
  replace: string;
  /** What mistake this stands for. */
  note: string;
}

const NEUROBAGEL = "shared/neurobagel";
const SCRIPTS = "scripts/neurobagel";

export const MUTANTS: Mutant[] = [
  // The loader.
  {
    id: "L01-duplicate-keys-ignored",
    layer: "loader",
    file: `${NEUROBAGEL}/curation.ts`,
    find: "if (keyProblems.length > 0) throw new CurationError(keyProblems);",
    replace: "",
    note: "a duplicate dataset id, column or level silently keeps the last",
  },
  {
    id: "L02-proto-key-allowed",
    layer: "loader",
    file: `${NEUROBAGEL}/curation.ts`,
    find: "    ...keys.protoKeys.map((path) => `${path}: __proto__ is not allowed as a key`),",
    replace: "",
    note: "__proto__ accepted as a key",
  },
  {
    id: "L03-any-term-accepted",
    layer: "loader",
    file: `${NEUROBAGEL}/vocab-terms.ts`,
    find: "const label = terms.get(identifier);",
    replace: 'const label = terms.get(identifier) ?? "any";',
    note: "a term outside the pinned vocabulary passes",
  },
  {
    id: "L04-label-not-checked",
    layer: "loader",
    file: `${NEUROBAGEL}/curation.ts`,
    find: "if (given.Label !== found.label) {",
    replace: "if (false) {",
    note: "a term whose label is not the pinned label passes",
  },
  {
    id: "L05-level-may-be-missing",
    layer: "loader",
    file: `${NEUROBAGEL}/curation.ts`,
    find: "if (annotation.MissingValues.includes(raw)) {",
    replace: "if (false) {",
    note: "a value is both a level and a missing value",
  },
  {
    id: "L06-empty-levels-allowed",
    layer: "loader",
    file: `${NEUROBAGEL}/curation.ts`,
    find: 'if (mapsNothing && !(about.kind === "diagnosis" && annotation.MissingValues.length > 0)) {',
    replace: "if (false) {",
    note: "a categorical column that maps no value and says nothing about its values",
  },
  {
    id: "L06b-empty-levels-for-any-kind",
    layer: "loader",
    file: `${NEUROBAGEL}/curation.ts`,
    find: 'about.kind === "diagnosis" && annotation.MissingValues.length > 0',
    replace: "annotation.MissingValues.length > 0",
    note: "a sex column that maps nothing withdraws the mechanical sex mapping",
  },
  {
    id: "L07-two-sex-columns-allowed",
    layer: "loader",
    file: `${NEUROBAGEL}/curation.ts`,
    find: "if (of.length > 1) {",
    replace: "if (false) {",
    note: "a second sex or age column",
  },
  {
    id: "L08-reserved-band-boundary",
    layer: "loader",
    file: `${NEUROBAGEL}/curation.ts`,
    find: "Number(m[2]) >= FIRST_RESERVED_NM_NUMBER",
    replace: "Number(m[2]) > FIRST_RESERVED_NM_NUMBER",
    note: "nm099900, the first reserved fixture id, is accepted",
  },
  {
    id: "L09-day-of-month-unbounded",
    layer: "loader",
    file: `${NEUROBAGEL}/curation.ts`,
    find: "day >= 1 && day <= days",
    replace: "day >= 1 && day <= 31",
    note: "30 February is a date",
  },
  {
    id: "L10-leap-year-rule",
    layer: "loader",
    file: `${NEUROBAGEL}/curation.ts`,
    find: "(year % 4 === 0 && year % 100 !== 0) || year % 400 === 0",
    replace: "year % 4 === 0",
    note: "1900 is a leap year",
  },
  {
    id: "L11-missing-values-unsorted",
    layer: "loader",
    file: `${NEUROBAGEL}/curation.ts`,
    find: "missingValues: [...annotation.MissingValues].sort(byCodeUnit)",
    replace: "missingValues: [...annotation.MissingValues]",
    note: "the order of the file decides the bytes of the dictionary",
  },
  {
    id: "L12-mechanical-name-rule-dropped",
    layer: "loader",
    file: `${NEUROBAGEL}/curation.ts`,
    find: "if (reserved !== undefined && reserved !== about.kind) {",
    replace: "if (false) {",
    note: "a column called sex that is about diagnosis",
  },
  {
    id: "L13-pin-length",
    layer: "loader",
    file: `${NEUROBAGEL}/curation.ts`,
    find: "/^[0-9a-f]{40}$/",
    replace: "/^[0-9a-f]{39,41}$/",
    note: "a pin one digit off is accepted",
  },
  {
    id: "L14-value-range-bounds",
    layer: "loader",
    file: `${NEUROBAGEL}/curation.ts`,
    find: "range.Min < AGE_MIN_YEARS || range.Max > AGE_MAX_YEARS",
    replace: "range.Min < AGE_MIN_YEARS && range.Max > AGE_MAX_YEARS",
    note: "a ValueRange outside 0 to 120 years",
  },
  {
    id: "L15-evidence-reviewer-blank",
    layer: "loader",
    file: `${NEUROBAGEL}/curation.ts`,
    find: 'const notBlank = (value: string): boolean => value.trim() !== "";',
    replace: "const notBlank = (value: string): boolean => true;",
    note: "evidence nobody wrote",
  },
  // The binder and the pins.
  {
    id: "B01-json-pin-ignored",
    layer: "binder",
    file: `${NEUROBAGEL}/curation-bind.ts`,
    find: 'staleFiles.push("participants_json");',
    replace: "",
    note: "a changed participants.json does not make the entry stale",
  },
  {
    id: "B02-tsv-pin-ignored",
    layer: "binder",
    file: `${NEUROBAGEL}/curation-bind.ts`,
    find: 'staleFiles.push("participants_tsv");',
    replace: "",
    note: "a changed participants.tsv does not make the entry stale",
  },
  {
    id: "B03-coverage-not-checked",
    layer: "binder",
    file: `${NEUROBAGEL}/curation-bind.ts`,
    find: "if (!column.levels.has(cell) && !missing.has(cell)) uncovered.add(cell);",
    replace: "",
    note: "a value the level map never saw is accepted",
  },
  {
    id: "B04-coverage-first-row-only",
    layer: "binder",
    file: `${NEUROBAGEL}/curation-bind.ts`,
    find: "for (const row of table.rows) {",
    occurrence: 1,
    count: 3,
    replace: "for (const row of table.rows.slice(0, 1)) {",
    note: "coverage read over the first row, not the whole table",
  },
  {
    id: "B05-header-case-insensitive",
    layer: "binder",
    file: `${NEUROBAGEL}/curation-bind.ts`,
    find: "(h === column.name ? [i] : [])",
    replace: "(h.toLowerCase() === column.name.toLowerCase() ? [i] : [])",
    note: "a column is found under a different spelling",
  },
  {
    id: "B06-duplicate-header-allowed",
    layer: "binder",
    file: `${NEUROBAGEL}/curation-bind.ts`,
    find: "if (found.length > 1) {",
    replace: "if (false) {",
    note: "two columns with one name, the first taken",
  },
  {
    id: "B07-value-range-not-checked",
    layer: "binder",
    file: `${NEUROBAGEL}/curation-bind.ts`,
    find: "(column.valueRange.min !== min || column.valueRange.max !== max)",
    replace: "false",
    note: "a reviewer's ValueRange the table does not have",
  },
  {
    id: "B08-undeclared-blank-item",
    layer: "binder",
    file: `${NEUROBAGEL}/curation-bind.ts`,
    find: "if (STANDARD_MISSING_VALUES.includes(cell) && !missing.has(cell)) undeclared.add(cell);",
    replace: "",
    note: "a blank assessment item that would count as recorded",
  },
  {
    id: "B09-blob-header",
    layer: "binder",
    file: `${NEUROBAGEL}/git-blob.ts`,
    find: "`blob ${bytes.length}\\0`",
    replace: "`blob ${bytes.length}`",
    note: "the pin is not a git blob hash",
  },
  {
    id: "B10-bom-tolerance-dropped",
    layer: "binder",
    file: `${NEUROBAGEL}/git-blob.ts`,
    find: "return !text.startsWith(BOM) && (await gitBlobSha(BOM + text)) === pin;",
    replace: "return false;",
    note: "text a decoder stripped the byte order mark from is stale",
  },
  {
    id: "B11-absent-matches-anything",
    layer: "binder",
    file: `${NEUROBAGEL}/git-blob.ts`,
    find: "return text === null && pin === null;",
    replace: "return true;",
    note: "a pin of an absent file holds for a present one",
  },
  // The transform's use of an entry.
  {
    id: "T01-other-datasets-entry-accepted",
    layer: "transform",
    file: `${NEUROBAGEL}/transform.ts`,
    find: "if (curationEntry !== null && curationEntry.datasetId !== datasetId) {",
    replace: "if (false) {",
    note: "an entry for another dataset is applied",
  },
  {
    id: "T02-stale-not-flagged",
    layer: "transform",
    file: `${NEUROBAGEL}/transform.ts`,
    find: 'flags.add("curation_stale");',
    replace: "",
    note: "a stale entry is skipped without a word",
  },
  {
    id: "T03-invalid-not-flagged",
    layer: "transform",
    file: `${NEUROBAGEL}/transform.ts`,
    find: 'flags.add("curation_invalid");',
    replace: "",
    note: "an entry that does not fit is skipped without a word",
  },
  {
    id: "T04-unused-not-flagged",
    layer: "transform",
    file: `${NEUROBAGEL}/transform.ts`,
    find: 'flags.add("curation_unused");',
    replace: "",
    note: "an entry that cannot attach is skipped without a word",
  },
  {
    id: "T05-diagnoses-not-deduplicated",
    layer: "transform",
    file: `${NEUROBAGEL}/transform.ts`,
    find: "if (t === undefined || seen.has(t.identifier)) continue;",
    replace: "if (t === undefined) continue;",
    note: "the same diagnosis said twice for one participant",
  },
  {
    id: "T06-assessment-availability-inverted",
    layer: "transform",
    file: `${NEUROBAGEL}/transform.ts`,
    find: "if (!column.missingValues.includes(row[column.index])) {",
    replace: "if (column.missingValues.includes(row[column.index])) {",
    note: "an assessment on participants who recorded nothing",
  },
  {
    id: "T07-curated-sex-not-preferred",
    layer: "transform",
    file: `${NEUROBAGEL}/transform.ts`,
    find: "if (applied?.sex) {",
    replace: "if (false) {",
    note: "the mechanical sex column wins over the reviewed one",
  },
  {
    id: "T08-curated-age-not-preferred",
    layer: "transform",
    file: `${NEUROBAGEL}/transform.ts`,
    find: "if (applied?.age) {",
    replace: "if (false) {",
    note: "the mechanical age column wins over the reviewed one",
  },
  {
    id: "T09-assessments-unordered",
    layer: "transform",
    file: `${NEUROBAGEL}/transform.ts`,
    find: "byCodeUnit(a.identifier, b.identifier),",
    replace: "byCodeUnit(b.identifier, a.identifier),",
    note: "the order of assessments depends on the file",
  },
  {
    id: "T10-gender-flag-after-curation",
    layer: "transform",
    file: `${NEUROBAGEL}/transform.ts`,
    find: '    sexOutcome.status !== "mapped";',
    replace: "    true;",
    note: "gender is still flagged after a reviewer mapped it",
  },
  {
    id: "T11-group-not-replaced",
    layer: "transform",
    file: `${NEUROBAGEL}/transform.ts`,
    find: "const groupIsCurated = curatedGroup !== undefined;",
    replace: "const groupIsCurated = false;",
    note: "the mechanical group rule runs next to a curated group column",
  },
  {
    id: "T12-curated-terms-not-declared-to-validation",
    layer: "transform",
    file: `${NEUROBAGEL}/transform.ts`,
    find: "validateGraphDocument(graph.document, curated)",
    replace: "validateGraphDocument(graph.document)",
    note: "output validation does not know the reviewed terms",
  },
  // Output validation.
  {
    id: "V01-any-diagnosis-allowed",
    layer: "validate",
    file: `${NEUROBAGEL}/validate-output.ts`,
    find: "diagnosis: new Set([VOCAB.healthy_control.identifier, ...(curated?.diagnosis ?? [])]),",
    replace: "diagnosis: new Set(),",
    note: "healthy control is no longer allowed",
  },
  {
    id: "V02-assessment-tools-unchecked",
    layer: "validate",
    file: `${NEUROBAGEL}/validate-output.ts`,
    find: "IsPartOf: dictTerm(tools),",
    replace: "IsPartOf: dictTerm(new Set([...tools, 'snomed:1'])),",
    note: "a tool nobody curated passes validation",
  },
  // The converter for upstream annotations.
  {
    id: "U01-labels-not-rewritten",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: "return found === null ? null : { TermURL: found.identifier, Label: found.label };",
    replace:
      "return found === null ? null : { TermURL: found.identifier, Label: String(given.Label ?? '') };",
    note: "upstream's blank labels are passed on",
  },
  {
    id: "U02-int-not-read-as-float",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: 'if (id === "nb:FromInt") {',
    replace: "if (false) {",
    note: "an age written FromInt is dropped, not read",
  },
  {
    id: "U03-second-sex-column-kept",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: 'if ((kind === "age" || kind === "sex") && keptKinds.has(kind)) {',
    replace: "if (false) {",
    note: "two sex columns in one entry",
  },
  {
    id: "U04-missing-values-not-deduplicated",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: "const unique = [...new Set(given)];",
    replace: "const unique = [...given];",
    note: "a repeated missing value reaches the loader",
  },
  {
    id: "U05-redundant-columns-kept",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: "options.skipRedundant &&",
    replace: "false &&",
    note: "columns that add nothing are carried",
  },
  {
    id: "U06-final-check-skipped",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: 'if (bound?.status !== "applied") return skip("entry_failed_final_check");',
    replace: "",
    note: "an entry the binder would reject is written",
  },
  {
    id: "U07-value-range-carried",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: "    // ValueRange is not carried: the binder computes it from the table, which is the truth.",
    replace:
      "    if (isRecord(annotations.ValueRange)) return { block: { Format: { Label: term.label, TermURL: term.identifier }, IsAbout: isAbout, ...common, ValueRange: annotations.ValueRange, VariableType: 'Continuous' } };",
    note: "upstream's ValueRange is trusted",
  },
];

/** The unit tests that exercise these layers; each run is a few seconds. */
const TEST_FILES = [
  "test/neurobagel-curation.unit.test.ts",
  "test/neurobagel-curation-transform.unit.test.ts",
  "test/neurobagel-upstream-reuse.unit.test.ts",
  "test/neurobagel-transform.unit.test.ts",
  "test/neurobagel-validate-output.unit.test.ts",
  "test/neurobagel-oracle.unit.test.ts",
  "test/neurobagel-vocab.unit.test.ts",
  "test/neurobagel-purity.unit.test.ts",
];

function mutate(source: string, m: Mutant): string {
  const expected = m.count ?? 1;
  const found = source.split(m.find).length - 1;
  if (found !== expected) {
    throw new Error(
      `${m.id}: anchor appears ${found} time(s) in ${m.file}, expected ${expected}; the mutant no longer applies`,
    );
  }
  const wanted = m.occurrence ?? 1;
  let at = -1;
  for (let i = 0; i < wanted; i++) at = source.indexOf(m.find, at + 1);
  return source.slice(0, at) + m.replace + source.slice(at + m.find.length);
}

async function runTests(): Promise<{ passed: boolean; failed: string[] }> {
  const proc = Bun.spawn(["bun", "test", ...TEST_FILES], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  // Bun colours its output when the environment asks it to, and marks a failed test `✗` (or
  // `(fail)` in its plain mode).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character IS what is stripped
  const text = `${out}\n${err}`.replace(/\u001b\[[0-9;]*m/g, "");
  const failed = [...text.matchAll(/^(?:\(fail\)|✗) (.+?)(?: \[[\d.]+ms\])?$/gm)].map((m) => m[1]);
  return { passed: code === 0, failed };
}

async function main(): Promise<void> {
  const only = process.argv[2] as Layer | undefined;
  const selected = MUTANTS.filter((m) => only === undefined || m.layer === only);
  const baseline = await runTests();
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
      const result = await runTests();
      if (result.passed) {
        survivors.push(m);
        console.log(`SURVIVED ${m.id}  (${m.note})`);
      } else {
        killed++;
        console.log(
          `killed   ${m.id}  by ${result.failed.length} test(s), for example: ${result.failed[0] ?? "(a suite failed to load)"}`,
        );
      }
    } finally {
      writeFileSync(path, original);
    }
  }
  console.log(`\n${selected.length} mutants: ${killed} killed, ${survivors.length} survived`);
  if (survivors.length > 0) process.exit(1);
}

if (import.meta.main) await main();
