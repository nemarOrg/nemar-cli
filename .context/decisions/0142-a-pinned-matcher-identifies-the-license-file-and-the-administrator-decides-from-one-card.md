# ADR 0142: A pinned matcher identifies the license file, and the administrator decides from one card

**Status:** accepted
**Date:** 2026-11-27
**Accepted:** 2026-11-27
**Owner:** Seyed Yahya Shirazi (decisions of 2026-11-27)

Epic #2449, Phase 0 (#2450); part of #2182.
Partially supersedes Architecture Decision Record (ADR) 0102: section 3's LICENSE bullet (the 4,000-character cap as the only handling of the root LICENSE),
and section 5's rule that a cut LICENSE lowers `authors_and_license` to at best `unknown`, for a LICENSE file this ADR identifies conclusively.
Extends ADR 0139: decision 9's reproducibility record gains the matcher version, and decision 7's lineage gains the time it was resolved.
ADR 0102 section 2 (what a model may receive) and ADR 0139 decision 1 (what denies automatically) stand unchanged.

## Context

On 37 production publication reviews, the root LICENSE was cut at its 4,000-character cap in 29, and `authors_and_license` was `unknown` in 27 of them.
A Creative Commons (CC) 4.0 legal code is about 17,000 to 19,000 characters (CC-BY-4.0 is 17,023 in the Software Package Data Exchange (SPDX) text),
so every dataset that ships the real license text loses that question, whatever the text says.
The license lineage was a stale `unresolved` at review time in 13 of the 37, and 9 of those 13 resolve today;
osf.io sources do not resolve, a Digital Object Identifier (DOI) cut out of a README (`10.17605/o`) was taken as a source,
and a `needs_permission` outcome does not show the license the source declares.
The administrator reads all of this across `nemar admin dataset publish show`, the lineage command and the website, and no one place says what to do next.
One description key is withheld from the model in 34 of the 37 reviews, and the report does not say which.

## Decision

### 1. The review job identifies LICENSE with askalono, pinned

- **The matcher is askalono 0.5.0** (Rust, Apache-2.0, `github.com/jpeddicord/askalono`), the release of 2024-10-22 and the project's last: the repository is archived.
  The job uses the release asset `askalono-Linux.zip`, a static `x86_64-unknown-linux-musl` binary, never a build of our own and never a version the dispatch payload names.
  - Zip SHA-256: `8a007355b700137b48e7e39aab5d083acb9a0926f20c064ab4476b1624390e52` (3,152,240 bytes).
  - Extracted `askalono` SHA-256: `2870cbd60c2edb3ff4514e595fe39fcd5c735828b1ded1a0371f5c56da0704d6` (6,359,440 bytes).
- **Where it is pinned.**
  `.github/dataset-workflows/run-publication-review.yml` downloads the zip and refuses it unless both digests match constants in that file,
  and the review script checks the binary's digest again against its own constant from nemar-cli `main` before it runs it.
  A missing binary or a digest mismatch is never a pass and never a denial: the identification is `unreadable` and the matcher word is `unavailable`,
  and LICENSE is handled as ADR 0102 handled it.
- **Its license data.**
  The binary embeds a cache built from the `spdx/license-list-data` submodule at the 0.5.0 tag, commit `7bd3f753d70c065dbf270598cc9736169b29835d`:
  the build of 2022-05-17 whose `licenseListVersion` is `65dd995`, two builds after tag v3.17.
  The embedded cache is a default feature, so the `--cache` flag and any cache file in the working directory are ignored.
- **The matcher version the review records** is `askalono-0.5.0+spdx-65dd995`, the release and the `licenseListVersion` the data declares.
  It joins ADR 0139 decision 9's record and every surface that prints it.
- **How askalono scores.**
  It normalizes both texts (Unicode, punctuation, whitespace, case, URLs, and it drops title lines and copyright statements),
  takes the set of word bigrams of each, and scores their Sørensen-Dice coefficient, 0 to 1; it reports the best-scoring license.
  With `--optimize` it also finds the line range that holds a license inside a longer file (`containing`, with its own score).
  The CLI reports nothing under 0.8; the library's default threshold is 0.9.
  The job runs `askalono --format json identify --optimize LICENSE` with a timeout, on the file the job already holds, and reads the JSON.
- **The threshold is 0.95**, on the score of the match used (the whole-file score, or the `containing` score when only a span matched).
  Reasons: a bigram Dice approximation on the pinned SPDX texts puts sibling CC 4.0 licenses at 0.964 to 0.979 of each other
  (CC-BY-4.0 against CC-BY-NC-4.0 is 0.979), so no threshold separates siblings and the best-match choice does that;
  a CC-BY-4.0 text with one added "non-commercial purposes only" sentence scores 0.996, so no threshold catches an added restriction either, and the additions rule below does;
  0.95 sits above both askalono defaults, so a weak match is never conclusive, and leaves room for a reformatted copy of a real license.
  Phase 1 measures askalono's own scores on the 37 reviewed LICENSE files and the SPDX texts and records them in its pull request; a change of threshold is a reviewed code change.
