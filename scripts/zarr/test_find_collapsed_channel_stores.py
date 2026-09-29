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
import functools
import http.server
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
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

    faults: ClassVar[dict[str, tuple[int, dict[str, str]]]] = {}
    hits: ClassVar[dict[str, int]] = {}

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        self.hits[path] = self.hits.get(path, 0) + 1
        fault = self.faults.get(path)
        if fault is not None:
            status, headers = fault
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
        handler_cls = type("_Handler", (_Quiet,), {"faults": {}, "hits": {}})
        self.faults: dict[str, tuple[int, dict[str, str]]] = handler_cls.faults
        self.hits: dict[str, int] = handler_cls.hits
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

    def fail(self, rel: str, status: int, **headers: str) -> None:
        """Answer every GET of `rel` (relative to the site root) with `status`."""
        self.faults["/" + rel] = (status, headers)


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


class TestOverHttp(unittest.TestCase):
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

    def run_main(self, *args: str) -> tuple[int, dict]:
        argv = ["--zarr-base", self.site.zarr_base, "--github-raw-base", self.site.raw_base, *args]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = fc.main(argv)
        return rc, json.loads(out.getvalue())

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
