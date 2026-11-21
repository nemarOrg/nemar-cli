"""Derive the card S1 numbers from the finished scan cache and the other outputs (no network).

Run: uv run --no-project python -I derive.py STAGE [--work DIR]
  scan     tallies, failures and the +D deep results, from cache.json (written by scan.py)
  zarr     join the +D deep results (and the other classes) with the zarr store indexes
  classes  the per-class table: recordings, stores, datasets, licenses
  bvstats  BrainVision gap statistics (percentiles by linear interpolation), signed and absolute sums
  fifstats FIF coverage: pool, sample, datasets, edge cases (reads fif.jsonl in the work directory)
  extras   largest EDF+D file, the .vmrk-missing cases (reads files-index.json in the work directory)
"""

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORK = Path("/Users/yahya/.cache/nemar-s1-scan")
WHOLE_FILE_LIMIT = 12_000_000


def jdump(obj, path):
    Path(path).write_text(json.dumps(obj, indent=1, sort_keys=True) + "\n")


def jload(path):
    return json.loads(Path(path).read_text())


def license_of(ds, api):
    return api.get(ds, {}).get("license")


def stage_scan():
    d = jload(WORK / "cache.json")
    api = {x["dataset_id"]: x for x in jload(HERE / "api-catalog.json")["datasets"]}
    cat = {x["id"]: x for x in d["catalog"]["datasets"]}
    heads, deep = d["heads"], d["deep"]
    public = [x for x in d["catalog"]["datasets"] if x["visibility"] == "public"]

    # files per dataset/version that the cache lists
    listed = {}
    for key, m in d["manifests"].items():
        ds, ver = key.split("/", 1)
        if m.get("ok") and cat.get(ds, {}).get("version") == ver:
            listed[ds] = m
    unlisted = sorted(x["id"] for x in public if x["id"] not in listed)

    by_cat = Counter()
    by_ext_cat = Counter()
    per_ds = defaultdict(Counter)
    failed = []
    unread = 0
    for ds, m in listed.items():
        for e in m["entries"]:
            h = heads.get(f"{ds}/{cat[ds]['version']}/{e['path']}")
            ext = e["path"].lower()[-3:]
            if h is None:
                unread += 1
            elif not h.get("ok"):
                failed.append({"ds": ds, "path": e["path"], "reason": h.get("reason")})
            else:
                by_cat[h["cat"]] += 1
                by_ext_cat[f"{ext}:{h['cat']}"] += 1
                per_ds[ds][f"{ext}:{h['cat']}"] += 1
    tally = {
        "datasets_in_catalog": len(d["catalog"]["datasets"]),
        "datasets_public": len(public),
        "datasets_listed": len(listed),
        "datasets_not_listed": unlisted,
        "datasets_not_listed_reason": {u: d["manifests"].get(f"{u}/-", {}).get("reason") for u in unlisted},
        "manifest_sources": dict(Counter(m["source"] for m in listed.values())),
        "datasets_with_edf_or_bdf": sum(1 for ds in listed if listed[ds]["entries"]),
        "edf_bdf_files_listed": sum(len(m["entries"]) for m in listed.values()),
        "headers_read_ok": sum(by_cat.values()),
        "headers_failed": len(failed),
        "headers_unread": unread,
        "by_header_type": dict(by_cat),
        "by_extension_and_header_type": dict(by_ext_cat),
        "datasets_per_header_type": {
            c: sum(1 for ds in per_ds if any(k.endswith(":" + c) for k in per_ds[ds]))
            for c in sorted(by_cat)},
        "edf_files": sum(v for k, v in by_ext_cat.items() if k.startswith("edf:")),
        "bdf_files": sum(v for k, v in by_ext_cat.items() if k.startswith("bdf:")),
    }
    jdump(tally, HERE / "heads-tally.json")
    jdump({"headers_failed": len(failed), "failed": failed,
           "manifest_failures": {k: m for k, m in d["manifests"].items() if not m.get("ok")}},
          HERE / "heads-failures.json")
    jdump({ds: {k: v for k, v in sorted(c.items())} for ds, c in sorted(per_ds.items())},
          HERE / "per-dataset-header-counts.json")

    # the deep pass over +D files
    files = []
    for key, r in sorted(deep.items()):
        ds, ver, path = key.split("/", 2)
        h = heads[key]
        files.append({
            "ds": ds, "path": path, "cat": h["cat"], "ok": r.get("ok"), "reason": r.get("reason"),
            "size": r.get("size"), "mode": r.get("mode"), "nrec": r.get("nrec"),
            "nrec_header": r.get("nrec_header"), "rec_dur": r.get("rec_dur"),
            "gap_count": r.get("gap_count"), "gap_total_s": r.get("gap_total_s"),
            "gap_pos_s": r.get("gap_pos_s"), "gap_neg_count": r.get("gap_neg_count"),
            "unparsed_onsets": r.get("unparsed_onsets"), "truncated": r.get("truncated"),
            "file_short": r.get("file_short"), "size_matches": r.get("size_matches"),
            "first_onset": r.get("first_onset"), "last_onset": r.get("last_onset"),
            "first_gaps": r.get("first_gaps"),
        })
    jdump(files, HERE / "deep-edfd-files.json")

    todo_headers = sum(1 for key, h in heads.items() if not h.get("ok"))
    todo_deep = sum(1 for key, h in heads.items()
                    if h.get("ok") and h["cat"] in ("EDF+D", "BDF+D")
                    and not deep.get(key, {}).get("ok"))
    whole = [f for f in files if f["size"] is not None and f["size"] <= WHOLE_FILE_LIMIT]
    big = [f for f in files if f["size"] is None or f["size"] > WHOLE_FILE_LIMIT]
    per = defaultdict(lambda: Counter())
    for f in files:
        c = per[f["ds"]]
        c["files"] += 1
        c["files_with_gap"] += 1 if (f["gap_count"] or 0) > 0 else 0
        c["gap_count"] += f["gap_count"] or 0
        c["gap_total_s"] += f["gap_total_s"] or 0
        c["files_unparsed_onsets"] += 1 if (f["unparsed_onsets"] or 0) > 0 else 0
        c["files_truncated_bisection"] += 1 if f["truncated"] else 0
        c["files_file_short"] += 1 if f["file_short"] else 0
        c["files_negative_first_onset"] += 1 if (f["first_onset"] is not None and f["first_onset"] < 0) else 0
        c["bytes_total"] += f["size"] or 0
    ds_rows = {}
    for ds, c in sorted(per.items()):
        ds_rows[ds] = {k: (round(v, 3) if isinstance(v, float) else v) for k, v in c.items()}
        ds_rows[ds]["license"] = license_of(ds, api)
        ds_rows[ds]["zarr_status"] = api[ds]["zarr_status"]
        ds_rows[ds]["zarr_store_count"] = api[ds]["zarr_store_count"]
        ds_rows[ds]["zarr_verify_status"] = api[ds]["zarr_verify_status"]
    gapped = [f for f in files if (f["gap_count"] or 0) > 0]
    summ = {
        "plus_d_files": len(files),
        "by_header_type": dict(Counter(f["cat"] for f in files)),
        "datasets": len(per),
        "files_ok": sum(1 for f in files if f["ok"]),
        "files_not_ok": [f for f in files if not f["ok"]],
        "retry_todo_after_scan": {"heads_not_ok": todo_headers, "deep_not_ok": todo_deep},
        "whole_file_bytes_files_up_to_12MB": {
            "files": len(whole), "bytes": sum(f["size"] for f in whole),
            "gigabytes": round(sum(f["size"] for f in whole) / 1e9, 3)},
        "bisected_files_over_12MB": {"files": len(big), "bytes": sum(f["size"] or 0 for f in big)},
        "files_with_real_gaps": len(gapped),
        "gap_count_total": sum(f["gap_count"] for f in gapped),
        "gap_total_s_all_files": round(sum(f["gap_total_s"] for f in gapped), 3),
        "files_unparsed_onsets": sum(1 for f in files if (f["unparsed_onsets"] or 0) > 0),
        "files_bisection_truncated": sum(1 for f in files if f["truncated"]),
        "files_header_claims_more_records_than_present": [f["path"] for f in files if f["file_short"]],
        "files_negative_first_onset": sum(1 for f in files
                                          if f["first_onset"] is not None and f["first_onset"] < 0),
        "files_with_negative_gap": sum(1 for f in files if (f["gap_neg_count"] or 0) > 0),
        "by_dataset": ds_rows,
    }
    jdump(summ, HERE / "deep-summary.json")
    print(json.dumps({k: v for k, v in summ.items() if k != "by_dataset"}, indent=1)[:6000])
    print(json.dumps(ds_rows, indent=1))
    print(json.dumps({k: v for k, v in tally.items() if k not in ("by_extension_and_header_type",)}, indent=1))
    print("by_extension_and_header_type", tally["by_extension_and_header_type"])


