"""One AMICA timing probe per process (clean GPU state, per-process peak memory).

Per-iteration cost is the slope between two fits of different length
(t_b - t_a) / (b - a), so data upload, sphering, kernel compilation and (for the
native binary) process start and file I/O drop out. A warm-up fit comes first.
Prints one JSON line on stdout; everything else goes to stderr.

Backends:
  torch   pamica.AMICA, device cpu|cuda, dtype f64|f32
  native  pamica.native.AMICANative (the Fortran reference, single process, OpenMP)
"""

import argparse
import json
import os
import platform
import resource
import sys
import time


def make_data(n_channels, n_samples, seed=7):
    import numpy as np

    rng = np.random.default_rng(seed)
    src = rng.laplace(size=(n_channels, n_samples))
    src[: n_channels // 4] = rng.standard_t(df=4, size=(n_channels // 4, n_samples))
    src *= rng.uniform(0.5, 3.0, size=(n_channels, 1))
    A = rng.standard_normal((n_channels, n_channels))
    X = A @ src
    X += 0.01 * X.std() * rng.standard_normal(X.shape)
    return X.astype(np.float64)


def rss_mb():
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round((r if platform.system() == "Darwin" else r * 1024) / 2**20, 1)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--backend", choices=["torch", "native"], required=True)
    p.add_argument("--device", default="cpu")
    p.add_argument("--dtype", choices=["f64", "f32"], default="f64")
    p.add_argument("--channels", type=int, required=True)
    p.add_argument("--samples", type=int, required=True)
    p.add_argument("--block-size", type=int, default=8192)
    p.add_argument("--threads", type=int, default=0)
    p.add_argument("--iters-a", type=int, default=20)
    p.add_argument("--iters-b", type=int, default=60)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--data", default=None, help=".npy (channels, samples); overrides synthetic")
    p.add_argument("--native-block", type=int, default=512,
                   help="native binary block size PER THREAD (pamica benchmarks use 512)")
    p.add_argument("--tag", default="")
    a = p.parse_args()

    import numpy as np

    if a.data:
        X = np.load(a.data)[: a.channels, : a.samples].astype(np.float64)
    else:
        X = make_data(a.channels, a.samples)

    rec = {
        "tag": a.tag, "backend": a.backend, "device": a.device, "dtype": a.dtype,
        "channels": a.channels, "samples": a.samples, "block_size": a.block_size,
        "threads": a.threads, "native_block": a.native_block, "iters_a": a.iters_a, "iters_b": a.iters_b,
        "host": platform.node(), "python": platform.python_version(),
        "slurm_job": os.environ.get("SLURM_JOB_ID"),
    }
    real_stdout, sys.stdout = sys.stdout, sys.stderr

    if a.backend == "torch":
        import torch
        import pamica

        if a.threads > 0:
            torch.set_num_threads(a.threads)
        dtype = torch.float32 if a.dtype == "f32" else torch.float64
        rec.update(torch=torch.__version__, pamica=pamica.__version__, cuda=torch.version.cuda)
        if a.device == "cuda":
            rec["gpu"] = torch.cuda.get_device_name(0)
            rec["capability"] = list(torch.cuda.get_device_capability(0))

        def fit(k):
            m = pamica.AMICA(n_models=1, n_mix=3, device=a.device, verbose=False)
            t = time.perf_counter()
            m.fit(X, max_iter=k, seed=a.seed, dtype=dtype, block_size=a.block_size,
                  use_min_dll=False, use_grad_norm=False, do_newton=False)
            if a.device == "cuda":
                torch.cuda.synchronize()
            wall = time.perf_counter() - t
            return wall, len(m.ll_history_), m.stop_reason_

        fit(5)
        if a.device == "cuda":
            torch.cuda.reset_peak_memory_stats()
        ta, na, sa = fit(a.iters_a)
        tb, nb, sb = fit(a.iters_b)
        if a.device == "cuda":
            rec["gpu_peak_alloc_mib"] = round(torch.cuda.max_memory_allocated() / 2**20, 1)
            rec["gpu_peak_reserved_mib"] = round(torch.cuda.max_memory_reserved() / 2**20, 1)
    else:
        import pamica
        from pamica.native import AMICANative

        rec.update(pamica=pamica.__version__, binary=os.environ.get("PAMICA_NATIVE_BINARY"))
        thr = max(a.threads, 1)

        def fit(k):
            m = AMICANative(threads=thr, max_threads=thr, max_iter=k, n_models=1, n_mix=3,
                            pdftype=0, do_newton=0, use_min_dll=0, use_grad_norm=0,
                            write_LLt=0, do_history=0, seed=a.seed,
                            block_size=a.native_block)
            t = time.perf_counter()
            m.fit(X)
            return time.perf_counter() - t, k, "native"

        fit(3)
        ta, na, sa = fit(a.iters_a)
        tb, nb, sb = fit(a.iters_b)

    slope = (tb - ta) / (a.iters_b - a.iters_a)
    rec.update(
        t_a_s=round(ta, 3), t_b_s=round(tb, 3), iters_run_a=na, iters_run_b=nb,
        stop_a=sa, stop_b=sb, s_per_iter=round(slope, 5),
        fixed_overhead_s=round(ta - a.iters_a * slope, 3), peak_rss_mb=rss_mb(),
        full_length=(na == a.iters_a and nb == a.iters_b),
    )
    sys.stdout = real_stdout
    print(json.dumps(rec))


if __name__ == "__main__":
    main()
