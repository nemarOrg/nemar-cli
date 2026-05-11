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
   - **Webhook**: uncheck **Active**. Webhooks are delivered via the
     existing repo-level secret, not the App.
   - **Repository permissions**:
     - Contents: **Read & write**
     - Actions: **Read & write** (Read for orchestrator CI checks;
       Write so dataset-repo CI can dispatch `generate-archive` via
       `gh api .../dispatches`)
     - Administration: **Read & write** (needed for branch / tag
       protection rulesets and visibility flips)
     - Issues: **Read & write** (BIDS-validation issue creation flow)
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
- [ ] `NEMAR_APP_ID` and `NEMAR_APP_PRIVATE_KEY` exist as org secrets on
      `nemarDatasets`.
- [ ] At least one dataset repo's most recent `pr-merge`,
      `llm-enrichment`, or `version-doi` workflow run shows the
      "Mint App installation token" step succeeding, and subsequent
      writes are attributed to `nemar-publish-bot[bot]` in the run log.

## Cross-references

- Existing PAT troubleshooting: [Publishing workflow Admin Issues](publishing.md#admin-issues)
- Tracking epic: [#432](https://github.com/nemarOrg/nemar-cli/issues/432)
