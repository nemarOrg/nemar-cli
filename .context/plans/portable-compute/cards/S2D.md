# Card S2D: Staging drills on `nm099996` with the signed runner as a user service: cancel, kill, revoke, lease expiry

Status: ready (dispatch only when every Depends item holds)
Tier: worker
Timebox: M, 4.5 hours of work plus the lease and give-up waits (about 75 minutes, spent on other steps); escalate at 7 hours
Needs: ssh:ws-b, network
Depends: S2S (its `1.0.1` release, with `curl -s $STAGING_ZARR/nm099996/zarr/index.json` naming a `source_commit` that descends from the `v1.0.1` tag); C2, L1, L2 and S4 merged into `feature/runner-epic` and carried by the signed runner release; S2P round 2 merged into nemar-process `dev` and released by the owner; the owner pushed the runner tag S4's workflow signs and its release carries the bundle and its `.sigstore.json`; owner question OQ3 answered yes (a user-local cosign for the runner account, lingering enabled)
Branch: none (no repository change)
Worktree: $WT/nemar-cli-pc-s2d (base origin/dev, read-only use, to run the CLI from source)
Plan: .context/plans/portable-compute/plan.md, D4, D5, D6; the bar of `cards/S3a.md` (Context): staging drills pass on the fixture with zero ledger rows and no Tapis tick touching a runner row, the runner from a signed release, limits enforced

## Goal

On staging, the runner installed from its signed release runs as a systemd user service on workstation B at the lowest priority, claims only when the machine is idle (card L2), verifies the image's signature, and four drills behave as ADR 0121 says: a cancelled job ends cancelled, a killed runner leaves no container and its job ends `runner_lost` `lease_expired`, a revoked runner's started job ends `runner_lost` `runner_revoked`, and an unstarted claim whose lease expires is released and later finishes; every drill job has zero ledger rows and was never examined by a Tapis mechanic, and the running container carries the job's limits.

## Context

- Live facts from the manager: as in S2S, plus `$COSIGN_VERSION` and its published checksum line, the runner release version `A.B.C` and the image digest set on the dev Worker.
- The protocol numbers (`shared/contract/compute-runner.ts`): lease 600 s, heartbeat 60 s, at most 3 claims, give-up 60 minutes; the routes are `POST /compute/runners/token`, `/claim`, `/heartbeat`, `/complete` under `$STAGING_API` (the request shapes are in that file); `sweepRunnerLeases` runs on every claim call.
- Each drill uses a fresh job on `nm099996@1.0.1`; a failed or cancelled job leaves its stamp `failed`, which allows the next attempt, and drill 4 ends with the one success.
- Workstation B only; never workstation A or the converter's directories; never before the Sunday demo has ended (about 2026-11-15T12:00 Pacific).
- Workstation B is shared with other people's work (owner, 2026-11-14; `cp2-note-N.md`): the runner's `availability` check (L2) declines to claim while the machine is busy, and drill 4 proves it by configuration, never by loading the machine. A `pause` file in the runner's reservation directory stops all claims.
- The recipe name follows S2S's Context rule (`nemar-floor-zarr`, or `nemar-floor` with input `zarr` after Q0 and Q0b); use the form the deployed head documents.

## Scope

- Workstation B: `$RUNNER_ROOT_STG` (the install prefix, configuration, secret, root, `bin/cosign`), the user units under `~/.config/systemd/user/`. Staging: jobs on `nm099996@1.0.1`, the registration from S2S, one new registration `staging-b2`, read-only database queries.

## Decided design

