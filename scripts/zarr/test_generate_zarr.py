#!/usr/bin/env python3
"""Unit tests for the pure helpers in scripts/zarr/generate_zarr.py.

No mocks: these exercise the path-classification, worklist, index-merge, and
annex-key parsing logic directly (the git/S3/biosigIO I/O is validated E2E by
`hallu-zarr.sh --dataset nm099999` on Hallu, not here; the old
run-generate-zarr.yml workflow_dispatch path was retired in nemar-cli#1109).

Run with:
    python3 scripts/zarr/test_generate_zarr.py
    uv run python scripts/zarr/test_generate_zarr.py
"""

from __future__ import annotations

import contextlib
import errno
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import generate_zarr
from zarr_queue import ZARR_ENGINE_VERSION  # type: ignore[import-not-found]  # noqa: E402

from generate_zarr import (  # type: ignore[import-not-found]  # noqa: E402  (sibling module via sys.path)
    _AWS_OP_TIMEOUT,
    _AWS_RM_TIMEOUT,
    _AWS_TIMEOUTS,
    RecordingTooLarge,
    _aws,
    _s3_prefix_empty,
    _recording_size_bytes,
    affected_primaries,
    annex_key_size,
    bids_suffix_modality,
    compute_clean_orphans,
    convert_one,
    convert_recording,
    projected_peak_bytes,
    per_recording_ceiling_bytes,
    recording_size_from_pointers,
    note_measurement,
    CEILING_FLOOR_BYTES,
    STREAM_PEAK_BYTES,
    _next_admission,
    _drain_with_admission,
    worker_mem_limit_bytes,
    stream_factor_for,
    projection_factor_hint,
    STREAM_MEM_FACTOR_BY_EXT,
    INMEM_MEM_FACTOR_BY_EXT,
    STREAM_MIN_BYTES,
    apply_worker_mem_limit,
    cap_blas_threads,
    data_segment_bytes,
    BLAS_THREAD_VARS,
    MEM_LIMIT_FLOOR_BYTES,
    MEM_LIMIT_SLACK,
    admission_reserve_bytes,
    streaming_peak_bytes,
    reset_peak_rss,
    peak_rss_bytes,
    inmem_factor_for,
    is_maxshield_fif,
    calibration_summary,
    INMEM_MEM_FACTOR,
    usable_ram_bytes,
    memory_failure_result,
    count_infra_failures,
    RecordingMemoryExceeded,
    MaxShieldUncalibrated,
    MaxShieldProbeFailed,
    maxshield_calibration_for,
    MAXSHIELD_MEM_FACTOR,
    RETRYABLE_CODES,
    reason_for_code,
    should_stream,
    STREAM_EDF_MIN_BYTES,
    compute_worklist,
    ChannelCountMismatch,
    dir_recording_of,
    dir_recordings,
    is_dir_recording,
    is_mefd,
    bti_recordings,
    bti_pdf_choice,
    is_bti_dir,
    is_bti_marker_name,
    MEFD_EXT,
    electrode_positions_for,
    expected_channel_count_for,
    store_total_channels,
    store_metadata,
    embed_attr,
    embed_root_attr,
    event_descriptions_for,
    events_sibling_for,
    fix_source_file_attr,
    in_excluded_tree,
    is_bids_calibration_file,
    _bids_entities,
    is_excluded_from_discovery,
    is_primary,
    is_split_fif,
    materialize_local,
    merge_index,
    parse_annex_key,
    power_line_frequency_for,
    safe_store_prefix,
    split_group_key,
    split_heads_and_members,
    split_index,
    split_members_for,
    store_rel_for,
    INDEX_SCHEMA_PATH,
    MANIFEST_SCHEMA_PATH,
    PENDING_MAX_ATTEMPTS,
    channels_tsv_for,
    check_index_invariant,
    dataset_citation,
    discover_primaries,
    _failure_entry,
    EVENTS_FIXED_COLUMNS,
    EVENTS_PARQUET_NAME,
    EventsStaging,
    PriorEventRows,
    conform_events_table,
    event_rows_for_store,
    events_schema,
    events_row_alert,
    events_summary,
    events_summary_of,
    parse_events_tsv,
    sample_index_for,
    write_events_parquet,
    failure_detail,
    fetch_dataset_row,
    is_commit_sha,
    merge_manifest,
    nemar_store_attrs,
    source_tree_for,
    redact_secrets,
    strip_local_paths,
    validate_document,
)


# Real-shaped 40-hex commit SHAs. `merge_index` refuses anything else since index
# v3: a published index that does not name the commit it was built from is
# unreproducible and cannot seed the next incremental diff, and one was actually
# published that way (on008083 carried `source_commit: ""`, #1197). A placeholder
# like "sha" would now assert the wrong contract.
SHA_OLD = "0" * 39 + "1"
SHA_NEW = "0" * 39 + "2"


def by_dir(primaries: list[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for p in primaries:
        d = p.rsplit("/", 1)[0] if "/" in p else ""
        out.setdefault(d, []).append(p)
    return out


class TestPathClassification(unittest.TestCase):
    def test_is_primary(self):
        self.assertTrue(is_primary("sub-01/eeg/sub-01_task-x_eeg.set"))
        self.assertTrue(is_primary("sub-01/eeg/sub-01_eeg.EDF"))  # case-insensitive
        self.assertTrue(is_primary("sub-01/meg/sub-01_meg.fif"))
        self.assertFalse(is_primary("sub-01/eeg/sub-01_task-x_eeg.fdt"))  # companion
        self.assertFalse(is_primary("sub-01/eeg/sub-01_task-x_events.tsv"))
        self.assertFalse(is_primary("dataset_description.json"))

    def test_store_rel_for(self):
        self.assertEqual(
            store_rel_for("sub-01/eeg/sub-01_task-x_eeg.set"),
            "sub-01/eeg/sub-01_task-x_eeg.zarr",
        )
        self.assertEqual(
            store_rel_for("sub-01/emg/sub-01_task-x_emg.edf"),
            "sub-01/emg/sub-01_task-x_emg.zarr",
        )
        self.assertEqual(
            store_rel_for("sub-01/eeg/sub-01_eeg.vhdr"), "sub-01/eeg/sub-01_eeg.zarr"
        )

    def test_events_sibling_for(self):
        self.assertEqual(
            events_sibling_for("sub-01/eeg/sub-01_task-x_eeg.set"),
            "sub-01/eeg/sub-01_task-x_events.tsv",
        )
        self.assertEqual(
            events_sibling_for("sub-02/emg/sub-02_task-rest_run-1_emg.edf"),
            "sub-02/emg/sub-02_task-rest_run-1_events.tsv",
        )

    def test_events_sibling_for_split_fif_drops_split_entity(self):
        # A split recording shares one events file without the split- entity.
        self.assertEqual(
            events_sibling_for("sub-03/meg/sub-03_task-x_run-02_split-01_meg.fif"),
            "sub-03/meg/sub-03_task-x_run-02_events.tsv",
        )


class TestBidsRawOnlyDiscovery(unittest.TestCase):
    """derivatives/sourcedata/code never hold a BIDS raw recording (nemarOrg/
    nemar-cli#1095/#1098, ADR 0027); BIDS-reserved MEG calibration files are
    excluded by naming convention. Matched on a path SEGMENT, never a bare
    substring."""

    def test_excluded_trees_top_level(self):
        for tree in ("derivatives", "sourcedata", "code"):
            self.assertTrue(
                in_excluded_tree(f"{tree}/sub-01/eeg/sub-01_task-x_eeg.set"),
                tree,
            )

    def test_excluded_trees_nested(self):
        for tree in ("derivatives", "sourcedata", "code"):
            self.assertTrue(
                in_excluded_tree(f"sub-01/{tree}/sub-01_task-x_eeg.set"),
                tree,
            )

    def test_segment_boundary_negatives_are_not_excluded(self):
        # A directory/name that merely CONTAINS an excluded word, but is not
        # that exact path segment, must still be discoverable.
        for path in (
            "mycode/sub-01/eeg/sub-01_task-x_eeg.set",
            "derivatives_old/sub-01/eeg/sub-01_task-x_eeg.set",
            "sourcedatafoo/sub-01/eeg/sub-01_task-x_eeg.set",
            "sub-01/eeg/sub-01_task-code_eeg.set",  # "code" as an entity VALUE
            "sub-01/mycode/sub-01_task-x_eeg.set",
        ):
            self.assertFalse(in_excluded_tree(path), path)
            self.assertTrue(is_primary(path), path)

    def test_is_bids_calibration_file(self):
        self.assertTrue(
            is_bids_calibration_file("sub-01/meg/sub-01_acq-crosstalk_meg.fif")
        )
        self.assertTrue(
            is_bids_calibration_file("sub-01/meg/sub-01_acq-calibration_meg.dat")
        )
        self.assertFalse(is_bids_calibration_file("sub-01/meg/sub-01_task-x_meg.fif"))

    def test_is_primary_excludes_derivatives_sourcedata_code(self):
        for path in (
            "derivatives/preprocessed/sub-01_task-x-epo.fif",
            "sourcedata/sub-01/sub-01_task-x_eeg.set",
            "code/analysis/sub-01_task-x_eeg.set",
            "sub-01/derivatives/sub-01_task-x_eeg.set",
        ):
            self.assertFalse(is_primary(path), path)

    def test_is_primary_excludes_calibration_files(self):
        self.assertFalse(is_primary("sub-01/meg/sub-01_acq-crosstalk_meg.fif"))
        self.assertFalse(is_primary("sub-01/meg/sub-01_acq-calibration_meg.dat"))

    def test_is_excluded_from_discovery_combines_both(self):
        self.assertTrue(is_excluded_from_discovery("derivatives/x/y_eeg.set"))
        self.assertTrue(
            is_excluded_from_discovery("sub-01/meg/sub-01_acq-crosstalk_meg.fif")
        )
        self.assertFalse(is_excluded_from_discovery("sub-01/eeg/sub-01_task-x_eeg.set"))

    def test_full_worklist_excludes_derivatives_sourcedata_code(self):
        head = [
            "sub-01/eeg/sub-01_task-x_eeg.set",
            "derivatives/preprocessed/sub-01_task-x-epo.fif",
            "sourcedata/sub-02/sub-02_task-x_eeg.set",
            "code/analysis/helper.set",
        ]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(convert, ["sub-01/eeg/sub-01_task-x_eeg.set"])
        self.assertEqual(remove, [])

    def test_full_worklist_excludes_ctf_ds_under_derivatives(self):
        head = [
            "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4",
            "derivatives/preprocessed/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4",
        ]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.ds"])
        self.assertEqual(remove, [])

    def test_full_worklist_excludes_split_fif_under_derivatives(self):
        head = [
            "sub-01/meg/sub-01_task-x_split-01_meg.fif",
            "sub-01/meg/sub-01_task-x_split-02_meg.fif",
            "derivatives/x/sub-01_task-x_split-01_meg.fif",
            "derivatives/x/sub-01_task-x_split-02_meg.fif",
        ]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_split-01_meg.fif"])
        self.assertEqual(remove, [])

    def test_full_worklist_excludes_calibration_files(self):
        head = [
            "sub-01/meg/sub-01_task-x_meg.fif",
            "sub-01/meg/sub-01_acq-crosstalk_meg.fif",
        ]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.fif"])
        self.assertEqual(remove, [])

    def test_derivatives_events_tsv_does_not_pull_in_a_recording(self):
        head = ["derivatives/preprocessed/sub-01_task-x_events.tsv"]
        convert, remove = compute_worklist(
            head, [("M", "derivatives/preprocessed/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, [])
        self.assertEqual(remove, [])

    def test_deleting_file_under_excluded_tree_never_removes_a_store(self):
        # A deletion confined to an excluded tree must never be misread as
        # "the recording is gone from HEAD" (it was never a candidate).
        convert, remove = compute_worklist(
            [], [("D", "derivatives/preprocessed/sub-01_task-x-epo.fif")], full=False
        )
        self.assertEqual(convert, [])
        self.assertEqual(remove, [])

    def test_deleting_one_file_of_a_derivatives_ctf_ds_does_not_remove_or_convert(self):
        head = ["derivatives/x/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4"]
        convert, remove = compute_worklist(
            head,
            [("D", "derivatives/x/sub-01_task-x_meg.ds/BadChannels")],
            full=False,
        )
        self.assertEqual(convert, [])
        self.assertEqual(remove, [])


class TestAffectedPrimaries(unittest.TestCase):
    def setUp(self):
        self.primaries = [
            "sub-01/eeg/sub-01_task-x_eeg.set",
            "sub-01/eeg/sub-01_eeg.vhdr",
        ]
        self.bd = by_dir(self.primaries)

    def test_primary_maps_to_itself(self):
        self.assertEqual(
            affected_primaries("sub-01/eeg/sub-01_task-x_eeg.set", self.bd),
            {"sub-01/eeg/sub-01_task-x_eeg.set"},
        )

    def test_primary_not_at_head_maps_to_nothing(self):
        self.assertEqual(affected_primaries("sub-09/eeg/sub-09_eeg.set", self.bd), set())

    def test_fdt_companion_maps_to_set(self):
        self.assertEqual(
            affected_primaries("sub-01/eeg/sub-01_task-x_eeg.fdt", self.bd),
            {"sub-01/eeg/sub-01_task-x_eeg.set"},
        )

    def test_brainvision_companions_map_to_vhdr(self):
        for comp in ("sub-01/eeg/sub-01_eeg.eeg", "sub-01/eeg/sub-01_eeg.vmrk"):
            self.assertEqual(
                affected_primaries(comp, self.bd), {"sub-01/eeg/sub-01_eeg.vhdr"}
            )

    def test_events_maps_to_same_base_primaries(self):
        self.assertEqual(
            affected_primaries("sub-01/eeg/sub-01_task-x_events.tsv", self.bd),
            {"sub-01/eeg/sub-01_task-x_eeg.set"},
        )


class TestComputeWorklist(unittest.TestCase):
    def setUp(self):
        self.head = [
            "dataset_description.json",
            "sub-01/eeg/sub-01_task-x_eeg.set",
            "sub-01/eeg/sub-01_task-x_eeg.fdt",
            "sub-01/eeg/sub-01_task-x_events.tsv",
            "sub-02/eeg/sub-02_task-x_eeg.set",
        ]

    def test_full_converts_every_primary(self):
        convert, remove = compute_worklist(self.head, [], full=True)
        self.assertEqual(
            convert,
            ["sub-01/eeg/sub-01_task-x_eeg.set", "sub-02/eeg/sub-02_task-x_eeg.set"],
        )
        self.assertEqual(remove, [])

    def test_modify_primary(self):
        convert, remove = compute_worklist(
            self.head, [("M", "sub-01/eeg/sub-01_task-x_eeg.set")], full=False
        )
        self.assertEqual(convert, ["sub-01/eeg/sub-01_task-x_eeg.set"])
        self.assertEqual(remove, [])

    def test_modify_events_only(self):
        convert, _ = compute_worklist(
            self.head, [("M", "sub-01/eeg/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, ["sub-01/eeg/sub-01_task-x_eeg.set"])

    def test_modify_companion_only(self):
        convert, _ = compute_worklist(
            self.head, [("M", "sub-01/eeg/sub-01_task-x_eeg.fdt")], full=False
        )
        self.assertEqual(convert, ["sub-01/eeg/sub-01_task-x_eeg.set"])

    def test_delete_primary_removes_store(self):
        head = [p for p in self.head if p != "sub-02/eeg/sub-02_task-x_eeg.set"]
        convert, remove = compute_worklist(
            head, [("D", "sub-02/eeg/sub-02_task-x_eeg.set")], full=False
        )
        self.assertEqual(convert, [])
        self.assertEqual(remove, ["sub-02/eeg/sub-02_task-x_eeg.zarr"])

    def test_rename_is_remove_plus_convert(self):
        # git diff --no-renames emits D old + A new
        head = [
            "sub-01/eeg/sub-01_task-y_eeg.set",  # renamed-to exists at HEAD
        ]
        convert, remove = compute_worklist(
            head,
            [
                ("D", "sub-01/eeg/sub-01_task-x_eeg.set"),
                ("A", "sub-01/eeg/sub-01_task-y_eeg.set"),
            ],
            full=False,
        )
        self.assertEqual(convert, ["sub-01/eeg/sub-01_task-y_eeg.set"])
        self.assertEqual(remove, ["sub-01/eeg/sub-01_task-x_eeg.zarr"])

    def test_delete_events_reconverts_sibling(self):
        # events.tsv removed but the recording remains -> rebuild without events
        convert, remove = compute_worklist(
            self.head, [("D", "sub-01/eeg/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, ["sub-01/eeg/sub-01_task-x_eeg.set"])
        self.assertEqual(remove, [])

    def test_metadata_only_change_is_empty(self):
        convert, remove = compute_worklist(
            self.head, [("M", "dataset_description.json")], full=False
        )
        self.assertEqual(convert, [])
        self.assertEqual(remove, [])


class TestSidecarRebuildsDirectoryRecordings(unittest.TestCase):
    """#1106: an events/companion edit beside a DIRECTORY recording must rebuild it.

    `by_dir` was keyed on file heads only, so `affected_primaries` got an empty
    bucket for a CTF `.ds` / MEF3 `.mefd` / 4D-BTi directory and an events edit
    queued nothing at all. The `--clean` cron papered over it on the next full
    rebuild, which is why it stayed invisible.
    """

    CTF = [
        "dataset_description.json",
        "sub-01/meg/sub-01_task-x_meg.ds/res4",
        "sub-01/meg/sub-01_task-x_meg.ds/meg4",
        "sub-01/meg/sub-01_task-x_events.tsv",
    ]
    MEFD = [
        "sub-01/ieeg/sub-01_task-x_ieeg.mefd/segment.1/x.rdat",
        "sub-01/ieeg/sub-01_task-x_ieeg.mefd/segment.1/x.ridx",
        "sub-01/ieeg/sub-01_task-x_events.tsv",
    ]
    BTI = [
        "sub-01/meg/sub-01_task-x_meg/c,rfDC",
        "sub-01/meg/sub-01_task-x_meg/config",
        "sub-01/meg/sub-01_task-x_meg/hs_file",
        "sub-01/meg/sub-01_task-x_events.tsv",
    ]

    def test_events_edit_rebuilds_ctf_ds(self):
        convert, remove = compute_worklist(
            self.CTF, [("M", "sub-01/meg/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.ds"])
        self.assertEqual(remove, [])

    def test_events_edit_rebuilds_mefd(self):
        convert, _ = compute_worklist(
            self.MEFD, [("M", "sub-01/ieeg/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, ["sub-01/ieeg/sub-01_task-x_ieeg.mefd"])

    def test_events_edit_rebuilds_bti(self):
        convert, _ = compute_worklist(
            self.BTI, [("M", "sub-01/meg/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg"])

    def test_events_added_rebuilds(self):
        convert, _ = compute_worklist(
            self.CTF, [("A", "sub-01/meg/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.ds"])

    def test_events_deleted_still_rebuilds_without_events(self):
        # The recording survives, so it must be regenerated WITHOUT the events
        # block rather than left carrying stale annotations.
        head = [p for p in self.CTF if not p.endswith("_events.tsv")]
        convert, remove = compute_worklist(
            head, [("D", "sub-01/meg/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.ds"])
        self.assertEqual(remove, [])

    def test_events_for_a_different_task_does_not_rebuild(self):
        # Guards against the fix over-matching: same directory, different entities.
        head = [*self.CTF, "sub-01/meg/sub-01_task-y_events.tsv"]
        convert, _ = compute_worklist(
            head, [("M", "sub-01/meg/sub-01_task-y_events.tsv")], full=False
        )
        self.assertEqual(convert, [])

    def test_only_the_matching_recording_rebuilds_among_siblings(self):
        head = [
            "sub-01/meg/sub-01_task-x_meg.ds/res4",
            "sub-01/meg/sub-01_task-y_meg.ds/res4",
            "sub-01/meg/sub-01_task-x_events.tsv",
        ]
        convert, _ = compute_worklist(
            head, [("M", "sub-01/meg/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.ds"])

    def test_file_and_directory_recordings_coexist_in_one_directory(self):
        # A directory recording must not displace a file primary sharing the dir.
        head = [
            "sub-01/meg/sub-01_task-x_meg.ds/res4",
            "sub-01/meg/sub-01_task-x_meg.fif",
            "sub-01/meg/sub-01_task-x_events.tsv",
        ]
        convert, _ = compute_worklist(
            head, [("M", "sub-01/meg/sub-01_task-x_events.tsv")], full=False
        )
        self.assertEqual(
            convert,
            ["sub-01/meg/sub-01_task-x_meg.ds", "sub-01/meg/sub-01_task-x_meg.fif"],
        )

    def test_change_inside_the_recording_directory_still_rebuilds(self):
        # Regression guard: this path is resolved by `dir_recording_of` BEFORE
        # `by_dir` is consulted, and must stay that way.
        convert, remove = compute_worklist(
            self.CTF, [("M", "sub-01/meg/sub-01_task-x_meg.ds/meg4")], full=False
        )
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.ds"])
        self.assertEqual(remove, [])

    def test_unrelated_sidecar_in_another_directory_does_not_rebuild(self):
        head = [*self.CTF, "sub-02/meg/sub-02_task-x_events.tsv"]
        convert, _ = compute_worklist(
            head, [("M", "sub-02/meg/sub-02_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, [])

    def test_session_run_and_acq_entities_route_to_the_right_run(self):
        # The flat sub-01 fixtures above are not how CTF/MEF3 data actually
        # arrives: these are precisely the multi-session, multi-run formats. The
        # entities-base matching is shared with file primaries, but it had never
        # been exercised on a directory recording, so pin it.
        head = [
            "sub-01/ses-01/meg/sub-01_ses-01_task-x_acq-hi_run-1_meg.ds/res4",
            "sub-01/ses-01/meg/sub-01_ses-01_task-x_acq-hi_run-2_meg.ds/res4",
            "sub-01/ses-01/meg/sub-01_ses-01_task-x_acq-hi_run-1_events.tsv",
            "sub-01/ses-01/meg/sub-01_ses-01_task-x_acq-hi_run-2_events.tsv",
            "sub-01/ses-02/meg/sub-01_ses-02_task-x_acq-hi_run-1_meg.ds/res4",
            "sub-01/ses-02/meg/sub-01_ses-02_task-x_acq-hi_run-1_events.tsv",
        ]
        convert, _ = compute_worklist(
            head,
            [("M", "sub-01/ses-01/meg/sub-01_ses-01_task-x_acq-hi_run-2_events.tsv")],
            full=False,
        )
        self.assertEqual(
            convert, ["sub-01/ses-01/meg/sub-01_ses-01_task-x_acq-hi_run-2_meg.ds"]
        )
        # And the same-numbered run in the OTHER session is untouched.
        convert, _ = compute_worklist(
            head,
            [("M", "sub-01/ses-02/meg/sub-01_ses-02_task-x_acq-hi_run-1_events.tsv")],
            full=False,
        )
        self.assertEqual(
            convert, ["sub-01/ses-02/meg/sub-01_ses-02_task-x_acq-hi_run-1_meg.ds"]
        )


class TestMergeIndex(unittest.TestCase):
    def test_upsert_remove_and_carry_over(self):
        prior = {
            "source_commit": SHA_OLD,
            "stores": [
                {"zarr": "sub-01/eeg/a_eeg.zarr", "store": "old-a"},
                {"zarr": "sub-02/eeg/b_eeg.zarr", "store": "keep-b"},
            ],
        }
        converted = [{"zarr": "sub-01/eeg/a_eeg.zarr", "store": "new-a"}]
        index = merge_index(
            prior, "nm000104", SHA_NEW, converted, ["sub-02/eeg/b_eeg.zarr"], "2026-06-02T00:00:00Z"
        )
        self.assertEqual(index["source_commit"], SHA_NEW)
        self.assertEqual(index["store_count"], 1)
        self.assertEqual(index["format"], "nemar-zarr-index")
        # v3 normalizes every published entry, this run's and the carried-over
        # ones alike, so one index never mixes shapes (see _normalize_store_entry).
        self.assertEqual(
            index["stores"],
            [{
                "zarr": "sub-01/eeg/a_eeg.zarr",
                "store": "new-a",
                "source_tree": "raw",
                "derived": False,
            }],
        )

    def test_no_prior_builds_fresh(self):
        index = merge_index(
            None, "nm000104", SHA_NEW, [{"zarr": "x/y_eeg.zarr"}], [], "2026-06-02T00:00:00Z"
        )
        self.assertEqual(index["store_count"], 1)
        self.assertEqual([s["zarr"] for s in index["stores"]], ["x/y_eeg.zarr"])

    def test_stores_sorted_by_zarr_path(self):
        converted = [{"zarr": "b.zarr"}, {"zarr": "a.zarr"}]
        index = merge_index(None, "nm000104", SHA_NEW, converted, [], "2026-06-02T00:00:00Z")
        self.assertEqual([s["zarr"] for s in index["stores"]], ["a.zarr", "b.zarr"])


class TestSafeStorePrefix(unittest.TestCase):
    def test_valid_store_path(self):
        self.assertEqual(
            safe_store_prefix("nemar", "nm000104", "sub-01/eeg/sub-01_task-x_eeg.zarr"),
            "s3://nemar/nm000104/zarr/sub-01/eeg/sub-01_task-x_eeg.zarr/",
        )

    def test_rejects_empty(self):
        with self.assertRaises(ValueError):
            safe_store_prefix("nemar", "nm000104", "")

    def test_rejects_non_zarr(self):
        with self.assertRaises(ValueError):
            safe_store_prefix("nemar", "nm000104", "sub-01/eeg/sub-01_eeg.set")

    def test_rejects_traversal(self):
        for bad in ("../escape.zarr", "sub-01/../../x.zarr", "/abs/x.zarr", "a//b.zarr"):
            with self.assertRaises(ValueError):
                safe_store_prefix("nemar", "nm000104", bad)


class TestMaterializeLocal(unittest.TestCase):
    def test_resolves_working_tree_paths_and_annex_key(self):
        key = "SHA256E-s100--abcdef.set"
        primary = "sub-01/eeg/sub-01_task-x_eeg.set"
        events = "sub-01/eeg/sub-01_task-x_events.tsv"
        with tempfile.TemporaryDirectory() as repo:
            os.makedirs(os.path.join(repo, "sub-01", "eeg"))
            # annex-style symlink for the primary; a plain file for the events sidecar
            os.symlink(
                f"../../.git/annex/objects/aa/bb/{key}/{key}",
                os.path.join(repo, primary),
            )
            with open(os.path.join(repo, events), "w") as fh:
                fh.write("onset\tduration\n0\t0\n")
            pl, el, k = materialize_local(repo, primary, {primary, events})
            self.assertEqual(pl, os.path.join(repo, primary))
            self.assertEqual(el, os.path.join(repo, events))
            self.assertEqual(k, key)

    def test_no_events_sibling_when_absent(self):
        primary = "sub-02/eeg/sub-02_task-x_eeg.edf"
        with tempfile.TemporaryDirectory() as repo:
            os.makedirs(os.path.join(repo, "sub-02", "eeg"))
            with open(os.path.join(repo, primary), "w") as fh:
                fh.write("not-an-annex-blob")  # regular in-git file -> key None
            pl, el, k = materialize_local(repo, primary, {primary})
            self.assertEqual(pl, os.path.join(repo, primary))
            self.assertIsNone(el)
            self.assertIsNone(k)


class TestParseAnnexKey(unittest.TestCase):
    def test_locked_symlink_target(self):
        key = "SHA256E-s12345--abcdef0123456789.set"
        target = f"../../.git/annex/objects/aa/bb/{key}/{key}"
        self.assertEqual(parse_annex_key(target), key)

    def test_unlocked_pointer_content(self):
        key = "MD5E-s59778400--abc.edf"
        self.assertEqual(parse_annex_key(f"/annex/objects/{key}"), key)

    def test_non_annex_blob_returns_none(self):
        self.assertIsNone(parse_annex_key("just some file contents\n"))


class TestBidsSuffixModality(unittest.TestCase):
    def test_known_suffixes_map_to_modality(self):
        self.assertEqual(bids_suffix_modality("sub-01/eeg/sub-01_task-rest_eeg.set"), "EEG")
        self.assertEqual(bids_suffix_modality("sub-01/meg/sub-01_task-rest_meg.fif"), "MEG")
        self.assertEqual(bids_suffix_modality("sub-01/ieeg/sub-01_task-rest_ieeg.edf"), "IEEG")
        self.assertEqual(bids_suffix_modality("sub-01/emg/sub-01_task-grip_emg.edf"), "EMG")

    def test_suffix_is_case_insensitive_and_uses_basename(self):
        self.assertEqual(bids_suffix_modality("X/sub-01_task-A_EEG.SET"), "EEG")

    def test_unknown_or_missing_suffix_returns_none(self):
        self.assertIsNone(bids_suffix_modality("sub-01/beh/sub-01_task-rest_physio.tsv"))
        self.assertIsNone(bids_suffix_modality("sub-01/eeg/sub-01_channels.tsv"))
        self.assertIsNone(bids_suffix_modality("noextnounderscore"))


class TestPowerLineFrequencyFor(unittest.TestCase):
    def _write(self, root: str, rel: str, body: dict) -> None:
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(body, fh)

    def test_sibling_sidecar_wins_over_root(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self._write(d, "sub-01/eeg/sub-01_task-rest_eeg.json", {"PowerLineFrequency": 60})
            self._write(d, "task-rest_eeg.json", {"PowerLineFrequency": 50})  # less specific
            head = {"sub-01/eeg/sub-01_task-rest_eeg.json", "task-rest_eeg.json"}
            self.assertEqual(power_line_frequency_for(d, rec, head, "HEAD"), 60.0)

    def test_inherited_from_root_when_no_sibling(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self._write(d, "task-rest_eeg.json", {"PowerLineFrequency": 50})
            head = {"task-rest_eeg.json"}
            self.assertEqual(power_line_frequency_for(d, rec, head, "HEAD"), 50.0)

    def test_none_when_field_absent(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self._write(d, "sub-01/eeg/sub-01_task-rest_eeg.json", {"SamplingFrequency": 1024})
            head = {"sub-01/eeg/sub-01_task-rest_eeg.json"}
            self.assertIsNone(power_line_frequency_for(d, rec, head, "HEAD"))

    def test_non_subset_entities_do_not_apply(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            # A sidecar for a different task must not apply to this recording.
            self._write(d, "sub-01/eeg/sub-01_task-other_eeg.json", {"PowerLineFrequency": 60})
            head = {"sub-01/eeg/sub-01_task-other_eeg.json"}
            self.assertIsNone(power_line_frequency_for(d, rec, head, "HEAD"))

    def test_wrong_suffix_does_not_satisfy(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self._write(d, "sub-01/eeg/sub-01_task-rest_ieeg.json", {"PowerLineFrequency": 60})
            head = {"sub-01/eeg/sub-01_task-rest_ieeg.json"}
            self.assertIsNone(power_line_frequency_for(d, rec, head, "HEAD"))

    def test_non_numeric_value_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self._write(d, "sub-01/eeg/sub-01_task-rest_eeg.json", {"PowerLineFrequency": "n/a"})
            head = {"sub-01/eeg/sub-01_task-rest_eeg.json"}
            self.assertIsNone(power_line_frequency_for(d, rec, head, "HEAD"))

    def test_reads_via_git_when_no_working_tree(self):
        # The workflow clones --no-checkout, so the sidecar is only in the git
        # object store, not on disk. Resolution must fall back to `git cat-file`.
        sidecar = "sub-01/eeg/sub-01_task-rest_eeg.json"
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as clone_parent:
            self._write(src, sidecar, {"PowerLineFrequency": 60})
            env = {
                **os.environ,
                "GIT_AUTHOR_NAME": "t",
                "GIT_AUTHOR_EMAIL": "t@t",
                "GIT_COMMITTER_NAME": "t",
                "GIT_COMMITTER_EMAIL": "t@t",
            }
            def run(*a: str) -> None:
                subprocess.run(a, check=True, env=env, capture_output=True)

            run("git", "-C", src, "init", "-q", "-b", "main")
            run("git", "-C", src, "add", "-A")
            run("git", "-C", src, "commit", "-qm", "init")
            clone = os.path.join(clone_parent, "repo")
            run("git", "clone", "--no-checkout", "-q", src, clone)
            self.assertFalse(os.path.exists(os.path.join(clone, sidecar)))  # no working tree
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self.assertEqual(
                power_line_frequency_for(clone, rec, {sidecar}, "HEAD"), 60.0
            )


class TestEmbedRootAttr(unittest.TestCase):
    def test_adds_attribute_and_preserves_existing(self):
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "rec.zarr")
            os.makedirs(store)
            with open(os.path.join(store, "zarr.json"), "w", encoding="utf-8") as fh:
                json.dump(
                    {
                        "zarr_format": 3,
                        "node_type": "group",
                        "attributes": {"format": "biosigio-zarr", "channel_groups": ["eeg_250hz"]},
                    },
                    fh,
                )
            embed_root_attr(store, "power_line_frequency", 60.0)
            with open(os.path.join(store, "zarr.json"), encoding="utf-8") as fh:
                doc = json.load(fh)
            self.assertEqual(doc["attributes"]["power_line_frequency"], 60.0)
            self.assertEqual(doc["attributes"]["channel_groups"], ["eeg_250hz"])  # preserved


class TestEmbedAttr(unittest.TestCase):
    """embed_attr writes into an arbitrary group zarr.json, not only the store root."""

    def _make_zarr_json(self, path: str, attrs: dict) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"zarr_format": 3, "node_type": "group", "attributes": attrs}, fh)

    def test_writes_into_sub_group_zarr_json(self):
        with tempfile.TemporaryDirectory() as d:
            meta = os.path.join(d, "rec.zarr", "events", "zarr.json")
            self._make_zarr_json(meta, {"n_events": 42, "label_map": {}})
            embed_attr(meta, "value_descriptions", {"21": "stimulus - face"})
            with open(meta, encoding="utf-8") as fh:
                doc = json.load(fh)
            self.assertEqual(doc["attributes"]["value_descriptions"], {"21": "stimulus - face"})
            self.assertEqual(doc["attributes"]["n_events"], 42)  # preserved

    def test_creates_attributes_when_absent(self):
        with tempfile.TemporaryDirectory() as d:
            meta = os.path.join(d, "zarr.json")
            with open(meta, "w", encoding="utf-8") as fh:
                json.dump({"zarr_format": 3}, fh)
            embed_attr(meta, "my_key", "my_value")
            with open(meta, encoding="utf-8") as fh:
                doc = json.load(fh)
            self.assertEqual(doc["attributes"]["my_key"], "my_value")

    def test_embed_root_attr_delegates(self):
        """embed_root_attr must still work (it now delegates to embed_attr)."""
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "rec.zarr")
            os.makedirs(store)
            with open(os.path.join(store, "zarr.json"), "w", encoding="utf-8") as fh:
                json.dump({"zarr_format": 3, "attributes": {"x": 1}}, fh)
            embed_root_attr(store, "power_line_frequency", 50.0)
            with open(os.path.join(store, "zarr.json"), encoding="utf-8") as fh:
                doc = json.load(fh)
            self.assertEqual(doc["attributes"]["power_line_frequency"], 50.0)
            self.assertEqual(doc["attributes"]["x"], 1)


class TestFixSourceFileAttr(unittest.TestCase):
    """recording_metadata.source_file must be the reproducible BIDS-repo-
    relative path, not the conversion host's ephemeral scratch path biosigIO
    was handed (nemarOrg/nemar-cli#1102)."""

    def _make_store(self, d: str, recording_metadata: dict) -> str:
        store = os.path.join(d, "rec.zarr")
        os.makedirs(store)
        with open(os.path.join(store, "zarr.json"), "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "zarr_format": 3,
                    "node_type": "group",
                    "attributes": {
                        "format": "biosigio-zarr",
                        "channel_groups": ["eeg_250hz"],
                        "recording_metadata": recording_metadata,
                    },
                },
                fh,
            )
        return store

    def test_overwrites_scratch_path_with_bids_relpath(self):
        with tempfile.TemporaryDirectory() as d:
            store = self._make_store(
                d,
                {
                    "source_file": (
                        "/mnt/local/zarr-scratch/tmpv58rz85q/work/"
                        "sub-1_task-x_eeg.bdf/sub-1_task-x_eeg.bdf"
                    ),
                    "source_format": "bdf",
                },
            )
            bids_path = "sub-1/eeg/sub-1_task-x_eeg.bdf"
            fix_source_file_attr(store, bids_path)
            with open(os.path.join(store, "zarr.json"), encoding="utf-8") as fh:
                doc = json.load(fh)
            rec_meta = doc["attributes"]["recording_metadata"]
            self.assertEqual(rec_meta["source_file"], bids_path)
            self.assertEqual(rec_meta["source_format"], "bdf")  # other keys preserved
            self.assertEqual(
                doc["attributes"]["channel_groups"], ["eeg_250hz"]
            )  # sibling root attrs preserved

    def test_reconversion_is_reproducible_across_different_scratch_dirs(self):
        # The whole point: two runs with DIFFERENT mkdtemp scratch dirs must
        # converge on the SAME source_file once fixed, since only the fix
        # (not biosigIO) determines the published value.
        bids_path = "sub-1/eeg/sub-1_task-x_eeg.bdf"
        results = []
        for tmp_name in ("tmpaaaaaaaa", "tmpbbbbbbbb"):
            with tempfile.TemporaryDirectory() as d:
                store = self._make_store(
                    d,
                    {"source_file": f"/mnt/local/zarr-scratch/{tmp_name}/work/x.bdf"},
                )
                fix_source_file_attr(store, bids_path)
                with open(os.path.join(store, "zarr.json"), encoding="utf-8") as fh:
                    doc = json.load(fh)
                results.append(doc["attributes"]["recording_metadata"]["source_file"])
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0], bids_path)

    def test_missing_recording_metadata_does_not_raise(self):
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "rec.zarr")
            os.makedirs(store)
            with open(os.path.join(store, "zarr.json"), "w", encoding="utf-8") as fh:
                json.dump({"zarr_format": 3, "attributes": {"format": "biosigio-zarr"}}, fh)
            fix_source_file_attr(store, "sub-1/eeg/sub-1_task-x_eeg.bdf")  # must not raise
            with open(os.path.join(store, "zarr.json"), encoding="utf-8") as fh:
                doc = json.load(fh)
            self.assertNotIn("recording_metadata", doc["attributes"])  # not fabricated

    def test_explicit_null_attributes_does_not_raise(self):
        # `"attributes": null` makes .get("attributes", {}) return None, so a
        # chained .get would raise AttributeError rather than skipping cleanly.
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "rec.zarr")
            os.makedirs(store)
            with open(os.path.join(store, "zarr.json"), "w", encoding="utf-8") as fh:
                json.dump({"zarr_format": 3, "attributes": None}, fh)
            fix_source_file_attr(store, "sub-1/eeg/sub-1_task-x_eeg.bdf")  # must not raise

    def test_rewrite_leaves_no_temp_file_and_keeps_zarr_json_parseable(self):
        # The rewrite goes through a sibling temp + os.replace so an interruption
        # can never leave a truncated zarr.json that validate_store (which only
        # checks existence) would wave through.
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "rec.zarr")
            os.makedirs(store)
            with open(os.path.join(store, "zarr.json"), "w", encoding="utf-8") as fh:
                json.dump(
                    {
                        "zarr_format": 3,
                        "attributes": {
                            "format": "biosigio-zarr",
                            "recording_metadata": {"source_file": "/mnt/local/zarr-scratch/t/x.bdf"},
                        },
                    },
                    fh,
                )
            fix_source_file_attr(store, "sub-1/eeg/sub-1_task-x_eeg.bdf")
            self.assertEqual(sorted(os.listdir(store)), ["zarr.json"])  # no .tmp left behind
            with open(os.path.join(store, "zarr.json"), encoding="utf-8") as fh:
                doc = json.load(fh)  # parses, i.e. not truncated
            self.assertEqual(
                doc["attributes"]["recording_metadata"]["source_file"],
                "sub-1/eeg/sub-1_task-x_eeg.bdf",
            )
            self.assertEqual(doc["attributes"]["format"], "biosigio-zarr")  # siblings intact


class TestEventDescriptionsFor(unittest.TestCase):
    def _write(self, root: str, rel: str, body: dict) -> None:
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(body, fh)

    def test_sibling_sidecar_wins_over_root(self):
        """Most-specific sidecar overrides less-specific one for the same code."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            # Root-level (less specific): code 1 -> "boundary event"
            self._write(d, "task-rest_events.json", {
                "value": {"Levels": {"1": "boundary event", "21": "generic face"}},
            })
            # Sibling (more specific): code 21 overrides; code 99 is new
            self._write(d, "sub-01/eeg/sub-01_task-rest_events.json", {
                "value": {"Levels": {"21": "stimulus - face", "99": "response"}},
            })
            head = {
                "task-rest_events.json",
                "sub-01/eeg/sub-01_task-rest_events.json",
            }
            result = event_descriptions_for(d, rec, head, "HEAD")
            self.assertEqual(result["21"], "stimulus - face")  # sibling wins
            self.assertEqual(result["1"], "boundary event")    # root carries over
            self.assertEqual(result["99"], "response")          # sibling-only code

    def test_inherited_from_root_when_no_sibling(self):
        """on007139 pattern: events.json at dataset root, no sibling in eeg dir."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-Flanker_eeg.set"
            self._write(d, "task-Flanker_events.json", {
                "value": {"Levels": {"1": "left arrow", "2": "right arrow"}},
            })
            head = {"task-Flanker_events.json"}
            result = event_descriptions_for(d, rec, head, "HEAD")
            self.assertEqual(result, {"1": "left arrow", "2": "right arrow"})

    def test_merge_levels_across_multiple_columns(self):
        """Codes from 'value' and 'trial_type' columns are both captured."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-x_eeg.set"
            self._write(d, "sub-01/eeg/sub-01_task-x_events.json", {
                "value": {"Levels": {"21": "stimulus - face"}},
                "trial_type": {"Levels": {"go": "go trial", "nogo": "no-go trial"}},
            })
            head = {"sub-01/eeg/sub-01_task-x_events.json"}
            result = event_descriptions_for(d, rec, head, "HEAD")
            self.assertIn("21", result)
            self.assertIn("go", result)
            self.assertIn("nogo", result)

    def test_non_subset_entities_not_applied(self):
        """A sidecar for a different task must not apply to this recording."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self._write(d, "sub-01/eeg/sub-01_task-other_events.json", {
                "value": {"Levels": {"10": "face"}},
            })
            head = {"sub-01/eeg/sub-01_task-other_events.json"}
            result = event_descriptions_for(d, rec, head, "HEAD")
            self.assertEqual(result, {})

    def test_absent_sidecar_returns_empty(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            result = event_descriptions_for(d, rec, set(), "HEAD")
            self.assertEqual(result, {})

    def test_non_string_values_ignored(self):
        """Levels entries with non-string key or value are skipped."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            # JSON keys are always strings, but values might be non-string
            self._write(d, "sub-01/eeg/sub-01_task-rest_events.json", {
                "value": {"Levels": {"21": 42, "22": None, "23": "valid"}},
            })
            head = {"sub-01/eeg/sub-01_task-rest_events.json"}
            result = event_descriptions_for(d, rec, head, "HEAD")
            self.assertEqual(result, {"23": "valid"})

    def test_empty_string_keys_and_values_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self._write(d, "sub-01/eeg/sub-01_task-rest_events.json", {
                "value": {"Levels": {"": "empty key", "21": ""}},
            })
            head = {"sub-01/eeg/sub-01_task-rest_events.json"}
            result = event_descriptions_for(d, rec, head, "HEAD")
            self.assertEqual(result, {})

    def test_no_levels_field_returns_empty(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self._write(d, "sub-01/eeg/sub-01_task-rest_events.json", {
                "value": {"Description": "the event value column", "Units": "n/a"},
            })
            head = {"sub-01/eeg/sub-01_task-rest_events.json"}
            result = event_descriptions_for(d, rec, head, "HEAD")
            self.assertEqual(result, {})

    def test_reads_via_git_when_no_working_tree(self):
        """Mirrors the PLF git test: clone --no-checkout, must use git cat-file."""
        sidecar = "sub-01/eeg/sub-01_task-rest_events.json"
        sidecar_body = {"value": {"Levels": {"10": "face", "20": "house"}}}
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as clone_parent:
            p = os.path.join(src, sidecar)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w", encoding="utf-8") as fh:
                json.dump(sidecar_body, fh)
            env = {
                **os.environ,
                "GIT_AUTHOR_NAME": "t",
                "GIT_AUTHOR_EMAIL": "t@t",
                "GIT_COMMITTER_NAME": "t",
                "GIT_COMMITTER_EMAIL": "t@t",
            }

            def run(*a: str) -> None:
                subprocess.run(a, check=True, env=env, capture_output=True)

            run("git", "-C", src, "init", "-q", "-b", "main")
            run("git", "-C", src, "add", "-A")
            run("git", "-C", src, "commit", "-qm", "init")
            clone = os.path.join(clone_parent, "repo")
            run("git", "clone", "--no-checkout", "-q", src, clone)
            self.assertFalse(os.path.exists(os.path.join(clone, sidecar)))
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            result = event_descriptions_for(clone, rec, {sidecar}, "HEAD")
            self.assertEqual(result, {"10": "face", "20": "house"})


class TestElectrodePositionsFor(unittest.TestCase):
    """Tests for electrode_positions_for -- TSV parsing, BIDS inheritance, coordsystem."""

    def _write(self, root: str, rel: str, body: str) -> None:
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(body)

    def _write_json(self, root: str, rel: str, body: dict) -> None:
        self._write(root, rel, json.dumps(body))

    def _tsv(self, *rows: tuple) -> str:
        return "\n".join("\t".join(str(c) for c in row) for row in rows) + "\n"

    # -- TSV parsing -----------------------------------------------------------

    def test_standard_tsv_parses_positions(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("FP1", "80.784", "26.133", "-4.001"),
                ("FP2", "-80.784", "26.133", "-4.001"),
            )
            self._write(d, "sub-01/eeg/sub-01_task-rest_electrodes.tsv", tsv)
            head = {"sub-01/eeg/sub-01_task-rest_electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertAlmostEqual(result["positions"]["FP1"][0], 80.784)
            self.assertAlmostEqual(result["positions"]["FP2"][0], -80.784)

    def test_extra_columns_do_not_break_parsing(self):
        """Columns like type, impedance, status after z must be ignored."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-x_eeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z", "type", "impedance"),
                ("Fz", "1.0", "2.0", "3.0", "EEG", "5"),
                ("Cz", "0.0", "0.0", "4.0", "EEG", "n/a"),
            )
            self._write(d, "sub-01/eeg/sub-01_task-x_electrodes.tsv", tsv)
            head = {"sub-01/eeg/sub-01_task-x_electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertIn("Fz", result["positions"])
            self.assertIn("Cz", result["positions"])
            self.assertEqual(result["positions"]["Fz"], [1.0, 2.0, 3.0])

    def test_non_standard_column_order(self):
        """z before y before x order must still work."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_eeg.set"
            tsv = self._tsv(
                ("z", "name", "y", "x"),
                ("9.0", "Oz", "0.0", "0.0"),
            )
            self._write(d, "sub-01/eeg/sub-01_electrodes.tsv", tsv)
            head = {"sub-01/eeg/sub-01_electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertEqual(result["positions"]["Oz"], [0.0, 0.0, 9.0])

    def test_na_rows_skipped(self):
        """Rows where x, y, or z is 'n/a' (case-insensitive) must be skipped."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_eeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("FP1", "80.0", "26.0", "n/a"),
                ("FP2", "N/A", "26.0", "-4.0"),
                ("Cz", "0.0", "0.0", "88.0"),
            )
            self._write(d, "sub-01/eeg/sub-01_electrodes.tsv", tsv)
            head = {"sub-01/eeg/sub-01_electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertNotIn("FP1", result["positions"])
            self.assertNotIn("FP2", result["positions"])
            self.assertIn("Cz", result["positions"])

    def test_non_numeric_rows_skipped(self):
        """Rows where x/y/z cannot be parsed as float must be skipped."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_eeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("REF", "unknown", "0.0", "0.0"),
                ("Cz", "0.0", "0.0", "88.0"),
            )
            self._write(d, "sub-01/eeg/sub-01_electrodes.tsv", tsv)
            head = {"sub-01/eeg/sub-01_electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertNotIn("REF", result["positions"])
            self.assertIn("Cz", result["positions"])

    def test_missing_name_xyz_columns_returns_none(self):
        """A TSV without a 'name' or 'x'/'y'/'z' column must return None."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_eeg.set"
            tsv = self._tsv(
                ("label", "lat", "lon"),
                ("FP1", "10.0", "20.0"),
            )
            self._write(d, "sub-01/eeg/sub-01_electrodes.tsv", tsv)
            head = {"sub-01/eeg/sub-01_electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNone(result)

    def test_all_rows_skipped_returns_none(self):
        """If all data rows are invalid (all n/a), return None."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_eeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("FP1", "n/a", "n/a", "n/a"),
            )
            self._write(d, "sub-01/eeg/sub-01_electrodes.tsv", tsv)
            head = {"sub-01/eeg/sub-01_electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNone(result)

    # -- BIDS inheritance ------------------------------------------------------

    def test_absent_electrodes_tsv_returns_none(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            result = electrode_positions_for(d, rec, set(), "HEAD")
            self.assertIsNone(result)

    def test_sibling_beats_root(self):
        """More-specific sibling must win over a root-level electrodes.tsv."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            root_tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("FP1", "1.0", "2.0", "3.0"),
            )
            sibling_tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("FP1", "80.0", "26.0", "-4.0"),
            )
            self._write(d, "electrodes.tsv", root_tsv)
            self._write(d, "sub-01/eeg/sub-01_task-rest_electrodes.tsv", sibling_tsv)
            head = {
                "electrodes.tsv",
                "sub-01/eeg/sub-01_task-rest_electrodes.tsv",
            }
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertAlmostEqual(result["positions"]["FP1"][0], 80.0)

    def test_root_only_inheritance(self):
        """When only a root-level electrodes.tsv exists, it must be used."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("FP1", "80.0", "26.0", "-4.0"),
            )
            self._write(d, "electrodes.tsv", tsv)
            head = {"electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertIn("FP1", result["positions"])

    def test_non_subset_entities_not_applied(self):
        """An electrodes.tsv for a different task must not apply."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("Cz", "0.0", "0.0", "88.0"),
            )
            self._write(d, "sub-01/eeg/sub-01_task-other_electrodes.tsv", tsv)
            head = {"sub-01/eeg/sub-01_task-other_electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNone(result)

    # -- coordsystem.json ------------------------------------------------------

    def test_coordsystem_units_and_system_extracted(self):
        """EEGCoordinateSystem and EEGCoordinateUnits must appear in the result."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("FP1", "80.0", "26.0", "-4.0"),
            )
            self._write(d, "sub-01/eeg/sub-01_task-rest_electrodes.tsv", tsv)
            self._write_json(d, "sub-01/eeg/sub-01_task-rest_coordsystem.json", {
                "EEGCoordinateSystem": "EEGLAB",
                "EEGCoordinateUnits": "mm",
            })
            head = {
                "sub-01/eeg/sub-01_task-rest_electrodes.tsv",
                "sub-01/eeg/sub-01_task-rest_coordsystem.json",
            }
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertEqual(result["coordinate_system"], "EEGLAB")
            self.assertEqual(result["coordinate_units"], "mm")

    def test_absent_coordsystem_gives_empty_strings(self):
        """When no coordsystem.json resolves, both strings must be empty."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_eeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("Cz", "0.0", "0.0", "88.0"),
            )
            self._write(d, "sub-01/eeg/sub-01_electrodes.tsv", tsv)
            head = {"sub-01/eeg/sub-01_electrodes.tsv"}
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertEqual(result["coordinate_system"], "")
            self.assertEqual(result["coordinate_units"], "")

    def test_ieeg_coordsystem_keys_extracted(self):
        """iEEGCoordinateSystem/iEEGCoordinateUnits must also be read."""
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/ieeg/sub-01_task-rest_ieeg.set"
            tsv = self._tsv(
                ("name", "x", "y", "z"),
                ("A1", "10.0", "20.0", "30.0"),
            )
            self._write(d, "sub-01/ieeg/sub-01_task-rest_electrodes.tsv", tsv)
            self._write_json(d, "sub-01/ieeg/sub-01_task-rest_coordsystem.json", {
                "iEEGCoordinateSystem": "Talairach",
                "iEEGCoordinateUnits": "mm",
            })
            head = {
                "sub-01/ieeg/sub-01_task-rest_electrodes.tsv",
                "sub-01/ieeg/sub-01_task-rest_coordsystem.json",
            }
            result = electrode_positions_for(d, rec, head, "HEAD")
            self.assertIsNotNone(result)
            self.assertEqual(result["coordinate_system"], "Talairach")
            self.assertEqual(result["coordinate_units"], "mm")

    # -- embed onto root -------------------------------------------------------

    def test_embed_electrode_attrs_onto_root(self):
        """The three attrs land on the root zarr.json and preserve existing attrs."""
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "rec.zarr")
            os.makedirs(store)
            with open(os.path.join(store, "zarr.json"), "w", encoding="utf-8") as fh:
                json.dump(
                    {
                        "zarr_format": 3,
                        "node_type": "group",
                        "attributes": {
                            "format": "biosigio-zarr",
                            "channel_groups": ["eeg_250hz"],
                            "power_line_frequency": 60.0,
                        },
                    },
                    fh,
                )
            positions = {"FP1": [80.0, 26.0, -4.0], "FP2": [-80.0, 26.0, -4.0]}
            embed_root_attr(store, "electrode_positions", positions)
            embed_root_attr(store, "electrode_coordinate_system", "EEGLAB")
            embed_root_attr(store, "electrode_coordinate_units", "mm")
            with open(os.path.join(store, "zarr.json"), encoding="utf-8") as fh:
                doc = json.load(fh)
            attrs = doc["attributes"]
            self.assertEqual(attrs["electrode_positions"], positions)
            self.assertEqual(attrs["electrode_coordinate_system"], "EEGLAB")
            self.assertEqual(attrs["electrode_coordinate_units"], "mm")
            self.assertEqual(attrs["power_line_frequency"], 60.0)  # preserved
            self.assertEqual(attrs["channel_groups"], ["eeg_250hz"])  # preserved

    # -- git cat-file fallback (no-checkout clone) -----------------------------

    def test_reads_via_git_when_no_working_tree(self):
        """The workflow clones --no-checkout; must resolve via git cat-file."""
        elec_rel = "sub-01/eeg/sub-01_task-rest_electrodes.tsv"
        cs_rel = "sub-01/eeg/sub-01_task-rest_coordsystem.json"
        tsv_body = "name\tx\ty\tz\nFP1\t80.784\t26.133\t-4.001\n"
        cs_body = json.dumps({"EEGCoordinateSystem": "EEGLAB", "EEGCoordinateUnits": "mm"})
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as clone_parent:
            for rel, body in ((elec_rel, tsv_body), (cs_rel, cs_body)):
                p = os.path.join(src, rel)
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, "w", encoding="utf-8") as fh:
                    fh.write(body)
            env = {
                **os.environ,
                "GIT_AUTHOR_NAME": "t",
                "GIT_AUTHOR_EMAIL": "t@t",
                "GIT_COMMITTER_NAME": "t",
                "GIT_COMMITTER_EMAIL": "t@t",
            }

            def run(*a: str) -> None:
                subprocess.run(a, check=True, env=env, capture_output=True)

            run("git", "-C", src, "init", "-q", "-b", "main")
            run("git", "-C", src, "add", "-A")
            run("git", "-C", src, "commit", "-qm", "init")
            clone = os.path.join(clone_parent, "repo")
            run("git", "clone", "--no-checkout", "-q", src, clone)
            # Confirm no working tree
            self.assertFalse(os.path.exists(os.path.join(clone, elec_rel)))
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            result = electrode_positions_for(clone, rec, {elec_rel, cs_rel}, "HEAD")
            self.assertIsNotNone(result)
            self.assertAlmostEqual(result["positions"]["FP1"][0], 80.784)
            self.assertEqual(result["coordinate_system"], "EEGLAB")
            self.assertEqual(result["coordinate_units"], "mm")


class TestKitAndCtf(unittest.TestCase):
    """KIT `.con`/`.sqd`/`.kdf` files and CTF `.ds` directory recordings (the
    extension-keyed directory mechanism generalized to also cover MEF3 `.mefd`
    -- see `TestMefdRecordings` -- via `dir_recording_of`/`dir_recordings`)."""

    def test_kit_extensions_are_primary(self):
        for ext in (".con", ".sqd", ".kdf"):
            self.assertTrue(is_primary(f"sub-01/meg/sub-01_task-x_meg{ext}"))
        # And map to MEG by their BIDS suffix.
        self.assertEqual(bids_suffix_modality("sub-01/meg/sub-01_task-x_meg.con"), "MEG")
        self.assertEqual(
            store_rel_for("sub-01/meg/sub-01_task-x_meg.con"),
            "sub-01/meg/sub-01_task-x_meg.zarr",
        )

    def test_dir_recording_of_and_is_dir_recording(self):
        inner = "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4"
        ds = "sub-01/meg/sub-01_task-x_meg.ds"
        self.assertEqual(dir_recording_of(inner), ds)
        self.assertEqual(dir_recording_of(ds), ds)  # the dir maps to itself
        self.assertIsNone(dir_recording_of("sub-01/meg/sub-01_task-x_meg.fif"))
        self.assertTrue(is_dir_recording(ds))
        self.assertFalse(is_dir_recording(inner))

    def test_dir_recordings_derived_from_inner_files(self):
        head = [
            "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4",
            "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.res4",
            "sub-01/meg/sub-01_task-x_meg.ds/BadChannels",
            "sub-02/meg/sub-02_task-y_meg.ds/sub-02_task-y_meg.meg4",
            "dataset_description.json",
        ]
        self.assertEqual(
            dir_recordings(head),
            {"sub-01/meg/sub-01_task-x_meg.ds", "sub-02/meg/sub-02_task-y_meg.ds"},
        )

    def test_ctf_store_rel_and_events_and_modality(self):
        ds = "sub-01/meg/sub-01_task-x_meg.ds"
        self.assertEqual(store_rel_for(ds), "sub-01/meg/sub-01_task-x_meg.zarr")
        self.assertEqual(
            events_sibling_for(ds), "sub-01/meg/sub-01_task-x_events.tsv"
        )
        self.assertEqual(bids_suffix_modality(ds), "MEG")

    def test_full_converts_ctf_ds_as_one_primary(self):
        head = [
            "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4",
            "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.res4",
            "sub-01/meg/sub-01_task-x_events.tsv",
        ]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.ds"])
        self.assertEqual(remove, [])

    def test_modify_inner_ctf_file_rebuilds_recording(self):
        head = [
            "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4",
            "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.res4",
        ]
        convert, remove = compute_worklist(
            head, [("M", "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4")], full=False
        )
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.ds"])
        self.assertEqual(remove, [])

    def test_delete_whole_ctf_ds_removes_store(self):
        # Every inner file deleted, none remain at HEAD -> drop the recording's store.
        convert, remove = compute_worklist(
            [],
            [
                ("D", "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4"),
                ("D", "sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.res4"),
            ],
            full=False,
        )
        self.assertEqual(convert, [])
        self.assertEqual(remove, ["sub-01/meg/sub-01_task-x_meg.zarr"])

    def test_delete_one_ctf_file_with_others_remaining_rebuilds(self):
        head = ["sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4"]
        convert, remove = compute_worklist(
            head, [("D", "sub-01/meg/sub-01_task-x_meg.ds/BadChannels")], full=False
        )
        self.assertEqual(convert, ["sub-01/meg/sub-01_task-x_meg.ds"])
        self.assertEqual(remove, [])

    def test_ctf_size_sums_directory_tree(self):
        with tempfile.TemporaryDirectory() as d:
            ds = os.path.join(d, "sub-01_task-x_meg.ds")
            os.makedirs(ds)
            with open(os.path.join(ds, "sub-01_task-x_meg.meg4"), "wb") as fh:
                fh.write(b"m" * 8000)
            with open(os.path.join(ds, "sub-01_task-x_meg.res4"), "wb") as fh:
                fh.write(b"r" * 200)
            self.assertEqual(_recording_size_bytes(ds), 8200)


class TestMefdRecordings(unittest.TestCase):
    """MEF3 `.mefd` directory recordings: the extension-keyed directory
    mechanism generalized from CTF `.ds` (`dir_recording_of`/`is_dir_recording`/
    `dir_recordings`) rather than copy-pasted for the new format. A real MEF3
    session nests several levels below the `.mefd` itself:
    `<name>.mefd/<CHANNEL>.timd/<CHANNEL>-000000.segd/<CHANNEL>-000000.{tdat,tidx,
    tmet}` (on006392 has 194 `.timd` channel dirs and 582 tracked files)."""

    MEFD = "sub-01/ieeg/sub-01_task-photicstim_ieeg.mefd"

    def _member(self, channel: str, suffix: str) -> str:
        return f"{self.MEFD}/{channel}.timd/{channel}-000000.segd/{channel}-000000.{suffix}"

    def test_dir_recording_of_resolves_nested_segd_members(self):
        for suffix in ("tdat", "tidx", "tmet"):
            self.assertEqual(dir_recording_of(self._member("C3", suffix)), self.MEFD)
        self.assertEqual(dir_recording_of(self.MEFD), self.MEFD)  # the dir maps to itself
        self.assertTrue(is_dir_recording(self.MEFD))
        self.assertTrue(is_mefd(self.MEFD))
        self.assertFalse(is_mefd("sub-01/meg/sub-01_task-x_meg.ds"))

    def test_dir_recordings_derives_one_mefd_from_many_channel_members(self):
        # Every .tdat/.tidx/.tmet across every .timd channel dir still resolves
        # to the SAME one recording, keyed at the .mefd path -- not one per
        # channel and not one per segd/timd directory.
        head = [
            self._member(ch, suffix)
            for ch in ("C3", "C4", "CZ", "ECG")
            for suffix in ("tdat", "tidx", "tmet")
        ]
        head.append("dataset_description.json")
        self.assertEqual(dir_recordings(head), {self.MEFD})

    def test_mefd_is_not_itself_a_file_extension_primary(self):
        # Like CTF .ds, a .mefd recording is directory-derived, not an
        # extension match on `is_primary` (which only matches file exts).
        self.assertFalse(is_primary(self.MEFD))

    def test_mefd_store_rel_events_and_modality(self):
        self.assertEqual(
            store_rel_for(self.MEFD), "sub-01/ieeg/sub-01_task-photicstim_ieeg.zarr"
        )
        self.assertEqual(
            events_sibling_for(self.MEFD),
            "sub-01/ieeg/sub-01_task-photicstim_events.tsv",
        )
        self.assertEqual(bids_suffix_modality(self.MEFD), "IEEG")

    def test_full_converts_mefd_as_one_primary(self):
        head = [self._member("C3", "tdat"), self._member("C3", "tidx")]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(convert, [self.MEFD])
        self.assertEqual(remove, [])

    def test_modify_inner_mefd_file_rebuilds_recording(self):
        head = [self._member("C3", "tdat"), self._member("C4", "tdat")]
        convert, remove = compute_worklist(
            head, [("M", self._member("C3", "tdat"))], full=False
        )
        self.assertEqual(convert, [self.MEFD])
        self.assertEqual(remove, [])

    def test_delete_whole_mefd_removes_store(self):
        convert, remove = compute_worklist(
            [],
            [("D", self._member("C3", "tdat")), ("D", self._member("C3", "tidx"))],
            full=False,
        )
        self.assertEqual(convert, [])
        self.assertEqual(
            remove, ["sub-01/ieeg/sub-01_task-photicstim_ieeg.zarr"]
        )

    def test_delete_one_channel_with_others_remaining_rebuilds(self):
        head = [self._member("C4", "tdat")]
        convert, remove = compute_worklist(
            head, [("D", self._member("C3", "tdat"))], full=False
        )
        self.assertEqual(convert, [self.MEFD])
        self.assertEqual(remove, [])

    def test_full_worklist_excludes_mefd_under_derivatives(self):
        head = [
            self._member("C3", "tdat"),
            f"derivatives/preprocessed/{self._member('C3', 'tdat')}",
        ]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(convert, [self.MEFD])
        self.assertEqual(remove, [])

    def test_mefd_size_sums_the_whole_nested_tree(self):
        with tempfile.TemporaryDirectory() as d:
            mefd = os.path.join(d, "sub-01_task-x_ieeg.mefd")
            sizes = {"C3": 4000, "C4": 3000}
            for ch, size in sizes.items():
                segd = os.path.join(mefd, f"{ch}.timd", f"{ch}-000000.segd")
                os.makedirs(segd)
                for suffix in ("tdat", "tidx", "tmet"):
                    with open(os.path.join(segd, f"{ch}-000000.{suffix}"), "wb") as fh:
                        fh.write(b"m" * size)
            self.assertEqual(_recording_size_bytes(mefd), sum(sizes.values()) * 3)

    def test_mefd_streams_on_the_common_threshold(self):
        # .mefd streams like CTF/FIF/BrainVision (biosigio>=1.2.3, read_raw_mef
        # supports preload=False), now on the single common threshold (#1112).
        self.assertTrue(self.MEFD.endswith(MEFD_EXT))
        self.assertFalse(should_stream(self.MEFD, 100 * 1024**2))
        self.assertTrue(should_stream(self.MEFD, 500 * 1024**2))


class TestBtiRecordings(unittest.TestCase):
    """4D/BTi recording directories: BIDS gives them NO extension at all, so
    detection is content-based (`bti_recordings`) rather than the extension
    match `dir_recording_of` uses for CTF `.ds`/MEF3 `.mefd`. Mirrors
    biosigIO's `importers.meg._find_bti_pdf` gate exactly: a `c,rf*` file AND a
    sibling `config` file, both required, checked directly in the directory."""

    BTI = "sub-01/meg/sub-01_task-rest_meg"

    def test_detects_directory_with_config_and_crf(self):
        head = [f"{self.BTI}/c,rfDC", f"{self.BTI}/config", f"{self.BTI}/hs_file"]
        self.assertEqual(bti_recordings(head), {self.BTI})

    def test_datalad_config_alone_is_not_a_bti_recording(self):
        # The exact false-positive this converter must never repeat: almost
        # every datalad-tracked dataset has `.datalad/config`, and it carries
        # no `c,rf*` sibling, so it must never be mistaken for a BTi recording.
        head = [
            ".datalad/config",
            "dataset_description.json",
            "sub-01/eeg/sub-01_task-x_eeg.set",
        ]
        self.assertEqual(bti_recordings(head), set())

    def test_crf_without_config_is_not_a_bti_recording(self):
        # Mirrors biosigIO's gate exactly: `config` is REQUIRED alongside
        # `c,rf*`, not merely sufficient on its own (the previous test) -- a
        # stray c,rf*-prefixed file with no config sibling is not enough
        # either, so the two sides never disagree about what counts.
        head = [f"{self.BTI}/c,rfDC"]
        self.assertEqual(bti_recordings(head), set())

    def test_excludes_bti_dir_under_derivatives(self):
        head = [
            f"{self.BTI}/c,rfDC",
            f"{self.BTI}/config",
            f"derivatives/preprocessed/{self.BTI}/c,rfDC",
            f"derivatives/preprocessed/{self.BTI}/config",
        ]
        self.assertEqual(bti_recordings(head), {self.BTI})

    def test_is_bti_marker_name(self):
        self.assertTrue(is_bti_marker_name("config"))
        self.assertTrue(is_bti_marker_name("c,rfDC"))
        self.assertTrue(is_bti_marker_name("c,rfDC,fn50,o"))
        # hs_file is optional and deliberately NOT a marker: its absence must
        # never affect whether a directory counts as a BTi recording.
        self.assertFalse(is_bti_marker_name("hs_file"))
        self.assertFalse(is_bti_marker_name("e,pos"))

    def test_is_bti_dir_is_a_bare_extension_check(self):
        self.assertTrue(is_bti_dir(self.BTI))
        self.assertFalse(is_bti_dir("sub-01/meg/sub-01_task-x_meg.ds"))
        self.assertFalse(is_bti_dir("sub-01/meg/sub-01_task-x_meg.mefd"))
        self.assertFalse(is_bti_dir("sub-01/eeg/sub-01_task-x_eeg.set"))

    def test_bti_pdf_choice_prefers_exact_crfdc(self):
        # Exact c,rfDC wins even when a filtered copy sits right beside it,
        # and its presence with only one candidate is NOT ambiguous.
        chosen, ambiguous = bti_pdf_choice({"c,rfDC", "config", "hs_file"})
        self.assertEqual(chosen, "c,rfDC")
        self.assertFalse(ambiguous)

    def test_bti_pdf_choice_prefers_crfdc_over_filtered_variant(self):
        chosen, ambiguous = bti_pdf_choice({"c,rfDC", "c,rfDC,fn50,o", "config"})
        self.assertEqual(chosen, "c,rfDC")
        self.assertTrue(ambiguous)  # >1 candidate, even though c,rfDC won

    def test_bti_pdf_choice_falls_back_to_sorted_order(self):
        # No exact c,rfDC present -> the first candidate in sorted() order,
        # NOT filesystem/os.listdir order (which is not reproducible).
        chosen, ambiguous = bti_pdf_choice({"c,rfDC,fn50,o", "c,rfhp0.1Hz", "config"})
        self.assertEqual(chosen, "c,rfDC,fn50,o")
        self.assertTrue(ambiguous)

    def test_bti_pdf_choice_no_candidates(self):
        self.assertEqual(bti_pdf_choice({"config", "hs_file"}), (None, False))

    def test_bti_store_rel_and_events_and_modality(self):
        # No extension to strip: store_rel_for is a plain `path + ".zarr"`.
        self.assertEqual(
            store_rel_for(self.BTI), "sub-01/meg/sub-01_task-rest_meg.zarr"
        )
        self.assertEqual(
            events_sibling_for(self.BTI), "sub-01/meg/sub-01_task-rest_events.tsv"
        )
        self.assertEqual(bids_suffix_modality(self.BTI), "MEG")

    def test_full_converts_bti_dir_as_one_primary(self):
        head = [f"{self.BTI}/c,rfDC", f"{self.BTI}/config", f"{self.BTI}/hs_file"]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(convert, [self.BTI])
        self.assertEqual(remove, [])

    def test_modify_config_rebuilds_recording(self):
        head = [f"{self.BTI}/c,rfDC", f"{self.BTI}/config"]
        convert, remove = compute_worklist(head, [("M", f"{self.BTI}/config")], full=False)
        self.assertEqual(convert, [self.BTI])
        self.assertEqual(remove, [])

    def test_delete_optional_hs_file_rebuilds_not_removes(self):
        # hs_file is optional in BIDS; its removal must rebuild the recording
        # (without headshape), never delete the store.
        head = [f"{self.BTI}/c,rfDC", f"{self.BTI}/config"]
        convert, remove = compute_worklist(
            head, [("D", f"{self.BTI}/hs_file")], full=False
        )
        self.assertEqual(convert, [self.BTI])
        self.assertEqual(remove, [])

    def test_delete_last_crf_removes_store(self):
        # The only c,rf* file is gone -> the directory no longer qualifies as
        # BTi (bti_dirs, computed from the post-diff HEAD state) -> drop it.
        convert, remove = compute_worklist(
            [f"{self.BTI}/config"], [("D", f"{self.BTI}/c,rfDC")], full=False
        )
        self.assertEqual(convert, [])
        self.assertEqual(remove, ["sub-01/meg/sub-01_task-rest_meg.zarr"])

    def test_delete_config_with_crf_remaining_removes_store(self):
        # config gone -> below the two-file detection threshold, even though
        # c,rfDC is still there; mirrors biosigIO's own gate exactly.
        convert, remove = compute_worklist(
            [f"{self.BTI}/c,rfDC"], [("D", f"{self.BTI}/config")], full=False
        )
        self.assertEqual(convert, [])
        self.assertEqual(remove, ["sub-01/meg/sub-01_task-rest_meg.zarr"])

    def test_replacing_crfdc_with_filtered_variant_still_rebuilds(self):
        # A rename (git diff --no-renames -> D old + A new) must still be read
        # as "rebuild," never "removed," because a qualifying c,rf* file is
        # still present at HEAD after the change (just a different one).
        head = [f"{self.BTI}/c,rfDC,fn50,o", f"{self.BTI}/config"]
        convert, remove = compute_worklist(
            head,
            [("D", f"{self.BTI}/c,rfDC"), ("A", f"{self.BTI}/c,rfDC,fn50,o")],
            full=False,
        )
        self.assertEqual(convert, [self.BTI])
        self.assertEqual(remove, [])

    def test_bti_size_sums_the_whole_directory(self):
        with tempfile.TemporaryDirectory() as d:
            bti = os.path.join(d, "sub-01_task-x_meg")
            os.makedirs(bti)
            with open(os.path.join(bti, "c,rfDC"), "wb") as fh:
                fh.write(b"p" * 9000)
            with open(os.path.join(bti, "config"), "wb") as fh:
                fh.write(b"c" * 300)
            with open(os.path.join(bti, "hs_file"), "wb") as fh:
                fh.write(b"h" * 100)
            self.assertEqual(_recording_size_bytes(bti), 9400)

    def test_bti_streams_on_the_same_threshold_as_everything_else(self):
        # #1112 collapsed the two-tier threshold: BTi used to stay in-memory until
        # multi-GB because it genuinely supports preload=False, but "has a lazy
        # reader" is a reason streaming WORKS, not a reason to postpone it. Only
        # genuinely small recordings keep the in-memory fast path now.
        self.assertFalse(should_stream(self.BTI, 100 * 1024**2))
        self.assertTrue(should_stream(self.BTI, 300 * 1024**2))
        self.assertTrue(should_stream(self.BTI, 3 * 1024**3))

    def test_all_directory_recording_kinds_coexist_in_one_worklist(self):
        # CTF .ds, MEF3 .mefd, and 4D/BTi discovered together must not
        # interfere with each other or with a plain file-extension primary.
        head = [
            "sub-01/eeg/sub-01_task-x_eeg.set",
            "sub-02/meg/sub-02_task-x_meg.ds/sub-02_task-x_meg.meg4",
            "sub-03/ieeg/sub-03_task-x_ieeg.mefd/C3.timd/C3-000000.segd/C3-000000.tdat",
            f"{self.BTI}/c,rfDC",
            f"{self.BTI}/config",
        ]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(
            convert,
            sorted([
                "sub-01/eeg/sub-01_task-x_eeg.set",
                "sub-02/meg/sub-02_task-x_meg.ds",
                "sub-03/ieeg/sub-03_task-x_ieeg.mefd",
                self.BTI,
            ]),
        )
        self.assertEqual(remove, [])


class TestRecordingSizeBytes(unittest.TestCase):
    """Streaming gate sizing: primary + same-stem companions, not the whole dir."""

    def test_sums_primary_and_same_stem_companions(self):
        with tempfile.TemporaryDirectory() as d:
            sub = os.path.join(d, "sub-01", "ieeg")
            os.makedirs(sub)
            stem = "sub-01_task-movie_ieeg"
            # BrainVision triplet: the bulk lives in the .eeg companion.
            with open(os.path.join(sub, f"{stem}.vhdr"), "wb") as fh:
                fh.write(b"x" * 100)
            with open(os.path.join(sub, f"{stem}.eeg"), "wb") as fh:
                fh.write(b"y" * 5000)
            with open(os.path.join(sub, f"{stem}.vmrk"), "wb") as fh:
                fh.write(b"z" * 50)
            # A different recording in the same dir must NOT be counted.
            with open(os.path.join(sub, "sub-01_task-rest_ieeg.eeg"), "wb") as fh:
                fh.write(b"q" * 9999)
            primary = os.path.join(sub, f"{stem}.vhdr")
            self.assertEqual(_recording_size_bytes(primary), 100 + 5000 + 50)

    def test_unreadable_dir_forces_streaming(self):
        # A listdir failure must NOT read as size 0 (which would misroute a large
        # recording to the OOM-prone in-memory path); it forces the streaming path.
        self.assertGreater(
            _recording_size_bytes("/no/such/dir/sub-01_eeg.vhdr"), 2 * 1024**3
        )

    def test_split_fif_sums_the_whole_chain(self):
        # #909: split-02.. carry DIFFERENT stems (`_split-02_meg`); summing only
        # split-01's same-stem companions undercounts the chain, so should_stream
        # misroutes a multi-GB recording to the in-memory path and OOMs. The size
        # must be the whole split group, not just split-01.
        with tempfile.TemporaryDirectory() as d:
            sub = os.path.join(d, "sub-01", "meg")
            os.makedirs(sub)
            base = "sub-01_task-rest"
            for idx, size in ((1, 1000), (2, 2000), (3, 500)):
                with open(os.path.join(sub, f"{base}_split-0{idx}_meg.fif"), "wb") as fh:
                    fh.write(b"f" * size)
            # A non-member file in the same dir must NOT be counted.
            with open(os.path.join(sub, "sub-01_task-other_meg.fif"), "wb") as fh:
                fh.write(b"x" * 9999)
            primary = os.path.join(sub, f"{base}_split-01_meg.fif")
            self.assertEqual(_recording_size_bytes(primary), 3500)


class TestMemoryGuard(unittest.TestCase):
    """Per-recording memory guard (#909): projection, budget, deterministic skip."""

    def test_projected_peak_streaming_is_bounded(self):
        # A large .fif streams -> peak is bounded regardless of on-disk size.
        self.assertEqual(
            projected_peak_bytes("sub-01_task-x_meg.fif", 50 * 1024**3), STREAM_PEAK_BYTES
        )

    def test_mef3_projects_from_on_disk_bytes_on_the_streaming_path(self):
        """MEF3 streams (MNE reads it a window at a time) but the worker still
        climbs to the whole recording at float64: 7.5-10.3 GiB from ~1 GB on
        disk on on004696 (2026-09-03). The flat bound admitted eight at once and
        the kernel killed a worker. The projection must scale with size."""
        size = 1024**3
        self.assertTrue(should_stream("sub-01/ieeg/sub-01_ieeg.mefd", size))
        self.assertEqual(
            projected_peak_bytes("sub-01/ieeg/sub-01_ieeg.mefd", size, 256),
            int(size * STREAM_MEM_FACTOR_BY_EXT[".mefd"]),
        )
        self.assertGreater(STREAM_MEM_FACTOR_BY_EXT[".mefd"], 10)
        # Other streamed formats keep the flat bound: nothing measured says
        # otherwise, and charging them 12x would serialise the archive.
        self.assertEqual(projected_peak_bytes("sub-01/meg/sub-01_meg.fif", size, 306), STREAM_PEAK_BYTES)
        self.assertEqual(projected_peak_bytes("sub-01/meg/sub-01_meg.ds", size, 275), STREAM_PEAK_BYTES)
        self.assertEqual(stream_factor_for("sub-01/meg/sub-01_meg.fif"), 0.0)

    def test_mef3_streaming_projection_never_drops_below_the_flat_bound(self):
        # A tiny MEF3 above the stream threshold still gets the streaming floor.
        size = STREAM_MIN_BYTES + 1
        self.assertEqual(
            projected_peak_bytes("x.mefd", size, 8),
            max(STREAM_PEAK_BYTES, int(size * STREAM_MEM_FACTOR_BY_EXT[".mefd"])),
        )

    def test_mef3_in_memory_path_uses_the_same_retention_factor(self):
        size = 100 * 1024**2
        self.assertFalse(should_stream("x.mefd", size))
        self.assertEqual(projected_peak_bytes("x.mefd", size), int(size * INMEM_MEM_FACTOR_BY_EXT[".mefd"]))
        self.assertEqual(INMEM_MEM_FACTOR_BY_EXT[".mefd"], STREAM_MEM_FACTOR_BY_EXT[".mefd"])

    def test_projected_peak_inmemory_scales_with_size(self):
        # EEGLAB `.set` is in no STREAM_*_EXTS tuple, so it is always in-memory
        # and the float64 blow-up scales with size.
        #
        # Deliberately NOT `.edf` here. EDF's path depends on the INSTALLED
        # biosigio (`_EDF_STREAMABLE`, >= 1.2 streams it), so an `.edf` assertion
        # passes in CI, which installs nothing, and FAILS on the conversion node,
        # which has 1.2.4 -- and it did, on the epic branch, before this phase
        # touched anything. A unit test of a pure projection must not depend on
        # whether an optional dependency happens to be present.
        size = 3 * 1024**3
        self.assertEqual(
            projected_peak_bytes("sub-01_task-x_eeg.set", size), int(size * INMEM_MEM_FACTOR)
        )

    def test_ceiling_is_the_whole_usable_node_and_jobs_independent(self):
        # The per-recording ceiling no longer shrinks with --jobs: it is the whole
        # usable node, so raising concurrency never skips a recording it otherwise
        # would convert (admission control bounds the SUM, not each recording).
        os.environ.pop("ZARR_REC_MEM_BUDGET_BYTES", None)
        # Sampled, not exact: since #1111 the ceiling comes from MemAvailable,
        # which moves between two reads on a shared box. The property under test
        # is that the ceiling IS the usable node and does not shrink with --jobs,
        # not that two live samples are bit-identical.
        self.assertAlmostEqual(
            per_recording_ceiling_bytes() / 1024**3, usable_ram_bytes() / 1024**3, places=0
        )

    def test_ceiling_explicit_override_wins(self):
        os.environ["ZARR_REC_MEM_BUDGET_BYTES"] = str(123 * 1024**2)
        try:
            self.assertEqual(per_recording_ceiling_bytes(), 123 * 1024**2)
        finally:
            os.environ.pop("ZARR_REC_MEM_BUDGET_BYTES", None)

    def test_preflight_skips_before_any_load(self):
        # A tiny budget forces a skip BEFORE any load (no biosigIO import, no OOM).
        # The recording easily fits the NODE, so the verdict is the temporary one:
        # "not enough free right now", which retries. Since #1111 the ceiling is
        # MemAvailable, a live sample on a shared box, so "over budget" no longer
        # implies "too big to ever convert" -- and only the latter may be terminal.
        with tempfile.TemporaryDirectory() as d:
            rec = os.path.join(d, "sub-01_task-x_eeg.edf")
            with open(rec, "wb") as fh:
                fh.write(b"e" * 100_000)
            with self.assertRaises(RecordingMemoryExceeded) as cm:
                convert_recording(rec, None, os.path.join(d, "store"), mem_budget_bytes=1)
            self.assertEqual(cm.exception.code, "recording_memory_exceeded")
            self.assertIn(cm.exception.code, RETRYABLE_CODES)

    def test_a_recording_too_big_for_the_node_is_still_terminal(self):
        # The other branch: beyond what the hardware could EVER offer, so no amount
        # of waiting helps and the deterministic, no-retry verdict is correct.
        with tempfile.TemporaryDirectory() as d:
            rec = os.path.join(d, "sub-01_task-x_eeg.edf")
            with open(rec, "wb") as fh:
                fh.write(b"e" * 100_000)
            with self.assertRaises(RecordingTooLarge) as cm:
                # The genuinely terminal shape: free < node capacity < what this
                # recording needs. The two ceilings must be DISTINGUISHABLE, or
                # the verdict is deliberately the retryable one.
                convert_recording(
                    rec, None, os.path.join(d, "store"),
                    mem_budget_bytes=1, hard_ceiling_bytes=2,
                )
            self.assertEqual(cm.exception.code, "recording_too_large")
            self.assertNotIn(cm.exception.code, RETRYABLE_CODES)

    def test_preflight_uses_the_projection_admission_computed(self):
        # Phase 4 made projected_peak_bytes channel-aware but only updated
        # main()'s call site. Recomputing blind inside convert_recording always
        # yielded the flat STREAM_PEAK_BYTES floor for a streaming recording --
        # and since the ceiling is itself floored at 2x that value, the
        # comparison could never fire, making the permanent RecordingTooLarge
        # verdict dead code for the entire streaming path. The preflight must use
        # the number admission already computed.
        with tempfile.TemporaryDirectory() as d:
            rec = os.path.join(d, "sub-01_task-x_eeg.edf")
            with open(rec, "wb") as fh:
                fh.write(b"e" * 100_000)
            # A tiny file whose CHANNEL-AWARE projection is enormous: exactly the
            # few-channel/long/high-rate shape the flat floor cannot represent.
            with self.assertRaises(RecordingTooLarge) as cm:
                convert_recording(
                    rec, None, os.path.join(d, "store"),
                    mem_budget_bytes=10, hard_ceiling_bytes=20,
                    projected_peak=100 * 1024**3,
                )
            self.assertEqual(cm.exception.code, "recording_too_large")

    def test_preflight_falls_back_to_computing_its_own_projection(self):
        # Callers that do not supply one (tests, any future call site) must still
        # get a preflight rather than silently none.
        with tempfile.TemporaryDirectory() as d:
            rec = os.path.join(d, "sub-01_task-x_eeg.edf")
            with open(rec, "wb") as fh:
                fh.write(b"e" * 100_000)
            with self.assertRaises((RecordingTooLarge, RecordingMemoryExceeded)):
                convert_recording(
                    rec, None, os.path.join(d, "store"), mem_budget_bytes=1
                )

    def test_indistinguishable_ceilings_never_produce_a_permanent_verdict(self):
        # When /proc/meminfo is unreadable both ceilings fall back to the same
        # fixed figure. That makes `peak <= hard_ceiling` unsatisfiable whenever
        # `peak > mem_budget`, so every over-budget recording would be marked
        # permanently too-large -- silently undoing the #1111 split. Being wrong
        # toward "retry" costs one attempt; being wrong the other way buries a
        # dataset forever.
        with tempfile.TemporaryDirectory() as d:
            rec = os.path.join(d, "sub-01_task-x_eeg.edf")
            with open(rec, "wb") as fh:
                fh.write(b"e" * 100_000)
            with self.assertRaises(RecordingMemoryExceeded):
                convert_recording(
                    rec, None, os.path.join(d, "store"),
                    mem_budget_bytes=5, hard_ceiling_bytes=5,
                )

    def test_a_too_large_mef3_names_the_factor_behind_the_verdict(self):
        # A MEF3 session is skipped because of the 12x retention factor, not
        # because of its bytes on disk; the message must say which knob to
        # revisit once the reader stops retaining. Small directory: in-memory path.
        with tempfile.TemporaryDirectory() as d:
            rec = os.path.join(d, "sub-01_task-x_ieeg.mefd")
            os.makedirs(os.path.join(rec, "ch-1.timd"))
            with open(os.path.join(rec, "ch-1.timd", "seg.tdat"), "wb") as fh:
                fh.write(b"m" * 100_000)
            with self.assertRaises(RecordingTooLarge) as cm:
                convert_recording(
                    rec, None, os.path.join(d, "store"),
                    mem_budget_bytes=1, hard_ceiling_bytes=2,
                )
            self.assertIn(".mefd factor 12x (ZARR_INMEM_MEM_FACTOR_MEFD)", str(cm.exception))
        self.assertEqual(projection_factor_hint("x.edf", streaming=True), "")
        self.assertEqual(projection_factor_hint("x.fif", streaming=True), "")
        self.assertIn("ZARR_STREAM_MEM_FACTOR_MEFD", projection_factor_hint("x.mefd", streaming=True))
        self.assertIn("ZARR_INMEM_MEM_FACTOR_VHDR", projection_factor_hint("x.vhdr", streaming=False))

    def test_reason_for_code_too_large_is_user_facing(self):
        self.assertIn("too large", reason_for_code("recording_too_large").lower())


class TestSplitFif(unittest.TestCase):
    """Multi-file FIF split recordings collapse to one head store."""

    def test_split_index_and_group_key(self):
        p1 = "sub-03/meg/sub-03_task-x_run-02_split-01_meg.fif"
        p2 = "sub-03/meg/sub-03_task-x_run-02_split-02_meg.fif"
        self.assertEqual(split_index(p1), 1)
        self.assertEqual(split_index(p2), 2)
        self.assertIsNone(split_index("sub-03/meg/sub-03_task-x_run-02_meg.fif"))
        # Both splits resolve to the same group key (split entity removed).
        self.assertEqual(split_group_key(p1), "sub-03/meg/sub-03_task-x_run-02_meg.fif")
        self.assertEqual(split_group_key(p1), split_group_key(p2))

    def test_is_split_fif_only_true_for_fif_with_split(self):
        self.assertTrue(is_split_fif("sub-03/meg/sub-03_task-x_split-01_meg.fif"))
        self.assertFalse(is_split_fif("sub-03/meg/sub-03_task-x_meg.fif"))  # no split
        # A `split-` entity on a non-FIF format is not part of the FIF chain logic.
        self.assertFalse(is_split_fif("sub-03/eeg/sub-03_task-x_split-01_eeg.set"))

    def test_heads_and_members_picks_lowest_split(self):
        primaries = [
            "sub-03/meg/sub-03_task-x_split-01_meg.fif",
            "sub-03/meg/sub-03_task-x_split-02_meg.fif",
            "sub-03/meg/sub-03_task-x_split-03_meg.fif",
            "sub-04/eeg/sub-04_task-y_eeg.set",  # non-split primary, carried verbatim
        ]
        heads, member_to_head = split_heads_and_members(primaries)
        self.assertEqual(
            heads,
            {
                "sub-03/meg/sub-03_task-x_split-01_meg.fif",
                "sub-04/eeg/sub-04_task-y_eeg.set",
            },
        )
        self.assertEqual(
            member_to_head,
            {
                "sub-03/meg/sub-03_task-x_split-02_meg.fif": "sub-03/meg/sub-03_task-x_split-01_meg.fif",
                "sub-03/meg/sub-03_task-x_split-03_meg.fif": "sub-03/meg/sub-03_task-x_split-01_meg.fif",
            },
        )

    def test_heads_picks_lowest_present_when_split01_absent(self):
        # Degenerate group missing split-01: lowest present split is the head.
        primaries = [
            "sub-03/meg/sub-03_task-x_split-02_meg.fif",
            "sub-03/meg/sub-03_task-x_split-03_meg.fif",
        ]
        heads, member_to_head = split_heads_and_members(primaries)
        self.assertEqual(heads, {"sub-03/meg/sub-03_task-x_split-02_meg.fif"})
        self.assertEqual(
            member_to_head,
            {"sub-03/meg/sub-03_task-x_split-03_meg.fif": "sub-03/meg/sub-03_task-x_split-02_meg.fif"},
        )

    def test_split_members_for_returns_sorted_chain(self):
        head_files = {
            "sub-03/meg/sub-03_task-x_split-02_meg.fif",
            "sub-03/meg/sub-03_task-x_split-01_meg.fif",
            "sub-03/meg/sub-03_task-x_events.tsv",
            "sub-04/eeg/sub-04_task-y_eeg.set",
        }
        members = split_members_for("sub-03/meg/sub-03_task-x_split-01_meg.fif", head_files)
        self.assertEqual(
            members,
            [
                "sub-03/meg/sub-03_task-x_split-01_meg.fif",
                "sub-03/meg/sub-03_task-x_split-02_meg.fif",
            ],
        )
        # A non-split primary has no members.
        self.assertEqual(split_members_for("sub-04/eeg/sub-04_task-y_eeg.set", head_files), [])

    def test_full_converts_only_head_split(self):
        head = [
            "sub-03/meg/sub-03_task-x_split-01_meg.fif",
            "sub-03/meg/sub-03_task-x_split-02_meg.fif",
            "sub-03/meg/sub-03_task-x_events.tsv",
        ]
        convert, remove = compute_worklist(head, [], full=True)
        self.assertEqual(convert, ["sub-03/meg/sub-03_task-x_split-01_meg.fif"])
        self.assertEqual(remove, [])

    def test_modify_any_split_rebuilds_head(self):
        head = [
            "sub-03/meg/sub-03_task-x_split-01_meg.fif",
            "sub-03/meg/sub-03_task-x_split-02_meg.fif",
        ]
        for changed in (
            "sub-03/meg/sub-03_task-x_split-01_meg.fif",
            "sub-03/meg/sub-03_task-x_split-02_meg.fif",
        ):
            convert, remove = compute_worklist(head, [("M", changed)], full=False)
            self.assertEqual(convert, ["sub-03/meg/sub-03_task-x_split-01_meg.fif"])
            self.assertEqual(remove, [])

    def test_events_change_rebuilds_split_head(self):
        head = [
            "sub-03/meg/sub-03_task-x_split-01_meg.fif",
            "sub-03/meg/sub-03_task-x_split-02_meg.fif",
            "sub-03/meg/sub-03_task-x_events.tsv",
        ]
        convert, _ = compute_worklist(
            head, [("M", "sub-03/meg/sub-03_task-x_events.tsv")], full=False
        )
        self.assertEqual(convert, ["sub-03/meg/sub-03_task-x_split-01_meg.fif"])

    def test_delete_non_head_split_rebuilds_head_not_remove(self):
        # split-02 removed but split-01 remains -> re-read the chain, no store drop.
        head = ["sub-03/meg/sub-03_task-x_split-01_meg.fif"]
        convert, remove = compute_worklist(
            head, [("D", "sub-03/meg/sub-03_task-x_split-02_meg.fif")], full=False
        )
        self.assertEqual(convert, ["sub-03/meg/sub-03_task-x_split-01_meg.fif"])
        self.assertEqual(remove, [])

    def test_delete_head_split_removes_its_store(self):
        # The whole recording is gone (both splits deleted) -> drop the head store.
        head: list[str] = []
        convert, remove = compute_worklist(
            head,
            [
                ("D", "sub-03/meg/sub-03_task-x_split-01_meg.fif"),
                ("D", "sub-03/meg/sub-03_task-x_split-02_meg.fif"),
            ],
            full=False,
        )
        self.assertEqual(convert, [])
        self.assertEqual(remove, ["sub-03/meg/sub-03_task-x_split-01_meg.zarr"])

    def test_head_split_reindex_drops_orphaned_old_store(self):
        # Old head split-01 deleted while split-02 survives as the new head: build the
        # new head store AND remove the orphaned old-head store (would otherwise linger).
        head = ["sub-03/meg/sub-03_task-x_split-02_meg.fif"]
        convert, remove = compute_worklist(
            head, [("D", "sub-03/meg/sub-03_task-x_split-01_meg.fif")], full=False
        )
        self.assertEqual(convert, ["sub-03/meg/sub-03_task-x_split-02_meg.fif"])
        self.assertEqual(remove, ["sub-03/meg/sub-03_task-x_split-01_meg.zarr"])

    def test_affected_primaries_non_head_split_maps_to_head(self):
        primaries = ["sub-03/meg/sub-03_task-x_split-01_meg.fif"]
        bd = by_dir(primaries)
        m2h = {
            "sub-03/meg/sub-03_task-x_split-02_meg.fif": "sub-03/meg/sub-03_task-x_split-01_meg.fif"
        }
        self.assertEqual(
            affected_primaries("sub-03/meg/sub-03_task-x_split-02_meg.fif", bd, m2h),
            {"sub-03/meg/sub-03_task-x_split-01_meg.fif"},
        )


class TestAnnexKeySize(unittest.TestCase):
    """The `-s<N>` size the download integrity check verifies a blob against."""

    def test_sha256e_size(self):
        self.assertEqual(
            annex_key_size("SHA256E-s628291820--64135e784fc1.con"), 628291820
        )

    def test_md5e_size(self):
        self.assertEqual(annex_key_size("MD5E-s12345--abcdef.edf"), 12345)

    def test_large_eeg_size(self):
        # The kind of >10 GB BrainVision blob that truncates without the check.
        self.assertEqual(
            annex_key_size("SHA256E-s12582746496--7ee1f5a2.eeg"), 12582746496
        )

    def test_no_size_field_returns_none(self):
        self.assertIsNone(annex_key_size("URL--https://example.org/x.edf"))
        self.assertIsNone(annex_key_size("WORM--whatever"))
        self.assertIsNone(annex_key_size(None))
        self.assertIsNone(annex_key_size(""))


class TestMaxShieldCalibrationResolution(unittest.TestCase):
    """ADR 0028: Signal-Space Separation runs only with the recording's OWN
    fine-calibration and cross-talk pair. Resolution is BIDS inheritance, and the
    pair is all-or-nothing -- uncalibrated filtering is a weaker correction a
    consumer could not distinguish from a good one, so it is declined instead."""

    REC = "sub-01/meg/sub-01_task-rest_meg.fif"
    CAL = "sub-01/meg/sub-01_acq-calibration_meg.dat"
    CTC = "sub-01/meg/sub-01_acq-crosstalk_meg.fif"

    def test_pair_beside_the_recording(self):
        self.assertEqual(
            maxshield_calibration_for(self.REC, {self.REC, self.CAL, self.CTC}),
            (self.CAL, self.CTC),
        )

    def test_the_entity_subset_rule_would_reject_these(self):
        """The regression this resolver exists for.

        Every other sidecar resolver requires the candidate's entities to be a
        SUBSET of the recording's. `sub-01_acq-calibration_meg.dat` carries
        `acq=calibration` while the recording has no `acq` at all, so that rule
        rejects the very file it should find. Pin the exemption.
        """
        self.assertEqual(_bids_entities("sub-01_acq-calibration_meg")["acq"], "calibration")
        self.assertNotIn("acq", _bids_entities("sub-01_task-rest_meg"))
        self.assertIsNotNone(
            maxshield_calibration_for(self.REC, {self.REC, self.CAL, self.CTC})
        )

    def test_half_a_pair_is_no_pair(self):
        for present in (self.CAL, self.CTC):
            with self.subTest(present=present):
                self.assertIsNone(
                    maxshield_calibration_for(self.REC, {self.REC, present})
                )

    def test_neither_present(self):
        self.assertIsNone(maxshield_calibration_for(self.REC, {self.REC}))

    def test_inherited_from_an_ancestor(self):
        rec = "sub-06/ses-1/meg/sub-06_ses-1_task-rest_meg.fif"
        head = {rec, "sub-06/sub-06_acq-calibration_meg.dat",
                "sub-06/sub-06_acq-crosstalk_meg.fif"}
        self.assertIsNotNone(maxshield_calibration_for(rec, head))

    def test_bare_form_at_the_dataset_root(self):
        head = {self.REC, "acq-calibration_meg.dat", "acq-crosstalk_meg.fif"}
        self.assertIsNotNone(maxshield_calibration_for(self.REC, head))

    def test_nearest_wins(self):
        rec = "sub-06/ses-1/meg/sub-06_ses-1_task-rest_meg.fif"
        near = "sub-06/ses-1/meg/sub-06_ses-1_acq-calibration_meg.dat"
        head = {rec, near, "sub-06/ses-1/meg/sub-06_ses-1_acq-crosstalk_meg.fif",
                "sub-06/sub-06_acq-calibration_meg.dat",
                "sub-06/sub-06_acq-crosstalk_meg.fif"}
        pair = maxshield_calibration_for(rec, head)
        self.assertIsNotNone(pair)
        self.assertEqual(pair[0], near)

    def test_another_subject_pair_does_not_apply(self):
        head = {self.REC, "sub-02/meg/sub-02_acq-calibration_meg.dat",
                "sub-02/meg/sub-02_acq-crosstalk_meg.fif"}
        self.assertIsNone(maxshield_calibration_for(self.REC, head))

    def test_a_sibling_session_does_not_apply(self):
        # `sub-06/ses-2/` is not an ancestor of `sub-06/ses-1/`, so inheritance
        # must not reach across it.
        rec = "sub-06/ses-1/meg/sub-06_ses-1_task-rest_meg.fif"
        head = {rec, "sub-06/ses-2/meg/sub-06_ses-2_acq-calibration_meg.dat",
                "sub-06/ses-2/meg/sub-06_ses-2_acq-crosstalk_meg.fif"}
        self.assertIsNone(maxshield_calibration_for(rec, head))

    def test_calibration_files_stay_excluded_from_discovery(self):
        """ADR 0028's own trap: these are inputs to conversion AND never
        recordings. Both must remain true; conflating them breaks MaxShield."""
        for p in (self.CAL, self.CTC):
            with self.subTest(p=p):
                self.assertTrue(is_bids_calibration_file(p))
                self.assertFalse(is_primary(p))
        self.assertIsNotNone(
            maxshield_calibration_for(self.REC, {self.REC, self.CAL, self.CTC})
        )


class TestMaxShieldVerdictAndProjection(unittest.TestCase):
    def test_decline_is_deterministic_not_retryable(self):
        """The calibration pair is either shipped or it is not; retrying cannot
        change that, so a dataset made entirely of these must be marked terminal
        rather than burning five attempts."""
        self.assertNotIn(MaxShieldUncalibrated.code, RETRYABLE_CODES)
        failures = [{"code": MaxShieldUncalibrated.code}]
        self.assertEqual(count_infra_failures(failures, failures), 0)

    def test_decline_has_its_own_user_facing_reason(self):
        reason = reason_for_code(MaxShieldUncalibrated.code)
        self.assertNotEqual(reason, reason_for_code("file_read_error"))
        self.assertIn("shielding", reason.lower())

    def test_probe_failure_is_deterministic_not_retryable(self):
        """#1139: the probe runs on a file this same attempt already fetched
        successfully, so a header it cannot read is a property of that file's
        content -- retrying cannot make a corrupt header become readable."""
        self.assertNotIn(MaxShieldProbeFailed.code, RETRYABLE_CODES)
        failures = [{"code": MaxShieldProbeFailed.code}]
        self.assertEqual(count_infra_failures(failures, failures), 0)

    def test_probe_failure_has_its_own_user_facing_reason(self):
        reason = reason_for_code(MaxShieldProbeFailed.code)
        self.assertNotEqual(reason, reason_for_code("file_read_error"))
        self.assertNotEqual(reason, reason_for_code(MaxShieldUncalibrated.code))
        self.assertIn("header", reason.lower())

    def test_projection_covers_the_filter_phase(self):
        """A streaming FIF is projected on the streaming bound, which for this
        dataset's largest recording exceeds the measured filter peak by under 5%.
        That is coincidence, not headroom, so the MaxShield term must raise it."""
        size = 927 * 1024**2
        p = "sub-01/meg/sub-01_task-rest_meg.fif"
        plain = projected_peak_bytes(p, size, 328)
        shielded = projected_peak_bytes(p, size, 328, maxshield=True)
        self.assertGreater(shielded, plain)
        self.assertGreaterEqual(shielded, int(size * MAXSHIELD_MEM_FACTOR))

    def test_factor_clears_every_measured_ratio(self):
        """Pin the factor against the measurements it was derived from, so a future
        edit cannot quietly drop it below an observed peak. Sizes in MiB, peaks in
        GiB, measured through apply_sss on the conversion node."""
        for mib, gib in ((160, 0.78), (164, 0.79), (438, 1.87), (716, 2.95)):
            with self.subTest(mib=mib):
                self.assertGreater(mib * 1024**2 * MAXSHIELD_MEM_FACTOR, gib * 1024**3)

    def test_reserve_keeps_headroom_over_the_measured_peak(self):
        """The projection is not the limit. What the worker actually gets is
        admission_reserve_bytes, which for these recordings suppresses the usual 3x
        slack because the CONVERSION streams -- so assert the end of that chain, not
        just the projection. 716 MiB measured at 2.95 GiB."""
        size = 716 * 1024**2
        p = "sub-01/meg/sub-01_task-rest_meg.fif"
        ceiling = 24 * 1024**3
        proj = projected_peak_bytes(p, size, 336, maxshield=True)
        reserve = admission_reserve_bytes(proj, ceiling, streamed=should_stream(p, size))
        self.assertGreater(reserve, int(2.95 * 1024**3))

    def test_projection_takes_the_larger_phase_not_the_sum(self):
        # The two phases are sequential and the Raw is released between them.
        size = 8 * 1024**2  # small enough that conversion dominates
        p = "sub-01/meg/sub-01_task-rest_meg.fif"
        plain = projected_peak_bytes(p, size)
        shielded = projected_peak_bytes(p, size, maxshield=True)
        self.assertEqual(shielded, max(plain, int(size * MAXSHIELD_MEM_FACTOR)))
        self.assertLess(shielded, plain + int(size * MAXSHIELD_MEM_FACTOR))


class TestFailureReasons(unittest.TestCase):
    """Typed data failures (recordings the viewer should explain) are carried into
    index.json `failures`; infra failures are not. Mirrors biosigIO's error codes."""

    def test_reason_for_code_known_and_unknown(self):
        # Known codes get specific copy; None/unknown get the generic fallback.
        self.assertIn("derivative", reason_for_code("not_continuous").lower())
        self.assertIn("truncated", reason_for_code("corrupt_or_truncated").lower())
        generic = reason_for_code(None)
        self.assertEqual(reason_for_code("some_future_code"), generic)
        self.assertTrue(generic)

    def test_merge_index_records_failures(self):
        index = merge_index(
            None, "nm000104", SHA_NEW, [{"zarr": "a_eeg.zarr", "path": "a_eeg.set"}], [],
            "2026-06-13T00:00:00Z",
            [{"path": "b-ave.fif", "zarr": "b-ave.zarr", "code": "not_continuous",
              "reason": "derivative"}],
        )
        self.assertEqual(index["store_count"], 1)
        self.assertEqual(index["failure_count"], 1)
        self.assertEqual(index["failures"][0]["code"], "not_continuous")
        self.assertEqual(index["failures"][0]["path"], "b-ave.fif")

    def test_merge_index_failure_clears_when_path_converts(self):
        # A path that failed before but converts now drops out of `failures`.
        prior = {
            "source_commit": SHA_OLD,
            "stores": [],
            "failures": [{"path": "x_eeg.set", "zarr": "x_eeg.zarr",
                          "code": "corrupt_or_truncated", "reason": "..."}],
        }
        index = merge_index(
            prior, "nm000104", SHA_NEW, [{"zarr": "x_eeg.zarr", "path": "x_eeg.set"}], [],
            "2026-06-13T00:00:00Z", [],
        )
        self.assertEqual(index["failure_count"], 0)
        self.assertEqual(index["store_count"], 1)

    def test_merge_index_path_never_in_both_stores_and_failures(self):
        # A recording that newly fails drops its stale store entry.
        prior = {
            "source_commit": SHA_OLD,
            "stores": [{"zarr": "x_eeg.zarr", "path": "x_eeg.set"}],
            "failures": [],
        }
        index = merge_index(
            prior, "nm000104", SHA_NEW, [], [], "2026-06-13T00:00:00Z",
            [{"path": "x_eeg.set", "zarr": "x_eeg.zarr", "code": "not_continuous",
              "reason": "..."}],
        )
        store_paths = {s.get("path") for s in index["stores"]}
        fail_paths = {f["path"] for f in index["failures"]}
        self.assertEqual(store_paths & fail_paths, set())
        self.assertEqual(index["failure_count"], 1)
        self.assertEqual(index["store_count"], 0)

    def test_merge_index_drops_failure_for_removed_store(self):
        prior = {
            "source_commit": SHA_OLD, "stores": [],
            "failures": [{"path": "gone_eeg.set", "zarr": "gone_eeg.zarr",
                          "code": "not_continuous", "reason": "..."}],
        }
        index = merge_index(
            prior, "nm000104", SHA_NEW, [], ["gone_eeg.zarr"], "2026-06-13T00:00:00Z", [],
        )
        self.assertEqual(index["failure_count"], 0)

    def test_merge_index_drops_stale_failures_for_now_excluded_paths(self):
        # A carried-forward failure for a path now excluded (derivatives/
        # sourcedata/code) must not persist forever: it will never be
        # reconverted, so it would otherwise show users a stale failure for a
        # file we deliberately no longer serve. A genuine current failure for
        # a still-discoverable path must survive alongside it.
        prior = {
            "source_commit": SHA_OLD,
            "stores": [],
            "failures": [
                {"path": "derivatives/preprocessed/sub-01_task-x-epo.fif",
                 "zarr": "derivatives/preprocessed/sub-01_task-x-epo.zarr",
                 "code": "not_continuous", "reason": "..."},
                {"path": "sub-01/eeg/sub-01_task-y_eeg.set",
                 "zarr": "sub-01/eeg/sub-01_task-y_eeg.zarr",
                 "code": "corrupt_or_truncated", "reason": "..."},
            ],
        }
        index = merge_index(
            prior, "nm000104", SHA_NEW, [], [], "2026-06-13T00:00:00Z", [],
        )
        self.assertEqual(index["failure_count"], 1)
        self.assertEqual(
            index["failures"][0]["path"], "sub-01/eeg/sub-01_task-y_eeg.set"
        )


class TestAwsRunner(unittest.TestCase):
    """The wall-clock timeout + retry that stops a wedged aws op from hanging a
    worker -- or the whole run -- forever (the 2.5 h `aws s3 rm` spin on an empty
    prefix). Real subprocesses, no mocks; python3 stands in for `aws` (the
    appended --cli-* flags are harmlessly absorbed as argv)."""

    def test_timeout_kills_wedged_command(self):
        import time as _t

        start = _t.monotonic()
        with self.assertRaises(RuntimeError):
            # Sleeps 30 s; the 1 s wall-clock cap must kill it well before that.
            _aws([sys.executable, "-c", "import time; time.sleep(30)"], timeout=1, retries=1)
        self.assertLess(_t.monotonic() - start, 10)  # killed, not run to completion

    def test_failing_command_retries_then_raises(self):
        with self.assertRaises(RuntimeError):
            _aws([sys.executable, "-c", "import sys; sys.exit(7)"], timeout=30, retries=2)

    def test_recursive_rm_timeout_far_exceeds_transfer_timeout(self):
        # A whole-prefix `aws s3 rm --recursive` (millions of chunk objects on a
        # big dataset) legitimately runs much longer than a single transfer; the
        # transfer cap was killing real wipes mid-delete.
        self.assertGreaterEqual(_AWS_RM_TIMEOUT, 4 * _AWS_OP_TIMEOUT)

    def test_read_timeout_is_short_enough_to_reap_a_wedge(self):
        # A wedged S3 socket delivers ZERO response bytes; the per-read timeout is
        # what reaps it so botocore reconnects to a healthy IP. It must stay short
        # -- 300 s let an empty-prefix `aws s3 rm` spin for minutes per wedge. A
        # live transfer streams body continuously, so a short cap never trips it.
        i = _AWS_TIMEOUTS.index("--cli-read-timeout")
        self.assertLessEqual(int(_AWS_TIMEOUTS[i + 1]), 60)


class TestS3PrefixEmpty(unittest.TestCase):
    """The empty-prefix probe that lets `--clean` skip a pointless (wedge-prone)
    recursive rm. Real subprocess, no mocks: a fake `aws` on PATH emulates
    `s3api list-objects-v2 --query Contents[0].Key --output text`, which prints the
    first key or the literal `None` when the prefix is empty."""

    def _probe(self, stdout: str, rc: int = 0) -> bool:
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "aws"
            fake.write_text(
                "#!/usr/bin/env python3\n"
                "import sys\n"
                f"sys.stdout.write({stdout!r})\n"
                f"sys.exit({rc})\n"
            )
            fake.chmod(0o755)
            old = os.environ.get("PATH", "")
            os.environ["PATH"] = f"{tmp}{os.pathsep}{old}"
            try:
                return _s3_prefix_empty("nemar", "nm000228/zarr/")
            finally:
                os.environ["PATH"] = old

    def test_empty_prefix_is_skippable(self):
        # `--output text` prints "None" for an empty query; a blank line is treated
        # the same. Both -> True (skip the wipe).
        self.assertTrue(self._probe("None\n"))
        self.assertTrue(self._probe("\n"))

    def test_nonempty_prefix_is_not_skipped(self):
        self.assertFalse(
            self._probe("nm000228/zarr/sub-01/ses-01/eeg/x.zarr/eeg_250hz/0/c/0/0\n")
        )

    def test_error_falls_through_to_real_wipe(self):
        # A nonzero exit (creds/network) must NOT skip -- returning False makes the
        # caller run the real rm rather than silently leaving a stale prefix.
        self.assertFalse(self._probe("some error\n", rc=1))


class TestShouldStream(unittest.TestCase):
    """Which recordings take the bounded-memory streaming path. KIT .con loads
    fully in memory (~5x float64) and OOMs a worker well below the multi-GB mark,
    so it streams at a much lower threshold than BrainVision/FIF/CTF."""

    GB = 1024**3
    MB = 1024**2

    def test_kit_con_streams_above_low_threshold(self):
        # The ~620 MB task-2 .con that OOM'd the in-memory path must stream.
        self.assertTrue(should_stream("sub-01/meg/sub-01_task-x_meg.con", 620 * self.MB))
        self.assertTrue(should_stream("sub-01/meg/sub-01_task-x_meg.sqd", 900 * self.MB))

    def test_small_kit_stays_in_memory(self):
        # A small (~190 MB task-0) .con is cheap in memory -> faster path.
        self.assertFalse(should_stream("sub-01/meg/sub-01_task-x_meg.con", 190 * self.MB))

    def test_brainvision_fif_stream_from_the_common_threshold(self):
        # The 2 GiB threshold is what sank on004917: its BrainVision recordings
        # were 1.18-2.25 GB, so all but one sat just UNDER it, took the unbounded
        # in-memory path, and were admitted seven at a time. 500 MB must stream.
        self.assertTrue(should_stream("sub-01/ieeg/sub-01_task-x_ieeg.vhdr", 500 * self.MB))
        self.assertTrue(should_stream("sub-01/ieeg/sub-01_task-x_ieeg.vhdr", 2 * self.GB))
        self.assertTrue(should_stream("sub-01/meg/sub-01_task-x_meg.fif", 3 * self.GB))

    def test_the_on004917_band_now_streams(self):
        # Regression pin for the exact sizes that OOMed the node.
        for gb in (1.18, 1.5, 2.09, 2.25):
            self.assertTrue(
                should_stream("sub-02/eeg/sub-02_task-pdm_eeg.vhdr", int(gb * 1000**3)),
                f"{gb} GB BrainVision must take the bounded path",
            )

    def test_small_recordings_keep_the_in_memory_fast_path(self):
        # Streaming is not free: a scratch memmap plus a second pass costs more
        # than simply loading a small recording.
        self.assertFalse(should_stream("sub-01/ieeg/sub-01_task-x_ieeg.vhdr", 10 * self.MB))
        self.assertFalse(should_stream("sub-01/meg/sub-01_task-x_meg.fif", 10 * self.MB))

    def test_eeglab_set_never_streams(self):
        # EEGLAB .set has no streaming reader -> always in-memory.
        self.assertFalse(should_stream("sub-01/eeg/sub-01_task-x_eeg.set", 5 * self.GB))

    def test_edf_streaming_gated_on_biosigio_capability(self):
        # EDF/BDF stream ONLY when the installed biosigIO does it via pyedflib
        # (>=1.2.0, #944); on an older lib they stay in-memory (MNE would rescale
        # EDF units and not match the in-memory path). The gate is a module global.
        import generate_zarr  # type: ignore[import-not-found]

        big = STREAM_EDF_MIN_BYTES + 1
        orig = generate_zarr._EDF_STREAMABLE
        try:
            generate_zarr._EDF_STREAMABLE = True
            self.assertTrue(should_stream("sub-01/eeg/sub-01_task-x_eeg.edf", big))
            self.assertTrue(should_stream("sub-01/emg/sub-01_task-x_emg.bdf", big))
            # A small EDF stays on the faster in-memory path.
            self.assertFalse(
                should_stream("sub-01/eeg/sub-01_task-x_eeg.edf", STREAM_EDF_MIN_BYTES - 1)
            )
            generate_zarr._EDF_STREAMABLE = False
            self.assertFalse(should_stream("sub-01/eeg/sub-01_task-x_eeg.edf", big))
            self.assertFalse(should_stream("sub-01/emg/sub-01_task-x_emg.bdf", big))
        finally:
            generate_zarr._EDF_STREAMABLE = orig


class TestNextAdmission(unittest.TestCase):
    def test_admits_first_fitting_when_slot_free(self):
        # slot free, running 50 of a 100 ceiling: the 30 fits -> index 0.
        self.assertEqual(_next_admission([30, 10], 1, 50, 4, 100), 0)

    def test_waits_when_cpu_cap_reached(self):
        self.assertIsNone(_next_admission([1, 1], 4, 0, 4, 100))

    def test_waits_when_nothing_pending_fits(self):
        # something in flight (running 95); neither pending peak fits under 100.
        self.assertIsNone(_next_admission([100, 20], 2, 95, 8, 100))

    def test_idle_admits_head_even_if_oversized(self):
        # nothing in flight -> the head runs ALONE regardless of size (the worker
        # #909-skips it if it truly can't fit); guarantees forward progress.
        self.assertEqual(_next_admission([10**12], 0, 0, 4, 100), 0)

    def test_skips_head_of_line_giant_for_a_smaller_one(self):
        # running 50/100: the 100 giant can't fit, but the 10 behind it can.
        self.assertEqual(_next_admission([100, 10], 1, 50, 4, 100), 1)

    def test_simulation_never_exceeds_ceiling_except_lone_job(self):
        # Drive a full drain via _next_admission, completing the oldest in-flight
        # job each step; assert the concurrent peak SUM stays within the ceiling
        # whenever more than one job runs (a lone job may exceed it, by design).
        cpu_cap, ceiling = 4, 100
        peaks = [30, 30, 30, 30, 90, 5, 5, 200]  # incl. a lone-only 200 (> ceiling)
        pending = list(peaks)
        in_flight: list[int] = []  # FIFO of running peaks
        max_multi = 0
        guard = 0
        while pending or in_flight:
            guard += 1
            self.assertLess(guard, 1000, "admission simulation did not converge")
            idx = _next_admission(pending, len(in_flight), sum(in_flight), cpu_cap, ceiling)
            if idx is not None:
                in_flight.append(pending.pop(idx))
                if len(in_flight) > 1:
                    max_multi = max(max_multi, sum(in_flight))
                continue
            # nothing admittable -> a running job completes (oldest first)
            self.assertTrue(in_flight, "deadlock: nothing running and nothing admittable")
            in_flight.pop(0)
        self.assertLessEqual(max_multi, ceiling)


class TestRecordingSizeFromPointers(unittest.TestCase):
    def _git(self, repo: str, *args: str) -> None:
        subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True)

    def test_sums_primary_and_companion_annex_sizes_at_head(self):
        # A real git repo with committed annex-style pointers (locked symlinks):
        # the recording's on-disk size is read from the keys' -s fields, no S3.
        primary = "sub-01/eeg/sub-01_task-x_eeg.set"
        companion = "sub-01/eeg/sub-01_task-x_eeg.fdt"
        pkey = "SHA256E-s5000--aaaa.set"
        ckey = "SHA256E-s2000000--bbbb.fdt"
        with tempfile.TemporaryDirectory() as repo:
            self._git(repo, "init", "-q")
            self._git(repo, "config", "user.email", "t@t")
            self._git(repo, "config", "user.name", "t")
            os.makedirs(os.path.join(repo, "sub-01", "eeg"))
            os.symlink(f"../../.git/annex/objects/aa/bb/{pkey}/{pkey}", os.path.join(repo, primary))
            os.symlink(f"../../.git/annex/objects/cc/dd/{ckey}/{ckey}", os.path.join(repo, companion))
            self._git(repo, "add", "-A")
            self._git(repo, "commit", "-qm", "fixture")
            head = subprocess.check_output(
                ["git", "-C", repo, "rev-parse", "HEAD"], text=True
            ).strip()
            total = recording_size_from_pointers(repo, primary, {primary, companion}, head)
            self.assertEqual(total, 5000 + 2000000)

    def test_sums_mefd_members_across_channel_dirs(self):
        mefd = "sub-01/ieeg/sub-01_task-x_ieeg.mefd"
        members = {
            f"{mefd}/C3.timd/C3-000000.segd/C3-000000.tdat": "SHA256E-s4000--c3.tdat",
            f"{mefd}/C4.timd/C4-000000.segd/C4-000000.tdat": "SHA256E-s3000--c4.tdat",
        }
        with tempfile.TemporaryDirectory() as repo:
            self._git(repo, "init", "-q")
            self._git(repo, "config", "user.email", "t@t")
            self._git(repo, "config", "user.name", "t")
            for path, key in members.items():
                full = os.path.join(repo, path)
                os.makedirs(os.path.dirname(full))
                # 5 levels deep (sub-01/ieeg/*.mefd/*.timd/*.segd) back to repo root.
                os.symlink(f"../../../../../.git/annex/objects/aa/bb/{key}/{key}", full)
            self._git(repo, "add", "-A")
            self._git(repo, "commit", "-qm", "fixture")
            head = subprocess.check_output(
                ["git", "-C", repo, "rev-parse", "HEAD"], text=True
            ).strip()
            total = recording_size_from_pointers(repo, mefd, set(members), head)
            self.assertEqual(total, 4000 + 3000)

    def test_sums_bti_dir_members_by_exact_dirname(self):
        bti = "sub-01/meg/sub-01_task-x_meg"
        members = {
            f"{bti}/c,rfDC": "SHA256E-s9000--pdf",
            f"{bti}/config": "SHA256E-s300--cfg",
        }
        with tempfile.TemporaryDirectory() as repo:
            self._git(repo, "init", "-q")
            self._git(repo, "config", "user.email", "t@t")
            self._git(repo, "config", "user.name", "t")
            for path, key in members.items():
                full = os.path.join(repo, path)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                # 3 levels deep (sub-01/meg/*_meg) back to repo root.
                os.symlink(f"../../../.git/annex/objects/aa/bb/{key}/{key}", full)
            self._git(repo, "add", "-A")
            self._git(repo, "commit", "-qm", "fixture")
            head = subprocess.check_output(
                ["git", "-C", repo, "rev-parse", "HEAD"], text=True
            ).strip()
            total = recording_size_from_pointers(repo, bti, set(members), head)
            self.assertEqual(total, 9000 + 300)


class TestExpectedChannelCountFor(unittest.TestCase):
    def _write(self, root: str, rel: str, text: str) -> None:
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(text)

    def test_sibling_channels_tsv_row_count(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            tsv = "sub-01/eeg/sub-01_task-rest_channels.tsv"
            self._write(d, tsv, "name\ttype\tunits\nCz\tEEG\tuV\nPz\tEEG\tuV\nEOG1\tEOG\tuV\n")
            self.assertEqual(
                expected_channel_count_for(d, rec, {tsv}, "HEAD"), 3
            )

    def test_none_when_no_channels_tsv(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.vhdr"
            self.assertIsNone(expected_channel_count_for(d, rec, set(), "HEAD"))

    def test_other_recordings_channels_tsv_does_not_apply(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            tsv = "sub-01/eeg/sub-01_task-other_channels.tsv"
            self._write(d, tsv, "name\ttype\nCz\tEEG\n")
            self.assertIsNone(expected_channel_count_for(d, rec, {tsv}, "HEAD"))

    def test_most_specific_wins(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            root_tsv = "task-rest_channels.tsv"
            sib_tsv = "sub-01/eeg/sub-01_task-rest_channels.tsv"
            self._write(d, root_tsv, "name\ttype\nCz\tEEG\nPz\tEEG\n")
            self._write(d, sib_tsv, "name\ttype\nCz\tEEG\nPz\tEEG\nOz\tEEG\nFz\tEEG\n")
            self.assertEqual(
                expected_channel_count_for(d, rec, {root_tsv, sib_tsv}, "HEAD"), 4
            )

    def test_header_only_tsv_yields_none(self):
        with tempfile.TemporaryDirectory() as d:
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            tsv = "sub-01/eeg/sub-01_task-rest_channels.tsv"
            self._write(d, tsv, "name\ttype\tunits\n")
            self.assertIsNone(expected_channel_count_for(d, rec, {tsv}, "HEAD"))


    def test_reads_via_git_when_no_working_tree(self):
        # The workflow clones --no-checkout, so channels.tsv is only in the git
        # object store. Resolution must fall back to `git cat-file`.
        tsv = "sub-01/eeg/sub-01_task-rest_channels.tsv"
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as clone_parent:
            self._write(src, tsv, "name\ttype\nCz\tEEG\nPz\tEEG\n")
            env = {
                **os.environ,
                "GIT_AUTHOR_NAME": "t",
                "GIT_AUTHOR_EMAIL": "t@t",
                "GIT_COMMITTER_NAME": "t",
                "GIT_COMMITTER_EMAIL": "t@t",
            }

            def run(*a: str) -> None:
                subprocess.run(a, check=True, env=env, capture_output=True)

            run("git", "-C", src, "init", "-q", "-b", "main")
            run("git", "-C", src, "add", "-A")
            run("git", "-C", src, "commit", "-qm", "init")
            clone = os.path.join(clone_parent, "repo")
            run("git", "clone", "--no-checkout", "-q", src, clone)
            self.assertFalse(os.path.exists(os.path.join(clone, tsv)))
            rec = "sub-01/eeg/sub-01_task-rest_eeg.set"
            self.assertEqual(expected_channel_count_for(clone, rec, {tsv}, "HEAD"), 2)


class TestStoreTotalChannels(unittest.TestCase):
    def test_sums_across_groups(self):
        meta = {"groups": [{"n_channels": 70}, {"n_channels": 4}]}
        self.assertEqual(store_total_channels(meta), 74)

    def test_missing_or_none_counts_zero(self):
        self.assertEqual(store_total_channels({}), 0)
        self.assertEqual(store_total_channels({"groups": []}), 0)
        self.assertEqual(
            store_total_channels({"groups": [{"n_channels": None}, {}, {"n_channels": 3}]}), 3
        )


class TestChannelCountMismatch(unittest.TestCase):
    def test_carries_typed_data_failure_code(self):
        # The gate must surface as a DETERMINISTIC data failure (a .code the
        # index records), not an untyped infra failure that retries forever.
        self.assertEqual(ChannelCountMismatch.code, "channel_count_mismatch")
        self.assertIn("channels.tsv", reason_for_code("channel_count_mismatch"))


class TestCleanOrphanSelection(unittest.TestCase):
    """`--clean` no longer wipes the prefix; it removes only the stores that are
    no longer produced at HEAD. `compute_clean_orphans` is the selection rule
    that replaced the wipe (nemarOrg/nemar-cli#1068 follow-up), and the exact
    function `main` calls -- not a hand-copied mirror of its logic."""

    def test_rebuilt_recordings_are_never_orphans(self):
        # The whole point: a full rebuild of the same dataset deletes NOTHING, so
        # the ~45 min wipe-then-re-upload of identical keys disappears.
        prior = {"stores": [
            {"zarr": "sub-01/eeg/sub-01_task-rest_eeg.zarr"},
            {"zarr": "sub-02/eeg/sub-02_task-rest_eeg.zarr"},
        ]}
        convert = ["sub-01/eeg/sub-01_task-rest_eeg.set", "sub-02/eeg/sub-02_task-rest_eeg.set"]
        self.assertEqual(compute_clean_orphans(prior, convert), set())

    def test_recording_dropped_from_head_is_removed(self):
        prior = {"stores": [
            {"zarr": "sub-01/eeg/sub-01_task-rest_eeg.zarr"},
            {"zarr": "sub-02/eeg/sub-02_task-rest_eeg.zarr"},
        ]}
        convert = ["sub-01/eeg/sub-01_task-rest_eeg.set"]
        self.assertEqual(
            compute_clean_orphans(prior, convert), {"sub-02/eeg/sub-02_task-rest_eeg.zarr"}
        )

    def test_renamed_recording_removes_the_old_store(self):
        prior = {"stores": [{"zarr": "sub-01/eeg/sub-01_task-old_eeg.zarr"}]}
        convert = ["sub-01/eeg/sub-01_task-new_eeg.set"]
        self.assertEqual(
            compute_clean_orphans(prior, convert), {"sub-01/eeg/sub-01_task-old_eeg.zarr"}
        )

    def test_first_conversion_has_no_prior_index_and_removes_nothing(self):
        self.assertEqual(
            compute_clean_orphans(None, ["sub-01/eeg/sub-01_task-rest_eeg.set"]), set()
        )

    def test_malformed_prior_entries_are_ignored(self):
        prior = {"stores": [{"zarr": 42}, {"no_zarr": "x"}, "notadict", {"zarr": "a.zarr"}]}
        self.assertEqual(compute_clean_orphans(prior, []), {"a.zarr"})

    def test_derivatives_sourcedata_code_stores_are_never_orphaned(self):
        # These stores predate the raw-only scope; a raw-only `convert` no
        # longer contains their primaries, but that must NOT be read as "gone
        # from HEAD" -- this change must not delete any already-published
        # store (nemarOrg/nemar-cli#1095 / #1097).
        prior = {"stores": [
            {"zarr": "derivatives/preprocessed/sub-01_task-x-epo.zarr"},
            {"zarr": "sourcedata/sub-02/sub-02_task-x_eeg.zarr"},
            {"zarr": "code/analysis/helper.zarr"},
            {"zarr": "sub-01/eeg/sub-01_task-rest_eeg.zarr"},
        ]}
        convert = ["sub-01/eeg/sub-01_task-rest_eeg.set"]  # only the raw one rebuilds
        self.assertEqual(compute_clean_orphans(prior, convert), set())

    def test_genuinely_gone_raw_store_is_still_removed_alongside_excluded_ones(self):
        prior = {"stores": [
            {"zarr": "derivatives/preprocessed/sub-01_task-x-epo.zarr"},
            {"zarr": "sub-02/eeg/sub-02_task-gone_eeg.zarr"},
        ]}
        convert: list[str] = []
        self.assertEqual(
            compute_clean_orphans(prior, convert),
            {"sub-02/eeg/sub-02_task-gone_eeg.zarr"},
        )

    def test_on005520_pattern_drops_from_index_without_deleting_stores(self):
        """A dataset whose ONLY prior stores are derivatives-tree ones (all
        raw recordings currently fail for an unrelated reason) legitimately
        reports store_count 0 in the next --clean index -- but the 92
        already-published derivatives stores are never scheduled for
        removal. Mirrors the documented on005520 case end-to-end at the
        pure-function level: worklist -> orphan selection -> index rewrite.
        """
        head = [
            "derivatives/preprocessed/sub-01_task-rest_eeg.set",
            "sub-01/eeg/sub-01_task-rest_eeg.vhdr",  # the one raw recording; fails
        ]
        convert, remove_from_worklist = compute_worklist(head, [], full=True)
        self.assertEqual(convert, ["sub-01/eeg/sub-01_task-rest_eeg.vhdr"])
        self.assertEqual(remove_from_worklist, [])

        prior_index = {"stores": [
            {"zarr": "derivatives/preprocessed/sub-01_task-rest_eeg.zarr"},
        ]}
        orphans = compute_clean_orphans(prior_index, convert)
        # The derivatives store is NOT an orphan: it must not be deleted.
        self.assertEqual(orphans, set())

        # The raw recording fails (unrelated reason) -> nothing converts, and
        # --clean rewrites the index fresh (prior=None), so the derivatives
        # store -- never touched -- simply has no entry in the new index.
        index = merge_index(
            None, "on005520", SHA_NEW, [], sorted(orphans),
            "2026-08-20T00:00:00Z",
            [{"path": head[1], "zarr": "sub-01/eeg/sub-01_task-rest_eeg.zarr",
              "code": "corrupt_or_truncated", "reason": "..."}],
        )
        self.assertEqual(index["store_count"], 0)  # 92 -> 0 in this dataset's index
        self.assertEqual(index["failure_count"], 1)  # the raw failure IS reported


class TestRmRecursiveSharding(unittest.TestCase):
    """`_rm_recursive` shards a big delete across child prefixes. A single
    `aws s3 rm --recursive` measured 13.8k objects/min on Hallu, which made a
    large wipe a ~45 min near-idle block."""

    def setUp(self):
        self.calls: list[list[str]] = []

    def _patch(self, children: list[str]):
        import generate_zarr as gz

        self._orig_aws, self._orig_children = gz._aws, gz._s3_child_prefixes
        gz._s3_child_prefixes = lambda url: children
        gz._aws = lambda cmd, **kw: self.calls.append(cmd)
        self.addCleanup(setattr, gz, "_aws", self._orig_aws)
        self.addCleanup(setattr, gz, "_s3_child_prefixes", self._orig_children)
        return gz

    def test_shards_across_child_prefixes_then_sweeps(self):
        gz = self._patch(["s3://b/d/zarr/sub-01/", "s3://b/d/zarr/sub-02/"])
        gz._rm_recursive("s3://b/d/zarr/")
        targets = [c[3] for c in self.calls]
        self.assertIn("s3://b/d/zarr/sub-01/", targets)
        self.assertIn("s3://b/d/zarr/sub-02/", targets)
        # ...and a final unsharded sweep, so keys sitting directly under the
        # prefix (which no child covers) are still deleted.
        self.assertEqual(targets[-1], "s3://b/d/zarr/")

    def test_falls_back_to_one_rm_when_there_are_no_children(self):
        gz = self._patch([])
        gz._rm_recursive("s3://b/d/zarr/")
        self.assertEqual([c[3] for c in self.calls], ["s3://b/d/zarr/"])

    def test_a_failing_shard_is_not_reported_as_a_clean_wipe(self):
        import generate_zarr as gz

        orig_aws, orig_children = gz._aws, gz._s3_child_prefixes
        gz._s3_child_prefixes = lambda url: ["s3://b/d/zarr/sub-01/"]

        def boom(cmd, **kw):
            raise RuntimeError("delete failed")

        gz._aws = boom
        self.addCleanup(setattr, gz, "_aws", orig_aws)
        self.addCleanup(setattr, gz, "_s3_child_prefixes", orig_children)
        with self.assertRaises(RuntimeError):
            gz._rm_recursive("s3://b/d/zarr/")



# --- #1110: worker memory backstop + pool-break recovery ----------------------

def _crashing_worker(primary, peak_bytes=None):
    """Fault-injection worker body. Module-level so it survives pickling to a
    spawned child. A recording whose path contains `boom` kills its own process
    the way the kernel OOM reaper does, which is what poisons a
    ProcessPoolExecutor; everything else converts normally.

    The sleeps make the crossfire DETERMINISTIC rather than hoped-for. The
    culprit dies while its siblings are provably still running, so a pool break
    always catches innocent recordings in flight -- which is the scenario the
    serial-isolation design exists for. Without them the timing is the
    scheduler's to decide: on macOS (spawn, slow worker startup) the crossfire
    happened readily, while on Linux (fork) the culprit died before any sibling
    was in flight, so the guarded path was never exercised on the platform
    production actually runs.
    """
    if "boom" in primary:
        time.sleep(0.15)
        os._exit(1)
    time.sleep(0.45)
    return {"ok": True, "primary": primary, "entry": {"zarr": primary + ".zarr"}}


class TestMemoryFailureClassification(unittest.TestCase):
    """#1110: a runtime OOM must be explainable to the viewer but still retryable."""

    def test_the_production_mapping_is_used(self):
        # Asserts the SAME helper convert_one calls, so deleting or weakening the
        # handler cannot leave this passing.
        r = memory_failure_result("sub-01/eeg/x.set", MemoryError("nope"))
        self.assertFalse(r["ok"])
        self.assertEqual(r["code"], RecordingMemoryExceeded.code)
        self.assertIn("memory budget", r["error"])

    def test_it_is_distinct_from_the_static_preflight_verdict(self):
        # RecordingTooLarge is a judgment on the recording alone, made before any
        # execution; a runtime OOM depends on what else was running. Conflating
        # them is what let a busy hour bury a dataset permanently.
        self.assertNotEqual(RecordingMemoryExceeded.code, RecordingTooLarge.code)

    def test_it_has_a_user_facing_reason(self):
        reason = reason_for_code(RecordingMemoryExceeded.code)
        self.assertTrue(reason)
        self.assertNotIn("recording_memory_exceeded", reason)  # not the raw code

    def test_a_run_of_only_oom_failures_stays_retryable(self):
        # The whole point. hallu-zarr.sh marks a dataset TERMINAL when every
        # failure is deterministic; an all-OOM run must not qualify.
        failures = ["a", "b"]
        entries = [
            {"path": "a", "code": RecordingMemoryExceeded.code},
            {"path": "b", "code": RecordingMemoryExceeded.code},
        ]
        self.assertEqual(count_infra_failures(failures, entries), 2)

    def test_real_data_failures_remain_deterministic(self):
        failures = ["a", "b"]
        entries = [
            {"path": "a", "code": "not_continuous"},
            {"path": "b", "code": "corrupt_or_truncated"},
        ]
        self.assertEqual(count_infra_failures(failures, entries), 0)

    def test_a_mixed_run_is_infra(self):
        failures = ["a", "b", "c"]
        entries = [{"path": "a", "code": "not_continuous"}]  # b uncoded, c OOM
        entries.append({"path": "c", "code": RecordingMemoryExceeded.code})
        self.assertEqual(count_infra_failures(failures, entries), 2)

    # NOT COVERED, deliberately: driving a real MemoryError through the whole of
    # `convert_one` with a synthetic context is not achievable deterministically.
    # Whichever allocation happens to fail first decides the exception type -- a
    # tight RLIMIT makes numpy's own import fail (ImportError), a loose one lets
    # the #909 preflight fire first (RecordingTooLarge), and neither exercises the
    # runtime handler. Both were tried on the real Linux conversion node.
    #
    # What that leaves untested is one line: `except MemoryError` calling
    # `memory_failure_result`. Everything it constructs is asserted above against
    # the SAME production helper, so the mapping itself cannot silently rot -- but
    # a change that deleted the handler, or folded it into the generic
    # `except Exception` below it, would not be caught here. Reaching it honestly
    # needs a real oversized recording, i.e. an integration test on the node.

class TestMemoryErrorBeforePeakResetIsTyped(unittest.TestCase):
    """A MemoryError raised BEFORE `rss_trusted` is assigned must still produce a
    typed memory failure.

    `apply_worker_mem_limit` tightens RLIMIT_DATA at the top of `convert_one`'s
    try, and `rss_trusted = reset_peak_rss()` comes after it. On a reused worker
    still holding the previous recording's memory, the next allocation -- inside
    reset_peak_rss's own `open()`, which catches only OSError -- can raise
    MemoryError while the name does not yet exist. The handler reads
    `rss_trusted`, so this raised UnboundLocalError and escaped `convert_one`
    uncoded, retrying forever. That is the precise failure the limit call sits
    inside the try to prevent (#1110).
    """

    def setUp(self):
        # convert_one calls apply_worker_mem_limit for real before it reaches the
        # injected reset, so on Linux these tests genuinely narrow this PROCESS's
        # RLIMIT_DATA and never put it back. That leaks: this class sorts before
        # TestWorkerMemLimit, whose setUp would then capture the already-narrowed
        # value as its "pristine" baseline and restore the wrong limit -- silently
        # defeating the isolation that class exists to provide. Same save/restore
        # it uses, for the same reason.
        try:
            import resource

            saved = resource.getrlimit(resource.RLIMIT_DATA)
            self.addCleanup(resource.setrlimit, resource.RLIMIT_DATA, saved)
        except Exception:  # noqa: BLE001 - no usable RLIMIT_DATA (macOS/Windows)
            pass

    def _inject(self, exc: BaseException):
        import generate_zarr as gz

        def boom() -> bool:
            raise exc

        self._orig_reset, self._orig_ctx = gz.reset_peak_rss, gz._CTX
        gz.reset_peak_rss = boom
        gz._CTX = {"mem_budget": None}
        self.addCleanup(setattr, gz, "reset_peak_rss", self._orig_reset)
        self.addCleanup(setattr, gz, "_CTX", self._orig_ctx)
        return gz

    def test_memory_error_before_reset_returns_typed_failure(self):
        gz = self._inject(MemoryError("cannot allocate"))
        res = gz.convert_one("sub-01/eeg/sub-01_task-x_eeg.set", 4 * 1024**3)
        self.assertFalse(res["ok"])
        # The whole point: coded, so the queue can mark it terminal instead of
        # burning five attempts on a recording that will never fit.
        self.assertEqual(res["code"], gz.RecordingMemoryExceeded.code)
        self.assertEqual(res["primary"], "sub-01/eeg/sub-01_task-x_eeg.set")
        # Unmeasurable, not zero: the reset never completed, so any reading would
        # be the worker's lifetime peak rather than this recording's.
        self.assertIsNone(res["peak_rss"])

    def test_thread_exhaustion_at_the_limit_is_typed_as_memory(self):
        # zarr's codec pipeline dies with this exact RuntimeError when a thread
        # stack cannot be mapped at the RLIMIT_DATA limit (on004696, 2026-09-03).
        # Uncoded it broke the pool; typed it is the same verdict as MemoryError.
        gz = self._inject(RuntimeError("can't start new thread"))
        res = gz.convert_one("sub-01/eeg/sub-01_task-x_eeg.set", 4 * 1024**3)
        self.assertFalse(res["ok"])
        self.assertEqual(res["code"], gz.RecordingMemoryExceeded.code)

    def test_enomem_at_the_limit_is_typed_as_memory(self):
        gz = self._inject(OSError(errno.ENOMEM, "Cannot allocate memory"))
        res = gz.convert_one("sub-01/eeg/sub-01_task-x_eeg.set", 4 * 1024**3)
        self.assertEqual(res["code"], gz.RecordingMemoryExceeded.code)
        # Any other OSError stays what it is: a read error, not a memory verdict.
        gz = self._inject(OSError(errno.EIO, "I/O error"))
        res = gz.convert_one("sub-01/eeg/sub-01_task-x_eeg.set", 4 * 1024**3)
        self.assertNotEqual(res.get("code"), gz.RecordingMemoryExceeded.code)

    def test_non_memory_error_before_reset_is_still_uncoded_infra(self):
        # The generic handler never touched rss_trusted, so it was already fine;
        # assert it stays that way rather than being swept into the typed branch.
        gz = self._inject(RuntimeError("something else"))
        res = gz.convert_one("sub-01/eeg/sub-01_task-x_eeg.set", 4 * 1024**3)
        self.assertFalse(res["ok"])
        self.assertIsNone(res["code"])


class TestMaxShieldWiringInConvertOne(unittest.TestCase):
    """ADR 0028's decision, as `convert_one` actually wires it (#1126).

    The pieces were covered in isolation -- `maxshield_calibration_for`'s
    resolution, and that `maxshield_uncalibrated` is classified deterministic --
    but nothing exercised the code that CONNECTS them. A regression that let any
    of these branches fall through would serve raw Internal Active Shielding
    data, which is the one outcome ADR 0028 exists to prevent, and every
    isolated test would still have passed.

    `is_maxshield_fif` is substituted here, and only it. Real detection needs
    both MNE (absent from the pure-python CI job) and a genuine IAS recording,
    and it is an environmental PROBE, not the decision under test: what runs for
    real below is the pair resolution, all three decline branches, and the
    verdict `convert_one` returns. Same injection the module already uses for
    `reset_peak_rss` in TestMemoryErrorBeforePeakReset.
    """

    REC = "sub-01/meg/sub-01_task-rest_meg.fif"
    CAL = "sub-01/meg/sub-01_acq-calibration_meg.dat"
    CTC = "sub-01/meg/sub-01_acq-crosstalk_meg.fif"

    def setUp(self):
        import generate_zarr as gz

        self.gz = gz
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = os.path.join(self._tmp.name, "repo")
        os.makedirs(os.path.join(self.repo, "sub-01", "meg"), exist_ok=True)
        self._write(self.REC)

        try:
            import resource

            saved = resource.getrlimit(resource.RLIMIT_DATA)
            self.addCleanup(resource.setrlimit, resource.RLIMIT_DATA, saved)
        except Exception:  # noqa: BLE001 - no usable RLIMIT_DATA (macOS/Windows)
            pass

        self._orig_probe, self._orig_ctx = gz.is_maxshield_fif, gz._CTX
        self.addCleanup(setattr, gz, "is_maxshield_fif", self._orig_probe)
        self.addCleanup(setattr, gz, "_CTX", self._orig_ctx)

    def _write(self, rel: str) -> None:
        path = os.path.join(self.repo, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(b"\0")

    def _run(self, head_files, *, shielded=True):
        self.gz.is_maxshield_fif = lambda _p: shielded
        self.gz._CTX = {
            "mem_budget": None,
            "tmp": self._tmp.name,
            "local": True,
            "repo": self.repo,
            "head_files": set(head_files),
            "bucket": "b",
            "dataset_id": "on000001",
            "head": "0" * 40,
        }
        return self.gz.convert_one(self.REC, 4 * 1024**3)

    def test_no_calibration_pair_declines_with_the_typed_code(self):
        res = self._run([self.REC])
        self.assertFalse(res["ok"])
        self.assertEqual(res["code"], self.gz.MaxShieldUncalibrated.code)
        # Assert the REASON, not just the code. Every decline branch here raises
        # the same code, so a code-only assertion still passes when this branch
        # falls through and a later one happens to catch the mess -- which is
        # exactly what a fallthrough regression looks like.
        self.assertIn("no fine-calibration", res["error"])

    def test_calibration_alone_is_not_enough(self):
        # ADR 0028 rejects uncalibrated SSS: half a pair must decline, not filter.
        self._write(self.CAL)
        res = self._run([self.REC, self.CAL])
        self.assertEqual(res["code"], self.gz.MaxShieldUncalibrated.code)
        self.assertIn("no fine-calibration", res["error"])

    def test_cross_talk_alone_is_not_enough(self):
        self._write(self.CTC)
        res = self._run([self.REC, self.CTC])
        self.assertEqual(res["code"], self.gz.MaxShieldUncalibrated.code)
        self.assertIn("no fine-calibration", res["error"])

    def test_tracked_pair_without_local_content_declines(self):
        # A git-annex pointer whose content was never fetched. Left uncoded this
        # became an infra failure that re-ran the filter on every future pass.
        res = self._run([self.REC, self.CAL, self.CTC])  # in head_files, not on disk
        self.assertEqual(res["code"], self.gz.MaxShieldUncalibrated.code)
        self.assertIn("git annex get", res["error"])

    def test_a_resolvable_pair_gets_past_the_gate(self):
        # The other direction: with both inputs really present, the decline must
        # NOT fire -- otherwise the 365 recoverable recordings ADR 0028 counted
        # would all be declined and the filtering would never run at all.
        self._write(self.CAL)
        self._write(self.CTC)
        res = self._run([self.REC, self.CAL, self.CTC])
        self.assertNotEqual(res.get("code"), self.gz.MaxShieldUncalibrated.code)

    def test_a_recording_that_is_not_shielded_never_declines(self):
        # The gate is conditioned on detection: an ordinary FIF in a dataset that
        # ships no calibration pair must convert normally, not be declined.
        res = self._run([self.REC], shielded=False)
        self.assertNotEqual(res.get("code"), self.gz.MaxShieldUncalibrated.code)

    def test_probe_failure_is_classified_with_the_typed_code_and_detail(self):
        # #1139: when the probe itself cannot read the file, convert_one must
        # not fall through to a generic/uncoded file_read_error -- the raised
        # MaxShieldProbeFailed is classified exactly like any other typed
        # failure (`.code` picked up by the generic `except Exception`
        # handler), and `detail` carries the exception class plus the first
        # message line, the same construction every other coded failure uses.
        def boom(_path):
            raise self.gz.MaxShieldProbeFailed(
                "could not read the FIF header to test for Internal Active "
                "Shielding: OSError: [Errno 5] I/O error"
            )

        self.gz.is_maxshield_fif = boom
        self.gz._CTX = {
            "mem_budget": None,
            "tmp": self._tmp.name,
            "local": True,
            "repo": self.repo,
            "head_files": {self.REC},
            "bucket": "b",
            "dataset_id": "on000001",
            "head": "0" * 40,
        }
        res = self.gz.convert_one(self.REC, 4 * 1024**3)
        self.assertFalse(res["ok"])
        self.assertEqual(res["code"], self.gz.MaxShieldProbeFailed.code)
        self.assertIn("MaxShieldProbeFailed", res["detail"])
        self.assertIn("Internal Active Shielding", res["detail"])
        self.assertNotIn(res["code"], RETRYABLE_CODES)


class TestIsMaxShieldFif(unittest.TestCase):
    """The MaxShield probe's own edges (#1126)."""

    def test_a_non_fif_is_not_probed(self):
        # Short-circuits on extension, so it costs nothing on the EEG datasets
        # that make up most of the archive and never needs MNE.
        self.assertFalse(is_maxshield_fif("sub-01/eeg/sub-01_task-x_eeg.set"))

    def test_an_unreadable_fif_raises_the_typed_probe_failure(self):
        # #1139: before this, a header probe that failed routed the recording
        # down the normal path silently (a print, then `return False`), where
        # a genuinely shielded file surfaced as an opaque file_read_error with
        # no hint the probe was the thing that broke. It must instead raise a
        # coded exception -- convert_one classifies it exactly like any other
        # typed failure, via `.code` and `failure_detail`.
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "sub-01_task-x_meg.fif")
            with open(bad, "wb") as fh:
                fh.write(b"not a fif")
            with self.assertRaises(MaxShieldProbeFailed) as cm:
                is_maxshield_fif(bad)
        self.assertEqual(cm.exception.code, "maxshield_probe_failed")
        self.assertIn("Internal Active Shielding", str(cm.exception))
        # The original read failure is chained, not swallowed -- a traceback
        # still names the real cause.
        self.assertIsNotNone(cm.exception.__cause__)


class TestWorkerMemLimit(unittest.TestCase):
    """#1110: the per-recording RLIMIT_DATA backstop."""

    def setUp(self):
        # These mutate the real process limit; restore it so test order cannot
        # leave a later test running under a narrowed data segment.
        try:
            import resource

            self._saved = resource.getrlimit(resource.RLIMIT_DATA)
        except Exception:  # noqa: BLE001
            self._saved = None

    def tearDown(self):
        if self._saved is not None:
            import resource

            resource.setrlimit(resource.RLIMIT_DATA, self._saved)

    def test_none_peak_leaves_limit_alone(self):
        self.assertIsNone(worker_mem_limit_bytes(None, 100))
        self.assertIsNone(worker_mem_limit_bytes(0, 100))

    def test_small_recording_gets_the_floor_not_a_tiny_limit(self):
        # A 10 MB recording reserves little; capping its worker there would kill
        # it on interpreter + numpy/MNE startup, long before any signal.
        self.assertEqual(
            worker_mem_limit_bytes(10 * 1024**2, 999 * 1024**3), MEM_LIMIT_FLOOR_BYTES
        )

    def test_large_recording_scales_with_its_reservation(self):
        peak = 20 * 1024**3
        self.assertEqual(
            worker_mem_limit_bytes(peak, 999 * 1024**3), int(peak * MEM_LIMIT_SLACK)
        )

    def test_never_exceeds_the_node_ceiling(self):
        ceiling = 8 * 1024**3
        self.assertEqual(worker_mem_limit_bytes(20 * 1024**3, ceiling), ceiling)

    def test_admission_charges_what_the_worker_is_permitted(self):
        # The invariant that makes the backstop a real containment rather than a
        # per-process curiosity: if admission charged the bare projection while
        # each worker was allowed `projection * SLACK`, N concurrent workers
        # could be permitted N*SLACK times the ceiling and the kernel OOM reaper
        # would still win. Reserving what we permit bounds the aggregate.
        ceiling = 48 * 1024**3
        projection = 4 * 1024**3
        reserve = admission_reserve_bytes(projection, ceiling)
        admitted, running = 0, 0
        while running + reserve <= ceiling:
            running += reserve
            admitted += 1
        self.assertGreaterEqual(admitted, 1)
        self.assertLessEqual(admitted * reserve, ceiling)

    def test_setting_the_limit_never_raises(self):
        apply_worker_mem_limit(4 * 1024**3, 8 * 1024**3)
        apply_worker_mem_limit(None, None)

    def test_the_limit_sits_on_top_of_the_data_segment_the_worker_already_holds(self):
        """The reservation is headroom for the recording, not an absolute cap.

        On the conversion node numpy+scipy reserve 2.6 GiB of RLIMIT_DATA at
        import (OpenBLAS buffer pools) against 100 MB of RSS, so an absolute
        4 GiB floor left ~1.3 GiB and a 4 MB EMG recording failed a 624 KiB
        allocation as "exceeded its memory budget" (2026-09-03). Linux only:
        that is the only platform the backstop is applied on.
        """
        if not sys.platform.startswith("linux"):
            self.skipTest("RLIMIT_DATA backstop is Linux-only")
        import resource

        reserve = 4 * 1024**3
        before = data_segment_bytes()
        self.assertIsNotNone(before)
        apply_worker_mem_limit(reserve, 64 * 1024**3, reserved=True)
        after = data_segment_bytes()
        soft = resource.getrlimit(resource.RLIMIT_DATA)[0]
        # The baseline is read inside the call, between our two readings.
        self.assertGreaterEqual(soft, before + reserve)
        self.assertLessEqual(soft, after + reserve + 64 * 1024**2)

    def test_the_ceiling_caps_the_reserve_not_the_sum_with_the_baseline(self):
        """A recording admitted AT the ceiling must still get the whole ceiling
        for its own allocations. Clamping the sum would leave it `baseline`
        short of what admission charged -- the original bug at smaller scale."""
        if not sys.platform.startswith("linux"):
            self.skipTest("RLIMIT_DATA backstop is Linux-only")
        import resource

        ceiling = 2 * 1024**3
        before = data_segment_bytes()
        apply_worker_mem_limit(8 * 1024**3, ceiling, reserved=True)
        after = data_segment_bytes()
        soft = resource.getrlimit(resource.RLIMIT_DATA)[0]
        self.assertGreaterEqual(soft, before + ceiling)
        self.assertLessEqual(soft, after + ceiling + 64 * 1024**2)

    def test_data_segment_is_measured_where_the_backstop_applies(self):
        value = data_segment_bytes()
        if sys.platform.startswith("linux"):
            self.assertIsInstance(value, int)
            self.assertGreater(value, 0)
        else:
            self.assertIsNone(value)


class TestBlasThreadCaps(unittest.TestCase):
    """Per-recording BLAS threading oversubscribes the node and, on the
    conversion node, costs each worker ~2.4 GiB of RLIMIT_DATA headroom in
    pre-mapped OpenBLAS buffer pools (see the note above BLAS_THREAD_VARS)."""

    def test_every_pool_is_pinned_to_one_thread_when_unset(self):
        env: dict[str, str] = {}
        effective = cap_blas_threads(env)
        self.assertEqual(effective, {var: "1" for var in BLAS_THREAD_VARS})
        self.assertEqual(env, effective)

    def test_an_operator_value_is_respected(self):
        env = {"OPENBLAS_NUM_THREADS": "4"}
        effective = cap_blas_threads(env)
        self.assertEqual(effective["OPENBLAS_NUM_THREADS"], "4")
        for var in BLAS_THREAD_VARS:
            if var != "OPENBLAS_NUM_THREADS":
                self.assertEqual(effective[var], "1")

    def test_importing_the_converter_pins_this_process(self):
        # The module-level call is what protects the driver and, by inheritance,
        # every pool worker; an operator override in the environment survives.
        for var in BLAS_THREAD_VARS:
            self.assertIn(var, os.environ)


class TestPoolBreakRecovery(unittest.TestCase):
    """#1110: a killed worker must cost one recording, not the whole queue."""

    def _run(self, primaries, cpu_cap=2):
        peaks = {p: 1024 for p in primaries}
        results = []
        breaks, max_suspects = _drain_with_admission(
            list(primaries), peaks, cpu_cap, 10**9, {},
            lambda r, i: results.append(r), worker=_crashing_worker,
        )
        return results, breaks, max_suspects

    def test_a_dying_worker_does_not_abandon_the_queue(self):
        # Before #1110 this aborted the run: on004998 converted 74 of 115 and
        # lost the remaining 41 to one kill.
        primaries = [f"sub-{i:02d}/eeg/sub-{i:02d}_task-rest_eeg.set" for i in range(1, 9)]
        primaries.insert(2, "sub-boom/eeg/sub-boom_task-rest_eeg.set")
        results, breaks, _ = self._run(primaries)

        self.assertEqual(len(results), len(primaries), "every recording must be accounted for")
        ok = {r["primary"] for r in results if r["ok"]}
        self.assertEqual(ok, set(primaries) - {"sub-boom/eeg/sub-boom_task-rest_eeg.set"})
        self.assertGreaterEqual(breaks, 1)

    def test_the_culprit_is_named_after_running_alone(self):
        results, _, _ = self._run(["sub-boom/eeg/sub-boom_task-rest_eeg.set"], cpu_cap=1)
        self.assertEqual(len(results), 1)
        self.assertFalse(results[0]["ok"])
        self.assertIn("killed its worker process", results[0]["error"])
        # Uncoded => infra => retried on a later run, rather than recorded as a
        # permanent property of the data.
        self.assertIsNone(results[0].get("code"))

    def test_innocent_siblings_are_never_blamed(self):
        # The reason recovery re-runs suspects SERIALLY. Retrying them in
        # parallel lets the culprit break the pool again, and a sibling in flight
        # for both breaks gets blamed for a crash it did not cause -- which is
        # exactly what an earlier parallel-retry implementation did.
        primaries = [f"sub-{i:02d}/eeg/sub-{i:02d}_task-rest_eeg.set" for i in range(1, 13)]
        primaries.insert(1, "sub-boom/eeg/sub-boom_task-rest_eeg.set")
        boom = "sub-boom/eeg/sub-boom_task-rest_eeg.set"
        saw_crossfire = False
        for _ in range(5):  # the race is timing-dependent; repeat it
            results, _breaks, max_suspects = self._run(primaries, cpu_cap=4)
            failed = {r["primary"] for r in results if not r["ok"]}
            self.assertEqual(
                failed, {boom}, "only the recording that dies alone may be reported failed"
            )
            self.assertEqual(len(results), len(primaries))
            # More than one suspect set aside at once means an INNOCENT recording
            # was in flight when the pool died -- the actual guarded path.
            # `pool_breaks` cannot express this: with one faulty recording it is
            # pinned at 2 (parallel pass, then the serial confirmation that always
            # breaks too) whether or not a sibling was ever caught, which made the
            # previous version of this assertion pass vacuously.
            if max_suspects > 1:
                saw_crossfire = True
        self.assertTrue(
            saw_crossfire,
            "never observed a sibling caught in the crossfire; the guarded path went untested",
        )

    def test_a_clean_run_is_unaffected(self):
        primaries = [f"sub-{i:02d}/eeg/sub-{i:02d}_task-rest_eeg.set" for i in range(1, 6)]
        results, breaks, _ = self._run(primaries)
        self.assertEqual(len(results), 5)
        self.assertTrue(all(r["ok"] for r in results))
        self.assertEqual(breaks, 0)


class TestStoreMetadataDiagnostics(unittest.TestCase):
    """#1119: a store-read failure must name its cause, and must not publish it."""

    def test_unreadable_store_reports_the_cause_privately(self):
        meta = store_metadata("/no/such/store.zarr")
        self.assertFalse(meta.get("groups"))
        self.assertIn("_error", meta)

    def test_diagnostic_keys_are_underscore_prefixed(self):
        # `meta` is spread into the published index entry, so anything diagnostic
        # has to be filterable. The `_` prefix is that contract.
        meta = store_metadata("/no/such/store.zarr")
        for key in meta:
            if key == "_error":
                continue
            self.assertFalse(key.startswith("_"), f"unexpected private key {key}")


class TestPeakRssMeasurement(unittest.TestCase):
    """#1111: per-recording peak RAM, so the projection factors stop being guesses."""

    def test_peak_rss_is_readable_and_plausible(self):
        rss = peak_rss_bytes()
        if rss is None:
            self.skipTest("no readable peak-RSS source on this platform")
        # A running CPython is comfortably over 1 MiB and nowhere near 1 TiB;
        # this catches a units error (KiB read as bytes, or vice versa), which is
        # the realistic failure mode here.
        self.assertGreater(rss, 1024**2)
        self.assertLess(rss, 1024**4)

    @unittest.skipUnless(sys.platform.startswith("linux"), "clear_refs is Linux-only")
    def test_reset_actually_lowers_the_high_water_mark(self):
        # The whole reason measurement is trustworthy with REUSED pool workers:
        # without this a small recording inherits the peak of the largest one its
        # worker handled earlier, and every number is an upper envelope.
        blob = bytearray(256 * 1024**2)
        blob[::4096] = b"\x01" * (len(blob) // 4096)  # touch it so it is resident
        before = peak_rss_bytes()
        del blob
        self.assertTrue(reset_peak_rss())
        after = peak_rss_bytes()
        self.assertIsNotNone(before)
        self.assertIsNotNone(after)
        self.assertLess(after, before, "clear_refs did not reset the peak")

    def test_reset_is_harmless_where_unsupported(self):
        # Returns False rather than raising, so a platform without clear_refs
        # simply reports coarser numbers instead of failing conversions.
        self.assertIn(reset_peak_rss(), (True, False))


class TestInMemoryFactors(unittest.TestCase):
    """#1111: one blow-up multiplier for every format was the calibration error."""

    def test_brainvision_is_higher_than_the_default(self):
        # Its chain is MNE float64 preload + a per-channel DataFrame copy + the
        # pandas consolidation transient + the resample copy -- roughly twice the
        # generic assumption, which is what the admission controller mis-reserved
        # when it packed seven of them onto a 62 GB node.
        self.assertGreater(inmem_factor_for("sub-01_task-x_eeg.vhdr"), INMEM_MEM_FACTOR)

    def test_unmeasured_formats_keep_the_default(self):
        for name in ("sub-01_eeg.set", "sub-01_eeg.edf", "sub-01_meg.con"):
            self.assertEqual(inmem_factor_for(name), INMEM_MEM_FACTOR)

    def test_projection_uses_the_per_format_factor(self):
        # Below the streaming threshold, so the in-memory factor is what applies.
        size = 100 * 1024**2
        self.assertEqual(
            projected_peak_bytes("sub-01_task-x_eeg.vhdr", size),
            int(size * inmem_factor_for("x.vhdr")),
        )


class TestCalibrationSummary(unittest.TestCase):
    """#1111: the feedback loop that turns the factor table into measurement."""

    def test_reports_the_worst_ratio_per_format(self):
        projections = {"a.set": 1000, "b.set": 1000, "c.vhdr": 1000}
        measured = {"a.set": 500, "b.set": 3000, "c.vhdr": 1200}
        rows = {r["ext"]: r for r in calibration_summary(measured, projections, set())}
        self.assertEqual(rows[".set"]["n"], 2)
        self.assertEqual(rows[".set"]["max_ratio"], 3.0)  # the worst, not the mean
        self.assertEqual(rows[".vhdr"]["max_ratio"], 1.2)
        # The peak reported must belong to the SAME recording as the ratio, or the
        # summary attributes one recording's size to another's overrun.
        self.assertEqual(rows[".set"]["max_peak_bytes"], 3000)

    def test_worst_format_sorts_first(self):
        projections = {"a.set": 1000, "b.vhdr": 1000}
        measured = {"a.set": 4000, "b.vhdr": 1100}
        self.assertEqual(calibration_summary(measured, projections, set())[0]["ext"], ".set")

    def test_suggested_factor_scales_the_current_one(self):
        # Advisory only: it says what WOULD have covered the worst case, and is
        # never applied automatically -- one pathological recording must not
        # silently re-tune the archive.
        rows = calibration_summary({"a.set": 2000}, {"a.set": 1000}, set())
        self.assertEqual(rows[0]["suggested_factor"], round(INMEM_MEM_FACTOR * 2, 1))

    def test_streamed_recordings_get_no_factor_suggestion(self):
        # A streamed recording's projection is the flat STREAM_PEAK_BYTES,
        # unrelated to on-disk size, so multiplying a blow-up factor by its
        # overrun ratio yields a number that looks like a factor but is not one.
        rows = calibration_summary(
            {"a.edf": STREAM_PEAK_BYTES * 2}, {"a.edf": STREAM_PEAK_BYTES}, {"a.edf"}
        )
        self.assertEqual(rows[0]["path"], "stream")
        self.assertNotIn("suggested_factor", rows[0])

    def test_the_same_format_is_split_by_which_path_it_took(self):
        rows = calibration_summary(
            {"a.edf": 100, "b.edf": STREAM_PEAK_BYTES * 2},
            {"a.edf": 50, "b.edf": STREAM_PEAK_BYTES},
            {"b.edf"},
        )
        self.assertEqual({r["path"] for r in rows}, {"inmem", "stream"})

    def test_channel_raised_streaming_projection_still_buckets_as_stream(self):
        # Regression: the bucket used to be derived from `proj == STREAM_PEAK_BYTES`,
        # which silently stopped being equivalent to "streamed" once
        # `streaming_peak_bytes` began raising the projection to the per-channel
        # floor for a few-channel, long, high-rate recording (ADR 0030). Such a
        # recording streamed, but was bucketed "inmem" and handed a suggested_factor
        # computed from a streaming projection -- a number that reads like a blow-up
        # multiplier and is not one.
        raised = streaming_peak_bytes(8 * 1024**3, 2)
        self.assertGreater(raised, STREAM_PEAK_BYTES)  # guard: the case is real
        rows = calibration_summary({"a.edf": raised * 2}, {"a.edf": raised}, {"a.edf"})
        self.assertEqual(rows[0]["path"], "stream")
        self.assertNotIn("suggested_factor", rows[0])

    def test_recordings_without_a_projection_are_ignored(self):
        self.assertEqual(calibration_summary({"ghost.set": 10}, {}, set()), [])

    def test_empty_input_is_empty_output(self):
        self.assertEqual(calibration_summary({}, {}, set()), [])


class TestUsableRam(unittest.TestCase):
    """#1111: the ceiling must describe RAM we can actually get."""

    def test_is_positive_and_not_absurd(self):
        os.environ.pop("ZARR_REC_MEM_BUDGET_BYTES", None)
        usable = usable_ram_bytes()
        self.assertGreater(usable, 0)
        self.assertLess(usable, 1024**5)

    @unittest.skipUnless(sys.platform.startswith("linux"), "reads /proc/meminfo")
    def test_never_exceeds_what_the_kernel_says_is_available(self):
        # MemTotal describes a machine we do not have to ourselves: the conversion
        # node is shared, and the page cache backing our own scratch lives in the
        # same RAM. Using it consistently overstated the budget.
        with open("/proc/meminfo") as fh:
            info = {
                line.split(":", 1)[0]: int(line.split()[1]) * 1024
                for line in fh
                if line.split(":", 1)[0] in ("MemTotal", "MemAvailable")
            }
        if "MemAvailable" not in info:
            self.skipTest("kernel too old to publish MemAvailable")
        self.assertLessEqual(usable_ram_bytes(), info["MemAvailable"])
        self.assertLess(usable_ram_bytes(), info["MemTotal"])


class TestUsableRamFromSyntheticMeminfo(unittest.TestCase):
    """#1111: prove the ceiling takes MemAvailable, without depending on whatever
    the host's ambient memory happens to be. On a near-idle CI runner MemAvailable
    is most of MemTotal, so a live-/proc assertion barely discriminates."""

    def _meminfo(self, total_gib, avail_gib=None):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "meminfo")
        lines = [f"MemTotal:       {total_gib * 1024 * 1024} kB\n"]
        if avail_gib is not None:
            lines.append(f"MemAvailable:   {avail_gib * 1024 * 1024} kB\n")
        lines.append("SwapTotal:      0 kB\n")
        with open(path, "w") as fh:
            fh.writelines(lines)
        return path

    def test_prefers_memavailable_over_memtotal(self):
        # Far apart on purpose: the old code took 0.8 * 64 = 51.2 GiB while only
        # 20 GiB was obtainable. That gap is the whole bug.
        path = self._meminfo(total_gib=64, avail_gib=20)
        os.environ["ZARR_MEM_HEADROOM_FRAC"] = "0.8"
        try:
            self.assertAlmostEqual(
                usable_ram_bytes(path) / 1024**3, 16.0, places=1  # 0.8 * 20
            )
        finally:
            os.environ.pop("ZARR_MEM_HEADROOM_FRAC", None)

    def test_falls_back_to_memtotal_on_an_old_kernel(self):
        # MemAvailable landed in 3.14; without it MemTotal is all there is.
        path = self._meminfo(total_gib=64)
        os.environ["ZARR_MEM_HEADROOM_FRAC"] = "0.5"
        try:
            self.assertAlmostEqual(usable_ram_bytes(path) / 1024**3, 32.0, places=1)
        finally:
            os.environ.pop("ZARR_MEM_HEADROOM_FRAC", None)

    def test_a_momentarily_loaded_node_cannot_starve_admission(self):
        # Without a floor, a transient dip yields a ceiling below one streaming
        # recording -- at which point EVERY recording is skipped as "too large"
        # and a node-load artifact is recorded as a property of the data.
        path = self._meminfo(total_gib=64, avail_gib=1)
        self.assertEqual(usable_ram_bytes(path), CEILING_FLOOR_BYTES)
        self.assertGreaterEqual(CEILING_FLOOR_BYTES, STREAM_PEAK_BYTES)


class TestNoteMeasurement(unittest.TestCase):
    """#1111: the bookkeeping that feeds calibration."""

    def test_records_a_measurement_and_stays_quiet_when_within_budget(self):
        measured = {}
        warning = note_measurement(
            {"primary": "a.set", "peak_rss": 500, "ok": True}, {"a.set": 1000}, measured
        )
        self.assertIsNone(warning)
        self.assertEqual(measured, {"a.set": 500})

    def test_warns_when_a_recording_cost_more_than_reserved(self):
        measured = {}
        # Over the containment boundary (projection * slack), not merely over the
        # bare projection.
        warning = note_measurement(
            {"primary": "a.vhdr", "peak_rss": 9000, "ok": True}, {"a.vhdr": 1000}, measured
        )
        self.assertIsNotNone(warning)
        self.assertIn("under-reserved", warning)
        self.assertIn("9.0x", warning)

    def test_stays_quiet_within_the_slack_that_was_actually_reserved(self):
        # A recording over its bare projection but inside its reservation
        # endangered nothing; warning here would put a line against a large share
        # of every run, in a log already too big to read.
        measured = {}
        self.assertIsNone(
            note_measurement(
                {"primary": "a.set", "peak_rss": 2000, "ok": True}, {"a.set": 1000}, measured
            )
        )
        self.assertEqual(measured, {"a.set": 2000})

    def test_an_unmeasured_recording_is_dropped_not_recorded_as_zero(self):
        # None means "not measured" or "measured untrustworthily". Blending it in
        # would silently corrupt the calibration sample.
        measured = {}
        self.assertIsNone(
            note_measurement({"primary": "a.set", "peak_rss": None}, {"a.set": 1000}, measured)
        )
        self.assertEqual(measured, {})

    def test_a_recording_with_no_projection_is_ignored(self):
        measured = {}
        self.assertIsNone(
            note_measurement({"primary": "ghost.set", "peak_rss": 10}, {}, measured)
        )
        self.assertEqual(measured, {})

    def test_a_backstop_trip_still_contributes_a_measurement(self):
        # The recordings that PROVE a format is under-projected are the ones that
        # hit the backstop; excluding them made calibration look cleanest exactly
        # where it was most wrong.
        r = memory_failure_result("a.set", MemoryError("x"), peak_rss=5000)
        measured = {}
        warning = note_measurement(r, {"a.set": 1000}, measured)
        self.assertEqual(measured, {"a.set": 5000})
        self.assertIn("under-reserved", warning)


class TestFactorAffectsAdmission(unittest.TestCase):
    """#1111: the per-format factor must actually change what runs concurrently --
    not merely what `projected_peak_bytes` returns."""

    def test_a_heavier_format_admits_fewer_at_once(self):
        # Below the streaming threshold on purpose: above it both formats get the
        # same flat STREAM_PEAK_BYTES and the factor is not what is being tested.
        size = 100 * 1024**2
        ceiling = 200 * 1024**3

        def admitted(name):
            reserve = admission_reserve_bytes(projected_peak_bytes(name, size), ceiling)
            n, running = 0, 0
            while running + reserve <= ceiling:
                running += reserve
                n += 1
            return n

        heavy = admitted("sub-01_task-x_eeg.vhdr")   # factor 12
        light = admitted("sub-01_task-x_eeg.set")    # factor 6 (default)
        self.assertLess(heavy, light, "the heavier format must self-limit concurrency")
        self.assertGreater(light, 0)


class TestStreamingAdmissionThroughput(unittest.TestCase):
    """#1112: making streaming the default must not make conversion serial."""

    def test_streaming_is_not_charged_in_memory_slack(self):
        # Slack covers the in-memory factor being a guess that runs ~2x low. The
        # streaming projection is the flat bound the two-pass design gives, not a
        # guess of that kind, so tripling it is charging for nothing.
        ceiling = 200 * 1024**3
        proj = STREAM_PEAK_BYTES
        self.assertEqual(admission_reserve_bytes(proj, ceiling, streamed=True), proj)
        self.assertEqual(
            admission_reserve_bytes(proj, ceiling, streamed=False),
            int(proj * MEM_LIMIT_SLACK),
        )

    def test_more_than_one_recording_is_admitted_on_a_realistic_ceiling(self):
        # The regression this guards: with slack applied to the streaming bound,
        # a 4 GiB projection was charged 12 GiB against this node's measured
        # ~19 GiB ceiling, admitting exactly ONE recording at a time under
        # --jobs 24 -- serial conversion of a 1.5 TB dataset.
        ceiling = 19 * 1024**3
        size = int(1.3 * 1000**3)  # a real on004917 recording
        name = "sub-02/eeg/sub-02_task-pdm_eeg.vhdr"
        self.assertTrue(should_stream(name, size))
        reserve = admission_reserve_bytes(
            projected_peak_bytes(name, size), ceiling, streamed=True
        )
        self.assertGreater(
            ceiling // reserve, 1, "streaming the default must not serialise the queue"
        )

    def test_in_memory_recordings_still_carry_slack(self):
        # .set has no streaming route, so its projection is still the guessed
        # multiple and must keep its safety margin.
        ceiling = 200 * 1024**3
        size = 100 * 1024**2
        name = "sub-01/eeg/sub-01_task-x_eeg.set"
        self.assertFalse(should_stream(name, size))
        proj = projected_peak_bytes(name, size)
        self.assertEqual(
            admission_reserve_bytes(proj, ceiling, streamed=False),
            int(proj * MEM_LIMIT_SLACK),
        )

    def test_set_never_streams_at_any_size(self):
        # ADR 0030: two independent blockers (MNE refuses v7.3; an embedded
        # classic .set loads fully even with preload=False). Pinned at sizes well
        # past every threshold so a future tuple edit cannot quietly include it.
        for size in (10 * 1024**2, 512 * 1024**2, 5 * 1024**3, 50 * 1024**3):
            self.assertFalse(
                should_stream("sub-01/eeg/sub-01_task-x_eeg.set", size),
                f".set must not stream at {size} bytes",
            )


class TestThresholdIndependence(unittest.TestCase):
    """#1112 collapsed STREAM_MIN_BYTES and STREAM_KIT_MIN_BYTES to the same
    value. They remain separate, separately-overridable constants feeding separate
    branches, so no black-box probe can tell any more whether BTi reads the right
    one -- a refactor wiring it to KIT's would pass every other test. These pin
    each branch to its own constant by giving them different values."""

    def setUp(self):
        self._saved = (
            generate_zarr.STREAM_MIN_BYTES,
            generate_zarr.STREAM_KIT_MIN_BYTES,
            generate_zarr.STREAM_EDF_MIN_BYTES,
        )
        generate_zarr.STREAM_MIN_BYTES = 100
        generate_zarr.STREAM_KIT_MIN_BYTES = 10_000
        generate_zarr.STREAM_EDF_MIN_BYTES = 1_000_000

    def tearDown(self):
        (
            generate_zarr.STREAM_MIN_BYTES,
            generate_zarr.STREAM_KIT_MIN_BYTES,
            generate_zarr.STREAM_EDF_MIN_BYTES,
        ) = self._saved

    def test_bti_tracks_stream_min_not_the_kit_constant(self):
        bti = "sub-01/meg/sub-01_task-x_meg"  # extension-less: the BTi branch
        self.assertTrue(generate_zarr.should_stream(bti, 200))     # > STREAM_MIN
        self.assertFalse(generate_zarr.should_stream(bti, 50))

    def test_brainvision_tracks_stream_min_not_the_kit_constant(self):
        vhdr = "sub-01/eeg/sub-01_task-x_eeg.vhdr"
        self.assertTrue(generate_zarr.should_stream(vhdr, 200))
        self.assertFalse(generate_zarr.should_stream(vhdr, 50))

    def test_kit_tracks_its_own_constant(self):
        con = "sub-01/meg/sub-01_task-x_meg.con"
        self.assertFalse(generate_zarr.should_stream(con, 200))    # < STREAM_KIT_MIN
        self.assertTrue(generate_zarr.should_stream(con, 20_000))

    def test_edf_tracks_its_own_constant(self):
        # The third constant, and the one this class originally missed: all three
        # default to 256 MiB, so a refactor wiring the EDF branch to
        # STREAM_MIN_BYTES or STREAM_KIT_MIN_BYTES would have passed every test
        # in the file -- exactly the bug shape this class exists to prevent.
        edf = "sub-01/eeg/sub-01_task-x_eeg.edf"
        if not generate_zarr._EDF_STREAMABLE:
            self.skipTest("installed biosigio does not stream EDF")
        self.assertFalse(generate_zarr.should_stream(edf, 200))        # > STREAM_MIN
        self.assertFalse(generate_zarr.should_stream(edf, 20_000))     # > STREAM_KIT_MIN
        self.assertTrue(generate_zarr.should_stream(edf, 2_000_000))   # > STREAM_EDF_MIN

    def test_exact_boundary_is_strictly_greater_than(self):
        vhdr = "sub-01/eeg/sub-01_task-x_eeg.vhdr"
        self.assertFalse(generate_zarr.should_stream(vhdr, 100))   # equal, not >
        self.assertTrue(generate_zarr.should_stream(vhdr, 101))


class TestOn004917BatchAdmission(unittest.TestCase):
    """#1112: the end-to-end concurrency the fix restores, on the real batch."""

    def test_the_real_batch_admits_several_at_once(self):
        # The 24 BrainVision recordings that OOMed the node, at their real sizes,
        # against the ceiling Phase 3 measured there. Before the streamed-slack
        # fix this admitted exactly one at a time.
        sizes = [
            2.246, 1.728, 1.681, 1.577, 1.452, 1.433, 1.407, 1.386, 1.369, 1.361,
            1.350, 1.326, 1.322, 1.318, 1.308, 1.304, 1.295, 1.280, 1.275, 1.261,
            1.254, 1.241, 1.237, 1.181,
        ]
        ceiling = 19 * 1024**3
        reserves = []
        for i, gb in enumerate(sizes):
            name = f"sub-{i:02d}/eeg/sub-{i:02d}_task-pdm_eeg.vhdr"
            size = int(gb * 1000**3)
            self.assertTrue(should_stream(name, size), f"{gb} GB must stream now")
            reserves.append(
                admission_reserve_bytes(
                    projected_peak_bytes(name, size), ceiling, streamed=True
                )
            )

        # Walk the real admission rule over the batch.
        running, admitted = 0, 0
        for r in reserves:
            if running + r > ceiling:
                break
            running += r
            admitted += 1
        self.assertGreater(admitted, 1, "the batch must not convert one at a time")
        self.assertLessEqual(running, ceiling, "and must still respect the ceiling")


class TestMneEmbeddedSetCanary(unittest.TestCase):
    """ADR 0030 rests on MNE eagerly materialising an EEGLAB `.set` whose samples
    are embedded in the MAT struct rather than a sibling `.fdt`. That is a claim
    about a third-party library, verified once by hand; if a future MNE gains real
    lazy support the `.set` exclusion goes stale silently. This is the canary."""

    def test_mne_still_eagerly_loads_embedded_set(self):
        try:
            import inspect

            from mne.io.eeglab.eeglab import RawEEGLAB
        except Exception:  # noqa: BLE001
            self.skipTest("mne not installed (it is lazily imported in production)")
        src = inspect.getsource(RawEEGLAB._read_segment_file)
        self.assertIn("is_embedded", src, "MNE no longer flags embedded .set")
        self.assertIn(
            "preload=True",
            src,
            "MNE may have gained lazy reads for embedded .set -- re-evaluate ADR 0030",
        )


class TestStreamingPeakIsChannelAware(unittest.TestCase):
    """#1112: STREAM_PEAK_BYTES is a FLOOR, not a bound.

    Pass 2 of the streaming exporter materialises one whole channel at native
    rate as anonymous float64 (`n_samples * 8`). That term scales with duration
    and sample rate and is independent of channel count, so a few-channel, long,
    high-rate recording can have a single channel that alone exceeds the flat
    figure -- it would then be admitted as if it cost 4 GiB, trip the RLIMIT set
    to exactly that, and fail.
    """

    SIZE = int(1.3 * 1000**3)

    def test_many_channels_stay_at_the_floor(self):
        # 66 short channels: no single one is anywhere near the floor.
        self.assertEqual(streaming_peak_bytes(self.SIZE, 66), STREAM_PEAK_BYTES)

    def test_a_single_channel_recording_projects_higher(self):
        # All the bytes in one channel: the per-channel term dominates and the
        # flat figure would have been a serious under-projection.
        self.assertGreater(streaming_peak_bytes(self.SIZE, 1), STREAM_PEAK_BYTES)

    def test_the_projection_falls_as_channels_rise(self):
        peaks = [streaming_peak_bytes(self.SIZE, n) for n in (1, 2, 4, 8)]
        self.assertEqual(peaks, sorted(peaks, reverse=True))

    def test_unknown_channel_count_falls_back_to_the_floor(self):
        # channels.tsv unreadable: no worse than before this change.
        self.assertEqual(streaming_peak_bytes(self.SIZE, None), STREAM_PEAK_BYTES)
        self.assertEqual(streaming_peak_bytes(self.SIZE, 0), STREAM_PEAK_BYTES)

    def test_projected_peak_bytes_threads_the_channel_count(self):
        name = "sub-01/emg/sub-01_task-x_emg.vhdr"
        self.assertTrue(should_stream(name, self.SIZE))
        self.assertGreater(
            projected_peak_bytes(name, self.SIZE, 1),
            projected_peak_bytes(name, self.SIZE, 66),
        )

    def test_the_in_memory_path_ignores_channel_count(self):
        # .set never streams, so its projection is the on-disk factor regardless.
        name = "sub-01/eeg/sub-01_task-x_eeg.set"
        self.assertEqual(
            projected_peak_bytes(name, 100 * 1024**2, 1),
            projected_peak_bytes(name, 100 * 1024**2, 66),
        )

def build_real_edf(directory: str, stem: str, n_channels: int = 4,
                   rate: int = 200, seconds: int = 60) -> str:
    """Write a REAL, spec-compliant EDF+ with pyedflib and return its path.

    Not a fixture file in the repo, and not a stub: `test/fixtures/bids-minimal`'s
    `.edf` is a 1 KB placeholder that pyedflib refuses to open ("the label is
    incorrect"), so it cannot exercise a conversion at all. This writes one with
    the same library biosigIO's importer reads it back with, so everything
    downstream -- the importer, the resampler, the Zarr writer, the attrs this
    module then republishes -- is the real code on real samples. 60 s at 200 Hz is
    the smallest size that still produces a multi-level view pyramid, which is
    what the geometry assertions need.
    """
    import numpy as np
    import pyedflib

    path = os.path.join(directory, f"{stem}.edf")
    writer = pyedflib.EdfWriter(path, n_channels, file_type=pyedflib.FILETYPE_EDFPLUS)
    writer.setSignalHeaders([
        {
            "label": f"E{i + 1}",
            "dimension": "uV",
            "sample_frequency": rate,
            "physical_max": 500.0,
            "physical_min": -500.0,
            "digital_max": 32767,
            "digital_min": -32768,
            "transducer": "",
            "prefilter": "",
        }
        for i in range(n_channels)
    ])
    rng = np.random.default_rng(0)
    writer.writeSamples([rng.normal(0, 20, rate * seconds) for _ in range(n_channels)])
    writer.close()
    return path


# --- real recordings ----------------------------------------------------------
# A handful of assertions can only be made against an actual archived recording:
# the resampling relation `sample_index` rests on is a property of biosigIO plus
# a real acquisition rate, and a hand-built fixture at the SERVING rate would
# never exercise it (#1060 names nm000329 for exactly this reason).
#
# Downloads are cached OUTSIDE the repository -- nothing to commit, and one
# download per host rather than one per worktree -- and every failure path skips
# rather than fails: these tests need the network, and a flaky connection must
# not turn a converter change red. Mirrors biosigio's own
# `biosigio/tests/real_data.py`, with `unittest.SkipTest` in place of
# `pytest.skip` so `python test_generate_zarr.py` behaves the same as pytest.
REAL_DATA_CACHE_ENV = "NEMAR_ZARR_REAL_DATA_CACHE"
REAL_DATA_SKIP_ENV = "NEMAR_ZARR_SKIP_REAL_DATA"
_REAL_DATA_DEFAULT_CACHE = os.path.join(
    os.path.expanduser("~"), ".cache", "nemar-zarr-tests", "real_data"
)
# data.nemar.org resets the connection for urllib's default `Python-urllib/x.y`
# User-Agent (a generic anti-bot header check -- any other string clears it).
_REAL_DATA_USER_AGENT = (
    "nemar-cli-zarr-tests/1.0 (+https://github.com/nemarOrg/nemar-cli)"
)


def fetch_real_file(url: str, *, min_bytes: int = 1) -> str:
    """Local path to `url`, downloading it into the shared cache on first use.

    Raises `unittest.SkipTest` (never fails) when the download is unavailable or
    opted out of. URLs must be VERSIONED (`/nm000329/v1.0.7/...`): the point of a
    real-data assertion is that it is made against known bytes, and `latest`
    would silently change what was verified.
    """
    if os.environ.get(REAL_DATA_SKIP_ENV):
        raise unittest.SkipTest(
            f"real-data test skipped: {REAL_DATA_SKIP_ENV} is set"
        )
    cache = os.environ.get(REAL_DATA_CACHE_ENV) or _REAL_DATA_DEFAULT_CACHE
    os.makedirs(cache, exist_ok=True)
    dest = os.path.join(cache, url.rsplit("/", 1)[-1])
    if os.path.exists(dest) and os.path.getsize(dest) >= min_bytes:
        return dest
    import urllib.error
    import urllib.request

    part = dest + ".part"
    try:
        request = urllib.request.Request(
            url, headers={"User-Agent": _REAL_DATA_USER_AGENT}
        )
        with urllib.request.urlopen(request, timeout=30) as resp, open(part, "wb") as fh:
            shutil.copyfileobj(resp, fh, 4 * 1024 * 1024)
        os.replace(part, dest)
    except Exception as exc:  # noqa: BLE001 - offline is a skip, never a failure
        with contextlib.suppress(OSError):
            os.unlink(part)
        raise unittest.SkipTest(f"real-data test skipped: could not fetch {url} ({exc})")
    if os.path.getsize(dest) < min_bytes:
        os.unlink(dest)
        raise unittest.SkipTest(f"real-data test skipped: {url} looked truncated")
    return dest


class TestSampleIndexAgainstARealRateChange(unittest.TestCase):
    """#1060's acceptance criterion: `sample_index` verified to within one sample
    on a dataset that actually changes rate (nm000329, 1000 Hz -> 250 Hz).

    A recording built at the serving rate cannot check this at all -- the whole
    class of error the column exists to remove only appears when the source and
    target rates differ. Three independent checks, none of which re-uses the
    formula under test:

    1. The store's own geometry: level-0 `n_samples` is `round(n_native *
       target / native)`, i.e. the grid really is `t[n] = n / rate`.
    2. No filter delay: the served signal correlates with the NATIVE samples
       taken at the same absolute times, peaking at lag 0. `resample_poly` is
       zero-phase, and this is what proves it for the exporter we ship.
    3. The dataset's own `sample` column (onsets in native samples, written by
       whoever curated it) scaled to the serving rate.
    """

    VERSION = "v1.0.7"
    STEM = "sub-1/ses-0/eeg/sub-1_ses-0_task-imagery_acq-calibration_run-0"
    BASE = "https://data.nemar.org/nm000329"
    NATIVE_RATE = 1000.0
    SERVING_RATE = 250.0

    @classmethod
    def setUpClass(cls):
        try:
            import numpy  # noqa: F401
            import pyedflib  # noqa: F401
            import zarr  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc
        cls.recording = fetch_real_file(
            f"{cls.BASE}/{cls.VERSION}/{cls.STEM}_eeg.bdf", min_bytes=100_000_000
        )
        cls.events = fetch_real_file(f"{cls.BASE}/{cls.VERSION}/{cls.STEM}_events.tsv")
        cls._tmp = tempfile.TemporaryDirectory()
        cls.store = os.path.join(cls._tmp.name, "real.zarr")
        # The real converter entry point on the real bytes: same call
        # `convert_one` makes.
        convert_recording(cls.recording, cls.events, cls.store)
        cls.meta = store_metadata(cls.store)
        cls.group = cls.meta["groups"][0]
        with open(cls.events, encoding="utf-8") as fh:
            cls.parsed = parse_events_tsv(fh.read())
        cls.rows = event_rows_for_store(
            "sub-1/ses-0/eeg/x_eeg.zarr", f"{cls.STEM}_eeg.bdf",
            cls.meta["groups"], cls.parsed,
        )

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "_tmp"):
            cls._tmp.cleanup()

    def native_samples(self):
        """(labels, n_samples, first-channel signal) straight from the BDF."""
        import pyedflib

        reader = pyedflib.EdfReader(self.recording)
        try:
            labels = reader.getSignalLabels()
            n = int(reader.getNSamples()[0])
            return labels, n, reader
        except Exception:
            reader.close()
            raise

    def test_the_dataset_really_changes_rate(self):
        # Guard the premise: if the archive ever re-published this at 250 Hz,
        # every assertion below would pass while checking nothing.
        self.assertEqual(self.group["source_rate_hz"], self.NATIVE_RATE)
        self.assertEqual(self.group["rate"], self.SERVING_RATE)

    def test_level_zero_is_the_nominal_grid_over_the_same_span(self):
        _labels, n_native, reader = self.native_samples()
        try:
            self.assertGreater(n_native, 0)
        finally:
            reader.close()
        expected = round(n_native * self.SERVING_RATE / self.NATIVE_RATE)
        self.assertEqual(self.group["n_samples"], expected)
        # ...so sample n is at t = n / rate, which is what the formula assumes.
        self.assertAlmostEqual(
            self.group["duration_s"], n_native / self.NATIVE_RATE, places=3
        )

    def test_the_served_signal_carries_no_filter_delay(self):
        """If `resample_poly` left its FIR group delay in, every sample index
        would be off by that delay and the column would be confidently wrong.

        Compared against the NATIVE samples at the same absolute times
        (1000 -> 250 is an exact 4, so `native[::4]` is the zero-phase reference
        and no resampler is involved in the reference at all).
        """
        import numpy as np
        import zarr

        root = zarr.open_group(self.store, mode="r")
        group = root[self.group["name"]]
        label = dict(group.attrs)["channels"][0]["label"]
        served = np.asarray(group["0"][0, :], dtype=np.float64)

        labels, _n, reader = self.native_samples()
        try:
            self.assertIn(label, labels, "store channel is not a native channel")
            native = reader.readSignal(labels.index(label)).astype(np.float64)
        finally:
            reader.close()

        step = int(self.NATIVE_RATE // self.SERVING_RATE)
        reference = native[::step]
        n = min(len(served), len(reference)) - 20
        a = served[10 : 10 + n] - served[10 : 10 + n].mean()
        b = reference[10 : 10 + n] - reference[10 : 10 + n].mean()
        lags = range(-8, 9)
        scores = {
            lag: float(np.dot(a, np.roll(b, lag)) / (np.linalg.norm(a) * np.linalg.norm(b)))
            for lag in lags
        }
        best = max(scores, key=scores.get)
        self.assertGreater(
            scores[0], 0.9,
            "the served channel does not track the native one at all -- the "
            f"channel mapping is wrong, not the delay (r={scores[0]:.3f})",
        )
        self.assertEqual(
            best, 0,
            f"served level 0 lags the native grid by {best} sample(s); "
            "sample_index would be off by the same amount",
        )

    def test_every_onset_lands_on_the_grid_within_one_sample(self):
        """The acceptance criterion, checked against the grid itself rather than
        against the formula: the level-0 timestamps are `n / rate`, and the
        published index must be the nearest of them.

        Measured on this recording: 72 events, worst disagreement 1 sample, and
        every one of those is an exact TIE -- the onset sits exactly half a
        sample (0.002 s at 250 Hz) between two level-0 samples, e.g. 39.302 s ->
        9825.5. The published rule takes the later sample and `argmin` takes the
        earlier; neither is more correct, and no rule can do better than one
        sample there. On every event that is not a tie the two agree exactly,
        which is the assertion that would break if the formula drifted.
        """
        import numpy as np

        rate = self.group["rate"]
        grid = np.arange(self.group["n_samples"], dtype=np.float64) / rate
        self.assertGreater(len(self.rows["onset_s"]), 50, "fixture lost its events")
        ties = 0
        for onset, published in zip(self.rows["onset_s"], self.rows["sample_index"]):
            nearest = int(np.argmin(np.abs(grid - onset)))
            delta = abs(published - nearest)
            self.assertLessEqual(
                delta, 1, f"onset {onset} published {published}, grid says {nearest}"
            )
            if delta == 0:
                continue
            ties += 1
            # The only licensed disagreement: equidistant from both samples.
            self.assertAlmostEqual(
                abs(grid[published] - onset), abs(grid[nearest] - onset), places=9,
                msg=f"onset {onset} is off by a sample and is NOT a tie",
            )
        # The fixture has to contain some, or the tie branch above is untested
        # and this test is weaker than it reads.
        self.assertGreater(ties, 0)

    def test_the_datasets_own_native_sample_column_agrees(self):
        """nm000329's events.tsv carries a `sample` column in NATIVE samples,
        written by whoever curated the dataset. It is the one ground truth here
        that owes nothing to this converter -- and it agrees to within one
        sample, disagreeing only on the same ties (a native sample number
        divided by 4 lands on x.5 for exactly those events)."""
        self.assertIn("sample", self.rows, "fixture lost its `sample` column")
        ratio = self.SERVING_RATE / self.NATIVE_RATE
        for native, published in zip(self.rows["sample"], self.rows["sample_index"]):
            scaled = int(native) * ratio
            self.assertLessEqual(
                abs(published - round(scaled)), 1,
                f"curated sample {native} -> {scaled}, published {published}",
            )
            if published != round(scaled):
                self.assertAlmostEqual(scaled % 1, 0.5, places=9)


class TestSampleIndexOnANonIntegerRateRatio(unittest.TestCase):
    """512 Hz -> 250 Hz: the ratio is 125/256, so there is no whole-sample
    relationship between the source and serving grids at all.

    Synthetic on purpose, and the comment matters: nm000329 (the real-data check
    above) is an exact 4, so it CANNOT distinguish a formula that quietly assumes
    an integer decimation from one that does not. Nothing in the archive was
    handy at a fractional ratio, so this fixture is the only thing standing
    between that assumption and a silently mis-aligned file. The recording is a
    real EDF written by pyedflib and converted by the real exporter -- only the
    samples are synthetic.
    """

    RATE = 512
    SERVING_RATE = 250.0
    SECONDS = 20
    ONSETS = [0.0, 0.001, 1.003, 7.777, 12.5, 19.999]

    @classmethod
    def setUpClass(cls):
        try:
            import numpy  # noqa: F401
            import pyedflib  # noqa: F401
            import zarr  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc
        cls._tmp = tempfile.TemporaryDirectory()
        d = cls._tmp.name
        cls.recording = build_real_edf(
            d, "sub-01_task-x_eeg", n_channels=3, rate=cls.RATE, seconds=cls.SECONDS
        )
        cls.events = os.path.join(d, "sub-01_task-x_events.tsv")
        with open(cls.events, "w") as fh:
            fh.writelines(
                ["onset\tduration\ttrial_type\n"]
                + [f"{onset}\t0.1\tgo\n" for onset in cls.ONSETS]
            )
        cls.store = os.path.join(d, "out.zarr")
        convert_recording(cls.recording, cls.events, cls.store)
        cls.meta = store_metadata(cls.store)
        cls.group = cls.meta["groups"][0]
        with open(cls.events) as fh:
            cls.rows = event_rows_for_store(
                "sub-01/eeg/x_eeg.zarr", "sub-01/eeg/sub-01_task-x_eeg.edf",
                cls.meta["groups"], parse_events_tsv(fh.read()),
            )

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_the_ratio_really_is_fractional(self):
        self.assertEqual(self.group["source_rate_hz"], float(self.RATE))
        self.assertEqual(self.group["rate"], self.SERVING_RATE)
        self.assertNotEqual((self.RATE / self.SERVING_RATE) % 1, 0.0)

    def test_level_zero_length_follows_the_rate_ratio(self):
        n_native = self.RATE * self.SECONDS
        self.assertEqual(
            self.group["n_samples"], round(n_native * self.SERVING_RATE / self.RATE)
        )

    def test_every_onset_lands_on_the_grid_within_one_sample(self):
        import numpy as np

        grid = np.arange(self.group["n_samples"], dtype=np.float64) / self.group["rate"]
        for onset, published in zip(self.rows["onset_s"], self.rows["sample_index"]):
            nearest = int(np.argmin(np.abs(grid - onset)))
            self.assertLessEqual(
                abs(published - nearest), 1,
                f"onset {onset} published as {published}, grid says {nearest}",
            )

    def test_the_acquisition_rate_is_the_wrong_rate_to_index_with(self):
        """The error the column exists to remove. A client reading the BIDS
        sidecar sees 512 Hz and computes `onset * 512`; level 0 is 250 Hz, so
        that index is roughly twice as far along the array as the event -- and
        for most of this recording it is off the end of it entirely. The index
        publishes the SERVING rate per group precisely so that guess is never
        needed."""
        n_samples = self.group["n_samples"]
        wrong = [round(onset * self.RATE) for onset in self.ONSETS]
        published = list(self.rows["sample_index"])
        self.assertNotEqual(wrong, published)
        # ...and it is not a rounding-scale disagreement, it is a different array
        # position: the last onset indexes past the end of level 0.
        self.assertGreater(wrong[-1], n_samples)
        self.assertLessEqual(published[-1], n_samples)

    def test_deriving_the_index_from_the_native_sample_number_disagrees(self):
        """The sub-sample error #1060 names. A client that rounds the onset to a
        NATIVE sample first and scales that -- what the BIDS `sample` column
        invites -- rounds twice, and on a fractional ratio the two roundings
        disagree wherever the true position sits within a quarter sample of a
        tie. It is bounded by one sample, which is exactly why nobody notices it
        without a column to compare against."""
        ratio = self.SERVING_RATE / self.RATE
        onset = 0.086  # 21.5 level-0 samples: the tie band
        published = sample_index_for(onset, self.SERVING_RATE)
        two_step = round(round(onset * self.RATE) * ratio)
        self.assertEqual(published, 22)
        self.assertEqual(two_step, 21)


class TestSourceTree(unittest.TestCase):
    def test_raw_is_the_default(self):
        self.assertEqual(source_tree_for("sub-01/eeg/sub-01_task-x_eeg.set"), "raw")

    def test_names_the_excluded_tree_it_sits_under(self):
        self.assertEqual(
            source_tree_for("derivatives/prep/sub-01/eeg/sub-01_eeg.set"), "derivatives"
        )
        self.assertEqual(source_tree_for("sourcedata/sub-01/eeg/x_eeg.set"), "sourcedata")
        self.assertEqual(source_tree_for("code/x_eeg.set"), "code")

    def test_segment_boundary_is_respected(self):
        # `mycode/` and `derivatives_old/` are ordinary directories, matching
        # in_excluded_tree's own rule.
        self.assertEqual(source_tree_for("mycode/sub-01_eeg.set"), "raw")
        self.assertEqual(source_tree_for("derivatives_old/sub-01_eeg.set"), "raw")


class TestFailureDetail(unittest.TestCase):
    """`detail` is the field that makes an opaque `file_read_error` diagnosable
    from the published index (#1197). It must name the exception and keep the
    message while dropping the conversion node's scratch paths, which are a fresh
    mkdtemp name every run."""

    def test_names_the_exception_class_and_first_line(self):
        detail = failure_detail(ValueError("could not find measurement data\nsecond line"))
        self.assertEqual(detail, "ValueError: could not find measurement data")

    def test_strips_absolute_paths(self):
        exc = OSError(
            "/mnt/local/zarr-scratch/tmpab12/work/sub-01_eeg.edf: the file is not "
            "EDF(+) or BDF(+) compliant the label is incorrect"
        )
        detail = failure_detail(exc)
        self.assertNotIn("/mnt/local", detail)
        self.assertIn("<path>", detail)
        # The diagnosis itself survives -- that is the whole point of the field.
        self.assertIn("not EDF(+) or BDF(+) compliant", detail)

    def test_leaves_non_path_slashes_alone(self):
        self.assertEqual(strip_local_paths("min/max envelope"), "min/max envelope")

    def test_accepts_a_bare_string_for_a_synthesized_failure(self):
        # A worker killed while running alone has no exception to report.
        self.assertEqual(failure_detail("killed its worker process"),
                         "killed its worker process")

    def test_length_capped(self):
        self.assertLessEqual(len(failure_detail(ValueError("x" * 5000))), 300)

    def test_strips_windows_paths(self):
        # MNE formats paths out of a recording's own header, so a Windows path
        # can reach a Linux conversion node's error message.
        detail = failure_detail(
            OSError(r"C:\Users\hallu\scratch\sub-01_eeg.edf is not EDF(+) compliant")
        )
        self.assertNotIn("Users", detail)
        self.assertIn("<path>", detail)
        self.assertIn("not EDF(+) compliant", detail)


class TestDetailRedaction(unittest.TestCase):
    """`detail` and `last_error` are published in index.json on a PUBLIC bucket,
    and the driver shells out to `aws` and reads HTTP -- so an exception message
    can quote a presigned URL, a request header, or a key id. Path stripping does
    not cover any of that; none of them is a filesystem path.

    Each case is a real message shape (AWS error text, a curl failure), and each
    asserts BOTH halves: the secret is gone and the diagnosis survives. A
    redactor that returned a constant would pass the first half alone.
    """

    def assert_redacted(self, message: str, secret: str, keep: str = ""):
        detail = failure_detail(RuntimeError(message))
        self.assertNotIn(secret, detail, f"secret survived in {detail!r}")
        self.assertIn("[redacted]", detail)
        if keep:
            self.assertIn(keep, detail, f"diagnosis lost from {detail!r}")

    def test_authorization_header(self):
        self.assert_redacted(
            "PUT failed with Authorization: AWS4-HMAC-SHA256 SignedHeaders=host",
            "AWS4-HMAC-SHA256",
            keep="PUT failed",
        )

    def test_bearer_token(self):
        self.assert_redacted(
            "callback rejected: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
            "eyJhbGciOiJIUzI1NiJ9",
            keep="callback rejected",
        )

    def test_x_amz_query_parameters(self):
        # A presigned URL is the realistic leak: `aws s3 cp` quotes the whole
        # request line on a 403.
        self.assert_redacted(
            "403 for https://nemar.s3.us-east-2.amazonaws.com/k?X-Amz-Signature=deadbeefcafe0123",
            "deadbeefcafe0123",
            keep="403",
        )

    def test_x_amz_credential_is_covered_by_the_prefix_rule(self):
        self.assert_redacted(
            "denied: https://h/k?X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260902",
            "AKIAIOSFODNN7EXAMPLE",
            keep="denied",
        )

    def test_signature_field(self):
        self.assert_redacted(
            "SignatureDoesNotMatch signature: abc123def456+/=",
            "abc123def456",
            keep="SignatureDoesNotMatch",
        )

    def test_bare_access_key_id(self):
        # AWS error text quotes the key id with no URL around it.
        self.assert_redacted(
            "The AWS Access Key Id AKIAIOSFODNN7EXAMPLE does not exist in our records",
            "AKIAIOSFODNN7EXAMPLE",
            keep="does not exist in our records",
        )

    def test_sts_session_key_id(self):
        # ASIA is the form the Hallu profile's session credentials actually take.
        self.assert_redacted(
            "expired token for ASIAY34FZKBOKMUTVV7A",
            "ASIAY34FZKBOKMUTVV7A",
            keep="expired token",
        )

    def test_token_query_parameter(self):
        self.assert_redacted(
            "POST https://api.nemar.org/webhooks/zarr-ready?token=s3cr3tvalue -> 401",
            "s3cr3tvalue",
            keep="401",
        )

    def test_key_query_parameter(self):
        self.assert_redacted("GET https://h/p?key=abc123secret", "abc123secret")

    def test_a_url_shaped_message_keeps_its_diagnosis(self):
        # #1197's whole point: an operator must still be able to tell WHAT failed.
        detail = failure_detail(
            RuntimeError("HTTP 503 from https://nemar.s3.us-east-2.amazonaws.com/a/b.edf")
        )
        self.assertIn("HTTP 503", detail)

    def test_an_innocent_message_is_left_alone(self):
        """A redactor that fired on ordinary text would destroy every diagnosis.

        The false-positive risk is real and specific here: BIDS filenames and
        column names routinely contain the very words the patterns key on, and
        the words alone must never be enough -- only the `?name=value` and
        `Header: value` SHAPES are. A redactor that ate `primary_key.csv` would
        make a corrupt-file report unreadable while leaking nothing.
        """
        for clean in (
            "Could not find measurement data",
            "channels.tsv declares 74 channels but the store has 1",
            "min/max envelope mismatch",
            # "token"/"key" inside BIDS entities and filenames.
            "sub-01_task-tokenTask_eeg.edf is not EDF(+) compliant",
            "sub-02_task-keypress_run-1_eeg.vhdr: header missing",
            "primary_key.csv could not be parsed",
            "no key column found in participants.tsv",
            "token count mismatch in the events sidecar",
            # A bare `key=` with no query string around it is a log field, not a
            # secret -- the patterns require the `?`/`&` that makes it a URL.
            "reader reported key=value for channel E1",
            # And the words as ordinary prose.
            "the signature of read_raw_edf changed upstream",
            "authorization to publish this dataset is pending",
        ):
            with self.subTest(message=clean):
                self.assertEqual(redact_secrets(clean), clean)
                self.assertNotIn("[redacted]", failure_detail(RuntimeError(clean)))

    def test_redaction_survives_the_length_cap(self):
        # Cap applied AFTER redaction, so truncation can never expose a tail.
        detail = failure_detail(
            RuntimeError("x" * 250 + " Bearer supersecrettokenvalue0123456789")
        )
        self.assertNotIn("supersecrettokenvalue", detail)
        self.assertLessEqual(len(detail), 300)

    def test_empty_is_none(self):
        self.assertIsNone(failure_detail(None))


class TestEventsSummary(unittest.TestCase):
    """`n_events` / `trial_types` let a client judge a dataset, and pick an
    epoching strategy, without reading a signal byte (#1059)."""

    def test_counts_rows_and_trial_types(self):
        text = (
            "onset\tduration\ttrial_type\n"
            "0.0\t0.5\tgo\n"
            "1.0\t0.5\tstop\n"
            "2.0\t0.5\tgo\n"
        )
        self.assertEqual(
            events_summary(text), {"n_events": 3, "trial_types": {"go": 2, "stop": 1}}
        )

    def test_no_events_file_omits_both_keys(self):
        # Absent keys mean "no events.tsv", which is not the same claim as
        # "an events.tsv with no trial types".
        self.assertEqual(events_summary(None), {})

    def test_no_trial_type_column_is_an_empty_object(self):
        self.assertEqual(
            events_summary("onset\tduration\n0.0\t0.5\n"),
            {"n_events": 1, "trial_types": {}},
        )

    def test_na_values_are_not_counted(self):
        text = "onset\ttrial_type\n0.0\tn/a\n1.0\t\n2.0\tgo\n"
        self.assertEqual(events_summary(text)["trial_types"], {"go": 1})
        self.assertEqual(events_summary(text)["n_events"], 3)

    def test_the_summary_and_the_rows_come_from_one_parse(self):
        """#1060's last acceptance criterion. `n_events` in index.json and the
        rows in events.parquet describe the same file, so they must not be able
        to disagree: both are computed from a single `parse_events_tsv`."""
        text = "onset\tduration\ttrial_type\n0.0\t0.5\tgo\n1.0\t0.5\tstop\n"
        parsed = parse_events_tsv(text)
        summary = events_summary_of(parsed)
        rows = event_rows_for_store(
            "sub-01/eeg/a_eeg.zarr", "sub-01/eeg/sub-01_task-x_eeg.edf",
            [{"name": "eeg_250hz", "rate": 250.0}], parsed,
        )
        self.assertEqual(summary, events_summary(text))
        # One group, so one row per event: the counts are the same number
        # arrived at two ways.
        self.assertEqual(len(rows["onset_s"]), summary["n_events"])


class TestEventsParse(unittest.TestCase):
    """The shared parse behind both the index summary and events.parquet."""

    def test_a_utf8_bom_does_not_eat_the_onset_column(self):
        """A spreadsheet-exported events.tsv starts with U+FEFF, so the first
        header cell reads `﻿onset` -- every onset would be unparseable and
        every sample_index null. nm000329 (the dataset #1060 names for the
        one-sample check) ships exactly this file."""
        parsed = parse_events_tsv("﻿onset\tduration\n1.5\t0.5\n")
        self.assertEqual(parsed["columns"], ["onset", "duration"])
        rows = event_rows_for_store(
            "a.zarr", "sub-01/eeg/sub-01_task-x_eeg.edf",
            [{"name": "eeg_250hz", "rate": 250.0}], parsed,
        )
        self.assertEqual(rows["onset_s"], [1.5])
        self.assertEqual(rows["sample_index"], [375])

    def test_no_file_and_an_empty_file_are_different(self):
        self.assertIsNone(parse_events_tsv(None))
        self.assertEqual(parse_events_tsv(""), {"columns": [], "rows": []})
        self.assertEqual(events_summary_of(parse_events_tsv("")),
                         {"n_events": 0, "trial_types": {}})

    def test_blank_lines_are_not_events(self):
        parsed = parse_events_tsv("onset\n0.0\n\n1.0\n\n")
        self.assertEqual(len(parsed["rows"]), 2)


class TestSampleIndexFormula(unittest.TestCase):
    """`sample_index` is the reason the file exists (#1060): the converter knows
    the exact resampling relation and every client re-deriving it gets a
    sub-sample offset wrong wherever the ratio is not an integer."""

    def test_it_is_the_onset_on_the_level_zero_grid(self):
        self.assertEqual(sample_index_for(0.0, 250.0), 0)
        self.assertEqual(sample_index_for(4.057, 250.0), 1014)
        self.assertEqual(sample_index_for(10.0, 250.0), 2500)

    def test_ties_round_up(self):
        # 1014.5 -> 1015, not banker's 1014. One rule, stated, so a client that
        # wants to reproduce it can.
        self.assertEqual(sample_index_for(4.058, 250.0), 1015)
        self.assertEqual(sample_index_for(0.002, 250.0), 1)

    def test_a_non_integer_rate_ratio_lands_on_the_grid(self):
        """The case the issue is about: 512 Hz capped to 250 Hz is 125/256, so
        `round(onset * source_rate) / 4`-style reasoning is wrong. Checked
        against the grid itself -- the times level 0 actually has, built from
        the rate rather than from the formula under test."""
        rate = 250.0
        n_samples = 512 * 60 * 125 // 256  # what the exporter writes for 60 s
        grid = [n / rate for n in range(n_samples)]
        for onset in (0.0, 0.001, 1.0 / 512, 7.13, 33.3333, 59.9):
            nearest = min(range(len(grid)), key=lambda i: abs(grid[i] - onset))
            self.assertLessEqual(
                abs(sample_index_for(onset, rate) - nearest), 1,
                f"onset {onset} is more than a sample off the level-0 grid",
            )

    def test_it_is_not_clamped_to_the_recording(self):
        # An onset past the end is a property of the data. Clamping would be
        # indistinguishable from an event on the last sample.
        self.assertEqual(sample_index_for(10_000.0, 250.0), 2_500_000)

    def test_unknowables_are_null_not_zero(self):
        for onset, rate in ((None, 250.0), (1.0, None), (1.0, 0), (1.0, -250.0),
                            (float("nan"), 250.0), (float("inf"), 250.0)):
            self.assertIsNone(sample_index_for(onset, rate), (onset, rate))


class TestEventRowBuilder(unittest.TestCase):
    """The rows of `<id>/zarr/events.parquet`, per store (#1060)."""

    PATH = "sub-01/ses-02/eeg/sub-01_ses-02_task-rest_run-3_eeg.edf"
    ZARR = "sub-01/ses-02/eeg/sub-01_ses-02_task-rest_run-3_eeg.zarr"
    TEXT = (
        "onset\tduration\ttrial_type\tvalue\tHED\tresponse_time\n"
        "1.0\t0.5\tgo\t2\t(Def/Go)\t0.31\n"
        "0.0\t0.25\tstop\tn/a\t\t\n"
    )

    UNSET = object()

    def rows(self, text=UNSET, groups=None, path=None):
        return event_rows_for_store(
            self.ZARR, path or self.PATH,
            [{"name": "eeg_250hz", "rate": 250.0}] if groups is None else groups,
            parse_events_tsv(self.TEXT if text is self.UNSET else text),
        )

    def test_the_fixed_columns_come_first_and_in_order(self):
        rows = self.rows()
        self.assertEqual(list(rows)[: len(EVENTS_FIXED_COLUMNS)], list(EVENTS_FIXED_COLUMNS))

    def test_entities_come_from_the_recording_path(self):
        rows = self.rows()
        self.assertEqual(set(rows["subject"]), {"01"})
        self.assertEqual(set(rows["session"]), {"02"})
        self.assertEqual(set(rows["task"]), {"rest"})
        self.assertEqual(set(rows["run"]), {"3"})
        self.assertEqual(set(rows["store_path"]), {self.ZARR})

    def test_session_and_run_are_null_when_the_dataset_has_neither(self):
        rows = self.rows(path="sub-01/eeg/sub-01_task-rest_eeg.edf")
        self.assertEqual(rows["session"], [None, None])
        self.assertEqual(rows["run"], [None, None])
        self.assertEqual(set(rows["subject"]), {"01"})

    def test_rows_are_ordered_by_onset(self):
        # The file's own order is onset 1.0 then 0.0; published order is sorted,
        # which is what makes `store_path, onset_s` true of the whole file
        # without a global sort at write time.
        self.assertEqual(self.rows()["onset_s"], [0.0, 1.0])
        self.assertEqual(self.rows()["trial_type"], ["stop", "go"])

    def test_na_and_blank_cells_are_null(self):
        rows = self.rows()
        self.assertEqual(rows["value"], [None, "2"])  # `n/a` on the stop row
        self.assertEqual(rows["hed"], [None, "(Def/Go)"])
        self.assertEqual(rows["response_time"], [None, "0.31"])

    def test_the_hed_column_is_matched_case_insensitively(self):
        # BIDS spells it `HED`; datasets in the archive use both cases, and a
        # case-sensitive match would silently pass it through as an extra column
        # instead of filling the declared `hed` one.
        self.assertEqual(self.rows(text="onset\thed\n0.0\tX\n")["hed"], ["X"])
        self.assertEqual(self.rows(text="onset\tHED\n0.0\tX\n")["hed"], ["X"])

    def test_remaining_columns_pass_through_under_their_own_names(self):
        rows = self.rows()
        self.assertIn("response_time", rows)
        self.assertNotIn("x_response_time", rows)

    def test_a_column_named_like_a_fixed_one_is_prefixed(self):
        rows = self.rows(text="onset\tsample_index\tsubject\n0.0\t7\tzz\n")
        self.assertEqual(rows["x_sample_index"], ["7"])
        self.assertEqual(rows["x_subject"], ["zz"])
        # ...and the real columns keep their meaning.
        self.assertEqual(rows["sample_index"], [0])
        self.assertEqual(rows["subject"], ["01"])

    def test_a_duplicated_header_keeps_both_columns(self):
        # Malformed input, but dropping the second column's values silently is
        # the worse answer.
        rows = self.rows(text="onset\tstim\tstim\n0.0\ta\tb\n")
        self.assertEqual(rows["stim"], ["a"])
        self.assertEqual(rows["x_stim"], ["b"])

    def test_one_row_per_event_and_group(self):
        """A store's groups are concurrent streams at different rates, so one
        onset has a different sample index in each -- and `group_name` is what
        tells the rows apart. No dataset in the catalog has a multi-group store
        today, so this fixture is the only thing standing between the rule and a
        silently single-rate file."""
        rows = self.rows(groups=[
            {"name": "eeg_250hz", "rate": 250.0},
            {"name": "misc_50hz", "rate": 50.0},
        ])
        self.assertEqual(len(rows["onset_s"]), 4)
        self.assertEqual(rows["group_name"], ["eeg_250hz", "misc_50hz"] * 2)
        self.assertEqual(rows["onset_s"], [0.0, 0.0, 1.0, 1.0])
        self.assertEqual(rows["sample_index"], [0, 0, 250, 50])

    def test_a_group_with_no_rate_yields_a_null_index_not_a_dropped_row(self):
        rows = self.rows(groups=[{"name": "eeg_250hz", "rate": None}])
        self.assertEqual(rows["sample_index"], [None, None])
        self.assertEqual(rows["onset_s"], [0.0, 1.0])

    def test_a_malformed_onset_keeps_the_row(self):
        rows = self.rows(text="onset\ttrial_type\nn/a\tgo\n1.0\tstop\n")
        # Unparseable onsets sort last, and say so with nulls rather than
        # vanishing -- an event was declared, its position is unknown.
        self.assertEqual(rows["onset_s"], [1.0, None])
        self.assertEqual(rows["sample_index"], [250, None])
        self.assertEqual(rows["trial_type"], ["stop", "go"])

    def test_nothing_to_publish_returns_none(self):
        self.assertIsNone(self.rows(text=None))          # no events.tsv
        self.assertIsNone(self.rows(text="onset\n"))     # header only
        self.assertIsNone(self.rows(groups=[]))          # store with no groups

    def test_duplicate_onsets_keep_both_rows_in_file_order(self):
        """Two events at the same instant are two events -- a simultaneous
        stimulus and response, or two annotation streams merged into one file.
        The sort is stable, so their file order survives; de-duplicating or
        reordering them would silently drop or re-pair a client's trials."""
        rows = self.rows(
            text="onset\tduration\ttrial_type\n1.5\t0.1\tfirst\n1.5\t0.2\tsecond\n"
        )
        self.assertEqual(rows["onset_s"], [1.5, 1.5])
        self.assertEqual(rows["trial_type"], ["first", "second"])
        self.assertEqual(rows["duration_s"], [0.1, 0.2])
        self.assertEqual(rows["sample_index"], [375, 375])


class TestEventsRowAlert(unittest.TestCase):
    """The two conditions that leave a client with events it cannot use, and
    which the parquet cannot show on its own: a store that contributes no rows
    at all, and rows whose sample index is null throughout."""

    PARSED = parse_events_tsv("onset\ttrial_type\n0.0\tgo\n1.0\tstop\n")
    PRIMARY = "sub-01/eeg/sub-01_task-x_eeg.edf"

    def build(self, groups):
        return event_rows_for_store("a.zarr", self.PRIMARY, groups, self.PARSED)

    def test_a_healthy_store_is_silent(self):
        rows = self.build([{"name": "eeg_250hz", "rate": 250.0}])
        self.assertIsNone(events_row_alert(self.PRIMARY, self.PARSED, rows))

    def test_events_but_no_channel_groups_is_named(self):
        """Unreachable through `main` -- `convert_one` refuses to publish a
        store with no channel groups -- so this is the only place the branch can
        be exercised at all. It stays because the alternative is a store that
        silently vanishes from events.parquet if that guard ever changes."""
        alert = events_row_alert(self.PRIMARY, self.PARSED, self.build([]))
        self.assertIsNotNone(alert)
        self.assertIn("::warning::", alert)
        self.assertIn(self.PRIMARY, alert)
        self.assertIn("no channel groups", alert)
        self.assertIn("2 event(s)", alert)

    def test_no_events_at_all_is_silent(self):
        # No events.tsv, or an empty one: not a defect, and not worth a line in
        # a log where most datasets would print it.
        self.assertIsNone(events_row_alert(self.PRIMARY, None, None))
        self.assertIsNone(events_row_alert(self.PRIMARY, parse_events_tsv("onset\n"), None))

    def test_every_sample_index_null_is_named(self):
        rows = self.build([{"name": "eeg_250hz", "rate": None}])
        alert = events_row_alert(self.PRIMARY, self.PARSED, rows)
        self.assertIn("no usable sample index", alert)
        self.assertIn("2 row(s)", alert)

    def test_one_usable_index_is_enough_to_stay_silent(self):
        parsed = parse_events_tsv("onset\ttrial_type\nn/a\tgo\n1.0\tstop\n")
        rows = event_rows_for_store(
            "a.zarr", self.PRIMARY, [{"name": "eeg_250hz", "rate": 250.0}], parsed
        )
        self.assertIsNone(events_row_alert(self.PRIMARY, parsed, rows))


class TestEventsParquetFile(unittest.TestCase):
    """The file itself: schema, order, and the bounded-memory write path.

    `pyarrow` is a real dependency here (scripts/zarr/requirements.txt, and the
    zarr-python-test CI job installs it) rather than an optional one, for the
    same reason `jsonschema` is: without it these tests do not fail, they ERROR
    on import, and the converter's own degradation path makes a missing writer
    look like a dataset with no events.
    """

    def test_pyarrow_is_installed_so_this_class_can_fail(self):
        import pyarrow  # noqa: F401 - presence IS the assertion

    def build(self, n_stores=3, n_events=2, rate=250.0, extra=None, first=0):
        staging = EventsStaging()
        rels = []
        for s in range(first, first + n_stores):
            rel = f"sub-{s:03d}/eeg/sub-{s:03d}_task-x_eeg.zarr"
            text = "onset\tduration\ttrial_type" + (f"\t{extra}" if extra else "") + "\n"
            for i in range(n_events):
                text += f"{i * 2.0}\t0.5\tgo" + (f"\t{i}" if extra else "") + "\n"
            rows = event_rows_for_store(
                rel, f"sub-{s:03d}/eeg/sub-{s:03d}_task-x_eeg.edf",
                [{"name": "eeg_250hz", "rate": rate}], parse_events_tsv(text),
            )
            staging.add(rel, rows)
            rels.append(rel)
        return staging, rels

    def write(self, staging, rels, prior=None):
        out = os.path.join(tempfile.mkdtemp(), "events.parquet")
        rows = write_events_parquet(out, rels, staging, prior)
        return out, rows

    def test_the_published_types_are_the_declared_ones(self):
        import pyarrow as pa
        import pyarrow.parquet as pq

        staging, rels = self.build()
        out, rows = self.write(staging, rels)
        self.assertEqual(rows, 6)
        table = pq.read_table(out)
        self.assertEqual(table.num_rows, 6)
        label = pa.dictionary(pa.int32(), pa.string())
        # Dictionary-encoded on the way out AND on the way back: a client reads
        # categoricals, not 25k copies of the same store path (#1060).
        for name in ("store_path", "subject", "task", "group_name", "trial_type"):
            self.assertEqual(table.schema.field(name).type, label, name)
        self.assertEqual(table.schema.field("onset_s").type, pa.float64())
        self.assertEqual(table.schema.field("duration_s").type, pa.float32())
        self.assertEqual(table.schema.field("sample_index").type, pa.int64())

    def test_two_hundred_stores_write_one_file_without_holding_them(self):
        """The shape that made this a streaming writer: nm000281 has ~25k stores,
        and one pandas frame for the dataset is not an option (#1060). With the
        row-group cap lowered, a build that buffered everything would produce ONE
        row group; the flush is what makes it many."""
        import pyarrow.parquet as pq

        staging, rels = self.build(n_stores=200, n_events=5)
        self.assertEqual(len(staging), 200)
        self.assertEqual(staging.row_count, 1000)
        saved = generate_zarr.EVENTS_ROW_GROUP_ROWS
        try:
            generate_zarr.EVENTS_ROW_GROUP_ROWS = 100
            out, rows = self.write(staging, rels)
        finally:
            generate_zarr.EVENTS_ROW_GROUP_ROWS = saved
        self.assertEqual(rows, 1000)
        pf = pq.ParquetFile(out)
        self.assertEqual(pf.metadata.num_rows, 1000)
        self.assertEqual(pf.num_row_groups, 10)

    def test_rows_are_ordered_by_store_then_onset(self):
        import pyarrow.parquet as pq

        staging, rels = self.build(n_stores=3, n_events=3)
        # Stores are emitted in the order given (in production the index's, i.e.
        # sorted by `zarr`) whatever order the pool finished them in -- so the
        # published order is a property of the caller's list, not of arrival.
        # Reversed here precisely so "sorted by accident" cannot pass.
        asked = sorted(rels, reverse=True)
        out, _ = self.write(staging, asked)
        table = pq.read_table(out)
        stores = table["store_path"].to_pylist()
        onsets = table["onset_s"].to_pylist()
        self.assertEqual(stores, [rel for rel in asked for _ in range(3)])
        # ...and onsets ascend within each store.
        self.assertEqual(onsets, [0.0, 2.0, 4.0] * 3)

    def test_a_column_only_some_stores_have_is_null_for_the_others(self):
        import pyarrow.parquet as pq

        with_extra, rels_a = self.build(n_stores=1, extra="stim_file")
        without, rels_b = self.build(n_stores=1)
        # Same store id in both fixtures; rename so they are distinct stores.
        rel_b = "sub-999/eeg/sub-999_task-x_eeg.zarr"
        rows = without.get(rels_b[0])
        rows["store_path"] = [rel_b] * len(rows["store_path"])
        with_extra.add(rel_b, rows)
        out, total = self.write(with_extra, sorted([*rels_a, rel_b]))
        table = pq.read_table(out).to_pydict()
        self.assertEqual(total, 4)
        self.assertIn("stim_file", table)
        by_store = dict(zip(table["store_path"], table["stim_file"]))
        self.assertIsNone(by_store[rel_b])
        self.assertIsNotNone(by_store[rels_a[0]])

    def test_a_store_not_converted_this_run_keeps_its_prior_rows(self):
        """The incremental path: an unchanged store carries its rows forward from
        the published file exactly as its entry carries forward in the index. It
        is not reconverted, so this is the only place its events exist."""
        import pyarrow.parquet as pq

        first, rels = self.build(n_stores=3, n_events=2)
        prior_path, _ = self.write(first, rels)

        # Second run: only the middle store reconverted, with different events.
        second = EventsStaging()
        changed = rels[1]
        second.add(changed, event_rows_for_store(
            changed, "sub-001/eeg/sub-001_task-x_eeg.edf",
            [{"name": "eeg_250hz", "rate": 250.0}],
            parse_events_tsv("onset\ttrial_type\n9.0\tnew\n"),
        ))
        out, total = self.write(second, rels, PriorEventRows(prior_path))
        self.assertEqual(total, 5)  # 2 carried + 1 fresh + 2 carried
        table = pq.read_table(out).to_pydict()
        rows_for = {}
        for rel, onset, trial in zip(
            table["store_path"], table["onset_s"], table["trial_type"]
        ):
            rows_for.setdefault(rel, []).append((onset, trial))
        self.assertEqual(rows_for[rels[0]], [(0.0, "go"), (2.0, "go")])
        self.assertEqual(rows_for[changed], [(9.0, "new")])
        self.assertEqual(rows_for[rels[2]], [(0.0, "go"), (2.0, "go")])

    def test_a_reconverted_store_never_inherits_prior_rows(self):
        """`reconverted` is not `staged`: a store rebuilt this run that produced
        no rows (its events.tsv was deleted or emptied) must publish none, not
        fall through to the prior file and resurrect the old ones."""
        import pyarrow.parquet as pq

        first, rels = self.build(n_stores=2, n_events=2)
        prior_path, _ = self.write(first, rels)

        # Second run rebuilt BOTH stores; only one still has events.
        second = EventsStaging()
        second.add(rels[0], event_rows_for_store(
            rels[0], "sub-000/eeg/sub-000_task-x_eeg.edf",
            [{"name": "eeg_250hz", "rate": 250.0}],
            parse_events_tsv("onset\ttrial_type\n4.0\tkept\n"),
        ))
        out = os.path.join(tempfile.mkdtemp(), "events.parquet")
        total = write_events_parquet(
            out, rels, second, PriorEventRows(prior_path), set(rels)
        )
        self.assertEqual(total, 1)
        table = pq.read_table(out).to_pydict()
        self.assertEqual(table["store_path"], [rels[0]])
        self.assertEqual(table["trial_type"], ["kept"])
        # Without the `reconverted` argument the same call carries them forward,
        # which is what an unchanged (untouched) store needs.
        carried = write_events_parquet(
            os.path.join(tempfile.mkdtemp(), "events.parquet"),
            rels, second, PriorEventRows(prior_path),
        )
        self.assertEqual(carried, 3)

    def test_a_store_dropped_from_the_index_loses_its_rows(self):
        # The rel list is the index's store list, so a removed recording's rows
        # are simply not carried: the two documents cannot disagree about which
        # stores exist.
        import pyarrow.parquet as pq

        first, rels = self.build(n_stores=3, n_events=1)
        prior_path, _ = self.write(first, rels)
        out, total = self.write(EventsStaging(), rels[:2], PriorEventRows(prior_path))
        self.assertEqual(total, 2)
        self.assertNotIn(rels[2], set(pq.read_table(out)["store_path"].to_pylist()))

    def test_a_prior_file_without_a_later_column_conforms(self):
        import pyarrow as pa
        import pyarrow.parquet as pq

        first, rels = self.build(n_stores=1, n_events=1)
        prior_path, _ = self.write(first, rels)
        prior = PriorEventRows(prior_path)
        schema = events_schema(pa, {"stim_file"})
        table = prior.table_for(rels[0], schema)
        self.assertEqual(table.schema, schema)
        self.assertEqual(table["stim_file"].to_pylist(), [None])
        # And through the writer, alongside a fresh store that HAS the column.
        fresh, rels_b = self.build(n_stores=1, n_events=2, extra="stim_file", first=1)
        out, total = self.write(fresh, sorted([*rels, *rels_b]), prior)
        self.assertEqual(total, 3)
        self.assertIn("stim_file", pq.read_table(out).column_names)

    def test_conform_fills_a_missing_column_with_nulls(self):
        import pyarrow as pa

        schema = events_schema(pa, {"a", "b"})
        table = pa.Table.from_arrays(
            [pa.array(["x"], type=pa.dictionary(pa.int32(), pa.string()))],
            names=["store_path"],
        )
        conformed = conform_events_table(pa, table, schema)
        self.assertEqual(conformed.schema, schema)
        self.assertEqual(conformed["b"].to_pylist(), [None])


class TestDatasetProvenanceAttrs(unittest.TestCase):
    """The structured `nemar` root attribute (#1064). Prose provenance is useless
    to the machines that are increasingly what reads these stores."""

    ROW = {
        "name": "Resting state EEG",
        "authors": "Doe J, Roe R",
        "concept_doi": "10.82901/nemar.on007763",
        "license": "CC0",
        "hed_version": "8.2.0",
        "latest_version": "v1.0.2",
        "created_at": "2024-05-01T00:00:00Z",
    }

    def attrs(self, row):
        return nemar_store_attrs(
            dataset_id="on007763",
            source_commit="a" * 40,
            source_tree="raw",
            derived=False,
            engine_version="2",
            contract_url="https://zarr.nemar.org/on007763/zarr/sub-01/eeg/x_eeg.zarr/",
            row=row,
        )

    def test_carries_the_catalog_fields(self):
        a = self.attrs(self.ROW)
        self.assertEqual(a["doi"], "10.82901/nemar.on007763")
        self.assertEqual(a["license"], "CC0")
        self.assertEqual(a["hed_version"], "8.2.0")
        self.assertEqual(a["source_commit"], "a" * 40)
        self.assertEqual(a["engine_version"], "2")
        self.assertEqual(a["source_tree"], "raw")
        self.assertIs(a["derived"], False)

    def test_missing_catalog_row_leaves_fields_null_not_invented(self):
        a = self.attrs(None)
        for key in ("doi", "license", "citation", "hed_version"):
            self.assertIsNone(a[key], key)
        # The fields the converter knows by itself are still stated.
        self.assertEqual(a["dataset_id"], "on007763")
        self.assertEqual(a["source_commit"], "a" * 40)

    def test_citation_composes_from_the_row(self):
        citation = dataset_citation(self.ROW)
        self.assertIn("Doe J, Roe R", citation)
        self.assertIn("(2024)", citation)
        self.assertIn("Resting state EEG (v1.0.2).", citation)
        self.assertIn("https://doi.org/10.82901/nemar.on007763", citation)

    def test_citation_needs_a_name(self):
        self.assertIsNone(dataset_citation({"authors": "Doe J"}))
        self.assertIsNone(dataset_citation(None))

    def test_citation_omits_the_parts_the_row_lacks(self):
        citation = dataset_citation({"name": "Untitled"})
        self.assertEqual(citation, "Untitled. NEMAR.")


class TestFetchDatasetRow(unittest.TestCase):
    """`fetch_dataset_row` against a REAL HTTP server on a real socket -- the
    provenance attrs depend on its parsing (two response shapes) and on it never
    failing a conversion when the catalog is unreachable."""

    def serve(
        self,
        handler_body: bytes | None,
        status: int = 200,
        refuse_user_agent_prefix: str | None = None,
        seen_user_agents: list[str] | None = None,
    ):
        """A real server on a real socket. `refuse_user_agent_prefix` makes it
        play the Cloudflare edge in front of api.nemar.org, which 403s the
        default Python-urllib User-Agent; `seen_user_agents` records what each
        request sent so a test can assert on the header itself."""
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
                ua = self.headers.get("User-Agent", "")
                if seen_user_agents is not None:
                    seen_user_agents.append(ua)
                if refuse_user_agent_prefix is not None and (
                    not ua or ua.startswith(refuse_user_agent_prefix)
                ):
                    self.send_error(403, "error code: 1010")
                    return
                if handler_body is None:
                    self.send_error(500)
                    return
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(handler_body)))
                self.end_headers()
                self.wfile.write(handler_body)

            def log_message(self, *_args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}"

    def test_reads_a_bare_row(self):
        base = self.serve(json.dumps({"dataset_id": "on007763", "license": "CC0"}).encode())
        row, failed = fetch_dataset_row(base, "on007763")
        self.assertEqual(row["license"], "CC0")
        self.assertIs(failed, False)

    def test_reads_a_row_wrapped_in_dataset(self):
        base = self.serve(json.dumps({"dataset": {"license": "CC-BY-4.0"}}).encode())
        row, failed = fetch_dataset_row(base, "on007763")
        self.assertEqual(row["license"], "CC-BY-4.0")
        self.assertIs(failed, False)

    def test_identifies_itself_so_the_cloudflare_edge_does_not_403_it(self):
        """Cloudflare 403s the default Python-urllib User-Agent on api.nemar.org.

        The first engine-3 production run (on004696, 2026-09-03) fetched with no
        User-Agent and flagged every store `provenance_fetch_failed`; this pins
        the header so the fetch cannot quietly regress to the blocked default.
        """
        seen: list[str] = []
        base = self.serve(
            json.dumps({"dataset": {"id": "on000001", "doi": "10.1/x"}}).encode(),
            refuse_user_agent_prefix="Python-urllib",
            seen_user_agents=seen,
        )
        with contextlib.redirect_stdout(io.StringIO()):
            row, failed = fetch_dataset_row(base, "on000001")
        self.assertIs(failed, False)
        self.assertEqual(row, {"id": "on000001", "doi": "10.1/x"})
        self.assertEqual(len(seen), 1)
        self.assertTrue(seen[0].startswith("nemar-zarr-converter/"), seen)
        self.assertIn(ZARR_ENGINE_VERSION, seen[0])

    def test_the_refusing_server_does_refuse_the_bare_urllib_default(self):
        # The fixture must actually discriminate, or the test above proves
        # nothing: a bare urllib request against the same server is a 403.
        base = self.serve(b"{}", refuse_user_agent_prefix="Python-urllib")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(f"{base}/datasets/on000001", timeout=5)
        self.assertEqual(ctx.exception.code, 403)
        ctx.exception.close()

    def test_a_500_is_reported_as_a_FETCH_FAILURE_not_an_absent_field(self):
        """The distinction the flag exists for.

        A catalog outage and a dataset with no license both leave `doi`/`license`
        null in every store's `nemar` attrs. One is a fact about the run, fixed
        by re-converting; the other is a fact about the dataset. Without the flag
        an outage silently publishes a whole conversion wave claiming to have no
        license, and afterwards nothing distinguishes those stores from datasets
        that genuinely have none.
        """
        base = self.serve(None)  # the handler send_error(500)s
        row, failed = fetch_dataset_row(base, "on007763")
        self.assertIsNone(row)
        self.assertIs(failed, True)

    def test_a_row_that_lacks_a_field_is_NOT_a_fetch_failure(self):
        # The other half of the same distinction: a 200 with no license is data.
        base = self.serve(json.dumps({"dataset_id": "on007763", "name": "N"}).encode())
        row, failed = fetch_dataset_row(base, "on007763")
        self.assertIs(failed, False)
        self.assertIsNone(nemar_store_attrs(
            dataset_id="on007763", source_commit="a" * 40, source_tree="raw",
            derived=False, engine_version="3",
            contract_url="https://zarr.nemar.org/on007763/zarr/x.zarr/",
            row=row, provenance_fetch_failed=failed,
        )["license"])

    def test_a_non_object_body_is_a_fetch_failure(self):
        # A 200 that is not an object is a broken catalog, not an absent field.
        base = self.serve(json.dumps(["not", "an", "object"]).encode())
        row, failed = fetch_dataset_row(base, "on007763")
        self.assertIsNone(row)
        self.assertIs(failed, True)

    def test_the_flag_reaches_the_store_attrs(self):
        attrs = nemar_store_attrs(
            dataset_id="on007763", source_commit="a" * 40, source_tree="raw",
            derived=False, engine_version="3",
            contract_url="https://zarr.nemar.org/on007763/zarr/x.zarr/",
            row=None, provenance_fetch_failed=True,
        )
        self.assertIs(attrs["provenance_fetch_failed"], True)
        self.assertIsNone(attrs["doi"])
        # Always present, so a consumer never has to ask whether the key exists
        # to know whether a null is meaningful.
        clean = nemar_store_attrs(
            dataset_id="on007763", source_commit="a" * 40, source_tree="raw",
            derived=False, engine_version="3",
            contract_url="https://zarr.nemar.org/on007763/zarr/x.zarr/",
            row={"name": "N", "license": "CC0"},
        )
        self.assertIs(clean["provenance_fetch_failed"], False)


class TestIndexFormatV3(unittest.TestCase):
    """The v3 envelope (#1059): where the bytes are, which engine made them, and
    a `source_commit` that is always a real commit."""

    HEAD = "b" * 40

    def build(self, **kwargs):
        base = {
            "prior": None,
            "dataset_id": "on007763",
            "head_commit": self.HEAD,
            "converted": [{"zarr": "sub-01/eeg/a_eeg.zarr", "path": "sub-01/eeg/a_eeg.edf"}],
            "removed_store_rels": [],
            "updated_utc": "2026-09-02T00:00:00Z",
        }
        base.update(kwargs)
        return merge_index(
            base.pop("prior"),
            base.pop("dataset_id"),
            base.pop("head_commit"),
            base.pop("converted"),
            base.pop("removed_store_rels"),
            base.pop("updated_utc"),
            **base,
        )

    def test_declares_the_data_plane(self):
        index = self.build(bucket="nemar", region="us-east-2")
        self.assertEqual(index["format"], "nemar-zarr-index")
        self.assertEqual(index["format_version"], 3)
        self.assertEqual(index["contract_base"], "https://zarr.nemar.org/on007763/zarr/")
        self.assertEqual(
            index["data_base"], "https://nemar.s3.us-east-2.amazonaws.com/on007763/zarr/"
        )
        self.assertEqual(index["data_base_kind"], "s3-public")
        self.assertEqual(index["s3_uri"], "s3://nemar/on007763/zarr/")
        self.assertEqual(index["s3_region"], "us-east-2")
        self.assertIs(index["s3_anonymous"], True)
        self.assertEqual(index["n_recordings"], index["store_count"])

    def test_contract_base_is_not_derived_from_the_bucket(self):
        # The test instance publishes its own host while writing to nemar-dev.
        index = self.build(contract_base="https://zarr-test.nemar.org", bucket="nemar-dev")
        self.assertEqual(index["contract_base"], "https://zarr-test.nemar.org/on007763/zarr/")
        self.assertEqual(
            index["data_base"], "https://nemar-dev.s3.us-east-2.amazonaws.com/on007763/zarr/"
        )

    def test_stamps_the_engine_and_the_library(self):
        index = self.build(engine_version="7", biosigio_version="1.2.6")
        self.assertEqual(index["engine_version"], "7")
        self.assertEqual(index["biosigio_version"], "1.2.6")

    def test_refuses_to_build_without_a_real_commit(self):
        # on008083 published `source_commit: ""` while D1 held the real SHA.
        for bad in ("", "abc123", None, "z" * 40, "A" * 40):
            with self.subTest(commit=bad), self.assertRaises(ValueError):
                self.build(head_commit=bad)

    def test_is_commit_sha(self):
        self.assertTrue(is_commit_sha("0123456789abcdef" + "0" * 24))
        self.assertFalse(is_commit_sha("0123456789ABCDEF" + "0" * 24))  # upper-case
        self.assertFalse(is_commit_sha("0" * 39))
        self.assertFalse(is_commit_sha(None))

    def test_source_key_is_not_published_in_the_index(self):
        index = self.build(
            converted=[{
                "zarr": "sub-01/eeg/a_eeg.zarr",
                "path": "sub-01/eeg/a_eeg.edf",
                "source_key": "SHA256E-s100--abc.edf",
            }],
        )
        self.assertNotIn("source_key", index["stores"][0])

    def test_a_carried_over_v1_entry_is_normalized(self):
        # An index built incrementally on top of a v1 one must not publish a
        # half-v1 document: `source_key` goes, `source_tree`/`derived` appear.
        prior = {
            "source_commit": "a" * 40,
            "stores": [{
                "zarr": "sub-02/eeg/b_eeg.zarr",
                "path": "sub-02/eeg/b_eeg.edf",
                "source_key": "SHA256E-s200--old.edf",
            }],
        }
        index = self.build(prior=prior)
        carried = next(s for s in index["stores"] if s["zarr"] == "sub-02/eeg/b_eeg.zarr")
        self.assertNotIn("source_key", carried)
        self.assertEqual(carried["source_tree"], "raw")
        self.assertIs(carried["derived"], False)

    def test_manifest_carries_the_source_key(self):
        manifest = merge_manifest(
            None,
            "on007763",
            [{"zarr": "sub-01/eeg/a_eeg.zarr", "source_key": "SHA256E-s100--abc.edf",
              "size_bytes": 100}],
            ["sub-01/eeg/a_eeg.zarr"],
            "2026-09-02T00:00:00Z",
        )
        self.assertEqual(manifest["format"], "nemar-zarr-manifest")
        self.assertEqual(manifest["format_version"], 1)
        self.assertEqual(manifest["stores"], [{
            "zarr": "sub-01/eeg/a_eeg.zarr",
            "source_key": "SHA256E-s100--abc.edf",
            "size_bytes": 100,
        }])

    def test_manifest_tracks_the_index_store_set(self):
        # A store the index no longer publishes must not linger in the manifest,
        # or the two documents disagree about what exists.
        prior = {"stores": [
            {"zarr": "gone.zarr", "source_key": "k1", "size_bytes": 1},
            {"zarr": "kept.zarr", "source_key": "k2", "size_bytes": 2},
        ]}
        manifest = merge_manifest(prior, "on007763", [], ["kept.zarr"], "2026-09-02T00:00:00Z")
        self.assertEqual([s["zarr"] for s in manifest["stores"]], ["kept.zarr"])


class TestCoverageInvariant(unittest.TestCase):
    """#1197's acceptance criterion: every discovered raw recording is accounted
    for exactly once, in the published document."""

    HEAD = "c" * 40
    A = "sub-01/eeg/a_eeg.edf"
    B = "sub-02/eeg/b_eeg.edf"
    C = "sub-03/eeg/c_eeg.edf"

    def build(self, converted=(), failures=(), pending=(), discovered=None, **kw):
        return merge_index(
            kw.pop("prior", None),
            "on008083",
            self.HEAD,
            list(converted),
            [],
            "2026-09-02T00:00:00Z",
            list(failures),
            list(pending),
            discovered=discovered,
            **kw,
        )

    def test_full_run_balances(self):
        index = self.build(
            converted=[{"zarr": store_rel_for(self.A), "path": self.A}],
            failures=[{"path": self.B, "zarr": store_rel_for(self.B),
                       "code": "corrupt_or_truncated", "reason": "...", "detail": "..."}],
            pending=[{"path": self.C, "reason": "infra_failure", "last_error": "boom"}],
            discovered=[self.A, self.B, self.C],
        )
        self.assertEqual(index["discovered_count"], 3)
        self.assertEqual((index["store_count"], index["failure_count"],
                          index["pending_count"]), (1, 1, 1))
        check_index_invariant(index)

    def test_partial_run_lists_the_untouched_recordings(self):
        # The five recordings on008083 lost: discovered, not attempted, and
        # before v3 present in neither list.
        index = self.build(
            converted=[{"zarr": store_rel_for(self.A), "path": self.A}],
            discovered=[self.A, self.B, self.C],
        )
        check_index_invariant(index)
        self.assertEqual(index["pending_count"], 2)
        reasons = {p["path"]: p for p in index["pending"]}
        self.assertEqual(reasons[self.B]["reason"], "not_attempted")
        self.assertEqual(reasons[self.B]["attempts"], 0)
        self.assertEqual(reasons[self.B]["zarr"], store_rel_for(self.B))

    def test_entries_for_undiscovered_paths_are_dropped(self):
        prior = {"source_commit": "a" * 40,
                 "stores": [{"zarr": store_rel_for(self.C), "path": self.C}]}
        index = self.build(
            prior=prior,
            converted=[{"zarr": store_rel_for(self.A), "path": self.A}],
            discovered=[self.A],
        )
        check_index_invariant(index)
        self.assertEqual([s["path"] for s in index["stores"]], [self.A])

    def test_a_non_raw_store_is_dropped_and_counted(self):
        """A carried-over store under `derivatives/` must NOT be republished.

        ADR 0027 made discovery raw-only and `purge_non_raw_stores.py` is the
        authorised deletion of what it stopped producing, so those stores are not
        hosted -- an index that kept describing one would advertise bytes that are
        being removed. The drop is deliberate, but it is LOUD: `merge_index` logs
        each one with the tree that excluded it, and `main` reports the count as
        `non_raw_dropped` on the callback, because "the index lost 92 stores"
        needs a cause attached when an orphan-detection bug is the alternative
        reading.
        """
        legacy = "derivatives/preprocessed/sub-09/eeg/sub-09_task-x_eeg.set"
        prior = {
            "source_commit": "a" * 40,
            "stores": [
                {"zarr": store_rel_for(legacy), "path": legacy,
                 "source_key": "SHA256E-s9--legacy"},
            ],
        }
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            index = self.build(
                prior=prior,
                converted=[{"zarr": store_rel_for(self.A), "path": self.A}],
                discovered=[self.A],
            )
        self.assertEqual([s["path"] for s in index["stores"]], [self.A])
        self.assertEqual(index["store_count"], 1)
        self.assertNotIn("legacy_store_count", index)
        # Named, with the reason, rather than vanishing.
        log = buf.getvalue()
        self.assertIn(legacy, log)
        self.assertIn("derivatives", log)
        self.assertEqual(index["discovered_count"], 1)
        check_index_invariant(index)

    def test_non_raw_store_paths_counts_from_the_prior_index(self):
        """The callback's `non_raw_dropped` is read from the PRIOR PUBLISHED
        index, not from the merge's filtering.

        Production always runs `--clean`, which passes `prior=None` to the merge:
        the entries never enter, so the filter never sees them -- yet they are
        still gone from the index a client fetches next. Counting from the merge
        would report 0 on exactly the path that matters.
        """
        prior = {"stores": [
            {"path": "derivatives/prep/a_eeg.set", "zarr": "derivatives/prep/a_eeg.zarr"},
            {"path": "sourcedata/b_eeg.set", "zarr": "sourcedata/b_eeg.zarr"},
            {"path": "code/c_eeg.set", "zarr": "code/c_eeg.zarr"},
            {"path": "sub-01/meg/sub-01_acq-crosstalk_meg.fif",
             "zarr": "sub-01/meg/sub-01_acq-crosstalk_meg.zarr"},
            {"path": self.A, "zarr": store_rel_for(self.A)},
        ]}
        dropped = generate_zarr.non_raw_store_paths(prior)
        self.assertEqual(len(dropped), 4, dropped)
        self.assertNotIn(self.A, dropped)
        self.assertEqual(generate_zarr.non_raw_store_paths(None), [])
        self.assertEqual(generate_zarr.non_raw_store_paths({}), [])

    def test_excluded_reason_names_the_cause(self):
        self.assertEqual(generate_zarr.excluded_reason("derivatives/x_eeg.set"), "derivatives")
        self.assertEqual(generate_zarr.excluded_reason("sub-01/sourcedata/x_eeg.set"), "sourcedata")
        self.assertEqual(generate_zarr.excluded_reason("code/x_eeg.set"), "code")
        self.assertEqual(
            generate_zarr.excluded_reason("sub-01/meg/sub-01_acq-crosstalk_meg.fif"),
            "bids-calibration",
        )
        self.assertIsNone(generate_zarr.excluded_reason("sub-01/eeg/a_eeg.set"))

    def test_a_non_raw_failure_or_pending_entry_cannot_survive(self):
        # The same rule on the other two lists: a non-raw path has no business in
        # any of them, and the carry-forward already refused one.
        prior = {
            "source_commit": "a" * 40,
            "stores": [],
            "failures": [{"path": "derivatives/prep/x-epo.fif", "zarr": "derivatives/prep/x-epo.zarr",
                          "code": "not_continuous", "reason": "..."}],
            "pending": [{"path": "code/y_eeg.set", "reason": "infra_failure", "attempts": 2}],
        }
        index = merge_index(
            prior, "on008083", self.HEAD, [], [], "2026-09-02T00:00:00Z", [], [],
            discovered=[self.A], prior_pending=prior["pending"],
        )
        self.assertEqual(index["failure_count"], 0)
        self.assertEqual([p["path"] for p in index["pending"]], [self.A])
        check_index_invariant(index)

    def test_errors_counts_this_runs_failures_typed_and_not(self):
        index = self.build(
            converted=[{"zarr": store_rel_for(self.A), "path": self.A}],
            failures=[{"path": self.B, "zarr": store_rel_for(self.B),
                       "code": "not_continuous", "reason": "..."}],
            pending=[{"path": self.C, "reason": "infra_failure"}],
            discovered=[self.A, self.B, self.C],
            errors=2,
        )
        self.assertEqual(index["errors"], 2)

    def test_discovered_primaries_match_the_worklist(self):
        # The coverage denominator has to be the set the converter would attempt,
        # not a second walk that could drift from it.
        head = [
            "sub-01/eeg/sub-01_task-x_eeg.set",
            "sub-01/eeg/sub-01_task-x_eeg.fdt",
            "derivatives/prep/sub-01/eeg/sub-01_task-x_eeg.set",
            "sub-02/meg/sub-02_task-x_acq-crosstalk_meg.fif",
            "dataset_description.json",
        ]
        convert, _remove = compute_worklist(head, [], full=True)
        self.assertEqual(discover_primaries(head), convert)
        self.assertEqual(discover_primaries(head), ["sub-01/eeg/sub-01_task-x_eeg.set"])


class TestPendingRetries(unittest.TestCase):
    """Pending entries age, and stop aging (#1197). An infra failure that will
    never succeed must not promise forever that it is about to."""

    HEAD = "d" * 40
    PATH = "sub-01/eeg/a_eeg.edf"

    def run_round(self, prior_pending, reason="infra_failure", last_error="boom"):
        return merge_index(
            None, "on008083", self.HEAD, [], [], "2026-09-02T00:00:00Z", [],
            [{"path": self.PATH, "reason": reason, "last_error": last_error}],
            discovered=[self.PATH],
            prior_pending=prior_pending,
        )

    def test_attempts_start_at_one_and_accumulate(self):
        index = self.run_round(None)
        self.assertEqual(index["pending"][0]["attempts"], 1)
        self.assertEqual(index["pending"][0]["reason"], "infra_failure")
        self.assertEqual(index["pending"][0]["last_error"], "boom")
        self.assertEqual(index["pending"][0]["last_attempt_utc"], "2026-09-02T00:00:00Z")

        index = self.run_round(index["pending"])
        self.assertEqual(index["pending"][0]["attempts"], 2)

    def test_exhaustion_promotes_to_a_typed_failure(self):
        pending = None
        for round_n in range(1, PENDING_MAX_ATTEMPTS):
            index = self.run_round(pending)
            self.assertEqual(index["pending_count"], 1, f"round {round_n}")
            pending = index["pending"]
        # The round that reaches the cap moves it out of `pending` for good.
        index = self.run_round(pending)
        self.assertEqual(index["pending_count"], 0)
        self.assertEqual(index["failure_count"], 1)
        failure = index["failures"][0]
        self.assertEqual(failure["code"], "retry_exhausted")
        self.assertEqual(failure["detail"], "boom")
        self.assertEqual(failure["attempts"], PENDING_MAX_ATTEMPTS)
        self.assertTrue(failure["reason"])
        check_index_invariant(index)

    def test_a_memory_budget_pending_is_reason_tagged(self):
        index = self.run_round(None, reason="memory_budget")
        self.assertEqual(index["pending"][0]["reason"], "memory_budget")

    def test_converting_clears_the_pending_entry(self):
        first = self.run_round(None)
        index = merge_index(
            None, "on008083", self.HEAD,
            [{"zarr": store_rel_for(self.PATH), "path": self.PATH}],
            [], "2026-09-02T01:00:00Z", [], [],
            discovered=[self.PATH],
            prior_pending=first["pending"],
        )
        self.assertEqual(index["pending_count"], 0)
        self.assertEqual(index["store_count"], 1)
        check_index_invariant(index)

    def test_a_path_is_never_in_two_lists(self):
        index = merge_index(
            None, "on008083", self.HEAD,
            [{"zarr": store_rel_for(self.PATH), "path": self.PATH}],
            [], "2026-09-02T00:00:00Z", [],
            [{"path": self.PATH, "reason": "infra_failure"}],
            discovered=[self.PATH],
        )
        self.assertEqual(index["store_count"], 0)
        self.assertEqual(index["pending_count"], 1)
        check_index_invariant(index)

    def test_not_attempted_never_ages_toward_exhaustion(self):
        # A recording a `--limit`ed run never reached has not failed at anything.
        pending = None
        for _ in range(PENDING_MAX_ATTEMPTS + 2):
            index = merge_index(
                None, "on008083", self.HEAD, [], [], "2026-09-02T00:00:00Z", [], [],
                discovered=[self.PATH], prior_pending=pending,
            )
            pending = index["pending"]
        self.assertEqual(index["pending_count"], 1)
        self.assertEqual(index["pending"][0]["reason"], "not_attempted")
        self.assertEqual(index["pending"][0]["attempts"], 0)


class TestIndexSchemaSelfCheck(unittest.TestCase):
    """The converter validates the document it is about to publish. index.json is
    the mandatory entry point (in-prefix ListBucket is denied), so a malformed one
    has no fallback for any consumer."""

    HEAD = "e" * 40

    def index(self):
        return merge_index(
            None, "on007763", self.HEAD,
            [{"zarr": "sub-01/eeg/a_eeg.zarr", "path": "sub-01/eeg/a_eeg.edf",
              "updated_utc": "2026-09-02T00:00:00Z", "source_tree": "raw",
              "derived": False, "modalities": ["eeg"],
              "groups": [{"name": "eeg_200hz", "modality": "EEG", "rate": 200.0,
                          "n_channels": 4, "n_samples": 12000, "duration_s": 60.0,
                          "n_view_levels": 3, "view_chunk_columns": 1024,
                          "source_rate_hz": 200.0, "chunk_samples": 800,
                          "shard_samples": 12000}],
              "n_events": 3, "trial_types": {"go": 2, "stop": 1},
              "units_report": {"converted": 1, "relabelled": 0,
                               "kept_importer_unit": 0, "units_column_present": True}}],
            [], "2026-09-02T00:00:00Z",
            [{"path": "sub-02/eeg/b_eeg.edf", "zarr": "sub-02/eeg/b_eeg.zarr",
              "code": "file_read_error", "reason": "...", "detail": "OSError: ..."}],
            [{"path": "sub-03/eeg/c_eeg.edf", "reason": "infra_failure",
              "last_error": "boom"}],
            discovered=["sub-01/eeg/a_eeg.edf", "sub-02/eeg/b_eeg.edf",
                        "sub-03/eeg/c_eeg.edf"],
            biosigio_version="1.2.6",
        )

    def test_the_validator_is_installed_so_this_class_can_fail(self):
        """Without `jsonschema` every other test here is vacuous.

        `validate_document` degrades to a loud warning when the validator is
        missing -- deliberately, so an old venv on the conversion node still
        converts rather than refusing to publish over a lint dependency. The
        cost is that the positive cases below then pass without validating
        anything, and the negative cases ERROR on their own import. Both read
        like a green schema gate.

        This is the tripwire: it fails, by name, in exactly the environment
        where the rest of the class stops meaning anything. CI installs the
        validator for this job (`.github/workflows/test.yml`), and so does
        `scripts/zarr/requirements.txt`; if either drops it, this is what says
        so.
        """
        import jsonschema  # noqa: F401 - presence IS the assertion

    def index_with_events(self):
        """The index as `main` publishes it for a dataset that HAS events: the
        two fields are set there, after the parquet is uploaded, so the document
        never names a file that was not written."""
        index = self.index()
        index["events_parquet"] = f"{index['data_base']}{EVENTS_PARQUET_NAME}"
        index["events_row_count"] = 3
        return index

    def test_a_built_index_validates(self):
        validate_document(self.index(), INDEX_SCHEMA_PATH, "index")

    def test_an_index_with_events_validates(self):
        validate_document(self.index_with_events(), INDEX_SCHEMA_PATH, "index")

    def test_the_events_fields_are_optional(self):
        """A dataset with no events.tsv anywhere publishes neither field, and a
        v3 index written before they existed carries neither. Both must keep
        validating -- that is what "additive within v3" means."""
        index = self.index()
        self.assertNotIn("events_parquet", index)
        self.assertNotIn("events_row_count", index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_the_events_file_is_in_the_layout_recipe(self):
        # Same reason as the rest of the layout block: an MCP recipe (ADR 0025)
        # is computable from index.json alone. Whether the file EXISTS is said by
        # `events_parquet`, not by this template.
        self.assertEqual(self.index()["layout"]["events"], "<data_base>events.parquet")
        with open(INDEX_SCHEMA_PATH) as fh:
            props = json.load(fh)["properties"]["layout"]
        self.assertEqual(props["properties"]["events"]["const"], "<data_base>events.parquet")
        # Optional in `required`, so an index published by the previous producer
        # (which had no such key) still validates against this schema.
        self.assertNotIn("events", props["required"])

    def test_the_index_declares_its_stability_policy(self):
        # A schema with no stated policy is one every client has to guess at.
        with open(INDEX_SCHEMA_PATH) as fh:
            schema = json.load(fh)
        self.assertIn("format_version 3", schema["$comment"])
        self.assertIn("additionalProperties", schema["$comment"])
        self.assertIn("v4", schema["$comment"])
        with open(MANIFEST_SCHEMA_PATH) as fh:
            self.assertIn("format_version 1", json.load(fh)["$comment"])

    def test_the_layout_recipe_is_published(self):
        """An MCP recipe (ADR 0025) has to be computable from index.json plus ONE
        array-metadata fetch. The broker is stateless, so anything absent from
        the index it must discover by request -- and discovery-by-404 is what
        #1178 item 2 removed. The numbers were already here; these are the path
        templates and the sample-value rule that make them usable."""
        layout = self.index()["layout"]
        self.assertEqual(layout["level0"], "<zarr>/<group>/0")
        self.assertEqual(layout["view"], "<zarr>/<group>/view/<L>")
        self.assertIn("n_view_levels", layout["view_levels"])
        self.assertIn("physical = digital * scale + offset", layout["scale_offset"])
        # `const` in the schema, so a client may hardcode it after checking
        # format_version -- and a layout change becomes a schema change.
        with open(INDEX_SCHEMA_PATH) as fh:
            props = json.load(fh)["properties"]["layout"]["properties"]
        self.assertEqual(props["level0"]["const"], layout["level0"])

    def test_dataset_provenance_is_hoisted_to_the_top_level(self):
        index = merge_index(
            None, "on007763", self.HEAD, [], [], "2026-09-02T00:00:00Z", [], [],
            discovered=[],
            dataset_row={"name": "N", "authors": "Doe J", "concept_doi": "10.82901/x",
                         "license": "CC0", "hed_version": "8.2.0",
                         "created_at": "2024-01-01"},
        )
        self.assertEqual(index["doi"], "10.82901/x")
        self.assertEqual(index["license"], "CC0")
        self.assertEqual(index["hed_version"], "8.2.0")
        self.assertIn("Doe J", index["citation"])
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_dataset_provenance_is_null_without_a_row(self):
        # Already fetched once per run, so publishing it is free -- but a catalog
        # that has no DOI yet must yield null rather than an invented string.
        index = merge_index(
            None, "on007763", self.HEAD, [], [], "2026-09-02T00:00:00Z", [], [],
            discovered=[],
        )
        for key in ("doi", "license", "citation", "hed_version"):
            self.assertIsNone(index[key], key)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_a_zero_store_index_validates(self):
        # A dataset whose every recording failed still publishes an index, and it
        # is the shape most likely to be built by a path nobody exercised.
        index = merge_index(
            None, "on008083", self.HEAD, [], [], "2026-09-02T00:00:00Z",
            [_failure_entry("sub-01/eeg/a_eeg.edf", "file_read_error", "OSError: x")],
            [],
            discovered=["sub-01/eeg/a_eeg.edf"],
        )
        self.assertEqual(index["store_count"], 0)
        self.assertEqual(index["stores"], [])
        check_index_invariant(index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_a_mutated_index_is_rejected(self):
        import jsonschema

        for mutate in (
            lambda d: d.__setitem__("source_commit", ""),
            lambda d: d.__setitem__("format_version", 1),
            lambda d: d.__setitem__("store_count", -1),
            lambda d: d.__setitem__("data_base_kind", "gopher"),
            lambda d: d.__setitem__("stray_key", 1),
            lambda d: d["pending"][0].__setitem__("reason", "because"),
            lambda d: d["stores"][0].pop("source_tree"),
            lambda d: d["failures"][0].pop("code"),
            # The "no source_key in the index" rule (#1178 item 5) is now
            # CHECKABLE rather than a convention: the store object is closed, so
            # a producer that forgot to strip it cannot publish.
            lambda d: d["stores"][0].__setitem__("source_key", "SHA256E-s1--a"),
            # Every sub-object closed, so a typo'd key fails here rather than
            # being served to clients that ignore it.
            lambda d: d["stores"][0].__setitem__("stray", 1),
            lambda d: d["stores"][0]["groups"][0].__setitem__("stray", 1),
            lambda d: d["failures"][0].__setitem__("stray", 1),
            lambda d: d["pending"][0].__setitem__("stray", 1),
            # A group with no name cannot be addressed at all: the layout
            # recipe's <group> has nothing to substitute.
            lambda d: d["stores"][0]["groups"][0].pop("name"),
            # http:// is not the contract: the data plane is HTTPS-only.
            lambda d: d.__setitem__("contract_base", "http://zarr.nemar.org/x/zarr/"),
            lambda d: d.__setitem__("data_base", "ftp://example.org/"),
            # A failure or pending entry must name a STORE path.
            lambda d: d["failures"][0].__setitem__("zarr", "sub-02/eeg/b_eeg.edf"),
            lambda d: d["pending"][0].__setitem__("zarr", "nope"),
            lambda d: d.pop("layout"),
            lambda d: d["layout"].__setitem__("level0", "<zarr>/<group>/level0"),
            lambda d: d["layout"].__setitem__("events", "<data_base>events.pq"),
            # The events file is fetched over the same HTTPS data plane as the
            # stores; an s3:// URI here would not be fetchable by a browser
            # client at all.
            lambda d: d.__setitem__("events_parquet", "s3://nemar/x/zarr/events.parquet"),
            lambda d: d.__setitem__("events_row_count", -1),
            lambda d: d.__setitem__("events_row_count", "3"),
        ):
            doc = json.loads(json.dumps(self.index_with_events()))
            mutate(doc)
            with self.subTest(mutation=str(mutate)), self.assertRaises(
                jsonschema.ValidationError
            ):
                validate_document(doc, INDEX_SCHEMA_PATH, "index")

    def test_a_built_manifest_validates(self):
        manifest = merge_manifest(
            None, "on007763",
            [{"zarr": "sub-01/eeg/a_eeg.zarr", "source_key": "SHA256E-s100--a.edf",
              "size_bytes": 100}],
            ["sub-01/eeg/a_eeg.zarr"], "2026-09-02T00:00:00Z",
        )
        validate_document(manifest, MANIFEST_SCHEMA_PATH, "manifest")

    def test_a_mutated_manifest_is_rejected(self):
        import jsonschema

        manifest = merge_manifest(
            None, "on007763",
            [{"zarr": "sub-01/eeg/a_eeg.zarr", "source_key": "k", "size_bytes": 1}],
            ["sub-01/eeg/a_eeg.zarr"], "2026-09-02T00:00:00Z",
        )
        manifest["stores"][0]["zarr"] = "sub-01/eeg/a_eeg.set"  # not a store path
        with self.assertRaises(jsonschema.ValidationError):
            validate_document(manifest, MANIFEST_SCHEMA_PATH, "manifest")

    def test_the_manifest_records_the_published_events_file(self):
        manifest = merge_manifest(
            None, "on007763", [], [], "2026-09-02T00:00:00Z",
            events_file={"name": EVENTS_PARQUET_NAME, "size_bytes": 4096, "row_count": 3},
        )
        self.assertEqual(manifest["files"][0]["size_bytes"], 4096)
        validate_document(manifest, MANIFEST_SCHEMA_PATH, "manifest")
        # No file published, no claim about one: the previous run's object may
        # still be on S3, and this document must not describe it.
        bare = merge_manifest(None, "on007763", [], [], "2026-09-02T00:00:00Z")
        self.assertNotIn("files", bare)
        validate_document(bare, MANIFEST_SCHEMA_PATH, "manifest")

    def test_a_mutated_manifest_file_entry_is_rejected(self):
        import jsonschema

        for mutate in (
            # The enum is what stops this list from quietly becoming a
            # free-form file inventory nobody validates.
            lambda d: d["files"][0].__setitem__("name", "events.pq"),
            lambda d: d["files"][0].__setitem__("size_bytes", -1),
            lambda d: d["files"][0].__setitem__("row_count", -1),
            lambda d: d["files"][0].pop("size_bytes"),
            lambda d: d["files"][0].__setitem__("stray", 1),
        ):
            manifest = merge_manifest(
                None, "on007763", [], [], "2026-09-02T00:00:00Z",
                events_file={"name": EVENTS_PARQUET_NAME, "size_bytes": 1, "row_count": 1},
            )
            with self.subTest(mutation=str(mutate)), self.assertRaises(
                jsonschema.ValidationError
            ):
                mutate(manifest)
                validate_document(manifest, MANIFEST_SCHEMA_PATH, "manifest")


class TestRealRecordingV3Fields(unittest.TestCase):
    """End-to-end over the STORE-LEVEL functions on a real recording.

    Not `convert_one`: that uploads with `aws s3 sync`, so a whole-run test would
    need S3 credentials and a bucket. Everything between the file and the upload
    is exercised here on real bytes -- biosigIO reads a real EDF, writes a real
    Zarr v3 store, and `store_metadata` reads back the very attrs the index
    republishes. That is the half where a biosigIO attr rename would silently
    empty the new fields.
    """

    @classmethod
    def setUpClass(cls):
        try:
            import pyedflib  # noqa: F401
            import zarr  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc
        cls._tmp = tempfile.TemporaryDirectory()
        d = cls._tmp.name
        cls.recording = build_real_edf(d, "sub-01_task-rest_eeg")
        cls.channels = os.path.join(d, "sub-01_task-rest_channels.tsv")
        with open(cls.channels, "w") as fh:
            fh.writelines(
                ["name\ttype\tunits\n"] + [f"E{i + 1}\tEEG\tV\n" for i in range(4)]
            )
        cls.events = os.path.join(d, "sub-01_task-rest_events.tsv")
        with open(cls.events, "w") as fh:
            fh.writelines(
                ["onset\tduration\ttrial_type\n"]
                + [
                    f"{i * 5.0}\t0.5\t{'go' if i % 2 == 0 else 'stop'}\n"
                    for i in range(6)
                ]
            )
        cls.store = os.path.join(d, "sub-01_task-rest_eeg.zarr")
        convert_recording(
            cls.recording, cls.events, cls.store, channels_local=cls.channels
        )
        cls.meta = store_metadata(cls.store)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_view_geometry_is_republished_from_the_store(self):
        group = self.meta["groups"][0]
        # Without n_view_levels the website reader probes view/1, view/2, ...
        # until a 404 (#1178 item 2).
        self.assertGreaterEqual(group["n_view_levels"], 1)
        # Constant COLUMNS per view chunk is what turns a zoomed-out read from
        # 594 requests into 3 (#1178 item 1, biosigio 1.2.6).
        self.assertEqual(group["view_chunk_columns"], 1024)

    def test_source_rate_is_the_acquisition_rate_not_the_serving_cap(self):
        group = self.meta["groups"][0]
        self.assertEqual(group["source_rate_hz"], 200.0)
        self.assertGreater(group["chunk_samples"], 0)
        self.assertGreater(group["shard_samples"], 0)

    def test_units_report_is_published_when_channels_tsv_was_applied(self):
        report = self.meta["units_report"]
        self.assertIs(report["units_column_present"], True)
        for key in ("converted", "relabelled", "kept_importer_unit"):
            self.assertIsInstance(report[key], int)

    def test_no_units_report_when_no_channels_tsv_applies(self):
        # Absence means "not applied", never "applied cleanly" -- the distinction
        # a consumer needs while the streaming path still cannot apply it.
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "plain_eeg.zarr")
            convert_recording(self.recording, None, store)
            self.assertNotIn("units_report", store_metadata(store))

    def test_events_summary_matches_the_applied_events_tsv(self):
        with open(self.events) as fh:
            summary = events_summary(fh.read())
        self.assertEqual(summary["n_events"], 6)
        self.assertEqual(summary["trial_types"], {"go": 3, "stop": 3})

    def test_provenance_attrs_land_in_the_store_root(self):
        import zarr

        embed_root_attr(
            self.store,
            "nemar",
            nemar_store_attrs(
                dataset_id="on007763",
                source_commit="f" * 40,
                source_tree=source_tree_for("sub-01/eeg/sub-01_task-rest_eeg.edf"),
                derived=False,
                engine_version="2",
                contract_url="https://zarr.nemar.org/on007763/zarr/x.zarr/",
                row={"name": "N", "license": "CC0"},
            ),
        )
        attrs = dict(zarr.open_group(self.store, mode="r").attrs)
        self.assertEqual(attrs["nemar"]["license"], "CC0")
        self.assertEqual(attrs["nemar"]["source_tree"], "raw")
        # biosigIO's own attributes are untouched.
        self.assertEqual(attrs["format"], "biosigio-zarr")
        self.assertIn("channel_groups", attrs)

    def test_sidecar_applies_to_a_recording_with_no_sidecar_beside_it(self):
        """The ADR 0028 MaxShield shape, without needing a MaxShield recording.

        On that path `primary_local` is the Signal-Space-Separated copy at
        `work/sss_<basename>` -- a real file at a path where no channels.tsv is
        adjacent. biosigIO's own `bids_channels="auto"` resolves the sidecar as a
        SIBLING, so it would find nothing there and silently serve importer units
        and MNE-inferred types. This reproduces exactly that geometry with a real
        EDF at a renamed path in an empty directory, and asserts the sidecar still
        reaches the conversion.
        """
        with tempfile.TemporaryDirectory() as d:
            filtered = os.path.join(d, "sss_sub-01_task-rest_eeg.edf")
            shutil.copyfile(self.recording, filtered)
            self.assertEqual(
                [f for f in os.listdir(d) if f.endswith("_channels.tsv")], [],
                "the fixture must have NO sidecar beside the recording",
            )
            store = os.path.join(d, "out.zarr")
            convert_recording(filtered, None, store, channels_local=self.channels)
            report = store_metadata(store)["units_report"]
            self.assertIs(report["units_column_present"], True)

    def test_sibling_auto_detection_is_not_what_applies_the_sidecar(self):
        """A sidecar sitting beside the recording but NOT the one this driver
        resolved must not be picked up: with no sidecar resolved the driver
        passes `bids_channels="off"`, so the only sidecar that can ever shape a
        store is one this driver chose.

        Without this, the SSS test above could pass for the wrong reason on some
        future release whose auto-detection searches more widely -- and a staged
        sidecar would be at risk of being applied twice, which matters because
        adopting a unit CONVERTS samples rather than relabelling them.
        """
        with tempfile.TemporaryDirectory() as d:
            recording = os.path.join(d, "sub-01_task-rest_eeg.edf")
            shutil.copyfile(self.recording, recording)
            # A sibling naming channels the recording does not have: applied, it
            # would report nothing changed; ignored, there is no report at all.
            with open(os.path.join(d, "sub-01_task-rest_channels.tsv"), "w") as fh:
                fh.write("name\ttype\tunits\nNOPE\tEEG\tV\n")
            store = os.path.join(d, "out.zarr")
            convert_recording(recording, None, store)
            self.assertNotIn("units_report", store_metadata(store))

    def test_bids_channels_arg_is_the_path_or_off_never_auto(self):
        """"auto" is biosigIO's default and is always wrong here: it resolves the
        sidecar as a SIBLING of the file the exporter was handed, which is a
        scratch materialisation (and, on the MaxShield path, a filtered copy).
        The driver therefore passes the resolved path, or "off" when no sidecar
        applies -- an explicit "there is none" rather than a guess."""
        self.assertEqual(generate_zarr.bids_channels_arg(self.channels), self.channels)
        self.assertEqual(generate_zarr.bids_channels_arg(None), "off")
        self.assertEqual(generate_zarr.bids_channels_arg(""), "off")
        # Staged but missing (a failed sidecar read) is "off", not a path the
        # exporter would raise on.
        self.assertEqual(
            generate_zarr.bids_channels_arg("/no/such/_channels.tsv"), "off"
        )

    def test_the_streaming_exporter_applies_the_sidecar_too(self):
        """The two exporters must not disagree about a recording's units.

        This is the assertion that was impossible on biosigio 1.2.6, whose
        `stream_to_zarr` had no `bids_channels` parameter at all: a dataset's
        small recordings carried the sidecar's units and its large ones carried
        the importer's, which is exactly why the engine bump waited for
        biosigio#128. Now it is an observable property of a real streamed store,
        so a regression on either path fails here rather than being inferred from
        a missing index field.
        """
        if not generate_zarr._EDF_STREAMABLE:
            self.skipTest("installed biosigio does not stream EDF")
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "streamed.zarr")
            saved = generate_zarr.STREAM_EDF_MIN_BYTES
            try:
                # Force the streaming branch for a small real EDF, so this runs
                # the same exporter a multi-GB recording would.
                generate_zarr.STREAM_EDF_MIN_BYTES = 1
                self.assertTrue(
                    generate_zarr.should_stream(self.recording, os.path.getsize(self.recording))
                )
                convert_recording(
                    self.recording, None, store, channels_local=self.channels
                )
            finally:
                generate_zarr.STREAM_EDF_MIN_BYTES = saved
            report = store_metadata(store)["units_report"]
            self.assertIs(report["units_column_present"], True)

    def test_a_streamed_recording_with_no_sidecar_beside_it(self):
        """The MaxShield geometry on the STREAMING path: the exporter is handed a
        filtered copy in a directory with no channels.tsv, and must still apply
        the sidecar the driver resolved. Sibling auto-detection would find
        nothing here."""
        if not generate_zarr._EDF_STREAMABLE:
            self.skipTest("installed biosigio does not stream EDF")
        with tempfile.TemporaryDirectory() as d:
            filtered = os.path.join(d, "sss_sub-01_task-rest_eeg.edf")
            shutil.copyfile(self.recording, filtered)
            self.assertEqual(
                [f for f in os.listdir(d) if f.endswith("_channels.tsv")], [],
                "the fixture must have NO sidecar beside the recording",
            )
            store = os.path.join(d, "out.zarr")
            saved = generate_zarr.STREAM_EDF_MIN_BYTES
            try:
                generate_zarr.STREAM_EDF_MIN_BYTES = 1
                convert_recording(filtered, None, store, channels_local=self.channels)
            finally:
                generate_zarr.STREAM_EDF_MIN_BYTES = saved
            self.assertIs(
                store_metadata(store)["units_report"]["units_column_present"], True
            )

    def test_channels_tsv_resolution_is_shared_with_the_fidelity_gate(self):
        head = {
            "sub-01/eeg/sub-01_task-rest_eeg.edf",
            "sub-01/eeg/sub-01_task-rest_channels.tsv",
            "sub-01/sub-01_channels.tsv",
        }
        self.assertEqual(
            channels_tsv_for("sub-01/eeg/sub-01_task-rest_eeg.edf", head),
            "sub-01/eeg/sub-01_task-rest_channels.tsv",
        )


class TestMainRefusesToPublish(unittest.TestCase):
    """The refuse-to-publish guards must still write a `failed` callback.

    `hallu-zarr.sh` POSTs whatever the callback file contains. A failure path
    that writes NO file posts nothing, so the `converting` signal the driver sent
    when it started the dataset is never superseded and D1 sits at
    `zarr_status='pending'` forever -- the dashboard shows a conversion in flight
    with nothing running. #774 fixed exactly that for the total-failure branch;
    the two schema guards were added later and returned 1 directly, reopening it.

    Drives `main()` end to end: a real git repo, a real (stub) `aws` executable
    on PATH, real argument parsing, real callback file. Only the SCHEMA is
    swapped -- for one that rejects every document -- because a producer bug is
    otherwise not reachable from outside.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.repo = os.path.join(self.dir, "repo")
        os.makedirs(self.repo)
        def run(*args):
            subprocess.run(args, cwd=self.repo, check=True, capture_output=True)

        run("git", "init", "-q", "-b", "main")
        run("git", "config", "user.email", "t@example.org")
        run("git", "config", "user.name", "t")
        # A dataset with NO recordings: `convert` is empty, so nothing is
        # downloaded or converted and the guard is the only thing under test.
        with open(os.path.join(self.repo, "dataset_description.json"), "w") as fh:
            json.dump({"Name": "guard fixture", "BIDSVersion": "1.8.0"}, fh)
        run("git", "add", "-A")
        run("git", "commit", "-q", "-m", "init")

        # A real executable standing in for `aws`, reporting NoSuchKey so the
        # prior index/manifest reads take their legitimate first-run path. Same
        # approach as TestAwsRunner, which stands python3 in for aws.
        bindir = os.path.join(self.dir, "bin")
        os.makedirs(bindir)
        self.aws = os.path.join(bindir, "aws")
        with open(self.aws, "w") as fh:
            fh.write("#!/bin/sh\necho 'NoSuchKey' >&2\nexit 1\n")
        os.chmod(self.aws, 0o755)
        self._path = os.environ["PATH"]
        os.environ["PATH"] = bindir + os.pathsep + self._path

        self.callback = os.path.join(self.dir, "cb.json")
        self._schemas = (generate_zarr.INDEX_SCHEMA_PATH, generate_zarr.MANIFEST_SCHEMA_PATH)

    def tearDown(self):
        os.environ["PATH"] = self._path
        (generate_zarr.INDEX_SCHEMA_PATH, generate_zarr.MANIFEST_SCHEMA_PATH) = self._schemas
        self._tmp.cleanup()

    def reject_everything(self) -> str:
        """A valid draft 2020-12 schema that no instance satisfies."""
        path = os.path.join(self.dir, "reject.schema.json")
        with open(path, "w") as fh:
            json.dump({"$schema": "https://json-schema.org/draft/2020-12/schema",
                       "not": {}}, fh)
        return path

    def run_main(self) -> int:
        argv = [
            "generate_zarr.py",
            "--dataset-id", "on008083",
            "--repo-dir", self.repo,
            "--bucket", "nemar-test",
            "--callback-out", self.callback,
            "--clean",
        ]
        saved, sys.argv = sys.argv, argv
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                return generate_zarr.main()
        finally:
            sys.argv = saved

    def read_callback(self) -> dict:
        self.assertTrue(
            os.path.exists(self.callback),
            "no callback file: the driver would POST nothing and D1 would stay "
            "at zarr_status='pending' forever",
        )
        with open(self.callback) as fh:
            return json.load(fh)

    def assert_failed_shape(self, body: dict):
        self.assertEqual(body["status"], "failed")
        self.assertEqual(body["dataset_id"], "on008083")
        # Same shape as the total-failure branch, so the backend's one handler
        # reads all three exits identically.
        for key in (
            "store_count", "commit", "converted", "removed", "errors", "failed",
            "failure_count", "data_failures", "deterministic", "pool_breaks",
            "pending_count", "discovered_count", "not_attempted_count",
            "provenance_fetch_failed",
        ):
            self.assertIn(key, body, key)
        self.assertRegex(body["commit"], r"^[0-9a-f]{40}$")

    def test_a_refused_index_writes_a_failed_callback(self):
        generate_zarr.INDEX_SCHEMA_PATH = self.reject_everything()
        rc = self.run_main()
        self.assertEqual(rc, 1)
        body = self.read_callback()
        self.assert_failed_shape(body)
        # And it names the cause: a schema violation has no per-recording failure
        # to point at, so without this the callback says "failed" and no more.
        self.assertIn("index refused", body["error"])

    def test_a_refused_manifest_writes_a_failed_callback(self):
        generate_zarr.MANIFEST_SCHEMA_PATH = self.reject_everything()
        rc = self.run_main()
        self.assertEqual(rc, 1)
        body = self.read_callback()
        self.assert_failed_shape(body)
        self.assertIn("manifest refused", body["error"])

    def test_a_clean_run_with_nothing_to_convert_publishes(self):
        """The control: with both schemas intact this run reaches the upload.

        Without it the two tests above could pass because `main` failed for some
        unrelated reason -- a missing git object, the stub `aws` -- rather than at
        the guard. Here the stub `aws` fails the UPLOAD, and the callback names a
        DIFFERENT cause from either guard, which is what proves the guards were
        what produced the other two.

        The upload failure used to escape as an uncaught RuntimeError, which is
        the very shape #774 removed everywhere else: the process exits non-zero
        having written no callback file, so `hallu-zarr.sh` POSTs nothing, the
        `converting` signal is never superseded, and D1 sits at
        `zarr_status='pending'` with nothing running. It now goes through
        `write_failed_callback` like every other exit that returns 1.
        """
        rc = self.run_main()
        self.assertEqual(rc, 1)
        body = self.read_callback()
        self.assert_failed_shape(body)
        self.assertIn("index publish failed", body["error"])
        # Not a schema guard: those are the other two tests' cause.
        self.assertNotIn("refused", body["error"])


# A real `aws` stand-in for the converter's main()-level tests: a real
# executable over local files, so `s3_read_json`, `s3_download_file`, `aws_cp`
# and the conditional index read/write pair all run for real, subprocess argv
# included.
#
# `s3api get-object`/`put-object` carry GENUINE ETag semantics -- an object's
# ETag is the md5 of its bytes, and put-object honours `--if-match` /
# `--if-none-match` the way S3 does (412 on a mismatch). That is the same
# stand-in test_purge_non_raw_stores.py uses, and it has to be: the two scripts
# now share one conditional write (`generate_zarr.write_index`), so a stub that
# accepted any condition would let a broken one pass in both suites.
STUB_AWS = r"""#!/usr/bin/env python3
import hashlib
import json
import os
import shutil
import sys

ROOT = os.environ["ZARR_TEST_S3_ROOT"]

FLAGS_WITH_VALUES = ("--bucket", "--key", "--body", "--content-type",
                     "--cache-control", "--if-match", "--if-none-match",
                     "--query", "--output")


def local(uri):
    return os.path.join(ROOT, uri.split("/", 3)[3].replace("/", "_"))


def local_key(key):
    return os.path.join(ROOT, key.replace("/", "_"))


def etag(path):
    with open(path, "rb") as fh:
        return chr(34) + hashlib.md5(fh.read()).hexdigest() + chr(34)


def opt(args, name, default=None):
    return args[args.index(name) + 1] if name in args else default


args = [a for a in sys.argv[1:] if not a.startswith("--cli-")]
args = [a for a in args if a not in ("--only-show-errors",)]
# Every invocation, in order, so a test can assert on what the converter did
# NOT do -- "it never fetched the prior events file" is otherwise unobservable.
log = os.environ.get("ZARR_TEST_S3_LOG")
if log:
    with open(log, "a") as fh:
        fh.write(" ".join(args) + "\n")
# One key made to fail, the way a bucket policy or a transient S3 error would,
# so the converter's own non-fatal handling runs for real.
fail_key = os.environ.get("ZARR_TEST_S3_FAIL_KEY")
if fail_key and any(fail_key in a for a in args):
    sys.stderr.write("An error occurred (InternalError) when calling PutObject\n")
    sys.exit(1)
if args[:2] == ["s3", "cp"]:
    src, dst = args[2], args[3]
    if src.startswith("s3://"):
        path = local(src)
        if not os.path.exists(path):
            sys.stderr.write("NoSuchKey\n")
            sys.exit(1)
        # `-` is a read-to-stdout (s3_read_json); anything else is a real
        # download to a path, and it must stay BYTE-exact -- events.parquet is
        # binary, and a text round-trip through stdout would corrupt it.
        if dst == "-":
            with open(path, "rb") as fh:
                sys.stdout.buffer.write(fh.read())
        else:
            shutil.copyfile(path, dst)
    else:
        shutil.copyfile(src, local(dst))
    sys.exit(0)
if args[:2] == ["s3api", "get-object"]:
    path = local_key(opt(args, "--key"))
    positional = [
        a for i, a in enumerate(args[2:], start=2)
        if not a.startswith("--") and args[i - 1] not in FLAGS_WITH_VALUES
    ]
    if not os.path.exists(path):
        sys.stderr.write("An error occurred (NoSuchKey) when calling GetObject\n")
        sys.exit(1)
    shutil.copyfile(path, positional[0])
    print(etag(path))
    sys.exit(0)
if args[:2] == ["s3api", "put-object"]:
    path = local_key(opt(args, "--key"))
    if "--if-match" in args:
        have = etag(path) if os.path.exists(path) else None
        if have != opt(args, "--if-match"):
            sys.stderr.write(
                "An error occurred (PreconditionFailed) when calling PutObject\n"
            )
            sys.exit(1)
    if "--if-none-match" in args and os.path.exists(path):
        sys.stderr.write(
            "An error occurred (PreconditionFailed) when calling PutObject\n"
        )
        sys.exit(1)
    shutil.copyfile(opt(args, "--body"), path)
    print(json.dumps({"ETag": etag(path)}))
    sys.exit(0)
if args[:2] == ["s3api", "head-object"]:
    print('"deadbeef"')
    sys.exit(0)
sys.exit(0)
"""


class TestMainCleanRunAgainstPriorIndexes(unittest.TestCase):
    """A `--clean` run over a REAL prior index, v1 and v3, through `main()`.

    This is the production path (hallu-zarr.sh always passes `--clean`) and no
    test reached it: every prior-index behaviour was exercised through
    `merge_index` directly, which `--clean` hands `prior=None` -- so the facts
    that must survive a clean rebuild travel a route nothing covered. They come
    from the PUBLISHED document rather than from what the merge is given:
    the `pending` attempt counts (reset every run, and a recording could never
    reach the exhaustion cap on the only path production runs), and the count of
    non-raw stores the run drops from the index.

    The stub `aws` is a real executable backed by local files, so `s3_read_json`,
    `aws_cp` and the ETag read all execute.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.repo = os.path.join(self.dir, "repo")
        self.s3 = os.path.join(self.dir, "s3")
        os.makedirs(self.repo)
        os.makedirs(self.s3)

        def run(*args):
            subprocess.run(args, cwd=self.repo, check=True, capture_output=True)

        run("git", "init", "-q", "-b", "main")
        run("git", "config", "user.email", "t@example.org")
        run("git", "config", "user.name", "t")
        with open(os.path.join(self.repo, "dataset_description.json"), "w") as fh:
            json.dump({"Name": "clean fixture", "BIDSVersion": "1.8.0"}, fh)
        run("git", "add", "-A")
        run("git", "commit", "-q", "-m", "init")
        self.head = subprocess.run(
            ["git", "-C", self.repo, "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()

        # A real `aws` stand-in over local files: `cp s3://... -` reads,
        # `cp <file> s3://...` writes, `s3api head-object` answers the ETag read.
        # The root arrives by environment rather than being baked in, so the
        # script is a fixed file with no interpolation.
        bindir = os.path.join(self.dir, "bin")
        os.makedirs(bindir)
        script = os.path.join(bindir, "aws")
        with open(script, "w") as fh:
            fh.write(STUB_AWS)
        os.chmod(script, 0o755)
        self._env = (os.environ.get("PATH"), os.environ.get("ZARR_TEST_S3_ROOT"))
        os.environ["PATH"] = bindir + os.pathsep + (self._env[0] or "")
        os.environ["ZARR_TEST_S3_ROOT"] = self.s3
        self.callback = os.path.join(self.dir, "cb.json")
        self.log = ""

    def tearDown(self):
        path, root = self._env
        if path is not None:
            os.environ["PATH"] = path
        if root is None:
            os.environ.pop("ZARR_TEST_S3_ROOT", None)
        else:
            os.environ["ZARR_TEST_S3_ROOT"] = root
        self._tmp.cleanup()

    def put(self, key, doc):
        with open(os.path.join(self.s3, "on008083_zarr_" + key), "w") as fh:
            json.dump(doc, fh)

    def published(self, key):
        path = os.path.join(self.s3, "on008083_zarr_" + key)
        self.assertTrue(os.path.exists(path), key + " was not published")
        with open(path) as fh:
            return json.load(fh)

    def prior_v3(self, **overrides):
        doc = {
            "dataset_id": "on008083", "format": "nemar-zarr-index",
            "format_version": 3, "source_commit": "a" * 40,
            "store_count": 0, "stores": [], "failure_count": 0, "failures": [],
            "pending_count": 0, "pending": [],
        }
        doc.update(overrides)
        return doc

    def run_main(self):
        argv = [
            "generate_zarr.py",
            "--dataset-id", "on008083",
            "--repo-dir", self.repo,
            "--bucket", "nemar-test",
            "--callback-out", self.callback,
            "--clean",
        ]
        saved, sys.argv = sys.argv, argv
        try:
            with contextlib.redirect_stdout(io.StringIO()) as out:
                rc = generate_zarr.main()
            self.log = out.getvalue()
            return rc
        finally:
            sys.argv = saved

    def callback_body(self):
        with open(self.callback) as fh:
            return json.load(fh)

    def test_a_clean_run_over_a_v1_prior_index(self):
        # The realistic first re-conversion: what is on S3 today is v1.
        self.put("index.json", {
            "dataset_id": "on008083", "format": "nemar-zarr-index",
            "format_version": 1, "source_commit": "a" * 40, "store_count": 1,
            "stores": [{"path": "sub-01/eeg/a_eeg.edf",
                        "zarr": "sub-01/eeg/a_eeg.zarr",
                        "source_key": "SHA256E-s1--a"}],
            "failure_count": 0, "failures": [],
        })
        self.assertEqual(self.run_main(), 0)
        index = self.published("index.json")
        self.assertEqual(index["format_version"], 3)
        self.assertEqual(index["source_commit"], self.head)
        # The v1 entry's recording is not at HEAD, so it does not carry -- and
        # its `source_key` is nowhere in the v3 document.
        self.assertEqual(index["store_count"], 0)
        self.assertNotIn("source_key", json.dumps(index))
        check_index_invariant(index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")
        validate_document(self.published("manifest.json"), MANIFEST_SCHEMA_PATH, "manifest")

    def test_a_clean_run_over_a_v3_prior_index(self):
        self.put("index.json", self.prior_v3())
        self.assertEqual(self.run_main(), 0)
        index = self.published("index.json")
        self.assertEqual(index["format_version"], 3)
        self.assertEqual(index["engine_version"], ZARR_ENGINE_VERSION)
        self.assertEqual(index["layout"]["level0"], "<zarr>/<group>/0")
        check_index_invariant(index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_the_manifest_is_published_alongside_the_index(self):
        self.put("index.json", self.prior_v3())
        self.put("manifest.json", {
            "format": "nemar-zarr-manifest", "format_version": 1,
            "dataset_id": "on008083", "updated_utc": "2026-09-01T00:00:00Z",
            "stores": [{"zarr": "sub-01/eeg/a_eeg.zarr",
                        "source_key": "SHA256E-s1--a", "size_bytes": 1}],
        })
        self.assertEqual(self.run_main(), 0)
        manifest = self.published("manifest.json")
        # Restricted to the rels the index publishes, so the two documents can
        # never disagree about which stores exist. Nothing is served here, so
        # the stale entry goes.
        self.assertEqual(manifest["stores"], [])
        self.assertEqual(manifest["dataset_id"], "on008083")
        validate_document(manifest, MANIFEST_SCHEMA_PATH, "manifest")

    def test_pending_attempts_are_read_from_the_published_index(self):
        """The fact `--clean` would otherwise reset on every run.

        `main` sources `prior_pending` from the document it read, not from what
        it hands the merge -- which under `--clean` is `None`. Without that, a
        recording failing for an infra reason would restart at attempt 1 forever
        and `retry_exhausted` would be unreachable in production.
        """
        path = "sub-01/eeg/a_eeg.edf"
        self.put("index.json", self.prior_v3(
            pending_count=1,
            pending=[{"path": path, "zarr": store_rel_for(path),
                      "reason": "infra_failure", "attempts": 4,
                      "last_error": "RuntimeError: boom",
                      "last_attempt_utc": "2026-09-01T00:00:00Z"}],
        ))
        self.assertEqual(self.run_main(), 0)
        # The recording is not at HEAD any more, so the entry drops rather than
        # ageing -- what is asserted here is that `main` READ it: the attempt
        # history reached the merge, which is the wiring `--clean` breaks.
        self.assertEqual(self.published("index.json")["pending_count"], 0)
        # And the merge does age it when the recording IS still discovered,
        # through the same argument main passes.
        index = merge_index(
            None, "on008083", self.head, [], [], "2026-09-02T00:00:00Z", [],
            [{"path": path, "reason": "infra_failure", "last_error": "boom"}],
            discovered=[path],
            prior_pending=self.prior_v3(
                pending=[{"path": path, "reason": "infra_failure", "attempts": 4}]
            )["pending"],
        )
        # 4 + 1 == PENDING_MAX_ATTEMPTS, so this is the round that promotes it.
        self.assertEqual(index["pending_count"], 0)
        self.assertEqual(index["failures"][0]["code"], "retry_exhausted")
        self.assertEqual(index["failures"][0]["attempts"], PENDING_MAX_ATTEMPTS)

    def test_non_raw_stores_are_dropped_reported_and_logged(self):
        self.put("index.json", self.prior_v3(
            store_count=2,
            stores=[
                {"path": "derivatives/prep/a_eeg.set",
                 "zarr": "derivatives/prep/a_eeg.zarr",
                 "source_tree": "raw", "derived": False},
                {"path": "sourcedata/b_eeg.set", "zarr": "sourcedata/b_eeg.zarr",
                 "source_tree": "raw", "derived": False},
            ],
        ))
        self.assertEqual(self.run_main(), 0)
        body = self.callback_body()
        self.assertEqual(body["non_raw_dropped"], 2)
        # Named in the log, with the tree, so the count has a cause attached.
        self.assertIn("derivatives/prep/a_eeg.set", self.log)
        self.assertIn("sourcedata", self.log)
        index = self.published("index.json")
        self.assertEqual(index["stores"], [])
        self.assertNotIn("legacy_store_count", index)

    def test_the_callback_reports_every_new_field(self):
        self.put("index.json", self.prior_v3())
        self.assertEqual(self.run_main(), 0)
        body = self.callback_body()
        for key in (
            "pending_count", "discovered_count", "not_attempted_count",
            "non_raw_dropped", "provenance_fetch_failed", "manifest_upload_failed",
        ):
            self.assertIn(key, body, key)
        self.assertEqual(body["status"], "ready")
        self.assertIs(body["manifest_upload_failed"], False)
        # Nothing to convert, so the catalog was never read: not a failure.
        self.assertIs(body["provenance_fetch_failed"], False)

    def test_a_missing_prior_index_is_the_first_run_path(self):
        # No document at all: the stub reports NoSuchKey, which must read as
        # "first run" rather than raising.
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.published("index.json")["store_count"], 0)
        self.assertEqual(self.callback_body()["non_raw_dropped"], 0)

    # --- The index publish is a conditional write ------------------------
    #
    # Two processes write `<id>/zarr/index.json`: a converter run and
    # `purge_non_raw_stores.py`. Both read it, work for minutes to hours, then
    # write back what they merged from that read, so an unconditional PUT from
    # either silently reverts the other -- restoring the 4,721 non-raw stores a
    # purge had just dropped, or losing a conversion's new stores while their
    # chunks sit on S3 unreferenced. Both exit 0; nothing anywhere says so.
    #
    # The stub `aws` carries real ETag semantics (md5 of the bytes, 412 on a
    # mismatch), so these drive the actual condition rather than a flag.

    def object_etag(self, key="index.json"):
        """The ETag the stub reports for a published object: md5 of its bytes,
        the same rule the stub's `put-object` and `get-object` use."""
        with open(os.path.join(self.s3, "on008083_zarr_" + key), "rb") as fh:
            return hashlib.md5(fh.read()).hexdigest()

    def log_aws_calls(self):
        """Capture every `aws` argv, in order -- the only way to see that the
        retry actually RE-READ the document rather than resending the same body.
        """
        path = os.path.join(self.dir, "aws.log")
        os.environ["ZARR_TEST_S3_LOG"] = path
        self.addCleanup(lambda: os.environ.pop("ZARR_TEST_S3_LOG", None))
        return lambda: [
            line.strip() for line in open(path) if os.path.exists(path)
        ] if os.path.exists(path) else []

    def publish_competitor_before(self, reads):
        """Publish a DIFFERENT document immediately after the run's first
        `reads` index reads, the way a concurrent purge would.

        Wrapping the real `read_index_with_etag` is the only way to open the
        window deterministically: the ETag the run holds is invalidated after it
        was read and before it is used, which is exactly the race. Nothing in the
        conditional write itself is replaced -- the stub `aws` decides the 412.
        """
        original = generate_zarr.read_index_with_etag
        seen = {"reads": 0}

        def read_then_publish(bucket, dataset_id):
            index, etag = original(bucket, dataset_id)
            seen["reads"] += 1
            if seen["reads"] <= reads:
                # A DIFFERENT body each time (the ETag is the md5 of the bytes),
                # so a second competing write really does invalidate the ETag the
                # retry just read -- republishing identical bytes would leave the
                # ETag unchanged and quietly turn the two-conflict case into the
                # one-conflict case.
                self.put("index.json", self.prior_v3(
                    source_commit="c" * 40, competitor_round=seen["reads"],
                ))
            return index, etag

        generate_zarr.read_index_with_etag = read_then_publish
        self.addCleanup(setattr, generate_zarr, "read_index_with_etag", original)
        return seen

    def test_the_index_publish_is_conditional_on_the_etag_it_read(self):
        self.put("index.json", self.prior_v3())
        calls = self.log_aws_calls()
        self.assertEqual(self.run_main(), 0)
        puts = [c for c in calls() if c.startswith("s3api put-object") and "index.json" in c]
        self.assertEqual(len(puts), 1)
        # The read's ETag, sent back verbatim: an unconditional PUT is what this
        # replaces, and `--if-none-match "*"` here would 412 on every run over an
        # existing document.
        self.assertIn("--if-match", puts[0])
        self.assertNotIn("--if-none-match", puts[0])
        # The callback reports the ETag the PUT itself returned, so it names the
        # version this run wrote rather than whatever a follow-up read would see.
        self.assertEqual(self.callback_body()["index_etag"], self.object_etag())

    def test_a_first_publish_is_conditional_on_there_being_no_document(self):
        calls = self.log_aws_calls()
        self.assertEqual(self.run_main(), 0)
        puts = [c for c in calls() if c.startswith("s3api put-object") and "index.json" in c]
        self.assertEqual(len(puts), 1)
        # `if_match=None` is not "skip the check": it means the object was absent
        # at read time, so a first index published in the meantime is not
        # clobbered either.
        self.assertIn("--if-none-match", puts[0])
        self.assertEqual(self.callback_body()["index_etag"], self.object_etag())

    def test_a_lost_race_is_re_read_re_merged_and_published(self):
        self.put("index.json", self.prior_v3())
        calls = self.log_aws_calls()
        seen = self.publish_competitor_before(reads=1)
        self.assertEqual(self.run_main(), 0)
        # Two reads and two writes: the first write 412'd, and the retry read the
        # NEWER document before recomputing. One read would mean it resent the
        # same body against a fresh ETag, which is the silent clobber wearing a
        # condition.
        self.assertEqual(seen["reads"], 2)
        gets = [c for c in calls() if c.startswith("s3api get-object") and "index.json" in c]
        puts = [c for c in calls() if c.startswith("s3api put-object") and "index.json" in c]
        self.assertEqual(len(gets), 2)
        self.assertEqual(len(puts), 2)
        self.assertIn("re-reading and re-merging once", self.log)
        # This run's document is what ends up published, and the callback names
        # the ETag of the retry's write.
        published = self.published("index.json")
        self.assertEqual(published["source_commit"], self.head)
        self.assertEqual(self.callback_body()["index_etag"], self.object_etag())
        self.assertEqual(self.callback_body()["status"], "ready")
        check_index_invariant(published)
        validate_document(published, INDEX_SCHEMA_PATH, "index")
        # The manifest rides the same publish, so it is not left describing the
        # first attempt's store set.
        validate_document(self.published("manifest.json"), MANIFEST_SCHEMA_PATH, "manifest")

    def test_losing_the_race_twice_fails_loudly_and_publishes_nothing(self):
        self.put("index.json", self.prior_v3())
        seen = self.publish_competitor_before(reads=2)
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(seen["reads"], 2)
        # The other writer's LATEST document is what survives: a third attempt
        # has no reason to win, and overwriting from a body that is already stale
        # again is the rollback this whole mechanism exists to prevent.
        survivor = self.published("index.json")
        self.assertEqual(survivor["source_commit"], "c" * 40)
        self.assertEqual(survivor["competitor_round"], 2)
        # And it is LOUD: the driver POSTs this file, so a run that published
        # nothing must not leave D1 at `converting` forever (#774).
        body = self.callback_body()
        self.assertEqual(body["status"], "failed")
        self.assertIn("index publish conflict", body["error"])
        self.assertIn("::error::", self.log)
        # The manifest is not published either -- it would describe stores the
        # surviving index does not list.
        self.assertFalse(
            os.path.exists(os.path.join(self.s3, "on008083_zarr_manifest.json")),
            "a run that published no index must not publish its manifest",
        )


class TestMainPublishesEventsParquet(unittest.TestCase):
    """`main()` over a real recording, through to `<id>/zarr/events.parquet`.

    The entry point, not the writer: everything the file depends on is derived by
    code the unit tests do not reach -- the worker parses the events.tsv, `record`
    turns it into rows against the entry's OWN groups, `main` orders them by the
    index's store list, uploads, and only then names the file in index.json. A
    writer test cannot catch a `record` that stages nothing.

    Same shape as TestMainCleanRunAgainstPriorIndexes: a real git repo, a real
    stub `aws` over local files, real argument parsing. `--local` reads the
    working tree, so no annex download is needed.
    """

    @classmethod
    def setUpClass(cls):
        try:
            import pyarrow  # noqa: F401
            import pyedflib  # noqa: F401
            import zarr  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.repo = os.path.join(self.dir, "repo")
        self.s3 = os.path.join(self.dir, "s3")
        eeg = os.path.join(self.repo, "sub-01", "ses-1", "eeg")
        os.makedirs(eeg)
        os.makedirs(self.s3)
        self.primary = "sub-01/ses-1/eeg/sub-01_ses-1_task-rest_run-2_eeg.edf"
        build_real_edf(eeg, "sub-01_ses-1_task-rest_run-2_eeg", seconds=30)
        self.onsets = [i * 3.0 + 0.111 for i in range(5)]
        with open(os.path.join(eeg, "sub-01_ses-1_task-rest_run-2_events.tsv"), "w") as fh:
            fh.writelines(
                ["onset\tduration\ttrial_type\tstim_file\n"]
                + [
                    f"{onset}\t0.5\t{'go' if i % 2 == 0 else 'stop'}\tim{i}.png\n"
                    for i, onset in enumerate(self.onsets)
                ]
            )

        def run(*args):
            subprocess.run(args, cwd=self.repo, check=True, capture_output=True)

        run("git", "init", "-q", "-b", "main")
        run("git", "config", "user.email", "t@example.org")
        run("git", "config", "user.name", "t")
        run("git", "add", "-A")
        run("git", "commit", "-q", "-m", "init")

        bindir = os.path.join(self.dir, "bin")
        os.makedirs(bindir)
        script = os.path.join(bindir, "aws")
        with open(script, "w") as fh:
            fh.write(STUB_AWS)
        os.chmod(script, 0o755)
        self._env = (os.environ.get("PATH"), os.environ.get("ZARR_TEST_S3_ROOT"))
        os.environ["PATH"] = bindir + os.pathsep + (self._env[0] or "")
        os.environ["ZARR_TEST_S3_ROOT"] = self.s3
        # Every `aws` invocation, in order: the only way to assert that a run
        # did NOT fetch the prior events file.
        self.aws_log = os.path.join(self.dir, "aws.log")
        os.environ["ZARR_TEST_S3_LOG"] = self.aws_log
        self.callback = os.path.join(self.dir, "cb.json")

    def tearDown(self):
        path, root = self._env
        if path is not None:
            os.environ["PATH"] = path
        if root is None:
            os.environ.pop("ZARR_TEST_S3_ROOT", None)
        else:
            os.environ["ZARR_TEST_S3_ROOT"] = root
        os.environ.pop("ZARR_TEST_S3_LOG", None)
        os.environ.pop("ZARR_TEST_S3_FAIL_KEY", None)
        self._tmp.cleanup()

    def aws_calls(self) -> list[str]:
        if not os.path.exists(self.aws_log):
            return []
        with open(self.aws_log) as fh:
            return [ln for ln in fh.read().splitlines() if ln.strip()]

    def downloads_of(self, name: str) -> list[str]:
        """Calls that READ `name` from S3 (`cp s3://... <dest>`), not writes."""
        return [
            call
            for call in self.aws_calls()
            if call.startswith("s3 cp s3://") and name in call.split()[2]
        ]

    def add_store(self, sub: str, onsets: list[float] | None) -> str:
        """A second/third recording in the same repo, with or without events.
        Returns its repo-relative primary path (uncommitted -- the caller
        commits, so a test controls which run sees it)."""
        eeg = os.path.join(self.repo, sub, "eeg")
        os.makedirs(eeg, exist_ok=True)
        stem = f"{sub}_task-rest_eeg"
        build_real_edf(eeg, stem, seconds=10)
        if onsets is not None:
            with open(os.path.join(eeg, f"{sub}_task-rest_events.tsv"), "w") as fh:
                fh.writelines(
                    ["onset\tduration\ttrial_type\n"]
                    + [f"{onset}\t0.2\tgo\n" for onset in onsets]
                )
        return f"{sub}/eeg/{stem}.edf"

    def commit(self, message: str) -> None:
        subprocess.run(["git", "add", "-A"], cwd=self.repo, check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", message], cwd=self.repo, check=True,
            capture_output=True,
        )

    def run_main(self, *extra):
        argv = [
            "generate_zarr.py",
            "--dataset-id", "on007763",
            "--repo-dir", self.repo,
            "--bucket", "nemar-test",
            "--callback-out", self.callback,
            "--local",
            # Nothing is listening there, so the catalog read fails fast instead
            # of reaching the real api.nemar.org from a unit test.
            "--api-base", "http://127.0.0.1:1",
            *extra,
        ]
        saved, sys.argv = sys.argv, argv
        try:
            with contextlib.redirect_stdout(io.StringIO()) as out:
                rc = generate_zarr.main()
            self.log = out.getvalue()
            return rc
        finally:
            sys.argv = saved

    def published(self, key):
        path = os.path.join(self.s3, "on007763_zarr_" + key)
        self.assertTrue(os.path.exists(path), key + " was not published")
        return path

    def index(self):
        with open(self.published("index.json")) as fh:
            return json.load(fh)

    def callback_body(self):
        with open(self.callback) as fh:
            return json.load(fh)

    def events_table(self):
        import pyarrow.parquet as pq

        return pq.read_table(self.published(EVENTS_PARQUET_NAME)).to_pydict()

    def test_a_clean_run_publishes_the_file_and_names_it_in_the_index(self):
        self.assertEqual(self.run_main("--clean"), 0)
        index = self.index()
        rel = store_rel_for(self.primary)
        self.assertEqual(index["store_count"], 1)
        # The index names the file only because it was uploaded first, so the
        # pointer can never precede the object.
        self.assertEqual(index["events_parquet"], index["data_base"] + EVENTS_PARQUET_NAME)
        self.assertEqual(index["events_row_count"], 5)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

        table = self.events_table()
        self.assertEqual(table["store_path"], [rel] * 5)
        # Joins to stores[].zarr, which is the whole point of the column.
        self.assertEqual({index["stores"][0]["zarr"]}, set(table["store_path"]))
        rate = index["stores"][0]["groups"][0]["rate"]
        self.assertEqual(
            table["sample_index"], [sample_index_for(o, rate) for o in self.onsets]
        )
        self.assertEqual(set(table["group_name"]), {index["stores"][0]["groups"][0]["name"]})
        self.assertEqual(table["subject"], ["01"] * 5)
        self.assertEqual(table["session"], ["1"] * 5)
        self.assertEqual(table["run"], ["2"] * 5)
        # A pass-through column keeps its own name.
        self.assertEqual(table["stim_file"], [f"im{i}.png" for i in range(5)])
        # And the per-store summary agrees with the rows, because one parse made
        # both (#1060's last acceptance criterion).
        self.assertEqual(index["stores"][0]["n_events"], 5)
        self.assertEqual(index["stores"][0]["trial_types"], {"go": 3, "stop": 2})

    def test_the_callback_reports_the_row_count(self):
        self.assertEqual(self.run_main("--clean"), 0)
        body = self.callback_body()
        self.assertEqual(body["events_row_count"], 5)
        self.assertIs(body["events_upload_failed"], False)

    def test_the_manifest_records_the_bytes_the_run_wrote(self):
        """The index says the file exists and how many rows it has; the producer
        manifest says how many BYTES this run uploaded, so "the object on S3 is
        the one this conversion wrote" is a HEAD away rather than a download."""
        self.assertEqual(self.run_main("--clean"), 0)
        with open(self.published("manifest.json")) as fh:
            manifest = json.load(fh)
        self.assertEqual(len(manifest["files"]), 1)
        entry = manifest["files"][0]
        self.assertEqual(entry["name"], EVENTS_PARQUET_NAME)
        self.assertEqual(entry["row_count"], 5)
        self.assertEqual(
            entry["size_bytes"], os.path.getsize(self.published(EVENTS_PARQUET_NAME))
        )
        validate_document(manifest, MANIFEST_SCHEMA_PATH, "manifest")

    def test_a_run_that_publishes_no_file_claims_no_bytes(self):
        # The previous run's file may still be on S3; the manifest must not
        # inherit its size and read as though this run wrote it.
        self.assertEqual(self.run_main("--clean"), 0)
        published = self.published(EVENTS_PARQUET_NAME)
        with open(published, "wb") as fh:
            fh.write(b"not a parquet file")
        self.assertEqual(self.run_main(), 0)
        with open(self.published("manifest.json")) as fh:
            manifest = json.load(fh)
        self.assertNotIn("files", manifest)
        validate_document(manifest, MANIFEST_SCHEMA_PATH, "manifest")

    def test_an_incremental_run_carries_the_rows_forward(self):
        """The store is not reconverted, so the published file is the only place
        its events exist -- exactly like its entry in the index."""
        self.assertEqual(self.run_main("--clean"), 0)
        first = os.path.getmtime(self.published(EVENTS_PARQUET_NAME))
        # Second run at the same commit: nothing to convert, everything carried.
        time.sleep(0.01)
        self.assertEqual(self.run_main(), 0)
        index = self.index()
        self.assertEqual(index["store_count"], 1)
        self.assertEqual(index["events_row_count"], 5)
        self.assertGreater(os.path.getmtime(self.published(EVENTS_PARQUET_NAME)), first)
        table = self.events_table()
        self.assertEqual(table["onset_s"], self.onsets)
        self.assertEqual(table["stim_file"], [f"im{i}.png" for i in range(5)])
        self.assertNotIn("contribute no rows", self.log)

    def test_a_dataset_with_no_events_publishes_no_file(self):
        """Absent means absent: a client must not fetch a file to learn there are
        no events, and `events_parquet` is what says whether to fetch at all."""
        os.remove(os.path.join(
            self.repo, "sub-01/ses-1/eeg/sub-01_ses-1_task-rest_run-2_events.tsv"
        ))
        subprocess.run(["git", "add", "-A"], cwd=self.repo, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-q", "-m", "drop events"],
                       cwd=self.repo, check=True, capture_output=True)
        self.assertEqual(self.run_main("--clean"), 0)
        index = self.index()
        self.assertNotIn("events_parquet", index)
        self.assertNotIn("events_row_count", index)
        self.assertFalse(os.path.exists(
            os.path.join(self.s3, "on007763_zarr_" + EVENTS_PARQUET_NAME)
        ))
        self.assertIsNone(self.callback_body()["events_row_count"])
        self.assertIs(self.callback_body()["events_upload_failed"], False)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_a_reconverted_store_that_lost_its_events_publishes_no_rows(self):
        """The carry-forward defect. "Carried over" has to mean "this run did
        not rebuild it", not "this run produced no rows for it": a store whose
        events.tsv was deleted IS rebuilt, produces nothing, and must not have
        its old rows resurrected from the published file forever."""
        keeper = self.add_store("sub-02", [1.0, 2.0])
        self.commit("add a second store with events")
        self.assertEqual(self.run_main("--clean"), 0)
        rel = store_rel_for(self.primary)
        self.assertEqual(len(set(self.events_table()["store_path"])), 2)

        os.remove(os.path.join(
            self.repo, "sub-01/ses-1/eeg/sub-01_ses-1_task-rest_run-2_events.tsv"
        ))
        self.commit("drop the first store's events")
        self.assertEqual(self.run_main("--clean"), 0)
        table = self.events_table()
        # The reconverted store is gone from the file; the untouched one is not.
        self.assertNotIn(rel, set(table["store_path"]))
        self.assertEqual(set(table["store_path"]), {store_rel_for(keeper)})
        self.assertEqual(self.index()["events_row_count"], 2)
        # ...and it is not reported as an unrecoverable carry-over, because it
        # was not carried over at all.
        self.assertNotIn("contribute no rows", self.log)

    def test_a_first_clean_run_never_fetches_a_prior_for_event_less_stores(self):
        """A store with no events.tsv is reconverted like any other, so it is
        not "carried over" and there is nothing to carry: a first run must not
        fetch a prior file (there is none) or warn about stores it just built."""
        self.add_store("sub-03", None)  # no events.tsv at all
        self.commit("add an event-less store")
        self.assertEqual(self.run_main("--clean"), 0)
        self.assertEqual(self.index()["store_count"], 2)
        self.assertEqual(self.index()["events_row_count"], 5)
        self.assertNotIn("contribute no rows", self.log)
        self.assertEqual(self.downloads_of(EVENTS_PARQUET_NAME), [])

    def test_an_onset_past_the_end_is_published_unclamped(self):
        """A client bound-checks against groups[].n_samples; a clamped index
        would be indistinguishable from an event on the last sample."""
        with open(os.path.join(
            self.repo, "sub-01/ses-1/eeg/sub-01_ses-1_task-rest_run-2_events.tsv"
        ), "a") as fh:
            fh.write("999.0\t0.5\tlate\tim9.png\n")  # the recording is 30 s
        self.commit("add an event past the end")
        self.assertEqual(self.run_main("--clean"), 0)
        index = self.index()
        group = index["stores"][0]["groups"][0]
        table = self.events_table()
        late = table["sample_index"][table["trial_type"].index("late")]
        self.assertEqual(late, sample_index_for(999.0, group["rate"]))
        self.assertGreater(late, group["n_samples"])

    def test_a_store_whose_onsets_all_fail_to_parse_is_warned_and_counted(self):
        """Rows with nothing but null sample indices are events a client cannot
        epoch, and the row count alone cannot show it."""
        with open(os.path.join(
            self.repo, "sub-01/ses-1/eeg/sub-01_ses-1_task-rest_run-2_events.tsv"
        ), "w") as fh:
            fh.write("onset\tduration\ttrial_type\n")
            fh.writelines(["n/a\t0.5\tgo\n", "later\t0.5\tstop\n"])
        self.commit("break every onset")
        self.assertEqual(self.run_main("--clean"), 0)
        self.assertIn("no usable sample index for any event", self.log)
        self.assertEqual(self.callback_body()["events_stores_without_rows"], 1)
        table = self.events_table()
        self.assertEqual(table["sample_index"], [None, None])

    def test_a_healthy_run_counts_no_store_without_rows(self):
        # The control: the counter is 0 on the ordinary path, so the assertion
        # above is about the condition and not about the field always being 1.
        self.assertEqual(self.run_main("--clean"), 0)
        self.assertEqual(self.callback_body()["events_stores_without_rows"], 0)

    def test_a_refused_index_uploads_no_events_file(self):
        """Schema first, uploads second. A refused index means this run
        publishes NOTHING -- and events.parquet is a destructive overwrite of a
        file the live index still describes, so it must not already be gone by
        the time the index is rejected."""
        self.assertEqual(self.run_main("--clean"), 0)
        published = self.published(EVENTS_PARQUET_NAME)
        with open(published, "rb") as fh:
            before = fh.read()
        with open(os.path.join(
            self.repo, "sub-01/ses-1/eeg/sub-01_ses-1_task-rest_run-2_events.tsv"
        ), "a") as fh:
            fh.write("29.0\t0.5\textra\tim9.png\n")  # would change the bytes
        self.commit("add an event")
        reject = os.path.join(self.dir, "reject.schema.json")
        with open(reject, "w") as fh:
            json.dump({"$schema": "https://json-schema.org/draft/2020-12/schema",
                       "not": {}}, fh)
        saved = generate_zarr.INDEX_SCHEMA_PATH
        try:
            generate_zarr.INDEX_SCHEMA_PATH = reject
            self.assertEqual(self.run_main("--clean"), 1)
        finally:
            generate_zarr.INDEX_SCHEMA_PATH = saved
        body = self.callback_body()
        self.assertEqual(body["status"], "failed")
        self.assertIn("index refused", body["error"])
        self.assertIsNone(body["events_row_count"])
        self.assertIs(body["events_upload_failed"], False)
        # The object on S3 is untouched: same bytes as the good run left.
        with open(published, "rb") as fh:
            self.assertEqual(fh.read(), before)

    def test_an_upload_that_precedes_a_rejection_is_reported_on_the_callback(self):
        """The interleaving that CAN still overwrite: a document that passes the
        pre-flight (row count 0) and fails on the real count. The file is
        replaced and the index is refused, so the callback is the only place
        that can say an object was rewritten by a run that published nothing."""
        schema = os.path.join(self.dir, "row-count-zero.schema.json")
        with open(schema, "w") as fh:
            json.dump({
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "type": "object",
                "properties": {"events_row_count": {"const": 0}},
            }, fh)
        saved = generate_zarr.INDEX_SCHEMA_PATH
        try:
            generate_zarr.INDEX_SCHEMA_PATH = schema
            self.assertEqual(self.run_main("--clean"), 1)
        finally:
            generate_zarr.INDEX_SCHEMA_PATH = saved
        body = self.callback_body()
        self.assertEqual(body["status"], "failed")
        self.assertIn("index refused", body["error"])
        # The upload DID happen before the refusal, and the callback says so.
        self.assertEqual(body["events_row_count"], 5)
        self.assertIs(body["events_upload_failed"], False)
        self.assertTrue(os.path.exists(
            os.path.join(self.s3, "on007763_zarr_" + EVENTS_PARQUET_NAME)
        ))
        # ...and no index was published at all.
        self.assertFalse(os.path.exists(os.path.join(self.s3, "on007763_zarr_index.json")))

    def test_a_failed_events_upload_leaves_no_pointer_and_does_not_fail_the_run(self):
        """ADR 0005: the stores and index.json are the serving copy. A failed
        events upload is reported, the index names no file (the object on S3 is
        the older one), and the run still publishes."""
        os.environ["ZARR_TEST_S3_FAIL_KEY"] = EVENTS_PARQUET_NAME
        # aws_cp retries with backoff; one attempt is enough here and keeps the
        # test from sleeping through 14 seconds of real backoff.
        saved = generate_zarr._aws.__kwdefaults__["retries"]
        try:
            generate_zarr._aws.__kwdefaults__["retries"] = 1
            self.assertEqual(self.run_main("--clean"), 0)
        finally:
            generate_zarr._aws.__kwdefaults__["retries"] = saved
            os.environ.pop("ZARR_TEST_S3_FAIL_KEY", None)
        index = self.index()
        self.assertEqual(index["store_count"], 1)
        self.assertNotIn("events_parquet", index)
        self.assertNotIn("events_row_count", index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")
        body = self.callback_body()
        self.assertEqual(body["status"], "ready")
        self.assertIs(body["events_upload_failed"], True)
        self.assertIsNone(body["events_row_count"])
        self.assertIn("events.parquet was not published", self.log)
        self.assertFalse(os.path.exists(
            os.path.join(self.s3, "on007763_zarr_" + EVENTS_PARQUET_NAME)
        ))

    def test_without_pyarrow_the_run_succeeds_and_publishes_no_events(self):
        """The Hallu fallback install (biosigio only, no requirements.txt) has
        no pyarrow. That must cost the events file and nothing else -- not the
        conversion, and not a `failed` flag, since nothing was attempted."""
        saved = sys.modules.get("pyarrow", "absent")
        try:
            # A real import failure, in the import system, not a patched
            # function: `None` in sys.modules is what CPython raises ImportError
            # for, which is exactly what a venv without the package does.
            sys.modules["pyarrow"] = None  # type: ignore[assignment]
            self.assertEqual(self.run_main("--clean"), 0)
        finally:
            if saved == "absent":
                sys.modules.pop("pyarrow", None)
            else:
                sys.modules["pyarrow"] = saved
        index = self.index()
        self.assertEqual(index["store_count"], 1)
        self.assertNotIn("events_parquet", index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")
        body = self.callback_body()
        self.assertEqual(body["status"], "ready")
        self.assertIsNone(body["events_row_count"])
        self.assertIs(body["events_upload_failed"], False)
        self.assertIn("pyarrow is not installed", self.log)

    def test_an_unreadable_prior_file_is_reported_not_fatal(self):
        """ADR 0005: the stores and index.json are the serving copy, so a failure
        to produce this one is reported and the run still publishes.

        The index then names NO file -- deliberately. The object on S3 is the
        older one, and pointing at it from a new index would claim rows for
        stores this run's index may not describe. A `--clean` run rebuilds it
        from scratch, which is the recovery.
        """
        self.assertEqual(self.run_main("--clean"), 0)
        published = self.published(EVENTS_PARQUET_NAME)
        with open(published, "wb") as fh:
            fh.write(b"not a parquet file")
        self.assertEqual(self.run_main(), 0)  # incremental: every store carried
        index = self.index()
        self.assertEqual(index["store_count"], 1)
        self.assertNotIn("events_parquet", index)
        self.assertNotIn("events_row_count", index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")
        body = self.callback_body()
        self.assertEqual(body["status"], "ready")
        self.assertIsNone(body["events_row_count"])
        # The flag is what separates "this dataset has no events" from "we could
        # not say what its events are".
        self.assertIs(body["events_upload_failed"], True)
        self.assertIn("events.parquet was not published", self.log)
        # The unreadable object is left exactly as it was rather than being
        # overwritten with a half-built file.
        with open(published, "rb") as fh:
            self.assertEqual(fh.read(), b"not a parquet file")


class TestConvertOneEndToEnd(unittest.TestCase):
    """`convert_one` in LOCAL mode over a real recording, up to the upload.

    The store entry is assembled here -- `store_metadata`'s spread, the events
    summary, the `units_report` annotation, the SSS flags -- and every test of
    those pieces called them individually. So the assembly itself, which is
    where a key gets mis-set or dropped, was covered by nothing.

    `--local` reads the working tree directly (the Hallu path after `nemar
    dataset download`), so no S3 is needed until the `aws s3 sync`, which the
    stub below absorbs. Everything before it is the real code on real bytes.
    """

    @classmethod
    def setUpClass(cls):
        try:
            import pyedflib  # noqa: F401
            import zarr  # noqa: F401
        except Exception as exc:
            raise unittest.SkipTest(f"conversion deps unavailable: {exc}") from exc

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.repo = os.path.join(self.dir, "repo")
        self.eeg = os.path.join(self.repo, "sub-01", "eeg")
        os.makedirs(self.eeg)
        self.primary = "sub-01/eeg/sub-01_task-rest_eeg.edf"
        build_real_edf(self.eeg, "sub-01_task-rest_eeg", seconds=30)
        with open(os.path.join(self.eeg, "sub-01_task-rest_channels.tsv"), "w") as fh:
            fh.writelines(
                ["name\ttype\tunits\n"] + [f"E{i + 1}\tEEG\tV\n" for i in range(4)]
            )
        with open(os.path.join(self.eeg, "sub-01_task-rest_events.tsv"), "w") as fh:
            fh.writelines(
                ["onset\tduration\ttrial_type\n"]
                + [f"{i * 2.0}\t0.5\t{'go' if i % 2 == 0 else 'stop'}\n"
                   for i in range(8)]
            )
        # `aws s3 sync` is the only external call convert_one makes in local
        # mode; a real no-op executable absorbs it.
        bindir = os.path.join(self.dir, "bin")
        os.makedirs(bindir)
        with open(os.path.join(bindir, "aws"), "w") as fh:
            fh.write("#!/bin/sh\nexit 0\n")
        os.chmod(os.path.join(bindir, "aws"), 0o755)
        self._path = os.environ["PATH"]
        os.environ["PATH"] = bindir + os.pathsep + self._path
        self._work = tempfile.TemporaryDirectory()

    def tearDown(self):
        os.environ["PATH"] = self._path
        self._work.cleanup()
        self._tmp.cleanup()

    def convert(self, head_files=None, dataset_row=None, provenance_failed=False):
        files = head_files if head_files is not None else {
            self.primary,
            "sub-01/eeg/sub-01_task-rest_channels.tsv",
            "sub-01/eeg/sub-01_task-rest_events.tsv",
        }
        generate_zarr._init_worker({
            "repo": self.repo, "bucket": "nemar-test", "dataset_id": "on007763",
            "head": "b" * 40, "head_files": files, "local": True,
            "tmp": self._work.name, "updated": "2026-09-02T00:00:00Z",
            "contract_base": "https://zarr.nemar.org",
            "engine_version": "3",
            "dataset_row": dataset_row,
            "provenance_fetch_failed": provenance_failed,
            "mem_budget": None, "hard_ceiling": None, "projections": {},
        })
        return convert_one(self.primary)

    def test_the_entry_carries_the_sidecar_annotation(self):
        result = self.convert()
        self.assertTrue(result["ok"], result.get("error"))
        entry = result["entry"]
        report = entry["units_report"]
        # Which sidecar shaped the store, and that the CONVERTER chose it rather
        # than the exporter stumbling on a sibling -- two separate claims, both
        # of which matter on the MaxShield path where sibling detection finds
        # nothing.
        self.assertIs(report["sidecar_supplied"], True)
        self.assertEqual(report["sidecar"], "sub-01/eeg/sub-01_task-rest_channels.tsv")
        self.assertIs(report["units_column_present"], True)
        self.assertNotIn("channels_tsv_read_error", entry)

    def test_the_entry_is_a_complete_v3_store_entry(self):
        entry = self.convert()["entry"]
        self.assertEqual(entry["path"], self.primary)
        self.assertEqual(entry["zarr"], store_rel_for(self.primary))
        self.assertEqual(entry["source_tree"], "raw")
        self.assertIs(entry["derived"], False)
        self.assertEqual(entry["n_events"], 8)
        self.assertEqual(entry["trial_types"], {"go": 4, "stop": 4})
        self.assertEqual(entry["modalities"], ["eeg"])
        self.assertGreaterEqual(entry["groups"][0]["n_view_levels"], 1)
        # And `source_key` is NOT here: it moved to the manifest (#1178 item 5).
        self.assertNotIn("source_key", entry)
        self.assertIn("source_key", self.convert()["manifest"])

    def test_the_entry_validates_inside_a_real_index(self):
        # The assembled entry has to satisfy the closed store schema, which is
        # what the producer enforces before publishing.
        entry = self.convert()["entry"]
        index = merge_index(
            None, "on007763", "b" * 40, [entry], [], "2026-09-02T00:00:00Z",
            [], [], discovered=[self.primary],
        )
        check_index_invariant(index)
        validate_document(index, INDEX_SCHEMA_PATH, "index")

    def test_an_unreadable_sidecar_is_recorded_not_collapsed(self):
        """A channels.tsv that APPLIES but cannot be read must not look like a
        dataset that ships none: both leave `units_report` absent, and only one
        of them means the store is serving importer units unintentionally."""
        # Declared at HEAD, absent from the working tree and from git: the read
        # fails the way a pack/tree desync would.
        files = {self.primary, "sub-01/sub-01_channels.tsv"}
        entry = self.convert(head_files=files)["entry"]
        self.assertIs(entry["channels_tsv_read_error"], True)
        self.assertNotIn("units_report", entry)

    def test_it_converts_with_a_failed_provenance_fetch(self):
        """A catalog outage must not cost a conversion.

        The store's `nemar` attrs then carry nulls plus
        `provenance_fetch_failed: true`; that the flag lands in the ATTRS is
        asserted in TestRealRecordingV3Fields (the store is deleted by
        `convert_one`'s `finally`, so it cannot be read back from here). What
        this covers is the path itself: the flag threads through the worker
        context without breaking the conversion.
        """
        result = self.convert(dataset_row=None, provenance_failed=True)
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["entry"]["path"], self.primary)


if __name__ == "__main__":
    unittest.main()
