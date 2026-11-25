# Runbook: publication-queue manager

## Start prompt

```text
You are the manager of nemar-cli epic #2182, the publication-queue track.
Run one tick of the runbook at /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/epic-publication-queue/.context/plans/publication-queue/runbook.md, exactly as written, using the project:manager-loop skill.
The state is the board beside it: /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/epic-publication-queue/.context/plans/publication-queue/board.md.
Your manager id is mba-claude-opus, the same on every tick.
Do not write product code.
Do not change the plan, a card, a gate, the parity, or a budget limit.
When the runbook says to stop or to ask, or does not cover what you see, record it on the board, ask the owner with a structured question, and stop that thread of work.
```

Run it on the self-paced `/loop` with no interval.

## What to read

- **Every tick:** `python3 <skill>/scripts/manager_board.py status <board>`, and the events it points to.
- **First tick of a session:** this runbook, `queue.md`, `checkpoints.md` and `risks.md`, once.
- **Never:** the whole log, fixtures, or large evidence.

`<skill>` is `/Users/yahya/.claude/plugins/cache/research-skills/project/0.15.1/skills/manager-loop`.

## Tools

| Action | How |
| --- | --- |
| Dispatch | Send `cards/README.md`, then the card verbatim, then the live facts (the epic branch tip from `git rev-parse origin/feature/issue-2182-epic-publication-queue` and the open PRs), to the Agent tool as a background agent with the model from the board's Parity row for the card's tier, named after the step id. |
| Message a worker | SendMessage to the agent's name. |
| Review | The `project:pr-review-toolkit` skill on the PR, with the lenses the diff calls for; reviewers on Sonnet 5.5 (owner rule). |
| Ask the owner | AskUserQuestion, and record it on the board first with `ask`. |
| Wake | ScheduleWakeup with the start prompt. |

## Events

- **Report arrives:** verify by observation, as in the skill.
  Also check that every new kind, status or reason has a copy entry: `git grep -n "KIND_COPY\|STATUS_COPY\|INCOMPLETE_COPY"` in the PR diff, plus the typecheck.
  Then start the review.
- **Review returns:** two rounds at most; give each finding an outcome.
- **A check fails because of the diff:** send it back to the worker; after two attempts, escalate to the lead.
- **A1 merges:** set A2, A6 and A9 ready; they all touch the registry, so see `queue.md` for the collision rule.
- **A1 and A3 both merged:** set A4 and A5 ready.
- **A7 merges:** ask owner question Q-A8: the policy for images and documents, with the three options from the report, the recommended one marked, and the dataset counts.
  Then the lead completes card A8.
- **A2, A4, A5, A6 and A9 merged:** the lead completes card A10 (CP1).
- **Every A step done:** checkpoint CP2.
- **B2 approved by the owner:** the lead completes cards B3, B4 and B5.

## Never (project additions)

- Run any `nemar` command against production or staging, any wrangler command, or any `gh workflow run`.
- Write to `nemarDatasets/*`.
  Approve, deny or acknowledge a publication request: these are owner actions, handed over as exact commands.
- Merge the epic into `dev`, or anything into `main`.
- Turn on `PUBLICATION_REVIEW_ENABLED` or any switch.
