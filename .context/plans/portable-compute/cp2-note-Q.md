# CP-2 note, track Q (processing and data quality), 2026-11-14

Lead Q, CP-2 brought forward by the owner. Eighteen cards written; every one prints "ready to dispatch" in the card helper and passes the leak check. No Z card.

## Board rows (proposed)

| ID | Title | Tier | Needs | Slot | Depends | Timebox | Review |
|---|---|---|---|---|---|---|---|
| Q0 | One nemar-floor; Zarr records name what they read | worker-hard | network | claude-sonnet | S1R | 6h | Sonnet, Opus |
| Q0b | Registry one floor, two inputs; stamp records input | worker-hard | | claude-sonnet | | 6h | Sonnet, Opus |
| V1 | Derivative store ADR and shared contract | worker-hard | | claude-sonnet | | 4h | Sonnet, Opus |
| V1b | Derivative store (copy, retention, promote) | worker-hard | | claude-sonnet | V1, Q0b | 6h | Sonnet, Opus |
| Q2 | Sample masks and QC summary | worker | network | claude-sonnet | Q0 | 4h | Sonnet |
| Q1a | nemar-ica in the registry on the CUDA image | worker | | claude-sonnet | Q0b, PX-05 | 3h | Sonnet |
| Q1 | nemar-ica on a GPU runner, GPU vs CPU | worker | ssh:ws-b, network | operator | Q1a, PX-06 | 4h | none |
| PX-01 | pAMICA probe on workstation B (rewritten) | worker | ssh:ws-b, network | operator | | 3h | none |
| PX-03 | eegprep icatype pamica (edited) | worker-hard | network | claude-sonnet | | 6h | Sonnet, Opus |
| PX-04 | eegprep ASR state | worker-hard | network | claude-sonnet | | 4h | Sonnet |
| PX-05 | nemar-ica recipe | worker-hard | network | claude-sonnet | PX-03, PX-04, PX-06, Q0 | 6h | Sonnet, Opus |
| PX-06 | CUDA flavor and amica15 | worker-hard | network | claude-sonnet | S1R | 6h | Sonnet, Opus |
| PX-07 | signalJourney 0.2.0 from PyPI | worker | network | claude-sonnet | S1R | 2h | Sonnet |
| PX-08 | eegprep-lean pin to the merge commit | worker | network | claude-sonnet | PX-07 | 2h | Sonnet |
| PX-09 | Resume a budget-cut run (#16) | worker | network | claude-sonnet | Q0 | 3h | Sonnet |
| R0 | Reader epic upstream, CI, review, ADR | worker-hard | network | claude-sonnet, claude-opus | | 4h | Opus (her code), Sonnet (ADR) |
| R1 | Conformance suite; the TypeScript core passes | worker-hard | network | claude-sonnet | R0, V1 | 6h | Sonnet |
| R1b | eegprep-lean suite and engine transport | worker-hard | network | claude-sonnet | R1 | 6h | Sonnet, Opus |

PX-03 needed an edit and has one: wrong paths (`eeg_amica.py`, `eeg_picard.py` are in `popfunc/`), PX-01 dependency dropped, E1's verdict moved to eegprep's Linux CI (the shipped macOS binary is x86_64 and the manager's host has no Rosetta), EEGLAB-matched defaults, `did_converge` never from `converged_`.

## Dispatch order

1. Now: R0 (manager step M1 first; it starts Q8's 2026-11-23 clock), Q0b, PX-03, V1, then PX-04.
2. After lead S's S1R merges (it brings nemar-process `dev` into `feature/runner-epic` and touches the Zarr recipe): Q0 and PX-07, then PX-08; PX-06 also once QB is answered.
3. After merges: Q2 and PX-09 (Q0); V1b (V1, Q0b); R1 (R0, V1, and the manager's merge of the portable-compute epic into the reader epic, plan 2.5); R1b (R1).
4. After the demo ends (2026-11-15T12:00): PX-01 (operator, workstation B).
5. Owner-gated: PX-05 (owner merges PX-03, PX-04; QA; PX-06; Q0); Q1a (owner publishes a release image with both flavors); Q1 (QC; no GPU-capable Docker is known on any workstation and no GPU runner has ever run).

## Proposed plan and risk changes (the manager and the owner decide)

- Rename `feature/reader-epic` to `feature/issue-2144-epic-reader`: `test.yml` runs only on `main`, `dev` and `feature/issue-*-epic-*`, so the plan's name gets no CI with secrets. Finding for lead S: `feature/portable-compute-epic` runs no Tests workflow either (only the npm publish job).
- Plan 0.4: add the reader epic branch to the manager's merge authority (2.5 sends R-track PRs there).
- Branches: every nemar-process card here bases on and targets `feature/runner-epic` (plan 2.9), which reaches `dev` through lead S's S2P; Q0b and V1b take migration numbers by S6's lowest-free rule from 0141.
- ADR numbers by landing order: the first of R0's and V1's ADRs takes 0123, the next 0124, Z0 the next free on resumption (no `TOLERATED_GAPS` churn).
- D12 and D14: the key uses the per-store content digest `nemar.store-content.v1` (A10, Q11), not the index digest; the converter image digest waits for Z; the stamp's claimed tuple grows by `input` only, and reader, Zarr engine and input digest are recorded at success.
- Splits and dependencies: Q0 to Q0 and Q0b, V1 to V1 and V1b, Q1 to Q1a and Q1, R1 to R1 and R1b; PX-03 drops PX-01, PX-04 drops DM-19, PX-06 drops PX-01 and PX-05, PX-05 gains PX-06, Q2 depends on Q0 not Q1, PX-09 on Q0 not PX-05; R1 and R1b move from CP-3 to now (advisor: R1 before Z5).
- New risks: K20 `amica15-linux-x64` needs GLIBC_2.38 and `libgomp.so.1` (read from the binary): fine in the image if the library is present, never native on workstation B (glibc 2.35) or a glibc-2.28 cluster; K21 pamica 0.4.0 declares `torch>=2.12.1` against issue #5's torch 2.8.0 (QB); K22 one engine string for two eegprep builds if eegprep is pinned to a commit (QA); K23 derivative keys rest on recipe-computed digests until Z writes them at commit, and a reconversion without a version change is invisible to stamps until then; K24 the GPU path is unproven end to end (Q1's preflight reads it).
- Computed facts the cards rely on: signalJourney 0.2.0's packaged schema equals the vendored copy (tree digest `d7bde496...`); the digest and key vectors agree in Python, NumPy and Bun.

## Owner questions (at most three)

- QA: release eegprep 0.5.1 (a patch) after PX-03 and PX-04 merge, with eegprep-lean in it? A (Recommended): yes, so PX-05 pins a release and PX-08's next move has a target. B: no; PX-05 stays a draft on a commit pin.
- QB: the CUDA flavor's torch? A (Recommended): torch 2.12.1 (pamica's floor) from CUDA 12.8 for the workstation GPUs; a V100 flavor later, with an HPC GPU run. B: issue #5's torch 2.8.0 for V100 with pamica's torch requirement overridden (untested).
- QC: GPU in Docker on workstation B after the demo? A (Recommended): the owner confirms or installs the NVIDIA container toolkit (a `sudo` step, the owner's), then Q1 runs. B: Q1 waits for an HPC GPU. C: workstation A (runs the conversion cron, K16; not recommended).
- Q8 was answered A (time-boxed) while I wrote: R0 now cites the decision and reports the green run the owner's early merge of #2144 needs.

Owner actions, not questions: create `nemar-compute-derivatives`, scope the compute R2 token to it, add its binding in a reviewed PR (V1b); set `COMPUTE_RUNTIME_IMAGE_CUDA` (Q1a); merge PX-03, PX-04 and R1b in sccn/eegprep; publish the release image with both flavors.

## Amendment 2026-11-14 (V1 from the Q0 review)

- V1 item 1: labels all or none, unit shared or none (an empty unit is `unit` alone), no Unicode normalization, refusal only of text that enters the header; item 2: paths sorted by code point (UTF-8 bytes in TypeScript); item 7: the keying checks the ADR states. Two vectors added (partly labeled `424c2a59...`, code point order `sha256:4bf7b0ab...`); the five existing ones unchanged.
- V1b item 9: the six keying checks with their counted words, `stores_unread` a list, and the recomputation through V1's `inputDigest` that Q0b (PR 2177) leaves to it. Q0's `test_an_empty_unit_is_a_unit_and_not_the_absence_of_one` now contradicts V1 and flips in Q0's fix round.

## Amendment 2026-11-14 (cards from the V1, Q0 and Q0b reviews)

- V1b item 9: the checks run in a fixed order, the first failure deciding the word; two words added, `undigestable` (a `DerivativeContractError` from `inputDigest`) and `key_invalid` (`validateDerivativeKeyFields` answers `ok: false`, or `derivativeKey` throws), the error's `field` logged beside the word; the non-empty and paths-equal-`stores` checks come before the recomputation, so its throw never masks them; a throw ends that one stamp, never the sync or the cron. One acceptance case (a 63-digit `content_sha256` counts `undigestable`, the next stamp is stored), a `key_invalid` example and one mutation (the catch removed).
- Q0: `stores_unread` is a list (an empty list in the Acceptance, not 0); items 5 to 7 record what PR 38 now does: V1's two rules and no normalization, the per-store refusals (`undigestable_metadata`, listed in `stores_unread`), the input-digest refusals as `ValueError`, zero rows kept as the digest of no bytes (V1b's non-empty check comes first), and the eighth vector.
- Q0b item 2 and its migration Acceptance: the merged migration sets `input = 'zarr'` and keeps the name `nemar-floor-zarr`, so an old stamp fails closed as `recipe_unknown` and never blocks or holds a `nemar-floor` claim.
- ADR numbers: V1 took 0123; R0's reader ADR takes the next free number once V1's PR merges (0124 unless a fetch shows otherwise); Z0 takes the next free number on resumption. Changed in plan.md (sections 2, 2.3, 2.4, 2.6, 2.8 and the Z0 and R0 rows), card R0's numbering line, and dispositions C1 and C13.
- `SERVING_PROFILE_SENTENCE`: kept as an EEG-only contract sentence. It is true of every derivative the store can take, because the one Zarr-input recipe reads only a store's EEG group, and it is in no key or digest, so a later change orphans nothing. The ADR states the cap per modality and the rule that the card which first lets a recipe read an iEEG, EMG or MEG group adds that modality's sentence, with an ADR amendment, before any such derivative is stored. No new card: V1's open PR 2178 carries it in its next round (V1 item 6: one ADR sentence, and the module comment states the rule instead of calling it an open point).

## Amendment 2026-11-14 (PX-05 after PX-03 and PX-04)

- PX-05 is written against eegprep `develop` at `edf694c8` (PX-03, holding PX-04's `73daa6a0` and PR 616's `af914512`): the record copies `EEG['etc']['pamica']` whole (`backend` `AMICATorchNG`, `pipeline` `pamica.AMICA(backend='torch').fit`, `pcakeep`, `rank`, `did_converge` from the stop reason), adds `reorder` (eegprep does not record it), and fails a degenerate fit as `ica_degenerate`; the docs say pamica computes the decomposition and name its pipeline (Q31).
- The eegprep pin: no release holds PX-03 and PX-04 and `develop` still says `0.5.0`, so PX-05 pins the commit and every eegprep version text reads `0.5.0+<commit>` (one helper, Q0's `reader_string` rule, for the engine stamp, step software and `nemar-recipe version`). The PR may merge on that pin; a release present at dispatch is pinned instead; a later release moves the pin by its own card. The draft-until-release rule and the QA dependency are dropped. `COMMON_VERSION` stays 1.0.0 under Q35, proved by two byte comparisons.
- `bit_reproducible`: true only for pamica on the CPU with one thread; null on CUDA or with more threads (unmeasured until the pAMICA workstream's PA-07); false for `amica15`, which pAMICA v0.4.0's build would seed from a `seed` line (pAMICA 0.3.1) that nemar-ica does not write. Q1c records it per recording.
- E1 stays informational: E1R prints in the CPU flavor's end-to-end job; a new CUDA flavor step runs a tiny CPU-path fit in the image the registry uses (torch `2.12.1+cu129`, Q33; the `cpu` extra locks `2.15.0`).
- Derivative key (ADR 0123): the key names eegprep alone, so a change of the pamica pin, the CUDA flavor's torch or the `amica15` digest bumps `nemar-ica`'s `RECIPE_VERSION`, held by a lock test; PX-05 writes no store, key or vector, and only the registry's default invocation is dispatched (a dispatch that passes an ICA option needs a key change first: patch note for V1b and Q1a).
- Left to the pAMICA workstream: eegprep's `_AMICA_DEFAULTS` against `runamica15.m` and the shipped binary, same-seed parity, the binary's `seed` and threads, pAMICA's `did_converge_`, CUDA determinism, E1's return, the pamica pin.
- Also changed: plan 2.9 (a 2026-11-14 state paragraph, the reproducibility and fallback sentences, E1's CI readings, the record list), the PX-05 row of section 4 (E1R printed, not a check), K19's response, Q1a's engine note, Q1c's determinism line.

## New cards 2026-11-14 (PX-06b and the #31 diagnosis)

Owner answers Q38 A and Q39 A.
Two cards, `cards/PX-06b.md` and `cards/L4.md`; both print "ready to dispatch" and pass the leak check.
The #31 card is `L4`, not `F31`: F1 to F3 are the demo's fallbacks (plan 3.4), and L is the launcher track (L1 to L3).

### Proposed Steps rows (the manager adds them)

| ID | Title | Tier | Needs | Slot | Depends | Timebox | Review |
|---|---|---|---|---|---|---|---|
| PX-06b | CUDA image records name the -cuda tag | worker-hard | network | claude-sonnet | Q0 | 3h | Sonnet, Opus |
| L4 | Diagnose #31, then fix the OOM read | worker-hard | network | claude-sonnet |  | 4h | Opus |

Board dependency changes: Q1a gains PX-06b (the owner's release image with both flavors must contain it, or every record written in its CUDA image names the `-cpu` tag).
L4 has no Depends: round 1 only measures, on a draft PR; its fix round takes L3's merge in; C4 after L4 (whichever merges later re-records `launcher_sha256`).
S2P (runner epic into `dev`, where the Docker job is a required check) is better merged after L4.

### Proposed plan section 4 rows

| ID | Repo | Goal | Acceptance gate | Depends | Files owned | Host | Tier | Card at |
|---|---|---|---|---|---|---|---|---|
| PX-06b | nemar-process | A release image's records name its own tag (`-cpu` or `-cuda`) from `/opt/nemar/flavor`; the aggregate accepts both; no byte of a CPU-image record changes | `uv run --frozen --group runtime --extra cpu pytest tests/recipes -q -m "not network"`; the byte comparison on the EEG fixture in three build modes | PX-06, Q0 | `common/build.py`, `common/records.py`, `common/determinism.py`, `cli.py` (`version`), `images/nemar-python/smoke.py`, `scripts/check_tag_absent.py` (docstring), docs | ci | wh, Opus review | written |
| L4 | nemar-process | nemar-process#31 diagnosed on CI's hosted runners (late, lost or failed `OOMKilled` read); a bounded re-read only if the launcher is at fault | the diagnostic run's per-image counts; `uv run --no-project --python 3.9 --with pytest --with jsonschema pytest tests/launcher -q` with a late-answer test that fails on the base | L3 (fix round only) | `launcher/nemar_launch/runtime.py`, `tests/standin/fake_docker.py`, `docs/launcher.md`, the launcher digest | ci | wh, Opus review | written |

### Decisions in the cards

- PX-06b: a build file (release or dev) without a valid flavor file ends the run before anything is written; no `cpu` default, because that default is the fault being removed, and dev builds then exercise the read in every pull request's image.
- PX-06b: no cross-check of the tag against the digest: no record states the digest's flavor, and a new field would change every CPU-image record; nemar-ica's `image_flavor` is the first such field (patch note for PX-05).
- PX-06b: `COMMON_VERSION` stays 1.0.0 under Q35: no CPU-image record changes (a fixture comparison in source, dev and release modes), and `-cuda` appears only in records of a CUDA release image, which no released image ever wrote (0.1.0-cpu was published from 9212eb5, before PX-10, and writes no tag).
- PX-06b: an in-image check in `smoke.py` proves the real reader in both flavors on every pull request, with no new smoke output key.
- L4: the reproduction runs on GitHub's hosted runners (matrix `ubuntu-latest`, today 26.04, and `ubuntu-24.04`) through a temporary workflow on the draft PR: there is no container engine on the manager's machine, and that is the host where it fails.
- L4: the reading is pre-registered (H1 late event, H2 lost event, H3 failed read, H0 not reproduced); only H1 or H3 lead to a fix, a re-read bounded by 4 times the largest measured delay (at most 5 s); H2 stops for the owner with options A to D.
- L4: the worker may wait for its own diagnostic run, at most 20 minutes (a stated exception to the CI-watch rule: the run is the card's measurement).

### Evidence read for L4 (not in issue #31)

- The launcher reads `State.OOMKilled` once, at once after `docker run` returns; a `false` and a failed inspect both read as not an OOM kill, and neither is logged. No `--rm`, a unique name, and removal after the read: a removal race is ruled out.
- Ten job logs of 2026-11-14 (six failed attempts, four passing reruns): one hosted image (`ubuntu-26.04` 20261111.196.1), Docker 29.4.2, containerd v2.4.2, runc 1.5.2 in all; the memory test took 0.47 to 0.62 s failing and 0.55 to 0.60 s passing: no image, version or timing signature.

### Patch notes for other cards

- PX-05: its amended card already reads `image_flavor` through `build.image_flavor()` when PX-06b merged first; add the aggregate's check that a release record's tag suffix equals `image_flavor`; PX-05 and PX-06b both edit `cli.py` `version_command` and `determinism.engine_info`, so the second merges the base in.
- Q1c: read `image_flavor` the same way. Q1: a record written in the CUDA release image names a tag ending in `-cuda`.
- C4: Podman's path calls the same OOM read; keep it as L4 leaves it.

### Corrections and an observation

- The brief listed PR 35 among #31's failures; PR 35's failure was issue 39 (the runner overrun test). #31's six failed attempts are on PRs 29, 30, 33, 37 (two) and 38.
- PX-10 added `process` and `image.tag` to the BIDS floor records after 0.1.0-cpu had published BIDS floor 1.0.0 records without them, and `COMMON_VERSION` stayed 1.0.0; Q35's exception covers only record shapes no release wrote. Nothing reads those fields from 0.1.0-cpu's records, so nothing breaks, but the rule paragraph does not describe that change; "byte-identical" in PX-06b means against today's runner epic, not against 0.1.0-cpu.

## New card 2026-11-14 (PX-06c re-lock and CPU torch)

Owner answer Q41 A (with Q33 A); closes nemar-process issue 42.
One card, `cards/PX-06c.md`: it prints "ready to dispatch" and passes the leak check.
Commit 1 rewrites `uv.lock` in uv 0.13.4's serialization with nothing moved; commit 2 pins the `cpu` extra to `torch==2.12.1`.

### Proposed Steps row (the manager adds it)

| ID | Title | Tier | Needs | Slot | Depends | Timebox | Review |
|---|---|---|---|---|---|---|---|
| PX-06c | Re-lock the runner epic, CPU torch 2.12.1 | worker-hard | network | claude-sonnet |  | 3h | Sonnet, Opus (every changed lock entry) |

Board edit: PX-05's Depends gains PX-06c (PX-05 changes `pyproject.toml` and `uv.lock` and must merge after it).
PX-05's Next already names PX-06b, which its Depends column lacks; the manager may add it in the same edit.
PX-06c needs nothing else: dispatch now on the runner epic; it shares only separate hunks of `tests/images/test_smoke.py` with Q0 and PX-06b, and of `docs/images.md` with PX-06b.

### Proposed plan section 4 row

| ID | Repo | Goal | Acceptance gate | Depends | Files owned | Host | Tier | Card at |
|---|---|---|---|---|---|---|---|---|
| PX-06c | nemar-process | The runner epic's lock rewritten in uv 0.13.4's serialization with no package, version, source or hash moved (#42), then the `cpu` extra pinned to torch 2.12.1 like the `cuda` extra (Q41 A) | `uv lock --check`; a package comparison of the locks (commit 1 empty, commit 2 only the two CPU-index torch entries); `uv run pytest tests/images tests/release -q`; the image workflow's smoke of both flavors | PX-06, PX-08 | `uv.lock`, `pyproject.toml` (`cpu` extra), `tests/images/`, `scripts/check_smoke_pins.py`, `docs/images.md` | ci | wh, Opus review | written |

Plan section 2.9's state paragraph of 2026-11-14 could add, once PX-06c merges, that both flavors carry torch 2.12.1 (the manager decides).

### Decisions in the card

- Commit 1 is forced with `uv lock --upgrade-package eegprep-lean`: the package is pinned by a full commit hash and cannot move, and a plain `uv lock` is a no-op on the base.
- The version spelling is avoided, not accepted: `bump_version.py` compares the two version strings, so `0.1.1.dev3` would break `bump-validator`, the release gate and the `dev` bump; `docs/images.md` already says to put the bot's line back.
- Purity is proved three ways: a `tomllib` comparison of (name, version, source) and hashes, per-platform `uv sync --dry-run` install sets, and a byte-for-byte reproduction from the base.
- The pin is `==2.12.1` in the extra alone (it matches `2.12.1+cpu` on Linux and `2.12.1` on macOS); indexes, sources and `conflicts` stay.
- Commit 2 may move only the two CPU-index torch entries; the CPU install set also moves setuptools 84.2.1 to 81.0.0 (torch 2.12.1's requirement, already locked for the CUDA flavor), and 84.2.1 stays locked through the no-flavor resolution, so the build constraint holds.
- `check_smoke_pins` takes the CPU flavor's torch only from the CPU index, so the PyPI 2.15.0 of the no-flavor resolution no longer passes as a CPU torch; a test requires the two extras to name one torch requirement.
- Not pinned: CPUFIT (a reading per host and build), the no-flavor resolution; no recipe or `COMMON_VERSION` bump (a lock change; the golden decisions are the check).
- A merge commit is recommended over a squash, so the pure re-lock stays its own commit on the epic; issue 42 is closed by hand (the PR's base is not the default branch).

### Evidence the lead reproduced (copies of the base files at a415ffc9, uv 0.13.4, 2026-11-14)

- Forced re-lock: 52 lines out, 52 in (one the version line); package comparison empty; install sets identical for both flavors on Linux x86_64 and aarch64, `cpu` on macOS arm64, Windows x86_64 and the default sync; with the version line put back, `uv lock --check` passes and a plain `uv lock` is a no-op.
- Pin: the CPU index lists torch 2.12.1 for CPython 3.12 on `manylinux_2_28_x86_64` and `macosx_14_0_arm64`, and their locked hashes match the index's sha256; only the two torch entries moved; `uv export` gives `2.12.1+cpu` (Linux), `2.12.1` (macOS) and `2.12.1+cu129` (CUDA).

### Patch notes for other cards

- PX-05: its re-lock after PX-06c shows only the eegprep entries; put the bot's version line back; nemar-ica's CPU tests then run torch 2.12.1, the production image's version.
- PX-06b and Q0: whichever merges after PX-06c merges the base in (separate hunks).

## Amendments 2026-11-15 (Q2 version design and the L5 card)

### Q2 (the card contradicted itself; its first dispatch stopped before any edit)

- Version 1.0.1, a patch, for both inputs (lead decision): Q2 adds files and record fields to the directory input's products, and directory-input `nemar-floor` 1.0.0 was released in image 0.1.0-cpu (from 9212eb5); the version rule of `docs/recipes.md` makes that a recipe bump, Q35 A's exception covers only record shapes no release wrote, and the owner's policy makes the bump a patch. Without it, a stamp or derivative key (both name the recipe version) could not tell a 1.0.0 product with masks from one without.
- The golden stop condition now says what it means: the channel table, the bad-segment table and every step decision must not change; `recipe.version` and `plan_hash` in `decisions.json` are expected to change, because `Plan.hash` hashes the version. Proof: a committed test re-hashes the fixture plan at 1.0.0 and must find the 1.0.0 golden hash (`sha256:ffa6a154...`), and the acceptance quotes the two tables as `R100` renames and a two-line diff of `decisions.json`.
- Scope gains `scripts/make_floor_golden.py` (`GOLDEN` and its docstring), the golden directory renamed to `nemar-floor-1.0.1`, `test_golden_decisions.py` (docstring and two tests), `tests/recipe_support.py` and the four tests that write 1.0.0 literally. It loses `common/naming.py`: both new names already exist (`product_path`, `dataset_path`) and `write_product`'s `nemar_extra` carries `mask_grid`, so a needed `common/` change is now a stop (whether `COMMON_VERSION` moves is the owner's question under Q35).
- The patch note for nemar-cli now says the registry moves to 1.0.1 in the same release as the first image carrying it: an image at 1.0.1 under a registry at 1.0.0 ends every floor stamp `tuple_mismatch` and holds the tuple. A collision line names PX-06b and PX-05 (`cli.py`, `docs/recipes.md`).

### New card L5 (owner answer Q42 C)

One card, `cards/L5.md`: it prints "ready to dispatch" and passes the leak check. L5 is the next free launcher-track id (L1 to L4 are used).

#### Proposed Steps row (the manager adds it)

| ID | Title | Tier | Needs | Slot | Depends | Timebox | Review |
|---|---|---|---|---|---|---|---|
| L5 | Measure the kernel's oom_kill count, then read it | worker-hard | network | claude-sonnet |  | 5h | Opus |

Board edit: C4 merges after L5 (both change `runtime.py`; whichever merges later re-records `launcher_sha256`).

#### Proposed plan section 4 row

| ID | Repo | Goal | Acceptance gate | Depends | Files owned | Host | Tier | Card at |
|---|---|---|---|---|---|---|---|---|
| L5 | nemar-process | Whether the kernel's `oom_kill` count of the container's own control group catches the memory kills the engine loses (#31), measured on CI's hosted runners; a Docker-only launcher read of that count only if it does | the diagnostic run's per-image `KDIAG` counts; `uv run --no-project --python 3.9 --with pytest --with jsonschema pytest tests/launcher -q` with a stand-in control group test that fails on the base | none | `launcher/nemar_launch/runtime.py`, `__main__.py` (the partial), `tests/standin/fake_docker.py`, `docs/launcher.md`, the launcher digest | ci | wh, Opus review | written |

#### Decisions in the card

- It reads the container's own control group, not one the launcher owns: under rootful Docker the daemon creates the group, and a launcher-owned parent needs `--cgroup-parent`, a change to the engine command line; that is option C2 for the owner if round 1 stops.
- The own read alone decides, pre-registered (`RELIABLE`, `UNRELIABLE`, `NOT REPRODUCED`); a during-run poller (no engine call) and the parent group's delta are recorded for the owner's next choice only.
- 100 control launches per image (exit 137 from a child's SIGKILL while holding 96 MiB, below the limit), interleaved one in four, give the false-positive check the reading needs.
- Round 2: Docker only; one more inspect for the id after an answer that is not `true`; one size-capped read, without following a symbolic link, of a path built from a fixed layout and an id checked to be 64 hexadecimal digits; every doubt stays `entry_failed`; Podman's path, Apptainer's classification and the existing one-inspect test are unchanged.
- The lead's expectation, unmeasured and stated in the card: runc removes the container's group while the daemon handles the exit, before the client returns, so the card is likely to stop after round 1. It is still the measurement the owner asked for, and its evidence decides between A, C1, C2 and D.

#### For the owner

- Q2's bump moves the floor's stamp tuple and derivative keys to 1.0.1 when the registry moves (the owner's release act). The lead decided under the written rule; the owner may countermand by widening Q35's exception, and Q2 then keeps 1.0.0 and needs another amendment.
