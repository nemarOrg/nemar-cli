"""Read-only catalog scan for EDF+D / BDF+D files (biosigio#180).

Run: uv run --no-project --with httpx python -I scan.py <stage> [--only id1,id2]
Stages: catalog, manifests, heads, deep, report. Results cache in cache.json (resumable).
Only public endpoints are read; nothing is written anywhere but cache.json here.
"""

import asyncio
import json
import os
import subprocess
import sys
import urllib.parse
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache.json"
UA = "nemar-edfd-scan/0.1"
API = "https://api.nemar.org"
DATA = "https://data.nemar.org"
S3 = "https://nemar.s3.us-east-2.amazonaws.com"
CONC = 8
ABORT_STREAK = 8


class Abort(Exception):
    pass


class State:
    def __init__(self):
        if CACHE.exists():
            self.d = json.loads(CACHE.read_text())
        else:
            self.d = {"catalog": None, "manifests": {}, "heads": {}, "deep": {}}
        self.dirty = 0
        self.bad_streak = 0
        self.sem = asyncio.Semaphore(CONC)
        self.requests = 0
        self.stat = {"429": 0, "5xx": 0, "other_fail": 0}

    def save(self):
        tmp = CACHE.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.d))
        os.replace(tmp, CACHE)
        self.dirty = 0

    def touch(self):
        self.dirty += 1
        if self.dirty >= 200:
            self.save()


async def req(st, client, method, url, headers=None, follow=True, tries=4, timeout=60):
    """One polite request with backoff. Returns httpx.Response (body fully read)."""
    last = None
    for attempt in range(tries):
        async with st.sem:
            st.requests += 1
            try:
                r = await client.request(
                    method, url, headers=headers, follow_redirects=follow, timeout=timeout
                )
            except (httpx.HTTPError, OSError) as e:
                last = e
                r = None
        if r is not None and r.status_code != 429 and r.status_code < 500:
            st.bad_streak = 0
            return r
        # failure accounting
        st.bad_streak += 1
        if r is not None and r.status_code == 429:
            st.stat["429"] += 1
        elif r is not None:
            st.stat["5xx"] += 1
        else:
            st.stat["other_fail"] += 1
        if st.bad_streak >= ABORT_STREAK:
            raise Abort(f"{st.bad_streak} consecutive 429/5xx/network failures; last={url}")
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


# ----------------------------------------------------------------- catalog
async def stage_catalog(st, client):
    out = []
    offset = 0
    while True:
        r = await req(st, client, "GET", f"{API}/datasets?limit=100&offset={offset}")
        r.raise_for_status()
        b = r.json()
        for d in b["datasets"]:
            out.append(
                {
                    "id": d["dataset_id"],
                    "visibility": d.get("visibility"),
                    "version": d.get("latest_version"),
                    "zarr_status": d.get("zarr_status"),
                    "zarr_store_count": d.get("zarr_store_count"),
                    "zarr_verify_status": d.get("zarr_verify_status"),
                    "modalities": d.get("modalities"),
                }
            )
        offset += 100
        if offset >= b["total_count"] or not b["datasets"]:
            break
    st.d["catalog"] = {"total_count": b["total_count"], "datasets": out}
    st.save()
    pub = [d for d in out if d["visibility"] == "public"]
    print(f"catalog: {len(out)} listed (api total {b['total_count']}), public {len(pub)}")


# --------------------------------------------------------------- manifests
def is_edf(p):
    return p.lower().endswith((".edf", ".bdf"))


def direct_url(ds, e):
    """Direct public S3 object URL for an annexed file, when derivable, else None."""
    if e.get("key"):
        k = e["key"]
        if k.startswith("git:") or "/" in k:
            return None
        return f"{S3}/{ds}/objects/{k}"
    alg = e.get("alg")
    if alg and alg.lower() == "sha256" and e.get("checksum") and e.get("size") is not None:
        ext = os.path.splitext(e["path"])[1]
        return f"{S3}/{ds}/objects/SHA256E-s{e['size']}--{e['checksum']}{ext}"
    return None


