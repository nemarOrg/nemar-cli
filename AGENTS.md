# NEMAR CLI — Development Instructions

> Tool-agnostic project instructions for any coding agent (Codex, Cursor, Copilot, Windsurf,
> Claude Code, ...). Claude Code reads this via `@AGENTS.md` in `CLAUDE.md`.

**This file is the rules, not the reference.** What it still contains is the set of things that
can go badly wrong in THIS checkout and are not obvious from the code: which datasets are live,
which environment shares real users, what CI owns, and where decisions are recorded. Everything
that merely describes the platform now lives at `docs.nemar.org` and is linked below.

**Read the hard rules in full before you edit anything.** Follow a link when you are about to
touch that area.

This file used to be 669 lines, most of it a second copy of the documentation site. Two copies
drift, and this epic exists because they did (ADR 0057). If you are about to add a paragraph
here explaining how part of the platform works, that paragraph belongs on `docs.nemar.org`; add
a link here instead.

---

## Retrieval: how to read the linked material

Public pages need nothing: fetch the URL. **Every page also has a Markdown mirror**, which is
what to fetch if you are a program rather than a browser, and `https://docs.nemar.org/llms.txt`
indexes them.

The mirror sits at the page path with `.md` appended and **no trailing slash**: the tables below
spell URLs as `/cli/commands/`, and the mirror of that page is `/cli/commands.md`, not
`/cli/commands/.md`. Drop the slash before adding the extension.

```bash
curl -s https://docs.nemar.org/cli/commands.md
```

Pages under `/admin/` are gated: `nemarOrg/docs` is private at source and the gate admits the
`admin` and `owner` roles only (ADR 0056, ADR 0059). An admin holding a CLI key reads one
without a browser:

```bash
nemar admin docs admin/operations/systems-inventory
nemar admin docs admin/operations/validated-workflows cli/commands   # several share one session
```

That trades the stored API key for a fifteen-minute, read-only, documentation-scoped session;
the key itself never reaches the documentation host.

---

## If you cannot read something you need

**Open the issue anyway.** Losing read access must not cost you the ability to report a problem
(ADR 0057).

If you hit an admin-adjacent problem, or need a runbook you cannot open, file the issue on the
relevant repository, say plainly what you could not read and what you were trying to do, and tag
**`@nemarOrg/admins`**. Someone with access will either answer or open the page for you.

Escalation replaces read access. **Silence does not.** A blocked agent that stops without saying
so is the failure mode this instruction exists to prevent: the problem stays real and nobody
learns it exists.

---

## START HERE: Architecture Decision Records

**[`.context/decisions/`](.context/decisions/README.md) records what was decided and why.**
Read the index before designing anything,
and before "fixing" something that looks wrong —
several of the oddities in this codebase are deliberate, and the ADR says which.

- **Where an ADR and any other doc disagree, the ADR wins.**
  Design docs under `.context/` keep the analysis; the ADR is the verdict.
- **Never delete an ADR. Supersede it** (see ADR 0019 for what a superseded one looks like).
- **Write a new one** when a decision is expensive to reverse, closes off other reasonable paths,
  has been argued more than once, or encodes a constraint that is not obvious from the code.
  Copy `0000-template.md`, number sequentially, and add it to the index in `README.md` —
  a test enforces that the index and the files on disk agree.

