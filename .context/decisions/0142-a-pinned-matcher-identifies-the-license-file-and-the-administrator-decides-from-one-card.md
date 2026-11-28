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

### 1. The review job identifies LICENSE with ScanCode, pinned

- **The matcher is ScanCode toolkit 32.5.0** (nexB, Apache-2.0, `github.com/aboutcode-org/scancode-toolkit`), the release of 2026-01-15 and the latest on the Python Package Index (PyPI) on 2026-11-27.
  Its license database (the licenses and detection rules, including every CC license and variant) ships inside the release, and it maps them to SPDX license list 3.27.
- **The matcher version the review records** is `scancode-32.5.0+spdx-3.27`: the toolkit release, which also versions its license database, and the SPDX list version that `scancode --version` prints.
  It joins ADR 0139 decision 9's record and every surface that prints it.
- **How it is installed.**
  uv only, never pip.
  nemar-cli carries a hashed requirements file for Linux x86_64 and Python 3.12 (`scripts/ci/scancode-requirements.txt`, from `uv pip compile --generate-hashes`; 80 packages),
  and the workflow installs it with `uv pip install --require-hashes --no-build` into a fresh environment, never at a version the dispatch payload names.
  `--no-build` takes wheels only, so no package's build code runs at install time, and unpacking a wheel runs none either.
  The file pins `pluggy` below 1.6: measured, ScanCode 32.5.0 with the `pluggy` 1.7 that its own requirements admit fails at start (`did not find any 'pre_scan' hooks`).
  The install is fresh on every run, with no Actions cache, because a cache is writable from other workflows of the repository.
  A failed install or a hash mismatch is never a pass and never a denial: the identification is `unreadable`, the matcher word is `unavailable`, and LICENSE is handled as ADR 0102 handled it.
