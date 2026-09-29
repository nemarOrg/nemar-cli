#!/usr/bin/env python3
"""Find published Zarr stores that lost channels to a repeated label. READ-ONLY.

Before biosigio 1.2.9 a channel label the source file repeated (CHB-MIT's
`T8-P8`, its `-` placeholders for unused inputs) overwrote an earlier channel
on the in-memory import path, because a Recording is keyed by label. The store
then held FEWER channels than the file: nm000110 serves 22 of 23. The
streaming EDF path kept every channel but wrote the repeated label as is, so a
consumer that keys channels by label collapses them instead. biosigio 1.2.9
suffixes repeats MNE-style (`T8-P8-0`, `T8-P8-1`) and the converter's
channel-count gate now reads the file header for every recording, so neither
can be published again. This script finds the stores published before that.

What it flags, per store in a dataset's published `index.json`:

* ``short_of_channels_tsv``: the store's channel count (summed over its
  groups, exactly as `store_total_channels` sums them) is below the row count
  of the recording's channels.tsv (counted exactly as the converter's gate
  counts it, `channels_tsv_row_count`). A store whose index entry already
  carries `channels_tsv_count_mismatch` is NOT flagged: the gate compared it
  to the file's own header and found the SIDECAR over-declares, so the store
  is faithful. It is counted as ``sidecar_overcount`` instead.
* ``short_of_file_header``: the store's channel count is below
  ``recording_metadata.number_of_signals`` in the store's root `zarr.json`,
  the signal count the importer read from the file header BEFORE its
  label-keyed collapse (verified on a biosigio 1.2.8 store built from a
  CHB-MIT-shaped EDF: `number_of_signals` 6, four channels served). It is
  independent of channels.tsv, so it finds a collapsed store that shipped
  with no sidecar, or with a sidecar that collapsed the same way. It is a
  WHERE-PRESENT check: the EDF/BDF, MNE (BrainVision, FIF, ...), neo and
  streaming paths record the key, while the EEGLAB importer does not, and a
  store without it is counted under ``no_header_count``.
* ``repeated_labels``: the channel labels the store's groups record repeat a
  label (read from each group's `zarr.json`). Only checked for EDF/BDF
  sources by default (`--labels`), the formats that can carry a repeated
  label into the store; every other importer either rejects a repeat or
  renames it.

The data file itself is never downloaded. A store with neither witness (no
channels.tsv and no `number_of_signals`) cannot be checked for a short count
at all; it is reported as ``unwitnessed``, never as clean, and makes the run
exit 2 if nothing else is flagged.

Safety
------
* Reads only, over public HTTPS: `<zarr-base>/<id>/zarr/index.json`, each
  store's root `zarr.json` (one GET per store, for `number_of_signals`) and
  its group `zarr.json` files for the label check, and each recording's
  channels.tsv from `raw.githubusercontent.com/nemarDatasets/<id>/<commit>/`
  at the commit the index was BUILT from (`source_commit`). No S3
  credentials, no GitHub token, no writes anywhere, no queue access.
* `--repo-dir` reads channels.tsv from a local clone of ONE dataset instead,
  with the converter's own BIDS-inheritance resolution (`channels_tsv_for`)
  over the tree at `source_commit`. Without it the sidecar is resolved
  nearest-first over the four placements real datasets use (the same bounded
  list the backend's fidelity sweep uses), which can miss an unusual one; a
  miss is counted under ``no_channels_tsv``, and a store with no header count
  either is ``unwitnessed``, never clean.
* Never run it from CI against production. It is for a maintainer, by hand.

Usage
-----
    python3 scripts/zarr/find_collapsed_channel_stores.py --dataset nm000110
    python3 scripts/zarr/find_collapsed_channel_stores.py --dataset nm000110 \\
        --repo-dir ~/datasets/nm000110
    python3 scripts/zarr/find_collapsed_channel_stores.py --all --out report.json

Exit status: 0 nothing flagged and every dataset and store checked, 1
something flagged, 2 nothing flagged but at least one dataset could not be
checked, at least one store had no witness to check it against, or (with
`--all`) the catalog walk was incomplete or failed outright. A dataset is
unchecked when its index could not be read OR when any one of its stores could
not be (a 429 or 5xx that outlived the retries, a malformed group): unchecked
is never reported as clean. The same goes for the catalog: a walk that saw only
some of its pages checked a subset of the archive, and the report says so in
`summary.catalog_complete` (always true for explicit `--dataset` ids, which
walk nothing).

What follows a finding is a re-conversion under biosigio >= 1.2.9, which the
report spells out per dataset (`requeue`): on the conversion host,
`zarr_queue.py --db <queue db> requeue --status done --dataset <id> --execute`
(the next cron tick rebuilds it), or `hallu-zarr.sh --dataset <id>` for one now.
That requeue is what replaces a bad store; nothing else does. The fidelity
gate only stops a NEW short store from being uploaded, and `--clean`
reconciles rather than wiping (ADR 0023), so a flagged store stays published
until a good re-conversion overwrites it.
"""