Load-bearing ones to know before touching the relevant area:
0005 (partial data still serves), 0009 (dev D1 is not a prod mirror),
0010 (never client-stream an import), 0012 (archive size policy),
0016 (never hand-bump versions), 0020 (workflow edits hit ~785 repos at once),
0023 (`--clean` reconciles, it does not wipe), 0027 (Zarr discovery is raw-only),
0028 (MaxShield MEG is filtered or declined),
0029 (the Zarr conversion engine lives here, not in the Actions repo),
0030 (bounded streaming is the default; `.set` is the exception),
0031 (one annex policy module; `_motion.tsv` is data despite the extension),
0032 (facet filters are declared once and report what they exclude),
0033 (the queue stamps which engine converted each dataset; pre-stamp rows are declared current),
0034 (`datasets` stays one table under an enforced column budget; derive, don't store),
0040 (`verified` is the base tier; admin approval is the only writer of upload access),
0042 (upload access is requested once, by the person who wants it),
0043 (one person, one account: an ORCID iD, an email or a GitHub handle backs at most one live account),
0044 (identity self-service reaches the CLI; ORCID links through a browser handoff whose
signed state names the account),
0045 (the CLI and the web say one thing about an account),
0048 (account kinds are explicit: person, service, test; superseding 0045's role-based
ORCID-gap exemption),
0051 (a specific import error is never overwritten by a generic one),
0052 (an import-failure tracking issue closes on verified state, and a burst rolls up),
0053 (silence is only evidence of a problem when there was work to do),
0054 (the weekly import report arrives whether or not anything is wrong, and unknown is
never rendered as zero),
<<<<<<< HEAD
0058 (an imported tree is brought onto the annex policy in prepare: an inherited
=======
0060 (an imported tree is brought onto the annex policy in prepare: an inherited
>>>>>>> origin/dev
`.gitattributes` outranks the configured policy, and stripping it without installing
ours annexes everything).

**Account copy and the profile-gap matrix are declared once, in
[`shared/contract/account-copy.ts`](shared/contract/account-copy.ts) and
[`shared/contract/profile-gaps.ts`](shared/contract/profile-gaps.ts)** (ADR 0045).
Every sentence about tiers, upload access or a missing field comes from the first;
`computeProfileGaps` in the second is the ONE rule behind `profile_gaps` on
`GET /users/me`, `profile_gaps` on `GET /auth/me`, and the `missing` array a refused
upload-access request carries. `nemarOrg/website` transcribes both files and a drift
test on each side compares them when both checkouts are present. Change a sentence or a
rule there, never at a call site; `cli.`-prefixed keys are the CLI's own and the website
ignores them.

---

## Hard rules

### Live datasets

**`nm000103`-`nm000107` are LIVE.** Do NOT modify their visibility, S3 data, DOIs,
or repo settings during development or testing.
They are kept private during dev for maximum control but contain real data.

For end-to-end testing use `nm099999`, created on demand via
`POST /admin/datasets/nm099999/reset` (lazily created if missing):

```bash
nemar admin e2e-test --verbose      # reset, upload, clone, download, update cycle
nemar admin e2e-test --skip-reset   # reuse existing nm099999 state
```

The 10-step pipeline lives in `src/lib/e2e-test.ts` and sources
`test/fixtures/bids-minimal/`. `xx`-prefix datasets are blocked from publishing.

### Dev D1 shares production users and the GitHub org

`nemar-db-dev` no longer mirrors production's dataset catalog — it was purged to the curated
fixtures only (the seven `xx0999NN` exemplars plus the private E2E dataset `nm099999`)
and must stay that way. **Do not re-seed production `nm`/`ds` rows into dev D1.**

But the `users` table was **not** purged: it still holds roughly 609 real email addresses,
and the dev worker holds a live `RESEND_API_KEY`.
The `nemarDatasets` GitHub org is also **shared** between prod and dev, since the org name is
hardcoded rather than environment-scoped.
So a dev-side job that selects users by a generic predicate can still email real people,
and a cascade delete can still destroy a real repo.
The catalog purge removed one blast-radius vector; it did not remove the reason these fences exist.

Admin-facing notification mail (new-user approval, upload-access and publication requests,
import recovery, cron digests) is production-only by default,
via `getAdminEmailsForCategory`'s fence in `backend/src/services/email.ts`.
Set `DEV_ADMIN_NOTIFICATIONS=1` only for a deliberate staging test of admin mail.
The dev worker's `DEV_EMAIL_ALLOWLIST` is a Worker secret holding exact human addresses, never a domain:
`@nemar.org` has a catch-all that lands in a real inbox, and `@nemar.test` fixtures get their sign-in codes echoed in the response instead of delivered.

`users.account_kind` (ADR 0048) is explicit on the seeded fixtures: `test-owner` and `test-admin`
are `service` (operational, no human signs in to them directly); `test-user`, `test-pending`,
`test-verified`, and `test-revoked` are `test` (a persona, not a real identity); `test-web` stays
`person`: it is the shared web-QA account and has to reach the ORCID authorize page and the
Settings key form the way a real person would.

**A new daily cron job is production-only BY DEFAULT.** The dev cron is governed by a fail-safe
allowlist in `scheduled()`. Before adding a job to the non-prod set, confirm it cannot email a
real user, dispatch GitHub work against `nemarDatasets`, or mutate a real DOI or prod-bucket object.

Authentication against staging never uses production keys: use `TEST_ADMIN_API_KEY` from
`test/.env.test` — it matches the `test-admin` token seeded by `scripts/seed-dev-db.sql` —
with an isolated `NEMAR_CONFIG_DIR`, so the real `~/.config/nemar` is untouched;
`TEST_OWNER_API_KEY`, the seeded `test-owner` token, is its owner-role sibling.

### Two names that look like bugs and are not

**`ORG_NAME = "nemarDatasets"`** in `backend/src/services/github.ts`, and the publishing scripts
targeting `nemarDatasets`, are correct. Two GitHub orgs is deliberate: `nemarOrg` holds tooling
and infrastructure, `nemarDatasets` holds dataset repositories only. **Do not change these to
`nemarOrg`.** In a two-org codebase this reads as a typo, which is exactly why the warning is
here rather than left to the reader.

**EZID is the DOI registrar, not Zenodo** (ADR 0007). `.context/research.md` describes a Zenodo
flow and `docs.nemar.org/develop/zenodo-testing/` documents Zenodo sandbox testing; both are
prior art and test tooling, neither is the production path. A DOI change made on the strength of
either is wrong.

### Revocation cascades, always

Ending a credential has to end everything minted from it. API tokens are tied to a GitHub PAT
and per-user S3 credentials, and an API key can now also mint a docs session
(`POST /auth/docs/cli-session`). `services/docs-auth.ts` names the callers of
`DOCS_REVOKE_ALL_SQL` and says a new path that ends a credential needs the line too; that count
is load-bearing, so add yourself to it rather than assuming someone else did.

### Never hand-bump the version

`package.json` version is owned by CI. Do not edit it, and do **not** run
`./scripts/bump-version.sh` before a dev → main PR — a manual bump desyncs the tag,
the version, and the npm release. See ADR 0016 and the release section below.

### Work in a worktree

Do not edit the primary checkout directly; concurrent sessions share it.
Branch into a worktree first: `git worktree add <path> -b <branch> origin/dev`.

### Dataset ID bands

All inside the 0-99999 cap, so `xx900001` is invalid.

| Band | Range | Purpose | Cleanup |
|---|---|---|---|
| Prod sandbox | `xx000001`-`xx089999` | real user sandbox training | 14-day cron (prod) |
| Dev ephemeral | `xx090001`-`xx099899` | throwaway dev/e2e | dev cron |
| Dev exemplar fleet | `xx099900`-`xx099999` | curated persistent copies | **never** (`is_exemplar=1`) |

**The exemplar fleet is permanent, not ephemeral.** Seven curated `xx0999NN` copies of real public
datasets (`scripts/exemplar-fleet.json`) cover eeg / ieeg / emg / meg / multi-modal / HED,
published with **sandbox** EZID DOIs (`10.5072/FK2`, never the production `10.82901` shoulder).
Their `active`/`public` state lives in D1 and is the source of truth for the staging catalog;
it does not depend on the registrar.
The only thing that lapses is EZID's sandbox shoulder, which purges DOIs after about two weeks,
so re-mint with `nemar admin exemplar remint-dois` only when a resolvable test DOI actually matters.

Two caveats with the clone tool: it reads `AWS_ACCESS_KEY_ID`/`SECRET` from the **ambient
environment** (unlike `e2e-test.ts`, which fetches per-user S3 credentials from the backend),
and session credentials are short-lived, so export them immediately before each run.
Creation is also **not retry-safe** after a partial failure (issue #955):
recover with `nemar admin delete-dataset <id>` then recreate, rather than re-running `create`.

---

## Tooling is fixed

**Bun** for JavaScript and TypeScript, never npm or npx.
**Biome** for lint and format, never ESLint or Prettier.
**uv** for anything Python, never pip or conda.

```bash
bun install                  # dependencies
bun run src/index.ts         # run the CLI from source
bun test                     # real tests only, no mocks (.rules/testing.md)
bun run typecheck            # tsc for the CLI and the backend
bun run lint                 # biome
```

Wrangler runs through cfman, which holds the SCCN account token:
`bunx cfman wrangler --account sccn <arguments>`. There is no plain `wrangler login` on these
machines, so a command reporting "Not logged in" was run without cfman.

---

## Development workflow

1. **Check decisions** — skim `.context/decisions/README.md` for anything binding on the area
2. **Check context** — `.context/plan.md` for current tasks
3. **Branch into a worktree** — `git worktree add <path> -b feature/short-description origin/dev`
4. **Code** — follow `.rules/javascript.md`
5. **Test** — real tests with `bun test`
6. **Commit** — atomic, under 50 characters, no emojis, no co-author tags
7. **PR** — reference the context and the issue
8. **Record the decision** — if the change settled something an ADR should own,
   add one (or supersede the ADR it contradicts) in the same PR

### Epic / multi-phase development (REQUIRED)

For any multi-phase feature — an epic with sub-issues, phased delivery,
or anything spanning more than one PR — drive it with the **`/project:epic-dev`** skill.
Do not hand-roll the epic or sprint flow.
The skill owns epic and sub-issue creation and linking (`gh sub-issue`),
the epic/phase worktree structure, the per-phase plan → implement → PR → `/review-pr` →
squash-merge cycle, and the `.claude/epic.local.md` state file that tracks `current_phase`.

```
/project:epic-dev <description>     # start
/project:epic-dev --next-phase      # advance
/project:epic-dev --resume          # resume mid-phase
/project:epic-dev --finalize        # epic branch -> dev
/project:epic-status                # inspect state
```

Never let GitHub issues/PRs and `.claude/epic.local.md` drift.
Phase PRs squash-merge into the epic branch; the epic branch merges into `dev`.

---

## Everything else is on the documentation site

`nemar <group> --help` is authoritative for command behavior. For anything else:

| If you need | Go to |
|---|---|
| What a CLI command does | [CLI command reference](https://docs.nemar.org/cli/commands/) |
| Signing in, keys, the device flow | [authentication](https://docs.nemar.org/cli/getting-started/authentication/) |
| Account tiers, upload access, what a status means | [account and access](https://docs.nemar.org/cli/reference/account-access/) |
| The HTTP API surface | [API reference](https://docs.nemar.org/platform/api/) |
| Dataset download and byte-range access | [data API](https://docs.nemar.org/platform/data-api/) |
| DOIs, versioning, what is permanent | [DOI and versioning](https://docs.nemar.org/platform/doi-and-versioning/) |
| Which host serves what | [hosts and routes](https://docs.nemar.org/platform/hosts-and-routes/) |
| The Zarr serving copy, end to end | [Zarr](https://docs.nemar.org/platform/zarr/) |
| The `index.json` contract | [index contract](https://docs.nemar.org/platform/zarr/index-contract/) |
| One store's on-disk layout | [store contract](https://docs.nemar.org/platform/zarr/store-contract/) |
| What the Zarr format guarantees, and how that is checked | [format stability](https://docs.nemar.org/platform/zarr/format-stability/) |
| How a version reaches npm, and when to bump by hand | [release pipeline](https://docs.nemar.org/develop/release-pipeline/) |
| Writing and reading as an agent | [for agents](https://docs.nemar.org/platform/for-agents/) |

Gated, and worth knowing exist:

| If you need | Go to |
|---|---|
| Hosts, paths, crons, deploy procedures | [systems inventory](https://docs.nemar.org/admin/operations/systems-inventory/) |
| A proven recipe (git-annex, staging, branch protection) | [validated workflows](https://docs.nemar.org/admin/operations/validated-workflows/) |
| Zarr operations, including the maintenance commands | [Zarr serving runbook](https://docs.nemar.org/admin/operations/zarr-serving/) |
| Staging and the exemplar fleet | [staging environment](https://docs.nemar.org/admin/operations/staging-environment/) |
| Backup and restore | [disaster recovery](https://docs.nemar.org/admin/disaster-recovery/) |

---

## Rules and context, which stay in this repository

`.rules/` holds the detailed standards: [`javascript.md`](.rules/javascript.md),
[`git.md`](.rules/git.md), [`testing.md`](.rules/testing.md) (**NO MOCK policy**),
[`code_review.md`](.rules/code_review.md), [`documentation.md`](.rules/documentation.md),
[`ci_cd.md`](.rules/ci_cd.md).

`.context/` holds decisions, planning and research. Start from
[`.context/README.md`](.context/README.md), which marks what is current and what is historical.
The entries worth knowing by name: [`decisions/`](.context/decisions/README.md) (binding),
[`plan.md`](.context/plan.md), [`ideas.md`](.context/ideas.md),
[`research.md`](.context/research.md).

**ADRs stay next to the code they bind** and are not moving to the documentation site. The
operational runbooks that used to sit beside them did move; `.context/README.md` links them at
their URLs.
