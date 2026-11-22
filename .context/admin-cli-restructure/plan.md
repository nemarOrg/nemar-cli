# Admin command tree restructure: plan

Status: DRAFT for owner review, 2026-11-22.
No issues are filed and no command code is changed yet.
The decision this plan builds is ADR 0135 (proposed), which refines ADR 0125 decision 7.

## Goal

`nemar admin` is too wide to learn.
Make every admin command findable from its object in at most three steps,
with one write flag and old paths that fail loudly with a pointer,
and move every outside caller in the same release.

## Measured state (origin/dev 63254f1c, 2026-11-22)

Measured by walking the Commander tree exported from `src/commands/admin.ts`
(a script that imports `adminCommand` and recurses over `.commands`; numbers below are from that walk, not from `--help` parsing).

- 200 command nodes under `admin`: 35 groups and 165 leaves.
- 55 top-level entries, 51 visible and 4 hidden (`regenerate-iam`, and the ADR 0125 stubs `publish`, `withdraw`, `restore`).
- Maximum depth is 3 below `admin` (`admin oidc clients add`, `admin compute jobs cancel`, `admin repo publish approve`, `admin mail away show`).
- The survey of 2026-11-21 counted 43 visible top-level entries; the comments in `src/lib/help.ts` and `src/lib/help-groups.ts` still say 43.
  The tree has grown since, or that count left out groups; either way width is the problem, not depth.
- Plain `nemar admin --help` already folds 40 names onto a "More commands" line through `src/lib/help-groups.ts`.

## Target tree

Fourteen top-level groups, each named for an object (ADR 0135 decision 1).
Children are verbs or sub-objects; nothing goes deeper than three levels below `admin`.

```
admin
  users            list (default action), show, edit, approve, revoke, role, verify, kind,
                   kind-check, duplicates, backfill-names, backfill-usernames,
                   keys {create, list, revoke}, email-preferences {show, update}
  dataset (repo)   publish {list, show, start, deny, screen, approve, next},
                   unpublish, withdraw, restore, delete, bulk-delete, reindex,
                   doi {create, info, update, enrich}, ci {check, add, validate, sync},
                   s3 {lock, credential-check}, exemplar {create, status, remint-dois},
                   doctor {scan, fix}
  rework           revert, recover {status} (Q2),
                   annex {normalize, policy, key-registration, content-recovery}
                   (later: scrub, reconvert, ieeg-geometry)
  repull           plan, execute, status, resume, merge, abandon, auto,
                   upstream-status, upstream-backfill
  import           openneuro, status, rollback, retry, verify, coverage, weekly, triage
  fleet            drift, enforce, require-review, revalidate,
                   sweep {hed, recording-stats, signal-defaults, data-integrity,
                          zarr-fidelity, anonymity, availability},
                   summary {check}, zarr-catalog {publish}, e2e-test
  compute          unchanged (policy, pool, status, observer, jobs, move-charge,
                   pipeline, access, runners, derivatives)
  oidc             unchanged
  pr-reviews       unchanged
  neurobagel       unchanged
  mail             unchanged (support tickets)
  notice           unchanged
  notify           unchanged
  docs             unchanged
```

Counts after the move, with the owner's recommended answers below:
14 visible top-level entries (from 51), 0 visible leaves directly under `admin` other than `notify` and `docs`, maximum depth still 3.
The widest groups are `users` (13 children, two of them sub-groups), `dataset` (12), `compute` (11, unchanged) and `fleet` (8).
`users` is one over the soft cap of twelve in ADR 0135 decision 2; retiring `backfill-names` (Q5) brings it to 12.

Why these placements, where the choice was not obvious:

- `dataset doctor`: every check but one is about a stuck dataset; the odd one, `doctor kinds`, checks accounts and goes to `users kind-check`.
- `dataset s3 {lock, credential-check}`: both act on one dataset's bucket prefix; `s3 regenerate-iam` is dead (Q3), so the old `s3` group dissolves.
- `dataset reindex`: refreshes one dataset's metadata (or all with `--all`); it is not a sweep of a derived column like the `fleet sweep` family.
- `repull upstream-status` and `repull upstream-backfill`: both read or record the upstream snapshot a re-pull starts from; `upstream-backfill` retires once the fleet backfill has run (Q4).
- `rework annex ...`: the owner put "annex repairs" in `rework`; the four annex commands share a sub-group so `rework` itself stays at three children plus the later ones.
- `fleet` is everything that runs across all datasets or checks the platform as a whole: governance (drift, enforce, require-review, revalidate), the sweeps that refresh or report derived metadata, the summary and Zarr catalog checks, and `e2e-test`.
  None of it changes a dataset's content, which is what separates it from `rework`;
  its three annex repairs do change content and move to `rework annex`.
  There is no separate `maint` group (owner, 2026-11-22).
  `e2e-test` sits here rather than under `dataset` because it checks the platform and `dataset` is already at the cap of twelve.
- `fleet sweep availability`: the per-dataset report and the `--all` drain are one command today; it is placed with the sweeps because its cron and `--all` form are the common use.

## Old path to new path, every admin command

Phase column: the phase that moves the path (see Phases); "unchanged" means the path stays as it is.
Every moved path leaves a stub (ADR 0135 decision 5) unless the row says otherwise.
Group rows move with their children; a stub on a group path catches every child path beneath it.

