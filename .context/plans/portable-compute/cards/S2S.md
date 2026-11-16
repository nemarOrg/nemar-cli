# Card S2S: The first staging runner job on `nm099996` finishes

Status: ready (dispatch only when every Depends item holds)
Tier: worker
Timebox: M, 3 hours; escalate at 5 hours
Needs: ssh:ws-b, network
Depends: S0 (and so not before 2026-11-15T12:00 Pacific); S1F, with `curl -s -o /dev/null -w '%{http_code}' $STAGING_ZARR/nm099996/zarr/index.json` printing `200`; S2 merged into `dev` by the owner and its dev deploy green; S2P round 1 merged, released by the owner, and the image published from that release; S3a's verdict not "not safe"; the owner has set `COMPUTE_ENABLED`, `COMPUTE_RUNNERS_ENABLED` and `COMPUTE_RUNTIME_IMAGE` on the dev Worker; owner question OQ1 answered yes
Branch: none (no repository change)
Worktree: $WT/nemar-cli-pc-s2s (base origin/dev, read-only use, to run the CLI from source)
Plan: .context/plans/portable-compute/plan.md, section 4 (S2), D4, D6; gates G5 to G7 of section 3.2 as models

## Goal

One `nemar-floor-zarr` job for `nm099996`, dispatched through staging's real API, is claimed and run by `nemar-runner` on workstation B from the signed image of the nemar-process release, and ends `finished` with executor `runner`, accounting `none`, zero ledger rows and no Tapis mechanic having touched it.

## Context