def zarr_index(ds):
    f = WORK / f"zarr-index-{ds}.json"
    return jload(f) if f.exists() else None


def class_members():
    """Recordings of each class as {class: {ds: [path, ...]}} from the scan outputs."""
    out = defaultdict(lambda: defaultdict(list))
    for f in jload(HERE / "deep-edfd-files.json"):
        out["edfd_header"][f["ds"]].append(f["path"])
        if (f["gap_count"] or 0) > 0:
            out["edfd_real_gap"][f["ds"]].append(f["path"])
    bvf = HERE / "brainvision-recordings.json"
    if bvf.exists():
        for r in jload(bvf).values():
            if r.get("n_segments", 0) > 1:
                out["bv_multi_segment"][r["ds"]].append(r["vhdr"])
                out["bv_multi_" + r["class"]][r["ds"]].append(r["vhdr"])
                if r["class"] == "dated-with-gap":
                    sign = "positive_total" if r["gap_total_s"] > 0 else "negative_total"
                    out["bv_gap_" + sign][r["ds"]].append(r["vhdr"])
    ff = HERE / "fif-recordings.json"
    if ff.exists():
        for r in jload(ff).values():
            if r.get("skips_nonzero"):
                out["fif_skip"][r["ds"]].append(r["path"])
    return out


