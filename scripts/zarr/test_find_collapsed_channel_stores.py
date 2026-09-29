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

sys.path.insert(0, str(Path(__file__).resolve().parent))

import find_collapsed_channel_stores as fc  # type: ignore[import-not-found]

COMMIT = "a" * 40
DATASET = "nm000110"
REC_DIR = "sub-chb01/eeg"
CHB_LABELS = ["FP1-F7", "F7-T7", "-", "T8-P8", "-", "T8-P8"]  # 6 in the file


def tsv(names: list[str]) -> str:
    return "name\ttype\tunits\n" + "".join(f"{n}\tEEG\tuV\n" for n in names)


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


class Site:
    """A temporary directory served over HTTP: `zarr/` is the zarr host,
    `raw/` the raw-GitHub host."""

    def __init__(self, root: str):
        self.root = root
        handler = functools.partial(_Quiet, directory=root)
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

    def publish(self, dataset: str, stores: list[dict], labels: dict[str, list[str]]) -> None:
        """An index listing `stores`, and a group zarr.json per store whose
        `channels` carry `labels[zarr]`."""
        self.write(f"zarr/{dataset}/zarr/index.json", json.dumps({
            "dataset_id": dataset, "format": "nemar-zarr-index", "format_version": 3,
            "source_commit": COMMIT, "stores": stores,
        }))
        for store in stores:
            for group in store["groups"]:
                self.write(
                    f"zarr/{dataset}/zarr/{store['zarr']}/{group['name']}/zarr.json",
                    json.dumps({"attributes": {
                        "channels": [{"label": x} for x in labels.get(store["zarr"], [])],
                    }}),
                )

    def sidecar(self, dataset: str, rel: str, content: str) -> None:
        self.write(f"raw/nemarDatasets/{dataset}/{COMMIT}/{rel}", content)


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

    def test_no_sidecar_is_not_clean(self):
        self.assertEqual(fc.classify_store(DATASET, store(1, 4), None, None, None),
                         ("no_channels_tsv", None))

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

    def test_no_sidecar_is_reported_not_passed(self):
        self.site.publish(DATASET, [store(1, 4, ext="set")], {})
        rc, report = self.run_main("--dataset", DATASET)
        self.assertEqual(rc, 0)
        self.assertEqual(report["summary"]["stores_without_channels_tsv"], 1)

    def test_a_missing_index_is_unchecked_not_clean(self):
        rc, report = self.run_main("--dataset", "nm999998")
        self.assertEqual(rc, 2)
        self.assertEqual(report["datasets"][0]["error"], "no_index")
        self.assertEqual(report["summary"]["datasets_unchecked"], 1)

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
        self.site.write(f"zarr/{DATASET}/zarr/index.json", json.dumps({
            "source_commit": commit, "stores": [store(1, 4, ext="set")],
        }))
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            rc = fc.main([
                "--dataset", DATASET, "--repo-dir", self.repo,
                "--zarr-base", self.site.zarr_base, "--github-raw-base", "http://127.0.0.1:9",
            ])
        report = json.loads(out.getvalue())
        self.assertEqual(rc, 1)
        self.assertEqual(report["findings"][0]["tsv_channels"], 6)

    def test_repo_dir_needs_exactly_one_dataset(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            fc.main(["--dataset", "a", "--dataset", "b", "--repo-dir", self.repo])


if __name__ == "__main__":
    unittest.main()