| Old path (below `nemar admin`) | New path | Phase | Kind |
|---|---|---|---|
| `users` | `users` | unchanged | group |
| `users show` | `users show` | unchanged | leaf |
| `users edit` | `users edit` | unchanged | leaf |
| `approve` | `users approve` | P2 | leaf |
| `revoke` | `users revoke` | P2 | leaf |
| `role` | `users role` | P2 | leaf |
| `verify` | `users verify` | P2 | leaf |
| `kind` | `users kind` | P2 | leaf |
| `keys` | `users keys` | P2 | group |
| `keys create` | `users keys create` | P2 | leaf |
| `keys list` | `users keys list` | P2 | leaf |
| `keys revoke` | `users keys revoke` | P2 | leaf |
| `docs` | `docs` | unchanged | leaf |
| `s3` | `dataset s3` | P1 | group |
| `s3 regenerate-iam` | RETIRE (Q3), stub only | P1 | leaf |
| `s3 lock` | `dataset s3 lock` | P1 | leaf |
| `s3 credential-check` | `dataset s3 credential-check` | P1 | leaf |
| `regenerate-iam` (hidden) | RETIRE (Q3), stub only | P1 | leaf |
| `repo` | `dataset` | P1 | group |
| `repo publish` | `dataset publish` | P1 | group |
| `repo publish list` | `dataset publish list` | P1 | leaf |
| `repo publish show` | `dataset publish show` | P1 | leaf |
| `repo publish start` | `dataset publish start` | P1 | leaf |
| `repo publish deny` | `dataset publish deny` | P1 | leaf |
| `repo publish screen` | `dataset publish screen` | P1 | leaf |
| `repo publish approve` | `dataset publish approve` | P1 | leaf |
| `repo publish next` | `dataset publish next` | P1 | leaf |
| `repo unpublish` | `dataset unpublish` | P1 | leaf |
| `repo withdraw` | `dataset withdraw` | P1 | leaf |
| `repo restore` | `dataset restore` | P1 | leaf |
| `ci` | `dataset ci` | P1 | group |
| `ci check` | `dataset ci check` | P1 | leaf |
| `ci add` | `dataset ci add` | P1 | leaf |
| `ci validate` | `dataset ci validate` | P1 | leaf |
| `ci sync` | `dataset ci sync` | P1 | leaf |
| `doi` | `dataset doi` | P1 | group |
| `doi create` | `dataset doi create` | P1 | leaf |
| `doi info` | `dataset doi info` | P1 | leaf |
| `doi update` | `dataset doi update` | P1 | leaf |
| `doi enrich` | `dataset doi enrich` | P1 | leaf |
| `revert` | `rework revert` | P3 | leaf |
| `make-public` | RETIRE? (Q1) or `dataset publish make-public` | P1 | leaf |
| `delete-dataset` | `dataset delete` | P1 | leaf |
| `bulk-delete` | `dataset bulk-delete` | P1 | leaf |
| `publish` (hidden) | stub, repointed to `dataset publish` | P1 | leaf |
| `withdraw` (hidden) | stub, repointed to `dataset withdraw` | P1 | leaf |
| `restore` (hidden) | stub, repointed to `dataset restore` | P1 | leaf |
| `annex-normalize` | `rework annex normalize` | P3 | leaf |
| `import-openneuro` | `import openneuro` | P4 | leaf |
| `e2e-test` | `fleet e2e-test` | P5 | leaf |
| `import` | `import` | unchanged | group |
| `import status` | `import status` | unchanged | leaf |
| `import rollback` | `import rollback` | unchanged | leaf |
| `import retry` | `import retry` | unchanged | leaf |
| `import verify` | `import verify` | unchanged | leaf |
| `recover` | RETIRE? (Q2) or `rework recover` | P3 | group |
| `recover status` | RETIRE? (Q2) or `rework recover status` | P3 | leaf |
| `exemplar` | `dataset exemplar` | P1 | group |
| `exemplar create` | `dataset exemplar create` | P1 | leaf |
| `exemplar status` | `dataset exemplar status` | P1 | leaf |
| `exemplar remint-dois` | `dataset exemplar remint-dois` | P1 | leaf |
| `fleet` | `fleet` | unchanged | group |
| `fleet drift` | `fleet drift` | unchanged | leaf |
| `fleet enforce` | `fleet enforce` | unchanged | leaf |
| `fleet require-review` | `fleet require-review` | unchanged | leaf |
| `fleet revalidate` | `fleet revalidate` | unchanged | leaf |
| `fleet annex-policy` | `rework annex annex-policy` | P3 | leaf |
| `fleet key-registration` | `rework annex key-registration` | P3 | leaf |
| `fleet content-recovery` | `rework annex content-recovery` | P3 | leaf |
| `reindex` | `dataset reindex` | P1 | leaf |
| `availability-report` | `fleet sweep availability` | P5 | leaf |
| `hed-sweep` | `fleet sweep hed` | P5 | leaf |
| `recording-stats-sweep` | `fleet sweep recording-stats` | P5 | leaf |
| `signal-defaults-sweep` | `fleet sweep signal-defaults` | P5 | leaf |
| `data-integrity-sweep` | `fleet sweep data-integrity` | P5 | leaf |
| `zarr-fidelity-sweep` | `fleet sweep zarr-fidelity` | P5 | leaf |
| `upstream-backfill` | `repull upstream-backfill` (retire after the fleet backfill, Q4) | P4 | leaf |
| `upstream-status` | `repull upstream-status` | P4 | leaf |
| `anonymity-sweep` | `fleet sweep anonymity` | P5 | leaf |
| `doctor` | `dataset doctor` | P1 | group |
| `doctor scan` | `dataset doctor scan` | P1 | leaf |
| `doctor fix` | `dataset doctor fix` | P1 | leaf |
| `doctor kinds` | `users kind-check` | P2 | leaf |
| `email-preferences` | `users email-preferences` | P2 | group |
| `email-preferences show` | `users email-preferences show` | P2 | leaf |
| `email-preferences update` | `users email-preferences update` | P2 | leaf |
| `notice` | `notice` | unchanged | group |
| `notice list` | `notice list` | unchanged | leaf |
| `notice set` | `notice set` | unchanged | leaf |
| `notice clear` | `notice clear` | unchanged | leaf |
| `notify` | `notify` | unchanged | leaf |
| `summary` | `fleet summary` | P5 | group |
| `summary check` | `fleet summary check` | P5 | leaf |
| `zarr-catalog` | `fleet zarr-catalog` | P5 | group |
| `zarr-catalog publish` | `fleet zarr-catalog publish` | P5 | leaf |
| `backfill-names` | `users backfill-names` | P2 | leaf |
| `import-issue-triage` | `import triage` | P4 | leaf |
| `import-coverage` | `import coverage` | P4 | leaf |
| `import-weekly` | `import weekly` | P4 | leaf |
| `backfill-usernames` | `users backfill-usernames` | P2 | leaf |
| `duplicates` | `users duplicates` | P2 | leaf |
| `neurobagel` | `neurobagel` | unchanged | group |
| `neurobagel regenerate` | `neurobagel regenerate` | unchanged | leaf |
| `neurobagel status` | `neurobagel status` | unchanged | leaf |
| `neurobagel verify` | `neurobagel verify` | unchanged | leaf |
| `pr-reviews` | `pr-reviews` | unchanged | group |
| `pr-reviews list` | `pr-reviews list` | unchanged | leaf |
| `pr-reviews show` | `pr-reviews show` | unchanged | leaf |
| `pr-reviews start` | `pr-reviews start` | unchanged | leaf |
| `pr-reviews approve` | `pr-reviews approve` | unchanged | leaf |
| `pr-reviews next` | `pr-reviews next` | unchanged | leaf |
| `pr-reviews allow` | `pr-reviews allow` | unchanged | leaf |
| `pr-reviews block` | `pr-reviews block` | unchanged | leaf |
| `pr-reviews clear` | `pr-reviews clear` | unchanged | leaf |
| `pr-reviews standing` | `pr-reviews standing` | unchanged | leaf |
| `repull` | `repull` | unchanged | group |
| `repull plan` | `repull plan` | unchanged | leaf |
| `repull execute` | `repull execute` | unchanged | leaf |
| `repull status` | `repull status` | unchanged | leaf |
| `repull resume` | `repull resume` | unchanged | leaf |
| `repull merge` | `repull merge` | unchanged | leaf |
| `repull abandon` | `repull abandon` | unchanged | leaf |
| `repull auto` | `repull auto` | unchanged | leaf |
| `oidc` | `oidc` | unchanged | group |
| `oidc end-account` | `oidc end-account` | unchanged | leaf |
| `oidc logout-deliveries` | `oidc logout-deliveries` | unchanged | leaf |
| `oidc clients` | `oidc clients` | unchanged | group |
| `oidc clients add` | `oidc clients add` | unchanged | leaf |
| `oidc clients list` | `oidc clients list` | unchanged | leaf |
| `oidc clients show` | `oidc clients show` | unchanged | leaf |
| `oidc clients rotate-secret` | `oidc clients rotate-secret` | unchanged | leaf |
| `oidc clients disable` | `oidc clients disable` | unchanged | leaf |
| `oidc keys` | `oidc keys` | unchanged | group |
| `oidc keys list` | `oidc keys list` | unchanged | leaf |
| `oidc keys rotate` | `oidc keys rotate` | unchanged | leaf |
| `oidc keys revoke` | `oidc keys revoke` | unchanged | leaf |
| `mail` | `mail` | unchanged | group |
| `mail list` | `mail list` | unchanged | leaf |
| `mail show` | `mail show` | unchanged | leaf |
| `mail reply` | `mail reply` | unchanged | leaf |
| `mail note` | `mail note` | unchanged | leaf |
| `mail summarize` | `mail summarize` | unchanged | leaf |
| `mail assign` | `mail assign` | unchanged | leaf |
| `mail status` | `mail status` | unchanged | leaf |
| `mail close` | `mail close` | unchanged | leaf |
| `mail escalate` | `mail escalate` | unchanged | leaf |
| `mail spam` | `mail spam` | unchanged | leaf |
| `mail blocklist` | `mail blocklist` | unchanged | group |
| `mail blocklist add` | `mail blocklist add` | unchanged | leaf |
| `mail blocklist remove` | `mail blocklist remove` | unchanged | leaf |
| `mail queues` | `mail queues` | unchanged | group |
| `mail queues set` | `mail queues set` | unchanged | leaf |
| `mail away` | `mail away` | unchanged | group |
| `mail away show` | `mail away show` | unchanged | leaf |
| `mail away set` | `mail away set` | unchanged | leaf |
| `mail away clear` | `mail away clear` | unchanged | leaf |
| `mail reprocess` | `mail reprocess` | unchanged | leaf |
| `compute` | `compute` | unchanged | group |
| `compute policy` | `compute policy` | unchanged | group |
| `compute policy show` | `compute policy show` | unchanged | leaf |
| `compute policy set` | `compute policy set` | unchanged | leaf |
| `compute pool` | `compute pool` | unchanged | group |
| `compute pool show` | `compute pool show` | unchanged | leaf |
| `compute pool grant` | `compute pool grant` | unchanged | leaf |
| `compute pool adjust` | `compute pool adjust` | unchanged | leaf |
| `compute status` | `compute status` | unchanged | leaf |
| `compute observer` | `compute observer` | unchanged | group |
| `compute observer mint` | `compute observer mint` | unchanged | leaf |
| `compute jobs` | `compute jobs` | unchanged | group |
| `compute jobs cancel` | `compute jobs cancel` | unchanged | leaf |
| `compute jobs advance` | `compute jobs advance` | unchanged | leaf |
| `compute jobs list` | `compute jobs list` | unchanged | leaf |
| `compute jobs record` | `compute jobs record` | unchanged | leaf |
| `compute jobs report` | `compute jobs report` | unchanged | leaf |
| `compute jobs access-report` | `compute jobs access-report` | unchanged | leaf |
| `compute jobs hold` | `compute jobs hold` | unchanged | leaf |
| `compute jobs release-hold` | `compute jobs release-hold` | unchanged | leaf |
| `compute jobs holds` | `compute jobs holds` | unchanged | leaf |
| `compute jobs access-reports` | `compute jobs access-reports` | unchanged | leaf |
| `compute jobs requeue-access-report` | `compute jobs requeue-access-report` | unchanged | leaf |
| `compute move-charge` | `compute move-charge` | unchanged | leaf |
| `compute pipeline` | `compute pipeline` | unchanged | group |
| `compute pipeline run` | `compute pipeline run` | unchanged | leaf |
| `compute pipeline status` | `compute pipeline status` | unchanged | leaf |
| `compute access` | `compute access` | unchanged | group |
| `compute access list` | `compute access list` | unchanged | leaf |
| `compute access grant` | `compute access grant` | unchanged | leaf |
| `compute access deny` | `compute access deny` | unchanged | leaf |
| `compute access suspend` | `compute access suspend` | unchanged | leaf |
| `compute access revoke` | `compute access revoke` | unchanged | leaf |
| `compute runners` | `compute runners` | unchanged | group |
| `compute runners register` | `compute runners register` | unchanged | leaf |
| `compute runners list` | `compute runners list` | unchanged | leaf |
| `compute runners revoke` | `compute runners revoke` | unchanged | leaf |
| `compute runners usage` | `compute runners usage` | unchanged | leaf |
| `compute derivatives` | `compute derivatives` | unchanged | group |
| `compute derivatives list` | `compute derivatives list` | unchanged | leaf |
| `compute derivatives show` | `compute derivatives show` | unchanged | leaf |
| `compute derivatives promote` | `compute derivatives promote` | unchanged | leaf |
| `compute derivatives sync` | `compute derivatives sync` | unchanged | leaf |