def stage_zarr():
    members = class_members()
    affected = sorted({ds for c in members.values() for ds in c})
    rows, missing = {}, []
    for cls, byds in sorted(members.items()):
        rows[cls] = {}
        for ds, paths in sorted(byds.items()):
            ix = zarr_index(ds)
            if ix is None:
                missing.append(ds)
                rows[cls][ds] = {"recordings": len(paths), "index": "missing"}
                continue
            stores = {s["path"] for s in ix["stores"]}
            fails = {f["path"] for f in ix.get("failures", [])}
            pend = {p if isinstance(p, str) else p.get("path") for p in ix.get("pending", [])}
            rows[cls][ds] = {
                "recordings": len(paths),
                "with_store": sum(1 for p in paths if p in stores),
                "failed": sum(1 for p in paths if p in fails),
                "pending": sum(1 for p in paths if p in pend),
                "not_in_index": sum(1 for p in paths if p not in stores | fails | pend),
                "index_store_count": len(stores), "index_discovered": ix.get("discovered_count"),
                "index_errors": ix.get("errors")}
    nm = zarr_index("nm000456")
    detail = None
    if nm:
        gap = {f["path"]: f for f in jload(HERE / "deep-edfd-files.json") if f["ds"] == "nm000456"}
        stores = [s["path"] for s in nm["stores"]]
        fails = [f for f in nm["failures"]]
        raw = {p for p in gap if not p.startswith("sourcedata/")}
        detail = {
            "gapped_files_in_dataset": len(gap), "gapped_raw_tree_files": len(raw),
            "gapped_sourcedata_files": len(gap) - len(raw),
            "index_discovered": nm["discovered_count"], "index_store_count": nm["store_count"],
            "index_failures": len(fails),
            "failure_codes": dict(Counter(f["code"] for f in fails)),
            "failure_detail_kinds": dict(Counter(f["detail"].split(":")[0] for f in fails)),
            "stores_with_gapped_source": [
                {"path": p, "gap_count": gap[p]["gap_count"], "gap_total_s": gap[p]["gap_total_s"],
                 "first_gaps": gap[p]["first_gaps"],
                 "store_duration_s": next(s for s in nm["stores"] if s["path"] == p)["groups"][0]["duration_s"],
                 "store_updated_utc": next(s for s in nm["stores"] if s["path"] == p)["updated_utc"]}
                for p in stores if p in gap],
            "stores_without_gap": sum(1 for p in stores if p not in gap),
            "failed_paths_that_are_gapped": sum(1 for f in fails if f["path"] in gap),
            "index_source_commit": nm["source_commit"], "index_updated_utc": nm["updated_utc"],
        }
    jdump({"missing_indexes": sorted(set(missing)), "by_class": rows, "nm000456": detail},
          HERE / "zarr-join.json")
    print(json.dumps({"affected_datasets": len(affected), "missing": sorted(set(missing))}))
    print(json.dumps(rows.get("edfd_real_gap"), indent=1))
    print(json.dumps(detail, indent=1))
    for cls, byds in rows.items():
        tot = Counter()
        for r in byds.values():
            for k in ("recordings", "with_store", "failed", "pending", "not_in_index"):
                tot[k] += r.get(k, 0)
        print(cls, dict(tot), "datasets", len(byds))


