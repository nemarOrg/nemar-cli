"""Card S1 measurements that scan.py does not cover (read-only, public endpoints only).

Run: uv run --no-project --with httpx python -I s1scan.py STAGE [--work DIR] [--out DIR]
Stages, in order:
  api         list the public catalog (api.nemar.org/datasets), keep a compact projection
  listing     list every file of every public dataset (data plane manifest.json; GitHub tree
              when the manifest answers 413), keep the BrainVision and FIF entries
  bv          Range-read every .vmrk and count "New Segment" markers per recording
  fif         Range-read the FIF tag directory of every .fif and count FIFF_DATA_SKIP tags
  throughput  stores converted per day from zarr_converted_at (no network; reads the api output)
  zarrcheck   keep the zarr.nemar.org store index of datasets IDS (comma list) in the work dir

The work directory (default /Users/yahya/.cache/nemar-s1-scan) holds the big intermediate
files and is never committed; the out directory (default: this script's directory) holds the
compact outputs that are committed.
The request helper and the Reader class are copied from scan.py (same method, same limits):
a named User-Agent, at most 8 concurrent requests, abort after 8 failures in a row.
"""

import asyncio
import json
import os
import re
import statistics
import struct
import subprocess
import sys
import urllib.parse
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
WORK = Path("/Users/yahya/.cache/nemar-s1-scan")
OUT = HERE
UA = "nemar-s1-scan/0.1"
API = "https://api.nemar.org"
DATA = "https://data.nemar.org"
ZARR = "https://zarr.nemar.org"
S3 = "https://nemar.s3.us-east-2.amazonaws.com"
CONC = int(os.environ.get("S1_CONC", "8"))  # the card caps the total at 8
ONLY = None
ABORT_STREAK = 8


class Abort(Exception):
    pass


class Net:
    def __init__(self):
        self.sem = asyncio.Semaphore(CONC)
        self.requests = 0
        self.bad_streak = 0
        self.stat = {"429": 0, "5xx": 0, "other_fail": 0}


async def req(st, client, method, url, headers=None, follow=True, tries=4, timeout=60, count=True):
    """One polite request with backoff.  Unlike scan.py, the abort streak counts requests that
    failed after every retry (not each retry), and `count=False` leaves it alone: used for the
    data-plane read of an object that S3 already answered 403/404 for (a deterministic 502)."""
    last = None
    r = None
    for attempt in range(tries):
        async with st.sem:
            st.requests += 1
            try:
                r = await client.request(method, url, headers=headers, follow_redirects=follow,
                                         timeout=timeout)
            except (httpx.HTTPError, OSError) as e:
                last = e
                r = None
        if r is not None and r.status_code != 429 and r.status_code < 500:
            st.bad_streak = 0
            return r
        if r is not None and r.status_code == 429:
            st.stat["429"] += 1
        elif r is not None:
            st.stat["5xx"] += 1
        else:
            st.stat["other_fail"] += 1
        if attempt == tries - 1:
            if count:
                st.bad_streak += 1
                if st.bad_streak >= ABORT_STREAK:
                    raise Abort(f"{st.bad_streak} consecutive failed requests; last={url}")
            break
        delay = 2**attempt
        if r is not None and "retry-after" in r.headers:
            try:
                delay = min(30, max(delay, float(r.headers["retry-after"])))
            except ValueError:
                pass
        await asyncio.sleep(delay)
    if r is not None:
        return r
    raise last or RuntimeError("request failed")


def enc(path):
    return "/".join(urllib.parse.quote(p, safe="") for p in path.split("/"))


def direct_url(ds, e):
    if e.get("key"):
        k = e["key"]
        if k.startswith("git:") or "/" in k:
            return None
        return f"{S3}/{ds}/objects/{k}"
    alg = e.get("alg")
    if alg and alg.lower() in ("sha256", "md5") and e.get("checksum") and e.get("size") is not None:
        ext = os.path.splitext(e["path"])[1]
        backend = "SHA256E" if alg.lower() == "sha256" else "MD5E"  # MD5E checked on on001810
        return f"{S3}/{ds}/objects/{backend}-s{e['size']}--{e['checksum']}{ext}"
    return None


