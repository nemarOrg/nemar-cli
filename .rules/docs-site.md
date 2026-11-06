# Reading docs.nemar.org, and where each topic lives

Platform description lives on the documentation site, not in `AGENTS.md` or here: two copies drift, and ADR 0057 exists because they did.
If you are about to add a paragraph explaining how part of the platform works, it belongs on `docs.nemar.org`; add a link instead.
`test/docs-links.unit.test.ts` checks that every `docs.nemar.org` pointer in tracked files resolves to a page that exists.

## Retrieval

Public pages need nothing: fetch the URL.
**Every page also has a Markdown mirror**, which is what to fetch if you are a program rather than a browser, and `https://docs.nemar.org/llms.txt` indexes them.

The mirror sits at the page path with `.md` appended and **no trailing slash**: the tables below spell URLs as `/cli/commands/`, and the mirror of that page is `/cli/commands.md`, not `/cli/commands/.md`.
Drop the slash before adding the extension.

```bash
curl -s https://docs.nemar.org/cli/commands.md
```

Pages under `/admin/` are gated: `nemarOrg/docs` is private at source and the gate admits the `admin` and `owner` roles only (ADR 0056, ADR 0059).
An admin holding a CLI key reads one without a browser:

```bash
nemar admin docs admin/operations/systems-inventory
nemar admin docs admin/operations/validated-workflows cli/commands   # several share one session
```

That trades the stored API key for a fifteen-minute, read-only, documentation-scoped session; the key itself never reaches the documentation host.

## If you cannot read something you need

**Open the issue anyway.** Losing read access must not cost you the ability to report a problem (ADR 0057).

If you hit an admin-adjacent problem, or need a runbook you cannot open, file the issue on the relevant repository, say plainly what you could not read and what you were trying to do, and tag **`@nemarOrg/admins`**.
Someone with access will either answer or open the page for you.

Escalation replaces read access.
**Silence does not.**
A blocked agent that stops without saying so is the failure mode this instruction exists to prevent: the problem stays real and nobody learns it exists.

## Page map

`nemar <group> --help` is authoritative for command behavior.
For anything else:

| If you need | Go to |
|---|---|
| What a CLI command does | [CLI command reference](https://docs.nemar.org/cli/commands/) |
| Signing in, keys, the device flow | [authentication](https://docs.nemar.org/cli/getting-started/authentication/) |
| Account tiers, upload access, what a status means | [account and access](https://docs.nemar.org/cli/reference/account-access/) |
| The HTTP API surface | [API reference](https://docs.nemar.org/platform/api/) |
| Dataset download and byte-range access | [data API](https://docs.nemar.org/platform/data-api/) |
| DOIs, versioning, what is permanent | [DOI and versioning](https://docs.nemar.org/platform/doi-and-versioning/) |
| Mirror versions and the `mirror` flag | [mirror versions](https://docs.nemar.org/platform/doi-and-versioning/#versions-of-an-openneuro-mirror), [the flag](https://docs.nemar.org/platform/data-api/#the-mirror-flag) |
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
| Upstream freshness and the re-pull runbooks | [freshness](https://docs.nemar.org/admin/operations/upstream-freshness/), [manual re-pull](https://docs.nemar.org/admin/operations/upstream-repull/), [automatic re-pull](https://docs.nemar.org/admin/operations/upstream-repull-automatic/) |
