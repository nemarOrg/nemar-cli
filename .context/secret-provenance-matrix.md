# Secret provenance matrix (epic #885, Phase 1 gate)

Surveyed 2026-07-23. **Contains no secret values, only names and classification.**
Companion to `.context/plan-secrets-infisical-migration.md`, which holds the full inventory
and the target Infisical layout.

## Why this document exists

Phase 1 says "load every current secret value into Infisical." That is only possible for
values we can still obtain. **Neither Cloudflare nor GitHub lets you read a secret back:**
`wrangler secret list` returns names only, and GitHub Actions secrets are write-only. So for
each secret there are exactly three outcomes, and we must know which before importing:

| Class | Meaning | Migration cost |
|---|---|---|
| **RECOVERABLE** | Plaintext still exists somewhere we control (local file, operator records). | None; import verbatim. |
| **RE-ISSUABLE** | Not recoverable, but a fresh value can be minted at the source and swapped in. | Brief, controlled cutover. |
| **VERBATIM-ONLY** | Cannot be re-issued without breaking stored data. Must be recovered. | Blocking if lost. |

## The single blocking risk

**`ENCRYPTION_KEY` is the only VERBATIM-ONLY secret.** It is the AES-GCM key for per-user
AWS credentials and passwordless auth codes stored in D1. Regenerating it renders every
stored credential undecryptable; there is no recovery path. Everything else on this list can
ultimately be re-issued.

`ENCRYPTION_KEY` is present in `backend/.dev.vars`, but **it is unproven that the local value
equals the production Worker's value**, and we cannot read prod's to compare. See
"Verification" below for the decisive non-destructive test.

## Coverage by surface

| Surface | Count | Values readable back? |
|---|---|---|
| Prod Worker `nemar-api` | 26 | No |
| Dev/staging Worker `nemar-api-dev` | 20 | No |
| GitHub repo `nemarOrg/nemar-cli` | 14 | No |
| GitHub org `nemarDatasets` | **unknown** | No, and **not yet enumerated**, see gap below |
| `backend/.dev.vars` | 17 | Yes |
| `test/.env.test` | 5 | Yes |

Of the 26 prod Worker secrets, 13 have a same-named entry in `backend/.dev.vars` and 1 more
(`TEST_BYPASS_TOKEN`) in `test/.env.test`. Same name is not proof of same value; treat every
local value as a *candidate* for the prod value until verified.

## Classification (prod Worker)

### VERBATIM-ONLY, blocking
| Secret | Local candidate | Note |
|---|---|---|
| `ENCRYPTION_KEY` | `.dev.vars` | Must verify local == prod before Phase 1. Cannot be rotated. |

### Coordinated rotation (re-issuable, but ≥2 consumers must change together)
| Secret | Matching consumer | Note |
|---|---|---|
| `NEMAR_WEBHOOK_TOKEN` | `nemarDatasets` org secret | Random shared bearer; cut over both sides in one step or dataset callbacks 401. |
| `MANIFEST_CALLBACK_SECRET` | `nemarDatasets` org secret | Same. |
| `PRESCREEN_CALLBACK_SECRET` | prescreen workflow | Same. |
| `GITHUB_WEBHOOK_SECRET` | GitHub App webhook config | HMAC; still cross-falls-back with `NEMAR_WEBHOOK_TOKEN` on 6 routes. |
| `GITHUB_APP_PRIVATE_KEY` | org `NEMAR_APP_PRIVATE_KEY` | Same identity under two names. GitHub allows multiple App keys, so this rotates with zero downtime; collapse to one `/shared` value. |
| `TEST_BYPASS_TOKEN` | `test/.env.test`, `nemar-cli` CI | Recoverable locally. |

### Freely re-issuable at source (single consumer)
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (IAM supports a two-key window, so rotation is
zero-downtime), `RESEND_API_KEY`, `OPENROUTER_API_KEY`, `ZENODO_API_KEY`,
`ZENODO_SANDBOX_API_KEY`, `GITHUB_ADMIN_PAT`, `ORCID_CLIENT_ID` / `ORCID_CLIENT_SECRET`,
`EZID_PASSWORD` (account password; changing it affects all DOI operations, so treat as
coordinated in practice).