- Live facts from the manager: `$STAGING_API`, `$STAGING_ZARR`, `$STG_ADMIN_KEY_FILE`, `$STG_OWNER_KEY_FILE` (as in S1F), `$WS_B` (workstation B's alias), `$RUNNER_ROOT_STG` (a new directory `nemar-runner-staging` under workstation B's scratch path), the nemar-process release tag `vX.Y.Z` and its commit, and the image digest `sha256:<hex>` from the release's digest file.
- Workstation B is the machine that does not run the production conversion cron (DM-01's rule; owner decision Q7); never list, open or write the converter's directories, and never use workstation A. It stays untouched until the Sunday demo ends (about 2026-11-15T12:00 Pacific).
- Workstation B is shared with other people's work (owner, 2026-11-14; `cp2-note-N.md`): never start anything there while it is busy. The runner of this card is a checkout of the round-1 release, which predates card L2's live check, so the operator applies the rule by hand (steps 0 and 7), runs the runner at the lowest priority, and registers half of DM-15's memory ceiling.
- The runner code is a checkout of the release tag, not yet a signed runner release (that is S4's, exercised in S2D); label the run "runner from a checkout of nemar-process vX.Y.Z; signed image".
- Long-lived processes: none here (the runner runs `once` in the foreground).
- The recipe name: if the processing lead's cards Q0 and Q0b have reached the deployed `dev` and the released image, `nemar-floor-zarr` has become `nemar-floor` with input `zarr`; use the dispatch form `bun run src/index.ts admin compute pipeline run --help` documents on the deployed head, and say which in the report. The image and the Worker must carry the same recipe registry (both before Q0, or both after).
- Records: `script -q <operator scratch>/s2s/run.typescript`; keys are never printed.

## Scope

- Staging, through the CLI and read-only database queries: one runner registration, one job, one new version `1.0.1` of `nm099996` (step 9). Workstation B: `$RUNNER_ROOT_STG` and Docker's image cache. Nothing else.

## Decided design

Settled, in order:
0. The idle check, run now and again right before step 7: `ssh "$WS_B" 'read l1 rest < /proc/loadavg; echo "load1=$l1 cpus=$(nproc) mem_avail_mb=$(( $(sed -n "s/^MemAvailable: *\([0-9]*\) kB$/\1/p" /proc/meminfo) / 1024 ))"'`; idle only if `load1` divided by `cpus` is at most 0.9 and `mem_avail_mb` is at least M (step 3) plus 12800; if busy, re-check every 15 minutes for up to 2 hours, then stop with "postponed: workstation B busy" (not a failure).
1. Preconditions, each printed: `date` is after 2026-11-15T12:00-08:00; the curl above prints `200`; on the operator's machine `crane digest ghcr.io/nemarorg/nemar-python:X.Y.Z-cpu` equals `sha256:<hex>` and `cosign verify ghcr.io/nemarorg/nemar-python@sha256:<hex> --certificate-identity-regexp '^https://github\.com/nemarOrg/nemar-process/\.github/workflows/image-nemar-python\.yml@refs/(tags/image-nemar-python-v[0-9]+\.[0-9]+\.[0-9]+|heads/main)$' --certificate-oidc-issuer https://token.actions.githubusercontent.com` passes; `bunx cfman wrangler --account sccn secret list --env dev -c backend/wrangler-sccn.toml` lists the three names (names only, never values); `bunx cfman wrangler --account sccn d1 migrations list nemar-db-dev --remote --env dev -c backend/wrangler-sccn.toml` shows nothing unapplied.
2. On `$WS_B`: `python3 -c 'import sys; assert sys.version_info >= (3, 9)'`; `mkdir -p -m 0700 "$RUNNER_ROOT_STG"`; `git clone --depth 1 --branch vX.Y.Z https://github.com/nemarOrg/nemar-process "$RUNNER_ROOT_STG/src"` and its head equals the tag's commit; `docker pull ghcr.io/nemarorg/nemar-python@sha256:<hex>`.
3. Register with the staging owner key (isolated `NEMAR_CONFIG_DIR=<operator scratch>/s2s/cfg-owner`, `TEST_API_URL=$STAGING_API`): `bun run src/index.ts admin compute runners register staging-b --pool cpu --cores <C> --memory-mb <M> --gpus 0 --scratch-gb <S> --backend local --runtime docker --arch amd64 --site lab_b --trust lab --json`, with DM-15's formulas for a host that is not the conversion host, the memory halved again because the host is shared (C = max(1, min(16, cores - 2)), M = floor(memory GiB x 1024 / 4), S = min(200, floor(free scratch GiB / 2))); pipe ONLY the secret field over ssh into `$RUNNER_ROOT_STG/secret` under `umask 077`.
4. On `$WS_B`, `$RUNNER_ROOT_STG/config.json`, mode 0600: `api_base` `$STAGING_API`, `secret_file` that file, `root` `$RUNNER_ROOT_STG`, `sif_root` `$RUNNER_ROOT_STG/sif` (created, 0700), `runtime` `docker`, `slots` 1, `arch` `amd64`, `max_scratch_gb` S, `default_job_memory_mb` M, `sif_pull` `false`.
5. `doctor`, then later `once`, each as `python3 -I -S -c 'import runpy, sys; sys.path.insert(0, sys.argv[1]); runpy.run_module("nemar_runner", run_name="__main__", alter_sys=True)' "$RUNNER_ROOT_STG/src/runner" <command> --config "$RUNNER_ROOT_STG/config.json"`; `doctor` prints yes on every required line.
6. Dispatch with the staging administrator key (`NEMAR_CONFIG_DIR=<operator scratch>/s2s/cfg-admin`): `bun run src/index.ts admin compute pipeline run nemar-floor-zarr --dataset nm099996@<staging version> --executor runner --json`; record the job id and time. A refusal (`zarr_source_mismatch`, `zarr_source_unverifiable`, a runner refusal) is reported with its word, not worked around.
7. After step 0's check passes again, run `once` (step 5) in the foreground at the lowest priority: the step-5 command prefixed with `nice -n 19 ionice -c 3` (the launcher inherits both; the Docker container keeps its hard `--cpus` and `--memory` limits).
8. Gates: `bun run src/index.ts admin compute jobs record <job> --json` shows `finished`, `executor` `runner`, `runner_backend` `local`, `accounting` `none`, `charged_milli` 0, `settled_final_at` set, `image_digest` `sha256:<hex>`; `bunx cfman wrangler --account sccn d1 execute nemar-db-dev --remote --env dev -c backend/wrangler-sccn.toml --command "SELECT COUNT(*) AS n FROM compute_ledger WHERE job_id = '<job>'"` prints 0; the same with `SELECT examined_at, tapis_uuid FROM compute_jobs WHERE id = '<job>'` prints both NULL; on `$WS_B`, `find "$RUNNER_ROOT_STG/jobs" -mindepth 1 | wc -l` prints 0 and `grep -c scratch_discarded "$RUNNER_ROOT_STG/runner.log"` prints 1.
9. Prepare S2D's dataset version: a finished run stamps the tuple (dataset version, recipe, recipe version, engine) `succeeded`, and a succeeded tuple is never dispatched again, so S2D needs a new version. In a staging clone (`bun run src/index.ts dataset clone nm099996 -o <operator scratch>/s2s/clone` as the staging administrator), add one line to `CHANGES` ("staging drill version; no data change"), push it through the CLI's update path for a public dataset (`bun run src/index.ts dataset update --help`), and run `bun run src/index.ts dataset release nm099996 --version 1.0.1`; its DOI must start `10.5072/` (else stop, as in S1F step 7). The nightly staging conversion rebuilds the copy from it.
10. Leave the registration in place for S2D; write `<operator scratch>/s2s/README.txt` (commits, tag, digest, job id, times, gate outputs, the `1.0.1` release and its DOI, the label of the Context section).
The implementer may choose: nothing else; a failed step stops the card.

## Acceptance

- Step 8's four checks, quoted, all as stated, and the wall time from dispatch to `finished`; step 9's release `1.0.1` exists on staging with a `10.5072/` DOI.

## Gates

- Step 8's commands, run again after `README.txt` is written, with the same results.

## Stop conditions

- Any step fails twice: stop, leave the registration, report the step and the last 20 log lines with secrets removed.
- Step 0 busy for 2 hours: stop before step 7 with "postponed: workstation B busy" and the idle lines (not a failure); the registration may stay for the next dispatch.
- Anything would touch production, workstation A, a live dataset or the converter's directories: stop.
- The runner log shows a pull of any other image, or `cosign verify` fails: stop.

## Report

At most 25 lines: commits (nemar-cli `dev`, nemar-process tag), digest, runner id, job id, gate outputs, wall time, step 0's idle lines, evidence directory.