- **The interpreter and uv are pinned.**
  uv itself comes from `astral-sh/setup-uv` pinned to a full commit with an exact uv version, like every action in the workflow (its header's item (a)).
  The interpreter is a uv-managed CPython at the exact patch version the requirements file was compiled for, named in a comment at its head (3.12.16 when this was measured);
  uv checks the interpreter archive against the SHA-256 it carries for that version, and the step refuses to continue when `python -I -c 'import sys; print(sys.version)'` names another version.
  The runner's own Python is not used, because the runner image changes it without a change here.
- **Where it runs, in the workflow's threat model.**
  The header of `run-publication-review.yml` says what each step can hold and what the order closes; ScanCode adds 80 packages of third-party code to it, so it does not run the way the review script does.
  - The install is its own step after the dataset fetch, with no `env:` beyond the paths: it holds no dataset token (only the fetch and the validation-run lookup do) and no Anthropic identity, and, with `--no-build`, it executes no package code.
  - **Before the scan**, as the runner user: the install step warms ScanCode's license index once (`scancode --reindex-licenses`, or the first scan of a fixed text) inside the environment, which then stays read-only to everyone else.
    The step extracts LICENSE with `git cat-file blob <head>:LICENSE` from the fetched repository, never following an annexed link or pointer (an annexed LICENSE is `annexed` and is not scanned),
    into a fresh directory outside `/home/runner`, `/tmp/license-scan/in` (mode 0755, the file 0644);
    it creates `/tmp/license-scan/out`, `/tmp/license-scan/home` and `/tmp/license-scan/tmp`, owned by uid 65534 with mode 0700.
  - **The scan** is its own step, before the OIDC fetch for Anthropic, and runs ScanCode as
    `sudo unshare --net -- setpriv --reuid=65534 --regid=65534 --clear-groups -- env -i PATH=<venv>/bin:/usr/bin HOME=/tmp/license-scan/home TMPDIR=/tmp/license-scan/tmp SCANCODE_CACHE=/tmp/license-scan/home SCANCODE_TEMP=/tmp/license-scan/tmp scancode ... --json /tmp/license-scan/out/result.json /tmp/license-scan/in/LICENSE`,
    from the environment installed outside the runner user's home.
    It needs the runner's passwordless `sudo`, because Ubuntu 23.10 and later block an unprivileged `unshare --net` through AppArmor; a runner without it records `unavailable`.
    So the scanning process has no network, so it can send nothing anywhere; it has no environment beyond those paths, so neither the OIDC request variables that `id-token: write` puts in every step nor any token reach it;
    and as another user it cannot write the runner user's files, so it cannot plant a hook for the mint action's post step or for the Review step.
  - **After the scan**, the Review step checks that `result.json` is a regular file owned by uid 65534, with mode no wider than 0644 and at most 4 MiB, before it parses it;
    it reads the output as JSON data, validated against the fields this decision uses, and nothing ScanCode wrote is executed.
  - Running ScanCode in the Review step with the SDK, as an accepted risk like the header's item (c), was rejected: it would put 80 packages' runtime code beside the Anthropic identity and the mint's post step, for no benefit.
    A separate job was rejected for the reason the header gives: the LICENSE text would have to cross jobs as an artifact, and this repository's artifacts are public.
  - Not closed: a kernel escape from the sandbox, and the callback token in the event file (the header's item (b)), which the sandbox cannot send anywhere.
  Phase 1 proves on a runner that a real scan of a CC-BY-4.0 text returns its result inside the sandbox, and that the scan step cannot open a socket and cannot write the workflow's `_actions` and `_temp` directories;
  the header gains these lines in the same change.
- **`unavailable` is never silent after deploy 3.**
  Before the workflow change it is expected; after it, it means the install, the sandbox or the scan broke.
  The card's license panel then says "License matcher unavailable" as its amber reason, and the administrators' existing review mail carries the same line, so a broken matcher shows on the first review it touches (the daily digest of ADR 0139 decision 4 lists automatic denials only and does not carry it).
- **Its cost.**
  The download is about 153 MB (the ScanCode wheel is 126 MB), and the environment is about 667 MB installed, 573 MB of it the license index.
  A cold install took 20 seconds on a laptop, so 30 to 60 seconds is the estimate on a GitHub runner; one file scans in about 5 seconds, start-up included.
- **How the job runs it.**
  `scancode --license --license-text --license-text-diagnostics --copyright --processes 1 --timeout 120 --json <out> LICENSE`, inside the sandbox above, on the copy of the file the job already holds, under a step timeout of 5 minutes.
- **How a depositor reproduces it.**
  With the same hashed set: `uv venv --python 3.12.16 scancode-env`, then `uv pip install --python scancode-env --require-hashes --no-build -r scancode-requirements.txt`
  (the file at the nemar-cli version the review names, published in the repository and linked from the docs page), then the command above.
  The one-line `uv tool run --python 3.12 --from scancode-toolkit==32.5.0 --with "pluggy<1.6" scancode ...` is shorter, but its other dependencies may drift; the review's record names the toolkit version either way.
  `nemar dataset license-check` does not bundle ScanCode: it prints the exact commands for the dataset's LICENSE.
- **What ScanCode reports, measured on 2026-11-27** (texts from SPDX license-list-data `main` and creativecommons.org `legalcode.txt`):

  | File | Detected expression | Score / coverage of the license's match | Unmatched text |
  | --- | --- | --- | --- |
  | CC-BY-4.0, CC-BY-SA-4.0, CC-BY-NC-4.0, CC-BY-NC-SA-4.0, CC0-1.0 (creativecommons.org) | each its own identifier | 100 / 100, exact (`1-hash`) | none |
  | the same five (SPDX texts) | each its own identifier | 100 / 100, or 98.8 and 98.88 for the two non-commercial texts (`3-seq`) | none |
  | CC-BY-4.0 with "This dataset may be used for non-commercial purposes only." inside it | `CC-BY-4.0 AND LicenseRef-scancode-proprietary-license` | 99.61 / 100 | the ten words, bracketed, and a second match on that line |
  | the same line appended at the end | the same | 100 / 100 | a second match on that line |
  | CC-BY-4.0 with a permission, a citation or a nonsense sentence inside it | `CC-BY-4.0` | 99.57 to 99.92 / 100 | each word, bracketed |
  | CC-BY-4.0 with a citation sentence appended | `CC-BY-4.0` | 100 / 100 | the line is outside the match (lines 1 to 395 of 397) |
  | CC-BY-4.0 with one word added ("may NOT satisfy") | `CC-BY-4.0` | 99.96 / 100 | `[NOT]` |
  | CC-BY-4.0 under a "Copyright 2024 Example Lab" line | `CC-BY-4.0` | 100 / 100 | none; line 1 is a copyright statement |
  | "This dataset is licensed under CC BY 4.0, https://creativecommons.org/licenses/by/4.0/" | `CC-BY-4.0` | 100 / 100 | none |
  | NEMAR's generated CC-BY-4.0 notice (`generateLicenseText`) | `CC-BY-4.0` | 68.75 / 68.75 for the title and URL, 100 / 100 for the sentence | none, but "See the URL above for the full license text." is outside every match |
  | NEMAR's generated CC0-1.0 notice | `CC0-1.0` | 84.62 / 100 and 100 / 100 | `[Public] [Domain]`, and public-domain clues |
  | the first 200 lines of CC-BY-4.0 | `LicenseRef-scancode-free-unknown AND (CC-BY-4.0 AND LicenseRef-scancode-unknown)` | the longest match is not CC-BY-4.0 | not applicable |
  | one line of prose with no license | none | none | not applicable |

  Siblings are told apart, and the score alone never reveals an added restriction (99.57 for a permission sentence); the bracketed and uncovered text does.
- **The decision rule.**
  - `P` is the `license_expression_spdx` of the longest match (`matched_length`) in the file.
    When there is no match, or `P` is not a single SPDX-listed identifier (a `LicenseRef-scancode-*` term, or an expression), the state is `unrecognized`.
  - The identification is conclusive only when that longest match itself has `score` at least 95 and `match_coverage` at least 95.
    A shorter match of the same license (a title or a URL) never makes a trimmed or clause-deleted text conclusive.
    The lowest real full text measured is 98.8, and a notice that names its license scores 100; a weaker longest match is `unrecognized`.
    A change of threshold is a reviewed code change.
  - **A compound result is not conclusive.**
    The file's expression is ScanCode's `detected_license_expression_spdx`.
    When it joins `P` with another SPDX-listed identifier by `OR`, `AND` or `WITH` (for example `MIT OR Apache-2.0`, or a CC text beside a full CC0 text), the state is `unrecognized`, amber on the card,
    and the review records the expression beside the fact (`license_file.expression`, ScanCode's words, never the depositor's).
    `P` joined by `AND` only to `LicenseRef-scancode-*` terms (the measured rider gives `CC-BY-4.0 AND LicenseRef-scancode-proprietary-license`) is not compound: those matches are additions.
  - A conclusive `P` that equals the `License` field after normalization (`shared/license-lineage.ts`) is `matches`; one that differs is `matches_other`.
    When the field does not normalize, the two cannot be compared: the state is `unrecognized`, and `spdx` still names `P`.
  - A LICENSE that is byte for byte NEMAR's own generated notice for the field's license (`generateLicenseText`, line endings normalized) is `matches` with no additions,
    because ScanCode leaves its last line outside every match and reads its CC0 title as a public-domain clue.
- **The identification is a closed fact**, `license_file: {state, spdx, additions, expression}` (`expression` is null unless the result was compound):
  - `matches`, `matches_other` and `unrecognized` as above;
  - `absent`: no LICENSE file;
  - `annexed`: LICENSE is an annexed link or pointer rather than text in git;
  - `unreadable`: the job could not read it in full, it is not UTF-8, ScanCode reported a scan error or timed out, or the matcher is unavailable.
  `spdx` is `P` or null; `additions` is a boolean, false unless the state is `matches` or `matches_other`.
- **Additions** are set by any of:
  - a bracketed (unmatched) token in the `matched_text_diagnostics` of a match of `P`;
  - a match of any other license, except a `LicenseRef-scancode-unknown-license-reference` match on lines that a match of `P` also covers (the "licensed under the" of a notice);
  - a license clue;
  - a line that no match covers, unless it is blank, only punctuation, or holds nothing but a copyright statement ScanCode reports (`--copyright`); a line with a copyright statement and other text is leftover.
  The leftover text is those tokens, the matched text of those other matches and clues, and those lines.
  There is no minimum length, because a false `additions` costs only a model read, which is the safe direction.
- **What the model receives.**
  The platform facts carry `license_file` and the matcher version.
  For a conclusive identification (`matches` or `matches_other`) the model receives only the leftover text, not the license, as the `license` document:
  it passes the same pre-send rules (ADR 0102 section 2) and the same 4,000-character cap, and a cut leftover is a cut document.
  For any other state the model receives LICENSE as ADR 0102 section 3 says.
- **The lowering rule.**
  When the identification is `matches` and the leftover, if any, was sent whole, LICENSE no longer lowers `authors_and_license` to `unknown`;
  the model still answers the question, the authors half included.
  `matches_other` lowers `authors_and_license` to at best `unknown` with the fact word `license_file_differs`, shows a red cue,
  and never leads to an automatic denial: when `license_file.state` is `matches_other`, a `fail` of `authors_and_license` is not eligible, whatever finding it carries (`license_inconsistent` included, which is in `AUTO_DENY_FINDING_CODES`).
  Lowering to `unknown` does not lift a model's `fail`, and both runs would see the same platform fact and likely return the same blocker, so ADR 0139's two-model agreement would be no check at all.
  The other questions keep their eligibility.
  Every other state keeps ADR 0102's rule: a cut or withheld LICENSE lowers the question to at best `unknown`, and an absent LICENSE does not lower it.

### 2. Report version 3 and prompt version 3, in three ordered deploys

- The report is version 3 and the prompt `publication-review-prompt/3`.
  Version 3's evidence adds `license_file`, the matcher version in the record, `description_keys_not_shown` (decision 5) and the lineage's `resolved_at` (decision 3);
  stored version 1 and 2 reports still parse as they were written.
- **Three deploys, in this order.**
  1. A nemar-cli release in which the Worker accepts version 3 (and still accepts 1 and 2).
  2. The next nemar-cli release, in which the job's script emits version 3 and the hashed requirements file lands.
     The job checks its script out of nemar-cli `main`, so a script that emitted version 3 before the Worker in production parsed it would have every review stored as `report_invalid`.
     Until step 3, the script finds no ScanCode output and records `unreadable` with the matcher word `unavailable`, which keeps ADR 0102's handling.
  3. The workflow change (the uv set-up, the install and the sandboxed scan) deployed to `nemarDatasets/.github`, which is a separate deploy from either release,
     and only after step 2, as the workflow header requires of every change that names a script.

### 3. Lineage reliability

- The lineage is resolved again at review time and again when the decision card is built, and each lineage records `resolved_at`.
  An `unresolved` source is never served from the resolver's cache.
  A fresher outcome on the card is shown beside the review's own with both times, and never raises the stored verdict (ADR 0093's stricter-of-two rule);
  when it is better, the card's next action is to review again (`start <id> --again`).
- An `osf.io/<id>` URL of the Open Science Framework (OSF) maps to its DataCite DOI, `10.17605/OSF.IO/<ID>`, and falls back to the license OSF's application programming interface (API) declares for the node.
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
  - Amber: `unrecognized` (a compound expression included), `annexed`, `unreadable`, LICENSE absent beside a recognized field or beside a field that does not normalize, `unresolved`, `source_is_publication`, an uncredited attribution source, or an enrichment license that disagrees with the field.
  - Green: anything else.
- **Authors**, with placeholders flagged.
- **Per question**: the answer and its strongest finding.
- **The identifier-screen line**, as `describeScreen` words it.
- **One suggested next action**, from a closed list, that never says approve while a gate withholds approval:
  `approve` (only when the approval gate would accept the approval with no override and no acknowledgment still owed),
  `acknowledge_screen`, `rerun_screen`, `wait` (the screen or the review is running), `start_review`, `review_again` (decision 3),
  `record_license_permission`, `ask_depositor` (a reason only the depositor can cure) and `deny`.
  An override is the administrator's own act (ADR 0102 section 8), so no action suggests one.
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
- The review job installs about 153 MB of pinned packages before the model call, which adds an estimated 30 to 60 seconds, and a failed install degrades to ADR 0102's handling rather than failing the review.
- The administrator reads one card, license first, and the suggested action is computed once.
- Obligations: three deploys in order (decision 2); the hashed requirements file and its refresh when ScanCode is bumped; the docs page, outlined here:
  1. What a depositor sees: the file identification, its three-color cue and reason, and that a file contradicting `License` needs a person, never an automatic denial.
  2. Why the full license text is fine to ship, and that added terms are read and judged.
  3. The matcher and its version (`scancode-32.5.0+spdx-3.27`), the threshold, and what `additions` means, with the measured table above.
  4. How to reproduce: the `uv tool run` command of decision 1, or `nemar dataset license-check`.
  5. The lineage outcomes, osf.io sources, and what to send for `needs_permission`.

## Open risks

- ScanCode's results above were measured on macOS arm64; Phase 1 repeats them on a GitHub runner, adds the 37 reviewed LICENSE files, and records both in its pull request.
- The install size and time on a runner are estimates from wheel sizes and one laptop install, not a runner measurement.
- The `pluggy` pin works around a dependency the release does not cap; a later ScanCode release may need a different pin, which the hashed file makes a reviewed change.
- ScanCode looks for libmagic on the host and warns when it uses the system copy; a LICENSE is read as text either way.
- A new SPDX license reaches the review only with a new ScanCode release and a reviewed bump of the pin.

## Alternatives considered

- **askalono** (Rust, a pinned release binary): rejected on 2026-11-27.
  Its repository is archived, its last release (0.5.0, 2024) embeds SPDX data from May 2022,
  and it scores one bigram similarity, which puts the CC 4.0 siblings within 0.96 to 0.98 of each other, so it does not separate them, and it reports no unmatched text.
- **licensee** (Ruby): rejected; it needs a Ruby runtime in the job, and its curated corpus, choosealicense.com's, leaves out the non-commercial and no-derivatives CC licenses that matter most here.
- **Vendored SPDX texts with a matcher of our own**: rejected; normalization, matching and the rules for notices are what ScanCode already does and maintains (take, not make), and we would own their correctness and drift.
- **Model only, with a larger LICENSE cap**: rejected; it spends the cap on boilerplate, an identification would differ between runs and models, and the decisive fact (which license this is) should be a platform fact, not a model's.

## Amendment 2026-11-27 (#2454): the rule for a README DOI cut short

Decision 3's bullet on cut README DOIs is replaced by the rule phase 3 built (pull request #2472).
A DOI candidate is cut, dropped and counted when its suffix is shorter than five characters (`10.17605/o`),
or, in the README, when it has a data-repository prefix and its suffix does not have that repository's DOI shape
(OpenNeuro, Zenodo, PhysioNet, figshare items and collections, OSF, Dryad datasets and files, Harvard Dataverse; `DATA_REPOSITORY_DOI_SHAPES` in `shared/license-lineage.ts`).
The rule that a candidate ending where the text ends is cut is not used:
the resolver reads whole files, so the end of a README is never a cut, and in a test it dropped a valid DOI that ended a README.
A dropped candidate still never stands beside other sources as `unresolved`;
when the README's only candidates were dropped and no source remains, the outcome is `unresolved` with the dropped count, never `no_upstream_declared`,
because the dataset did name a source that could not be read.

## Amendment 2026-11-27 (owner hotfix): README DOI prefixes and DANDI's license spellings

Decision 3 gains two rules, and the resolver becomes `license-lineage/4` because outcomes change.

- **A README DOI that prefixes another declared DOI is that DOI cut short.**
  A README DOI candidate that is a strict prefix of a DOI declared in `SourceDatasets`, the related identifiers or the attestation, or of another README DOI candidate, is dropped and counted in `dropped_doi_candidates`,
  but only when the README text itself continues it into that DOI across whitespace (a line break, with any quote or emphasis markup around it: `10.5281/zenodo.2231` then `4785` on the next line).
  A prefix the text does not continue is a distinct record (`10.5281/zenodo.1234567` beside `10.5281/zenodo.12345678`) and stays a source.
  The cut copy still has its repository's DOI shape (`10.5281/zenodo.2231` beside a declared `10.5281/zenodo.22314785`, measured on nm000746 and nm000843), so the shape rule cannot see it, and it made the lineage `unresolved`.
  A README DOI equal to a declared one is the same source and is de-duplicated, not counted; a declared DOI is never dropped.
- **DANDI's license spellings are read.**
  The normalizer reads dandischema's `LicenseType` values (`spdx:CC-BY-4.0`, `spdx:CC0-1.0`, any `spdx:` identifier) and the enum names that DANDI's DataCite records give as `rightsIdentifier` (`cc_by_40`, `cc0_10`).
  `10.48324/dandi.001535/0.250714.1218` (nm001003) declares only `cc_by_40`, which read as `other` and made the lineage `needs_permission`; it is now CC BY 4.0, `compatible_attribution` for a CC-BY-4.0 target.

## Amendment 2026-11-27 (owner, follow-up): README DOIs cut by an ellipsis

The README prefix rule of the amendment above also drops a README DOI candidate that is a strict prefix of a declared or longer README DOI when an ellipsis follows it immediately (optional whitespace between): `[...]`, `[…]`, `...` or `…`.
Both rules apply only when every place the README writes the short DOI on its own is a cut (continued across a line break, or followed by an ellipsis); one standalone occurrence, and the short DOI is a source.
nm000746 and nm000843 carry a truncated cell, `https://doi.org/10.5281/zenodo.2231 [...]; N: 30`, beside the declared `10.5281/zenodo.22314785` (and `zenodo.236` beside `zenodo.23610719`).
Two distinct records, one a prefix of the other, with no ellipsis right after the shorter, are both kept. Resolver `license-lineage/5`.

## Amendment 2026-11-27 (lead ruling, #2455): the card's closed list, permissions and gates

Decision 4 is extended by the rulings of phase 4's review (pull request #2479).
- **A tenth next action, `administrator_reads`**: an administrator reads the review and the dataset and decides.
  It is for a reason no rule settles and the depositor cannot cure alone: `doi_state_unexpected`, `text_withheld`, `question_unknown` and `bids_unconcluded_at_review`, a red license cue that no reason names, and a request whose approval has started publishing.
  It suggests no override; the terminal points at `show`.
- **A recorded license permission clears `needs_permission` and `share_alike_mismatch` on the card**: the cue is green when nothing else stands, and its reason says a recorded permission covers the upstream license.
  `redistribution_prohibited` stays red with a permission, because a repository's data use agreement may bind more than the authors.
  A permission counts per lineage: the card's fresher lineage is covered only when the permission covers that lineage's own basis (`permissionCovers`), never because it covered the review's.
- **`approve` also needs the approval's own gates**: the screened commit is still `main` by the approval path's check (`verifyScreenHead`, asked by the card once and without a sleep; a stale head suggests running the screen again, and a head that could not be checked suggests waiting and looking again), and the request is `requested`, or `approving` with no approval run holding it and nothing published.
- The dataset's License field and each source's declared licenses carry their labels in the card's JSON.

## Receipts

- Epic nemarOrg/nemar-cli#2449, issue #2450; the 37-review measurement in the epic.
- ScanCode toolkit 32.5.0 on PyPI (wheels of 2026-01-15), `scancode --version` (SPDX License list version 3.27), and the measurement of 2026-11-27 above, run outside every repository.
- askalono 0.5.0 (archived; `.gitmodules` pins `spdx/license-list-data` at commit `7bd3f753`, two builds after v3.17).
- `src/lib/license.ts` (`generateLicenseText`).
- ADR 0102 sections 2, 3 and 5; ADR 0139 decisions 1, 7 and 9; ADR 0093.

## Amendment 2026-11-27 (seam review of #2486): two cues decision 4 did not list

`administrator_reads` also covers an unresolved lineage: ADR 0139's amendment of the same day makes `unresolved` NEMAR's failure to read a registry, not the depositor's to cure, so no depositor mail is sent and the card does not ask the depositor.
Decision 4's amber list also holds `license_file_not_identified`, for a review made before report v3, which recorded no identification.
Until deploy 3 every review records the matcher `unavailable`; its amber line is listed last, after every reason an administrator can act on, and a LICENSE that was read whole but not scanned is not called unreadable.
The card shows how many README DOIs the resolver dropped as cut short, which explains a lineage that names no source.

## Amendment 2026-11-27 (owner, third lineage fix): which declared sources decision 3 reads

Decision 3's sources gain two rules (ADR 0139's amendment of the same day, resolver `license-lineage/6`): a figshare article URL maps to the figshare record, not to "no DOI", and an enrichment relation that is a publication SourceDatasets does not name is skipped and counted, not a source.


