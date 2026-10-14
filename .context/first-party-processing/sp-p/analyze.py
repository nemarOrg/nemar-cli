"""Summarize SP-P result files (run locally on rsynced results; no Expanse access).

usage: analyze.py results_dir
"""
import glob
import json
import sys
from collections import defaultdict
from pathlib import Path

d = Path(sys.argv[1])


def load(pattern):
    rows = []
    for f in sorted(glob.glob(str(d / pattern))):
        for line in open(f):
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def ok(r):
    return "s_per_iter" in r and r.get("full_length")


print("== GPU grid: s/iter (peak alloc MiB)  rows=channels x samples, cols=block size")
g = [r for r in load("gpu_grid_*.jsonl") if ok(r)]
bad = [r for r in load("gpu_grid_*.jsonl") if not ok(r) and "skipped" not in r]
skipped = [r for r in load("gpu_grid_*.jsonl") if "skipped" in r]
tab = defaultdict(dict)
for r in g:
    tab[(r["dtype"], r["channels"], r["samples"])][r["block_size"]] = (r["s_per_iter"], r.get("gpu_peak_alloc_mib"))
for key in sorted(tab):
    cells = "  ".join(f"b{b}: {v[0]:.4f} ({v[1]:.0f})" for b, v in sorted(tab[key].items()))
    best = min(tab[key].items(), key=lambda kv: kv[1][0])
    print(f"{key[0]} {key[1]:>3}ch x {key[2]:>7}: {cells}   best b{best[0]}")
print(f"voided/failed: {len(bad)}; skipped for budget: {len(skipped)}")

print("\n== GPU concurrency (aggregate iterations/s)")
for r in load("gpu_pack_*.jsonl"):
    if "n_procs" in r:
        c = r["config"]
        print(f"{c.get('--dtype')} N={r['n_procs']}: ok={r['ok']} agg={r['aggregate_iters_per_s']} it/s  "
              f"slope min/med/max={r['slope_min']}/{r['slope_median']}/{r['slope_max']}  wall={r['wall_s']}s  mem={r['gpu_peak_alloc_mib'][:1]}")

print("\n== CPU thread scaling (s/iter) 64ch x 75k unless noted")
c = defaultdict(dict)
for r in load("cpu_scale_*.jsonl"):
    if ok(r):
        c[(r["backend"], r["channels"])][r["threads"]] = r["s_per_iter"]
for key in sorted(c):
    print(key, "  ".join(f"t{t}: {v:.4f}" for t, v in sorted(c[key].items())))
print("\n== CPU packing")
for r in load("cpu_pack_*.jsonl"):
    if "n_procs" in r:
        c2 = r["config"]
        print(f"{c2.get('--backend')} P={r['n_procs']}: ok={r['ok']} agg={r['aggregate_iters_per_s']} it/s  slope med={r['slope_median']} max={r['slope_max']}")
