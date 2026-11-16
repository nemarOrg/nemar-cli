# pAMICA: same-seed parity with the Fortran reference, for NEMAR

**Status:** revision 1, 2026-11-14 (Saturday), written by the lead (Opus); not yet reviewed by an executability or design reviewer.
**Owner:** Seyed Yahya Shirazi (pAMICA maintainer; merges and releases).
**Repository:** `sccn/pAMICA` (public; default branch `dev`, release branch `main`).
**Consumers in NEMAR:** eegprep PR #617 (`pop_runica(icatype='pamica')`, NEMAR card PX-03) and the `nemar-ica` recipe (PX-05, PX-06), which pin `pamica==0.4.0`.

Abbreviations, defined once here: Adaptive Mixture Independent Component Analysis (AMICA); continuous integration (CI); pull request (PR); log-likelihood (LL); Apple's Metal Performance Shaders (MPS); Apple's array framework (MLX); NVIDIA's Compute Unified Device Architecture (CUDA); graphics processing unit (GPU); out of memory (OOM); Architecture Decision Record (ADR); independent component (IC); Linear Algebra Package (LAPACK); JavaScript Object Notation (JSON).

## 0. How the manager uses this plan

1. **Start prompt and owner questions:** `START.md` beside this file. The manager is a separate Sonnet session with the id `mba-claude-sonnet-pamica`.
2. **The tick** is `runbook.md`; its Setup section creates the epic issue and, after Q1, the epic branch.
3. **Precedence.** The owner's later instructions override this plan and are logged with `decide`.
   pAMICA's `AGENTS.md` and `.rules/` override this plan for everything inside sccn/pAMICA, with one explicit exception: the two-round review cap of section 7 (R4) replaces "address ALL PR review findings" by "every finding gets an outcome: fixed, filed as an issue, or rejected with a reason".
   nemar-cli's `AGENTS.md` governs the pack files themselves (public repository: no host names or real paths in them).
4. **Merge authority (Q1).** With Q1 answered A, the manager merges step PRs into the epic branch `feature/issue-$EPIC-nemar-parity` after the merge gate, with `gh pr merge <n> -R sccn/pAMICA --squash --delete-branch`, never `--admin`.
   With Q1 answered B, the manager merges nothing: each PR targets `dev` and waits for the owner.
   The manager never merges into `dev` or `main`, never tags, releases or publishes, and never touches eegprep merges.
5. **Question classes that may take a default at their deadline:** none.
6. **Routing.** Implementers are Sonnet (`worker`, `worker-hard`) on the one `claude-sonnet` slot.
   The one `claude-opus` slot does planning (the checkpoint card PA-08 and outline completion), every review (one Opus reviewer per round), and advisor consults.
   The frontier tier is never used unless the owner asks.
7. **Issue posting.** Implementers post issues only from texts their card pre-writes.
   The manager may run `gh issue create` only for the epic issue (Appendix A) and for the "parity not attained" template (Appendix B) filled with numbers from a recorded owner answer (PA-07); this is the plan's one exception to the skill's "never post".

## 1. Goal

The owner's words (2026-11-14): "pAMICA is quite important and critical resource, so it is important to keep it as true as possible.
We already have the fortran binary shipped in pamica, so the goal is that the pytorch, and mps match the fortran results on the same seed, when possible."

Made precise:

- **"The Fortran results"** are those of the binary pAMICA builds from its maintained `amica15.f90` and attaches to each release (`amica15-macos-arm64`, `amica15-linux-x64`, ...), which honors a `seed` parameter.
- **"The same seed"** means the same start: pAMICA's seed `s` defines a starting state (`numpy.random.RandomState(s)`, `pamica/initialization.py`), and the binary is started from that state through its `load_*` inputs.
  The binary's own `seed s` draws from gfortran's generator, a different start (`pamica/initialization.py:17-22`); comparing that run with pAMICA's seed `s` is an independent-start comparison, which can only agree distributionally.
- **"When possible"** is a per-backend tier (section 5), pre-registered from measured spread, with a documented "not attained because X" as an acceptable outcome (section 7, R5).