def aws_version_manifest(ds, ver):
    p = subprocess.run(
        ["aws", "s3", "cp", f"s3://nemar/{ds}/version/{ver}.json", "-"],
        capture_output=True,
        timeout=900,
    )
    if p.returncode != 0:
        raise RuntimeError("aws:" + p.stderr.decode(errors="replace")[:200])
    return json.loads(p.stdout)


async def one_manifest(st, client, ds, ver):
    key = f"{ds}/{ver}"
    if key in st.d["manifests"] and st.d["manifests"][key].get("ok"):
        return
    rec = {"ok": False}
    try:
        r = await req(st, client, "GET", f"{DATA}/{ds}/{ver}/manifest.json", timeout=180)
        if r.status_code == 200:
            m = r.json()
            ents = [
                {
                    "path": e["path"],
                    "size": e.get("size"),
                    "alg": e.get("checksum_algorithm"),
                    "checksum": e.get("checksum"),
                }
                for e in m
                if is_edf(e["path"])
            ]
            rec = {"ok": True, "source": "manifest.json", "total": len(m), "entries": ents}
        elif r.status_code == 413:
            doc = await asyncio.to_thread(aws_version_manifest, ds, ver)
            files = doc["files"]
            ents = [
                {"path": p, "size": f.get("size"), "key": f.get("key")}
                for p, f in files.items()
                if is_edf(p)
            ]
            rec = {
                "ok": True,
                "source": "s3-version-manifest",
                "total": len(files),
                "entries": ents,
            }
        else:
            rec = {"ok": False, "reason": f"manifest HTTP {r.status_code}"}
    except Abort:
        raise
    except Exception as e:  # noqa: BLE001
        rec = {"ok": False, "reason": f"{type(e).__name__}: {str(e)[:150]}"}
    st.d["manifests"][key] = rec
    st.touch()


async def stage_manifests(st, client, only):
    ds_list = [d for d in st.d["catalog"]["datasets"] if d["visibility"] == "public"]
    if only:
        ds_list = [d for d in ds_list if d["id"] in only]
    todo = []
    for d in ds_list:
        if not d["version"]:
            st.d["manifests"][f"{d['id']}/-"] = {"ok": False, "reason": "no latest_version"}
            continue
        todo.append(d)
    q = asyncio.Queue()
    for d in todo:
        q.put_nowait(d)

    async def worker():
        while not q.empty():
            d = q.get_nowait()
            await one_manifest(st, client, d["id"], d["version"])

    await asyncio.gather(*[worker() for _ in range(4)])
    st.save()
    ok = sum(1 for d in todo if st.d["manifests"].get(f"{d['id']}/{d['version']}", {}).get("ok"))
    n = sum(
        len(st.d["manifests"][f"{d['id']}/{d['version']}"]["entries"])
        for d in todo
        if st.d["manifests"].get(f"{d['id']}/{d['version']}", {}).get("ok")
    )
    print(f"manifests: {ok}/{len(todo)} ok; EDF/BDF files {n}")



# ------------------------------------------------------------ directory walk
async def walk_dataset(st, client, ds, ver, log):
    """List a dataset through data-plane JSON directory listings (no manifest.json)."""
    ents, total, dirs = [], 0, 0
    q = asyncio.Queue()
    q.put_nowait("")
    pending = 1
    lock = asyncio.Lock()

    async def worker():
        nonlocal total, dirs, pending
        while True:
            try:
                p = await asyncio.wait_for(q.get(), timeout=0.5)
            except asyncio.TimeoutError:
                if pending == 0:
                    return
                continue
            r = await req(st, client, "GET", f"{DATA}/{ds}/{ver}/{enc(p)}" + ("/" if p else ""),
                          timeout=90)
            if r.status_code != 200:
                raise RuntimeError(f"dir {p!r} HTTP {r.status_code}")
            b = r.json()
            dirs += 1
            for c in b["children"]:
                cp = f"{p}/{c['name']}" if p else c["name"]
                if c["kind"] == "dir":
                    async with lock:
                        pending += 1
                    q.put_nowait(cp)
                else:
                    total += 1
                    if is_edf(cp):
                        ents.append({"path": cp, "size": c.get("size")})
            async with lock:
                pending -= 1
            if dirs % 500 == 0:
                log(f"  walk {ds} dirs={dirs} files={total}")

    await asyncio.gather(*[worker() for _ in range(CONC)])
    return {"ok": True, "source": "dir-walk", "total": total, "dirs": dirs, "entries": ents}


