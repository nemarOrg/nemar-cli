/**
 * A hand-written mutation battery for curation (epic #1586, phase 5; ADR 0083).
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
    file: `${NEUROBAGEL}/curation-resolve.ts`,
    find: "if (entry.datasetId !== datasetId) {",
    replace: "if (false) {",
    note: "an entry for another dataset is applied",
  },
  {
    id: "T02-stale-not-flagged",
    layer: "transform",
    file: `${NEUROBAGEL}/curation-resolve.ts`,
    find: 'flag: "curation_stale",',
    replace: "flag: null,",
    note: "a stale entry is skipped without a word",
  },
  {
    id: "T03-invalid-not-flagged",
    layer: "transform",
    file: `${NEUROBAGEL}/curation-resolve.ts`,
    find: 'flag: "curation_invalid",',
    replace: "flag: null,",
    note: "an entry that does not fit is skipped without a word",
  },
  {
    id: "T04-unused-not-flagged",
    layer: "transform",
    file: `${NEUROBAGEL}/curation-resolve.ts`,
    find: 'flag: "curation_unused",',
    replace: "flag: null,",
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
    find: "!options.keepRedundant &&",
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
  // Review round 2: the age rules, withholding, the opaque entry, whole-entry skipping, the pins.
  {
    id: "B12-age-units-ignored",
    layer: "binder",
    file: `${NEUROBAGEL}/curation-bind.ts`,
    find: "if (ageUnitsAreNotYears(units)) {",
    replace: "if (false) {",
    note: "an age declared in months is bound as years",
  },
  {
    id: "B13-null-units-not-years",
    layer: "binder",
    file: `${NEUROBAGEL}/participants.ts`,
    find: "units !== undefined && units !== null && (typeof units",
    replace: "units !== undefined && (typeof units",
    note: "a null Units is read as a declaration of something other than years",
  },
  {
    id: "B14-zero-share-ignored",
    layer: "binder",
    file: `${NEUROBAGEL}/curation-bind.ts`,
    find: "if (parsed > 0 && zeros / parsed >= ZERO_PLACEHOLDER_SHARE) {",
    replace: "if (false) {",
    note: "a column of placeholder zeros becomes an age of 0 for everyone",
  },
  {
    id: "B15-zero-share-boundary",
    layer: "binder",
    file: `${NEUROBAGEL}/curation-bind.ts`,
    find: "zeros / parsed >= ZERO_PLACEHOLDER_SHARE",
    replace: "zeros / parsed > ZERO_PLACEHOLDER_SHARE",
    note: "exactly half zeros passes",
  },
  {
    id: "B16-declared-missing-zero-counted",
    layer: "binder",
    file: `${NEUROBAGEL}/curation-bind.ts`,
    find: "        if (missing.has(cell)) continue;\n        const age = parseAge(cell, column.format);",
    replace: "        const age = parseAge(cell, column.format);",
    note: "a 0 the reviewer declared missing still counts as a placeholder zero (and a missing value as unreadable)",
  },
  {
    id: "B17-binder-takes-a-forged-entry",
    layer: "binder",
    file: `${NEUROBAGEL}/curation-bind.ts`,
    find: "if (!isLoaded(entry)) {",
    replace: "if (false) {",
    note: "the binder accepts a hand-built entry",
  },
  {
    id: "B18-partial-application",
    layer: "binder",
    file: `${NEUROBAGEL}/curation-bind.ts`,
    find: '  if (problems.length > 0) return { status: "invalid", problems };\n  return { status: "applied", bound };',
    replace: '  return { status: "applied", bound };',
    note: "the columns that fit are applied when others do not",
  },
  {
    id: "B19-coverage-skips-blank-id-rows",
    layer: "binder",
    file: `${NEUROBAGEL}/curation-bind.ts`,
    find: "for (const row of table.rows) {",
    occurrence: 1,
    count: 3,
    replace: 'for (const row of table.rows.filter((r) => r[0].trim() !== "")) {',
    note: "rows without a participant id escape coverage",
  },
  {
    id: "B20-coverage-keeps-one-row-per-id",
    layer: "binder",
    file: `${NEUROBAGEL}/curation-bind.ts`,
    find: "for (const row of table.rows) {",
    occurrence: 1,
    count: 3,
    replace: "for (const row of [...new Map(table.rows.map((r) => [r[0], r])).values()]) {",
    note: "only the last of a participant's repeated rows is covered",
  },
  {
    id: "B21-line-endings-normalized",
    layer: "binder",
    file: `${NEUROBAGEL}/git-blob.ts`,
    find: "gitBlobShaOfBytes(encoder.encode(text))",
    replace: 'gitBlobShaOfBytes(encoder.encode(text.replace(/\\r\\n/g, "\\n")))',
    note: "a CRLF to LF flip leaves the pin matching",
  },
  {
    id: "T13-unapplied-entry-withholds-nothing",
    layer: "transform",
    file: `${NEUROBAGEL}/curation-resolve.ts`,
    find: "const named = new Set(kindsOf(entry));",
    replace: "const named = new Set<CurationKind>();",
    note: "a stale or invalid entry that withdraws a claim fails open",
  },
  {
    id: "T14-group-not-withheld",
    layer: "transform",
    file: `${NEUROBAGEL}/transform.ts`,
    find: ' && !groupIsCurated && !withheldFor("diagnosis")) {',
    replace: " && !groupIsCurated) {",
    note: "the mechanical healthy control mapping survives a stale veto entry",
  },
  {
    id: "T15-sex-not-withheld",
    layer: "transform",
    file: `${NEUROBAGEL}/transform.ts`,
    find: 'let sexOutcome: ColumnOutcome<SexMapping> = withheldFor("sex")',
    replace: "let sexOutcome: ColumnOutcome<SexMapping> = false",
    note: "the mechanical sex survives an entry that names sex and does not apply",
  },
  {
    id: "T16-age-not-withheld",
    layer: "transform",
    file: `${NEUROBAGEL}/transform.ts`,
    find: 'let ageOutcome: ColumnOutcome<AgeMapping> = withheldFor("age")',
    replace: "let ageOutcome: ColumnOutcome<AgeMapping> = false",
    note: "the mechanical age survives an entry that names age and does not apply",
  },
  {
    id: "T17-withheld-not-flagged",
    layer: "transform",
    file: `${NEUROBAGEL}/transform.ts`,
    find: 'if (withheld.age + withheld.diagnosis + withheld.sex > 0) flags.add("curation_withheld");',
    replace: "",
    note: "claims are withheld without a word",
  },
  {
    id: "T18-forged-entry-accepted",
    layer: "transform",
    file: `${NEUROBAGEL}/curation-resolve.ts`,
    find: "if (!isLoaded(entry)) {",
    replace: "if (false) {",
    note: "the transform accepts a hand-built entry",
  },
  {
    id: "L16-future-review-accepted",
    layer: "loader",
    file: `${NEUROBAGEL}/curation.ts`,
    find: "raw.evidence.date > options.today",
    replace: "raw.evidence.date < options.today",
    note: "a review dated tomorrow passes (or yesterday's does not)",
  },
  {
    id: "L17-loaded-entry-not-frozen",
    layer: "loader",
    file: `${NEUROBAGEL}/curation-loaded.ts`,
    find: "  Object.freeze(data.columns);",
    replace: "",
    note: "a loaded entry's columns can be edited afterwards",
  },
  {
    id: "U08-age-units-not-checked-by-the-converter",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: "const bound = bindCuratedColumn(column.column, { header, rows }, participantsJson);",
    replace: "const bound = bindCuratedColumn(column.column, { header, rows });",
    note: "upstream's age in months is carried",
  },
  {
    id: "U09-merge-overwrites-a-persons-entry",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: 'if (review !== "upstream_community") {',
    replace: "if (false) {",
    note: "a regeneration replaces an author entry",
  },
  {
    id: "U10-redundant-kept-by-default",
    layer: "upstream",
    file: `${SCRIPTS}/reuse-openneuro-annotations.ts`,
    find: 'keepRedundant: argv.includes("--keep-redundant"),',
    replace: 'keepRedundant: !argv.includes("--keep-redundant"),',
    note: "the default flips back to keeping redundant columns",
  },
  {
    id: "U11-empty-levels-guard-removed",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: 'if (Object.keys(levels).length === 0) return { drop: "levels_empty" };',
    replace: "",
    note: "an upstream diagnosis column that maps nothing withdraws the mechanical healthy control from unreviewed data",
  },
  {
    id: "U12-gender-note-dropped",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: "if (!isNamedSex(column.name) && text !== null) {",
    replace: "if (false) {",
    note: "a column not named sex that is read as sex is not flagged in the evidence",
  },
  // Review round 3: the survivors of the delta review, the lookup contract, the date slack.
  {
    id: "B22-zero-share-of-all-rows",
    layer: "binder",
    file: `${NEUROBAGEL}/curation-bind.ts`,
    find: "zeros / parsed >= ZERO_PLACEHOLDER_SHARE",
    replace: "zeros / table.rows.length >= ZERO_PLACEHOLDER_SHARE",
    note: "missing cells dilute a placeholder column of zeros",
  },
  {
    id: "B23-small-ages-count-as-zeros",
    layer: "binder",
    file: `${NEUROBAGEL}/curation-bind.ts`,
    find: "if (age === 0) zeros++;",
    replace: "if (age < 0.5) zeros++;",
    note: "newborns in decimal years are read as placeholder zeros",
  },
  {
    id: "B24-unreadable-participants-json-throws",
    layer: "binder",
    file: `${NEUROBAGEL}/curation-bind.ts`,
    find: "  } catch {\n    return null;\n  }",
    replace: "  } catch (error) {\n    throw error;\n  }",
    note: "a malformed participants.json makes the binder throw",
  },
  {
    id: "T19-flag-ignores-sex-withheld",
    layer: "transform",
    file: `${NEUROBAGEL}/transform.ts`,
    find: "withheld.age + withheld.diagnosis + withheld.sex > 0",
    replace: "withheld.age + withheld.diagnosis > 0",
    note: "withholding only the sex is not flagged",
  },
  {
    id: "T20-flag-ignores-age-withheld",
    layer: "transform",
    file: `${NEUROBAGEL}/transform.ts`,
    find: "withheld.age + withheld.diagnosis + withheld.sex > 0",
    replace: "withheld.diagnosis + withheld.sex > 0",
    note: "withholding only the age is not flagged",
  },
  {
    id: "T21-flag-ignores-diagnosis-withheld",
    layer: "transform",
    file: `${NEUROBAGEL}/transform.ts`,
    find: "withheld.age + withheld.diagnosis + withheld.sex > 0",
    replace: "withheld.age + withheld.sex > 0",
    note: "withholding only the diagnosis is not flagged",
  },
  {
    id: "L18-lookup-answers-none-for-a-broken-file",
    layer: "loader",
    file: `${NEUROBAGEL}/curation.ts`,
    find: 'return { status: "stop", problems: error.problems };',
    replace: 'return { status: "none" };',
    note: "a writer is told there is no entry when the file does not load, and publishes the false claim",
  },
  {
    id: "L19-another-file-registers-entries",
    layer: "loader",
    file: `${NEUROBAGEL}/curation-resolve.ts`,
    find: 'import { isLoaded } from "./curation-loaded";',
    replace: 'import { isLoaded, markLoaded } from "./curation-loaded";\nvoid markLoaded;',
    note: "a module other than the loader can mark an entry as checked",
  },
  {
    id: "L20-no-time-zone-slack",
    layer: "loader",
    file: `${SCRIPTS}/fixtures-io.ts`,
    find: "now + 24 * 60 * 60 * 1000",
    replace: "now",
    note: "a review dated today in a zone ahead of UTC is rejected",
  },
  {
    id: "L21-committed-file-without-today",
    layer: "loader",
    file: `${SCRIPTS}/fixtures-io.ts`,
    find: "parseCuration(text, { today: latestReviewDate(now) })",
    replace: "parseCuration(text)",
    note: "the committed file's dates are never compared with today",
  },
  {
    id: "U13-some-codes-confirm-all",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: "numeric.every(",
    replace: "numeric.some(",
    note: "one described code confirms a set of codes of which another is not described",
  },
  {
    id: "U14-sex-matched-inside-a-longer-word",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: 'new RegExp(`\\\\b${t.label}\\\\b`, "i")',
    replace: 'new RegExp(`${t.label}`, "i")',
    note: "the word female confirms a code mapped to Male",
  },
  {
    id: "U15-merge-refusal-removed",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: "if (result.skipped.length > 0 && !options.skipAuthored) throw new MergeRefusal(result.skipped);",
    replace: "",
    note: "the merge neither refuses nor skips an authored entry, but overwrites it",
  },
  {
    id: "U16-skip-authored-still-overwrites",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: '          review: typeof review === "string" ? review : "(unreadable)",\n        });\n        continue;',
    replace: '          review: typeof review === "string" ? review : "(unreadable)",\n        });',
    note: "--skip-authored reports an authored entry as skipped and overwrites it anyway",
  },
  {
    id: "U17-skip-authored-by-default",
    layer: "upstream",
    file: `${SCRIPTS}/reuse-openneuro-annotations.ts`,
    find: 'skipAuthored: argv.includes("--skip-authored"),',
    replace: "skipAuthored: true,",
    note: "the merge silently skips authored entries instead of refusing",
  },
  // The owner's rule: a sex column not named `sex` is read as sex only if its description says sex.
  {
    id: "U18-sex-test-flipped",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: "if (description !== null && /\\bsex\\b/i.test(description)) return null;",
    replace: "if (description !== null && !/\\bsex\\b/i.test(description)) return null;",
    note: "a gender column is read as sex when its description does NOT say sex",
  },
  {
    id: "U19-gender-test-flipped",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: 'if (description !== null && /gender/i.test(description)) return "sex_described_as_gender";',
    replace:
      'if (description !== null && !/gender/i.test(description)) return "sex_described_as_gender";',
    note: "a description that says gender no longer keeps the column out, and one that does not does",
  },
  {
    id: "U20-sex-rule-dropped",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: 'if (kind === "sex") {\n      const refusal',
    replace: "if (false as boolean) {\n      const refusal",
    note: "upstream's reading of every gender column as sex is carried, as before the rule",
  },
  {
    id: "U21-named-sex-not-exempt",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: "  if (isNamedSex(name)) return null;\n",
    replace: "",
    note: "a column literally named sex needs a description too, and is lost without one",
  },
  {
    id: "U22-left-out-column-claims-the-sex-slot",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: "        bump(result.dropped, refusal);\n        continue;",
    replace:
      "        bump(result.dropped, refusal);\n        keptKinds.add(kind);\n        continue;",
    note: "a gender column left out still takes the dataset's one sex slot, and the real sex column is dropped as a second",
  },
  {
    id: "U23-gender-only-as-a-whole-word",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: "/gender/i.test(description)) return",
    replace: "/\\bgender\\b/i.test(description)) return",
    note: "transgender, genders or cisgender in a description no longer says gender",
  },
  {
    id: "U24-sex-wins-over-gender",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: 'if (description !== null && /gender/i.test(description)) return "sex_described_as_gender";\n  if (description !== null && /\\bsex\\b/i.test(description)) return null;',
    replace:
      'if (description !== null && /\\bsex\\b/i.test(description)) return null;\n  if (description !== null && /gender/i.test(description)) return "sex_described_as_gender";',
    note: "a description that names both sex and gender is read as sex",
  },
  {
    id: "U25-sex-matched-inside-a-longer-word-in-a-description",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: "/\\bsex\\b/i.test(description)) return null;",
    replace: "/sex/i.test(description)) return null;",
    note: "sexual, Essex or sexes in a description says sex",
  },
  {
    id: "U26-description-read-from-levels",
    layer: "upstream",
    file: `${SCRIPTS}/upstream-annotations.ts`,
    find: 'return isRecord(entry) && typeof entry.Description === "string" ? entry.Description : null;',
    replace: "return isRecord(entry) ? JSON.stringify(entry) : null;",
    note: "any text of the column's entry, a Levels text included, counts as its description",
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
  if (process.argv.includes("--check-anchors")) {
    // No tests: only that every mutant still applies to the source as it is.
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