class Reader:
    """Resolve a readable URL for a file once, then Range-read it (copied from scan.py)."""

    def __init__(self, st, client):
        self.st, self.client = st, client
        self.urls = {}
        self.sizes = {}
        self.raw_sem = asyncio.Semaphore(3)

    async def read(self, ds, ver, e, start, end):
        k = (ds, ver, e["path"])
        cands = []
        if k not in self.urls and not direct_url(ds, e) and e.get("size") is None \
                and "annexkey" not in e:
            e["annexkey"] = None
            try:
                async with self.raw_sem:
                    rr = await req(self.st, self.client, "GET",
                                   f"https://raw.githubusercontent.com/nemarDatasets/{ds}/{ver}/{enc(e['path'])}",
                                   timeout=30)
                    await asyncio.sleep(0.15)
                t = rr.text.strip() if rr.status_code == 200 else ""
                kk = t.rsplit("/", 1)[-1] if "annex/objects" in t else ""
                if kk and "\n" not in kk and len(kk) < 400:
                    e["annexkey"] = kk
            except Abort:
                raise
            except Exception:  # noqa: BLE001
                pass
        if e.get("annexkey") and k not in self.urls:
            m = re.search(r"-s(\d+)--", e["annexkey"])
            if m:
                self.sizes[k] = int(m.group(1))
            self.urls[k] = f"{S3}/{ds}/objects/{e['annexkey']}"
        if k in self.urls:
            cands.append(self.urls[k])
        else:
            du = direct_url(ds, e)
            if du:
                cands.append(du)
            cands.append(None)
        if None not in cands:
            cands.append(None)
        s3_miss = False
        for u in cands:
            if u is None:
                dp = f"{DATA}/{ds}/{ver}/{enc(e['path'])}"
                r = await req(self.st, self.client, "GET", dp, follow=False,
                              headers={"Range": f"bytes={start}-{end}"},
                              tries=2 if s3_miss else 4, count=not s3_miss)
                if r.status_code in (301, 302, 303, 307, 308):
                    u2 = r.headers["location"]
                    self.urls[k] = u2
                    r = await req(self.st, self.client, "GET", u2,
                                  headers={"Range": f"bytes={start}-{end}"})
                else:
                    u2 = dp
            else:
                u2 = u
                r = await req(self.st, self.client, "GET", u2,
                              headers={"Range": f"bytes={start}-{end}"})
            if r.status_code in (200, 206):
                if k not in self.urls:
                    self.urls[k] = u2
                body = r.content
                cr = r.headers.get("content-range", "")
                if "/" in cr and cr.rsplit("/", 1)[1].isdigit():
                    self.sizes[k] = int(cr.rsplit("/", 1)[1])
                if r.status_code == 200:
                    self.sizes.setdefault(k, len(body))
                    body = body[start: end + 1]
                return body
            if r.status_code == 416:  # range starts past the end: empty read
                return b""
            if u is not None and r.status_code in (403, 404):
                self.urls.pop(k, None)
                s3_miss = True
                continue
            raise RuntimeError(f"HTTP {r.status_code}" + (" after S3 403/404" if s3_miss else ""))
        raise RuntimeError("no readable URL")

    async def read_all(self, ds, ver, e, cap=64_000_000, chunk=4_000_000):
        """The whole file by Range reads of `chunk` bytes, up to `cap` bytes."""
        out = b""
        while len(out) < cap:
            b = await self.read(ds, ver, e, len(out), len(out) + chunk - 1)
            out += b
            total = self.sizes.get((ds, ver, e["path"]))
            if len(b) < chunk or (total is not None and len(out) >= total):
                break
        return out


def jdump(obj, path):
    Path(path).write_text(json.dumps(obj, indent=1, sort_keys=True) + "\n")


def load_jsonl(path):
    """Results already written by an earlier run of the same stage (resume)."""
    out = {}
    if Path(path).exists():
        for line in Path(path).read_text().splitlines():
            if line.strip():
                d = json.loads(line)
                out[d["k"]] = d["r"]
    return out


def keep_done(prev):
    return {k: r for k, r in prev.items() if not str(r.get("status", "")).startswith("FAILED")}


def load_json(path):
    return json.loads(Path(path).read_text())


# ------------------------------------------------------------------- api
KEEP = ("dataset_id", "visibility", "license", "latest_version", "source", "modalities",
        "total_files", "zarr_status", "zarr_store_count", "zarr_converted_at", "zarr_errors",
        "zarr_failure_count", "zarr_verify_status", "zarr_verified_at", "zarr_requeue_at",
        "zarr_failed_at", "recording_count", "recordings_unavailable", "latest_version_at")


