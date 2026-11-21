"""Union counts across classes (no network). Run: uv run --no-project python -I union.py"""
import json
from pathlib import Path
H = Path(__file__).resolve().parent
c = json.loads((H / "classes.json").read_text())["classes"]
api = {d["dataset_id"]: d for d in json.loads((H / "api-catalog.json").read_text())["datasets"]}
def dsset(*names): return set().union(*[set(c[n]["by_dataset"]) for n in names])
def rec(*names): return sum(c[n]["recordings"] for n in names)
def st(*names): return sum(c[n]["stores_in_serving_index"] for n in names)
out = {}
for label, names in {
    "real_discontinuity": ("edfd_real_gap", "bv_multi_dated-with-gap", "fif_skip"),
    "can_be_discontinuous": ("edfd_header", "bv_multi_segment", "fif_skip"),
}.items():
    ds = dsset(*names)
    out[label] = {"recordings": rec(*names), "datasets": len(ds),
                  "stores_in_serving_index": st(*names),
                  "dataset_stores_total": sum(api[d]["zarr_store_count"] or 0 for d in ds),
                  "classes": {n: {"recordings": c[n]["recordings"], "datasets": len(c[n]["by_dataset"]),
                                  "stores_in_serving_index": c[n]["stores_in_serving_index"]} for n in names}}
    out[label]["licenses"] = {}
    for d in ds:
        out[label]["licenses"][api[d]["license"]] = out[label]["licenses"].get(api[d]["license"], 0) + 1
Path(H / "union.json").write_text(json.dumps(out, indent=1, sort_keys=True) + "\n")
print(json.dumps(out, indent=1, sort_keys=True))
