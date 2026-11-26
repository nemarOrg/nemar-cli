"""Union counts across classes and projection days (no network).
Run: uv run --no-project python -I union.py   (reads classes.json, api-catalog.json, throughput.json,
fif-coverage.json, brainvision-summary.json, listing-census.json, all in this directory)

Every row is MEASURED ONLY: sources the scan could not read are listed in `not_measured`, not in the rows.
"""
import json
from pathlib import Path

H = Path(__file__).resolve().parent
L = lambda n: json.loads((H / n).read_text())  # noqa: E731
c = L("classes.json")["classes"]
api = {d["dataset_id"]: d for d in L("api-catalog.json")["datasets"]}
thr = L("throughput.json")
fifc = L("fif-coverage.json")
bvs = L("brainvision-summary.json")
census = L("listing-census.json")["per_dataset_counts"]

RATES = {
    "mean_30_day": thr["stores_per_day_over_30_complete_days"]["mean"],
    "p90_all_days": thr["stores_per_day_over_30_complete_days"]["p90_linear"],
    "median_active_days": thr["stores_per_day_on_days_with_conversions"]["median"],
}
SCOPES = {
    "real_discontinuity_all": ("edfd_real_gap", "bv_multi_dated-with-gap", "fif_skip"),
    "real_discontinuity_positive_total_only": ("edfd_real_gap", "bv_gap_positive_total", "fif_skip"),
    "can_be_discontinuous_all": ("edfd_header", "bv_multi_segment", "fif_skip"),
    "can_be_discontinuous_without_known_non_gaps": (
        "edfd_real_gap", "bv_multi_dated-with-gap", "bv_multi_undated", "bv_multi_partly-dated", "fif_skip"),
}
NOTES = {
    "real_discontinuity_all": "EDF+D with gap_count above 0, BrainVision dated with a gap (includes 36 recordings whose total is negative), FIF with a skip",
    "real_discontinuity_positive_total_only": "as above without the 36 BrainVision recordings whose total gap is negative (overlap or out of order)",
    "can_be_discontinuous_all": "includes 1,626 EDF+D files measured gapless, 3 dated-contiguous and 86 epoched (MARKERBASED) BrainVision recordings, and the 528 undated multi-segment recordings, which cannot be tested from the markers",
    "can_be_discontinuous_without_known_non_gaps": "drops the 1,626 gapless EDF+D files and the 3 dated-contiguous and 86 epoched BrainVision recordings; keeps the 528 undated and 1 partly dated (not testable)",
}


def days(stores):
    return {k: round(stores / r, 2) for k, r in RATES.items()}


out = {"rates_stores_per_day": RATES, "scopes": {}}
for label, names in SCOPES.items():
    ds = set().union(*[set(c[n]["by_dataset"]) for n in names])
    stores = sum(c[n]["stores_in_serving_index"] for n in names)
    all_stores = sum(api[d]["zarr_store_count"] or 0 for d in ds)
    lic = {}
    for d in ds:
        lic[api[d]["license"]] = lic.get(api[d]["license"], 0) + 1
    out["scopes"][label] = {
        "measured_only": True, "note": NOTES[label],
        "recordings": sum(c[n]["recordings"] for n in names), "datasets": len(ds),
        "stores_in_serving_index": stores, "all_stores_of_those_datasets": all_stores,
        "days_to_reconvert_stores_in_serving_index": days(stores),
        "days_to_reconvert_all_stores_of_those_datasets": days(all_stores),
        "classes": {n: {"recordings": c[n]["recordings"], "datasets": len(c[n]["by_dataset"]),
                        "stores_in_serving_index": c[n]["stores_in_serving_index"]} for n in names},
        "licenses": lic,
    }
fifgz = {ds: v["fif.gz"] for ds, v in census.items() if v["fif.gz"]}
out["not_measured"] = {
    "fif_without_usable_directory_unmeasured": fifc["unmeasured"],
    "fif_unreadable": fifc["failed"],
    "fif_measured": fifc["measured_total"],
    "fif_gz_files": sum(fifgz.values()), "fif_gz_datasets": len(fifgz),
    "bv_vmrk_not_in_listing": bvs["segment_markers"]["no-vmrk-in-listing"],
    "bv_vmrk_unreadable": bvs["segment_markers"]["FAILED RuntimeError"],
    "other_formats_not_scanned_files": {k: sum(v[k] for v in census.values()) for k in ("gdf", "xdf", "set", "cnt")},
    "meaning": "FIF, and BrainVision to a small extent, are LOWER BOUNDS; every scope above is measured only",
}
out["all_stores"] = {"stores": sum(d["zarr_store_count"] or 0 for d in api.values()),
                     "days_to_reconvert": days(sum(d["zarr_store_count"] or 0 for d in api.values()))}
(H / "union.json").write_text(json.dumps(out, indent=1, sort_keys=True) + "\n")
print(json.dumps(out, indent=1, sort_keys=True))