def stage_classes():
    api = {x["dataset_id"]: x for x in jload(HERE / "api-catalog.json")["datasets"]}
    members = class_members()
    z = jload(HERE / "zarr-join.json")["by_class"]
    census = jload(HERE / "listing-census.json")["per_dataset_counts"]
    totals = {
        "stores_all_datasets": sum(x["zarr_store_count"] or 0 for x in api.values()),
        "files_by_format": {k: sum(v[k] for v in census.values())
                            for k in ("edf", "bdf", "vhdr", "fif", "fif.gz", "set", "cnt", "gdf", "xdf")},
    }
    rows = {}
    for cls, byds in sorted(members.items()):
        zs = z.get(cls, {})
        rows[cls] = {
            "recordings": sum(len(p) for p in byds.values()),
            "datasets": len(byds),
            "stores_in_serving_index": sum(r.get("with_store", 0) for r in zs.values()),
            "recordings_failed_conversion": sum(r.get("failed", 0) for r in zs.values()),
            "recordings_not_in_index": sum(r.get("not_in_index", 0) for r in zs.values()),
            "by_dataset": {ds: {"recordings": len(p), "license": license_of(ds, api),
                                "zarr_status": api[ds]["zarr_status"],
                                "zarr_store_count": api[ds]["zarr_store_count"],
                                **{k: zs.get(ds, {}).get(k) for k in ("with_store", "failed", "not_in_index")}}
                           for ds, p in sorted(byds.items())},
            "licenses": dict(Counter(license_of(ds, api) for ds in byds)),
        }
    jdump({"totals": totals, "classes": rows}, HERE / "classes.json")
    for c, r in rows.items():
        print(c, {k: v for k, v in r.items() if k != "by_dataset"})
    print(totals)


