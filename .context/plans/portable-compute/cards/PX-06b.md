# Card PX-06b: Records written in the CUDA image name its `-cuda` tag, and the aggregate accepts both flavors' tags

Status: ready (after Q0 merges: both change `cli.py`, `docs/recipes.md` and `tests/recipes/test_provenance_contract.py`)
Tier: worker-hard
Timebox: S, 3 hours; escalate at 5 hours or two failed approaches
Needs: network
Depends: Q0 (nemar-process PR 38, merged into `feature/runner-epic`); PX-06 (merged as 85d3e3ec); this card merges before the first image release that publishes the `cuda` flavor
Branch: feature/px06b-cuda-image-tag
Worktree: $WT/nemar-process-px06b (base origin/feature/runner-epic, containing Q0 and PX-06)
Plan: .context/plans/portable-compute/plan.md, section 2.9, section 4 (PX-06, PX-06b); board proposal P9 and the owner's answer Q38 A; the owner's answer Q35 A (the `COMMON_VERSION` rule)
Review: Sonnet panel plus one Opus review (a `common/` change: every record the CPU image writes is byte-identical to the base in the three build modes of the Acceptance; a build file without a valid flavor file ends the run before anything is written; the aggregate accepts exactly the two flavors' tags; no record gains a field; `COMMON_VERSION` and every `RECIPE_VERSION` unchanged)

## Goal

A record written in a release image names the tag that image was published under, `<version>-cpu` in the CPU flavor and `<version>-cuda` in the CUDA flavor, read from the flavor file the image carries; the aggregate accepts either tag for a release; the tag-absence script says it guards both; and no byte of any record the CPU image writes changes.

## Context

- What is wrong, read at the runner epic head 85d3e3ec: `recipes/nemar_process/common/build.py` hard-codes `IMAGE_FLAVOR = "cpu"` (lines 44-46), so `image_tag` (lines 143-150) returns `<version>-cpu` for every release; `common/records.py` `provenance()` writes that tag beside the image digest into every recording and dataset record; `build.check_recorded` (lines 117-140), which `aggregate` calls on every input (`cli.py` line 916), refuses any other tag; `docs/recipes.md` (lines 283 and 290) and `docs/images.md` (lines 168 and 242) say the tag is `-cpu`; the docstring of `scripts/check_tag_absent.py` (lines 3 and 21) names only `-cpu`.
  So a record written inside a CUDA release image would pair the CUDA digest with the CPU tag, and a reader who looks the tag up gets the CPU image.
  The digest stays the identity; the tag is a name, and it must be the right one.
- What exists: PX-06 made each Dockerfile write the one-word file `/opt/nemar/flavor` as root (`cpu` in `Dockerfile`, `cuda` in `Dockerfile.cuda`, beside the label `io.nemar.flavor`), readable by the image's user (the smoke test reads it).
  `cli.py` already reads it for `nemar-recipe version` (`FLAVOR_FILE`, `IMAGE_FLAVORS`, `read_image_fact`: no file is null; a symbolic link, unreadable text or another word is refused).
  `scripts/make_image_digests.py` already writes `<version>-<flavor>`, and the image workflow already checks and pushes one tag per flavor.
- No record anywhere names a tag yet: the one published image (0.1.0-cpu, dispatched from `main` at 9212eb5 on 2026-11-14 at 02:18 UTC) predates PX-10 (d6d80b3, merged five hours later), so it has no build file and writes neither a `process` block nor a tag; no `vX.Y.Z` git tag exists, so no release image with a build file has been published, and no CUDA image has been published at all.
  A dev build and a source run write the tag `null`, and keep doing so.
- The owner's rule for `common/` (Q35 A, the `COMMON_VERSION` paragraph of `docs/recipes.md` "For the next recipe" as PR 38 amended it): a change that alters a byte of the floor fixture's outputs is a recipe version bump; a bump is skipped when a change adds only to a record shape that no released (recipe, version, input) ever wrote, because no record of that shape exists to be told apart from the new one.
- Collisions: Q0 (PR 38) changes `cli.py` (the aggregate and `version`), `docs/recipes.md`, `tests/recipes/test_provenance_contract.py`, `tests/recipes/test_cli.py` and `tests/images/test_smoke.py`, so this card starts from a base that contains Q0.
  PX-08 (running) changes `docs/images.md` and `docs/recipes.md` (the eegprep-lean pin sentences only): whichever of the two merges second merges the base in.
  PX-05 (amended 2026-11-14, waiting on Q0) adds `nemar_ica/`, a `docs/recipes.md` section and the record field `image_flavor` read from `/opt/nemar/flavor`, and also changes `cli.py` (the eegprep text of `version`) and `common/determinism.py` (the eegprep version in `engine_info`), next to this card's edits of the same two functions.
  Merge order: Q0, then this card, then PX-05, which then reads `image_flavor` through `build.image_flavor()` (its card says so).
  If PX-05 merges first instead, this card merges the base in and moves PX-05's own flavor read in `nemar_ica/` onto `build.image_flavor()`, so that one reader remains.

## Scope

- `recipes/nemar_process/common/build.py`; `common/records.py` (`provenance` only); `common/determinism.py` (the preflight read only); `cli.py` (`version_command` uses the shared reader; the aggregate's call only if its signature changes); `scripts/check_tag_absent.py` (docstring only); `images/nemar-python/smoke.py` (one in-image check, no new output key); `docs/recipes.md` (the `image` bullet, the aggregate paragraph, one sentence under the `COMMON_VERSION` rule); `docs/images.md` (the record's tag sentence and the "not verified" bullet about the tag).
- Only if PX-05 merged first: its one flavor read under `recipes/nemar_process/nemar_ica/`, moved onto `build.image_flavor()` with no other change.
- Tests: `tests/recipes/test_provenance_contract.py`, `tests/recipes/test_cli.py`, `tests/images/test_smoke.py`, `tests/images/test_dockerfile.py`: new assertions; an existing test that sets a build file also sets a flavor file (setup only; no assertion removed or weakened).
- Not: `COMMON_VERSION`, any `RECIPE_VERSION`, any record field (no record gains or loses a key), the Dockerfiles, the image workflow, `scripts/check_smoke_pins.py`, `scripts/make_image_digests.py`, the launcher, the runner, `pyproject.toml`, `uv.lock`.

## Decided design

Settled:
1. **One flavor reader.** `build.py` holds the only reader of `/opt/nemar/flavor` (a module attribute `FLAVOR_FILE` that tests point elsewhere) and `IMAGE_FLAVORS = ("cpu", "cuda")`, standard library only, with the rules of today's `cli.read_image_fact`: no file is `None`; a symbolic link (never followed), text that is not ASCII, a file that cannot be read, or anything but one word of `IMAGE_FLAVORS` after stripping whitespace raises `BuildRefused`, whose message names the part and never a path or a value.
   `IMAGE_FLAVOR` and `cli.IMAGE_FLAVORS` are removed (one tuple).
   `cli.version_command` uses this reader and keeps its output key `flavor`, its exit code and its standard-error line for a refused file.
2. **The tag.** `image_tag(info, flavor)`: a release is `<version>-<flavor>` and requires a flavor of `IMAGE_FLAVORS` (otherwise `BuildRefused`); a dev build or a source run is `None` whatever the flavor.
3. **When the flavor must exist (decision).** Whenever a build file exists (release or dev), the flavor file must exist and hold a flavor word, or `BuildRefused`; it is read at the point where `build_info` is read today before anything is created (`determinism.engine_info`), so the run ends before writing a byte, as a build file that contradicts itself does.
   With no build file (a source run, outside an image) the flavor file is not read and the tag is `null`.
   Why refuse rather than default to `cpu`: since PX-06 every Dockerfile writes the file, so a build file without it is a broken or foreign image, and a `cpu` default is the very fault this card removes (a CUDA image named as a CPU one).
   Why for dev builds too: then every pull request's image build reads the file in the real image (the CPU leg's end-to-end launch writes records in a dev build), instead of the first release being the first real read.
   Outside an image the question does not arise: no build file, no tag.
