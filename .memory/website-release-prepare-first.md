---
name: website-release-prepare-first
description: "nemarOrg/website releases differ from nemar-cli: run the Prepare release workflow on staging (strips -devN) BEFORE the staging-to-main PR; promoting without it deploys a -devN version and release.yml fails with nothing to tag"
metadata:
  type: project
---

On 2026-09-08 I merged website#320 (staging -> main) the nemar-cli way (open PR as-is, merge, let main's automation strip the suffix). The website's `release.yml` failed: "main is on 0.2.9-dev1. Promotion happened without prepare-release.yml, so there is nothing to tag. Run 'Prepare release' on staging and promote again." Production served version `0.2.9-dev1` (functionally fine, untagged).

**Why:** the website strips the suffix on `staging` via the manual `prepare-release.yml` (level auto/minor/major), which re-runs CI and the test deploy on the stripped commit; `release.yml` on `main` only tags. nemar-cli strips on `main` via `auto-tag.yml`. The website's AGENTS.md documents this in its "Release cycle" table and step 8 of its checklist.

**How to apply:** before promoting the website: `gh workflow run prepare-release.yml --repo nemarOrg/website --ref staging -f level=auto`, wait for it to land the strip commit on staging, then open the `staging` -> `main` PR and merge with a regular merge (`gh pr merge --merge`); then verify `https://nemar.org/version.json` reports the clean version. Recovery after a premature promotion is the same sequence: prepare on staging, promote again (a one-commit PR). Read the target repo's AGENTS.md release section before any promotion. See [[release-pr-needs-own-review]] and [[website-staging-pr-no-autoclose]].
