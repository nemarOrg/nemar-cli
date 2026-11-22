# ADR 0135: The admin command tree is grouped by object, three levels deep at most, and a moved command fails at once

**Status:** accepted
**Date:** 2026-11-22
**Owner:** Seyed Yahya Shirazi
**Refines:** ADR 0125 decision 7 (the stub style for moved commands)

## Context

`nemar admin` had 200 command nodes on 2026-11-22 (origin/dev 63254f1c): 55 top-level entries, 51 of them visible, and at most three levels below `admin`.
Width, not depth, is what makes it hard to use.
A sweep, a backfill, an import report and a one-off repair sit beside the user queue at the same level,
so `src/lib/help-groups.ts` has to fold 40 names onto a "More commands" line for plain `--help` to be readable at all.
The same verb is spelled four ways for "really write": `--apply`, `--execute`, `--write` and `--fix`, and several commands write unless `--dry-run` is given.

ADR 0125 decision 7 moved the dataset lifecycle under `admin repo` and left the old top-level spellings as hidden stubs that run nothing and exit 1 naming the new path.
No ADR says how the rest of the tree is shaped, so every new command picks its own place.
The owner settled the main lines on 2026-11-21: `repo` becomes `dataset`, a `rework` group holds repairs to existing datasets, account commands go under `users`, `--apply` is the one write flag, and old paths fail at once with no forwarding period.

## Decision

1. **A top-level admin group names an object, and its children are verbs or sub-objects of it.**
   The groups are `users`, `dataset` (alias `repo`), `rework`, `repull`, `import`, `fleet`, `compute`, `oidc`, `pr-reviews`, `neurobagel`, `mail`, `notice`, `notify` and `docs`.
   A new command joins an existing group; a new top-level group needs a line in this ADR's index entry or a superseding ADR.
2. **Depth is capped at three levels below `admin`** (`admin <group> <sub-group> <verb>`), which is today's deepest path.
   A group aims at no more than about twelve visible children; past that, a sub-group is made rather than a fourth level.
3. **`rework` holds operations that change the content or history of a dataset that already exists:** revert, the annex repairs, content recovery, and later scrub, re-conversion and iEEG geometry.
   `repull` stays its own top-level group, because it mints a version DOI per merge and has its own switches (ADR 0111).
   `fleet` holds what runs across all datasets or checks the platform without changing a dataset's content: governance, the derived-metadata sweeps, the summary and catalog checks and the end-to-end test.
   There is no separate maintenance group.
4. **`--apply` is the one flag that makes a dry-run-by-default command write.**
   `--execute`, `--write` and `--fix` stay accepted as hidden aliases of `--apply` on the commands that had them, so a script keeps working while its spelling is changed.
   A command that writes by default today keeps its default unless its own phase says otherwise; the flag name, not the default, is what this ADR unifies.
5. **A moved command fails at once (refines ADR 0125 decision 7).**
   The old path stays registered as a hidden command that accepts any arguments, runs nothing, prints one line naming the new path to stderr and exits 1, in the same release that adds the new path.
   There is no forwarding period: a forwarding alias would let an unattended workflow keep calling a path nobody reads.
   The stubs are declared once, in one table, and a test asserts each one exits 1 without a request.
   A group alias (`repo` for `dataset`) is the one exception, because it names the same object and no reader is misled by it.
6. **A path change ships with every caller outside the CLI that names the path, in the same release.**
   Workflows install the latest CLI unpinned, so the nemarDatasets `.github` workflows, backend mail and notice text, docs.nemar.org and the scripts that call a moved command change in the same release as the CLI, never after it.

## Consequences

- Plain `nemar admin --help` lists 14 groups instead of 51 commands; the "More commands" fold in `help-groups.ts` stops carrying most of the tree.
- Every operator relearns paths once, and every script that names an old path breaks loudly on the first run after the release; the stub's one line is the migration guide.
- A release that moves a command is cross-repository work: it cannot ship until the nemarDatasets workflows and the docs that name the path are ready to merge with it.
- The stubs accumulate; removing one is a later decision with its own release note, not something this ADR schedules.
- A new command has a place to go by rule, so the tree should not widen again without a decision.

## Alternatives considered

- **Forward old paths to new ones for a release.** Keeps scripts running, but an unattended workflow would never notice, and the forwarding table becomes permanent in practice. Rejected by the owner on 2026-11-21.
- **Group by frequency (daily, weekly, rare).** Matches how `help-groups.ts` folds help today, but a command's frequency changes and its object does not, so paths would move again.
- **Go deeper (four levels) to keep every group small.** People get lost below three levels, and the deepest paths today (`admin oidc clients add`, `admin compute jobs cancel`) already sit at three.
- **Keep the flat tree and rely on `--help` folding.** Presentation only: the names still collide (`import`, `import-openneuro`, `import-coverage`) and a new command still has no rule for where it goes.

## Amendment 2026-11-22: `make-public` is retired

The owner's answer on `make-public`: the CLI command `nemar admin make-public` is retired, not moved.
Its old path is a retired-command stub that says a bare visibility flip that skipped the publication request and screen no longer exists, and to use `nemar admin dataset publish`;
it does not point at `dataset publish` as its new home, because that is the request, screen and approve workflow, not a bare flip.
The backend route `POST /datasets/:id/publish` stays, and no break-glass flag is added to the approval path.

## Receipts

- Owner decisions of 2026-11-21 on the admin tree.
- `.context/admin-cli-restructure/plan.md`: the old-to-new path table, the flag list and the cross-repository inventory.
- ADR 0125 decision 7 and its stubs in `src/commands/admin.ts` (`publish`, `withdraw`, `restore`).
- `src/lib/help-groups.ts` and `test/help-tiers.unit.test.ts` (the help fold this tree makes mostly unnecessary).