def pct(vals, p):
    """Percentile by linear interpolation between order statistics (the numpy default)."""
    s = sorted(vals)
    k = (len(s) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return round(s[lo] + (s[hi] - s[lo]) * (k - lo), 3)


def stage_bvstats():
    recs = jload(HERE / "brainvision-recordings.json")
    g = [v for v in recs.values() if v.get("class") == "dated-with-gap"]
    tol = lambda v: max(v["sampling_interval_us"] / 1e6, 1e-3)  # noqa: E731
    pos = [v for v in g if v["gap_total_s"] > 0]
    neg = [v for v in g if v["gap_total_s"] <= 0]

    def block(rows):
        t = [v["gap_total_s"] for v in rows]
        return {"recordings": len(rows), "median_s": pct(t, 50), "p90_s": pct(t, 90),
                "max_s": max(t), "min_s": min(t),
                "over_0.1s": sum(1 for x in t if x > 0.1), "over_1s": sum(1 for x in t if x > 1),
                "over_60s": sum(1 for x in t if x > 60),
                "at_most_0.1s_incl_negative": sum(1 for x in t if x <= 0.1),
                "abs_total_below_0.1s": sum(1 for x in t if abs(x) < 0.1),
                "net_signed_sum_s": round(sum(t), 3)}

    def real(v):
        return [x for x in v["gap_s"] if abs(x) > tol(v)]

    truncated = [v for v in g if v["real_gaps"] > len(v["gap_s"]) and len(v["gap_s"]) >= 50]
    with_neg = [v for v in g if any(x < -tol(v) for x in real(v))]
    small = [v for v in g if real(v) and all(abs(x) < 1 for x in real(v))]

    def frac(x, si):
        return abs(x / (si / 1e6) - round(x / (si / 1e6))) < 1e-6

    off_grid = [v for v in small if not all(frac(x, v["sampling_interval_us"]) for x in real(v))]
    on_grid = [v for v in small if v not in off_grid]
    out = {
        "method": "percentiles by linear interpolation between order statistics; gap_total_s is the "
                  "signed sum of the real gaps (|gap| above max(one sampling interval, 1 ms)) over "
                  "ALL segment pairs; the absolute sum and the negative-gap test use gap_s, which "
                  "holds the first 50 gaps only",
        "dated_with_gap_all": block(g),
        "positive_total": block(pos),
        "negative_total": block(neg),
        "negative_total_by_dataset": dict(Counter(v["ds"] for v in neg)),
        "recordings_with_at_least_one_negative_gap_first50": len(with_neg),
        "abs_gap_sum_s_first50": round(sum(abs(x) for v in g for x in real(v)), 3),
        "net_gap_sum_s_all": round(sum(v["gap_total_s"] for v in g), 3),
        "recordings_with_more_than_50_gaps_abs_sum_is_lower_bound": len(truncated),
        "recordings_with_all_gaps_under_1s": len(small),
        "of_those_with_a_gap_that_is_not_a_multiple_of_the_sampling_interval": len(off_grid),
        "of_those_all_gaps_multiples_of_the_sampling_interval": len(on_grid),
        "on_grid_detail": [{"ds": v["ds"], "vhdr": v["vhdr"], "sampling_interval_us": v["sampling_interval_us"],
                            "gap_s": v["gap_s"]} for v in on_grid],
        "second_resolution_note": "a date written to whole seconds would give a gap equal to a whole "
                                  "number of seconds minus the sample span; a gap that is not a multiple "
                                  "of the sampling interval therefore shows dates finer than a second, "
                                  "and the others cannot be told from millisecond dates",
    }
    jdump(out, HERE / "bv-gap-stats.json")
    print(json.dumps({k: v for k, v in out.items() if k != "on_grid_detail"}, indent=1))


def stage_fifstats():
    rs = {}
    for line in (WORK / "fif.jsonl").read_text().splitlines():
        d = json.loads(line)
        rs[d["k"]] = d["r"]
    ds_of = lambda r: r["ds"]  # noqa: E731
    pool = [r for r in rs.values() if r["status"] in ("ok-walk", "walk-capped", "no-directory",
                                                       "no-directory-unmeasured", "directory-beyond-end",
                                                       "directory-beyond-end-unmeasured")]
    walked = [r for r in rs.values() if r["status"] in ("ok-walk", "walk-capped")]
    bad_skip = [k for k, r in rs.items() if any(s is None or s <= 0 for s in r.get("skip_values", []))]
    with_skip = [r for r in rs.values() if r.get("skips_nonzero")]  # directory method only
    out = {
        "files": len(rs),
        "status": dict(Counter(r["status"] for r in rs.values())),
        "no_directory_pointer_minus_1": sum(1 for r in pool if r.get("directory_status", r["status"]).startswith("no-directory")),
        "directory_beyond_end": sum(1 for r in pool if r.get("directory_status", r["status"]).startswith("directory-beyond-end")),
        "pool_without_usable_directory": len(pool),
        "pool_datasets": len({ds_of(r) for r in pool}),
        "walked_sample": len(walked), "walked_sample_datasets": len({ds_of(r) for r in walked}),
        "walked_by_dataset": dict(Counter(ds_of(r) for r in walked)),
        "walked_with_skip": sum(1 for r in walked if r.get("skips_nonzero")),
        "pool_files_in_datasets_that_have_a_measured_skip": sum(
            1 for r in pool if ds_of(r) in {ds_of(x) for x in with_skip}),
        "sample_datasets_that_have_a_measured_skip": len(
            {ds_of(r) for r in walked} & {ds_of(x) for x in with_skip}),
        "walk_capped": sum(1 for r in rs.values() if r["status"] == "walk-capped"),
        "walk_reads_total": sum(r.get("reads", 0) for r in walked),
        "unmeasured": sum(1 for r in pool if r["status"].endswith("-unmeasured") or r["status"] in ("no-directory", "directory-beyond-end")),
        "measured_total": sum(1 for r in rs.values() if r["status"] in ("ok", "ok-walk")),
        "failed": sum(1 for r in rs.values() if r["status"].startswith("FAILED")),
        "directory_files_with_skip": len(with_skip),
        "datasets_with_skip": len({ds_of(r) for r in with_skip}),
        "files_with_a_nonpositive_or_unreadable_skip_value": len(bad_skip),
        "files_with_more_than_one_skip_tag": sum(1 for r in rs.values() if r.get("skip_tags", 0) > 1),
    }
    jdump(out, HERE / "fif-coverage.json")
    print(json.dumps(out, indent=1))


def stage_extras():
    d = jload(HERE / "deep-edfd-files.json")
    top = sorted((f for f in d if f["gap_count"]), key=lambda f: -f["gap_total_s"])[:4]
    idx = jload(WORK / "files-index.json")
    miss = []
    for ds, v in idx.items():
        paths = {e["path"] for e in v["entries"]}
        lowdirs = defaultdict(set)
        for p in paths:
            if p.lower().endswith(".vmrk"):
                lowdirs[p.rsplit("/", 1)[0] if "/" in p else ""].add(p)
        for p in paths:
            if p.endswith(".vhdr") and p[:-5] + ".vmrk" not in paths:
                dr = p.rsplit("/", 1)[0] if "/" in p else ""
                miss.append({"ds": ds, "vhdr": p, "case_insensitive_name_match": (p[:-5] + ".vmrk").lower() in {x.lower() for x in paths},
                             "any_vmrk_in_same_directory": bool(lowdirs.get(dr))})
    out = {"largest_gapped_edfd_files": [{"path": f["path"], "gap_count": f["gap_count"],
                                          "gap_total_s": f["gap_total_s"]} for f in top],
           "vhdr_without_matching_vmrk_in_listing": len(miss),
           "by_dataset": dict(Counter(m["ds"] for m in miss)),
           "with_case_insensitive_name_match": sum(1 for m in miss if m["case_insensitive_name_match"]),
           "with_any_vmrk_in_same_directory": sum(1 for m in miss if m["any_vmrk_in_same_directory"]),
           "note": "the MarkerFile= line of each .vhdr was not read (needs a network read), so a marker "
                   "file kept in another directory cannot be excluded"}
    jdump(out, HERE / "extras.json")
    print(json.dumps(out, indent=1))


STAGES = {"scan": stage_scan, "zarr": stage_zarr, "classes": stage_classes, "bvstats": stage_bvstats,
          "fifstats": stage_fifstats, "extras": stage_extras}

if __name__ == "__main__":
    if "--work" in sys.argv:
        WORK = Path(sys.argv[sys.argv.index("--work") + 1])
    STAGES[sys.argv[1]]()