from __future__ import annotations

import argparse
import contextlib
import email.utils
import http.client
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import TypedDict

sys.path.insert(0, str(Path(__file__).resolve().parent))

from generate_zarr import (  # type: ignore[import-not-found]
    DEFAULT_CONTRACT_BASE,
    _decode_sidecar_text,
    channels_tsv_for,
    channels_tsv_row_count,
    is_commit_sha,
    store_total_channels,
)

REPORT_FORMAT = "nemar-zarr-collapsed-channel-report"
REPORT_FORMAT_VERSION = 1
GITHUB_RAW_BASE = "https://raw.githubusercontent.com"
DATASET_ORG = "nemarDatasets"
DEFAULT_API_BASE = "https://api.nemar.org"
# Cloudflare 403s the default Python-urllib User-Agent; see generate_zarr.USER_AGENT.
USER_AGENT = "nemar-zarr-collapsed-channel-check/1.0 (+https://github.com/nemarOrg/nemar-cli)"
# The source formats whose labels can reach a store repeated (see module doc).
REPEATABLE_LABEL_EXTS = (".edf", ".bdf")
# Seconds before the n-th retry of a transient failure is `n * RETRY_BACKOFF_S`,
# unless the host said how long to wait (`Retry-After`, capped below).
RETRY_BACKOFF_S = 2.0
RETRY_AFTER_MAX_S = 300.0
# Minimum spacing between requests under `--all` (`--request-interval`), which
# walks every public dataset against raw.githubusercontent.com and the zarr host.
ALL_REQUEST_INTERVAL_S = 0.1


class Finding(TypedDict, total=False):
    dataset: str
    recording: str
    zarr: str
    store_channels: int
    header_channels: int | None
    tsv_channels: int | None
    channels_tsv: str | None
    reasons: list[str]
    repeated_labels: list[str]


# --- Pure --------------------------------------------------------------------


def sidecar_candidates(recording_path: str, suffix: str = "channels.tsv") -> list[str]:
    """Nearest-first sidecar paths for one recording: its own directory with
    its full entities, the session directory, the subject directory, the
    dataset root. A port of the backend's `bidsSidecarCandidates`
    (zarr-fidelity-sweep.ts), used only when no local clone is given."""
    parts = [p for p in recording_path.split("/") if p]
    if not parts:
        return [suffix]
    filename = parts[-1]
    directory = "/".join(parts[:-1])
    dot = filename.rfind(".")
    stem = filename[:dot] if dot > 0 else filename
    entities = [t for t in stem.split("_")[:-1] if "-" in t]
    subject = next((t for t in entities if t.startswith("sub-")), None)
    session = next((t for t in entities if t.startswith("ses-")), None)
    subject_dir = parts[0] if parts[0].startswith("sub-") else None
    session_dir = (
        f"{parts[0]}/{parts[1]}"
        if subject_dir and len(parts) > 1 and parts[1].startswith("ses-")
        else None
    )
    out: list[str] = []

    def add(where: str, ents: list[str]) -> None:
        name = f"{'_'.join(ents)}_{suffix}" if ents else suffix
        path = f"{where}/{name}" if where else name
        if path not in out:
            out.append(path)

    add(directory, entities)
    if session_dir and subject and session:
        add(session_dir, [subject, session])
    if subject_dir and subject:
        add(subject_dir, [subject])
    add("", [])
    return out


def repeated_labels(labels: list[str]) -> list[str]:
    """Every label that occurs more than once, in first-occurrence order."""
    counts = Counter(labels)
    return [label for label in dict.fromkeys(labels) if counts[label] > 1]


def wants_label_check(recording_path: str, mode: str) -> bool:
    if mode == "all":
        return True
    if mode == "none":
        return False
    return recording_path.lower().endswith(REPEATABLE_LABEL_EXTS)