Totals: 118 nodes unchanged, 82 moved or retired (P1 41, P2 16, P3 7, P4 6, P5 12).

## Flag normalization

ADR 0135 decision 4: `--apply` is the one flag that makes a dry-run-by-default command write.
The other spellings stay as hidden aliases on the commands that had them (Commander `Option.hideHelp()`, parsed into the same `apply` key), so a script keeps working while it is changed.

| Command today | Write flag today | Becomes | Phase |
|---|---|---|---|
| `repo unpublish` (admin.ts:3809) | `--execute` | `dataset unpublish --apply` | P1 |
| `repo withdraw` (admin.ts:3887) | `--execute` | `dataset withdraw --apply` | P1 |
| `repo restore` (admin.ts:3999) | `--execute` | `dataset restore --apply` | P1 |
| `recover` (admin.ts:4893) | `--execute` | `rework recover --apply` (if kept, Q2) | P3 |
| `upstream-backfill` (admin.ts:7902) | `--execute` | `repull upstream-backfill --apply` | P4 |
| `neurobagel regenerate` (admin.ts:10618) | `--execute` | `neurobagel regenerate --apply` | P6 |
| `availability-report` (admin.ts:7104) | `--write` | `fleet sweep availability --apply` | P5 |
| `summary check` (admin.ts:9250) | `--fix` (with `--yes`) | `fleet summary check --apply` | P5 |
| `fleet enforce`, `require-review`, `revalidate`; `fleet annex-policy`, `key-registration`, `content-recovery`; `backfill-names`, `backfill-usernames`; `import-issue-triage`, `import-coverage`, `import-weekly` | `--apply` | unchanged flag, new path where the table says | with the move |