Scope kept from the first brief, now subordinate to the goal: a documented reproducible pipeline and a run record eegprep can store, honest convergence reporting, GPU out-of-memory propagation, the pAMICA issues that block the goal, the recipe or the reproducibility claim, and the downstream eegprep consequence.
Out of scope: anything section 8 leaves, a float32-aware stopping rule (#362), multi-model parity beyond what exists, warm starts on the array backends (#312), and every release step (the owner's).

## 2. Evidence: what pAMICA already gives (read 2026-11-14, `dev` at 0e93728, version 0.4.1.dev1)

1. **Release binaries and resolution.** `pamica/native/resolver.py:101-150`: `PAMICA_NATIVE_BINARY` override, then a cache at `<cache>/<version>/<asset>`, then a download from the release verified against its `.sha256` asset before it is moved into place; a cache hit is returned unchecked, and `"latest"` is never refreshed (#331).
   The binaries are built from pAMICA's own `pamica/amica15.f90`, which carries sccn/amica PR #54: a full-size seed array and a `seed` parameter (`native/patch_sources.py`); unseeded runs still mix in the clock.
   The 0.4.0 Linux assets need glibc 2.38; `dev` builds them on glibc 2.28 (#370, PR #371, unreleased). The v0.4.0 `amica15-linux-x64` SHA-256 is `ada316d3cd8819a5e506b51b48eb464eccba133b81d4efbf63f977e680bb6b1a` (read for NEMAR PX-06).
2. **`AMICANative`** (`pamica/native/engine.py`): writes data and an `input.param` from pAMICA's shared defaults plus keywords, so `seed=5489` reaches the binary as `seed 5489`; `fix_init` is written as 0 (`engine.py:43`); `threads` only sets `OMP_NUM_THREADS` (`engine.py:247-251`) while the binary calls `omp_set_num_threads(max_threads)` from `input.param` (`amica15.f90:93-100`), so `threads=1` still runs 10 threads (#358). NEMAR's PX-01 and PX-06 call `AMICANative(threads=1, ...)`.
3. **The shared start exists, but only in tests.** `pamica/tests/native_oracle.py` writes pAMICA's state into the binary's `load_A`, `load_mean`, `load_mu`, `load_beta`, `load_rho`, `load_alpha`, `load_gm` and `load_c` files (full rank only, `native_oracle.py:214-215`; `load_sphere` crashes the binary, so it computes its own sphere).
   It is not in the public API and not in the wheel. `validate_implementations.py` compares independent starts only (#359).
4. **Measured same-start agreement** (`docs/guides/validation.md`):
   bundled sample, harness settings, 100 iterations, PyTorch float64 against the v0.3.3 macOS arm64 binary on one thread: LL difference 1.6e-6, mean matched correlation 0.99999993, Amari distance 3.9e-5 (`validation.md:112-125`); first-iteration LL equal to 9e-16;
   MLX float32 against PyTorch float64 from the same start, 100 iterations: 5.0e-6, 0.99999991 (minimum 0.9999994), 5.0e-5;
   70 channels (OpenNeuro ds002718 sub-002), identity start (`A = I`, `mu` at -1, 0, 1, `sbeta` 1, `rho` 1.5) through `load_*`, 2000 Newton iterations, CUDA float64: mean correlation 0.9999998 (minimum 0.9999964), Amari 3.8e-5, final LL 7.6e-8 apart (`validation.md:188-216`).
   Independent starts with Newton on spread on weak components (pamica seed 42 against reference seed 1: minimum 0.667), as the reference does against itself (minimum 0.841).
5. **`fix_init`.** The reference's `fix_init 1` starts from `A = I`, `mu` at fixed centers and `sbeta` 1 with no random draw (`amica15.f90:750-771, 805-810`). pAMICA: the shared `initial_mixing(fix_init=)` exists, NumPy honors an undocumented `fix_init` attribute (`numpy_impl/core.py:1761, 1795, 1803`), torch and MLX have no parameter, and `pamica/fortran_params.py:340` lists it "not ported".
   Not needed for the goal (the shared start covers it); filed as an issue (PA-06).
6. **New finding: mixture locations at the start.** The reference sets `mu(j,k) = j - 1 - (num_mix-1)/2` (`amica15.f90:750`); all three array backends use `numpy.linspace(-1, 1, n_mix)` (`torch_impl/core.py:1220`, `numpy_impl/core.py:1794`, `mlx_impl/core.py:1146`).
   They agree only for `n_mix = 3` (NEMAR's value). Not in `docs/guides/amica-differences.md`; no issue found. Filed by PA-06.
7. **Backends and precision.** PyTorch CPU float64 and float32, CUDA float64 and float32, MPS float32 only (an explicit `device="mps"` with float64 raises `ValueError`; an automatic MPS pick for float64 moves to the CPU, `torch_impl/core.py:692-697`), MLX float32 (the recommended Apple GPU backend), NumPy float64 (legacy), and the native binary.
8. **Convergence reporting.** `converged_` means "usable": true for every non-degenerate stop including `max_iter` (`amica.py:282-289, 657`); `stop_reason_` names the stop; there is no attribute that says the fit met a convergence criterion.
9. **Out of memory.** With `n_restarts=1` (the default) no handler wraps the fit, so a `torch.cuda.OutOfMemoryError` propagates unchanged; with `n_restarts > 1` the restart loop catches every `RuntimeError`, OOM included, and records a degenerate restart (`torch_impl/core.py:2480-2482`, `mlx_impl/core.py:2614`).
10. **`pcakeep` with `do_sphere=False`.** Ignored with a WARNING, as the reference does (`rank.py:103-145`, `numeigs = nx`); reference-faithful, not a defect. NEMAR's recipe spheres.
11. **The parity CI is red and runs only weekly.** `.github/workflows/ci.yml` never sets `AMICA_RUN_FORTRAN`, so no pull request runs a Fortran comparison.
    The weekly macOS job (`weekly-macos-slow.yml`, shim built on the runner) has failed on every run since 2026-09-27 (#369) on one test, `test_a_freeze_without_sharing_matches_the_reference[freeze]`: "torch: LL off by 1.14e-06, reference noise 6.92e-08" (run 42480739848; 7.51e-08 and 8.99e-08 on two other runs), against a bound of 10 times that floor.
    The test's own table, measured on a development host against the v0.3.3 release asset, gives torch 6.6e-7 against a floor of 4.0e-7 to 4.3e-7: both the deviation and the floor move with the binary's build.
12. **Local measurement (lead, this machine: Apple M4, torch 2.12.1, `dev` 0e93728, no binary run):** PyTorch CPU float64, bundled sample, seed 5489, `block_size` 131072, Newton on from 50, `lrate` 0.05, 200 iterations: weights and LL history bit-identical across two processes and across 1, 4 and 8 threads; `stop_reason_` `max_iter` with `converged_` true.
13. **Not verified:** any run of the Fortran binary on the eegprep sample (no arm64 binary in the local checkout, the bundled `amica15mac` is x86_64, this machine has no Rosetta and no gfortran; nothing was downloaded); any CUDA run; determinism on Linux; MPS out-of-memory behavior.

## 3. Decisions (lead)

**D1. The shared start becomes public API** (PA-02): `AMICANative(start="pamica", seed=s)` writes pAMICA's seed-`s` state into the binary's `load_*` files, moving the machinery out of `pamica/tests/native_oracle.py` into `pamica/native/seeding.py`.
*Rejected:* porting `fix_init` to the array backends as the parity mechanism (it fixes one start, needs the mu-location decision first, and the identity start is already reachable through `load_*`).

**D2. Parity is stated per backend and tier** (section 5), pre-registered from the measured numbers of section 2 with about ten times margin, and never loosened to pass.

**D3. CI plan.** A new `parity.yml` (PA-01) runs the fast Fortran-gated tests on every pull request on `macos-26` (Apple silicon, Accelerate, MPS and MLX available) and `ubuntu-latest`, each against two binaries: the shim built from the pull request's own source and the pinned v0.4.0 release asset (resolved with its SHA-256 check; the Linux asset is the one NEMAR's image ships).
The slow tiers (2000 iterations) run in the existing weekly macOS job, and once per card by `gh workflow run weekly-macos-slow.yml --ref <branch>`.
CUDA has no runner: the owner runs PA-07 on a Linux workstation with an NVIDIA GPU (agents never ssh).

**D4. #369's noise model (Q3, pre-registered before the build floor is measured).** The test claims each backend stays within 10 times "the reference's own round-off noise".
The thread-only floor omits the variation between two faithful builds of the same source (compiler, LAPACK), which section 2 item 11 shows is of the same size.
Rule A: the floor becomes the larger of the thread floor and the build floor (the shim against the pinned release asset, both on one thread, from the same start), the bound stays 10 times it, and the pre-change control must still exceed 100 times it; if torch still exceeds the bound on any leg, the bound is not changed and the case goes to the advisor as a possible real divergence.

**D5. Reproducible pipeline** (PA-04): `pamica.presets.RUNAMICA15` (EEGLAB `runamica15.m`'s settings as the binary receives them, with the reference-restoring `keep_best=False` and absolute `mineig` floor), `run_record()` on `AMICA` and `AMICANative` (schema `pamica.run-record.v1`), and determinism tests on both CI operating systems.
The NEMAR pipeline is: pamica version, engine torch, device cpu, dtype float64, threads 1, seed, `RUNAMICA15` plus `block_size`, recorded in full.

**D6. Convergence reporting (Q2)** (PA-05): `did_converge_` is true exactly for the reference's convergence stops (`lrate_floor`, `grad_norm_floor`, `min_dll`, `grad_norm`), from one shared constant.

**D7. Allocation failures propagate unchanged** (PA-05): the restart loops re-raise any exception `pamica.blocktune.is_allocation_failure` recognizes, as the same object, before recording a degenerate restart.

**D8. The release is the owner's** (PA-10): a minor release (new public API), then the NEMAR pin bump, which this pack does not do.

**D9. Downstream consequence.** Once a release carries `start="pamica"` and PA-03 states the attained tier, an eegprep card can bring E1 back as a gate against pAMICA's binary on the shared seed (PA-09, an outline completed at checkpoint CP-B). Until then the owner's interim decision stands: E1 is informational and eegprep's docs name pamica and its pipeline.

## 4. Steps

Table order is dispatch priority. Every implementer card gets one Opus review per round (the card's Review line names the lens).

| ID | Goal | Literal gate (summary; the card holds the commands) | Depends | Tier | Timebox |
|---|---|---|---|---|---|
| PA-01 | Fortran parity checks on every PR, green, #369 resolved by rule D4 | both `parity` legs green on the final head; floor, build floor and control lines quoted | Q3 for its step 4 | worker-hard | 8h |
| PA-05 | `did_converge_` and allocation failures that propagate | `pytest pamica/tests/test_fit_outcome.py` passes, including a real MPS OOM case | Q2 | worker-hard | 4h |
| PA-02 | Shared start and thread count for `AMICANative` (#358) | binary iteration-1 LL equals PyTorch's within 1e-12 in the parity workflow; seeding round-trip test | PA-01 | worker-hard | 6h |
| PA-06 | File three pre-written issues | issue bodies equal the card's text; leak check clean | PA-02 | worker | 1h |
| PA-03 | Same-seed parity gates per backend; harness shared start (#359) | Tier A and B `PARITY` lines in both legs; Tier C from one weekly run on the branch | PA-01, PA-02 | worker-hard | 10h |
| PA-04 | `RUNAMICA15`, `run_record()`, determinism tests | D1 test green on both operating systems; refit from a record bit-identical | PA-02, PA-05 | worker-hard | 6h |
| PA-08 | Checkpoint CP-A: tier table, card corrections | note at most 60 lines; `card` passes on every edited card | PA-03 | lead | 2h |
| PA-07 | Owner: CUDA float64 parity, determinism, OOM on a GPU workstation | the owner's pasted `PARITY` lines meet Tier A and C | PA-03, PA-04, PA-05 | owner | 1h of owner time |
| PA-10 | Owner: epic into `dev`, then a minor release | `gh release view v0.5.0 -R sccn/pAMICA` shows the release | PA-01 to PA-06, PA-08 | owner | owner |
| PA-09 | eegprep: E1 back as a gate on the shared seed (outline) | completed at CP-B | PA-10, eegprep PR #617 merged | worker-hard | outline |

## 5. Parity targets (pre-registered; the bundled sample `eeglab_data.set`, 32 channels, 30504 samples)

Common to every tier: the binary runs with `max_threads 1`; pamica runs with `keep_best=False`; the same settings on both sides (the bundled `input.param`, read on the pamica side through `pamica.fortran_params`, `block_size` 512); correlation is the Hungarian-matched absolute correlation of the sensor-space unmixing rows, and Amari distance and LL difference are those of `validate_implementations.py` (`compare_results`, `amari_distance`).

| Tier | Backends | Start and budget | Thresholds | Measured basis | Attainable? |
|---|---|---|---|---|---|
| A1 | PyTorch CPU float64, NumPy float64, CUDA float64 (PA-07) | shared start, seeds 42 and 5489, 1 iteration | absolute first-iteration LL difference at most 1e-12 | 9e-16 | yes: same arithmetic up to reduction order |
| A2 | same | shared start, 100 iterations | LL difference at most 1e-5; minimum correlation at least 0.99999; Amari at most 1e-4 | 1.6e-6; mean 0.99999993; 3.9e-5 | near-exact: reduction order (LAPACK, block sums) differs, EM amplifies round-off slowly |
| B | PyTorch MPS float32, MLX float32 (CUDA float32 in PA-07, informational) | shared start, seed 42, 100 iterations | LL difference at most 5e-5; minimum correlation at least 0.9999; Amari at most 5e-4 | MLX against PyTorch float64: 5.0e-6, minimum 0.9999994, 5.0e-5 | near-exact at short budgets only: about 7 significant digits per operation |
| C | PyTorch CPU float64 (CUDA float64 in PA-07) | shared start, seed 5489, 2000 iterations, Newton on | minimum correlation at least 0.999; median at least 0.9999; Amari at most 1e-3; LL difference at most 1e-5 | 70 channels: minimum 0.9999964, 3.8e-5, 7.6e-8; bundled sample unmeasured | unknown at the bundled sample's data adequacy (about 30 samples per squared channel); "not attained" is acceptable |
| C32 | PyTorch MPS float32, MLX float32 | as C | distributional: Amari to the binary's same-start fit at most the largest Amari among the 10 pairs of five binary runs drawn from its own seeds 1 to 5 | float32 Newton fits stop on the learning-rate floor near iteration 950 at 70 channels (#362) | near-exact is not expected (#362); distributional only |
| D1 | PyTorch CPU float64 (CUDA in PA-07) | same settings, two processes, threads 1 | `numpy.array_equal` of weights and LL history | identical on Apple M4 (section 2 item 12) | yes on one host and thread count |
| D2 | same | threads 1, 2, 4 | measured and printed, not asserted | identical on Apple M4 | host-dependent; the record names threads |

Bit-level agreement between engines is not attainable after the first iteration: the engines sum in different orders (LAPACK builds, block reductions, eigensolvers), and the iteration amplifies the last bits (a 1e-9 microvolt change in one sample moves the LL by 4.4e-4 after 25 iterations at 70 channels and 30000 frames, `validation.md:608-630`).
Independent starts (the binary's own seed against pAMICA's) are never near-exact; they are compared distributionally, as the weak components settle into different basins from different starts in both engines.

## 6. What a parity failure means for a NEMAR user

- **Tier A fails** (the update rule differs from the reference's): a pAMICA build that fails A must not be pinned by NEMAR; a record saying "AMICA (pAMICA, Fortran parity)" would be false. The pin stays where it is and the failure is an issue.
- **Tier B fails** (float32 Apple GPU paths beyond float32 consistency): NEMAR does not run on Apple GPUs; a user reproducing a NEMAR record on a Mac must use PyTorch CPU float64, and the docs say a float32 run does not reproduce a float64 record.
- **Tier C not attained, A passing** (long runs amplify round-off on weak components): the algorithm is the reference's, but a NEMAR record is reproducible only with the same engine, device, dtype and threads, which the record names; a comparison with the binary at the recipe's budget can only be distributional, so eegprep's E1 stays informational.
- **D1 fails** (same engine, same settings, a new process gives other bits): the reproducibility promise cannot be made for that host; NEMAR holds the release and the owner decides.
- **C32 fails** (float32 lands in basins the reference does not sample): a scientific divergence; issue and owner decision before any float32 claim.

## 7. Rabbit-hole guard (rules the manager applies literally)

- **R1. Step cap:** at most 12 rows in the Steps table (10 now). The manager never adds a row; the lead adds one only at a checkpoint and within the cap.
- **R2. Dispatch caps:** Budget rows "Agents total" 40 (never resets), "Agents today" 8 (daily), "Advisor consults" 3 (never). Every dispatch (implementer, reviewer, fix round, lead card, advisor) spends "Agents today" and "Agents total"; at a limit the manager stops dispatching and asks.
- **R3. Timeboxes:** the Timebox column; nudge once at the timebox; at twice the timebox, one advisor consult whose verdict is either "continue with this narrowed scope" (the lead writes it into the card) or "stop and file what was measured".
- **R4. Rounds:** at most two review rounds and two fix rounds per card. After round two every open finding gets an outcome: fixed, filed as an issue (text from the reviewer), or rejected with a reason; an open Critical goes to the owner.
- **R5. Parity budget:** per tier and backend, at most two approaches or six agent-hours. Then the thread stops: the implementer posts Appendix B with the measured numbers, records "not attained because X" in `docs/guides/validation.md`, and for a slow tier marks the test `xfail(strict=True)` naming the issue; the card continues with its other tiers. A documented "not attained" is an acceptable outcome.
- **R6. No new scope without the lead:** an idea is recorded with `propose` (one per tick) and never dispatched unless the lead or owner accepts it within R1 and R2.
- **R7. Pack deadline:** 2026-11-28T17:00 Pacific. After it nothing new is dispatched; open steps are written up as issues and the board is set `paused`.
- **R8. Stop:** every step `done` or `dropped`, or everything left waits on the owner: `tick --state paused`, one notification, and the loop ends.

## 8. pAMICA issues: taken on, filed, left (read 2026-11-14)

| Issue | Matters for | Disposition |
|---|---|---|
| #369 weekly parity run red since 2026-09-27 | the goal (the only Fortran gate is red) | taken on: PA-01 |
| #358 `threads` does not set the binary's thread count | reproducibility of the native path; NEMAR PX-01 and PX-06 call it | taken on: PA-02 |
| #359 shared-start context in the harness | the goal | taken on: PA-03 |
| #362 float32 Newton stops on the learning-rate floor | the float32 tier only | left; PA-03 comments the C32 measurement on it |
| #328 `do_sphere=False` variance normalization | nothing NEMAR runs (the recipe spheres) | left |
| #360 seed every side of the benchmarks | benchmark claims, not the recipe | left |
| #331 stale cached `latest` binary | parity reports; NEMAR pins by SHA-256 and the run record names it | left |
| #363 sample data and harness not in the wheel | nothing NEMAR runs | left |
| #317, #319, #320, #307, #298, #312, #314 | restarts, rejection, sharing, warm starts, diagnostics: off in the recipe | left |
| #292 binary block larger than the frames per thread | explicit `block_size` on the native path; tests write per-thread sizes | left |
| #209, #230, #361 controlled experiments and re-measurements | benchmark claims; PA-03 contributes a controlled same-start gate | left |
| new: mixture locations differ for `n_mix` other than 3 | parity of the default start (not NEMAR's value) | filed: PA-06 |
| new: `fix_init` not ported to the array backends | a reference feature | filed: PA-06 |
| new: shared start needs full rank | a future same-seed comparison on average-referenced recordings | filed: PA-06 |

Not pAMICA's (for the record): eegprep's E1 Amari divides by 2n where pAMICA's divides by 2n(n-1); eegprep's `_AMICA_DEFAULTS` differs from `runamica15.m` (eegprep issue #619, which `RUNAMICA15` can resolve).

## 9. Checkpoints

- **CP-A** (PA-08, after PA-03 merges or on 2026-11-21, whichever comes first): the lead reads the PA-01 to PA-03 reports and their `PARITY` lines, writes `cp-a-note.md` here (at most one page), corrects PA-04, PA-05 and PA-07 cards if the measurements require it, and confirms or revises the thresholds PA-09 will use.
- **CP-B** (after PA-10): the lead completes PA-09 into a ready card; the manager runs the anticipation pass and sends a five-line digest.

## 10. Risks (pre-registered)

| Risk | Observation | Read by | If bad | Decides |
|---|---|---|---|---|
| K1 #369 is a real divergence | torch above 10 times the larger floor on any leg | PA-01 report | advisor consult; the case stays red; Q3 options B or C | owner |
| K2 the macos-26 runner has no MPS | `-rs` shows the MPS cases skipped | PA-01 or PA-03 | Tier B on MPS runs locally only (this machine has MPS); the record says so | lead |
| K3 Tier C not attained on the bundled sample | PA-03's weekly run | 2026-11-21 | R5: issue, xfail strict, docs row; E1 stays informational | lead |
| K4 a real MPS OOM cannot be produced | PA-05's stop condition | PA-05 report | the OOM proof moves to PA-07's CUDA case only | lead |
| K5 the account's weekly usage limit | a refused dispatch or a usage-limit message | every tick | write the board, wait once for the reset, resume; never raise a budget | owner |
| K6 the two programs collide in the board worktree | `index.lock` on commit | every tick | retry once after 10 seconds; commit only this pack's paths | manager |
| K7 CUDA is not bit-reproducible run to run | PA-07's D1 line | when the owner runs PA-07 | the docs and NEMAR's plan stop claiming CUDA bit reproducibility (patch note to NEMAR) | owner |

## 11. Owner questions

Q1 (merge authority), Q2 (`converged_`), Q3 (#369 noise model): `START.md`, recorded on the board.

## Appendix A: the epic issue (posted by the manager at Setup)

Title: `Epic: same-seed parity with the Fortran reference, and reproducible run records`

```text
Goal: PyTorch (CPU, CUDA) and the Apple GPU paths (MPS, MLX) match the Fortran binary pAMICA ships, started from the same seed, wherever the arithmetic allows, with every tier stated and pre-registered.
"Same seed" means the same start: pAMICA's seed defines a starting state, and the binary is started from that state through its load_* inputs.
Tiers: first-iteration log-likelihood within 1e-12 and near-exact agreement after 100 iterations (float64); float32 consistency after 100 iterations (MPS, MLX); near-exact or distributional agreement after 2000 Newton iterations; bit-identical refits within one engine and thread count.
Work items:
- [ ] Fortran parity checks on every pull request, green (#369)
- [ ] Shared start and thread count for AMICANative (#358)
- [ ] Same-seed parity gates per backend; shared start in the harness (#359)
- [ ] did_converge_ and allocation failures that propagate unchanged
- [ ] RUNAMICA15 settings, run_record(), determinism tests
- [ ] Follow-up issues: mixture locations for n_mix other than 3; fix_init; full-rank shared start
Consumer: eegprep's pop_runica(icatype='pamica') and NEMAR's ICA recipe, which record the exact pamica pipeline.
```

## Appendix B: "parity not attained" issue template

Title: `Parity tier <tier> not attained for <backend>`

```text
Measured on <date> by <workflow run URL or "owner run on a Linux workstation with an NVIDIA GPU">, pamica commit <sha>, binary <asset name> SHA-256 <hex>.
Setting: bundled sample (32 channels, 30504 samples), shared start (AMICANative start="pamica"), seed <s>, <iterations> iterations, the bundled input.param settings, binary on one thread, keep_best=False.
Pre-registered thresholds (nemar parity plan, tier <tier>): <thresholds>.
Measured: LL difference <x>; minimum matched correlation <y>; median <z>; Amari distance <w>.
Approaches tried (at most two): <one line each>.
Reading: <one sentence, for example "round-off amplification over 2000 Newton iterations on under-determined components at about 30 samples per squared channel">.
Effect for users: <one sentence from the plan's section 6>.
The test is marked xfail(strict=True) with this issue, so a fix makes it fail loudly.
```
