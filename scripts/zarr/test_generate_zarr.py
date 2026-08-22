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

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import generate_zarr
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
    apply_worker_mem_limit,
    MEM_LIMIT_FLOOR_BYTES,
    MEM_LIMIT_SLACK,
    admission_reserve_bytes,
    streaming_peak_bytes,
    reset_peak_rss,
    peak_rss_bytes,
    inmem_factor_for,
    calibration_summary,
    INMEM_MEM_FACTOR,
    usable_ram_bytes,
    memory_failure_result,
    count_infra_failures,
    RecordingMemoryExceeded,
    MaxShieldUncalibrated,
    maxshield_calibration_for,
    MAXSHIELD_MEM_FACTOR,
    projected_peak_bytes,
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
)


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
            "source_commit": "old",
            "stores": [
                {"zarr": "sub-01/eeg/a_eeg.zarr", "store": "old-a"},
                {"zarr": "sub-02/eeg/b_eeg.zarr", "store": "keep-b"},
            ],
        }
        converted = [{"zarr": "sub-01/eeg/a_eeg.zarr", "store": "new-a"}]
        index = merge_index(
            prior, "nm000104", "newsha", converted, ["sub-02/eeg/b_eeg.zarr"], "2026-06-02T00:00:00Z"
        )
        self.assertEqual(index["source_commit"], "newsha")
        self.assertEqual(index["store_count"], 1)
        self.assertEqual(index["format"], "nemar-zarr-index")
        self.assertEqual(index["stores"], [{"zarr": "sub-01/eeg/a_eeg.zarr", "store": "new-a"}])

    def test_no_prior_builds_fresh(self):
        index = merge_index(
            None, "nm000104", "sha", [{"zarr": "x/y_eeg.zarr"}], [], "2026-06-02T00:00:00Z"
        )
        self.assertEqual(index["store_count"], 1)
        self.assertEqual([s["zarr"] for s in index["stores"]], ["x/y_eeg.zarr"])

    def test_stores_sorted_by_zarr_path(self):
        converted = [{"zarr": "b.zarr"}, {"zarr": "a.zarr"}]
        index = merge_index(None, "nm000104", "sha", converted, [], "2026-06-02T00:00:00Z")
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
            None, "nm000104", "sha", [{"zarr": "a_eeg.zarr", "path": "a_eeg.set"}], [],
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
            "source_commit": "old",
            "stores": [],
            "failures": [{"path": "x_eeg.set", "zarr": "x_eeg.zarr",
                          "code": "corrupt_or_truncated", "reason": "..."}],
        }
        index = merge_index(
            prior, "nm000104", "new", [{"zarr": "x_eeg.zarr", "path": "x_eeg.set"}], [],
            "2026-06-13T00:00:00Z", [],
        )
        self.assertEqual(index["failure_count"], 0)
        self.assertEqual(index["store_count"], 1)

    def test_merge_index_path_never_in_both_stores_and_failures(self):
        # A recording that newly fails drops its stale store entry.
        prior = {
            "source_commit": "old",
            "stores": [{"zarr": "x_eeg.zarr", "path": "x_eeg.set"}],
            "failures": [],
        }
        index = merge_index(
            prior, "nm000104", "new", [], [], "2026-06-13T00:00:00Z",
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
            "source_commit": "old", "stores": [],
            "failures": [{"path": "gone_eeg.set", "zarr": "gone_eeg.zarr",
                          "code": "not_continuous", "reason": "..."}],
        }
        index = merge_index(
            prior, "nm000104", "new", [], ["gone_eeg.zarr"], "2026-06-13T00:00:00Z", [],
        )
        self.assertEqual(index["failure_count"], 0)

    def test_merge_index_drops_stale_failures_for_now_excluded_paths(self):
        # A carried-forward failure for a path now excluded (derivatives/
        # sourcedata/code) must not persist forever: it will never be
        # reconverted, so it would otherwise show users a stale failure for a
        # file we deliberately no longer serve. A genuine current failure for
        # a still-discoverable path must survive alongside it.
        prior = {
            "source_commit": "old",
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
            prior, "nm000104", "new", [], [], "2026-06-13T00:00:00Z", [],
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
            None, "on005520", "sha", [], sorted(orphans),
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

    def test_non_memory_error_before_reset_is_still_uncoded_infra(self):
        # The generic handler never touched rss_trusted, so it was already fine;
        # assert it stays that way rather than being swept into the typed branch.
        gz = self._inject(RuntimeError("something else"))
        res = gz.convert_one("sub-01/eeg/sub-01_task-x_eeg.set", 4 * 1024**3)
        self.assertFalse(res["ok"])
        self.assertIsNone(res["code"])


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
        rows = {r["ext"]: r for r in calibration_summary(measured, projections)}
        self.assertEqual(rows[".set"]["n"], 2)
        self.assertEqual(rows[".set"]["max_ratio"], 3.0)  # the worst, not the mean
        self.assertEqual(rows[".vhdr"]["max_ratio"], 1.2)
        # The peak reported must belong to the SAME recording as the ratio, or the
        # summary attributes one recording's size to another's overrun.
        self.assertEqual(rows[".set"]["max_peak_bytes"], 3000)

    def test_worst_format_sorts_first(self):
        projections = {"a.set": 1000, "b.vhdr": 1000}
        measured = {"a.set": 4000, "b.vhdr": 1100}
        self.assertEqual(calibration_summary(measured, projections)[0]["ext"], ".set")

    def test_suggested_factor_scales_the_current_one(self):
        # Advisory only: it says what WOULD have covered the worst case, and is
        # never applied automatically -- one pathological recording must not
        # silently re-tune the archive.
        rows = calibration_summary({"a.set": 2000}, {"a.set": 1000})
        self.assertEqual(rows[0]["suggested_factor"], round(INMEM_MEM_FACTOR * 2, 1))

    def test_streamed_recordings_get_no_factor_suggestion(self):
        # A streamed recording's projection is the flat STREAM_PEAK_BYTES,
        # unrelated to on-disk size, so multiplying a blow-up factor by its
        # overrun ratio yields a number that looks like a factor but is not one.
        rows = calibration_summary(
            {"a.edf": STREAM_PEAK_BYTES * 2}, {"a.edf": STREAM_PEAK_BYTES}
        )
        self.assertEqual(rows[0]["path"], "stream")
        self.assertNotIn("suggested_factor", rows[0])

    def test_the_same_format_is_split_by_which_path_it_took(self):
        rows = calibration_summary(
            {"a.edf": 100, "b.edf": STREAM_PEAK_BYTES * 2},
            {"a.edf": 50, "b.edf": STREAM_PEAK_BYTES},
        )
        self.assertEqual({r["path"] for r in rows}, {"inmem", "stream"})

    def test_recordings_without_a_projection_are_ignored(self):
        self.assertEqual(calibration_summary({"ghost.set": 10}, {}), [])

    def test_empty_input_is_empty_output(self):
        self.assertEqual(calibration_summary({}, {}), [])


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

if __name__ == "__main__":
    unittest.main()