async def stage_walk(st, client, only):
    targets = [k for k, m in st.d["manifests"].items()
               if not m.get("ok") and "aws:" in m.get("reason", "")]
    if only:
        targets = [k for k in targets if k.split("/")[0] in only]
    print("walk targets:", targets)
    for key in targets:
        ds, ver = key.split("/", 1)
        try:
            rec = await walk_dataset(st, client, ds, ver, lambda s: print(s, flush=True))
        except Abort:
            raise
        except Exception as ex:  # noqa: BLE001
            rec = {"ok": False, "reason": f"walk {type(ex).__name__}: {str(ex)[:150]}"}
        st.d["manifests"][key] = rec
        st.save()
        print(key, rec.get("source"), rec.get("ok"), rec.get("total"), len(rec.get("entries", [])),
              rec.get("reason", ""), flush=True)


# ------------------------------------------------------------ GitHub tree listing
def gh_tree(ref, recursive):
    url = f"repos/nemarDatasets/{ref[0]}/git/trees/{ref[1]}" + ("?recursive=1" if recursive else "")
    import time
    for attempt in range(6):
        p = subprocess.run(["gh", "api", url], capture_output=True, timeout=120)
        if p.returncode == 0:
            return json.loads(p.stdout)
        time.sleep(2 ** attempt)
    raise RuntimeError("gh:" + p.stderr.decode(errors="replace")[:200])


def list_tree(ds, sha, prefix, out, calls):
    """Collect blob paths; recurse per subtree when the recursive listing is truncated."""
    calls[0] += 1
    b = gh_tree((ds, sha), True)
    if not b.get("truncated"):
        for n in b["tree"]:
            if n["type"] == "blob":
                out.append(prefix + n["path"])
        return
    calls[0] += 1
    b = gh_tree((ds, sha), False)
    if b.get("truncated"):
        raise RuntimeError(f"flat tree truncated at {prefix!r}")
    for n in b["tree"]:
        if n["type"] == "blob":
            out.append(prefix + n["path"])
        elif n["type"] == "tree":
            list_tree(ds, n["sha"], prefix + n["path"] + "/", out, calls)


async def stage_tree(st, client, only):
    targets = [k for k, m in st.d["manifests"].items()
               if not m.get("ok") and ("aws:" in m.get("reason", "") or "walk" in m.get("reason", "") or "tree " in m.get("reason", ""))]
    if only:
        targets = [k for k in targets if k.split("/")[0] in only]
    print("tree targets:", targets, flush=True)
    for key in targets:
        ds, ver = key.split("/", 1)
        out, calls = [], [0]
        try:
            await asyncio.to_thread(list_tree, ds, ver, "", out, calls)
            ents = [{"path": p, "size": None} for p in out if is_edf(p)]
            rec = {"ok": True, "source": "github-tree", "total": len(out), "entries": ents,
                   "gh_calls": calls[0]}
        except Exception as ex:  # noqa: BLE001
            rec = {"ok": False, "reason": f"tree {type(ex).__name__}: {str(ex)[:150]}"}
        st.d["manifests"][key] = rec
        st.save()
        print(key, rec.get("source"), rec.get("ok"), rec.get("total"), len(rec.get("entries", [])),
              rec.get("gh_calls"), rec.get("reason", ""), flush=True)

# ------------------------------------------------------------------- reads
def all_files(st, only=None):
    cat = {d["id"]: d for d in st.d["catalog"]["datasets"]}
    for key, m in st.d["manifests"].items():
        if not m.get("ok"):
            continue
        ds, ver = key.split("/", 1)
        if ds not in cat or cat[ds]["visibility"] != "public" or cat[ds]["version"] != ver:
            continue
        if only and ds not in only:
            continue
        for e in m["entries"]:
            yield ds, ver, e