async def stage_api(client, net):
    out, offset, total = [], 0, None
    while True:
        r = await req(net, client, "GET", f"{API}/datasets?limit=100&offset={offset}")
        r.raise_for_status()
        b = r.json()
        total = b["total_count"]
        out += [{k: d.get(k) for k in KEEP} for d in b["datasets"]]
        offset += 100
        if offset >= total or not b["datasets"]:
            break
    jdump({"fetched_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "total_count": total, "datasets": out}, OUT / "api-catalog.json")
    pub = [d for d in out if d["visibility"] == "public"]
    print(f"listed {len(out)} (api total_count {total}); public {len(pub)}")
    print("sum zarr_store_count (all listed):", sum(d["zarr_store_count"] or 0 for d in out))
    print("zarr_status:", dict(Counter(d["zarr_status"] for d in out)))
    print("converted_at present:", sum(1 for d in out if d["zarr_converted_at"]))
    print("licenses:", dict(Counter(d["license"] for d in out)))


# --------------------------------------------------------------- listing
def ext_of(p):
    n = p.lower()
    if n.endswith(".fif.gz"):
        return "fif.gz"
    return os.path.splitext(n)[1].lstrip(".") or "(none)"


WANT = {"vhdr", "vmrk", "fif", "fif.gz"}


def gh_tree(ds, sha, recursive):
    url = f"repos/nemarDatasets/{ds}/git/trees/{sha}" + ("?recursive=1" if recursive else "")
    import time
    p = None
    for attempt in range(6):
        p = subprocess.run(["gh", "api", url], capture_output=True, timeout=120)
        if p.returncode == 0:
            return json.loads(p.stdout)
        time.sleep(2 ** attempt)
    raise RuntimeError("gh:" + p.stderr.decode(errors="replace")[:200])


def list_tree(ds, sha, prefix, out):
    b = gh_tree(ds, sha, True)
    if not b.get("truncated"):
        out += [prefix + n["path"] for n in b["tree"] if n["type"] == "blob"]
        return
    b = gh_tree(ds, sha, False)
    if b.get("truncated"):
        raise RuntimeError(f"flat tree truncated at {prefix!r}")
    for n in b["tree"]:
        if n["type"] == "blob":
            out.append(prefix + n["path"])
        elif n["type"] == "tree":
            list_tree(ds, n["sha"], prefix + n["path"] + "/", out)


async def stage_listing(client, net):
    cat = load_json(OUT / "api-catalog.json")["datasets"]
    todo = [d for d in cat if d["visibility"] == "public" and d["latest_version"]]
    res = {}
    q = asyncio.Queue()
    for d in todo:
        q.put_nowait(d)

    async def one(d):
        ds, ver = d["dataset_id"], d["latest_version"]
        r = await req(net, client, "GET", f"{DATA}/{ds}/{ver}/manifest.json", timeout=180)
        if r.status_code == 200:
            m = r.json()
            census = Counter(ext_of(e["path"]) for e in m)
            ents = [{"path": e["path"], "size": e.get("size"), "alg": e.get("checksum_algorithm"),
                     "checksum": e.get("checksum")} for e in m if ext_of(e["path"]) in WANT]
            return {"source": "manifest.json", "total": len(m), "census": dict(census),
                    "entries": ents}
        if r.status_code == 413:
            paths = []
            await asyncio.to_thread(list_tree, ds, ver, "", paths)
            census = Counter(ext_of(p) for p in paths)
            ents = [{"path": p, "size": None} for p in paths if ext_of(p) in WANT]
            return {"source": "github-tree", "total": len(paths), "census": dict(census),
                    "entries": ents}
        return {"source": f"FAILED manifest HTTP {r.status_code}", "total": 0, "census": {},
                "entries": []}

    async def worker():
        while not q.empty():
            d = q.get_nowait()
            try:
                res[d["dataset_id"]] = {"version": d["latest_version"], **await one(d)}
            except Abort:
                raise
            except Exception as ex:  # noqa: BLE001
                res[d["dataset_id"]] = {"version": d["latest_version"],
                                        "source": f"FAILED {type(ex).__name__}: {str(ex)[:120]}",
                                        "total": 0, "census": {}, "entries": []}
            if len(res) % 100 == 0:
                print("  listed", len(res), "of", len(todo), flush=True)

    await asyncio.gather(*[worker() for _ in range(4)])
    jdump(res, WORK / "files-index.json")
    census = {ds: v["census"] for ds, v in sorted(res.items())}
    tot = Counter()
    for v in res.values():
        tot.update(v["census"])
    summary = {
        "datasets_listed": len(res),
        "sources": dict(Counter(v["source"] for v in res.values())),
        "total_files": sum(v["total"] for v in res.values()),
        "extension_totals_top": dict(tot.most_common(25)),
        "datasets_with_vhdr": sorted(ds for ds, v in res.items() if v["census"].get("vhdr")),
        "datasets_with_fif": sorted(ds for ds, v in res.items()
                                    if v["census"].get("fif") or v["census"].get("fif.gz")),
        "per_dataset_counts": {
            ds: {k: c.get(k, 0) for k in ("edf", "bdf", "vhdr", "vmrk", "fif", "fif.gz", "set",
                                          "cnt", "gdf", "mefd", "xdf")}
            for ds, c in census.items()},
    }
    jdump(summary, OUT / "listing-census.json")
    print(json.dumps({k: v for k, v in summary.items() if k != "per_dataset_counts"}, indent=1))
    print("failed:", [ds for ds, v in res.items() if v["source"].startswith("FAILED")])
    print("requests", net.requests, net.stat)


# ------------------------------------------------------------ BrainVision
MK = re.compile(r"^Mk(\d+)=([^,]*),([^,]*),(\d+),(\d+),(\d+)(?:,(\d*))?\s*$")


def parse_vmrk(text):
    segs = []
    for line in text.splitlines():
        m = MK.match(line.strip())
        if m and m.group(2).strip() == "New Segment":
            segs.append({"pos": int(m.group(4)), "date": (m.group(7) or "").strip()})
    return segs


def parse_date(s):
    if len(s) < 14 or not s.isdigit():
        return None
    try:
        t = datetime(int(s[0:4]), int(s[4:6]), int(s[6:8]), int(s[8:10]), int(s[10:12]),
                     int(s[12:14]), tzinfo=timezone.utc)
    except ValueError:
        return None
    if t.year < 1990:
        return None
    us = int(s[14:20].ljust(6, "0")) if len(s) > 14 else 0
    return t.timestamp() + us / 1e6


def vhdr_info(text):
    def g(key):
        m = re.search(rf"^{key}\s*=\s*(.*?)\s*$", text, re.M)
        return m.group(1) if m else None
    si = g("SamplingInterval")
    return {"segmentation": g("SegmentationType"), "data_format": g("DataFormat"),
            "sampling_interval_us": float(si) if si and re.match(r"^[0-9.]+$", si) else None,
            "n_channels": g("NumberOfChannels")}


async def stage_bv(client, net):
    idx = load_json(WORK / "files-index.json")
    idx = {k: v for k, v in idx.items() if ONLY is None or k in ONLY}
    rd = Reader(net, client)
    work = []
    for ds, v in idx.items():
        ents = {e["path"]: e for e in v["entries"]}
        for p, e in ents.items():
            if p.lower().endswith(".vhdr"):
                work.append((ds, v["version"], e, ents.get(p[:-5] + ".vmrk")))
    print("vhdr recordings:", len(work), "datasets:", len({w[0] for w in work}))
    jl = WORK / ("bv.jsonl" if ONLY is None else "bv-only.jsonl")
    out = keep_done(load_jsonl(jl))
    print("already done from an earlier run:", len(out), flush=True)
    fh = open(jl, "a")
    q = asyncio.Queue()
    for w in work:
        if f"{w[0]}/{w[2]['path']}" not in out:
            q.put_nowait(w)

    async def worker():
        while not q.empty():
            ds, ver, vh, vm = q.get_nowait()
            rec = {"ds": ds, "vhdr": vh["path"], "vmrk": vm["path"] if vm else None}
            try:
                if vm is None:
                    rec["status"] = "no-vmrk-in-listing"
                else:
                    segs = parse_vmrk((await rd.read_all(ds, ver, vm)).decode("latin-1"))
                    rec["n_segments"] = len(segs)
                    rec["status"] = "ok"
                    if len(segs) > 1:
                        info = vhdr_info((await rd.read_all(ds, ver, vh, cap=1_000_000)).decode("latin-1"))
                        rec.update(info)
                        dts = [parse_date(s["date"]) for s in segs]
                        rec["dated_segments"] = sum(1 for t in dts if t is not None)
                        si = info["sampling_interval_us"]
                        if (info["segmentation"] or "").upper() == "MARKERBASED":
                            rec["class"] = "epoched-markerbased"
                        elif si and all(t is not None for t in dts):
                            gaps = []
                            for i in range(len(segs) - 1):
                                span = (segs[i + 1]["pos"] - segs[i]["pos"]) * si / 1e6
                                gaps.append(round(dts[i + 1] - dts[i] - span, 6))
                            tol = max(si / 1e6, 1e-3)
                            real = [g for g in gaps if abs(g) > tol]
                            rec["gap_s"] = gaps[:50]
                            rec["real_gaps"] = len(real)
                            rec["gap_total_s"] = round(sum(real), 6)
                            rec["class"] = "dated-with-gap" if real else "dated-contiguous"
                        elif rec["dated_segments"]:
                            rec["class"] = "partly-dated"
                        else:
                            rec["class"] = "undated"
            except Abort:
                raise
            except Exception as ex:  # noqa: BLE001
                rec["status"] = f"FAILED {type(ex).__name__}: {str(ex)[:100]}"
            out[f"{ds}/{vh['path']}"] = rec
            fh.write(json.dumps({"k": f"{ds}/{vh['path']}", "r": rec}) + "\n")
            fh.flush()
            if len(out) % 200 == 0:
                print("  bv", len(out), "of", len(work), flush=True)

    await asyncio.gather(*[worker() for _ in range(CONC)])
    # the full per-recording table stays in the work directory (bv.jsonl); commit the compact part
    jdump({k: r for k, r in out.items() if r.get("n_segments", 0) > 1 or r["status"] != "ok"},
          OUT / "brainvision-recordings.json")
    segc = Counter()
    per = defaultdict(Counter)
    for r in out.values():
        if r["status"] == "ok":
            segc["multi" if r["n_segments"] > 1 else ("one" if r["n_segments"] == 1 else "zero")] += 1
            if r["n_segments"] > 1:
                per[r["ds"]][r.get("class")] += 1
        else:
            segc[r["status"].split(":")[0]] += 1
    summ = {"recordings": len(out), "segment_markers": dict(segc),
            "multi_segment_by_class": dict(Counter(r.get("class") for r in out.values()
                                                   if r.get("n_segments", 0) > 1)),
            "multi_segment_by_dataset": {k: dict(v) for k, v in sorted(per.items())},
            "n_segments_distribution_multi": dict(Counter(r["n_segments"] for r in out.values()
                                                          if r.get("n_segments", 0) > 1)),
            "requests": net.requests, "stat": net.stat}
    jdump(summ, OUT / "brainvision-summary.json")
    print(json.dumps(summ, indent=1))


# -------------------------------------------------------------------- FIF
def be32(b, off):
    return struct.unpack(">i", b[off: off + 4])[0]


async def fif_one(rd, ds, ver, e):
    """FIF tags are big-endian (kind, type, size, next); the directory tag lists every tag."""
    rec = {"ds": ds, "path": e["path"]}
    head = await rd.read(ds, ver, e, 0, 63)
    if len(head) < 56:
        rec["status"] = "too-short"
        return rec
    kind0, _, size0, next0 = struct.unpack(">iiii", head[0:16])
    if next0 == 0:  # next 0 means "the tag follows immediately"
        next0 = 16 + size0
    if kind0 != 100 or size0 != 20 or next0 + 20 > len(head):
        rec["status"] = "not-fif-start"
        return rec
    kind1 = be32(head, next0)
    if kind1 != 101:
        rec["status"] = "no-dir-pointer-tag"
        return rec
    dirpos = be32(head, next0 + 16)
    rec["dirpos"] = dirpos
    if dirpos <= 0:
        rec["status"] = "no-directory"
        return rec
    dh = await rd.read(ds, ver, e, dirpos, dirpos + 15)
    if len(dh) < 16:
        rec["status"] = "directory-beyond-end"
        return rec
    _, dtype, dsize, _ = struct.unpack(">iiii", dh)
    if dtype != 32 or dsize <= 0 or dsize > 256_000_000 or dsize % 16:
        rec["status"] = f"bad-directory-tag-type{dtype}-size{dsize}"
        return rec
    got = b""
    pos = dirpos + 16
    end = pos + dsize
    while pos < end:
        step = min(8_000_000, end - pos)
        b = await rd.read(ds, ver, e, pos, pos + step - 1)
        if not b:
            break
        got += b
        pos += len(b)
    if len(got) != dsize:
        rec["status"] = f"short-directory-{len(got)}-of-{dsize}"
        return rec
    ents = [struct.unpack(">iiii", got[i: i + 16]) for i in range(0, dsize, 16)]
    rec["n_tags"] = len(ents)
    rec["n_buffers"] = sum(1 for k, _, _, _ in ents if k == 300)
    skips = [p for k, _, _, p in ents if k == 301]
    rec["skip_tags"] = len(skips)
    nskips = []
    for p in skips:
        b = await rd.read(ds, ver, e, p + 16, p + 19)
        nskips.append(be32(b, 0) if len(b) == 4 else None)
    rec["skip_values"] = nskips[:20]
    # r1 review (code-only, no effect on the committed data: no skip value was <= 0 or None):
    # count only positive skip values, as MNE does (`if nskip > 0`), and record unreadable ones.
    rec["skips_nonzero"] = sum(1 for n in nskips if n is not None and n > 0)
    rec["skipped_buffers"] = sum(n for n in nskips if n is not None and n > 0)
    rec["skip_read_none"] = sum(1 for n in nskips if n is None)
    if rec["skip_read_none"]:
        print("  WARNING: unreadable FIFF_DATA_SKIP value", ds, e["path"], flush=True)
    rec["first_tag_is_skip"] = bool(ents and ents[0][0] == 301)
    rec["status"] = "ok"
    return rec



FALLBACK = ("no-directory", "directory-beyond-end")
SAMPLE_N = 50
SAMPLE_SEED = 20261120
WALK_MAX_READS = 20000


async def fif_walk(rd, ds, ver, e):
    """No usable directory: follow the tag chain with one 16-byte Range read per tag
    (what MNE does when the directory is missing).  Capped at WALK_MAX_READS reads."""
    rec = {"ds": ds, "path": e["path"], "method": "tag-chain-walk"}
    pos, reads, buffers, skips = 0, 0, 0, []
    size = rd.sizes.get((ds, ver, e["path"])) or e.get("size")
    while reads < WALK_MAX_READS:
        if size is not None and pos >= size:
            break
        h = await rd.read(ds, ver, e, pos, pos + 15)
        reads += 1
        if len(h) < 16:
            break
        kind, _, tsize, nxt = struct.unpack(">iiii", h)
        if kind == 300:
            buffers += 1
        elif kind == 301:
            b = await rd.read(ds, ver, e, pos + 16, pos + 19)
            reads += 1
            skips.append(be32(b, 0) if len(b) == 4 else None)
        if nxt == -1 or tsize < 0:
            break
        pos = pos + 16 + tsize if nxt == 0 else nxt
    rec.update({"reads": reads, "n_buffers": buffers, "skip_tags": len(skips),
                "skip_values": skips[:20],
                "skips_nonzero": sum(1 for n in skips if n is not None and n > 0),
                "skipped_buffers": sum(n for n in skips if n is not None and n > 0),
                "skip_read_none": sum(1 for n in skips if n is None),
                "status": "ok-walk" if reads < WALK_MAX_READS else "walk-capped"})
    return rec


async def stage_fif(client, net):
    idx = load_json(WORK / "files-index.json")
    idx = {k: v for k, v in idx.items() if ONLY is None or k in ONLY}
    rd = Reader(net, client)
    work = [(ds, v["version"], e) for ds, v in idx.items() for e in v["entries"]
            if ext_of(e["path"]) == "fif"]
    print("fif files:", len(work), "datasets:", len({w[0] for w in work}))
    jl = WORK / ("fif.jsonl" if ONLY is None else "fif-only.jsonl")
    out = keep_done(load_jsonl(jl))
    print("already done from an earlier run:", len(out), flush=True)
    fh = open(jl, "a")
    q = asyncio.Queue()
    for w in work:
        if f"{w[0]}/{w[2]['path']}" not in out:
            q.put_nowait(w)

    async def worker():
        while not q.empty():
            ds, ver, e = q.get_nowait()
            try:
                rec = await fif_one(rd, ds, ver, e)
            except Abort:
                raise
            except Exception as ex:  # noqa: BLE001
                rec = {"ds": ds, "path": e["path"],
                       "status": f"FAILED {type(ex).__name__}: {str(ex)[:100]}"}
            out[f"{ds}/{e['path']}"] = rec
            fh.write(json.dumps({"k": f"{ds}/{e['path']}", "r": rec}) + "\n")
            fh.flush()
            if len(out) % 100 == 0:
                print("  fif", len(out), "of", len(work), flush=True)

    await asyncio.gather(*[worker() for _ in range(CONC)])
    # files without a usable directory: walk a fixed-seed sample of SAMPLE_N, leave the rest unmeasured
    import random
    fb = sorted(k for k, r in out.items()
                if r.get("directory_status", r["status"]) in FALLBACK
                or r.get("directory_status", r["status"]).removesuffix("-unmeasured") in FALLBACK)
    sample = random.Random(SAMPLE_SEED).sample(fb, min(SAMPLE_N, len(fb)))
    print("no usable directory:", len(fb), "walking a sample of", len(sample), flush=True)
    byk = {f"{ds}/{e['path']}": (ds, ver, e) for ds, ver, e in work}
    q2 = asyncio.Queue()
    for k in sample:
        if out[k]["status"] in ("ok-walk", "walk-capped"):
            continue
        q2.put_nowait(k)

    async def walker():
        while not q2.empty():
            k = q2.get_nowait()
            ds, ver, e = byk[k]
            prev = out[k]["status"]
            try:
                rec = await fif_walk(rd, ds, ver, e)
            except Abort:
                raise
            except Exception as ex:  # noqa: BLE001
                rec = {"ds": ds, "path": e["path"], "status": f"FAILED walk {type(ex).__name__}: {str(ex)[:100]}"}
            rec["directory_status"] = prev
            out[k] = rec
            fh.write(json.dumps({"k": k, "r": rec}) + "\n")
            fh.flush()

    await asyncio.gather(*[walker() for _ in range(CONC)])
    for k in fb:
        if k not in sample and not out[k]["status"].endswith("-unmeasured"):
            out[k]["directory_status"] = out[k]["status"]
            out[k]["status"] = out[k]["status"] + "-unmeasured"
    jdump({k: r for k, r in out.items() if r["status"] != "no-directory-unmeasured"
           and not (r["status"] == "ok" and not r.get("skips_nonzero"))},
          OUT / "fif-recordings.json")
    per = defaultdict(Counter)
    for r in out.values():
        per[r["ds"]]["files"] += 1
        if r["status"] in ("ok", "ok-walk", "walk-capped"):
            per[r["ds"]]["with_skip"] += 1 if r["skips_nonzero"] else 0
            per[r["ds"]]["skip_tag_zero_only"] += 1 if (r["skip_tags"] and not r["skips_nonzero"]) else 0
        else:
            per[r["ds"]][r["status"].split(":")[0]] += 1
    summ = {"files": len(out),
            "status": dict(Counter(r["status"].split(":")[0] for r in out.values())),
            "walk_capped": sum(1 for r in out.values() if r["status"] == "walk-capped"),
            "files_with_skip": sum(1 for r in out.values() if r.get("skips_nonzero")),
            "skipped_buffers_total": sum(r.get("skipped_buffers", 0) for r in out.values()),
            "by_dataset": {k: dict(v) for k, v in sorted(per.items())},
            "requests": net.requests, "stat": net.stat}
    jdump(summ, OUT / "fif-summary.json")
    print(json.dumps(summ, indent=1))


# ------------------------------------------------------------- throughput
def pct(vals, p):
    s = sorted(vals)
    if not s:
        return None
    k = (len(s) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return round(s[lo] + (s[hi] - s[lo]) * (k - lo), 1)


def stage_throughput():
    """Stores per day from the catalog's `zarr_converted_at` (read from api-catalog.json, no network).
    `zarr_converted_at` strings carry no zone and are read as UTC.  The window is the 30 complete UTC
    days before the fetch date, selected by calendar date (r1 review: the earlier version selected by
    elapsed time, which made 2026-10-22 a partial day and counted the partial fetch day)."""
    api = load_json(OUT / "api-catalog.json")
    now = datetime.fromisoformat(api["fetched_utc"].replace("Z", "+00:00"))
    fetch_day = now.date()
    window = [str(fetch_day - timedelta(days=i)) for i in range(1, 31)]  # 30 complete UTC days
    wset = set(window)
    total_stores = sum(d["zarr_store_count"] or 0 for d in api["datasets"])
    undated = sum(d["zarr_store_count"] or 0 for d in api["datasets"] if not d["zarr_converted_at"])
    per_day, per_day_ds, all_days = Counter(), Counter(), Counter()
    on_fetch_day = 0
    for d in api["datasets"]:
        if not d["zarr_converted_at"] or not d["zarr_store_count"]:
            continue
        t = datetime.strptime(d["zarr_converted_at"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        all_days[str(t.date())] += d["zarr_store_count"]
        if str(t.date()) in wset:
            per_day[str(t.date())] += d["zarr_store_count"]
            per_day_ds[str(t.date())] += 1
        if t.date() == fetch_day:
            on_fetch_day += d["zarr_store_count"]
    w_vals = [per_day.get(k, 0) for k in window]
    active = [v for v in w_vals if v]
    in30 = sum(per_day.values())
    earliest = min(all_days)
    span = (fetch_day - timedelta(days=1) - datetime.fromisoformat(earliest).date()).days + 1
    summ = {
        "fetched_utc": api["fetched_utc"],
        "definition": "stores per day = the zarr_store_count of every dataset whose zarr_converted_at "
                      "(its LAST conversion, read as UTC) falls on that calendar day, summed",
        "window_complete_days_utc": [window[-1], window[0]],
        "stores_credited_to_the_partial_fetch_day_excluded": on_fetch_day,
        "total_stores_all_datasets": total_stores,
        "stores_whose_dataset_last_converted_in_window": in30,
        "stores_whose_dataset_last_converted_earlier": total_stores - in30 - on_fetch_day - undated,
        "stores_without_zarr_converted_at": undated,
        "stores_per_day_over_30_complete_days": {
            "median": statistics.median(w_vals), "p90_linear": pct(w_vals, 90),
            "mean": round(statistics.mean(w_vals), 1), "max": max(w_vals),
            "days_with_conversions": len(active)},
        "stores_per_day_on_days_with_conversions": {
            "median": statistics.median(active) if active else None, "p90_linear": pct(active, 90)},
        "earliest_last_conversion_day": earliest,
        "days_from_earliest_to_last_complete_day_inclusive": span,
        "mean_stores_per_day_over_that_span": round(total_stores / span, 1),
        "per_day_stores_window": {k: per_day[k] for k in sorted(per_day)},
        "per_day_datasets_window": {k: per_day_ds[k] for k in sorted(per_day_ds)},
        "per_day_stores_all_time": dict(sorted(all_days.items())),
        "caveat": "zarr_converted_at is the LAST conversion of a dataset: earlier conversions of a "
                  "re-converted dataset are not visible, every store of a dataset is dated by its "
                  "dataset's last conversion (which inflates bursts and hides earlier days), and the "
                  "series mixes first conversions with re-conversions; version 3 re-conversion "
                  "throughput was not measured",
    }
    jdump(summ, OUT / "throughput.json")
    print(json.dumps({k: v for k, v in summ.items() if not k.startswith("per_day")}, indent=1))
    print("per_day_stores_window:", dict(sorted(per_day.items())))
    print("per_day_stores_all_time:", dict(sorted(all_days.items())))


# ------------------------------------------------------------- zarrcheck
async def stage_zarrcheck(client, net, ids):
    """Keep the full store index of each dataset in the work directory (not committed)."""
    for ds in ids:
        r = await req(net, client, "GET", f"{ZARR}/{ds}/zarr/index.json", timeout=120)
        if r.status_code != 200:
            print(ds, "HTTP", r.status_code)
            continue
        ix = r.json()
        (WORK / f"zarr-index-{ds}.json").write_text(r.text)
        print(ds, "stores", len(ix["stores"]), "discovered", ix.get("discovered_count"),
              "errors", ix.get("errors"), "failure_count", ix.get("failure_count"),
              "format_version", ix.get("format_version"), "engine", ix.get("engine_version"))


async def main():
    global WORK, OUT, ONLY
    stage = sys.argv[1]
    if "--only" in sys.argv:
        ONLY = set(sys.argv[sys.argv.index("--only") + 1].split(","))
    if "--work" in sys.argv:
        WORK = Path(sys.argv[sys.argv.index("--work") + 1])
    if "--out" in sys.argv:
        OUT = Path(sys.argv[sys.argv.index("--out") + 1])
    if stage == "throughput":
        stage_throughput()
        return
    net = Net()
    async with httpx.AsyncClient(headers={"User-Agent": UA},
                                 limits=httpx.Limits(max_connections=CONC * 2)) as client:
        try:
            if stage == "api":
                await stage_api(client, net)
            elif stage == "listing":
                await stage_listing(client, net)
            elif stage == "bv":
                await stage_bv(client, net)
            elif stage == "fif":
                await stage_fif(client, net)
            elif stage == "zarrcheck":
                await stage_zarrcheck(client, net, sys.argv[2].split(","))
            else:
                raise SystemExit(f"unknown stage {stage}")
        except Abort as a:
            print("ABORTED:", a, net.stat)
            sys.exit(3)
    print("requests", net.requests, net.stat)


asyncio.run(main())