def header_signal_count(root_attrs: dict) -> int | None:
    """``recording_metadata.number_of_signals`` from a store's root attributes:
    the file header's signal count as the importer read it, before anything
    was keyed by label. None when the store does not record it."""
    meta = root_attrs.get("recording_metadata")
    count = meta.get("number_of_signals") if isinstance(meta, dict) else None
    if isinstance(count, bool) or not isinstance(count, int) or count <= 0:
        return None
    return count


def classify_store(
    dataset_id: str,
    entry: dict,
    tsv_channels: int | None,
    channels_tsv: str | None,
    labels: list[str] | None,
    header_channels: int | None = None,
) -> tuple[str, Finding | None]:
    """One store's verdict and, when flagged, its finding.

    Verdicts: ``flagged``, ``sidecar_overcount`` (short of channels.tsv but
    the converter's gate matched it to the file header), ``unwitnessed``
    (neither a channels.tsv nor a header count to compare against, and no
    repeated label seen), ``ok``.
    """
    store_channels = store_total_channels(entry)
    reasons: list[str] = []
    overcount = False
    if header_channels and store_channels < header_channels:
        reasons.append("short_of_file_header")
    if tsv_channels and store_channels < tsv_channels:
        if isinstance(entry.get("channels_tsv_count_mismatch"), dict):
            overcount = True
        else:
            reasons.append("short_of_channels_tsv")
    repeats = repeated_labels(labels) if labels is not None else []
    if repeats:
        reasons.append("repeated_labels")
    if reasons:
        finding: Finding = {
            "dataset": dataset_id,
            "recording": str(entry.get("path", "")),
            "zarr": str(entry.get("zarr", "")),
            "store_channels": store_channels,
            "header_channels": header_channels,
            "tsv_channels": tsv_channels,
            "channels_tsv": channels_tsv,
            "reasons": reasons,
        }
        if repeats:
            finding["repeated_labels"] = repeats
        return "flagged", finding
    if overcount:
        return "sidecar_overcount", None
    if not tsv_channels and not header_channels:
        return "unwitnessed", None
    return "ok", None


def requeue_commands(dataset_id: str) -> list[str]:
    """What a maintainer runs on the conversion host once a dataset is
    flagged. Printed, never executed."""
    return [
        (
            "python3 scripts/zarr/zarr_queue.py --db <queue db> requeue --status done "
            f"--dataset {dataset_id} --execute"
        ),
        f"./scripts/zarr/hallu-zarr.sh --dataset {dataset_id}",
    ]


def is_unchecked(result: dict) -> bool:
    """A dataset is unchecked when it could not be read at all (`error`) OR
    when any one of its stores could not be (`unreadable_stores`). Unchecked
    is never clean: a store the run could not read is a store it cannot vouch
    for, whatever the rest of the dataset looked like."""
    return bool(result.get("error")) or bool(result.get("unreadable_stores"))


def summarize(results: list[dict], catalog_complete: bool = True) -> dict:
    """`catalog_complete` is False when `--all` did not see the whole catalog:
    the datasets in `results` are then a subset of the archive, and a run that
    found nothing in them has not shown the archive clean."""
    flagged = [r for r in results if r.get("findings")]
    unchecked = [r for r in results if is_unchecked(r)]
    return {
        "catalog_complete": catalog_complete,
        "datasets_checked": len(results) - len(unchecked),
        "datasets_unchecked": len(unchecked),
        "datasets_flagged": len(flagged),
        "stores_checked": sum(
            r.get("stores", 0) - r.get("unreadable_stores", 0) for r in results
        ),
        "stores_unreadable": sum(r.get("unreadable_stores", 0) for r in results),
        "stores_flagged": sum(len(r.get("findings", [])) for r in results),
        "stores_sidecar_overcount": sum(r.get("sidecar_overcount", 0) for r in results),
        "stores_without_channels_tsv": sum(r.get("no_channels_tsv", 0) for r in results),
        "stores_without_header_count": sum(r.get("no_header_count", 0) for r in results),
        "stores_unwitnessed": sum(r.get("unwitnessed", 0) for r in results),
    }


def exit_status(summary: dict) -> int:
    """1 when anything is flagged; else 2 when any dataset went unchecked, any
    store had no witness, or the catalog walk behind `--all` was incomplete;
    else 0."""
    if summary["stores_flagged"]:
        return 1
    if (
        summary["datasets_unchecked"]
        or summary["stores_unwitnessed"]
        or not summary.get("catalog_complete", True)
    ):
        return 2
    return 0


