/**
 * The webhook Zarr gate must stay a superset of what the converter reads (#1103).
 *
 * `ZARR_DATA_EXTENSIONS` / `isZarrTriggerPath` in
 * `backend/src/routes/webhooks/github.ts` decide whether a push re-dispatches
 * conversion. `PRIMARY_EXTS` / `COMPANION_EXTS` / `DIR_RECORDING_EXTS` in
 * `scripts/zarr/generate_zarr.py` decide what the converter actually builds a
 * store from. If the gate is narrower than the converter, a push to a real
 * recording never triggers conversion and the serving copy silently stops
 * tracking the dataset -- nothing errors, because the whole symptom is an event
 * that never happens. That drift has already shipped once: `.con`/`.sqd`/`.kdf`
 * were missing, leaving `on007763`'s 35 KIT recordings stale until #1101.
 *
 * Until now the two constants lived in different repositories and different
 * languages, so only a doc comment held them together. Epic #1108 Phase 1
 * (#1109) moved the converter into this repo, which makes the check a plain
 * same-repo file read.
 *
 * KNOWN SCOPE LIMIT: 4D/BTi carries no extension at all -- BIDS names its
 * directory `sub-<label>..._meg/` -- so it appears in none of the constants
 * parsed here and cannot be covered by this check. The gate's `isBtiMember`
 * and the converter's `bti_recordings` are kept in sync by hand; the gate is
 * deliberately the wider of the two, which limits the damage. Covering BTi
 * would mean parsing both detection rules, not two constant tuples.
 *
 * Deliberately parses both sides out of source text rather than importing
 * `ZARR_DATA_EXTENSIONS`: the gate is module-private, and a test is not a
 * reason to widen the export surface that `github-export-surface.unit.test.ts`
 * pins.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./setup";
import { isZarrTriggerPath } from "../backend/src/routes/webhooks/github";

const REPO_ROOT = join(import.meta.dir, "..");
const CONVERTER = join(REPO_ROOT, "scripts/zarr/generate_zarr.py");
const GATE = join(REPO_ROOT, "backend/src/routes/webhooks/github.ts");

/** Extensions from a Python tuple-of-string-literals assignment, dots stripped. */
function pyTupleExts(source: string, name: string): string[] {
  const m = source.match(new RegExp(`^${name}\\s*=\\s*\\(([^)]*)\\)`, "m"));
  if (!m) throw new Error(`${name} not found in generate_zarr.py`);
  return [...m[1].matchAll(/"\.([a-z0-9]+)"/g)].map((x) => x[1]);
}

/** A Python `NAME = ".ext"` single-value constant, dot stripped. */
function pyScalarExt(source: string, name: string): string {
  const m = source.match(new RegExp(`^${name}\\s*=\\s*"\\.([a-z0-9]+)"`, "m"));
  if (!m) throw new Error(`${name} not found in generate_zarr.py`);
  return m[1];
}

/**
 * Extensions from a Python tuple of NAMES rather than literals, e.g.
 * `DIR_RECORDING_EXTS = (CTF_DS_EXT, MEFD_EXT)`, resolving each name.
 *
 * Parsed rather than hand-enumerated on purpose: hardcoding today's two names
 * would keep this file green while silently not checking a third directory
 * format someone adds later -- which is precisely the silent-drift failure the
 * whole test exists to catch.
 */
function pyNameTupleExts(source: string, name: string): string[] {
  const m = source.match(new RegExp(`^${name}\\s*=\\s*\\(([^)]*)\\)`, "m"));
  if (!m) throw new Error(`${name} not found in generate_zarr.py`);
  const names = [...m[1].matchAll(/([A-Z][A-Z0-9_]+)/g)].map((x) => x[1]);
  if (names.length === 0) throw new Error(`${name} parsed to zero members`);
  return names.map((n) => pyScalarExt(source, n));
}

const converter = readFileSync(CONVERTER, "utf8");
const gateSource = readFileSync(GATE, "utf8");

const primaryExts = pyTupleExts(converter, "PRIMARY_EXTS");
const companionExts = pyTupleExts(converter, "COMPANION_EXTS");
const dirRecordingExts = pyNameTupleExts(converter, "DIR_RECORDING_EXTS");

describe("zarr dispatch gate vs converter (#1103)", () => {
  test("the converter's constants are parsed, not silently empty", () => {
    // Guards the regexes themselves: a rename upstream would otherwise make
    // every assertion below vacuously pass over an empty list.
    expect(primaryExts.length).toBeGreaterThanOrEqual(8);
    expect(companionExts.length).toBeGreaterThanOrEqual(3);
    expect(dirRecordingExts.length).toBeGreaterThanOrEqual(2);
    expect(dirRecordingExts).toContain("ds");
    expect(primaryExts).toContain("con"); // the #1101 regression, pinned
  });

  test("every primary and companion extension passes the gate", () => {
    const missed = [...primaryExts, ...companionExts].filter(
      (ext) => !isZarrTriggerPath(`sub-01/eeg/sub-01_task-rest_eeg.${ext}`),
    );
    expect(missed).toEqual([]);
  });

  test("every directory-recording format passes the gate", () => {
    const missed = dirRecordingExts.filter(
      (ext) => !isZarrTriggerPath(`sub-01/meg/sub-01_task-rest_meg.${ext}/data.bin`),
    );
    expect(missed).toEqual([]);
  });

  test("the gate lists no extension the converter does not read", () => {
    // The other drift direction: a gate wider than the converter dispatches
    // runs that then convert nothing. Not silent data loss, but wasted work
    // with no signal, so it is worth failing on too.
    const m = gateSource.match(/ZARR_DATA_EXTENSIONS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
    expect(m).not.toBeNull();
    const gateExts = [...(m?.[1] ?? "").matchAll(/"([a-z0-9]+)"/g)].map((x) => x[1]);
    expect(gateExts.length).toBeGreaterThanOrEqual(8);

    const known = new Set([...primaryExts, ...companionExts]);
    expect(gateExts.filter((ext) => !known.has(ext))).toEqual([]);
  });
});
