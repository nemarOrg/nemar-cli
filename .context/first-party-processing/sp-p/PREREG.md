# SP-P pre-registration: AMICA cost per device class (written before any timing job ran)

Date: 2026-10-12. Account `<ACCOUNT>` on SDSC Expanse. Scope rule from the owner: short experiments only,
on the `debug` and `gpu-debug` partitions, never on a login node.

## Questions
Q1. Which backend is cheapest per fitted recording-hour on a device NEMAR can get: pamica torch on a V100,
    pamica torch on one CPU core or thread-scaled, or the native Fortran binary (single process, OpenMP, no MPI)?
Q2. On the V100: how do block size and channel count change seconds per iteration and peak GPU memory?
Q3. On the V100: does running N fits concurrently on one GPU raise aggregate iterations per second?
Q4. On a 128-core EPYC node: does the Fortran binary beat pamica torch-CPU, per core and at saturation, and what
    does a node deliver when filled with independent single-thread fits?
Q5. float32 against float64 on the V100: speed ratio (equivalence of the components is NOT tested here).

## Method (all of it)
Per-iteration cost is the slope (t_b - t_a)/(b - a) between two fits of different length in one process after a
warm-up fit, so setup, kernel compilation, file I/O and process start drop out. Early stops are disabled
(use_min_dll off, use_grad_norm off); `full_length` must be true or the point is void. Newton off, n_models 1,
n_mix 3, seed 42. Data are synthetic Laplace/Student-t mixtures (timing depends on shape, not content, with
Newton and early stops off), plus one real 70-channel recording (ds002718 sub-002) as a cross-check against
pamica's own published RTX 4090 figures. Each point is one process, so peak memory is per fit.

## Decision rules (fixed before the numbers exist)
R1 (engine per device class). Compare cost in Expanse service units (SU): V100 = 1 SU per GPU-hour on
   gpu-shared; CPU = 1 SU per core-hour on shared, 128 per node-hour when exclusive. If the native Fortran
   binary is at least 1.5x faster than pamica torch-CPU at the same thread count, the CPU arm of the recipe uses
   the native backend of the pamica package (same state format); otherwise torch-CPU.
R2 (GPU vs CPU). The GPU arm is preferred only if SU per fitted recording-hour on the V100 is below the best CPU
   arm's by at least 3x, OR wall time per recording-hour is below a quarter of the best CPU arm's at a similar
   SU cost. The owner's availability argument (CPU nodes are easier to get) is recorded as a tie-breaker, not as
   a number this spike can measure.
R3 (block size). Per channel count, pick the block size with the lowest s/iter; ties within 5% go to the larger
   block (fewer launches). A block size becomes part of the recipe pin because it changes the trajectory (~1e-6).
R4 (packing). Adopt N concurrent fits per GPU if aggregate iterations/s at N in {2,3,4} is at least 1.3x the N = 1
   value and peak memory per process times N stays under 80% of the GPU's 32 GiB.
R5 (CPU packing). The node price per fitted hour is 128 SU / aggregate iterations per second at P = 128 (or the
   best P), compared with R2's GPU figure.

## Not decided here
Component-level equivalence across backends and device classes (needs real 2000-iteration fits, which do not fit
the 30-minute debug limit); the bounded fit window; the A100 nodes in gpu-shared (not used under this scope
rule); Tapis; containers. Those are the next stage and need a go-ahead for gpu-shared or shared partitions.

## What would void a point
Not full length; a crash; a timeout; a CUDA wheel without sm_70 (the whole GPU arm is then re-run on the fallback
torch 2.8.0 and the venv choice is reported).
