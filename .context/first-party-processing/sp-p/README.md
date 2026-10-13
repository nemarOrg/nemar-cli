# SP-P: AMICA cost per device class

Spike code and raw results behind sections B.6c and B.6d of
[`../../first-party-processing-design.md`](../../first-party-processing-design.md).
The decision rules were written before any timing ran: [`PREREG.md`](PREREG.md).

These are templates, not runnable as they stand.
The scripts ran on SDSC Expanse (Slurm, Lustre project space), and every site-specific value is a placeholder:

| Placeholder | Meaning |
|---|---|
| `<ACCOUNT>` | the Slurm account charged |
| `<USER>` | the cluster user name |
| `<SPIKE_ROOT>` | the working directory holding `code/`, `venvs/`, `data/`, `results/`, `logs/` |
| `<SPIKE_PARENT>` | its parent directory |
| `<LOCAL>`, `<SCRATCH>` | local paths from the laptop that drove the runs |

Replace them before submitting, and check the partition, constraint and time-limit lines against your site.
Rules that applied there: nothing ran on a login node, and the short experiments used the `debug` and `gpu-debug` partitions.

## Files

| File | What it does |
|---|---|
| `probe.py` | One measurement: cost per iteration as the slope between two fits of different length after a warm-up fit, for pamica torch (CPU or CUDA) or the native Fortran binary |
| `drive.py` | Runs a plan of probes (`gpu`, `gpu2`, `key`, `cpu`, `cpunat`) or packs N concurrent fits (`pack`) and writes JSON Lines |
| `anchor.py`, `compare.py`, `compare2.py` | 2,000-iteration fits on a real recording and the component-equivalence comparison (map and activation correlation after Hungarian matching) |
| `analyze.py` | Applies the decision rules to a results directory |
| `native_setup.sh`, `native_smoke.sbatch`, `native_build_modules.sbatch` | Getting the native Fortran binary to run on a glibc 2.28 cluster (see sccn/pAMICA issue 370 and pull request 371) |
| `*.sbatch` | The jobs, one per question |
| `docker/` | Container builds of the Linux binary and the seeded, fixed-thread comparison used for the pamica pull request |
| `results/` | Raw JSON Lines from the jobs and the component anchors (`anchors/*.npz`) |

## Not included

The real test recording (OpenNeuro ds002718, subject 002, 70 EEG channels, 747,750 samples, about 400 MB as float64) is a public dataset.
pamica's `benchmarks/README_dimsweep.md` gives the download and extraction recipe; the comparison scripts expect it as `ds002718_full.npy`.
The environments were built with `uv` (`env_build.sbatch`): torch 2.8.0 with the CUDA 12.8 wheel for the V100 (the 12.8 index stops at torch 2.11.0, so pamica 0.4.0 was installed without its dependency pin), and the CPU wheel for the CPU arm.

## Result files

| File | Section | Content |
|---|---|---|
| `gpu_grid_*.jsonl`, `gpu_grid2_*.jsonl` | B.6c | V100 grid over block size, channels and samples, float64 and float32 |
| `gpu_pack*_*.jsonl` | B.6c | N concurrent fits on one GPU |
| `anchors/` | B.6c | V100 2,000-iteration fits on the real recording, float64 and float32, seeds 42 and 43, and 20-minute and 10-minute windows |
| `cpu_scale_*.jsonl` | B.6d | torch-CPU thread scaling (the native rows of that job failed on glibc; see the native files) |
| `cpu_native_*.jsonl`, `cpu_native_t1_*.jsonl` | B.6d | the CI-built native Fortran binary, 1 to 32 threads |
| `gpu_shared_wait_*.jsonl` | B.6d | the V100 reference point repeated on `gpu-shared`, with the queue wait recorded in the design |