## Amendment 2026-11-27 (owner): the card shows the name rule

Decision 4's card gains a panel, `upstream_name`: the review's closed word (null for a review made before the rule), a cue (red for `differs`, amber for `unknown` or no word, green otherwise), NEMAR's line for it, and the declared upstream dataset titles under the registry label.
The served snapshot keeps those titles (`upstream_titles`, absent from a snapshot written before the rule, which still reads).
The next action gains three rules, each below a running screen or review and above the lineage:
`name_differs_from_upstream` asks the depositor, in a sentence that names the rule ("it should be the upstream dataset's title, as its registry gives it, and a version and an author-year naming the dataset's authors may follow it"), unless a review fail or an agreed denial already says deny;
`name_upstream_unconfirmed` is `administrator_reads`;
and a fail of `name_adequate` alone on a Name that follows a declared upstream's title is set aside: the card says `administrator_reads`, not deny, unless something else decides.

## Amendment 2026-11-27 (epic gate of #2449): a notice rule that ends inside the license's own identifier

Decision 1's compound and additions rules gain one exception, measured with ScanCode 32.5.0 on the LICENSE files of nm000677, nm000774, nm000968, nm000712 and nm000924 (fixtures `gate-*` in `test/fixtures/license-scan/`).
Each opens with a NEMAR header ("The source release is distributed under CC-BY-NC-4.0, and this dataset is distributed under the same licence.") and then the full legal code.
ScanCode's `cc-by-4.0_64.RULE`, a license notice whose text is "distributed under CC-BY", matches the first words of "distributed under CC-BY-NC-4.0" (its matched text is `distributed under CC-BY-`),
while a match of the declared license covers `CC-BY-NC-4.0,` on the same line; the file's expression becomes `(CC-BY-NC-4.0 AND CC-BY-4.0) AND CC-BY-NC-4.0`, and the compound rule made it `unrecognized`.
The legal code's own boilerplate plays no part: the full-text match is CC-BY-NC-4.0 (98.8, `3-seq`) or CC-BY-SA-4.0 (100) alone.

