# ADR 0091: A new recording's acquisition dates are set to 1 January of their year, on upload and on import, and nothing already published is changed

**Status:** accepted
**Date:** 2026-10-07
**Owner:** Seyed Yahya Shirazi

Epic #1610, Phase 9 (branch `feature/issue-1616-normalize-dates`).
Amends ADR 0090 (policy B) for new data, and builds on ADR 0085 (the scrub rules and their proofs), ADR 0087 (the upload preflight) and ADR 0089 (the importer's scrub).

## Context

ADR 0090 kept every acquisition date as it was and warned about the ones finer than year and month.
On 2026-10-07 the maintainer decided that, for NEW uploads and imports, the day-level acquisition date is removed right away and automatically, "without even telling users": no warning and no acknowledgment for what the tool fixes itself.
Datasets that are already public are not touched by this decision.

When the phase was assigned, the decision was given this reading, which this ADR records as the rule:
"removed" means the date is set to 1 January of the same year in the stored copy;
the year is kept, the time of day is kept, and nothing else in the file changes;
the tool prints at most one neutral line with a count (fixed words, no value, not a warning, no prompt), and no acknowledgment is ever asked for it.

## Decision

**A new recording's acquisition dates, as the scanner reads them, are set to 1 January of their year by one shared rule, in the importer's prepare step and in `nemar dataset upload` before anything is sent; the year, the time and every other byte are kept, what the rule cannot set safely is left and warned about as before, and nothing already published is changed.**

### The rule (`shared/identifier-scrub.ts`)

`normalizeEdfDates` rewrites an EDF, EDF+ or BDF header (the first 256 bytes) and touches nothing else.
It finds the dates with the scanner's own reading (`edfAcquisitionDates` in `shared/identifier-scan.ts`, the same helper `scanEdfHeader` uses for `edf-startdate` and `edf-recording-startdate`), so what it writes is what the scanner exempts.

- **The header start date**, bytes 168 to 176 in `dd.mm.yy`, when the scanner parses it as a date (two digits, a dot, two digits, a dot, two digits, with a day from 1 to 31 and a month from 1 to 12) and it is not already 1 January: `dd` and `mm` become `01`.
  The two year digits are never read or written.
  The EDF specification reads `85` to `99` as 1985 to 1999 and `00` to `84` as 2000 to 2084; because the bytes do not change, any reader applying that pivot, or any other, reads the same year before and after.
  The start time, bytes 176 to 184, is not touched.
  Text the scanner does not parse as a date (`  .  .  `, `14/03/23`, `00.00.00`) is left, and is still reported as `edf-startdate-unparsed`.
- **The EDF+ date after `Startdate`** in the recording identification, when the field starts with the keyword (in any letter case), the date the scanner reports there is the whole token after it, and that token is `dd-MMM-yyyy` (two digits, three letters, four digits): `dd` becomes `01` and the three month letters become `JAN`, each letter keeping its case, so `14-mar-2023` becomes `01-jan-2023`.
  The separators and the four-digit year stay.
  A three-letter word the scanner reads as a month in another language (`OKT`) becomes `JAN` the same way.
- **All or nothing for one header.**
  If the recording field holds an acquisition date in any other layout (`14.03.2023`, `2023-03-14`, `1-MAR-2023`, `14-MAR-23`, `14MAR2023`, or a date in a free-text field), the header is left byte for byte as it is, both dates included.
  Setting only the header start date would leave the day in the other field and the two dates disagreeing.
  Those dates remain review findings and ADR 0090's warning covers them.
- **The proof.**
  `verifyDateNormalization` accepts a result only when it is the same size, differs from the original only in the day and month bytes of the dates the scanner reports, the scanner then reports neither date kind, and every other finding (kind, severity, field, shape) is what it was.
  The rule throws `DateNormalizationUnverified` rather than return bytes that fail it.

`normalizeScansTableDates` is the scans-table rule.
It reads the `acq_time` cells the screen reads (`acqTimeCells`: a byte-order mark dropped, rows split at a newline, the first column whose header is exactly `acq_time`), and in a value the scanner reports (`scanAcqTime`: it starts `YYYY-MM-DD` and is not `-01-01`) sets `MM-DD` to `01-01`.
The year, the time of day, a fraction of a second, a zone, every other cell and every byte between them stay; a table that is not UTF-8 is not edited.
Its proof is that the result decodes, the screen reports no dated value in it, and only month and day digits differ.

These are separate from `scrubEdfHeader`, which does not call them.
ADR 0085's scrub of published data is byte for byte what it was: two golden digests in `test/identifier-dates.test.ts`, of the scrub's and the scanner's output over a seeded corpus, were computed from the epic tip before this phase and are asserted unchanged.

### Where it applies

**The importer (ADR 0089), on a first import only.**
The header patch of a recording is `scrubEdfHeader` and then `normalizeEdfDates`, each proven, through the scrub's own path: an annexed recording is downloaded, hashed against its key, patched, annexed as SHA256E under a new key, uploaded with the location-log proof, and its upstream key retired as dead, so the copy phase never copies the original.
A recording whose only change is its date gets a new key the same way.
The same upstream bytes give the same patch and the same key, so a second first import of the same upstream names the same keys.
Dated `acq_time` values of inline `_scans.tsv` files are set at the head of the tree, in the same step as the JSON blanking.
A date never refuses an import, because a date never gates (ADR 0090): a recording whose only change would be its date, and whose key is not SHA256E, keeps its date; and the recordings whose only change would be their date are downloaded only when all of them fit in the bound (`--normalize-max-gb`, 5 GiB by default) after what the identifier scrub must download, and otherwise none of them is, so a dataset is not left half set.
The ledger line (`import-scrubbed`) carries counts only: `headers_dates_normalized`, `git_held_recordings_dates_normalized`, `headers_dates_over_bound`, `headers_dates_left`, and five `scans_tables_*`/`scans_values_normalized` counts, beside the scrub's own.
A tree's provenance file gets a sentence that says the dates were set (`dates-set`, or `scrubbed-and-dates-set`), because its checksums describe the upstream files.
The commit body and the import log say how many dates were set, in counts.

**`nemar dataset upload`, for recording headers only.**
The upload makes the uploader's directory the dataset's git-annex repository and annexes the files where they are, so the stored bytes are the directory's bytes; the rule therefore changes the file in that directory, which the upload already turns into a link into the annex.
`planUploadDates` runs before the identifier preflight and only reads: it asks the rule about every EDF and BDF file the preflight reads, and plans a file only when changing it is safe.
The preflight screens the planned headers as they will be written, so a date the upload sets is not warned about and one it leaves is; a dry run plans, screens and stops, and changes no file.
After the final confirmation and before the second screen, `applyUploadDates` copies each planned file into the dataset's own `.nemar/` directory (excluded from the upload and from git), writes the new header into the copy, syncs it, checks the copy's size and header and the original's device, inode, size and modification time again, and renames the copy over the original.
The second screen then reads the files as they are and is the record that is sent.
A file is never planned, or is left at apply time, when git tracks it (which includes every file git-annex tracks), when it cannot be told which files git tracks (a repository and no git), when it is a symbolic link, when the uploader cannot write it or its directory or does not own it, when it is on another filesystem than the dataset's directory, or when it changed after the plan or while it was copied.
The upload edits no scans table: its dates stay, and ADR 0090's warning names them.
The one line printed is `Acquisition dates in N recording header(s) are set to 1 January of their year before upload.` (`dateNormalizationLine` in `shared/identifier-screen-report.ts`), dim, under the verdict.

**Nothing else.**
ADR 0085's scrub, the scheduled sweep (ADR 0088), a re-import (the tree is the dataset NEMAR already holds, which may be public), `nemar dataset commit`, `nemar dataset push` and `nemar dataset update` do not run the rule.
Datasets already on NEMAR keep their dates, and ADR 0090's warning still applies to them.

### Why 1 January

It is the only value that keeps the year and makes the dataset screen clean for dates.
The scanner's year-only test is exactly 1 January (`isYearOnly`, and the 1 January test for the header start date and for `acq_time`), and the first of any other month is still counted (ADR 0090, Consequences).
The EDF header has no month-only form: `dd.mm.yy` must hold a day and a month, so there is no way to write "March 2023" there.
Setting both day and month also removes the month, which the maintainer's reading accepts.

## Consequences

- **What an analysis loses.**
  The day and month of every set date are gone from the stored copy.
  Analyses that need absolute dates lose them: circadian or seasonal effects, the order and spacing of sessions recorded on different days (they all fall on 1 January, with their times of day kept), age at recording finer than the year, and synchronization with other devices or records by calendar date.
  Relative timing inside a recording is unaffected: EDF+ annotations are offsets from the start, and the start time is kept.
  This was the maintainer's decision.
- **The uploader's own files change.**
  After an upload the dataset directory holds the copies with the dates set; a file that was the uploader's only copy loses its day and month, and the upload says so only in the count line.
  A hard link elsewhere keeps the original, because the rename replaces the directory entry and not the file's contents.
- **No guarantee that no date remains.**
  The rule sets only what the scanner reads and the rule can rewrite: EDF and BDF headers, and on import inline scans tables.
  It does not read or change BrainVision, EEGLAB, FIF or other headers, sessions tables, sidecar fields, file names, or dates inside annotations; a header in a layout the rule leaves keeps its dates; and an upload leaves what it cannot change safely.
  ADR 0090's warning still appears for every date finding that remains, with its count, and only for those; the gate, the verdicts and the acknowledgment rules are unchanged.
- **Git history keeps the originals of git-held content.**
  On an import, a recording git held and a scans table are changed at the head of the tree, and upstream's commits, which the push carries, still hold the dated originals; for a public mirror that history is public.
  Only ADR 0085's history rewrite removes them.
  Because a date never gates, this does not hold the publication: `historyHoldsOriginals` still counts only identifier fixes, and an annexed recording's original is never copied, so NEMAR's bucket does not hold it.
- **Large imports keep their dates by default.**
  Setting the date of an annexed recording means downloading all of it, because its new key is the hash of its whole content.
  A dataset whose date-only recordings do not fit in the bound keeps all of their dates (`headers_dates_over_bound`), and the screen warns about them, unless an operator runs the import with a larger `--normalize-max-gb`.
- **The new keys.**
  A first import names a new key for every dated recording and retires upstream's, which also makes a later re-pull of the same upstream bytes reproduce the same keys without a declaration.
  The keys are not ADR 0085's: that patch is `scrubEdfHeader` alone.
- **ADR 0090's words stay right.**
  "NEMAR does not change them" is shown only for dates that remain after this rule, which NEMAR did not change.
- **Versions.**
  The import runs the CLI that `nemarDatasets/.github` installs, and the upload runs the uploader's CLI, so neither sets a date until that CLI is released; an older CLI warns as ADR 0090 says.
  The Worker is unchanged.
- **docs.nemar.org** describes ADR 0090's behavior in pages that live in a private repository and are not edited here; the pull request lists them for the maintainer.

## Alternatives considered

- **Coarsen to year and month (policy A of ADR 0090).**
  The EDF header cannot hold a month alone, and the scanner counts the first of a month, so the result would not screen clean; the maintainer asked for the date removed.
- **Extend `scrubEdfHeader`.**
  It is ADR 0085's rule for published data, whose proof (`verifyScrub`) requires bytes 168 to 256 to stay identical; folding the date into it would change that rule and its proof for every correction.
  A separate rule with its own proof keeps ADR 0085 byte for byte.
- **Set what can be set in a header and leave the rest.**
  It leaves the day in one field and creates two disagreeing dates; all or nothing per header avoids both.
- **Edit the uploader's scans tables too.**
  Tables are text the uploader writes and edits, and this phase was scoped to leave them on upload; the warning names their dates.
- **Keep a copy of each original for the uploader.**
  It doubles the disk an upload needs and leaves dated copies in the dataset directory; left for the maintainer below.
- **Refuse an import whose date-only recordings do not fit the bound.**
  That would make dates gate an import, which ADR 0090 rules out.

## Decisions left to the maintainer

1. Whether the upload should keep a restorable record of the original dates for the uploader, or offer a way to opt out, now that it changes the uploader's own files with one count line.
2. Whether large imports should run with a larger bound, or on a host that can, so that their dates are set rather than left (`headers_dates_over_bound`).
3. Whether git-held recordings and scans tables of a public mirror should have their dated originals removed from history (ADR 0085's rewrite), or be held for a person.
4. Whether the rule should also rewrite slot dates in other layouts and dates in free-text recording fields, which it now leaves and the warning names.
5. Whether files added later by `nemar dataset commit`, `push` or `update` should have their dates set too.

## Receipts

- Rule, proofs and tests: `shared/identifier-scrub.ts` (`normalizeEdfDates`, `verifyDateNormalization`, `normalizeScansTableDates`), `shared/identifier-scan.ts` (`edfAcquisitionDates`, `acqTimeCells`, `scanScansTable`), `test/identifier-dates.test.ts` (including a read-back by the independent `edfio` reader and the golden digests).
- Importer: `src/lib/import-scrub.ts`, `test/import-scrub.test.ts` ("a first import sets acquisition dates to 1 January", "a re-import changes no date").
- Upload: `src/lib/upload/date-normalization.ts`, `src/lib/upload/identifier-preflight.ts`, `src/commands/dataset.ts`, `test/upload-date-normalization.test.ts`, `test/upload-identifier-preflight-cli.test.ts`.
- Provenance sentences: `shared/privacy-correction-text.ts`.
