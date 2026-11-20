# Card DOC1: the method page at docs.nemar.org/data/ieeg-geometry/

Status: ready
Tier: worker
Timebox: S, half a day; escalate at 1 day
Needs: none
Depends: none
Branch: docs/ieeg-geometry-method
Worktree: /Users/yahya/Documents/git/nemar/docs-worktrees/ieeg-geometry-method (`git -C /Users/yahya/Documents/git/nemar/docs fetch origin && git -C /Users/yahya/Documents/git/nemar/docs worktree add <path> -b docs/ieeg-geometry-method origin/main`)
Plan: /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/ieeg-geometry/.context/plans/ieeg-geometry/plan.md (settled design, all rulings, owner decisions); step DOC1

## Goal

`https://docs.nemar.org/data/ieeg-geometry/` exists and explains, for dataset authors and users, what NEMAR's computed iEEG geometry files are, how each is made and verified, how to read their provenance, and how authors replace or remove them; every sidecar the pipeline writes already links to this URL.

## Context

- The docs repository is Astro Starlight (read its `AGENTS.md`): pages are Markdown under `src/content/docs/<path>`, the sidebar is hand-listed in `astro.config.mjs` (`sidebar:`), there is no `data/` section yet, a links validator fails the build on broken links, and policy-hygiene rules ban em dashes.
- Facts to explain (read the plan, ADR 0129 and the ADR 0111 amendment in nemar-cli `epic/ieeg-geometry` `.context/decisions/`, and `scripts/ieeg_geometry/README.md` there): the three methods (labels for contacts already on fsaverage, FreeSurfer surface-based registration for cortical contacts, SPM deformation inversion for depth contacts), the evidence grades and checks in plain words with their thresholds, what is never written (affine depth positions, `MNI` without a variant, `Talairach`, relabeling `ACPC` or `ScanRAS`), the `space-` file pair and its "Computed by NEMAR" description, `.nemar/ieeg-geometry.json`, how mirrors receive files (N.0.1) and datasets pushed to NEMAR (a pull request), that a re-pull regenerates them and that an author's own file at the same path always wins, that hand-edited pipeline files are kept, and that subject surfaces appear in the Brain panel as display data only.

## Scope

`src/content/docs/data/ieeg-geometry.md` (new) and the sidebar entry (a new "Data" group, or under the closest existing group if a new group is against the repo's rules), plus any index page the links validator needs. Nothing else.

## Decided design

Settled: public page; no ADR or `.context` references, no host names; semantic line breaks (one sentence per line); American spelling; no em dashes; define abbreviations on first use (intracranial EEG (iEEG), electrocorticography (ECoG), stereo-EEG (sEEG)); cite FreeSurfer, SPM and the MNI templates with their papers; say plainly what each check can and cannot show (the SPM field check excludes only errors of roughly 10 mm or more; depth-contact checks are plausibility checks).
The implementer may choose: headings and order.

## Acceptance

- The repo's build and checks pass (`bun run build` or the repo's equivalent, including the links validator); quote their last lines.
- The page renders at `/data/ieeg-geometry/` in the dev server (screenshot or the built HTML path).

## Gates

The docs repo's own lint and build commands from its `AGENTS.md`.

## Stop conditions

- The repo forbids a new top-level sidebar group: put it under Platform and report the URL change (the pipeline's link would then need changing in nemar-cli; report it, do not edit nemar-cli).

## Report

Your final message is the report, at most 25 lines: PR number (into the docs repo's default branch) and head commit hash; gates; the final URL; deviations; questions.