Commands that write by default and take `--dry-run` to preview are not flipped by this plan (ADR 0135 decision 4 unifies the flag name, not the default):
`annex-normalize` (admin.ts:4221), `reindex` (6930, bulk only), `doctor fix` (8213), `notify` (8942), `pr-reviews start` (admin-pr-reviews.ts:1287) and `approve` (1993), `repo publish start` (admin-publish-review.ts:98) and `compute pipeline run` (admin-compute-pipeline.ts:257).
Whether the bulk ones among them (`annex-normalize`, `reindex --all`, `doctor fix`) should become dry-run by default is Q6.

`run-upstream-repull.yml` passes `--yes` and `--automatic-dispatch` to `repull` only; no workflow passes `--execute`, `--write` or `--fix`,
so the alias step breaks nothing outside the CLI.
`check-summary-drift.yml` prints `summary check --fix --yes` in issue text; that text changes in P5.

## Cross-repository inventory

Fail-at-once means each executed caller below must change in the same release as the path it names.
"Executed" means a workflow, cron or script runs it; "text" means a person reads it.

### Executed callers

| Where | What it runs | Breaks in | How it breaks |
|---|---|---|---|
| nemarDatasets/.github `.github/workflows/onboard-openneuro.yml:177-178` (copy in nemar-cli `.github/dataset-workflows/onboard-openneuro.yml:177`) | `nemar admin import-openneuro --help`, then a bash match for `--tag <tag>` | P4 | `--help` exits 1, `|| true` hides it, the tag check reads "no --tag" and drops the tag with a warning; then :184 fails under `pipefail`. The first symptom is misleading |
| same file :184, :330, :424 | `admin import-openneuro <id> --phase prepare|copy|finalize --trust-upstream [--shard] [--tag]` | P4 | every OpenNeuro import fails at the prepare phase |
| same, install at :148, :315, :395 | `bun install -g nemar-cli` | | unpinned: the release reaches it on the next dispatch |
| nemarDatasets/.github `.github/workflows/approve-publication.yml:347-351` | `nemar admin repo --help`, ANSI stripped, regex for an indented `publish` line; picks `admin repo publish approve`, else `admin publish approve` | P1 | works through the `repo` alias only if `nemar admin repo --help` still prints `publish` on its own indented line. If `help-groups.ts` ever folds `publish` onto the "More commands" line, the fallback picks the dead stub and every web-button approval fails |
| same :354, :368 (install :198-207, dist-tag `latest` or `dev`) | `admin repo publish approve <id> --yes [--resume]` | P1 (alias keeps it working) | unpinned dist-tag |
| nemarDatasets/.github `.github/workflows/run-upstream-repull.yml:316-319, 341-342` (copy in nemar-cli `.github/dataset-workflows/run-upstream-repull.yml`) | `admin repull plan|execute|resume ... --automatic-dispatch` | never (paths unchanged) | pinned to `client_payload.cli_version` (:232-238) |
| nemar-cli `.github/workflows/check-summary-drift.yml:159, 165, 168, 309, 335` | names `nemar admin summary check [--fix --yes] [--id] [--json]` in an issue body | P5 | text only, but in a weekly issue operators copy from |
| nemarOrg/website `src/lib/publication-queue.ts:196` (`cliApproveCommand()`), tests at `src/lib/publication-queue.test.ts:199, 206, 220, 330, 338, 352` | builds `nemar admin publish approve <id> [--resume]` for an admin to paste | **already broken** | that path has exited 1 since 0.10.34 (ADR 0125); fix now, independent of this epic |
| nemar-observability `scripts/check-manifests.ts:95`, asserted at `test/check-manifests.test.ts:112` | remediation text `nemar admin doctor fix missing-manifest` in a scheduled alert | P1 | text in an alert, and a test pins the string |