### Not actually secret, recover trivially
- `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS`, `GITHUB_APP_INSTALLATION_ID_NEMAR_ORG`
  — readable from the GitHub App settings / API at any time.
- `EZID_SANDBOX_USERNAME` / `EZID_SANDBOX_PASSWORD` — the shared public EZID test account.
- `PRESCREEN_ENABLED` — a boolean flag stored as a secret. **Should become a `[vars]` entry**,
  not an Infisical secret. Fix during Phase 2.

### Confirmed cruft: delete, do not migrate
Re-verified 2026-07-23 by extracting every `env.X` reference from `backend/src` and `shared`
(54 bindings) and diffing against the live secret lists:

- `NEMAR_USERNAME`, `NEMAR_PASSWORD` — live in **both** prod and dev Workers, referenced
  **nowhere** in code. Orphaned legacy dataexplorer-sync credentials, dead since epic #837.
- `.dev.vars` only: `ADMIN_API_KEY`, `ADMIN_PASSWORD`, `NEMAR_ACCESS_TOKEN`,
  `PROD_ADMIN_API_KEY` — absent from every live surface.
- `nemarOrg/nemar-cli` has both `OPENROUTER_API_KEY` and `OPENROUTER_KEY`; one is a duplicate.

### Referenced in code but never provisioned
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID` are read by the zarr cache-purge path (#684)
but are set on neither Worker. The feature has never run. Decide during Phase 2 whether to
provision or remove the code path.

### New since the 2026-07-01 inventory
`nemarOrg/nemar-cli` carries `CLAUDE_CODE_OAUTH_TOKEN`, `DEPLOY_SSH_KEY`, and `OPENROUTER_KEY`,
none of which appear in the original plan's inventory. Classify before Phase 3.

## Verification: does local `ENCRYPTION_KEY` equal prod's?

Decisive, non-destructive, and requires no ability to read the prod secret. The Worker
encrypts per-user AWS credentials into D1 with AES-GCM under `ENCRYPTION_KEY`. GCM is
authenticated, so decryption with the wrong key **fails** rather than returning garbage.

1. Read one ciphertext column from **prod** D1 (read-only query, no mutation).
2. Attempt decryption locally using the `.dev.vars` value.
3. Assert only on the *shape* of the result (auth tag valid, plaintext parses as the expected
   credential structure). **Never print the plaintext.**

Pass means the local value is the prod value and Phase 1 imports it verbatim. Fail means the
prod key exists only inside Cloudflare, and the epic needs a decision: either locate it in
operator records, or accept that per-user stored AWS credentials must be re-issued for all
users, which is a user-visible event and would need its own plan.

Run this **before** any Infisical import, because it determines whether Phase 1 is a copy or
a migration.

## Open gap: `nemarDatasets` org secrets

`gh api /orgs/nemarDatasets/actions/secrets` returns 403; the current token lacks `admin:org`.
Phase 3 cannot be scoped until this list exists. Unblock with:

```bash
gh auth refresh -h github.com -s admin:org
```

The plan expects roughly: `NEMAR_ADMIN_API_KEY`, `NEMAR_GITHUB_PAT`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `NEMAR_WEBHOOK_TOKEN`, `NEMAR_APP_ID`, `NEMAR_APP_PRIVATE_KEY`,
`MANIFEST_CALLBACK_SECRET`, plus the Anthropic credential the prescreen workflow uses. Confirm
rather than assume.

## Staging changes the environment model

The original plan defines Infisical environments `dev` and `prod`. Since epic #923, the dev
Worker **is** staging: it serves `api-test` / `data-test` / `zarr-test` and the exemplar
fleet, and is user-facing. Name the environment accordingly and do not treat it as a scratch
env whose values may drift.