class Reader:
    """Resolve a readable URL for a file once, then Range-read it."""

    def __init__(self, st, client):
        self.st, self.client = st, client
        self.urls = {}
        self.sizes = {}
        self.raw_sem = asyncio.Semaphore(3)

    async def read(self, ds, ver, e, start, end):
        """Return bytes [start, end] inclusive, or raise."""
        k = (ds, ver, e["path"])
        cands = []
        if k not in self.urls and not direct_url(ds, e) and e.get("size") is None \
                and "annexkey" not in e:
            # tree-listed file: the git-annex symlink blob names the object key (raw GitHub,
            # not the Worker), which gives the direct S3 URL and the size.
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
            import re
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
            cands.append(None)  # data plane
        if None not in cands:
            cands.append(None)  # data plane as the last resort
        for u in cands:
            if u is None:
                dp = f"{DATA}/{ds}/{ver}/{enc(e['path'])}"
                r = await req(self.st, self.client, "GET", dp, follow=False,
                              headers={"Range": f"bytes={start}-{end}"})
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
                    body = body[start : end + 1]
                return body
            if u is not None and r.status_code in (403, 404):
                self.urls.pop(k, None)
                continue  # try the data plane
            raise RuntimeError(f"HTTP {r.status_code}")
        raise RuntimeError("no readable URL")


def parse_head(b):
    s = lambda a, z: b[a:z].decode("latin-1")  # noqa: E731
    res = s(192, 236)
    out = {
        "version": s(0, 8).strip(),
        "reserved": res.strip(),
        "nrec": s(236, 244).strip(),
        "dur": s(244, 252).strip(),
        "ns": s(252, 256).strip(),
    }
    return out


def category(reserved, ext):
    r = reserved.strip().upper()
    if r.startswith("EDF+C"):
        return "EDF+C"
    if r.startswith("EDF+D"):
        return "EDF+D"
    if r.startswith("BDF+C"):
        return "BDF+C"
    if r.startswith("BDF+D"):
        return "BDF+D"
    if r.startswith("EDF+") or r.startswith("BDF+"):
        return "plus-other"
    return "plain"


async def stage_heads(st, client, only):
    rd = Reader(st, client)
    todo = [(ds, ver, e) for ds, ver, e in all_files(st, only)
            if f"{ds}/{ver}/{e['path']}" not in st.d["heads"]
            or not st.d["heads"][f"{ds}/{ver}/{e['path']}"].get("ok")]
    print(f"heads: {len(todo)} to read")
    q = asyncio.Queue()
    for t in todo:
        q.put_nowait(t)
    done = 0

    async def worker():
        nonlocal done
        while not q.empty():
            ds, ver, e = q.get_nowait()
            key = f"{ds}/{ver}/{e['path']}"
            try:
                if e.get("size") is not None and e["size"] < 256:
                    rec = {"ok": True, "cat": "too-small", "size": e["size"]}
                else:
                    b = await rd.read(ds, ver, e, 0, 255)
                    if len(b) < 256:
                        rec = {"ok": True, "cat": "too-small", "size": e.get("size")}
                    else:
                        h = parse_head(b)
                        rec = {"ok": True, "cat": category(h["reserved"], e["path"]),
                               "size": e.get("size") if e.get("size") is not None
                               else rd.sizes.get((ds, ver, e["path"])), **h}
            except Abort:
                raise
            except Exception as ex:  # noqa: BLE001
                rec = {"ok": False, "reason": f"{type(ex).__name__}: {str(ex)[:120]}"}
            st.d["heads"][key] = rec
            st.touch()
            done += 1
            if done % 1000 == 0:
                print(f"  heads {done}/{len(todo)} requests={st.requests} stat={st.stat}",
                      flush=True)

    try:
        await asyncio.gather(*[worker() for _ in range(CONC)])
    finally:
        st.save()
    tally(st, only)