- **A match of another SPDX-listed license is subsumed by `P`** when it lies on one line, its span and the span of a match of `P` on that line are each found there exactly once,
  and it begins before that match of `P` and ends strictly inside it: it read part of `P`'s identifier and nothing beyond it.
  A match that ends where `P`'s span ends or after it, spans several lines, or cannot be placed is never subsumed.
- An identifier all of whose matches are subsumed is not another license for the compound rule, when every operator of the expression is `AND` (an `OR` or `WITH` is ScanCode's choice, which no position undoes),
  and its matches are not leftover.
- Everything else stands: the five are `matches` with `additions`, because the header's sentences are uncovered text, exactly as the same header over CC-BY-4.0 (nm000699) was already;
  a LICENSE with the CC-BY-NC-4.0 header and text followed by the MIT License stays `unrecognized` with its compound expression.
- The matcher version does not change: it names the ScanCode release and SPDX list, and this decision versions no parser.

## Amendment 2026-11-27 (owner-approved, after 0.10.56): web-copy artifacts are not deletions

Decision 1's `partial` rule (a longest match below 100% coverage sends the whole file) is narrowed, measured with ScanCode 32.5.0 on nm000677, nm000774, nm000968, nm000712, nm000924 and nm000982.
The three CC-BY-NC-4.0 files match `cc-by-nc-4.0_23.RULE` at 98.8%: a word-by-word diff against the rule and against creativecommons.org's `legalcode.txt` shows the file lacks exactly the two `wiki.creativecommons.org/Considerations_for_licensors` and `..._licensees` links (hyperlinks on the web page) and the closing sentence "The text of the Creative Commons public licenses is dedicated to the public domain under the CC0 Public Domain Dedication.", and nothing else.
The two CC-BY-SA-4.0 files lack the same pieces, but `cc-by-sa-4.0.SPDX.RULE` lacks them too, so they match at 100%.
nm000982 (99.82%) has its title on line 1, matched by `cc-by-sa-4.0_68.RULE`, outside the full-text match.
Sent whole, the files were cut at the cap, and a cut document lowers `authors_and_license` to `unknown`.

- **The official texts are vendored**: `legalcode.txt` of CC-BY, CC-BY-SA, CC-BY-NC, CC-BY-NC-SA, CC-BY-ND and CC-BY-NC-ND 4.0 and of CC0-1.0, byte for byte as creativecommons.org served them on 2026-11-27, in `scripts/ci/license-texts/` with a manifest of each file's URL and SHA-256.
  Creative Commons dedicates these texts to the public domain under CC0.
- **When the longest match of `P` covers less than 100%**, is a full text (its `matched_length` is at least 90% of the official text's words, `FULL_TEXT_MIN_SHARE`; a notice or a fragment is not), and `P`'s text is vendored (its SHA-256 matching), the longest match's lines are diffed word by word (letters and digits, lowercased) against the whole official text, in both directions.
  Not missing: a Considerations link or the closing CC0 sentence (`WEB_COPY_PIECES`) that the matched lines do not have, and the official title when another match of `P` outside the longest match's lines reads exactly the title's words.
  `partial` is then false, and the diff's pieces join the leftover: each run of official words the file lacks, marked `[missing from the official text]`, and each run of words the file has that the official text does not (an insertion, a substitution, a web copy's own heading words), marked `[added beyond the official text]`, whether or not ScanCode bracketed them.
  So the model reads the deleted and the added words instead of the file, and `additions` is set by any of them.
- **The file is sent whole, as before,** when no official text is vendored for `P`, its SHA-256 differs, the longest match is not a full text, or the diff is too large to compute (`MAX_DIFF_CELLS`).
- The matcher version does not change.

## Amendment 2026-11-27 (lead, shadow run on 0.10.58): what the card says of sources, authors and the denial

ADR 0139's amendment of the same date settles the automatic denial's mail reasons; decisions 3 and 4 gain the parts the card and the lineage own.

- **Decision 3: an OSF node declared as a URL is named by its URL unless DataCite confirms its DOI.**
  The resolver maps `https://osf.io/<guid>` to `10.17605/osf.io/<guid>` to look it up; when DataCite answers that it does not hold the DOI, or the lookup fails or cannot be read, the source is marked `doi_registered: false` and every surface names it `https://osf.io/<guid>` (`sourceLabelOf`): the card's declared licenses, `lineageLines` and the review's registry records.
  A DOI the dataset itself declared keeps its name.
  The record's `id`, the cache key and the permission basis keep the DOI form, so nothing a permission or a cache matched changes.
  nm001019's `10.17605/osf.io/fx4ud` does not exist; the model had read it as an OSF-issued DOI the README disagreed with.
- **Decision 3: a Zenodo record its registry types as a paper records what it holds.**
  For a Zenodo DOI whose DataCite record is not a `Dataset`, the resolver reads Zenodo's record (`/api/records/<id>`, which answers a concept id with its latest version) and keeps its type and files (`registry_files`: Zenodo's type, the file count, the count of files with a data extension (`DATA_FILE_EXTENSIONS`: recordings, tables, arrays and archives; never a PDF, a figure or a document), and up to three of their names).
  The read is one attempt, never retried, so it never spends the lineage's fetch budget on retries the license reads need.
  The record stays a publication and its outcome is unchanged; a record that cannot be read records nothing.
  The DOI cache key becomes `doi3:`, so records cached without these fields are read again (a one-time refetch of every cached DOI after deploy).
- **Decision 4: the license panel says when a paper holds data files.**
  The served snapshot keeps one line per such source (`paper_with_data_files`), and the card's lineage carries it under the registry label: "the registry types this record as a journal article but it holds data files (N of M files, such as ...); it is still read as a publication for the license lineage, and an administrator decides" (nm001028's `10.5281/zenodo.3648065` holds one `Data.zip`; nm000661's `10.5281/zenodo.6529724` holds 35 `.mat` files).
  The cue is unchanged: `source_is_publication` stays amber.
- **Decision 4: authors.** The placeholder count is the larger of the review's count and the names the card flags now, so it never says fewer placeholders than the names it lists (a review made before a placeholder form was recognized counted none).
- **Decision 4: the automatic-denial line carries the agreed codes** (`auto_deny.codes`, and the mail's sentence for each in `auto_deny.reasons`), read from migration 0164's column; empty for a state that records no agreement and for one recorded before the column.
