"""One full-length AMICA fit on the real ds002718 recording; saves the state for equivalence checks.

Saves npz with W, S, mean, c (model 0), the LL history and a JSON meta string. Early stops stay at the
library defaults so the run reports the natural stop_reason (a production run would).
"""
import argparse
import json
import os
import platform
import sys
import time

import numpy as np

p = argparse.ArgumentParser()
p.add_argument("--backend", choices=["torch", "native"], required=True)
p.add_argument("--device", default="cpu")
p.add_argument("--dtype", choices=["f64", "f32"], default="f64")
p.add_argument("--threads", type=int, default=0)
p.add_argument("--block-size", type=int, default=131072)
p.add_argument("--data", required=True)
p.add_argument("--channels", type=int, default=70)
p.add_argument("--offset", type=int, default=0)
p.add_argument("--samples", type=int, default=747750)
p.add_argument("--native-block", type=int, default=512, help="Fortran block per thread")
p.add_argument("--max-iter", type=int, default=2000)
p.add_argument("--seed", type=int, default=42)
p.add_argument("--out", required=True)
a = p.parse_args()

X = np.load(a.data)[: a.channels, a.offset : a.offset + a.samples].astype(np.float64)
meta = {k: v for k, v in vars(a).items()}
meta.update(host=platform.node(), slurm_job=os.environ.get("SLURM_JOB_ID"), shape=list(X.shape))
real_stdout, sys.stdout = sys.stdout, sys.stderr

t0 = time.perf_counter()
if a.backend == "torch":
    import torch
    import pamica

    if a.threads > 0:
        torch.set_num_threads(a.threads)
    dtype = torch.float32 if a.dtype == "f32" else torch.float64
    m = pamica.AMICA(n_models=1, n_mix=3, device=a.device, verbose=False)
    m.fit(X, max_iter=a.max_iter, seed=a.seed, dtype=dtype, block_size=a.block_size, do_newton=False)
    if a.device == "cuda":
        torch.cuda.synchronize()
    wall = time.perf_counter() - t0
    W, S, mean, c = m.get_unmixing_matrix(), m.get_sphere(), m.get_mean(), m.get_model_center()
    ll = np.asarray(m.ll_history_, dtype=np.float64)
    meta.update(torch=torch.__version__, pamica=pamica.__version__, stop_reason=m.stop_reason_,
                final_ll=float(m.final_ll_), n_iter=len(ll),
                gpu=(torch.cuda.get_device_name(0) if a.device == "cuda" else None))
else:
    import pamica
    from pamica.native import AMICANative

    thr = max(a.threads, 1)
    m = AMICANative(threads=thr, max_threads=thr, max_iter=a.max_iter, n_models=1, n_mix=3, pdftype=0,
                    do_newton=0, write_LLt=0, do_history=0, seed=a.seed,
                    block_size=a.native_block)
    m.fit(X)
    wall = time.perf_counter() - t0
    o = m.output_
    W, S, mean, c = o.W[:, :, 0], o.S, o.data_mean, o.c
    ll = np.asarray(o.LL, dtype=np.float64)
    meta.update(pamica=pamica.__version__, binary=os.environ.get("PAMICA_NATIVE_BINARY"),
                n_iter=int(len(ll)), final_ll=float(ll[-1]) if len(ll) else None, stop_reason="native")
meta["wall_s"] = round(wall, 2)
np.savez(a.out, W=np.asarray(W), S=np.asarray(S), mean=np.asarray(mean), c=np.asarray(c), ll=ll,
         meta=json.dumps(meta))
sys.stdout = real_stdout
print(json.dumps({k: meta[k] for k in ("backend", "device", "dtype", "threads", "samples", "offset", "seed",
                                       "wall_s", "n_iter", "stop_reason", "final_ll")}))