Parity guard: `test/dataset-workflow-parity.test.ts` compares nemar-cli's `.github/dataset-workflows/*.yml` with nemarDatasets/.github `main` (checked out in `test.yml:1007-1015`).
A change to `onboard-openneuro.yml` therefore cannot land in one repository first without turning that test red in nemar-cli; the two pull requests merge together, or the nemarDatasets copy is first made to accept both paths (see Phases, P4).

### Backend and shared text users see (nemar-cli, ships with the release)

| file:line | Names | Phase |
|---|---|---|
| backend/src/services/email.ts:1332, 1333, 1522 | `nemar admin approve <username>` / `--id` (signup and upload-access mail) | P2 |
| email.ts:1382, 1527 | `nemar admin users --awaiting-approval` | unchanged |
| email.ts:1612, 1613, 1660 | `admin compute access grant|list` | unchanged |
| email.ts:1821 | `admin import status|rollback <id>` | unchanged |
| email.ts:2085, 2086, 2091 | `admin repo publish approve|deny|list` | P1 (alias works; text should say `dataset`) |
| email.ts:2934 | `admin delete-dataset <id>` | P1 |
| services/ticket-notify.ts:107; routes/users.ts:161 | `admin email-preferences` | P2 |
| services/identifier-screen.ts:151, 155, 888, 900, 929, 961 | `admin repo publish approve|screen` | P1 |
| services/unpublish.ts:133, 139; routes/datasets/publication.ts:942; routes/admin/fleet.ts:285 | `admin repo restore`, `repo publish deny`, `repo unpublish` | P1 |
| services/enrich-dataset.ts:1248; routes/admin/doi.ts:764 | `admin backfill-names --apply` | P2 |
| services/import-coverage.ts:460 | `admin import-coverage` (issue body) | P4 |
| services/import-failure-cause.ts:115, 142, 156 | `admin fleet content-recovery`, `admin import-openneuro <ds> --tag`, `admin import retry` | P3, P4 |
| services/import-weekly-summary.ts:457, 566 | `admin upstream-status`, `admin repull auto` | P4 |
| routes/admin/user-edit.ts:342 | `admin approve <username>` | P2 |
| shared/contract/admin-user.ts:107-111 | `role`, `approve`, `revoke`, `kind`, `duplicates --clear` | P2 |
| shared/contract/device-auth.ts:154 | `admin keys create` | P2 |
| shared/contract/publication.ts:173; shared/publication-review.ts:1088-1092 (the `COMMAND_*` constants, 32 uses) | `admin repo publish <verb>` | P1 |
| shared/upstream-staleness.ts:298 | `admin upstream-backfill` | P4 |
| services/upstream-repull-verified.ts:346; services/oidc-clients.ts:744; routes/admin/users.ts:1323; shared/pr-review.ts:1319, 1624; shared/contract/account-copy.ts:185 | `repull resume`, `oidc clients list`, `compute runners`, `pr-reviews`, `compute` | unchanged |

About 68 comment-only mentions in `backend/src` (including migrations 0021, 0075, 0076, 0080, 0082, 0092, 0113, 0118) and 12 in `shared` change with their phase where they describe current behavior; migrations are never edited.
`backend/wrangler-sccn.toml` names commands in comments at 199, 317, 477, 509 and 529.

### CLI text that points at another admin command (nemar-cli `src/`)

Outside the admin command files: `src/commands/auth.ts:2098, 2565`; `src/commands/dataset.ts:2097, 3087, 4928, 4933, 6035`; `src/lib/upload/finalize.ts:347`; `src/lib/fleet-annex-policy.ts:456, 476`; `src/lib/publication-review-{approve,next,display}.ts`; `src/lib/import-publication.ts:311-314`; `src/lib/import-openneuro.ts:231, 457, 2299, 2422, 2490, 2496`; `src/lib/exemplar-clone.ts:603, 809, 842, 860, 887`; `src/lib/admin-user-lookup.ts:297`; `src/lib/admin-command.ts:34`; `src/lib/normalize-dataset.ts:385`; `src/lib/upstream-status-report.ts:138`; `src/lib/import-finalize-gate.ts:149`; `src/lib/repull/auto-view.ts:161`; `src/lib/repull/execute/register.ts:258`.
The `src/lib/repull/*` hints name `repull` and `pr-reviews` paths, which do not move.
Inside the admin files: the `admin --help` examples at admin.ts:323-331 (name `approve`, `role`, `ci check`, `s3 regenerate-iam`, `doi create`), the `make-public` help (3409-3472), the users hints (376, 726-756, 952-953, 1114-1387, 1455), doi help 2594, stub targets 4092-4094, recover 4925, 5133, fleet annex-policy 6209, 6454, backfill-usernames 10310.
`src/lib/help-groups.ts:40-52` names the admin lead block (`users`, `approve`, `revoke`, `repo`, `pr-reviews`, `mail`, `doi`, `make-public`, `delete-dataset`, `notify`, `doctor`); `test/help-tiers.unit.test.ts` fails on a name that no longer exists, so it changes in every phase.

### Tests in nemar-cli

149 test files name an admin path (the per-file count is in the phase sections).
The ones that spawn the CLI with an old path, by phase:

- P1: `admin-publish-cli-harness` (42 argv), `admin-publish-exit-codes-cli` (35), `admin-publish-review-cli` (17), `publish-list-filter` (15), `admin-restructure` (13), `publish-workflow` (10), `identifier-screen-cli` (8), `admin-route-skew-cli` (7), `admin-publish-approve-token-cli` (7), `admin-unpublish-cli` (6), `admin-publish-approve-cli` (5), `admin-publish-deny-request-cli` (3), `publish-withdraw-cli` (2), `admin-publish-deny-help-cli` (2), `admin-publish-{next,list-skew,approve-all-done}-cli`, `test/helpers/admin-publish-cli.ts`, `completion-candidates.unit:229`, `admin-route-inventory.unit:136`.
- P2: `admin-users-search-edit-cli` (role), `admin-backfill-usernames-cli` (14), `admin-kind-cli` (12, includes `doctor kinds`), `cli` (approve), `admin-duplicates-cli` (10), `email-preferences-community-cli` (9), `admin-approve-tier-cli` (8), `admin-keys-cli` (8), `admin-revoke-id-cli` (7), `email-preferences` (5), `admin-verify-cli` (4), `identifier-sweep-cli` (3).
- P3: `cli` (revert), `recover-datasets-packaging` (4), `release-version-flag` (6, `recover status`).
- P4: `upstream-status-cli` (55), `import-weekly-cli` (32), `import-issue-triage-cli` (18), `upstream-backfill-cli` (17), `import-coverage-cli` (16), `onboard-workflow`, `import-openneuro-tag-option.unit`, `import-tag-pin.integration`, `dataset-workflow-parity`.
- P5: `recording-signal-sweeps-cli` (18), `zarr-fidelity-sweep-cli` (10), `hed-sweep-cli` (10).
- P6: `admin-neurobagel-cli` (44, `regenerate --execute`).

Tests that walk the Commander tree rather than spawn it (`repull-command-text.unit`, `repull-workflow`, `publication-review-contract`, `facet-cli-correspondence.unit`) and about 60 files that only assert strings are swept with the phase whose strings they assert.

### Docs (nemarOrg/docs, docs.nemar.org)

- `src/content/docs/admin/commands.mdx` is generated by `scripts/generate-commands.ts` (`bun run gen:commands`), which runs `../nemar-cli/src/index.ts <path> --help-all` and parses each `Commands:` block.
  No workflow runs it; it is refreshed by hand. Regenerate it in each release that moves a path.
- Hand-written pages that name moved paths: `admin/index.md`; `admin/operations/publication-lifecycle.md` (3-21, 42, 44, 71, 104); `cli/guides/publishing.md` (149-223, 304-329, 411, 516-519); `admin/operations/identifier-screening.md`; `admin/operations/upstream-freshness.md`; `admin/operations/account-tiers.md` (3-147); `admin/operations/account-kinds.md` (16-103); `admin/operations/community-mail-sends.md` (`email-preferences update`); `admin/operations/support-tickets.md` (219-221); `admin/operations/staging-environment.md` (24, 236, 301, 366, 380); `admin/operations/access-policies.md` (249, 252, 255, 445; 249 names `nemar admin sandbox`, which does not exist); `admin/operations/zarr-serving.md` (125, 223-227); `admin/operations/systems-inventory.md` (33, 264, 412); `admin/disaster-recovery/*`; `admin/github-app-setup.md:278`; `develop/zenodo-testing.md:118, 139`; `platform/api.md:70`; `platform/identifier-screening.md:137`.
  Generated public pages `cli/commands/dataset.mdx:817, 822` and `cli/commands/auth.mdx:238, 476` regenerate from the CLI's own text.
- Unchanged paths (`repull`, `pr-reviews`, `compute`, `oidc`, `mail`) need no edit: `upstream-repull*.md`, `pr-reviews.md`, `compute-*.md`, `oidc-clients.md`.

### Other text outside nemar-cli

- nemarDatasets/.github `.github/ISSUE_TEMPLATE/import-failure.yml:56` (`import verify`, unchanged) and `docs/import-failure-procedure.md:31-39`, which already names the dead `nemar admin withdraw` and a `recover <id>` call that refuses ids off its list without `--force --execute`.
- nemarDatasets/.github `approve-publication.yml:425` and `run-prescreen.yml:22, 222`: hint and comments naming `repo publish`.
- nemar-db-backup `README.md:26` (`reindex`), nemar-infisical `RESUME.md:59` and nemar-private `.context/runbook-copy-dataset.md:129` (`e2e-test`).
- `nemar admin docs ...` appears in the AGENTS.md of six repositories; `docs` does not move.
- No tracked cron or systemd unit on Hallu, nemaring or Expanse runs `nemar admin`; host-only crontabs could not be read (Risks).
- nemar-tools is archived and names no admin command.

### Docs inside nemar-cli

AGENTS.md:50 (`e2e-test`), README.md (134, 256, 326-400, 596), `.rules/datasets-and-fixtures.md` (16, 17, 66, 85, 103), `.memory/manifest-healing-dispatch-over-rest.md:10` (`doctor fix`), `.context/scrub-runbook.md` (82, 1275, 1279 still name the removed `repo public`), `.context/recover-runbook.md`, `.context/release-safety-playbook.md:45`, `.context/access_control.md`, `.context/plan-multi-archive-importer.md`, `.context/plans/ieeg-geometry/plan.md:62` (a proposed `admin ieeg-geometry`, which belongs in `rework`).
ADRs name old paths 159 times in 41 files; they are records and are not edited (ADR 0135 is the pointer).
Historical `.context` documents are not edited.

## Phases

One epic, `/project:epic-dev`, phase pull requests squash-merged into the epic branch, the epic merged into `dev`.
Each phase moves one group: new paths, the stubs for the old ones, the flag aliases for what it moves, every in-repo caller and test, and the help lead block.
Each phase leaves `main` releasable: nothing half-moved, every old path either working or a stub.

**Ship together.**
Because fail-at-once breaks unattended callers on the first release, the recommended release is the whole epic at once (Q8): one relearning event, one release note, one docs regeneration.
If phases are released one by one instead, these couplings are hard:

