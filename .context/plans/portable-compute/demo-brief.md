# Demo brief: portable compute, Sunday 2026-11-15

This page is for the owner.
It says what can be shown, what is live and what is recorded, what each part proves and does not prove, and what comes next.
Times are Pacific.
Every row rests on a gate that passed in the recorded evidence; anything without a passed gate is under "does not prove yet".
Last updated 2026-11-14 00:08, before DM-15 (the live run through NEMAR's routes) has a result; this brief is updated if DM-15 passes before 2026-11-15T05:00.

## 1. What you can say

"NEMAR's quality control (QC) recipe, built on eegprep, ran in a container identified by its image digest on a lab workstation over a real public electroencephalography (EEG) dataset, streaming the recordings from NEMAR's Zarr serving copy with no dataset download and nothing kept on disk, and wrote QC tables with signalJourney provenance; the same recordings open in mne-python.
QC ran on NEMAR's Zarr serving copy (EEG resampled to 250 Hz, 16-bit), not on the archived recordings.
The pull-based runner and its queue are built and tested against NEMAR's real control-plane code; they are not yet deployed."

Add: the container image was built and signed in continuous integration (CI), and its digest was checked on the demo workstation before the run.
Label every recording and every run "manual run, not dispatched by NEMAR".
Do not say the F1 sentence (the runner claiming a job from NEMAR's control plane on the workstation): no live run has passed.
The four stores in this demo measured 32 channels at 200 Hz, equal to the index, so do not quote 250 Hz as a measurement of this dataset.
Never say or imply: runs on high-performance computing (HPC) unchanged, the runner verified a signature, private data, EEGLAB support, EEGDash integration, derivatives published or citable, catalog-scale throughput, or a consolidated NEMAR reader.

## 2. Live or recorded

All runs used the public dataset `nm000274`, version `v1.0.5` (tag commit `91a8f5c9c83117b7e064cf7ae4eef1220b81cf57`, Zarr index source commit `64feed5210ebea128a8484acd3027f9551ff2d7e`).
Only `.nemar/availability-report.json` and `.nemar/metadata.json` changed since the tag (verdict `metadata_only`, checked by the GitHub compare call).
Abbreviations: nemar-cli epic head `27868ce1b2ea81424b42a3bc518f750821717de9` ("cli head"); nemar-process runner-epic head `13b3a899f2adf42b01120496cb902abf19feb1b2` ("process head"); eegprep-lean reader commit `14ba46e8da5340cd7ae6adb644cda24fb3f5e483` ("reader commit").

| Step | Mode | Recorded time and commit | Gate it rests on |
|---|---|---|---|
| Image digest and signature | recorded | signature verified against the CI workflow identity 2026-11-13 18:37, pulled by digest on the demo workstation and equal 23:48; image `sha256:33922cad47b58098079905edb9a06e688e533c30e0a24e364c0306f0f14c431a` (tag `0.1.0-cpu`); published by the CI image run on nemar-process `main` at `9212eb5a919cfdd5d6b74fc77f8ea7aed807fc70`, 2026-11-13 18:18, per GitHub's run list (the image's own labels were not read; the digest is the identity) | G4 path A, passed |
| Recipe run in the container | live, about 15 s | 2026-11-13 23:54, cli head and process head | F2-a, passed: exit 0 in 14 s, 4 of 4 stores, 0 failed |
| Provenance check | live | 2026-11-13 23:55, process head | G6, passed: five signalJourney records, exit 0 each |
| Discard | live | 2026-11-13 23:55, process head | F2-a discard, passed: `discarded` printed |
| Reader in mne-python | live | 2026-11-13 23:55, reader commit | G8 and F2-b, passed: all 4 stores, 32 channels, 200 Hz, sample counts equal to the index |
| Control-plane tests | live (about 19 s) | 2026-11-14 00:00, cli head | G2 and F2-c, passed: six test files, 254 pass, 0 fail, plus typecheck, lint and the D1 catalog check |
| Runner and launcher tests | recorded only (about 4 minutes) | 2026-11-14 00:00, process head | G3 and F2-c, passed: 3781 passed, 57 skipped (the container tests that need Apptainer are skipped on that machine) |
| Runner in CI with real Apptainer | recorded only | CI run on the process head `13b3a899f2adf42b01120496cb902abf19feb1b2`, 2026-11-13 19:30 | G3 CI job, passed: 2 tests, not skipped |

Every live row has its recording as the fallback; the recordings are the operator's typescript files.
The discard row is the manual run's own `rm` and `test ! -e`, not the runner's G7 check.
The full `bun test` suite was not run.

## 3. What it proves and does not prove

What it proves, one line per passed gate:

- G4: the image on the demo workstation is the CI-built, signed digest named above, and the container tooling inside it reports `nemar-floor-zarr` 1.0.0 and `eegprep` 0.5.0.
- G1: the demo workstation runs that digest with memory and CPU limits applied (control groups version 2) as the owner's login.
- F2-a: the QC recipe processed 4 of 4 EEG stores over the network in 14 s inside a read-only container with all capabilities dropped, 4 CPUs and 16 GiB, and wrote 5 records.
- G6: all 5 signalJourney records are schema-valid, and the aggregate record names the image digest and both commits.
- F2-a discard: the output directory was deleted afterwards, and the container root was read-only, so nothing of the run remains on the workstation.
- G8: the same 4 recordings open in mne-python with 32 channels at 200 Hz and the index's sample counts.
- G2: the control-plane tests of the runner registry, queue, callers and local stack pass on the cli head.
- G3: the runner and launcher tests pass on the process head, and the runner stack ran in CI with real Apptainer.

What it does not prove yet:

- A job dispatched through NEMAR's routes and run by the runner on the demo workstation (F1).
  The real runner flow (register, claim, run, finish) is proven on the local stack through real routes in CI, but no run on the workstation has passed.
- Staging or production: nothing here touched either; the dark switches stay untouched.
- Private data: only a public dataset was read.
- HPC or any scheduler: only a workstation with Docker.
- The runner's own Docker backend on the demo workstation: Docker was run by hand.
- The Zarr conversion migration: the conversion cron is untouched and unchanged.
- The fidelity of the serving copy: QC ran on the resampled copy, so QC values describe that copy, not the archived recordings.
- Where derivatives will live: the outputs of this run existed only in the local scratch and the operator's evidence directory, not in any NEMAR store, and were then discarded.
- Reproducibility of the input: the recipe writes `index_sha256` and `bytes_read`, but the platform does not verify them, and G6 proves schema validity only.
- A consolidated reader: the reader that ran is `eegprep-lean` at a commit now on the `develop` branch of eegprep, not a release; the image's pin moves to a release later (step PX-08).
- Release provenance in the records: the published image `0.1.0` predates the release-provenance change (nemar-process pull request 28), so its records carry the image digest but not the nemar-process release version and commit; the first image with them needs a release tag and the owner's publish.
- That the runner verifies image signatures: the signature was checked by hand on the operator's machine.

## 4. Run order for Sunday

Placeholders: `<ws>` is the demo workstation login, `$RUNNER_ROOT` is its runner directory, `<out>` is a local evidence directory.
No secret is needed for any step.

```bash
# DM-19 step 2: the directory the run writes into (on the demo workstation)
ssh <ws> 'mkdir -p -m 0700 "$RUNNER_ROOT/manual/out"'

# DM-19 step 3: the recipe in the container (on the demo workstation)
H=33922cad47b58098079905edb9a06e688e533c30e0a24e364c0306f0f14c431a
ssh <ws> "docker run --rm --user \"\$(id -u):\$(id -g)\" --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp --cpus 4 --memory 16384m --mount type=bind,src=\$RUNNER_ROOT/manual/out,dst=/work/outputs ghcr.io/nemarorg/nemar-python@sha256:$H nemar-recipe run nemar-floor-zarr --out /work/outputs/product --dataset-id nm000274 --dataset-version v1.0.5 --source-commit 64feed5210ebea128a8484acd3027f9551ff2d7e --tag-commit 91a8f5c9c83117b7e064cf7ae4eef1220b81cf57 --commit-equivalence metadata_only --image-digest sha256:$H --zarr-base https://zarr.nemar.org --commit-delta-path .nemar/availability-report.json --commit-delta-path .nemar/metadata.json"

# DM-19 step 4: copy back, validate each signalJourney file, discard (validate in the nemar-process checkout at the process head)
scp -r "<ws>:$RUNNER_ROOT/manual/out/product" <out>/
for f in $(find <out>/product -name '*signalJourney.json'); do uv run --group signaljourney python scripts/validate_signaljourney.py "$f"; echo "rc=$?"; done
ssh <ws> 'rm -rf "$RUNNER_ROOT/manual" && test ! -e "$RUNNER_ROOT/manual" && echo discarded'

# DM-19 step 5: the reader, once per store (the store argument is the index path key, the .edf path)
uv run --no-project --with "eegprep-lean[zarr,mne] @ git+https://github.com/sccn/eegprep@14ba46e8da5340cd7ae6adb644cda24fb3f5e483#subdirectory=packages/eegprep-lean" python -c "import eegprep_lean as L; w = L.load_recording('nm000274', '<store .edf path>'); r = L.to_mne_raw(w); print(r.info['nchan'], r.info['sfreq'])"
```

The four store paths are `sub-4/ses-0/eeg/sub-4_ses-0_task-imagery_acq-finaltest_run-1_eeg.edf`, `sub-4/ses-0/eeg/sub-4_ses-0_task-imagery_acq-finaltrain_run-0_eeg.edf`, `sub-5/ses-0/eeg/sub-5_ses-0_task-imagery_acq-finaltest_run-1_eeg.edf` and `sub-5/ses-0/eeg/sub-5_ses-0_task-imagery_acq-finaltrain_run-0_eeg.edf`.
Expected: exit 0, a summary of 4 discovered and 4 succeeded, `rc=0` five times, `discarded`, and `32 200.0` four times.
If DM-15 passes, its steps 2, 3 and 7 to 9 are added here by an update.

## 5. If something fails on stage

Switch in this order, and say "recorded" aloud each time.
1. Recipe run or network trouble: the recorded step 3 transcript (2026-11-13 23:54, exit 0 in 14 s).
2. Validation: the recorded step 4 validation and discard output (23:55).
3. Reader: the recorded step 5 transcript (23:55).
4. Tests: the recorded step 6 transcripts (2026-11-14 00:00), including the runner and launcher run.
5. Anything else: the architecture slide of the plan, then stop and answer from section 3.

A question outside the evidence gets "not shown yet", with the matching line from "does not prove yet".

## 6. Next

- Phase S (staging and production runner jobs): S1, a dev-owned compute fixture `nm099996` eligible outside production only; then S2, the epic reaching `dev` with a staging job finished.
- Phase Z (Zarr conversion becomes a pipeline): Z0, ADR 0123 proposed after the CP-F review; then Z1, the formats contract file.
- Phase R (readers): R0, the collaborator's reader epic arriving upstream with ADR 0120; then R1, the shared reader transport.
