"""Run probe.py configurations inside ONE batch job, inside a wall-clock budget.

  drive.py grid --plan gpu --budget-min 22 --out results/gpu_grid.jsonl
  drive.py grid --plan cpu --budget-min 22 --out results/cpu_scale.jsonl
  drive.py pack --device cuda --counts 1,2,3,4,6 --channels 64 --samples 300000 --out ...
  drive.py pack --device cpu  --counts 1,16,64,128 --backend torch|native ...

Every probe is its own process. Configs run in priority order, so hitting the budget
drops the least useful points; the point that did not run is logged as 'skipped'.
Never run on a login node: it refuses unless SLURM_JOB_ID is set.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROBE = HERE / "probe.py"


def need_slurm():
    if not os.environ.get("SLURM_JOB_ID"):
        sys.exit("refusing to run outside a Slurm job (no login-node compute)")


def run_probe(py, args, timeout):
    cmd = [py, "-I", str(PROBE), *map(str, args)]
    t = time.time()
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"error": "timeout", "args": args, "wall_s": round(time.time() - t, 1)}
    out = r.stdout.strip().splitlines()
    if r.returncode != 0 or not out:
        return {"error": f"rc={r.returncode}", "args": args, "stderr_tail": r.stderr[-600:]}
    rec = json.loads(out[-1])
    rec["probe_wall_s"] = round(time.time() - t, 1)
    return rec


def iters_for(c, n):
    work = c * n
    return (5, 15) if work > 30e6 else (10, 30)


def gpu_plan(data):
    P = []
    # defaults first: the 8192-sample block, f64 and f32
    for ch in (64, 128):
        for dt in ("f64", "f32"):
            P.append(("cuda", dt, ch, 75_000, 8192))
    for ch in (32, 64, 128, 256):
        for bs in (512, 2048, 8192, 32768):
            P.append(("cuda", "f64", ch, 75_000, bs))
    for ch in (32, 64, 128, 256):
        for bs in (2048, 8192, 32768):
            P.append(("cuda", "f32", ch, 75_000, bs))
    for ch in (64, 128):
        for n in (300_000, 900_000):
            for bs in (8192, 32768):
                P.append(("cuda", "f64", ch, n, bs))
    P.append(("cuda", "f32", 64, 900_000, 32768))
    P.append(("cuda", "f64", 256, 300_000, 32768))
    if data and Path(data).exists():
        P.append(("cuda", "f64", 70, 60_000, 8192, data))
    return P


def gpu2_plan(data):
    """Second GPU stage: larger blocks (up to the whole recording) and the published
    70-channel, 747,750-frame configuration that pamica's own 4090 benchmark used."""
    P = []
    if data and Path(data).exists():
        for dt in ("f64", "f32"):
            for bs in (32768, 131072, 747750):
                P.append(("cuda", dt, 70, 747750, bs, data))
    for dt in ("f64", "f32"):
        for ch, n in ((64, 300_000), (64, 900_000), (128, 300_000), (128, 900_000)):
            for bs in (65536, 131072, 262144, n):
                P.append(("cuda", dt, ch, n, bs))
    return P


def key_plan(data):
    """Key points only (large blocks), for cross-device comparison on a new GPU type."""
    P = []
    for dt in ("f64", "f32"):
        for ch, n in ((64, 75_000), (64, 300_000), (64, 900_000), (128, 900_000), (256, 300_000)):
            P.append(("cuda", dt, ch, n, 131072))
        if data and Path(data).exists():
            P.append(("cuda", dt, 70, 747750, 131072, data))
    return P


def cpu_plan(data):
    P = []
    for thr in (1, 2, 4, 8, 16, 32, 64, 120):
        P.append(("native", thr, 64, 75_000))
        P.append(("torch", thr, 64, 75_000))
    for thr in (1, 16, 120):
        P.append(("native", thr, 128, 75_000))
        P.append(("torch", thr, 128, 75_000))
    return P


def cpunat_plan(data):
    """Native Fortran only, small enough for the debug partition (torch-CPU rows already exist)."""
    P = [("native", thr, 64, 75_000) for thr in (1, 4, 8, 16, 32)]
    P.append(("native", 16, 128, 75_000))
    return P


