---
name: hallu-launch-and-self-deploy-lag
description: Launching background jobs on Hallu over ssh hangs the session unless fully detached; and a hallu-zarr.sh run that pulls new code still executes the OLD script body (bash reads incrementally), only its python is new
metadata:
  type: project
---

Two Hallu operating facts learned 2026-09-03 during the epic #1181 closeout.

1. `ssh hallu '... nohup cmd >> log 2>&1 &'` hangs the local ssh until the remote job exits, even with `disown`, because the remote shell keeps the session's pipes open. What returns immediately: `ssh hallu 'cd DIR && (setsid nohup env VARS script args > log 2>&1 < /dev/null &); sleep 1; echo launched' < /dev/null`, with nothing else in the same remote command. Verify the job in a second, separate ssh call.

2. `hallu-zarr.sh` self-deploys: `setup()` resets the clone to `origin/$ZARR_DRIVER_REF` in the middle of the run, and cron invokes the clone's copy of the script. Bash reads scripts incrementally from the original file handle, so the run that pulls a new commit still executes the previous script body (its reconcile args, callbacks, and guards), while every python it invokes afterwards is the new code. Only the NEXT run executes the new script. Seen when the first `--test` run after #1211 still logged `rejected=7` with the new `(xx099903, ...)` sample format; the relaunch behaved. Also true for prod: the run that consumes the engine-bump ack after a release runs the previous release's script with the new python.

**Why:** both cost real time to diagnose and look like bugs in the change being deployed.

**How to apply:** after any merge that changes `hallu-zarr.sh` itself, expect one lagging run before judging it, or launch a second manual run. For ssh launches use the detached form above. Related: [[epic-branch-ci-and-purge-lock]], [[crontab-edit-via-file-not-pipe]].