- **The identification is a closed fact**, `license_file: {state, spdx, additions}`:
  - `matches`: askalono's best match is at or above the threshold, and it is the license the `License` field names after normalization (`shared/license-lineage.ts`);
  - `matches_other`: the match is at or above the threshold and the field normalizes to a different license;
  - `unrecognized`: no match at or above the threshold, or a match while the field does not normalize, so the two cannot be compared (then `spdx` still names the file's license);
  - `absent`: no LICENSE file;
  - `annexed`: LICENSE is an annexed link or pointer rather than text in git;
  - `unreadable`: the job could not read it in full, it is not UTF-8, the matcher failed or timed out, or the matcher is unavailable.
  `spdx` is the matched SPDX identifier or null; `additions` is a boolean, false unless the state is `matches` or `matches_other`.
- **Additions.**
  The job aligns the file with the matched license's text from the same license-list build askalono embeds
  (`json/details/<id>.json` of license-list-data at commit `7bd3f753`; the source archive at that commit, 37,121,421 bytes, SHA-256 `22e61a9d486ee1f8561ee3cc0ada7286133e677439487a8a49867d6ebc69a4f7`, pinned and checked like the binary),
  as a word diff over text normalized the same way.
  Text outside the matched line range and text inside it that the template does not contain is leftover;
  copyright lines, title lines, whitespace and punctuation are dropped from it.
  Any leftover sets `additions`, with no minimum length, because a false `additions` costs only a model read and the old lowering, which is the safe direction.
- **What the model receives.**
  The platform facts carry `license_file` and the matcher version.
  For a conclusive identification (`matches` or `matches_other`) the model receives only the leftover text, not the license, as the `license` document:
  it passes the same pre-send rules (ADR 0102 section 2) and the same 4,000-character cap, and a cut leftover is a cut document.
  For any other state the model receives LICENSE as ADR 0102 section 3 says.
- **The lowering rule.**
  When the identification is `matches` and the leftover, if any, was sent whole, LICENSE no longer lowers `authors_and_license` to `unknown`;
  the model still answers the question, the authors half included.
  `matches_other` lowers `authors_and_license` to at best `unknown` with the fact word `license_file_differs`, shows a red cue,
  and is not `auto_deny_eligible`: ADR 0139 needs two models to agree, and a platform fact would be identical in both runs.
  Every other state keeps ADR 0102's rule: a cut or withheld LICENSE lowers the question to at best `unknown`, and an absent LICENSE does not lower it.

### 2. Report version 3 and prompt version 3, in two releases

- The report is version 3 and the prompt `publication-review-prompt/3`.
  Version 3's evidence adds `license_file`, the matcher version in the record, `description_keys_not_shown` (decision 5) and the lineage's `resolved_at` (decision 3);
  stored version 1 and 2 reports still parse as they were written.
- **The Worker accepts version 3 first, in a release of its own; the job emits version 3 in the next release.**
  The job checks its script out of nemar-cli `main`, so a job that emitted version 3 before the Worker in production parsed it would have every review stored as `report_invalid`.

### 3. Lineage reliability

- The lineage is resolved again at review time and again when the decision card is built, and each lineage records `resolved_at`.
  An `unresolved` source is never served from the resolver's cache.
  A fresher outcome on the card is shown beside the review's own with both times, and never raises the stored verdict (ADR 0093's stricter-of-two rule);
  when it is better, the card's next action is to review again (`start <id> --again`).
- An `osf.io/<id>` URL maps to its DataCite DOI, `10.17605/OSF.IO/<ID>`, and falls back to the license OSF's API declares for the node.
- A DOI candidate cut out of a README (a suffix too short to be one, or one that ends where the sent text ends) is not a source:
  it is dropped and counted, and never makes the lineage `unresolved`.
- `needs_permission` shows the license the source declares, in the lineage command, the permission sentence and the card.
- `nemar dataset license-check` and the admin lineage command print no bug-report prompt for an outcome, `needs_permission` included; the prompt is for a crash.

### 4. The administrator's decision card