def cmd_grid(a):
    need_slurm()
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    budget = a.budget_min * 60
    plan = {"gpu": gpu_plan, "gpu2": gpu2_plan, "key": key_plan, "cpu": cpu_plan, "cpunat": cpunat_plan}[a.plan](a.data)
    with out.open("a") as f:
        for item in plan:
            left = budget - (time.time() - t0)
            if left < 60:
                f.write(json.dumps({"skipped": list(item), "reason": "budget"}) + "\n")
                f.flush()
                continue
            if a.plan in ("gpu", "gpu2", "key"):
                dev, dt, ch, n, bs, *rest = item
                ia, ib = iters_for(ch, n)
                args = ["--backend", "torch", "--device", dev, "--dtype", dt, "--channels", ch,
                        "--samples", n, "--block-size", bs, "--threads", 4,
                        "--iters-a", ia, "--iters-b", ib, "--tag", a.plan]
                if rest:
                    args += ["--data", rest[0]]
            else:
                be, thr, ch, n = item
                ia, ib = (5, 15) if be == "torch" and thr == 1 else (10, 30)
                args = ["--backend", be, "--device", "cpu", "--dtype", "f64", "--channels", ch,
                        "--samples", n, "--block-size", 8192, "--threads", thr,
                        "--iters-a", ia, "--iters-b", ib, "--tag", a.plan]
            rec = run_probe(a.python, args, timeout=min(left - 20, 420))
            f.write(json.dumps(rec) + "\n")
            f.flush()
            print(rec.get("s_per_iter", rec.get("error")), item, flush=True)


def cmd_pack(a):
    need_slurm()
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    budget = a.budget_min * 60
    with out.open("a") as f:
        for n_proc in map(int, a.counts.split(",")):
            if budget - (time.time() - t0) < 120:
                f.write(json.dumps({"skipped_count": n_proc, "reason": "budget"}) + "\n")
                continue
            base = ["--backend", a.backend, "--device", a.device, "--dtype", a.dtype,
                    "--channels", a.channels, "--samples", a.samples, "--block-size", a.block_size,
                    "--threads", a.threads, "--iters-a", a.iters_a, "--iters-b", a.iters_b,
                    "--tag", f"pack{n_proc}"]
            t = time.time()
            procs = [
                subprocess.Popen([a.python, "-I", str(PROBE), *map(str, base)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                for _ in range(n_proc)
            ]
            recs = []
            for p in procs:
                o, e = p.communicate(timeout=max(60, budget - (time.time() - t0)))
                lines = o.strip().splitlines()
                recs.append(json.loads(lines[-1]) if p.returncode == 0 and lines else {"error": e[-300:]})
            wall = time.time() - t
            good = [r for r in recs if "s_per_iter" in r]
            slopes = sorted(r["s_per_iter"] for r in good)
            agg = sum(1.0 / s for s in slopes) if slopes else None
            rec = {
                "n_procs": n_proc, "ok": len(good), "wall_s": round(wall, 1),
                "slope_min": slopes[0] if slopes else None,
                "slope_median": slopes[len(slopes) // 2] if slopes else None,
                "slope_max": slopes[-1] if slopes else None,
                "aggregate_iters_per_s": round(agg, 3) if agg else None,
                "config": {k: v for k, v in zip(base[::2], base[1::2])},
                "gpu_peak_alloc_mib": [r.get("gpu_peak_alloc_mib") for r in good][:8],
                "full_length_all": all(r.get("full_length") for r in good),
            }
            f.write(json.dumps(rec) + "\n")
            f.flush()
            print(rec, flush=True)


def main():
    p = argparse.ArgumentParser()
    sp = p.add_subparsers(dest="cmd", required=True)
    g = sp.add_parser("grid")
    g.add_argument("--plan", choices=["gpu", "gpu2", "key", "cpu", "cpunat"], required=True)
    g.add_argument("--python", default=sys.executable)
    g.add_argument("--budget-min", type=float, default=22)
    g.add_argument("--data", default=None)
    g.add_argument("--out", required=True)
    k = sp.add_parser("pack")
    k.add_argument("--python", default=sys.executable)
    k.add_argument("--backend", default="torch")
    k.add_argument("--device", default="cuda")
    k.add_argument("--dtype", default="f64")
    k.add_argument("--counts", required=True)
    k.add_argument("--channels", type=int, default=64)
    k.add_argument("--samples", type=int, default=300_000)
    k.add_argument("--block-size", type=int, default=8192)
    k.add_argument("--threads", type=int, default=2)
    k.add_argument("--iters-a", type=int, default=10)
    k.add_argument("--iters-b", type=int, default=40)
    k.add_argument("--budget-min", type=float, default=22)
    k.add_argument("--out", required=True)
    a = p.parse_args()
    {"grid": cmd_grid, "pack": cmd_pack}[a.cmd](a)


if __name__ == "__main__":
    main()
