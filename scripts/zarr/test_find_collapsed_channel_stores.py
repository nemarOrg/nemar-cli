"""Tests for find_collapsed_channel_stores.py.

The detector reads over HTTPS, so these serve a synthetic zarr host and a
synthetic raw-GitHub host from a temporary directory with a REAL local HTTP
server (`http.server`), and the `--repo-dir` path reads a REAL git repository.
Nothing in the detector is substituted: every request it makes is a real GET
against files laid out the way zarr.nemar.org and raw.githubusercontent.com
lay them out.

Run: `pytest scripts/zarr/test_find_collapsed_channel_stores.py`.
"""

from __future__ import annotations

import contextlib
import email.utils
import functools
import http.server
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from pathlib import Path
from typing import ClassVar

sys.path.insert(0, str(Path(__file__).resolve().parent))

import find_collapsed_channel_stores as fc  # type: ignore[import-not-found]

COMMIT = "a" * 40
DATASET = "nm000110"
REC_DIR = "sub-chb01/eeg"
CHB_LABELS = ["FP1-F7", "F7-T7", "-", "T8-P8", "-", "T8-P8"]  # 6 in the file


def tsv(names: list[str]) -> str:
    return "name\ttype\tunits\n" + "".join(f"{n}\tEEG\tuV\n" for n in names)


