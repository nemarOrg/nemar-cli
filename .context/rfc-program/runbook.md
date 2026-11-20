# RFC program: the manager's runbook

Follow the `project:manager-loop` skill's tick exactly; this file adds only what is specific to this program.
The board helper is `python3 /Users/yahya/.claude/plugins/cache/research-skills/project/0.12.0/skills/manager-loop/scripts/manager_board.py`, written `MB` below.
The board is `.context/rfc-program/board.md` in the worktree `/Users/yahya/Documents/git/nemar/nemar-cli-worktrees/rfc-program`.

## What to read

- Every tick: `MB status <board>` and the events it points to.
- The first tick of a session, once: [`plan.md`](plan.md) sections 0, 2 and 4, [`queue.md`](queue.md), [`checkpoints.md`](checkpoints.md), [`risks.md`](risks.md).
- Never: the `research/` notes, the whole log, or a worker's full transcript.

## Tools

| Need | How |
| --- | --- |
| Dispatch | Agent tool, `run_in_background: true`, model from the board's Parity for the card's tier, name `impl-<step>`; send `cards/README.md`, then the card verbatim, then the live facts |
| Message a live worker | SendMessage to its name |
| Review | `project:pr-review-toolkit` with a Sonnet panel of two (code or text, and tests); a different model family from the implementer when possible |
| Ask the owner | `MB ask` first, then AskUserQuestion, at most four questions per call |
| Notify | PushNotification, once per event class per day |
| Wake | ScheduleWakeup: 1800 seconds while a worker runs, 3600 while everything waits on the owner |

## Repositories, worktrees, gates

| Repository | Integration branch | Where workers work | Quick gates |
| --- | --- | --- | --- |
| nemarOrg/nemar-cli | `feature/rfc-program` | `git worktree add /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/rfc-STEP -b BRANCH origin/feature/rfc-program` | `bun install && bun run typecheck && bun run lint`, plus the card's targeted tests |
| nemarOrg/rfcs | `main` | a clone at `/Users/yahya/Documents/git/nemar/rfcs`, one branch per card | `bun install && bun run lint && bun test` |
| nemarOrg/biosig-zarr | `main` | a clone at `/Users/yahya/Documents/git/nemar/biosig-zarr`, one branch per card | the card's gates (B1 defines them) |
| nemarOrg/docs | `main` | `git worktree add /Users/yahya/Documents/git/nemar/docs-worktrees/rfc-STEP -b BRANCH origin/main` | `bun install && bun run build && bun test` |

In a fresh nemar-cli worktree, run `bun install` at the root and in `backend/` before any gate (a stale `bunx` Biome reports a schema error that is not a broken configuration).
The full `bun test` of nemar-cli (about 80 minutes) is never run for this program; only targeted tests and the quick gates.

## First tick of a session

1. `MB tick <board> --manager mba-claude-sonnet --state running --next 30m`.
2. Reconcile every step in `active` or `review` with its PR and worktree, per the skill.
3. Before any dispatch, run `git ls-remote origin feature/rfc-program`.
   If it prints nothing, step O0 is not done: ask the owner once to approve the plan, and dispatch nothing until the lead has pushed the branch and logged the approval.
