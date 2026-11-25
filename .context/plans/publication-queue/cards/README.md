# Worker preamble (sent before every card)

You are implementing one card of the publication-queue plan (epic nemarOrg/nemar-cli#2182).
Plan: `/Users/yahya/Documents/git/nemar/nemar-cli-worktrees/epic-publication-queue/.context/plans/publication-queue/plan.md`.

- One card, one branch, one PR into the base the card's Branch line names (`feature/issue-2182-epic-pq-decide` or `feature/issue-2182-epic-pq-evidence`), in the worktree the card names.
  Create the worktree yourself: `git -C /Users/yahya/Documents/git/nemar/nemar-cli worktree add <worktree> -b <branch> origin/<base>`.
  If git-annex breaks the worktree's `.git` file, restore it to a `gitdir:` file (memory `annex-worktree-git-symlink`).
  Then run `bun install` at the worktree root and in `backend/` before any gate (a fresh worktree otherwise runs the wrong biome).
  Use absolute paths.
- Read `AGENTS.md` and the ADRs the card names before editing.
  Never edit the primary checkout `/Users/yahya/Documents/git/nemar/nemar-cli`.
  Never `git stash`: the stash is shared across worktrees.
- **No production or staging commands of any kind.**
  That means no `nemar` CLI against a real server, no wrangler, no `gh workflow run`, no writes to `nemarDatasets/*`.
  Read-only `gh api` reads of public metadata and of `nemarDatasets` repository trees are allowed only where the card says so.
  A spawned CLI in a test gets an environment built from nothing, with an isolated `NEMAR_CONFIG_DIR`.
- The PR body references `#2182` and the phase issue the manager gives you.
  Push with the `neuromechanist` gh account (`gh auth status` shows it active).
- Only the manager merges, and only after the PR's own `project:pr-review-toolkit` review.
  Push once per review round; never force-push or rebase a pushed branch.
  To take in the base, merge it.
- Stay inside Scope; put anything else in the report as a patch note for its owner.
- Tests are real (`.rules/testing.md`): no mocks that replace business logic.
  Real recordings or real registry responses as fixtures, with their provenance and license recorded in a README beside them.
  Every new rule gets a test that fails when the rule's line is reverted; mutate in the dangerous direction too (widen a bound, not only narrow it).
- **Transparency rule:** every new finding kind, status, incomplete reason or outcome gets its entry in the vocabulary table A1 defines.
  The entry holds the statement, what was read, the remedy and the docs anchor; a missing entry fails the typecheck.
  No user-visible sentence is written at a call site.
- Never print or log a header value, an identifier, an email or a secret, in tests, reports or PR text.
- Commits: atomic, subject under 50 characters, no emojis, no co-author or AI attribution.
  PR text: no hard line breaks inside a paragraph.
- Quick gates, run on the final head and quoted in the report:
  `bun run typecheck`, `bun run lint`, and the targeted `bun test <files>` the card names.
  Never the full `bun test`: it takes about 80 minutes.
- Stop and report on any stop condition, or when the card seems wrong.
- Scratch files (mutation scripts, downloads, logs) go only under a directory named after your step id inside the session scratchpad, for example `<scratchpad>/A4/`. The scratchpad is shared by parallel agents, and a script with a common name has been overwritten and run against another agent's worktree. A mutation script must refuse to run unless its working directory is your own worktree.
- No computer use, no visible GUI runs, no secrets.
- Your final message is the report, at most 25 lines:
  PR number and head commit; gates with their quoted last lines; evidence paths; a revert check per rule; deviations from the card; questions for the lead; patch notes for other owners.