def tally(st, only=None):
    from collections import Counter

    c = Counter()
    fail = 0
    for ds, ver, e in all_files(st, only):
        h = st.d["heads"].get(f"{ds}/{ver}/{e['path']}")
        if not h:
            c["unread"] += 1
        elif not h.get("ok"):
            fail += 1
        else:
            c[(e["path"].lower()[-3:], h["cat"])] += 1
    print("tally:", dict(c), "failed:", fail)


# -------------------------------------------------------------------- deep
def parse_tal_onset(buf):
    """Onset (float seconds) of the first TAL in an annotation signal's bytes, or None."""
    i = buf.find(b"\x14")
    if i <= 0:
        return None
    head = buf[:i]
    j = head.find(b"\x15")
    if j >= 0:
        head = head[:j]
    try:
        txt = head.decode("ascii")
        if txt[0] not in "+-":
            return None
        return float(txt)
    except (UnicodeDecodeError, ValueError):
        return None


async def deep_one(st, rd, ds, ver, e, h):
    bps = 3 if e["path"].lower().endswith(".bdf") else 2
    ns = int(h["ns"])
    hdr_len = 256 + 256 * ns
    size = h.get("size") or e.get("size")
    hb = await rd.read(ds, ver, e, 0, hdr_len - 1)
    lab = lambda i: hb[256 + 16 * i : 256 + 16 * (i + 1)].decode("latin-1").strip()  # noqa: E731
    nsoff = 256 + 216 * ns
    nsamp = [int(hb[nsoff + 8 * i : nsoff + 8 * (i + 1)].decode("latin-1").strip())
             for i in range(ns)]
    labels = [lab(i) for i in range(ns)]
    ann = [i for i, l in enumerate(labels) if l in ("EDF Annotations", "BDF Annotations")]
    dur = float(h["dur"])
    rec_bytes = sum(nsamp) * bps
    nrec = int(h["nrec"])
    nrec_hdr = nrec
    if nrec < 0:
        nrec = (size - hdr_len) // rec_bytes
    out = {"ok": True, "ns": ns, "nrec": nrec, "nrec_header": nrec_hdr, "rec_dur": dur,
           "rec_bytes": rec_bytes, "size": size, "ann_signals": len(ann)}
    if not ann:
        out["ok"] = False
        out["reason"] = "no annotation signal"
        return out
    a = ann[0]
    off_in = sum(nsamp[:a]) * bps
    alen = nsamp[a] * bps
    onsets = []
    if size <= 12_000_000:
        body = await rd.read(ds, ver, e, hdr_len, size - 1) if size > hdr_len else b""
        for k in range(nrec):
            s = k * rec_bytes + off_in
            onsets.append(parse_tal_onset(body[s : s + alen]))
        out["mode"] = "whole-file"
    else:
        # Large file: TAL onsets are non-decreasing, so onset[j]-onset[i] == (j-i)*dur proves
        # records i..j contiguous. Bisect only the spans that fail that test.
        memo = {}
        reads = [0]

        async def on(k):
            if k not in memo:
                s0 = hdr_len + k * rec_bytes + off_in
                reads[0] += 1
                memo[k] = parse_tal_onset(await rd.read(ds, ver, e, s0, s0 + alen - 1))
            return memo[k]

        found = []
        bad = [0]
        truncated = [False]

        async def bis(i, j):
            if truncated[0]:
                return
            oi, oj = await on(i), await on(j)
            if oi is None or oj is None:
                bad[0] += 1
                return
            if abs((oj - oi) - (j - i) * dur) <= 1e-6:
                return
            if j == i + 1:
                found.append((i, oi, oj))
                return
            if reads[0] > 6000 or len(found) > 500:
                truncated[0] = True
                return
            m = (i + j) // 2
            await bis(i, m)
            await bis(m, j)

        if nrec >= 2:
            await bis(0, nrec - 1)
        found.sort()
        out["mode"] = "bisect"
        out["reads"] = reads[0]
        out["truncated"] = truncated[0]
        out["bisect_unparsed"] = bad[0]
        onsets = None
    if onsets is None:
        gaps = [[k, round(a0, 6), round(a1, 6), round(a1 - a0 - dur, 6)] for k, a0, a1 in found]
        out["unparsed_onsets"] = out.pop("bisect_unparsed")
        o0, o1 = memo.get(0), memo.get(nrec - 1)
    else:
        out["unparsed_onsets"] = sum(1 for o in onsets if o is None)
        gaps = []
        for k in range(len(onsets) - 1):
            a0, a1 = onsets[k], onsets[k + 1]
            if a0 is None or a1 is None:
                continue
            d = a1 - a0 - dur
            if abs(d) > 1e-6:
                gaps.append([k, round(a0, 6), round(a1, 6), round(d, 6)])
        o0, o1 = (onsets[0], onsets[-1]) if onsets else (None, None)
    out["size_matches"] = (size == hdr_len + nrec * rec_bytes)
    out["gap_count"] = len(gaps)
    out["gap_total_s"] = round(sum(g[3] for g in gaps), 6)
    out["gap_pos_s"] = round(sum(g[3] for g in gaps if g[3] > 0), 6)
    out["gap_neg_count"] = sum(1 for g in gaps if g[3] < 0)
    out["first_gaps"] = gaps[:5]
    out["first_onset"] = o0
    out["last_onset"] = o1
    return out


