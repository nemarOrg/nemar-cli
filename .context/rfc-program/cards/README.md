# Worker preamble

This preamble is sent before every card of the RFC program.

- One card, one branch, one pull request (PR), in the worktree or clone the card names; use absolute paths.
- Only the manager merges, and some PRs are merged only by the owner; never merge, and never push to an integration branch.
- Push once per review round; never force-push or rebase a pushed branch.
- Stay inside the card's Scope; anything else goes in the report as a patch note for its owner.
- Run every gate yourself and quote its last lines; a computed value is never reported as measured.
- Stop and report on any stop condition, or when the card seems wrong.
- No computer use, no visible graphical user interface (GUI) runs, no secrets read or printed.
- Never create, rename or delete a repository, a setting, a Discussion, a label set, a tag or a release; never comment outside your own PR; never send mail or announce anything.
- Never touch a live dataset, production data, or a re-pull switch; every production or GitHub call outside your PR is a read.
- Write American English, avoid em-dashes, define every abbreviation once on first use, and use semantic line breaks in prose source (one sentence per line, more breaks at clause punctuation in long sentences).
  Text posted to GitHub (PR bodies, comments) keeps each paragraph on one line.
- Commits are atomic, with subjects under 50 characters, no emojis, and no AI or co-author attribution.
- Tooling is fixed: Bun for JavaScript and TypeScript (never npm or npx), Biome for lint and format, uv for Python (never pip or conda).
- Tests use real code paths; no mocks of business logic.
  A local HTTP stand-in (`Bun.serve`) is allowed for testing a client's behavior against GitHub's API.
- The owner decisions of 2026-11-20 in `.context/rfc-program/plan.md` section 2 are settled; do not reopen them.
- The final message is the report, in the card's Report section, at most 25 lines.