# --- I/O ---------------------------------------------------------------------


class NotFound(Exception):
    """A 404: the object is not there, which is an answer, not an error."""


def retry_after_seconds(value: str | None, now: float | None = None) -> float | None:
    """A `Retry-After` header as seconds to wait, capped at RETRY_AFTER_MAX_S,
    or None when absent or unparseable. It is either delta-seconds or an
    HTTP-date (RFC 9110 10.2.3); a date in the past means no wait."""
    if value is None or not value.strip():
        return None
    value = value.strip()
    if value.isdigit():
        seconds = float(value)
    else:
        try:
            when = email.utils.parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return None
        if when.tzinfo is None:
            return None
        seconds = when.timestamp() - (time.time() if now is None else now)
    return min(max(seconds, 0.0), RETRY_AFTER_MAX_S)


class Pacer:
    """Spaces successive requests at least `interval` seconds apart."""

    def __init__(self, interval: float = 0.0):
        self.interval = interval
        self._last: float | None = None

    def wait(self) -> None:
        if self.interval > 0 and self._last is not None:
            delay = self._last + self.interval - time.monotonic()
            if delay > 0:
                time.sleep(delay)
        self._last = time.monotonic()


# Every GET this script makes goes through this one pacer; `main` sets its
# interval (non-zero by default under `--all`).
PACER = Pacer()


def http_get(url: str, *, timeout: int = 60, attempts: int = 3) -> bytes:
    """GET `url`. Raises NotFound on 404; retries a 429, a 5xx or a network
    failure, waiting what a 429/503 `Retry-After` asks for when it says."""
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        wait = RETRY_BACKOFF_S * attempt
        PACER.wait()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise NotFound(url) from exc
            if exc.code < 500 and exc.code != 429:
                raise
            last = exc
            if exc.code in (429, 503):
                asked = retry_after_seconds(exc.headers.get("Retry-After"))
                if asked is not None:
                    wait = asked
        # `http.client.HTTPException` (RemoteDisconnected, BadStatusLine) is not
        # wrapped by urllib and is as transient as a 503.
        except (
            urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException,
        ) as exc:
            last = exc
        if attempt < attempts:
            time.sleep(wait)
    assert last is not None
    raise last


def http_get_json(url: str) -> dict:
    doc = json.loads(http_get(url).decode("utf-8"))
    if not isinstance(doc, dict):
        raise TypeError(f"{url} is not a JSON object")
    return doc


def store_root_attrs(zarr_base: str, dataset_id: str, entry: dict) -> dict:
    """A published store's root `zarr.json` attributes."""
    url = _join(zarr_base, dataset_id, "zarr", entry["zarr"], "zarr.json")
    attrs = http_get_json(url).get("attributes")
    return attrs if isinstance(attrs, dict) else {}


def store_labels(zarr_base: str, dataset_id: str, entry: dict) -> list[str]:
    """Every channel label a published store records, across its groups, in
    store order. A list, so a repeat stays visible."""
    labels: list[str] = []
    for group in entry.get("groups") or []:
        name = group.get("name") if isinstance(group, dict) else None
        if not name:
            continue
        url = _join(zarr_base, dataset_id, "zarr", entry["zarr"], name, "zarr.json")
        attrs = http_get_json(url).get("attributes") or {}
        labels.extend(
            str(ch.get("label", "")) for ch in attrs.get("channels") or [] if isinstance(ch, dict)
        )
    return labels


def _join(base: str, *parts: str) -> str:
    return "/".join([base.rstrip("/"), *(urllib.parse.quote(p.strip("/")) for p in parts)])


