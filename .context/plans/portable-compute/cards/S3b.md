# Card S3b: Every path the compute switches open fails closed on staging without Tapis secrets

Status: ready (dispatch only when every Depends item holds)
Tier: worker
Timebox: S, 2 hours; escalate at 3 hours
Needs: network
Depends: S3a (its probe table, section 7); S2 merged into `dev` and deployed; the owner has set `COMPUTE_ENABLED` and `COMPUTE_RUNNERS_ENABLED` on the dev Worker with no Tapis secret set there; owner question OQ1 answered yes
Branch: docs/pc-s3b-staging-probes
Worktree: $WT/nemar-cli-pc-s3b (base origin/feature/portable-compute-epic)
Plan: .context/plans/portable-compute/plan.md, section 4 (S3a, S3); the bar of `cards/S3a.md` (Context)

## Goal

Each probe of S3a's table is run once against staging and its observed status and word are recorded beside the expected ones, so the bar's item "every path `COMPUTE_ENABLED` opens without Tapis secrets fails closed on staging" is evidence, not a reading of the code.

## Context

- Live facts from the manager: `$STAGING_API`, `$STG_ADMIN_KEY_FILE`, `$STG_OWNER_KEY_FILE` (as in S1F); a revoked runner token, if a probe needs one, comes from a registration this card makes and revokes itself.
- `.context/plans/portable-compute/s3a-switch-inventory.md` (S3a's output) is the list; run exactly its section 7, in order; do not invent probes, and add a row only as "missing from S3a" in the report.
- No probe dispatches a job on any dataset but `nm099996`, and none uses a production host or key.
- First confirm the absence of Tapis secrets by name: `bunx cfman wrangler --account sccn secret list --env dev -c backend/wrangler-sccn.toml` lists no `TAPIS_USERNAME`, `TAPIS_PASSWORD` or `TAPIS_SERVICE_TOKEN` (names only).

## Scope

- One new file, `.context/plans/portable-compute/s3b-staging-probes.md`, in a docs PR into `feature/portable-compute-epic`; staging requests as the probe table says; one throwaway runner registration (named `probe-s3b`), revoked at the end.

## Decided design

Settled:
1. Record the dev Worker's version (`bunx cfman wrangler --account sccn deployments list --env dev -c backend/wrangler-sccn.toml`, the newest line) and the `dev` commit it was built from.
2. For each probe in S3a's section 7: run it with the isolated configuration of the account it names, and record the observed HTTP status and refusal word, and `pass` when both equal the expected ones.
3. After the probes: `bunx cfman wrangler --account sccn d1 execute nemar-db-dev --remote --env dev -c backend/wrangler-sccn.toml --command "SELECT COUNT(*) AS n FROM compute_ledger"` before and after the run is unchanged, and the `probe-s3b` registration is revoked (`admin compute runners revoke <id>`, then `runners list` shows it revoked).
4. The document: the Worker version and commit, one table row per probe (expected, observed, pass), the ledger counts, and a one-line verdict: "all fail closed" or the list of probes that did not.
The implementer may choose: nothing else.

## Acceptance

- Every probe row is `pass`, the ledger count is unchanged, and `probe-s3b` is revoked; or the report names each failing probe with its observed answer.

## Gates

- The leak check of `cards/README.md` on the new file, all three commands printing nothing.

## Stop conditions

- A probe changes anything outside staging, or would need a production key: stop.
- A probe answers 2xx where S3a expected a refusal: record it, stop the remaining probes that use the same route, and notify the manager at once (it blocks S3).

## Report

At most 25 lines: PR, the Worker version, counts of pass and fail, every failing probe with its observed answer, the ledger counts.
