# NEMAR full secret inventory + centralization analysis

Cross-system sweep 2026-07-24 (epic #885). **Names and locations only, no values.**
Extends `.context/secret-provenance-matrix.md` (which covers the nemar-cli Worker in depth)
to every system NEMAR runs.

## 1. Where secrets live today (every surface)

| # | Surface | Kind | Secret names |
|---|---|---|---|
| 1 | **CF Worker `nemar-api` (prod)** | runtime | AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, ENCRYPTION_KEY, EZID_USERNAME, EZID_PASSWORD, EZID_SANDBOX_USERNAME, EZID_SANDBOX_PASSWORD, GITHUB_ADMIN_PAT, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS, GITHUB_APP_INSTALLATION_ID_NEMAR_ORG, GITHUB_WEBHOOK_SECRET, MANIFEST_CALLBACK_SECRET, NEMAR_WEBHOOK_TOKEN, OPENROUTER_API_KEY, ORCID_CLIENT_ID, ORCID_CLIENT_SECRET, PRESCREEN_CALLBACK_SECRET, PRESCREEN_ENABLED, RESEND_API_KEY, TEST_BYPASS_TOKEN, ZENODO_API_KEY, ZENODO_SANDBOX_API_KEY, NEMAR_USERNAME*, NEMAR_PASSWORD* (26) |
| 2 | **CF Worker `nemar-api-dev` (staging)** | runtime | subset of the above (20): lacks EZID_USERNAME/PASSWORD, ORCID_*, PRESCREEN_ENABLED, ZENODO_API_KEY |
| 3 | **GitHub `nemarOrg/nemar-cli`** | CI | AUTO_TAG_PAT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, CLAUDE_CODE_OAUTH_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, DEPLOY_SSH_KEY, GH_TOKEN, OPENROUTER_API_KEY, OPENROUTER_KEY†, PROD_ADMIN_API_KEY, TEST_ADMIN_API_KEY, TEST_BYPASS_TOKEN, TEST_USER_API_KEY (14) |
| 4 | **GitHub `nemarDatasets` org** (dataset workflows) | CI | AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, CLAUDE_CODE_OAUTH_TOKEN, NEMAR_ADMIN_API_KEY, NEMAR_APP_ID, NEMAR_APP_PRIVATE_KEY, NEMAR_GITHUB_PAT, NEMAR_WEBHOOK_TOKEN (8) |
| 5 | **GitHub `nemarOrg/website`** | CI | CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (2) |
| 6 | **CF Pages `website` (runtime)** | runtime | SESSION_SECRET (ORCID itself is handled by the Worker, not the site) |
| 7 | **GitHub `nemarOrg/nemar-db-backup`** | CI | CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (2) |
| 8 | **GitHub `nemarOrg/nemar-citations`** | CI | CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, OPENALEX_API_KEY, PUBMED_API_KEY, SEMANTIC_SCHOLAR_API_KEY (5) |
| 9 | **Hallu (`ssh hallu`, SDSC VM)** | on-disk | `~/.aws/credentials`: `[default]`, `[nemar-zarr]` static keys; `~/.aws/config` also references `nemar-admin`. Long-lived, on disk. |
| 10 | **Local dev** | on-disk | `backend/.dev.vars` (17, mostly stale — see matrix), `test/.env.test` (5) |
| 11 | **`nemar-tools` (Python publish)** | CI/local | ZENODO_TOKEN, GITHUB_ORG (+ AWS for S3 upload) |
| 12 | **npm publish** | CI | none — OIDC trusted publishing, no NPM_TOKEN (already ideal) |

\* `NEMAR_USERNAME`/`NEMAR_PASSWORD`: code-unreferenced legacy dataexplorer creds → delete, don't migrate.
† `nemar-cli` has both `OPENROUTER_API_KEY` and `OPENROUTER_KEY`; one is a duplicate.

**Coverage gap:** GitHub **org-level** secrets (both orgs) cannot be enumerated with the
current token — `gh secret list --org` returns 403 (needs `admin:org`). The `nemarDatasets`
list above is what the dataset workflows *reference*, which is authoritative for what must be
synced, but a definitive org-secret dump still needs `gh auth refresh -h github.com -s admin:org`.

## 2. The AWS S3 key problem (the specific question)

The **same** ability to read/write `s3://nemar` is granted by long-lived static AWS keys
copied across **five** independent surfaces:

| Copy | Surface | Purpose |
|---|---|---|
| A | CF Worker prod | backend S3 operations on `s3://nemar` |
| B | CF Worker staging | S3 operations on `s3://nemar-dev` |
| C | `nemar-cli` GitHub CI | E2E test + deploy S3 access |
| D | `nemarDatasets` org CI | dataset-workflow staging→final S3 copy |
| E | Hallu `~/.aws/credentials` | zarr conversion + archive downloads |

Each copy is an independent leak vector and an independent rotation chore. Rotating the S3
key today means editing five places by hand and hoping none is missed — miss one and either a
job breaks or a revoked key is left live somewhere.

**Not a problem (leave as-is):** per-user IAM keys are AES-GCM-encrypted in D1 and handed out
as short-lived STS federation tokens per request. Those are already derived and short-lived;
they do not belong in Infisical.

## 3. Vulnerabilities centralization removes

1. **Drift of copies.** N hand-maintained copies of one secret diverge silently. We already
   found this live: `backend/.dev.vars` held an **expired** GITHUB_ADMIN_PAT, an **invalid**
   AWS key, and a **stale** RESEND key pointing at the wrong account.
2. **Must-match-pair breakage.** `NEMAR_WEBHOOK_TOKEN`, `MANIFEST_CALLBACK_SECRET`, and the
   GitHub App key each exist under two names on two platforms and must stay identical; a
   partial rotation 401s dataset callbacks. One `/shared` value referenced by both consumers
   makes drift structurally impossible.
3. **Rotation cost → rotation avoidance.** Because rotating means touching 5 surfaces, keys
   don't get rotated. Centralized, one edit propagates.
4. **Orphaned live credentials.** A key removed from one place but forgotten in another stays
   valid. A single source with sync makes "removed" mean removed everywhere.
5. **No audit trail.** Today nothing records who read or changed a secret. Infisical logs it.
6. **Standing keys at rest.** Hallu and local disks hold long-lived AWS keys with no expiry.

## 4. Can we stop keeping secrets on GitHub / CF / Hallu?

Partly yes, and the honest answer is three tiers. The distinction is **pull vs push**.

### Tier A — PULL: the secret genuinely leaves the surface
Consumer authenticates to Infisical with a short-lived machine-identity token and fetches at
use-time. Nothing is stored at rest.
- **Hallu** → `infisical run -- …` (or the Infisical agent). **The standing AWS keys in
  `~/.aws/credentials` go away.** This is the single biggest at-rest win.
- **`nemar-cli` own CI** → OIDC `infisical/secrets-action`. Nothing stored in GitHub.
- **Local dev** → `infisical run -- bun …`. `.dev.vars` deleted from disk.

### Tier B — PUSH/materialized: value still at rest, but single-source-managed
The consumer reads a value natively and cannot call out at use-time, so Infisical
materializes it into the platform's own store via Secret Sync. The value still physically
lives there, but you edit it in **exactly one place** and it propagates.
- **CF Worker** (prod + staging): the Worker reads `env.X` bindings; calling Infisical on the
  request path is explicitly forbidden (it would couple runtime uptime to Infisical). So the
  Worker keeps a materialized copy — but hand-management and drift end.
- **`nemarDatasets` org secrets**: dataset workflows run in arbitrary repos and need the
  secret present. Materialized org secret, synced from one source.

### Tier C — ELIMINATE the static AWS key (the ideal)
For AWS specifically, the best state is **no static key stored anywhere**:
- An Infisical **AWS App Connection using assume-role** (external-id scoped), so Infisical
  holds no static AWS key itself.
- Collapse copies A–E to **one canonical credential + assume-role**, and push per-request STS
  federation (already in the Worker for per-user creds) to the other consumers.
- Caveat: true **dynamic secrets / auto-rotation** are Enterprise-gated on self-hosted
  Infisical, so full automatic rotation stays a manual runbook. But 5 drifting copies → 1
  canonical + assume-role is achievable now and is most of the security win.

**Net:** Hallu, local dev, and `nemar-cli` CI can hold **nothing at rest** (Tier A). CF Worker
and `nemarDatasets` org keep a materialized copy by necessity, but managed from one source
(Tier B). AWS static keys collapse from five to one, ideally behind assume-role (Tier C).

## 5. Sibling-repo follow-ons beyond the original epic scope

The epic scoped itself to nemar-cli + the `nemarDatasets` org secrets. This sweep surfaced
more that should join, as a documented follow-on:
- **website**: `SESSION_SECRET` (Pages runtime) + deploy token.
- **nemar-citations**: `OPENALEX_API_KEY`, `PUBMED_API_KEY`, `SEMANTIC_SCHOLAR_API_KEY` + deploy token.
- **nemar-tools**: `ZENODO_TOKEN` + AWS for S3 publish.
- **nemar-db-backup**: deploy token only.
- **Hallu**: the standing AWS credentials (highest at-rest priority).