- P4 cannot reach `main` until the nemarDatasets `onboard-openneuro.yml` change is ready to merge the same hour (the parity test makes it the same moment for nemar-cli CI).
- P1 must keep `nemar admin repo --help` printing `publish` on its own line, or `approve-publication.yml` must change with it.
- The website `cliApproveCommand` fix and the nemar-observability alert text should merge before or with P1.

### P0: the scaffolding

- `src/lib/moved-commands.ts`: one table of `{ oldPath, newPath }` and one function that registers each old path as a hidden stub (`allowUnknownOption`, `allowExcessArguments`, one line to stderr, `markReportedExit()`, exit 1). The three ADR 0125 stubs move into it.
- `src/lib/apply-flag.ts`: one helper that declares `--apply` with hidden `--execute`, `--write` or `--fix` aliases on the same key.
- Acceptance: `test/moved-commands.unit.test.ts` spawns every stub in the table and asserts exit 1, the one-line pointer, and that no HTTP request was made (a `Bun.serve` stand-in that fails on any request, per `.rules/testing.md`); `test/admin-restructure.test.ts` keeps passing on the three existing stubs.
- Ships alone; changes no path.

### P1: `dataset` (rename `repo`, gather the per-dataset commands)

- `repo` becomes `dataset` with alias `repo`; `ci`, `doi`, `exemplar`, `doctor` (less `kinds`), `s3 lock`, `s3 credential-check`, `delete-dataset`, `bulk-delete`, `reindex` move under it.
- Retire `regenerate-iam` and `s3 regenerate-iam` (Q3); decide `make-public` (Q1).
- Repoint the ADR 0125 stubs to `dataset ...`.
- `--execute` on `unpublish`, `withdraw`, `restore` becomes `--apply` with the hidden alias.
- Update `shared/publication-review.ts` `COMMAND_*`, the backend strings listed above, `help-groups.ts`, the README.
- Acceptance: every P1 row of the table resolves (`nemar admin <new> --help` exits 0) and every old path exits 1 with its pointer; `nemar admin repo publish approve --help` still works (alias); `nemar admin repo --help` prints `publish` on its own indented line (a test that runs the exact regex from `approve-publication.yml:347-351`).
- Named tests: `test/moved-commands.unit.test.ts` (P1 rows), `test/admin-restructure.test.ts`, `test/help-tiers.unit.test.ts`, the publish CLI tests listed above with their argv updated, `test/approve-publication-probe.unit.test.ts` (new, the regex).
- Outside: website `cliApproveCommand` (already broken), nemar-observability alert text, docs pages.

### P2: `users`

- `approve`, `revoke`, `role`, `verify`, `kind`, `duplicates`, `keys`, `email-preferences`, `backfill-names`, `backfill-usernames` move under `users`; `doctor kinds` becomes `users kind-check`.
- Check first that adding subcommands named `approve`, `revoke` and so on under `users` does not collide with `users`'s own positional search argument (`users <query>` is not declared today, but `users show <query>` is; a bare `nemar admin users approve` must reach the subcommand).
- Update the approval mail (`email.ts:1332, 1333, 1522`), `routes/admin/user-edit.ts:342`, `shared/contract/admin-user.ts:107-111`, `shared/contract/device-auth.ts:154`, `ticket-notify.ts:107`, `routes/users.ts:161`, `enrich-dataset.ts:1248`, `src/lib/admin-command.ts:34`.
- Acceptance: the approval mail renders `nemar admin users approve <username>` (backend mail test asserts the rendered body); every P2 old path is a stub.
- Named tests: the P2 CLI tests above, `backend/test/tier-emails.test.ts`, `backend/test/admin-user-edit-route.test.ts`.

### P3: `rework`

- `revert`, `annex-normalize` (to `rework annex normalize`), `fleet annex-policy`, `fleet key-registration`, `fleet content-recovery` (to `rework annex ...`), and `recover` (Q2).
- Update `import-failure-cause.ts:115`, `import-finalize-gate.ts:149`, `repull/execute/register.ts:258`, `fleet-annex-policy.ts:456, 476`, the ieeg-geometry plan's proposed path.
- Acceptance and tests: the P3 rows; `test/cli.test.ts` (revert), the fleet annex CLI tests, `recover-datasets-packaging`, `release-version-flag`.

### P4: `import` and upstream (ships with nemarDatasets)

- `import-openneuro` becomes `import openneuro`; `import-coverage`, `import-weekly`, `import-issue-triage` become `import coverage|weekly|triage`; `upstream-status` and `upstream-backfill` move under `repull`.
- Change `.github/dataset-workflows/onboard-openneuro.yml` (help probe at :177, calls at :184, :330, :424) and the same file in nemarDatasets/.github.
  Recommended order: first a nemarDatasets pull request that probes `nemar admin import openneuro --help` and falls back to `import-openneuro`, mirrored into nemar-cli's copy in the same nemar-cli phase pull request so the parity test stays green; then the CLI release; then a follow-up removing the fallback from both copies.
  The fallback lives in the workflow, not the CLI, so ADR 0135 decision 5 holds.
- Update backend `import-coverage.ts:460`, `import-failure-cause.ts:142, 156`, `import-weekly-summary.ts:457`, `shared/upstream-staleness.ts:298`, `src/lib/import-openneuro.ts:457`, `src/lib/repull/auto-view.ts:161`, `src/lib/upstream-status-report.ts:138`.
- `upstream-backfill --execute` becomes `--apply`.
- Acceptance: `test/onboard-workflow.test.ts` asserts the workflow calls only paths that exist in the current tree (walk the Commander tree for each `nemar admin ...` the YAML contains); `test/dataset-workflow-parity.test.ts` green.
- Named tests: the P4 CLI tests above.

### P5: sweeps and checks into `fleet`

- The six `*-sweep` commands and `availability-report` become `fleet sweep <name>`; `summary`, `zarr-catalog`, `e2e-test` move under `fleet`.
- `availability-report --write` and `summary check --fix` become `--apply`.
- Update `.github/workflows/check-summary-drift.yml` text, AGENTS.md:50 and `.rules/datasets-and-fixtures.md` (`e2e-test`), `src/commands/dataset.ts:2097`.
- Acceptance and tests: the P5 rows; `recording-signal-sweeps-cli`, `zarr-fidelity-sweep-cli`, `hed-sweep-cli`.

