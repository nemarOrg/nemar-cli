# Runbook: publication-queue manager

## Start prompt

```text
You are the manager of nemar-cli epic #2182, the publication queue: lanes D (decide) and E (evidence).
Run one tick of the runbook at /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/epic-publication-queue/.context/plans/publication-queue/runbook.md, exactly as written, using the project:manager-loop skill.
The state is the board beside it: /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/epic-publication-queue/.context/plans/publication-queue/board.md.
Your manager id is mba-claude-opus, the same on every tick.
Do not write product code.
Do not change the plan, a card, a gate, the parity, or a budget limit.
When the runbook says to stop or to ask, or does not cover what you see, record it on the board, ask the owner with a structured question, and stop that thread of work.
```

Run the start prompt on the self-paced `/loop` with no interval.

## What to read

- **Every tick:** `python3 <skill>/scripts/manager_board.py status <board>` and the events it points to.
- **First tick of a session:** this runbook, `queue.md`, `checkpoints.md` and `risks.md`, once.
- **Never:** the whole log, fixtures, or large evidence.

`<skill>` is `/Users/yahya/.claude/plugins/cache/research-skills/project/0.15.1/skills/manager-loop`.

## Tools

| Action | How |
| --- | --- |
| Dispatch | Send `cards/README.md`, then the card verbatim, then the live facts (the base tip from `git rev-parse origin/<base>`, the phase issue number, and the open PRs) to the Agent tool as a background agent, named after the step id, with the model from Parity for the card's tier. |
| Message a worker | SendMessage to the agent's name. |
| Review | The `project:pr-review-toolkit` skill on the PR, with the lenses the diff calls for; reviewers run on Sonnet 5.5. |
| Ask the owner | `ask` on the board first, then AskUserQuestion. |
| Wake | ScheduleWakeup with the start prompt. |

## Merge gate (an exception to the skill, approved with the plan)

Phase PRs into an epic branch are gated locally (owner rule, 2026-10-26).
The manager runs these on the PR's final head, in a fresh worktree of that head:
- `bun install` (root and `backend/`);
- `bun run typecheck && bun run lint`;
- `bunx biome check <changed files>`;
- `bash scripts/ci/unit-pure-files.sh | xargs bun test --parallel=4`;
- the card's targeted tests.

Then the review in the `Review` cell, then the squash-merge.
The remote live tier is not awaited, and the PR gets a comment saying so.
An epic PR into `dev` waits for full remote CI, and the owner merges it.

## Events

- **Report arrives:** verify by observation.
  Every new kind, status or reason must have its copy entry (the typecheck proves this).
  For reader cards, the false-positive numbers must be in the PR.
  Then start the review.
- **Review returns:** at most two rounds; every finding gets an outcome.
- **A check fails because of the diff:** send it back; after two attempts, escalate to the lead.
- **After every merge:**
  - `git worktree remove` the step's worktree;
  - delete the local branch;
  - run `df -h /` and stop dispatching below 20 GiB free (memory `clean-scratch-after-each-phase`).
- **A1 merged:** A2, A6 and A9 become ready.
  **A1 and A3 merged:** A4 becomes ready.
  **A4 merged:** A5 becomes ready.
- **D2 merged:** CP-D1.
  **ADR 0139 approved:** CP-D2.
  **The D steps listed in CP-D3 merged:** CP-D3.
- **The steps listed in CP-E1 merged:** CP-E1.
  **Every lane E step done:** CP-E2.
- **At CP-D3 and CP-E2:** the manager runs the `seam` review, opens the epic PR into `dev`, sets the step to `owner`, and hands over the owner commands from `checkpoints.md`.

## Never (project additions)

- Run any `nemar` command against production or staging, any wrangler command, or any `gh workflow run`.
- Write to `nemarDatasets/*`.
- Approve, deny or acknowledge a publication request.
- Merge an epic into `dev`, or anything into `main`.
- Turn on any switch (`PUBLICATION_REVIEW_ENABLED`, `PUBLICATION_AUTO_DENY_MODE`).