4. **The aggregate (decision).** `check_recorded` accepts, for a release block, exactly `image_tag(block, f)` for some `f` of `IMAGE_FLAVORS` (so `<version>-cpu` or `<version>-cuda`), and `None` for every other block, as today.
   A CPU chunk and a CUDA chunk of one release are already refused as disagreeing by `shared("image tag", ...)` (their digests differ too).
   No cross-check of the tag's flavor against the digest: a record holds nothing that states the digest's flavor (a digest says nothing without the release's digests file, which is not in the image), and a new flavor field in the floor's records would change the bytes of every record the CPU image writes.
   The first record that states a flavor beside the tag is nemar-ica's `image_flavor` (PX-05); the check that a release record's tag suffix equals it belongs with that field (a patch note for PX-05, not this card's work).
5. **In-image proof, both flavors, every pull request.** `smoke.py`, when the flavor file is present, fails unless `build.image_flavor()` returns the flavor smoke read itself and `build.image_tag` of the release `{"version": "0.0.0", "commit": "0" * 40, "build": "release"}` with that flavor is `0.0.0-<flavor>`.
   Its output gains no key, so `scripts/check_smoke_pins.py` and its fixtures are unchanged.
6. **No version bump (Q35).** `COMMON_VERSION` stays `1.0.0` and `RECIPE_VERSION` stays `1.0.0`: the change alters no byte of any record the CPU image writes, in a source run, a dev build or a release (the Acceptance's comparison proves it), and the only new value, the `-cuda` tag, appears only in records written in a CUDA release image, a record shape no released image ever wrote (the one published image writes no tag at all).
   `docs/recipes.md` gets one sentence under the rule saying exactly that, after Q0's sentence about its own case.
7. **Docs and docstring.** `docs/recipes.md`: the `image` bullet says the tag is `<version>-<flavor>` (the flavor in the image's `/opt/nemar/flavor`) for a release image and null otherwise; the aggregate paragraph says the tag of a release is `<version>-cpu` or `<version>-cuda`, and that a build file without a valid flavor file ends the run before anything is written.
   `docs/images.md`: the record sentence says the same; the "not verified" bullet about the `-cpu` tag is removed.
   The docstring of `scripts/check_tag_absent.py` names `<version>-cpu` and `<version>-cuda` (the workflow checks one per flavor) and its usage line shows one of each.
The implementer may choose: function names (one helper that the preflight and `provenance` both call is fine), the test layout, the wording of a refusal within item 1's rule.

## Acceptance

- `uv run --frozen --group runtime --extra cpu pytest tests/recipes -q -m "not network"` passes, including new tests: (a) a release build file with flavor `cuda` gives both records `{"digest": DIGEST, "tag": "1.2.3-cuda"}`, and with `cpu` gives `1.2.3-cpu`; (b) a dev build file with either flavor gives the tag `null`; (c) a release or a dev build file with no flavor file, or with a flavor file that is a symbolic link, empty, `gpu` or `CUDA`, ends the run with no output directory created; (d) no build file and a flavor file holding `gpu` runs as a source run with the tag `null`; (e) the aggregate merges two honest release chunks tagged `-cuda`, refuses by position (exit 6) a release chunk tagged `1.2.3-gpu` or `1.2.3-cuda-cpu` and a dev chunk tagged `1.2.4-dev2-cuda` (new cases beside the existing forged ones), and refuses a `-cpu` chunk merged with a `-cuda` chunk of one release (exit 6); (f) `version` prints the flavor through the shared reader and refuses a bad flavor file with today's exit code.
- `uv run pytest tests/images tests/release -q` passes, including a test that the word each Dockerfile writes to `/opt/nemar/flavor` is in `build.IMAGE_FLAVORS` and equals its `io.nemar.flavor` label, and a test of smoke's new check against a flavor file of each word (run the way `tests/images/test_smoke.py` runs `image_flavor`).
- Byte identity on the repository's EEG fixture, quoted: a scratch driver (uncommitted, in your private folder) runs `cli.main` on the fixture with the arguments `run_bids` in `tests/recipes/test_provenance_contract.py` uses (a fixed `--run-id` and `--image-digest`), in three modes: no build file; a dev build file (`1.2.4-dev2`); a release build file (`1.2.3`, with a flavor file holding `cpu` at your head); once in a detached worktree of the base commit and once at your head.
  Every file of each pair of product trees is byte-identical after removing the clock keys the determinism comparison excludes (`executionDate`, `executionDateTime`, `started_utc`, `finished_utc`).
  Quote the file count per mode and the word identical.
- Mutations, each failing a test, quoted and reverted: `image_tag` returns `-cpu` whatever the flavor (test a fails); a missing flavor file read as `cpu` instead of refused (test c fails); `check_recorded` accepting only `-cpu` (test e fails); `cuda` removed from `IMAGE_FLAVORS` (the Dockerfile word test fails).
- The image workflow's pull-request run: "not run locally, would check: both legs' smoke pass with the new check (`0.0.0-cpu` in the CPU leg, `0.0.0-cuda` in the CUDA leg), and the CPU leg's end-to-end launch, a dev build, still records the tag null".

## Gates

- `uv sync --frozen`, `uv run ruff check .`, `uv run ruff format --check .`, `uv run ty check`, `uv lock --check`, the Acceptance commands, and the leak check of `cards/README.md` on `docs/recipes.md` and `docs/images.md`.

## Stop conditions

- Any file of the byte-identity comparison differs beyond the excluded clock keys: stop and report the files (a version bump is the owner's question, Q35).
- Carrying the flavor would need a new field in any record: stop.
- `git ls-remote --tags origin` lists a `v*` or `image-nemar-python-v*` tag: a release image with a build file may have been published, so records with a `-cpu` tag may exist; stop and report the tag before changing what the aggregate accepts.
- The change would touch a Dockerfile, the image workflow, a publish guard, `SIGNING_IDENTITY` or `scripts/check_smoke_pins.py`: stop.

## Report

At most 25 lines: PR URL and head, each gate with its last lines, the mutations, the byte-identity result per mode, deviations, and patch notes: for PX-05 and Q1c (read `image_flavor` with `build.image_flavor()`, and add to the aggregate the check that a release record's tag suffix equals its `image_flavor`), for Q1 (a record written in the CUDA release image names a tag ending in `-cuda`).