### P6: the last flag, the help, the docs

- `neurobagel regenerate --execute` becomes `--apply`.
- A tree test: no visible admin option is named `--execute`, `--write` or `--fix` (`test/admin-write-flag.unit.test.ts`, walking the tree); no visible top-level entry is a leaf other than `notify` and `docs`; no path is deeper than three below `admin`.
- `help-groups.ts`: with 14 entries the admin fold may be dropped; update its comment and the 43 in `help.ts`.
- Regenerate docs.nemar.org `admin/commands.mdx`; edit the hand-written pages; release note listing every moved path.
- Acceptance: the epic-to-`dev` full `bun test` and the live tier on staging; a staging walk-through of one import dispatch, one web-button approval and the summary-drift workflow.

## Risks

- **An unattended caller nobody inventoried.** Host-only crontabs on Hallu, nemaring and Expanse were not readable, GitHub code search missed all of nemarDatasets/.github, and only the nm000103 shims of about 900 dataset repositories were checked. Mitigation: the stubs write one line to stderr, so a broken cron mails its owner; ask Yahya to grep the three hosts' crontabs before release.
- **`approve-publication.yml` parses help.** It already falls back to a dead path; any help change that folds `publish` breaks web approvals. P1's regex test guards it.
- **Parity test ordering.** `dataset-workflow-parity` turns red if either copy of `onboard-openneuro.yml` changes alone.
- **Rebase load.** `src/commands/admin.ts` is about 10,850 lines and other branches edit it (the RFC program's `feature/rfc-program` and `feature/rfc-R3-weekly-rfc-line` edit `import-weekly`). Move code by group with no behavior edits in the same commit, and keep each phase short-lived.
- **Old CLIs and new mail.** An administrator on an old CLI who follows the new approval mail text gets "unknown command". Low cost; the release note says to update.
- **Stubs pile up.** The table grows by about 80 rows; removal is a later decision (Q9).
- **`backfill-usernames --apply` sends mail.** Moving it is harmless, but any test or walk-through that runs it with `--apply` against staging re-sends verify mail (the dead-command check measured 25 retries pending in production on 2026-11-22). Never run it with `--apply` as part of this epic.

## Owner questions

Each with a recommendation; the first four came from the 2026-11-21 open items.

1. **`make-public`: retire or keep?** It still works (`POST /datasets/:id/publish`, a full bare flip with no DOI, request or screen), ADR 0086 keeps it as the administrator path around the screen, and it is in the help lead block; but it makes the "public with no publication" half state ADR 0125 says the CLI can no longer produce.
   *Recommendation:* retire it (stub pointing at `dataset publish`), and if a break-glass path around the screen is still wanted, make it `dataset publish approve --break-glass` with an ADR 0125 amendment naming the exception.
2. **`recover`: retire or move?** Near-dead: bound to the 45 ids in `scripts/recover-datasets.json`, epic #967 closed in July, and `fleet content-recovery` is the general repair now.
   *Recommendation:* run the read-only `nemar admin recover status --all` once; if all 45 are complete, retire both into stubs pointing at `rework annex content-recovery`; if not, move to `rework recover` and retire after.
3. **`regenerate-iam` and `s3 regenerate-iam`: retire?** Dead: the action prints a deprecation and sends nothing; the backend route answers 410.
   *Recommendation:* retire both to stubs; keep the 410 route (it is the sentence an old caller gets).
4. **`upstream-backfill`: move or retire?** Live and unfinished: 568 of 611 mirrors are `not_examined` and the fleet run is the owner's step after the on003645 and on004362 re-pulls.
   *Recommendation:* move to `repull upstream-backfill` now, retire after the fleet run.
5. **`backfill-names` and `backfill-usernames`.** `backfill-names` is drained (production dry run: 0 to fill) and names now come from ORCID at sign-up, but an approval error still tells admins to run it. `backfill-usernames` assigns nothing (8 left, all single names) yet re-sends verify mail to 25 accounts per `--apply`.
   *Recommendation:* retire `backfill-names` and change the approval hint; move `backfill-usernames` to `users backfill-usernames` and file the mail-retry side effect as its own issue (out of this epic).
6. **Bulk writers that write by default.** Should `annex-normalize`, `reindex --all` and `doctor fix` become dry-run by default with `--apply`?
   *Recommendation:* yes for `annex-normalize` and `doctor fix` (they rewrite git history or dispatch repairs), no for `reindex` (idempotent, run by people and docs as a plain refresh). Do it in the same phase as the move, since the path already breaks there.
7. **`maint` or `maintenance`?** Resolved by the owner on 2026-11-22: neither.
   There is no maintenance group; the sweeps, the summary and Zarr catalog checks and `e2e-test` fold into `fleet`, which avoids a third meaning for "maintenance" (the ADR 0132 mail category and maintenance mode).
   `availability-report` goes to `fleet sweep availability`.
8. **One release or one per phase?**
   *Recommendation:* one release for the whole epic, announced in advance through a CLI notice (`admin notice set`) a week before, so the break is a single event.
9. **How long do stubs live?**
   *Recommendation:* until the next minor version after the release (0.11 or 0.12, whichever comes second), then removed with a release note; the stub table makes it one deletion.
10. **`doi create`.** Superseded by the publication orchestrator, and its `--provider zenodo` always answers 400.
    *Recommendation:* keep as `dataset doi create` (a repair tool for a failed orchestrator run) but drop `--provider`.
11. **`mail`, `notice`, `notify` stay three top-level entries?** `mail` is support tickets, which is easy to confuse with community mail sent by `notify`.
    *Recommendation:* keep all three where they are in this epic; a `support` rename for tickets can be its own decision.
12. **`bulk-delete`.** *Recommendation:* move as `dataset bulk-delete`; folding it into `dataset delete <ids...>` changes behavior and belongs in its own change.