class TsvReader:
    """channels.tsv for a recording at the commit its store was built from:
    from a local clone (`repo_dir`) with the converter's own resolution, or
    over public HTTPS nearest-first. Returns (path, row count) or (None, None).
    Caches per path, since a dataset-level sidecar serves many recordings."""

    def __init__(self, dataset_id: str, commit: str, raw_base: str, repo_dir: str | None):
        self.dataset_id = dataset_id
        self.commit = commit
        self.raw_base = raw_base
        self.repo_dir = repo_dir
        self.cache: dict[str, int | None] = {}
        self.head_files: set[str] | None = None
        if repo_dir:
            self.head_files = set(
                subprocess.check_output(
                    ["git", "-C", repo_dir, "ls-tree", "-r", "--name-only", commit], text=True
                ).splitlines()
            )

    def rows(self, recording_path: str) -> tuple[str | None, int | None]:
        if self.repo_dir is not None and self.head_files is not None:
            path = channels_tsv_for(recording_path, self.head_files)
            if path is None:
                return None, None
            if path not in self.cache:
                # At the commit, never the working tree: the clone may have
                # moved on since the store was built.
                raw = subprocess.check_output(
                    ["git", "-C", self.repo_dir, "cat-file", "blob", f"{self.commit}:{path}"]
                )
                self.cache[path] = channels_tsv_row_count(_decode_sidecar_text(raw, path))
            return path, self.cache[path]
        for path in sidecar_candidates(recording_path):
            if path not in self.cache:
                url = _join(self.raw_base, DATASET_ORG, self.dataset_id, self.commit, path)
                try:
                    # The same decode as the --repo-dir path and the converter:
                    # a UTF-16 sidecar read as UTF-8 grows a phantom NUL row.
                    self.cache[path] = channels_tsv_row_count(
                        _decode_sidecar_text(http_get(url), path)
                    )
                except NotFound:
                    self.cache[path] = None
            if self.cache[path] is not None:
                return path, self.cache[path]
        return None, None


def check_dataset(
    dataset_id: str,
    *,
    zarr_base: str,
    raw_base: str,
    repo_dir: str | None,
    labels_mode: str,
) -> dict:
    """One dataset's result. Never raises for a dataset-level problem: the
    reason lands in `error` and the dataset counts as unchecked."""
    result: dict = {"dataset": dataset_id, "stores": 0, "findings": []}
    try:
        index = http_get_json(_join(zarr_base, dataset_id, "zarr", "index.json"))
    except NotFound:
        result["error"] = "no_index"
        return result
    except Exception as exc:  # noqa: BLE001 - one dataset must not stop the run
        result["error"] = f"index_unreadable: {type(exc).__name__}: {exc}"
        return result
    commit = index.get("source_commit")
    if not isinstance(commit, str) or not commit:
        result["error"] = "index_has_no_source_commit"
        return result
    # The commit reaches `git ls-tree`/`git cat-file` argv and raw-GitHub URLs,
    # so it must be exactly what the converter writes (`merge_index` refuses
    # anything else): 40 lowercase hex. A value like `--output=...` from a
    # hostile or corrupt index would otherwise be read by git as an option.
    if not is_commit_sha(commit):
        result["error"] = "index_source_commit_not_a_sha"
        return result
    result["source_commit"] = commit
    try:
        tsv = TsvReader(dataset_id, commit, raw_base, repo_dir)
    except (subprocess.CalledProcessError, OSError) as exc:
        result["error"] = f"repo_dir_unreadable_at_{commit[:12]}: {exc}"
        return result
    counts: Counter[str] = Counter()
    for entry in index.get("stores") or []:
        if not isinstance(entry, dict) or not isinstance(entry.get("zarr"), str):
            continue
        result["stores"] += 1
        recording = str(entry.get("path", ""))
        try:
            path, rows = tsv.rows(recording)
            header = header_signal_count(store_root_attrs(zarr_base, dataset_id, entry))
            labels = (
                store_labels(zarr_base, dataset_id, entry)
                if wants_label_check(recording, labels_mode)
                else None
            )
        except Exception as exc:  # noqa: BLE001 - record and keep going
            counts["unreadable"] += 1
            result.setdefault("store_errors", []).append(
                {"recording": recording, "error": f"{type(exc).__name__}: {exc}"}
            )
            continue
        verdict, finding = classify_store(dataset_id, entry, rows, path, labels, header)
        counts[verdict] += 1
        counts["no_channels_tsv"] += 0 if rows else 1
        counts["no_header_count"] += 0 if header else 1
        if finding is not None:
            result["findings"].append(finding)
    result["sidecar_overcount"] = counts["sidecar_overcount"]
    result["no_channels_tsv"] = counts["no_channels_tsv"]
    result["no_header_count"] = counts["no_header_count"]
    result["unwitnessed"] = counts["unwitnessed"]
    result["unreadable_stores"] = counts["unreadable"]
    if result["findings"]:
        result["requeue"] = requeue_commands(dataset_id)
    return result