4. For every step already in state `owner`, ask the owner now, once, with the exact commands from `plan.md` section 5 (O1's two browser steps at the time of writing).
5. Read `risks.md` and ask about any risk whose "Read by" date is within two days.

## Blocked steps and questions

Ask an open question when the step it names is the next one to unblock (its other dependencies are `done` or `active`), batched by Needed by, at most four per call; also ask any question whose Needed by is within two days.

Steps that wait on an owner answer are `blocked`, and their Next cell names the questions (for example "waits on Q1 to Q7").
When every question a blocked step names is `answered`, record each answer with `decide <text> --by owner`, set the questions `closed`, and set the step `todo`.
Answers become live facts on the card at dispatch: paste them under a heading "Owner answers" after the card.

## Owner steps

Steps with tier `owner` (O0, O1, O1b, O2, O4, O4b, O4c, O5, O6) are never dispatched, and neither are the lead's checkpoint steps C3 and C4 or the lead's step E0, which run in the owner's session.
Steps in state `owner`, and C3 and C4, are exempt from the timebox, silent-worker and twice-the-timebox handlers; they are asked about, never escalated.
When an owner step's dependencies are `done`, set it `owner`, and ask the owner once, with the exact commands from `plan.md` section 5, to run it and say when it is done.
Verify by observation before setting it `done`:

| Step | Observation |
| --- | --- |
| O1 | `gh api repos/nemarOrg/rfcs -q .has_discussions` prints `true`, and `gh api graphql -f query='{repository(owner:"nemarOrg",name:"rfcs"){discussionCategories(first:20){nodes{name}}}}'` lists `RFCs` |
| O1b | `gh api repos/nemarOrg/rfcs/rulesets` lists a ruleset whose rules include `required_status_checks` with `rfc-check` |
| O2 | `gh api repos/nemarOrg/biosig-zarr -q .visibility` prints `public`, and the biosigio#179 comment exists (`gh issue view 179 -R neuromechanist/biosigio --comments`) |
| O0 | `git ls-remote origin feature/rfc-program` prints a line, and `board-log.md` Decisions holds "plan approved" by owner |
| E0 | `gh issue list -R nemarOrg/nemar-cli --search "RFC program in:title" --state open` lists the epic issue |
| O4 | `gh release view 2.0.0 -R nemarOrg/biosig-zarr --json isPrerelease -q .isPrerelease` prints `false` |
| O4b | `gh release view 3.0.0-draft.1 -R nemarOrg/biosig-zarr --json isPrerelease -q .isPrerelease` prints `true` |
| O4c | `gh release view 3.0.0-draft.2 -R nemarOrg/biosig-zarr --json isPrerelease,targetCommitish -q '[.isPrerelease,.targetCommitish]'` prints `true` and B5's merge commit |
| R2, B3, SC1 (owner-merged, or manager-merged on the owner's authorization) | `gh pr view N -R nemarOrg/docs --json mergedAt -q .mergedAt` prints a time; then set the step `done` |
| C3, C4 | the lead's checkpoint PR into `feature/rfc-program` is merged and the owner's decision is recorded in the RFC file on `main` of nemarOrg/rfcs |
| O5, O6 | the RFC PR is merged, and `gh api repos/nemarOrg/rfcs/contents/README.md` lists the RFC as `open` |

## Event handlers specific to this program

- **A PR to nemarOrg/docs passes its merge gate** (R2, B3, SC1): set the step `owner`, and ask the owner to review and merge it, or to authorize the manager to merge that PR (see "Never").
- **An RFC text PR or the version 3 text PR passes its merge gate** (B4, B4b, V2, B6): set the step `done` with Next "draft waits for the owner", leave the PR open, and unblock the owner step.
- **B5's PR passes its merge gate**: merge it into `draft/3.0.0` with a merge commit (it keeps the Developer Certificate of Origin sign-offs), never into `main`; then set O4c `owner` and ask the owner to run it, or to say that the manager runs it.
- **Dispatching a card whose inputs are another step's report** (B4 needs B2's report; B4b needs B5's report; S1 takes any newer output path or summary that the scan session remi:18769 relays, otherwise its card names the scan directory; N1 needed Q15, Q31 and Q32): paste them under "Reports from dependencies" after the card, with the owner answers and the later owner decisions from `board-log.md` Decisions that the card names under "Owner answers".
- **An RFC closes** (its close instant passes): set C3 (or C4) `todo` and notify the owner and the lead that the checkpoint is due.
- **A worker reports that a needed read was refused** (for example a production query in V1): do not retry and do not work around it; set the step `owner` and hand the owner the exact command from the worker's report.
- **A reviewer argues against an owner decision in `plan.md` section 2**: give the finding the outcome "rejected: owner decision of 2026-11-20", citing the item.
- **An ADR number collides** (another PR took it first): the worker takes the next unused number and renames the file; this is mechanical and needs no escalation.
- **A checkpoint is due** (see `checkpoints.md`): stop dispatching the steps in its Gates column, notify the owner and the lead, and wait for the lead's card PR.

## Never, in addition to the skill's list

- Create, rename or delete a repository, a Discussion or a Discussion category; these stay the owner's, always.
- Apply a repository or organization setting, a ruleset, a label set, a tag or a release, unless all three hold:
  a merged, reviewed file (for example `ops/ruleset-main.json`) or the exact command in `plan.md` section 5 specifies it;
  the owner has said, for that step, that the manager runs it;
  and the manager has recorded that instruction with `decide "<step>: owner asked the manager to run it" --by owner` before acting.
  Then run exactly what the file or the command says, nothing else, and verify with the step's observation in "Owner steps" before setting the step `done`.
  The owner did this on 2026-11-20 for O1b (the ruleset), O4 (release `2.0.0`) and O4b (pre-release `3.0.0-draft.1`).
- Merge a PR in nemarOrg/docs, unless the owner has authorized the manager for that PR, recorded the same way with `decide` (as for B3, docs#128, on 2026-11-20); the authorization covers that PR only.
- Merge an RFC text PR, or merge `feature/rfc-program` into `dev`.
- Comment on an issue or PR in another repository (biosigio#179 is the owner's).
- Send mail, post news or a command-line interface (CLI) notice, or announce anything.
- Touch a live dataset, a re-pull switch, or production data; V1 is read-only.
- Edit `package.json` version in nemar-cli.