async def stage_deep(st, client, only):
    rd = Reader(st, client)
    todo = []
    for ds, ver, e in all_files(st, only):
        key = f"{ds}/{ver}/{e['path']}"
        h = st.d["heads"].get(key)
        if h and h.get("ok") and h["cat"] in ("EDF+D", "BDF+D"):
            if key not in st.d["deep"] or not st.d["deep"][key].get("ok"):
                todo.append((ds, ver, e, h, key))
    todo.sort(key=lambda t: t[3].get("size") or 0)
    print(f"deep: {len(todo)} +D files to analyze")
    q = asyncio.Queue()
    for t in todo:
        q.put_nowait(t)

    async def worker():
        while not q.empty():
            ds, ver, e, h, key = q.get_nowait()
            try:
                rec = await deep_one(st, rd, ds, ver, e, h)
            except Abort:
                raise
            except Exception as ex:  # noqa: BLE001
                rec = {"ok": False, "reason": f"{type(ex).__name__}: {str(ex)[:150]}"}
            st.d["deep"][key] = rec
            st.touch()

    try:
        await asyncio.gather(*[worker() for _ in range(CONC)])
    finally:
        st.save()
    print("deep done; requests", st.requests)


# ------------------------------------------------------------------ report
def report(st):
    cat = {d["id"]: d for d in st.d["catalog"]["datasets"]}
    rows = []
    for key, r in sorted(st.d["deep"].items()):
        ds, ver, path = key.split("/", 2)
        rows.append((ds, ver, path, r))
    for ds, ver, path, r in rows:
        c = cat[ds]
        print(ds, ver, path, json.dumps({k: r.get(k) for k in
              ("ok", "reason", "size", "nrec", "rec_dur", "gap_count", "gap_total_s",
               "gap_pos_s", "gap_neg_count", "unparsed_onsets", "mode")}),
              "zarr=", c["zarr_status"], c["zarr_store_count"])


async def main():
    stage = sys.argv[1]
    only = None
    if "--only" in sys.argv:
        only = set(sys.argv[sys.argv.index("--only") + 1].split(","))
    st = State()
    if stage == "report":
        report(st)
        return
    if stage == "tally":
        tally(st, only)
        return
    async with httpx.AsyncClient(headers={"User-Agent": UA},
                                 limits=httpx.Limits(max_connections=CONC * 2)) as client:
        try:
            if stage == "catalog":
                await stage_catalog(st, client)
            elif stage == "manifests":
                await stage_manifests(st, client, only)
            elif stage == "tree":
                await stage_tree(st, client, only)
            elif stage == "walk":
                await stage_walk(st, client, only)
            elif stage == "heads":
                await stage_heads(st, client, only)
            elif stage == "deep":
                await stage_deep(st, client, only)
        except Abort as a:
            st.save()
            print("ABORTED:", a, "stat", st.stat)
            sys.exit(3)
    print("requests", st.requests, "stat", st.stat)


asyncio.run(main())
