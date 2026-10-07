# ADR 0087: The upload preflight screens on the uploader's machine, refuses direct identifiers, records its verdict with the attestation, and is never trusted

**Status:** accepted
**Date:** 2026-10-06
**Owner:** Seyed Yahya Shirazi

Epic #1610, issue #1613.
Builds on ADR 0086 (the publication screen and its gate), ADR 0024 (the deposit attestation) and ADR 0085 (what a correction costs once the bytes are in the bucket).

## Context

The uploader is the one person who can fix a header before it is copied anywhere.
Once an upload has run, the bytes sit in a versioned bucket under Object Lock and in git history,
and taking them out again is the procedure ADR 0085 describes.

But a check in the CLI cannot be the gate.
Uploads go straight to S3 with scoped credentials, raw git-annex and the web upload never run the CLI,
and a modified client can say anything (design review on #1613).
The publication screen (ADR 0086) is the check that holds.

`nemar dataset upload` sends dataset content first at the create call, which carries the path of every data file,
and before that at the co-author step, which reads author names out of `dataset_description.json` for ORCID matching.

## Decision

**The upload screens the dataset on the uploader's machine before anything is sent,
refuses direct identifiers with no override,
lets a lesser verdict through only on an explicit acknowledgment that names every condition found,
screens again right before the create call,
and records the verdict inside the deposit attestation, where nothing reads it as permission.**

- **Where.**
  The preflight runs after the account checks and before the tool checks, BIDS validation, the co-author step and the create call.
  It reads local files only and makes no network request.
- **The same question.**
  It hands the files to the fleet scan's `scanDatasetFromManifest` with the `clone` source, as the publication screen does,
  through a local reader: 256 bytes of every EDF/BDF header and nothing more of a recording,
  and side files and tables up to `LOCAL_SCAN_LIMITS`, the one definition both screens use.
  The verdict is therefore `classifyDataset`'s.
  This is the first import of `scripts/` into the CLI bundle, and it is deliberate: one verdict function.
- **What it screens.**
  The files the upload plan lists (`.git` and `.nemar` at the top excluded, and a FILE named `.gitattributes`, as in `collectFileManifest`, whose `find` still descends into a directory of that name).
  It walks them itself so that what it cannot see is counted:
  a directory it cannot list makes the scan `tree-truncated`,
  and a broken link, a special file or a file that cannot be opened is never opened,
  and counts as a failed read when it is a file the scan reads (a recording, a table, a side file).
  Any other such path is in the file count and the path rules only.
- **What it decides** (`screenGate`'s three sets):
  `clean`, `dates-only` and `no-recordings` proceed.
  `direct-identifiers` refuses, also under `--dry-run`, and no flag changes that (as in ADR 0086).
  `review`, `unchecked`, `not-screened` and `clean-edf-only-others-unscreened` proceed only on an acknowledgment:
  a prompt that defaults to no (Ctrl+C cancels and exits 130),
  or `--acknowledge-identifier-preflight`, repeatable or comma-separated, which must name exactly the conditions found.
  The verdict alone is not enough to name, because `classifyDataset` ranks `review` above an incomplete read and both above unparsed recordings:
  a scan that found one image and could not read a header says only `review`.
  So the conditions are the verdict, plus `unchecked` when the scan is incomplete, plus `not-screened` when there are recordings it cannot parse (`preflightConditions`).
  No fewer is accepted, so a new condition stops a pipeline;
  and no more, so a list of every word is not a standing waiver.
  The kinds inside `review` are not bound: a new kind of finding under an acknowledged `review` passes.
  `--yes` never acknowledges (as ADR 0024 rules for the attestation).
  `--dry-run` never prompts; it says what a real upload would need, and goes on to show the plan.
- **Screened again before anything is sent.**
  Between the preflight and the create call come validation, the license, provenance and attestation prompts and the final confirmation,
  which take as long as a person likes, and some of them write into the tree.
  So the tree is screened again right before the create call, and that scan is the record sent.
  The upload stops if the second scan finds direct identifiers, or any condition the acknowledgment did not cover.
- **No free text.**
  The acknowledgment records only how it was given (`prompt` or `flag`).
  This is stricter than the admin's recorded reason in ADR 0086: no text the uploader writes reaches D1 by this path.
- **Words.**
  The report contract's own verdicts and count lines (`describePreflight`).
  No value is printed, and no path, because a path can be a name and an upload's output can land in a public CI log.
  Format names come from file names (`sourcedata/Smith.John` yields `.john`), so the preflight keeps only names on a closed list (`KNOWN_FORMATS`) and folds the rest into `.other`; the door refuses any other.
  The publication report still accepts any extension-shaped name.
- **The record.**
  It is stored as `identifier_preflight` inside the `datasets.attestation` JSON, so no column is spent (ADR 0034).
  `parseUploaderPreflight` is the door: closed kinds, counts and fixed words,
  no dataset identity, every field required, a status no cleaner than its counts,
  and an acknowledgment present exactly when the verdict needs one.
  A record the door refuses is not stored, and the response names the parser's fixed word.
  It never fails the upload, so a CLI newer than the Worker can still upload.
  A resume from the CLI's local config never reached the create route, so its attestation used to be dropped.
  It now records both through `PUT /datasets/:id/attestation` (owner or admin, private and never published).
  The detail route serves none of it.
  `readRecordedPreflight` reads it back as `recorded`, `absent` or `unreadable`, and neither of the last two is ever clean.
- **Never trusted, never a refusal of its own.**
  No gate reads the record as permission.
  A record that could not be stored is a warning to the uploader, and the upload goes on.
  A scan that produced no verdict stops the upload, because unknown is never clean.

## Consequences

- An upload of recordings the scanner cannot parse (BrainVision, EEGLAB, FIF and others) now asks once.
  Pipelines must pass `--acknowledge-identifier-preflight not-screened`.
  That is intended, as with the attestation flags: nobody acknowledges a finding they were not shown.
- A pipeline flag is bound to the conditions found, so a newly incomplete read or a new unparsed format stops the pipeline instead of riding on an old acknowledgment.
  A new kind of finding inside `review` does not.
- A deliberate refusal or cancel exits non-zero without the CLI's "attach the log to an issue" nudge; a scan that could not finish keeps it.
- The uploader learns kinds and counts, not which files.
  Finding the file is the uploader's work, by design, because the output can be public.
- A false positive on a direct identifier blocks the upload until the scanner is fixed, as at publication.
- What the preflight does not cover:
  later pushes (`nemar dataset push`, `nemar dataset update`), the web upload and raw git-annex;
  formats other than EDF and BDF, which are counted and never read;
  the text of a symlink's target, which git stores;
  files the CLI writes after the second scan (the `.nemar` metadata and the CI workflow);
  and files that `.gitignore` keeps out of the commit, which it screens anyway.
- A dry run whose verdict needs an acknowledgment goes on past the preflight to the remaining local steps of the preview;
  at a terminal that includes the co-author ORCID lookup, which reads author names (public by design) from `dataset_description.json`.
- The record is readable today and read by nothing that decides.
  Showing it beside the publication screen, and comparing it in the sweep, are later work (Phase 5).

## Alternatives considered

- **Advisory only: print and continue.**
  A name in a header is a fact, and advisory is how review was bypassed before (ADR 0086).
- **An override for direct identifiers.**
  Rejected for the reason ADR 0086 gives: the cost of a published name exceeds the cost of a delayed upload, and a false positive is fixed once, in the scanner.
- **A free-text reason, like the admin's.**
  Uploader text in D1 is an unbounded channel for the very values this guards.
- **A flag with no value.**
  A standing flag in a pipeline would cover every future verdict without anyone looking.
- **Refusing the create when the record does not parse.**
  Version skew would block uploads over a field nothing trusts.
- **Reusing `collectFileManifest` for the walk.**
  It drops what it cannot stat, and an unreadable directory makes it return an empty list.
- **Gating on the record server side.**
  The client is not trusted; the publication screen is the gate.
- **A column or a side table.**
  ADR 0034, and the attestation is already the one document about the deposit.

## Receipts

- Design note: comment on #1613 (2026-10-06).
- Contract: `shared/identifier-screen-report.ts` (`parseUploaderPreflight`, `describePreflight`), `test/identifier-preflight-contract.test.ts`.
- Step: `src/lib/upload/identifier-preflight.ts`, `test/upload-identifier-preflight.test.ts`, `test/upload-identifier-preflight-cli.test.ts`.
- Recording: `backend/src/services/identifier-preflight.ts`, `backend/src/routes/datasets/upload.ts`, `backend/test/identifier-preflight-route.test.ts`, `test/upload-preflight-recording.test.ts`.