class _Quiet(http.server.SimpleHTTPRequestHandler):
    """Serves the directory, except that a path in `faults` answers with the
    configured status (and headers) instead, the way a rate-limited or failing
    host does. `hits` counts every request per path."""

    faults: ClassVar[dict[str, list]] = {}
    hits: ClassVar[dict[str, int]] = {}
    # The catalog, paged: `{"total": N, <offset>: [row, ...] or a status, ...}`.
    # An offset with no page answers an empty page, which is how the real API
    # ends a walk that has run out of rows; an int page answers that status.
    # Empty means `api/datasets` is a plain file.
    catalog: ClassVar[dict] = {}

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        self.hits[path] = self.hits.get(path, 0) + 1
        if path == "/api/datasets" and self.catalog and path not in self.faults:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            offset = int(query.get("offset", ["0"])[0])
            page = self.catalog.get(offset, [])
            if isinstance(page, int):  # this page fails with that status
                self.send_response(page)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            body = json.dumps({"total_count": self.catalog["total"], "datasets": page}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        fault = self.faults.get(path)
        if fault is not None and fault[2] != 0:
            status, headers, remaining = fault
            fault[2] = remaining - 1 if remaining > 0 else remaining
            self.send_response(status)
            for key, value in headers.items():
                self.send_header(key, value)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        super().do_GET()

    def log_message(self, format, *args):
        pass


class Site:
    """A temporary directory served over HTTP: `zarr/` is the zarr host,
    `raw/` the raw-GitHub host."""

    def __init__(self, root: str):
        self.root = root
        # Per-site fault table and hit counter, shared with the handler class
        # the server instantiates per request.
        handler_cls = type("_Handler", (_Quiet,), {"faults": {}, "hits": {}, "catalog": {}})
        self.faults: dict[str, list] = handler_cls.faults
        self.hits: dict[str, int] = handler_cls.hits
        self.catalog_pages: dict = handler_cls.catalog
        handler = functools.partial(handler_cls, directory=root)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.zarr_base = f"{base}/zarr"
        self.raw_base = f"{base}/raw"

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def write(self, rel: str, content: str) -> None:
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(content)

    def publish(
        self, dataset: str, stores: list[dict], labels: dict[str, list[str]],
        header_counts: dict[str, int] | None = None, commit: str = COMMIT,
    ) -> None:
        """An index listing `stores`; per store a root zarr.json, whose
        `recording_metadata` carries `number_of_signals` only where
        `header_counts[zarr]` gives one (an EEGLAB-built store records none),
        and a group zarr.json whose `channels` carry `labels[zarr]`."""
        self.write(f"zarr/{dataset}/zarr/index.json", json.dumps({
            "dataset_id": dataset, "format": "nemar-zarr-index", "format_version": 3,
            "source_commit": commit, "stores": stores,
        }))
        for store in stores:
            meta: dict = {"source_format": store["path"].rsplit(".", 1)[-1]}
            if header_counts and store["zarr"] in header_counts:
                meta["number_of_signals"] = header_counts[store["zarr"]]
            self.write(
                f"zarr/{dataset}/zarr/{store['zarr']}/zarr.json",
                json.dumps({"attributes": {
                    "channel_groups": [g["name"] for g in store["groups"]],
                    "recording_metadata": meta,
                }}),
            )
            for group in store["groups"]:
                self.write(
                    f"zarr/{dataset}/zarr/{store['zarr']}/{group['name']}/zarr.json",
                    json.dumps({"attributes": {
                        "channels": [{"label": x} for x in labels.get(store["zarr"], [])],
                    }}),
                )

    def sidecar(self, dataset: str, rel: str, content: str) -> None:
        self.write(f"raw/nemarDatasets/{dataset}/{COMMIT}/{rel}", content)

    def sidecar_bytes(self, dataset: str, rel: str, content: bytes) -> None:
        path = os.path.join(self.root, f"raw/nemarDatasets/{dataset}/{COMMIT}/{rel}")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(content)

    def catalog(self, total: int, *pages: list[dict] | int) -> None:
        """Serve `GET /api/datasets` as the real API pages it: `pages[i]` is the
        page at the offset the earlier pages add up to (an int is an HTTP
        status that page fails with), and `total` is what every page reports
        as `total_count`. A walk that asks past the last page gets an empty one."""
        self.catalog_pages.clear()
        self.catalog_pages["total"] = total
        offset = 0
        for page in pages:
            self.catalog_pages[offset] = page
            offset += 0 if isinstance(page, int) else len(page)

    def fail(self, rel: str, status: int, times: int = -1, **headers: str) -> None:
        """Answer GETs of `rel` (relative to the site root) with `status`: the
        next `times` of them, or every one when `times` is -1."""
        self.faults["/" + rel] = [status, headers, times]


def store(run: int, n_channels: int, ext: str = "edf", **extra) -> dict:
    stem = f"{REC_DIR}/sub-chb01_task-rest_run-{run:02d}_eeg"
    return {
        "path": f"{stem}.{ext}", "zarr": f"{stem}.zarr",
        "groups": [{"name": "eeg_250hz", "n_channels": n_channels}], **extra,
    }


def tsv_rel(run: int) -> str:
    return f"{REC_DIR}/sub-chb01_task-rest_run-{run:02d}_channels.tsv"


class TestPure(unittest.TestCase):
    def test_sidecar_candidates_are_nearest_first(self):
        self.assertEqual(
            fc.sidecar_candidates("sub-01/ses-a/eeg/sub-01_ses-a_task-x_run-1_eeg.edf"),
            [
                "sub-01/ses-a/eeg/sub-01_ses-a_task-x_run-1_channels.tsv",
                "sub-01/ses-a/sub-01_ses-a_channels.tsv",
                "sub-01/sub-01_channels.tsv",
                "channels.tsv",
            ],
        )

    def test_repeated_labels_keep_first_occurrence_order(self):
        self.assertEqual(fc.repeated_labels(CHB_LABELS), ["-", "T8-P8"])
        self.assertEqual(fc.repeated_labels(["A", "B"]), [])

    def test_a_store_short_of_its_sidecar_is_flagged(self):
        verdict, finding = fc.classify_store(DATASET, store(1, 4), 6, "x_channels.tsv", None)
        self.assertEqual(verdict, "flagged")
        assert finding is not None
        self.assertEqual(finding["reasons"], ["short_of_channels_tsv"])
        self.assertEqual((finding["store_channels"], finding["tsv_channels"]), (4, 6))

    def test_a_gate_disclosed_overcount_is_not_flagged(self):
        entry = store(1, 4, channels_tsv_count_mismatch={
            "channels_tsv": 6, "in_file": 4, "in_store": 4,
        })
        self.assertEqual(fc.classify_store(DATASET, entry, 6, "t", None), ("sidecar_overcount", None))

    def test_no_witness_is_not_clean(self):
        self.assertEqual(fc.classify_store(DATASET, store(1, 4), None, None, None),
                         ("unwitnessed", None))

    def test_a_store_short_of_its_header_count_is_flagged(self):
        # The collapse channels.tsv cannot see: no sidecar at all, and the
        # labels already unique because the importer collapsed them.
        verdict, finding = fc.classify_store(
            DATASET, store(1, 4), None, None, ["FP1-F7", "F7-T7", "-", "T8-P8"], 6
        )
        self.assertEqual(verdict, "flagged")
        assert finding is not None
        self.assertEqual(finding["reasons"], ["short_of_file_header"])
        self.assertEqual((finding["store_channels"], finding["header_channels"]), (4, 6))

    def test_a_header_count_alone_is_a_witness(self):
        self.assertEqual(fc.classify_store(DATASET, store(1, 6), None, None, None, 6),
                         ("ok", None))

    def test_header_signal_count_reads_only_a_positive_integer(self):
        self.assertEqual(fc.header_signal_count({"recording_metadata": {"number_of_signals": 23}}), 23)
        for bad in ({}, {"recording_metadata": {}}, {"recording_metadata": "x"},
                    {"recording_metadata": {"number_of_signals": True}},
                    {"recording_metadata": {"number_of_signals": "23"}},
                    {"recording_metadata": {"number_of_signals": 0}}):
            self.assertIsNone(fc.header_signal_count(bad), bad)

    def test_repeated_labels_flag_a_store_with_the_right_count(self):
        verdict, finding = fc.classify_store(DATASET, store(1, 6), 6, "t", CHB_LABELS)
        self.assertEqual(verdict, "flagged")
        assert finding is not None
        self.assertEqual(finding["reasons"], ["repeated_labels"])
        self.assertEqual(finding["repeated_labels"], ["-", "T8-P8"])

    def test_label_check_scope(self):
        self.assertTrue(fc.wants_label_check("a_eeg.EDF", "repeatable"))
        self.assertFalse(fc.wants_label_check("a_eeg.set", "repeatable"))
        self.assertTrue(fc.wants_label_check("a_eeg.set", "all"))
        self.assertFalse(fc.wants_label_check("a_eeg.edf", "none"))


class TestRetryAfter(unittest.TestCase):
    def test_delta_seconds_and_http_dates(self):
        self.assertEqual(fc.retry_after_seconds("7"), 7.0)
        self.assertEqual(fc.retry_after_seconds(" 0 "), 0.0)
        now = 1_800_000_000.0
        date = email.utils.formatdate(now + 30, usegmt=True)
        seconds = fc.retry_after_seconds(date, now=now)
        assert seconds is not None
        self.assertAlmostEqual(seconds, 30.0)
        past = email.utils.formatdate(now - 30, usegmt=True)
        self.assertEqual(fc.retry_after_seconds(past, now=now), 0.0)

    def test_absent_or_garbage_is_none_and_huge_is_capped(self):
        for value in (None, "", "soon", "-5", "1.5"):
            self.assertIsNone(fc.retry_after_seconds(value), value)
        self.assertEqual(fc.retry_after_seconds("86400"), fc.RETRY_AFTER_MAX_S)


class _OverHttp(unittest.TestCase):
    """A real local site per test, and `main` run against it."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.site = Site(self._tmp.name)
        self.addCleanup(self.site.close)
        # The retries are real; only their spacing is shortened, so a store
        # that keeps failing costs the test milliseconds rather than seconds.
        backoff = fc.RETRY_BACKOFF_S
        fc.RETRY_BACKOFF_S = 0.01
        self.addCleanup(setattr, fc, "RETRY_BACKOFF_S", backoff)
        self.addCleanup(setattr, fc.PACER, "interval", 0.0)

    def run_main(self, *args: str) -> tuple[int, dict]:
        argv = ["--zarr-base", self.site.zarr_base, "--github-raw-base", self.site.raw_base, *args]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = fc.main(argv)
        self.stderr = err.getvalue()
        return rc, json.loads(out.getvalue())


class TestOverHttp(_OverHttp):
    def test_the_nm000110_shape_is_found(self):
        # Run 1: collapsed in the importer (4 of 6). Run 2: streamed, every
        # channel kept but the labels repeat. Run 3: re-converted on 1.2.9.
        suffixed = ["FP1-F7", "F7-T7", "--0", "T8-P8-0", "--1", "T8-P8-1"]
        self.site.publish(
            DATASET, [store(1, 4), store(2, 6), store(3, 6)],
            {
                store(1, 4)["zarr"]: list(dict.fromkeys(CHB_LABELS)),
                store(2, 6)["zarr"]: CHB_LABELS,
                store(3, 6)["zarr"]: suffixed,
            },
        )
        for run in (1, 2, 3):
            self.site.sidecar(DATASET, tsv_rel(run), tsv(suffixed))
        rc, report = self.run_main("--dataset", DATASET)
        self.assertEqual(rc, 1)
        self.assertEqual(report["format"], "nemar-zarr-collapsed-channel-report")
        found = {f["recording"].split("_")[2]: f for f in report["findings"]}
        self.assertEqual(sorted(found), ["run-01", "run-02"])
        self.assertEqual(found["run-01"]["reasons"], ["short_of_channels_tsv"])
        self.assertEqual(
            (found["run-01"]["store_channels"], found["run-01"]["tsv_channels"]), (4, 6)
        )
        self.assertEqual(found["run-01"]["channels_tsv"], tsv_rel(1))
        self.assertEqual(found["run-02"]["reasons"], ["repeated_labels"])
        self.assertEqual(report["summary"]["stores_flagged"], 2)
        self.assertEqual(report["summary"]["stores_checked"], 3)
        self.assertIn("--dataset nm000110", report["datasets"][0]["requeue"][0])

    def test_an_inherited_subject_sidecar_is_found(self):
        self.site.publish(DATASET, [store(1, 4, ext="set")], {})
        self.site.sidecar(DATASET, "sub-chb01/sub-chb01_channels.tsv", tsv(CHB_LABELS))
        rc, report = self.run_main("--dataset", DATASET)
        self.assertEqual(rc, 1)
        self.assertEqual(report["findings"][0]["channels_tsv"], "sub-chb01/sub-chb01_channels.tsv")

    def test_a_clean_dataset_exits_zero(self):
        self.site.publish(DATASET, [store(1, 6)], {store(1, 6)["zarr"]: [f"C{i}" for i in range(6)]})
        self.site.sidecar(DATASET, tsv_rel(1), tsv([f"C{i}" for i in range(6)]))
        rc, report = self.run_main("--dataset", DATASET)
        self.assertEqual((rc, report["findings"]), (0, []))

    def test_no_witness_is_reported_not_passed(self):
        # No channels.tsv and no number_of_signals (an EEGLAB-built store):
        # nothing to count against, so the run cannot call it clean.
        self.site.publish(DATASET, [store(1, 4, ext="set")], {})
        rc, report = self.run_main("--dataset", DATASET)
        self.assertEqual((rc, report["findings"]), (2, []))
        summary = report["summary"]
        self.assertEqual(summary["stores_without_channels_tsv"], 1)
        self.assertEqual(summary["stores_without_header_count"], 1)
        self.assertEqual(summary["stores_unwitnessed"], 1)

    def test_a_pre_129_collapse_with_no_sidecar_is_found_by_its_header_count(self):
        # The shape a biosigio 1.2.8 store has, verified by building one from
        # a CHB-MIT-shaped EDF: `number_of_signals` 6 at the root, the four
        # surviving (unique) labels in the group. No channels.tsv anywhere.
        entry = store(1, 4)
        self.site.publish(
            DATASET, [entry], {entry["zarr"]: ["FP1-F7", "F7-T7", "-", "T8-P8"]},
            header_counts={entry["zarr"]: 6},
        )
        rc, report = self.run_main("--dataset", DATASET)
        self.assertEqual(rc, 1)
        finding = report["findings"][0]
        self.assertEqual(finding["reasons"], ["short_of_file_header"])
        self.assertEqual((finding["store_channels"], finding["header_channels"]), (4, 6))
        self.assertIsNone(finding["tsv_channels"])
        self.assertEqual(report["summary"]["stores_without_header_count"], 0)

    def test_a_complete_store_with_a_header_count_and_no_sidecar_is_clean(self):
        entry = store(1, 6)
        self.site.publish(
            DATASET, [entry], {entry["zarr"]: [f"C{i}" for i in range(6)]},
            header_counts={entry["zarr"]: 6},
        )
        rc, report = self.run_main("--dataset", DATASET)
        self.assertEqual((rc, report["findings"]), (0, []))
        self.assertEqual(report["summary"]["stores_unwitnessed"], 0)

    def test_a_missing_index_is_unchecked_not_clean(self):
        rc, report = self.run_main("--dataset", "nm999998")
        self.assertEqual(rc, 2)
        self.assertEqual(report["datasets"][0]["error"], "no_index")
        self.assertEqual(report["summary"]["datasets_unchecked"], 1)

    def test_a_non_utf8_sidecar_is_decoded_as_the_converter_decodes_it(self):
        # Windows "Unicode" (UTF-16 with a BOM) and cp1252 sidecars both ship
        # in real datasets. Read as UTF-8 the UTF-16 one ends in a lone NUL
        # line, one row too many, and a complete store would be flagged.
        labels = [f"C{i}" for i in range(6)]
        stores = [store(1, 6), store(2, 6)]
        self.site.publish(DATASET, stores, {s["zarr"]: labels for s in stores},
                          header_counts={s["zarr"]: 6 for s in stores})
        self.site.sidecar_bytes(DATASET, tsv_rel(1), tsv(labels).encode("utf-16"))
        self.site.sidecar_bytes(
            DATASET, tsv_rel(2), tsv(labels).replace("uV", "\u00b5V").encode("cp1252")
        )
        # run_main parses stdout as JSON, so this also proves the decode's
        # `::warning::` line went to stderr rather than into the report.
        rc, report = self.run_main("--dataset", DATASET)
        self.assertEqual((rc, report["findings"]), (0, []))

    def _two_clean_stores_one_failing(self, status: int) -> tuple[int, dict]:
        labels = [f"C{i}" for i in range(6)]
        stores = [store(1, 6), store(2, 6)]
        self.site.publish(DATASET, stores, {s["zarr"]: labels for s in stores})
        for run in (1, 2):
            self.site.sidecar(DATASET, tsv_rel(run), tsv(labels))
        bad = f"zarr/{DATASET}/zarr/{stores[1]['zarr']}/eeg_250hz/zarr.json"
        self.site.fail(bad, status)
        rc, report = self.run_main("--dataset", DATASET)
        self.assertEqual(self.site.hits["/" + bad], 3, "every attempt was made")
        return rc, report

    def test_a_rate_limited_store_leaves_the_dataset_unchecked(self):
        rc, report = self._two_clean_stores_one_failing(429)
        self.assertEqual(rc, 2, "a store the run could not read is not clean")
        self.assertEqual(report["findings"], [])
        summary = report["summary"]
        self.assertEqual(
            (summary["datasets_checked"], summary["datasets_unchecked"]), (0, 1)
        )
        self.assertEqual((summary["stores_checked"], summary["stores_unreadable"]), (1, 1))
        errors = report["datasets"][0]["store_errors"]
        self.assertEqual(len(errors), 1)
        self.assertIn("429", errors[0]["error"])

    def test_a_failing_store_leaves_the_dataset_unchecked(self):
        rc, report = self._two_clean_stores_one_failing(503)
        self.assertEqual(rc, 2)
        self.assertEqual(report["summary"]["datasets_unchecked"], 1)
        self.assertIn("503", report["datasets"][0]["store_errors"][0]["error"])

    def test_an_unreadable_sidecar_leaves_the_dataset_unchecked(self):
        labels = [f"C{i}" for i in range(6)]
        self.site.publish(DATASET, [store(1, 6)], {store(1, 6)["zarr"]: labels})
        self.site.sidecar(DATASET, tsv_rel(1), tsv(labels))
        self.site.fail(f"raw/nemarDatasets/{DATASET}/{COMMIT}/{tsv_rel(1)}", 500)
        rc, report = self.run_main("--dataset", DATASET)
        self.assertEqual(rc, 2)
        self.assertEqual(report["summary"]["stores_unreadable"], 1)

    def test_a_finding_outranks_an_unreadable_store(self):
        stores = [store(1, 4), store(2, 6)]
        self.site.publish(DATASET, stores, {})
        for run in (1, 2):
            self.site.sidecar(DATASET, tsv_rel(run), tsv(CHB_LABELS))
        self.site.fail(f"zarr/{DATASET}/zarr/{stores[1]['zarr']}/eeg_250hz/zarr.json", 502)
        rc, report = self.run_main("--dataset", DATASET)
        self.assertEqual(rc, 1)
        self.assertEqual(report["summary"]["stores_flagged"], 1)
        self.assertEqual(report["summary"]["datasets_unchecked"], 1)

    def test_a_429_waits_what_retry_after_asks(self):
        # raw.githubusercontent.com answers a burst with 429 and Retry-After.
        # The backoff is 10 ms here, so only the header explains a 1 s wait.
        labels = [f"C{i}" for i in range(6)]
        self.site.publish(DATASET, [store(1, 6)], {store(1, 6)["zarr"]: labels})
        self.site.sidecar(DATASET, tsv_rel(1), tsv(labels))
        rel = f"raw/nemarDatasets/{DATASET}/{COMMIT}/{tsv_rel(1)}"
        self.site.fail(rel, 429, times=1, **{"Retry-After": "1"})
        started = time.monotonic()
        rc, report = self.run_main("--dataset", DATASET)
        self.assertGreaterEqual(time.monotonic() - started, 1.0)
        self.assertEqual((rc, report["findings"]), (0, []))
        self.assertEqual(self.site.hits["/" + rel], 2)
        self.assertEqual(report["summary"]["stores_unreadable"], 0)

    def test_requests_are_paced(self):
        labels = [f"C{i}" for i in range(6)]
        self.site.publish(DATASET, [store(1, 6)], {store(1, 6)["zarr"]: labels})
        self.site.sidecar(DATASET, tsv_rel(1), tsv(labels))
        started = time.monotonic()
        rc, _ = self.run_main("--dataset", DATASET, "--request-interval", "0.2")
        elapsed = time.monotonic() - started
        requests = sum(self.site.hits.values())
        self.assertEqual(rc, 0)
        # index, root zarr.json, group zarr.json, channels.tsv
        self.assertEqual(requests, 4)
        self.assertGreaterEqual(elapsed, 0.2 * (requests - 1))

    def test_all_paces_by_default_and_a_single_dataset_does_not(self):
        self.site.write("api/datasets", json.dumps({"total_count": 0, "datasets": []}))
        api = self.site.zarr_base.rsplit("/", 1)[0] + "/api"
        self.run_main("--all", "--api-base", api)
        self.assertEqual(fc.PACER.interval, fc.ALL_REQUEST_INTERVAL_S)
        self.run_main("--dataset", "nm999998")
        self.assertEqual(fc.PACER.interval, 0.0)

    def test_all_walks_the_public_catalog(self):
        other = "nm000111"
        labels = [f"C{i}" for i in range(6)]
        self.site.publish(DATASET, [store(1, 4)], {})
        self.site.sidecar(DATASET, tsv_rel(1), tsv(CHB_LABELS))
        self.site.publish(other, [store(1, 6)], {store(1, 6)["zarr"]: labels})
        self.site.sidecar(other, tsv_rel(1), tsv(labels))
        # The catalog's own shape (`GET /datasets`, paginated by
        # `total_count`); a private row must not be walked.
        self.site.write("api/datasets", json.dumps({
            "total_count": 3,
            "datasets": [
                {"dataset_id": other, "visibility": "public"},
                {"dataset_id": DATASET, "visibility": "public"},
                {"dataset_id": "nm000999", "visibility": "private"},
            ],
        }))
        api = self.site.zarr_base.rsplit("/", 1)[0] + "/api"
        rc, report = self.run_main("--all", "--api-base", api)
        self.assertEqual(rc, 1)
        self.assertEqual([d["dataset"] for d in report["datasets"]], [DATASET, other])
        self.assertEqual([f["dataset"] for f in report["findings"]], [DATASET])
        self.assertEqual(report["summary"]["datasets_checked"], 2)

    def _two_clean_datasets(self) -> tuple[str, str]:
        """Two public datasets whose every store is complete: nothing to flag."""
        first, second = DATASET, "nm000111"
        labels = [f"C{i}" for i in range(6)]
        for ds in (first, second):
            self.site.publish(ds, [store(1, 6)], {store(1, 6)["zarr"]: labels})
            self.site.sidecar(ds, tsv_rel(1), tsv(labels))
        return first, second

    def _api(self) -> str:
        return self.site.zarr_base.rsplit("/", 1)[0] + "/api"

    def test_a_complete_catalog_walk_is_recorded_and_exits_zero(self):
        first, second = self._two_clean_datasets()
        # Two pages, so the walk really pages: 2 rows, then 1, of a total of 3.
        self.site.catalog(
            3,
            [{"dataset_id": second, "visibility": "public"},
             {"dataset_id": "nm000999", "visibility": "private"}],
            [{"dataset_id": first, "visibility": "public"}],
        )
        rc, report = self.run_main("--all", "--api-base", self._api())
        self.assertEqual(rc, 0)
        self.assertIs(report["summary"]["catalog_complete"], True)
        self.assertEqual(report["summary"]["datasets_checked"], 2)
        self.assertNotIn("catalog_error", report)

    def test_explicit_datasets_walk_no_catalog(self):
        self._two_clean_datasets()
        rc, report = self.run_main("--dataset", DATASET)
        self.assertEqual(rc, 0)
        self.assertIs(report["summary"]["catalog_complete"], True)
        self.assertNotIn("/api/datasets", self.site.hits)

    def test_an_incomplete_catalog_walk_is_unchecked_not_clean(self):
        # The API says 4 datasets and hands over 2 before running dry: every
        # dataset the run DID see is clean, and the run still cannot call the
        # archive clean.
        first, second = self._two_clean_datasets()
        self.site.catalog(
            4,
            [{"dataset_id": second, "visibility": "public"},
             {"dataset_id": first, "visibility": "public"}],
        )
        rc, report = self.run_main("--all", "--api-base", self._api())
        self.assertEqual(rc, 2)
        self.assertIs(report["summary"]["catalog_complete"], False)
        self.assertEqual(report["summary"]["datasets_checked"], 2)
        self.assertEqual(report["findings"], [])
        self.assertIn("catalog walk was incomplete", self.stderr)

    def test_a_finding_outranks_an_incomplete_catalog_walk(self):
        self.site.publish(DATASET, [store(1, 4)], {})
        self.site.sidecar(DATASET, tsv_rel(1), tsv(CHB_LABELS))
        self.site.catalog(3, [{"dataset_id": DATASET, "visibility": "public"}])
        rc, report = self.run_main("--all", "--api-base", self._api())
        self.assertEqual(rc, 1)
        self.assertIs(report["summary"]["catalog_complete"], False)
        self.assertEqual([f["dataset"] for f in report["findings"]], [DATASET])

    def test_a_failed_catalog_fetch_is_unchecked_not_a_traceback(self):
        # Before: the fetch's HTTPError escaped main() as a traceback, exit 1,
        # which reads as "something was flagged".
        self.site.fail("api/datasets", 500)
        rc, report = self.run_main("--all", "--api-base", self._api())
        self.assertEqual(rc, 2)
        self.assertIs(report["summary"]["catalog_complete"], False)
        self.assertEqual(report["datasets"], [])
        self.assertIn("HTTPError", report["catalog_error"])
        self.assertIn("could not read the catalog", self.stderr)

    def test_a_catalog_page_that_fails_midwalk_is_unchecked(self):
        # The first page is fine and the second is not: the datasets on page
        # one are not reported as if they were the whole catalog.
        first, second = self._two_clean_datasets()
        self.site.catalog(
            3,
            [{"dataset_id": second, "visibility": "public"},
             {"dataset_id": first, "visibility": "public"}],
            503,
        )
        rc, report = self.run_main("--all", "--api-base", self._api())
        self.assertEqual(rc, 2)
        self.assertIs(report["summary"]["catalog_complete"], False)
        self.assertEqual(report["datasets"], [])
        self.assertIn("503", report["catalog_error"])
        self.assertEqual(self.site.hits["/api/datasets"], 2)  # page one, then the failing page

    def test_labels_mode_decides_which_stores_are_read(self):
        # A non-EDF store whose labels repeat: only `--labels all` reads it.
        entry = store(1, 6, ext="set")
        self.site.publish(DATASET, [entry], {entry["zarr"]: CHB_LABELS})
        self.site.sidecar(DATASET, tsv_rel(1), tsv(CHB_LABELS))
        group = f"/zarr/{DATASET}/zarr/{entry['zarr']}/eeg_250hz/zarr.json"
        rc, report = self.run_main("--dataset", DATASET)
        self.assertEqual((rc, report["findings"]), (0, []))
        self.assertNotIn(group, self.site.hits)
        rc, report = self.run_main("--dataset", DATASET, "--labels", "all")
        self.assertEqual(rc, 1)
        self.assertEqual(report["findings"][0]["repeated_labels"], ["-", "T8-P8"])
        # And `none` skips even an EDF store's labels.
        edf = store(2, 6)
        self.site.publish(DATASET, [edf], {edf["zarr"]: CHB_LABELS})
        self.site.sidecar(DATASET, tsv_rel(2), tsv(CHB_LABELS))
        rc, report = self.run_main("--dataset", DATASET, "--labels", "none")
        self.assertEqual((rc, report["findings"]), (0, []))
        rc, report = self.run_main("--dataset", DATASET)
        self.assertEqual(rc, 1)

    def test_a_real_biosigio_store_is_read(self):
        # The group layout the detector reads is biosigIO's, not this file's:
        # write a real store from a real EDF that repeats a label and read it
        # back over HTTP. biosigio >= 1.2.9 suffixes the repeats, so nothing
        # repeats and the count matches; the labels prove the read happened.
        try:
            import numpy as np
            import pyedflib
            from biosigio import Recording
        except Exception as exc:  # noqa: BLE001
            self.skipTest(f"conversion deps unavailable: {exc}")
        edf = os.path.join(self._tmp.name, "src.edf")
        writer = pyedflib.EdfWriter(edf, len(CHB_LABELS), file_type=pyedflib.FILETYPE_EDFPLUS)
        writer.setSignalHeaders([{
            "label": x, "dimension": "uV", "sample_frequency": 256,
            "physical_max": 3000.0, "physical_min": -3000.0,
            "digital_max": 32767, "digital_min": -32768, "transducer": "", "prefilter": "",
        } for x in CHB_LABELS])
        writer.writeSamples([np.zeros(256 * 4) for _ in CHB_LABELS])
        writer.close()
        entry = store(1, len(CHB_LABELS))
        store_dir = os.path.join(self._tmp.name, "zarr", DATASET, "zarr", entry["zarr"])
        Recording.from_file(edf).to_zarr(store_dir, dtype="int16")
        with open(os.path.join(store_dir, "zarr.json")) as fh:
            groups = json.load(fh)["attributes"]["channel_groups"]
        entry["groups"] = [{"name": g, "n_channels": len(CHB_LABELS)} for g in groups]
        labels = fc.store_labels(self.site.zarr_base, DATASET, entry)
        self.assertEqual(len(labels), len(CHB_LABELS))
        self.assertIn("T8-P8-0", labels)
        # And the root carries the header witness, equal to what is served.
        root = fc.store_root_attrs(self.site.zarr_base, DATASET, entry)
        self.assertEqual(fc.header_signal_count(root), len(CHB_LABELS))


def joined(unmatched: int, **extra) -> dict:
    """A `units_report` as the converter publishes it once it reports the join."""
    return {"converted": 0, "relabelled": 0, "kept_importer_unit": 0,
            "units_column_present": True, "unmatched_channels": unmatched, **extra}


class TestCaseOnlyPure(unittest.TestCase):
    def test_a_case_only_miss_is_flagged(self):
        entry = store(1, 23, units_report=joined(
            2, unmatched_case_only=2, unmatched_examples=["FP1-F7", "FP2-F8"]))
        verdict, finding = fc.classify_case_only(DATASET, entry)
        self.assertEqual(verdict, "flagged")
        assert finding is not None
        self.assertEqual(finding["unmatched_case_only"], 2)
        self.assertEqual(finding["unmatched_channels"], 2)
        self.assertEqual(finding["unmatched_examples"], ["FP1-F7", "FP2-F8"])
        self.assertEqual(finding["zarr"], entry["zarr"])

    def test_no_join_report_is_unverifiable_not_clean(self):
        # units_report from before the converter reported the join (0.10.9).
        pre = store(1, 23, units_report={"converted": 23, "relabelled": 0,
                                         "kept_importer_unit": 0,
                                         "units_column_present": True})
        self.assertEqual(fc.classify_case_only(DATASET, pre), ("no_join_report", None))
        self.assertEqual(fc.classify_case_only(DATASET, store(1, 23)),
                         ("no_units_report", None))
        self.assertEqual(
            fc.classify_case_only(DATASET, store(1, 23, units_report="garbage")),
            ("no_join_report", None),
        )

    def test_a_reported_join_with_no_case_miss_is_ok(self):
        self.assertEqual(fc.classify_case_only(DATASET, store(1, 23, units_report=joined(0))),
                         ("ok", None))
        # A 1.2.10 conversion that applied rows by ignoring case.
        self.assertEqual(
            fc.classify_case_only(DATASET, store(1, 23, units_report=joined(
                0, matched_case_only=23, matched_case_only_examples=["Fp1-F7 -> FP1-F7"]))),
            ("case_matched", None),
        )

    def test_a_non_positive_or_non_integer_count_is_not_a_finding(self):
        for value in (0, True, "2", 1.5):
            verdict, _ = fc.classify_case_only(
                DATASET, store(1, 3, units_report=joined(1, unmatched_case_only=value)))
            self.assertNotEqual(verdict, "flagged", value)


class TestCaseOnlyOverHttp(_OverHttp):
    """`--case-only` against a real local HTTP server laid out like the zarr
    host. It reads each dataset's index.json and nothing else."""

    def publish_index(self, dataset: str, stores: list[dict], **top) -> str:
        rel = f"zarr/{dataset}/zarr/index.json"
        self.site.write(rel, json.dumps({
            "dataset_id": dataset, "format": "nemar-zarr-index", "format_version": 3,
            "source_commit": COMMIT, "stores": stores, **top,
        }))
        return rel

    def test_the_affected_stores_are_listed_and_the_rest_counted(self):
        stores = [
            store(1, 23, units_report=joined(23, unmatched_case_only=23,
                                             unmatched_examples=["FP1-F7"])),
            store(2, 23, units_report=joined(0, matched_case_only=23,
                                             matched_case_only_examples=["Fp1-F7 -> FP1-F7"])),
            store(3, 23, units_report={"converted": 23, "relabelled": 0,
                                       "kept_importer_unit": 0,
                                       "units_column_present": True}),
            store(4, 23),
            store(5, 23, units_report=joined(0)),
        ]
        self.publish_index(DATASET, stores, biosigio_version="1.2.9")
        rc, report = self.run_main("--case-only", "--dataset", DATASET)
        self.assertEqual(rc, 1)
        self.assertEqual(report["format"], "nemar-zarr-case-only-join-report")
        self.assertEqual([f["zarr"] for f in report["findings"]], [stores[0]["zarr"]])
        summary = report["summary"]
        self.assertEqual(summary["stores_checked"], 5)
        self.assertEqual(summary["stores_flagged"], 1)
        self.assertEqual(summary["stores_case_matched"], 1)
        self.assertEqual(summary["stores_unverifiable"], 2)
        self.assertEqual(summary["stores_unverifiable_no_units_report"], 1)
        dataset = report["datasets"][0]
        self.assertIn("--dataset nm000110", dataset["requeue"][0])
        self.assertEqual(dataset["index_biosigio_version"], "1.2.9")
        self.assertIn("cannot be enumerated", report["unverifiable_note"])
        self.assertIn("unverifiable from the index", self.stderr)
        # index.json alone: no store and no sidecar was read.
        self.assertEqual(list(self.site.hits), [f"/zarr/{DATASET}/zarr/index.json"])

    def test_unverifiable_entries_are_never_clean(self):
        self.publish_index(DATASET, [store(1, 23, units_report={"converted": 23})])
        rc, report = self.run_main("--case-only", "--dataset", DATASET)
        self.assertEqual((rc, report["findings"]), (2, []))
        self.assertEqual(report["summary"]["stores_unverifiable"], 1)

    def test_a_fully_reported_clean_dataset_exits_zero(self):
        self.publish_index(DATASET, [store(1, 23, units_report=joined(0))])
        rc, report = self.run_main("--case-only", "--dataset", DATASET)
        self.assertEqual((rc, report["findings"]), (0, []))

    def test_an_unreadable_index_is_unchecked_not_clean(self):
        rel = self.publish_index(DATASET, [store(1, 23, units_report=joined(0))])
        self.site.fail(rel, 503)
        rc, report = self.run_main("--case-only", "--dataset", DATASET)
        self.assertEqual(rc, 2)
        self.assertEqual(self.site.hits["/" + rel], 3, "every attempt was made")
        self.assertEqual(report["summary"]["datasets_unchecked"], 1)
        self.assertIn("503", report["datasets"][0]["error"])

    def test_a_missing_index_is_unchecked(self):
        rc, report = self.run_main("--case-only", "--dataset", "nm999998")
        self.assertEqual(rc, 2)
        self.assertEqual(report["datasets"][0]["error"], "no_index")

    def test_an_index_without_a_stores_list_is_unchecked(self):
        self.publish_index(DATASET, None)  # type: ignore[arg-type]
        rc, report = self.run_main("--case-only", "--dataset", DATASET)
        self.assertEqual(rc, 2)
        self.assertEqual(report["datasets"][0]["error"], "index_has_no_stores_list")

    def test_a_finding_outranks_an_unreadable_dataset(self):
        self.publish_index(DATASET, [store(1, 23, units_report=joined(1, unmatched_case_only=1))])
        rc, report = self.run_main("--case-only", "--dataset", DATASET, "--dataset", "nm999998")
        self.assertEqual(rc, 1)
        self.assertEqual(report["summary"]["datasets_unchecked"], 1)

    def test_a_429_waits_what_retry_after_asks(self):
        rel = self.publish_index(DATASET, [store(1, 23, units_report=joined(0))])
        self.site.fail(rel, 429, times=1, **{"Retry-After": "1"})
        started = time.monotonic()
        rc, _ = self.run_main("--case-only", "--dataset", DATASET)
        self.assertGreaterEqual(time.monotonic() - started, 1.0)
        self.assertEqual(rc, 0)
        self.assertEqual(self.site.hits["/" + rel], 2)

    def test_all_walks_the_catalog_and_an_incomplete_walk_is_unchecked(self):
        self.publish_index(DATASET, [store(1, 23, units_report=joined(0))])
        api = self.site.zarr_base.rsplit("/", 1)[0] + "/api"
        self.site.catalog(3, [{"dataset_id": DATASET, "visibility": "public"}])
        rc, report = self.run_main("--case-only", "--all", "--api-base", api)
        self.assertEqual(rc, 2)
        self.assertIs(report["summary"]["catalog_complete"], False)
        self.assertEqual(report["summary"]["datasets_checked"], 1)

    def test_repo_dir_and_labels_do_not_apply(self):
        for extra in (["--repo-dir", self._tmp.name], ["--labels", "all"]):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                fc.main(["--case-only", "--dataset", DATASET, *extra])


class TestRepoDir(unittest.TestCase):
    """`--repo-dir`: channels.tsv from a real local clone, at the commit the
    index names, through the converter's own BIDS-inheritance resolution."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.site = Site(os.path.join(self._tmp.name, "site"))
        self.addCleanup(self.site.close)
        self.repo = os.path.join(self._tmp.name, "repo")
        os.makedirs(os.path.join(self.repo, REC_DIR))

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", "-C", self.repo, *args], check=True, capture_output=True, text=True
        ).stdout.strip()

    def test_the_commit_is_read_not_the_working_tree(self):
        self.git("init", "-q")
        self.git("config", "user.email", "t@example.org")
        self.git("config", "user.name", "t")
        path = os.path.join(self.repo, tsv_rel(1))
        with open(path, "w") as fh:
            fh.write(tsv(CHB_LABELS))
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "six channels")
        commit = self.git("rev-parse", "HEAD")
        with open(path, "w") as fh:  # the working tree moves on; the store did not
            fh.write(tsv(CHB_LABELS[:4]))
        self.site.publish(DATASET, [store(1, 4, ext="set")], {}, commit=commit)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            rc = fc.main([
                "--dataset", DATASET, "--repo-dir", self.repo,
                "--zarr-base", self.site.zarr_base, "--github-raw-base", "http://127.0.0.1:9",
            ])
        report = json.loads(out.getvalue())
        self.assertEqual(rc, 1)
        self.assertEqual(report["findings"][0]["tsv_channels"], 6)

    def test_a_source_commit_that_is_not_a_sha_never_reaches_git(self):
        # A hostile index: the "commit" is a git option that would write a
        # file if `git ls-tree` ever parsed it.
        self.git("init", "-q")
        planted = os.path.join(self._tmp.name, "planted")
        self.site.publish(DATASET, [store(1, 4, ext="set")], {}, commit=f"--output={planted}")
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            rc = fc.main([
                "--dataset", DATASET, "--repo-dir", self.repo,
                "--zarr-base", self.site.zarr_base, "--github-raw-base", self.site.raw_base,
            ])
        report = json.loads(out.getvalue())
        self.assertEqual(rc, 2)
        self.assertEqual(report["datasets"][0]["error"], "index_source_commit_not_a_sha")
        self.assertFalse(os.path.exists(planted))
        self.assertEqual(self.site.hits.get(f"/zarr/{DATASET}/zarr/index.json"), 1)
        self.assertFalse([p for p in self.site.hits if p.startswith("/raw/")])

    def test_repo_dir_needs_exactly_one_dataset(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            fc.main(["--dataset", "a", "--dataset", "b", "--repo-dir", self.repo])


if __name__ == "__main__":
    unittest.main()
