# Versions, Releases and the Re-pull Switches

The detail behind the "Never hand-bump the version" and "The re-pull switches and caps are the owner's" hard rules in `AGENTS.md`.
The decisions are ADR 0016 (release versioning is owned by CI), ADR 0020 (workflow edits hit about 785 repositories at once) and ADR 0111 (an upstream re-pull is a reviewed delta on a release branch).
Where this file and an ADR disagree, the ADR wins.

## [STRICT] Never hand-bump the version

The `package.json` version is owned by CI.
Do not edit it, and do **not** run `./scripts/bump-version.sh` before a `dev` to `main` pull request: a manual bump desyncs the tag, the version and the npm release.
How a version reaches npm, and when a bump by hand is ever right, is on the [release pipeline](https://docs.nemar.org/develop/release-pipeline/) page; the CI side (bump and sync commits, `[skip ci]`) is in `.rules/ci_cd.md`.

## [STRICT] The re-pull switches and caps are the owner's

`AUTO_REPULL_ENABLED`, `AUTO_REPULL_MERGE_ENABLED`, `REPULL_DAILY_OPEN_CAP` and `REPULL_DAILY_MERGE_CAP` appear in no table of `backend/wrangler-sccn.toml`, and `backend/test/repull-switches-flag.test.ts` fails a change that adds one.
No change adds one except the owner's own, in a reviewed pull request that edits that test, because every merge of a re-pull mints a version DOI that cannot be withdrawn (ADR 0111).
The test reads the file only; a Worker secret of the same name also takes effect, so `GET /admin/repulls/switches` is what says what the Worker reads.

A manual major bump on an `on` dataset is refused by the CLI, in `nemar dataset release` and in `nemar dataset update --bump major`: a major of a mirror is an upstream re-pull, so plan one with `nemar admin repull plan <id>`.
The refusal is the CLI's only; the dataset repositories' `version-check` workflow does not read it (ADR 0020).

The runbooks are gated: [freshness](https://docs.nemar.org/admin/operations/upstream-freshness/), [manual re-pull](https://docs.nemar.org/admin/operations/upstream-repull/) and [automatic re-pull](https://docs.nemar.org/admin/operations/upstream-repull-automatic/).
