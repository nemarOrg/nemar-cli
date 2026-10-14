"""Map-space and activation-space comparison of anchor decompositions (run locally)."""
import itertools, json, sys
import numpy as np
from scipy.optimize import linear_sum_assignment

X = np.load("ds002718_full.npy")  # (70, 747750)
Xs = X[:, 100000:400000]          # common 300k-sample test slice
def load(path):
    z = np.load(path); W = z["W"]; W = W[:, :, 0] if W.ndim == 3 else W
    U = W @ z["S"]; mean = z["mean"]; m = json.loads(str(z["meta"]))
    return U, mean, m
def maps(U):
    A = np.linalg.pinv(U); A = A / np.linalg.norm(A, axis=0, keepdims=True); return A
def acts(U, mean, X):
    Y = U @ (X - mean[:, None]); Y -= Y.mean(1, keepdims=True); return Y / np.linalg.norm(Y, axis=1, keepdims=True)
def hung(C):
    C = np.abs(C); r, c = linear_sum_assignment(-C); return C[r, c]
paths = sys.argv[1:]
M = [load(p) for p in paths]
name = lambda p: p.split("/")[-1].replace(".npz", "")
for (i, (Ui, mi, _)), (j, (Uj, mj, _)) in itertools.combinations(enumerate(M), 2):
    dm = hung(maps(Ui).T @ maps(Uj))
    Yi, Yj = acts(Ui, mi, Xs), acts(Uj, mj, Xs)
    da = hung(Yi @ Yj.T)
    print(f"{name(paths[i])} vs {name(paths[j])}: MAPS mean {dm.mean():.3f} share>0.95 {np.mean(dm>0.95):.2f} | ACTIVATIONS mean {da.mean():.3f} share>0.95 {np.mean(da>0.95):.2f} share>0.8 {np.mean(da>0.8):.2f}")
