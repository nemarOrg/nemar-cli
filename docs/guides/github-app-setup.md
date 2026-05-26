# GitHub App setup

This is the operational runbook for creating the GitHub App that the
Cloudflare Worker will use to authenticate against GitHub once the
[migration epic](https://github.com/nemarOrg/nemar-cli/issues/432) lands.

## Why

The Worker today reads `GITHUB_ADMIN_PAT`, a user PAT tied to an
individual maintainer. Every Worker call to GitHub competes against that
same maintainer's interactive `gh` CLI usage in one shared 5,000/hr core
bucket, so a large publication batch can starve the queue.

A GitHub App installation gets its own rate-limit pool per installed
organization, independent of any human user. Once the migration ships,
the Worker mints short-lived installation tokens from the App and never
touches a user PAT again.

This runbook covers creating the App and verifying it works.

## Steps

### 1. Create the App under `nemarOrg`

Owner must be the organization, not a personal account, so the App
survives any individual maintainer leaving.

1. Open <https://github.com/organizations/nemarOrg/settings/apps/new> while
   signed in as an org owner.
2. Fill in:
   - **GitHub App name**: `nemar-publish-bot`
   - **Homepage URL**: `https://github.com/nemarOrg/nemar-cli`
   - **Webhook**: check **Active**.
     - **Webhook URL**: `https://api.nemar.org/webhooks/github`
     - **Webhook secret**: a random value (e.g., `openssl rand -hex 32`).
       Store this exact value as the Cloudflare Worker secret
       `GITHUB_WEBHOOK_SECRET` (`wrangler secret put GITHUB_WEBHOOK_SECRET`).
       The Worker uses it as the HMAC secret for verifying
       `X-Hub-Signature-256` on push deliveries.
     - Under **Subscribe to events** (further down the form), tick
       **Push**. This is the only event the Worker acts on today;
       `shouldDispatchEnrichment` / `shouldDispatchVersionDoi` in
       `backend/src/routes/webhooks.ts` gate on it. The App receiver
       was added in Phase 1 of centralization epic #601 — without
       Active webhook + Push event subscription, central
       `run-version-doi.yml` and `run-enrichment.yml` will never
       receive their `repository_dispatch` from tag and main pushes,
       and DOIs silently never mint.
   - **Repository permissions**:
     - Contents: **Read & write**
     - Actions: **Read & write** (Read for orchestrator CI checks;
       Write so the central workflows on `nemarDatasets/.github` can
       `repository_dispatch` to each other — e.g. `run-version-doi.yml`
       dispatching `generate-archive` against `nemarDatasets/.github`.
       Phase 3 of centralization epic #601 moved these dispatches off
       the dataset repos onto `.github`.)
     - Administration: **Read & write** (needed for branch / tag
       protection rulesets and visibility flips)
     - Issues: **Read & write** (BIDS-validation issue creation flow)
     - Checks: **Read & write** (Phase 4 of #601: central
       `run-bids-validation.yml` on nemarDatasets/.github posts
       `check-runs` to each dataset repo's PR via the GitHub Checks API.
       Without this, the central workflow's `gh api ... /check-runs`
       calls return 403 and the PR loses its validation check.)
     - Metadata: **Read-only** (always required)
     - Pull requests: **Read & write**
     - Workflows: **Read & write** (CI workflow deploy)
   - **Organization permissions**: leave all at `No access` for now.
   - **Where can this GitHub App be installed?**: **Any account**. The
     App is owned by `nemarOrg` but needs to be installable on
     `nemarDatasets` too. "Only on this account" locks the App to its
     owner and blocks the second installation.
3. Click **Create GitHub App**.
4. On the new App's settings page, note the numeric **App ID** near the
   top. Record it; Phase 2 will store it as the Worker secret
   `GITHUB_APP_ID`.

### 2. Generate and download the private key

1. Still on the App settings page, scroll to **Private keys** and click
   **Generate a private key**. The browser downloads a `.pem` file.
2. Open the file in a text editor and confirm the header reads
   `-----BEGIN RSA PRIVATE KEY-----`. Convert to PKCS#8 if needed (GitHub
   ships PKCS#1; the verify script and Phase 2 helper both expect PKCS#8):
   ```bash
   openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
     -in nemar-publish-bot.<date>.private-key.pem \
     -out /tmp/nemar-app.pem
   ```
3. Store the original download AND the PKCS#8 copy in 1Password under a
   new item titled **NEMAR / GitHub App** along with the App ID. Share
   the 1Password item with at least one other maintainer so rotation
   isn't single-pointed.
4. Delete the local downloads:
   ```bash
   rm ~/Downloads/nemar-publish-bot.*.private-key.pem
   ```
   The PKCS#8 copy in `/tmp` is fine to keep for the next step; remove it
   once verification passes.

### 3. Install on both organizations

The App is owned by `nemarOrg` and needs two installations:
- **`nemarDatasets`** — required. All dataset-repo writes happen here.
- **`nemarOrg`** — optional today; covers any future feature that
  writes to tooling repos. Install it too to stay symmetric.

Repository visibility in each install scope determines which repos
the Worker can access.

1. From the App settings page, click **Install App** in the left sidebar.
2. Click **Install** next to **nemarDatasets** first (this is the
   one Phase 3 actively uses).
3. Choose **All repositories** and confirm. Note the installation ID
   from the resulting URL:
   `https://github.com/organizations/nemarDatasets/settings/installations/<INSTALL_ID>`.
   Record this as `GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS`.
4. Back on the install screen, click **Install** next to **nemarOrg**.
5. Choose **All repositories** and confirm. Note the installation ID.
   Record this as `GITHUB_APP_INSTALLATION_ID_NEMAR_ORG`.

### 4. Verify

From the repo root:

```bash
bun run scripts/verify-github-app.ts \
  --app-id <APP_ID> \
  --private-key /tmp/nemar-app.pem
```

Expected output:

```
Listing installations...
  installation_id=12345678 account=nemarOrg target_type=Organization
  installation_id=12345679 account=nemarDatasets target_type=Organization

Minting installation tokens and listing repositories...
  installation_id=12345678 account=nemarOrg repos=4 first_repo=nemar-cli
  installation_id=12345679 account=nemarDatasets repos=156 first_repo=nm000103

OK: both expected installations validated.
```

If the script reports a missing installation, revisit step 3 and confirm
the App is installed on both orgs. If it reports a non-zero repo count
mismatch, confirm the install scope is **All repositories** in both orgs.

After a clean verify run, remove the PKCS#8 PEM:

```bash
rm /tmp/nemar-app.pem
```

The canonical copy lives in 1Password.

## Phase 1 acceptance checklist

- [ ] App `nemar-publish-bot` exists under `nemarOrg`.
- [ ] App permissions match the list in step 1 (no extras, no missing
      grants).
- [ ] App installed on `nemarOrg` and `nemarDatasets`, both scoped to
      **All repositories**.
- [ ] App ID, two installation IDs, and the private key (PKCS#8) stored
      in 1Password.
- [ ] `bun run scripts/verify-github-app.ts ...` returns OK.
- [ ] Local copy of the private key removed from disk.

Phase 2 (#437) consumes these credentials in the Worker. No Worker secret
changes happen in this phase.

> **Do NOT remove `GITHUB_ADMIN_PAT` from the Worker yet.** The Phase 3 routing helper
> falls back to the PAT when any App secret is missing; if both are absent the helper
> throws "No GitHub auth configured" and every orchestrator call 500s. The PAT stays
> as a safety net until Phase 5 (#440) removes it after a soak period confirms App
> auth is live in `github-rl` logs.

## Dataset-repo CI uses the same App

Workflow templates in dataset repos mint short-lived installation tokens
via `actions/create-github-app-token@v1` so all CI writes carry the
`nemar-publish-bot[bot]` identity. Two org-level secrets must be set on
**nemarDatasets** for the templates to work.

### Ops steps

1. **Accept the updated App permissions.**

   This step raises **Actions** from Read-only to Read & write. If the
   App was created against the original list, GitHub holds the new
   permission request as "pending approval" until an org owner accepts
   it.

   - Visit the App settings page: `https://github.com/organizations/nemarOrg/settings/apps/nemar-publish-bot/permissions`.
   - Bump **Actions** to **Read & write** if not already set.
   - Save. GitHub emails the installations.
   - In each org's **Installed GitHub Apps** page (one for nemarOrg, one
     for nemarDatasets), click the App and accept the new permissions.

2. **Set org-level secrets on `nemarDatasets`.**

   Visit `https://github.com/organizations/nemarDatasets/settings/secrets/actions`.
   Add (Repository access: **All repositories**):

   - `NEMAR_APP_ID` — the same numeric App ID stored in 1Password.
   - `NEMAR_APP_PRIVATE_KEY` — the PKCS#8 PEM, pasted in full
     (BEGIN/END lines included).
   - `NEMAR_WEBHOOK_TOKEN` — bearer token sent as `X-Webhook-Token` by
     `run-version-doi.yml` (calling `/webhooks/publish-version-doi`) and
     `run-enrichment.yml` (calling `/webhooks/llm-enrich`). Set the
     **same value** as the Cloudflare Worker secret `NEMAR_WEBHOOK_TOKEN`
     (`wrangler secret put NEMAR_WEBHOOK_TOKEN`).

   ### Webhook secrets — the two-secret model

   The Worker uses two separate secrets, each with a distinct purpose.
   They MAY hold the same value but no longer must (since the
   secret-untangle landing on this PR); rotate independently going forward.

   | Secret | Stored on | Purpose |
   | --- | --- | --- |
   | `GITHUB_WEBHOOK_SECRET` | Worker secret + App webhook config | HMAC for `/webhooks/github` (App push deliveries). Rotate by setting on Worker AND on the App's webhook secret field. |
   | `NEMAR_WEBHOOK_TOKEN` | Worker secret + `nemarDatasets` org Actions secret | Bearer token for `/webhooks/publish-version-doi` and `/webhooks/llm-enrich`. Rotate by setting on the Worker AND on the org secret. |

   Historical note: before the secret-untangle, both endpoints read
   `GITHUB_WEBHOOK_SECRET`, so the org secret and Worker secret had to
   match the App webhook secret. Rotating one without the others 401'd
   every DOI mint until the value was re-synced. The endpoints now
   prefer `NEMAR_WEBHOOK_TOKEN` and fall back to `GITHUB_WEBHOOK_SECRET`
   only if the new var is unset — set the new Worker secret to drop
   the coupling.

3. **Refresh existing dataset repos** so they pick up the new workflow
   templates with the App-token step:

   ```bash
   nemar admin ci add <dataset-id>
   ```

   Or sweep the catalog if many at once (the
   `/tmp/refresh-archive-workflow.sh` pattern from the May 2026 sweep
   works as a reference).

### Acceptance

- [ ] App permissions show **Actions: Read & write** and the update is
      accepted on both org installations.
- [ ] App permissions show **Checks: Read & write** (added in Phase 4 of
      epic nemarOrg/nemar-cli#601 for the central `run-bids-validation`
      workflow's check-run posts). The grant must be re-accepted on the
      `nemarOrg` and `nemarDatasets` installations after the App
      definition changes.
- [ ] `NEMAR_APP_ID`, `NEMAR_APP_PRIVATE_KEY`, and `NEMAR_WEBHOOK_TOKEN`
      exist as org secrets on `nemarDatasets`.
- [ ] At least one dataset repo's most recent `pr-merge`,
      `llm-enrichment`, or `version-doi` workflow run shows the
      "Mint App installation token" step succeeding, and subsequent
      writes are attributed to `nemar-publish-bot[bot]` in the run log.
- [ ] App webhook is **Active**, URL is `https://api.nemar.org/webhooks/github`,
      webhook secret matches Worker `GITHUB_WEBHOOK_SECRET`, and
      **Push** is checked under Subscribe to events.
- [ ] After pushing a version tag on any dataset repo, the central
      `nemarDatasets/.github` shows a `run-version-doi` run with
      `event=repository_dispatch` (not just manual `workflow_dispatch`).
- [ ] `NEMAR_WEBHOOK_TOKEN` exists as a Worker secret AND as the
      `nemarDatasets` org Actions secret with the same value.

## Cross-references

- Existing PAT troubleshooting: [Publishing workflow Admin Issues](publishing.md#admin-issues)
- Tracking epic: [#432](https://github.com/nemarOrg/nemar-cli/issues/432)
