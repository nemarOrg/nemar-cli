"""Hungarian-matched |cos| of unmixing rows (sensor space, U = W S) between anchor npz files.

usage: compare.py a.npz b.npz [c.npz ...]   -> pairwise table (mean, min, share above 0.95)
"""
import itertools
import json
import sys

import numpy as np
from scipy.optimize import linear_sum_assignment


def unmix(path):
    z = np.load(path)
    W = z["W"]
    if W.ndim == 3:
        W = W[:, :, 0]
    U = W @ z["S"]
    U = U / np.linalg.norm(U, axis=1, keepdims=True)
    return U, json.loads(str(z["meta"]))


def match(U1, U2):
    C = np.abs(U1 @ U2.T)
    r, c = linear_sum_assignment(-C)
    return C[r, c]


paths = sys.argv[1:]
mods = [unmix(p) for p in paths]
for p, (_, m) in zip(paths, mods):
    print(f"{p.split('/')[-1]}: {m['backend']} {m['device']} {m['dtype']} thr={m['threads']} n={m['samples']} off={m['offset']} "
          f"seed={m['seed']} wall={m['wall_s']}s iters={m['n_iter']} stop={m['stop_reason']} LL={m['final_ll']}")
print()
for (i, (U1, _)), (j, (U2, _)) in itertools.combinations(enumerate(mods), 2):
    if U1.shape != U2.shape:
        print(i, j, "shape mismatch", U1.shape, U2.shape)
        continue
    d = match(U1, U2)
    print(f"{paths[i].split('/')[-1]} vs {paths[j].split('/')[-1]}: mean {d.mean():.4f} min {d.min():.4f} share>0.95 {np.mean(d>0.95):.2f} share>0.99 {np.mean(d>0.99):.2f}")