Settled, in order:
1. cosign on `$WS_B`: download the pinned `$COSIGN_VERSION` linux amd64 binary from the sigstore cosign GitHub release into `$RUNNER_ROOT_STG/bin/cosign`, check its SHA-256 against the published checksum line, `chmod 0700`; `"$RUNNER_ROOT_STG/bin/cosign" version` prints that version.
2. Install from the signed release. First read the release workflow's own verify step in the run that published A.B.C (`.github/workflows/runner-release.yml`, steps "Sign the bundle and verify the signature" and "Check that cosign refuses a wrong workflow repository"): both must be green, because a real certificate field that does not read as expected (repository or trigger) fails the owner's first signed release there, before any file is attached, and never reaches an install; a red step there is a stop, not a drill. The S2S checkout predates S4, so the first install bootstraps from the release itself: download `nemar-runner-A.B.C.tar.gz` and its `.sigstore.json` from the release of the tag into `$RUNNER_ROOT_STG/boot/`, verify by hand with `"$RUNNER_ROOT_STG/bin/cosign" verify-blob <tarball> --bundle <bundle> --certificate-identity-regexp '^https://github\.com/nemarOrg/nemar-process/\.github/workflows/runner-release\.yml@refs/tags/nemar-runner-v[0-9]+\.[0-9]+\.[0-9]+$' --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-github-workflow-repository nemarOrg/nemar-process --certificate-github-workflow-trigger push` (the four checks `install` makes, from S4's `docs/runner.md`), unpack it there, and run its own installer: `python3 -I -S -c '<the runpy boot line of S2S step 5>' "$RUNNER_ROOT_STG/boot/runner" install --version A.B.C --prefix "$RUNNER_ROOT_STG/install" --write-units --cosign-path "$RUNNER_ROOT_STG/bin/cosign"` (`install` does not read the configuration, and `$RUNNER_ROOT_STG/bin` is not on the launch PATH, so without `--cosign-path` it refuses with `cosign_missing`; the configuration's `cosign_path` serves `self-update` and image verification); then delete `$RUNNER_ROOT_STG/boot` and the S2S checkout `$RUNNER_ROOT_STG/src` (the configuration gains `verify_images` true, `cosign_path` `$RUNNER_ROOT_STG/bin/cosign`, `self_update` true, and `"availability": {"claim_memory_mb": M, "reservation_dirs": [the absolute path of $RUNNER_ROOT_STG/reservations]}` with S2S's M, that directory created with mode 0700); the runner's `availability` command prints `availability: idle`; `systemctl --user show nemar-runner.service -p Nice -p IOSchedulingClass` prints `Nice=19` and the idle class (3); the install log shows the bundle verified; `loginctl show-user "$USER" -p Linger` prints `Linger=yes`; `systemctl --user daemon-reload && systemctl --user enable --now nemar-runner.service nemar-runner-update.timer`; `systemctl --user is-active nemar-runner.service` prints `active`; `self-update` run once by hand logs no newer release.
3. Drill 1, cancel: dispatch (`admin compute pipeline run nemar-floor-zarr --dataset nm099996@1.0.1 --executor runner --json`, staging administrator); when the record shows `running`, `admin compute jobs cancel <job>`; the record ends cancelled with the cancel noted; the runner log shows the cancel and `scratch_discarded`; during the run, the log shows the signature verified for the image digest (image verification, card C2, checks the identity, the issuer and `--certificate-github-workflow-repository nemarOrg/nemar-process` only, with no trigger flag, because images are published by `workflow_dispatch` and by tags; a hand check of the image uses the same flags), and `docker inspect --format '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}'` of the job's container (found by its `nemar.job` label) equals the job's memory in bytes and cores times 1000000000; `docker inspect --format '{{.HostConfig.CpuShares}}'` of the same container prints 2 (or 0 with the launcher log saying the engine cannot apply CPU shares); and `ps -o ni= -p <pid>` of the job's launcher process (`pgrep -u "$(id -u)" -f nemar_launch`) prints 19.
4. Drill 2, kill: dispatch; when `running`, kill only the runner's main process, as a crash would: `kill -KILL "$(systemctl --user show -p MainPID --value nemar-runner.service)"`; within 60 s `docker ps -q --filter label=nemar.job=<job>` prints nothing (L1's parent-death signal, then the restarted runner's removal); stop the service (`systemctl --user stop nemar-runner.service`) so it claims nothing during the wait; after the lease the record shows `unreported`, and after the give-up wait `failed` `runner_lost` `lease_expired` (a claim call is needed to run the sweep: restart the service when the give-up time has passed and no other job is queued).
5. Drill 3, revoke: dispatch; when `running`, revoke the S2S registration with the staging owner key (`admin compute runners revoke <id>`); the runner logs `runner_unknown`, stops the job, deletes its directory and exits 3; register `staging-b2` with S2S step 3's command (new secret into the same file, `umask 077`) and start the service; its first claim's sweep moves the job to `failed` `runner_lost` `runner_revoked`.
6. Drill 4, unstarted lease expiry, a busy machine, then success: stop the service; dispatch; on `$WS_B`, exchange the secret for a token and claim with `free_slots` 1 over HTTPS with `curl` (the secret read from its file and never echoed), and send nothing else. After 11 minutes, make the runner see a busy machine by configuration only: read `MemAvailable` in MiB, set `availability.reserve_memory_mb` to that value plus 1024, and start the service; for 3 minutes the journal shows `claim_skipped reason=memory` and no claim request, and the record still shows `claim_attempts` 1. Then restore `reserve_memory_mb` (remove the key), create `$RUNNER_ROOT_STG/reservations/pause`, restart the service: for 2 minutes the journal shows `claim_skipped reason=paused`. Remove the file and restart: the claim's sweep releases the expired claim and claims the job again (`claim_attempts` 2 in the record), runs it, and the record ends `finished`.
7. For each drill job: `SELECT COUNT(*) AS n FROM compute_ledger WHERE job_id = '<job>'` prints 0, and `SELECT examined_at, tapis_uuid, accounting, executor FROM compute_jobs WHERE id = '<job>'` prints NULL, NULL, `none`, `runner` (through `bunx cfman wrangler --account sccn d1 execute nemar-db-dev --remote --env dev -c backend/wrangler-sccn.toml --command "<query>"`).
8. Leave the service running with `staging-b2` (it is staging's runner from now on); write `<operator scratch>/s2d/README.txt` with every job id, state, detail, the times, step 3's limits line, and step 7's rows.
The implementer may choose: the order of waiting (do drill 3 while drill 2's give-up wait runs only if the service is restarted for drill 3 after drill 2's job is `unreported`).

## Acceptance

- The four drills end exactly as the Goal says (`bun run src/index.ts admin compute jobs record <job> --json` for each: cancelled; `failed` `runner_lost` `lease_expired`; `failed` `runner_lost` `runner_revoked`; `finished` with `claim_attempts` 2), step 7 holds for all four jobs, step 3's limits and priority lines match, and `journalctl --user -u nemar-runner.service` shows the bundle and image verifications and drill 4's `claim_skipped` lines for `memory` and `paused` with no claim between them.

## Gates

- `bun run src/index.ts admin compute jobs record <job> --json` for each of the four jobs, run again after `README.txt` is written, with the same states and details.

## Stop conditions

- The release run of A.B.C has a red verify step (step 2's first check): stop before installing and report the step's log; it is the owner's release to fix, not a drill result.
- Any drill ends otherwise than stated: stop, leave the evidence, report the record and the last 30 runner log lines with secrets removed; it is a finding for the lead (the bar is not met).
- A container outlives drill 2's 60 s: stop (L1 or the removal failed).
- The runner sends a claim while its `availability` check says busy or paused: stop (an L2 defect; the bar is not met).
- Workstation B is genuinely busy (the `availability` command says busy with the default configuration) when a drill would start: wait, re-checking every 15 minutes; after 2 hours stop with "postponed: workstation B busy" (not a failure).
- Anything would touch production, workstation A or the converter's directories: stop.

## Report

At most 25 lines: versions (runner bundle, image digest, cosign), every drill's job id and end state, the limits and priority lines, drill 4's busy-window lines, the ledger and Tapis checks, evidence directory.