One structure, built by the Worker and printed by `nemar admin dataset publish show` and the website's approval page, with no surface computing its own:
- **The dataset's own words, side by side**: the main fields of the enrichment (`.nemar/metadata.json`; the review reads D1's stored copy, snapshotted when the inputs are served):
  title, description (the dataset's aim), license, creators, keywords and funding,
  beside `dataset_description.json`'s `Name`, `License` and `Authors`, and the `Version` from the facts.
- **A license panel**: the `License` field, the file identification, the lineage outcome, whether the source is credited, and the source's declared license,
  with one cue and a one-line reason.
  - Red: no `License` field, `matches_other`, `needs_permission`, a share-alike mismatch, or `redistribution_prohibited` without recorded permission.
  - Amber: `unrecognized`, `annexed`, `unreadable`, LICENSE absent beside a recognized field, `unresolved`, `source_is_publication`, an uncredited attribution source, or an enrichment license that disagrees with the field.
  - Green: anything else.
- **Authors**, with placeholders flagged.
- **Per question**: the answer and its strongest finding.
- **The identifier-screen line**, as `describeScreen` words it.
- **One suggested next action**, from a closed list, that never says approve while a gate withholds approval.
- Depositor and model text stays labeled as such, as in ADR 0102 section 8.

### 5. The withheld description key

The key withheld in 34 of 37 reviews is most likely `Version`, which ADR 0102 keeps from the model on purpose.
Version 3 evidence records the names of the keys not shown as closed words (the keys NEMAR knows, `Version` among them, and `other` for any key it does not), never a depositor's key name, so the guess is checked.
The card shows the version from the facts.

### 6. Documentation

A docs.nemar.org page, `/platform/license-check`, explains the check to depositors; its outline is in Consequences, and the docs change is a later phase's pull request.

## Consequences

- A dataset that ships the real text of the license it declares no longer loses `authors_and_license` to the cap; epic #2449's gate is at most 8 of the 37 compared requests `unknown` on it after re-review.
- An added restriction cannot hide inside a high score: it is leftover, and the model reads exactly it.
- A license file that contradicts the field is red and needs a person; it never denies on its own.
- The review job downloads two pinned artifacts (about 3 MB and 37 MB) before the model call, and a failed download degrades to ADR 0102's handling rather than failing the review.
- The administrator reads one card, license first, and the suggested action is computed once.
- Obligations: two releases in order (decision 2); the threshold measurement in Phase 1; the docs page, outlined here:
  1. What a depositor sees: the file identification, its three-color cue and reason, and that a file contradicting `License` needs a person, never an automatic denial.
  2. Why the full license text is fine to ship, and that added terms are read and judged.
  3. The matcher and its version (`askalono-0.5.0+spdx-65dd995`), the threshold and what `additions` means.
  4. How to reproduce: download the pinned askalono release, check its SHA-256, run `askalono --format json identify --optimize LICENSE`; or run `nemar dataset license-check`.
  5. The lineage outcomes, osf.io sources, and what to send for `needs_permission`.

## Open risks

- askalono is archived, so its license data stays at May 2022: a license published after it is `unrecognized` (amber), and a fix means a new pinned matcher in a new ADR or amendment.
- The threshold rests on an approximation of askalono's scoring until Phase 1 measures the real scores.
- The source archive is a GitHub codeload tarball; its bytes were identical on two downloads, but GitHub does not promise that forever, and a change fails the digest (degrading safely) until the pin is refreshed.
- A LICENSE that is a one-line notice ("licensed under CC BY 4.0") is usually `unrecognized`; it keeps ADR 0102's handling, which is cheap for a short file.
- The release binary has no `--diff` (built without diagnostics), so the alignment is ours: a small piece of make inside a take.

## Alternatives considered

- **Vendored SPDX texts with a matcher of our own**: rejected; normalization and scoring are what askalono already does and is known for, and we would own their correctness and drift (take, not make).
  askalono is an established implementation, used widely to detect license files, small, and a static binary with no runtime to install.
- **licensee** (Ruby): rejected; it needs a Ruby runtime in the job, and its corpus is choosealicense.com's, which leaves out the non-commercial and no-derivatives CC licenses that matter most here.
- **Model only, with a larger LICENSE cap**: rejected; it spends the cap on boilerplate, an identification would differ between runs and models, and the decisive fact (which license this is) should be a platform fact, not a model's.

## Receipts

- Epic nemarOrg/nemar-cli#2449, issue #2450; the 37-review measurement in the epic.
- askalono 0.5.0 release and source at tag 0.5.0 (`cli/src/identify.rs` MIN_SCORE 0.8, `src/strategy.rs` default 0.9, `src/ngram.rs` Dice, `cli/build.rs` embedded cache, `.gitmodules`).
- `spdx/license-list-data` commit `7bd3f753`, compared with tag v3.17 (two builds ahead).
- ADR 0102 sections 2, 3 and 5; ADR 0139 decisions 1, 7 and 9; ADR 0093.