def list_public_dataset_ids(api_base: str) -> tuple[list[str], bool]:
    """Every public catalog id, via the same paginated walk the queue uses, and
    whether the walk saw every page. An incomplete walk still returns the ids
    it saw: they are worth checking, but the caller must not call the run clean."""
    from zarr_queue import fetch_public_catalog_rows  # type: ignore[import-not-found]

    rows, complete = fetch_public_catalog_rows(api_base)
    if not complete:
        print(
            "::warning::the catalog walk was incomplete; --all covers a subset, "
            "so the run cannot exit 0",
            flush=True,
        )
    return sorted({str(r["dataset_id"]) for r in rows if r.get("dataset_id")}), complete


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Find published Zarr stores that lost channels to a repeated label (read-only)."
    )
    target = ap.add_mutually_exclusive_group(required=True)
    target.add_argument("--dataset", action="append", help="dataset id; repeatable")
    target.add_argument("--all", action="store_true", help="every public catalog dataset")
    ap.add_argument("--zarr-base", default=DEFAULT_CONTRACT_BASE)
    ap.add_argument("--github-raw-base", default=GITHUB_RAW_BASE)
    ap.add_argument("--api-base", default=DEFAULT_API_BASE, help="catalog, for --all")
    ap.add_argument(
        "--repo-dir",
        help="local clone of the ONE --dataset given; channels.tsv is read from it",
    )
    ap.add_argument(
        "--labels", choices=("repeatable", "all", "none"), default="repeatable",
        help="which stores get the repeated-label check (default: EDF/BDF sources)",
    )
    ap.add_argument("--sleep", type=float, default=0.0, help="pause between datasets (s)")
    ap.add_argument(
        "--request-interval", type=float, default=None,
        help=f"minimum spacing between requests (s); default {ALL_REQUEST_INTERVAL_S} "
        "under --all, 0 otherwise",
    )
    ap.add_argument("--out", help="write the JSON report here as well as to stdout")
    args = ap.parse_args(argv)

    if args.repo_dir and (args.all or len(args.dataset or []) != 1):
        ap.error("--repo-dir is a clone of one dataset: give exactly one --dataset")
    if args.request_interval is not None and args.request_interval < 0:
        ap.error("--request-interval must be >= 0")
    PACER.interval = (
        args.request_interval if args.request_interval is not None
        else ALL_REQUEST_INTERVAL_S if args.all else 0.0
    )
    # stdout carries the JSON report and nothing else. The converter helpers
    # this reuses (`_decode_sidecar_text`, the catalog walk) print their
    # `::warning::` lines to stdout, so send those to stderr with the progress.
    catalog_complete = True
    catalog_error: str | None = None
    with contextlib.redirect_stdout(sys.stderr):
        if args.all:
            try:
                ids, catalog_complete = list_public_dataset_ids(args.api_base)
            except (OSError, ValueError, TypeError, AttributeError, http.client.HTTPException) as exc:
                # The walk raises on any page that fails (HTTPError and URLError
                # are OSErrors; a body that is not the catalog's JSON is a
                # ValueError or an AttributeError). Nothing was checked, and
                # that is "unchecked" (exit 2), not the traceback's exit 1, which
                # reads as "something was flagged".
                ids, catalog_complete = [], False
                catalog_error = f"{type(exc).__name__}: {exc}"
                print(
                    f"::error::could not read the catalog from {args.api_base}: "
                    f"{catalog_error}; nothing was checked",
                    file=sys.stderr, flush=True,
                )
        else:
            ids = list(dict.fromkeys(args.dataset))

        results = []
        for i, dataset_id in enumerate(ids):
            if i and args.sleep:
                time.sleep(args.sleep)
            result = check_dataset(
                dataset_id, zarr_base=args.zarr_base, raw_base=args.github_raw_base,
                repo_dir=os.path.expanduser(args.repo_dir) if args.repo_dir else None,
                labels_mode=args.labels,
            )
            results.append(result)
            state = result.get("error") or f"{len(result['findings'])} flagged of {result['stores']}"
            if result.get("unreadable_stores"):
                state += f", {result['unreadable_stores']} unreadable (unchecked)"
            print(f"{dataset_id}: {state}", file=sys.stderr, flush=True)

    report = {
        "format": REPORT_FORMAT,
        "format_version": REPORT_FORMAT_VERSION,
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "zarr_base": args.zarr_base,
        "findings": [f for r in results for f in r["findings"]],
        "datasets": results,
        "summary": summarize(results, catalog_complete),
    }
    if catalog_error is not None:
        report["catalog_error"] = catalog_error
    text = json.dumps(report, indent=2)
    print(text)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    return exit_status(report["summary"])


if __name__ == "__main__":
    sys.exit(main())
