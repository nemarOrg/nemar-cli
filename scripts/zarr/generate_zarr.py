#!/usr/bin/env python3
"""NEMAR Zarr serving-copy generator (epic nemarOrg/nemar-cli#684, Stream B).

Runs on the SDSC Hallu cron, driven by ``scripts/zarr/hallu-zarr.sh`` (ADR 0029).
It previously lived in nemarDatasets/.github and ran as run-generate-zarr.yml;
that workflow is retired -- Actions cannot finish a large dataset inside the
120-minute cap. Converts the BIDS recordings that changed since the last
conversion into per-recording biosigIO Zarr v3 serving stores, uploads them to
``s3://<bucket>/<id>/zarr/...`` (LATEST-ONLY: overwrite in place, delete on
source removal), maintains ``s3://<bucket>/<id>/zarr/index.json``, and writes a
callback body the driver script POSTs to ``/webhooks/zarr-ready``.

The conversion itself is biosigIO (``Recording.from_file -> bids.apply_events_tsv
-> rec.to_zarr``); this driver owns the BIDS-tree orchestration: change
detection, annex-content materialisation, S3 sync, and the index.

Design notes
------------
* The dataset repo is cloned by the workflow (full history, ``--no-checkout``);
  this script reads the tree with git plumbing (``ls-tree``/``cat-file``/``diff``)
  exactly like ``emit_manifest.py``, and pulls annex *content* from
  ``s3://<bucket>/<id>/objects/<key>`` with authenticated ``aws s3 cp`` (works for
  private datasets, unlike the archive workflow's public-HTTP fetch).
* Incremental: the prior ``index.json`` records the commit it was built from;
  we ``git diff <prior>..HEAD`` and convert only the affected recordings, mapping
  a changed companion (``.fdt``/``.eeg``/``.vmrk``) or ``*_events.tsv`` back to its
  sibling recording. ``--full`` (or a missing/!ancestor prior) converts everything.
* BIDS raw only: ``derivatives/``, ``sourcedata/``, and ``code/`` never hold a BIDS
  raw recording, so ``is_excluded_from_discovery`` excludes them (and BIDS-reserved
  MEG calibration filenames) from every discovery path -- ``is_primary``, the
  directory-recording derivation, and the diff-based companion/events routing. This
  scope matches nemarOrg/nemar-cli ADR 0027 (the backend dispatch-gate side of the
  same decision). Excluding a tree from *future* conversion must not be read as
  "gone from HEAD": ``compute_clean_orphans`` explicitly protects already-published
  stores under an excluded tree from ``--clean``'s orphan-removal so this scope
  change alone never deletes a store; that cleanup is separate, explicitly-authorized
  follow-up work (nemarOrg/nemar-cli#1095 / nemarOrg/nemar-cli#1097).
* Directory-keyed recordings: CTF ``.ds``, MEF3 ``.mefd``, and 4D/BTi are each a
  DIRECTORY of files git tracks individually, never the directory itself.
  ``.ds``/``.mefd`` are derived from an extension on a path component
  (``dir_recording_of`` / ``is_dir_recording`` / ``dir_recordings``); 4D/BTi carries
  no extension at all (BIDS names it a bare ``..._meg/`` directory), so it is
  detected by CONTENT instead -- a ``c,rf*`` processed-data file alongside a sibling
  ``config`` file (``bti_recordings``), the same gate biosigIO's importer uses, so
  the two sides agree on what counts as a recording. Requires biosigio>=1.2.3 (the
  release that added ``.mefd``/4D-BTi import); see ``requirements.txt``.
* The pure helpers (path classification, worklist, index merge) carry the logic
  and are unit-tested in ``test_generate_zarr.py``; the I/O lives in ``main``.
"""

from __future__ import annotations

import argparse
import contextlib
import errno
import json
import math
import os
import pickle
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from collections.abc import MutableMapping
from concurrent.futures import (
    FIRST_COMPLETED,
    ProcessPoolExecutor,
    ThreadPoolExecutor,
    wait,
)
from concurrent.futures.process import BrokenProcessPool
from datetime import datetime, timezone
from typing import Any, Literal, Protocol, TypedDict

# The engine stamp lives in `zarr_queue`, whose column decides which already-done
# datasets re-convert (ADR 0033). The index republishes it so a consumer can tell
# WHICH generation of the discovery rules produced a store without reading the
# queue, and so an operator can spot a node running a stale driver. Imported
# rather than copied: two constants would drift the moment one was bumped. This is
# a sibling module in the same directory, which is on sys.path both when this file
# is run as a script and when the test suite imports it.
from zarr_queue import ZARR_ENGINE_VERSION

# --- Path classification -------------------------------------------------

# Primary recording containers biosigIO reads directly. A change to one of
# these (or its companion / events sidecar) rebuilds exactly one `.zarr` store.
# KIT/Yokogawa MEG is a single `.con`/`.sqd`/`.kdf` file (its `.mrk`/`.elp`/`.hsp`
# coregistration sidecars are not needed for the signal serving copy).
PRIMARY_EXTS = (".set", ".edf", ".bdf", ".vhdr", ".fif", ".con", ".sqd", ".kdf")
# Companions that share a recording's filename stem and carry its samples or
# markers; a change confined to one still rebuilds the recording's store.
COMPANION_EXTS = (".fdt", ".eeg", ".vmrk")
# CTF MEG is a `.ds` DIRECTORY (`.meg4` data + `.res4`/`.hc`/... headers), and MEF3
# iEEG is a `.mefd` DIRECTORY (`<CHANNEL>.timd/<CHANNEL>-000000.segd/` holding
# `.tdat`/`.tidx`/`.tmet` per channel segment -- a real session can hold well over a
# hundred `.timd` channel dirs, see on006392's 194). Neither is a single file, so
# neither ever appears in `git ls-tree` as one path -- each is derived from the files
# under it and treated as one recording keyed at the directory itself. Both are
# EXTENSION-keyed (the directory's own name ends in `.ds`/`.mefd`), which is what
# lets `dir_recording_of` derive the recording from any member path without
# consulting `head_files`; contrast 4D/BTi below, which is directory-based too but
# carries no extension and needs content-based detection instead.
CTF_DS_EXT = ".ds"
# api.nemar.org sits behind Cloudflare, which 403s the default Python-urllib
# User-Agent as a bot (verified 2026-09-03: the same GET is 200 under any other
# string). The first production run on engine 3 fetched provenance without one
# and flagged every store `provenance_fetch_failed`, so this is load-bearing for
# the whole conversion wave, not a courtesy header. `zarr_queue.USER_AGENT`
# covers the catalog fetch for the same reason; the converter identifies itself
# distinctly so the two are separable in access logs.
USER_AGENT = f"nemar-zarr-converter/{ZARR_ENGINE_VERSION} (+https://github.com/nemarOrg/nemar-cli)"

MEFD_EXT = ".mefd"
DIR_RECORDING_EXTS = (CTF_DS_EXT, MEFD_EXT)

# 4D Neuroimaging/BTi MEG: BIDS gives the recording directory NO extension at all
# (`sub-<label>[_ses-<label>]_task-<label>[_run-<index>]_meg/`), so unlike
# `.ds`/`.mefd` it cannot be keyed by a path-component extension -- detection is by
# CONTENT instead (`bti_recordings`, `bti_dir_of`): a directory qualifies only when
# it directly (non-nested) contains a `c,rf*`-prefixed processed-data file AND a
# sibling `config` file. Requiring `c,rf*` is the point: `config` alone is common to
# almost every datalad-tracked dataset (`.datalad/config`) and would false-positive
# on nearly every repo if used by itself. This mirrors biosigIO's own
# `importers.meg._find_bti_pdf` gate exactly, so the converter and biosigIO agree on
# what counts as a BTi recording.
_BTI_PDF_PREFIX = "c,rf"
_BTI_CONFIG_NAME = "config"

# Trees that can never hold a BIDS raw recording, so a file under one is never
# a servable recording no matter its extension. Mirrors `emit_records.py`'s
# `derivatives`/`sourcedata` exclusion shape (this repo), extended to also
# cover `code/` -- see `is_excluded_from_discovery` below and
# nemarOrg/nemar-cli ADR 0027 for the matching backend dispatch-gate scope.
EXCLUDED_TREES = ("derivatives", "sourcedata", "code")

# BIDS-reserved Elekta/Neuromag MEG calibration filenames: fine-calibration
# and crosstalk-correction data, never a recording. `_acq-crosstalk_meg.fif`
# matches PRIMARY_EXTS by extension alone and, read as a recording, raises a
# correctly-failing `ValueError: Could not find measurement data` (confirmed
# in on006012, on006720) -- the right verdict on the wrong question.
_BIDS_CALIBRATION_SUFFIXES = ("_acq-crosstalk_meg.fif", "_acq-calibration_meg.dat")

INDEX_FORMAT = "nemar-zarr-index"
# v3 (nemarOrg/nemar-cli#1059, #1197, #1178 item 5). Additive over v1 for every
# field a consumer already read, with ONE removal: per-store `source_key` moved to
# the sibling producer manifest (see MANIFEST_FORMAT), because nothing on the
# website read it and it was 18 percent of nm000281's 12.8 MB index. v2 was never
# published; the number is skipped so "v3" means one thing everywhere.
INDEX_FORMAT_VERSION = 3
MANIFEST_FORMAT = "nemar-zarr-manifest"
MANIFEST_FORMAT_VERSION = 1

# JSON Schemas the published documents are validated against before upload. They
# live in the repo (`shared/`) rather than beside this file so the backend can
# serve the same bytes at GET /schemas/zarr-index-v3.json.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
INDEX_SCHEMA_PATH = os.path.join(_REPO_ROOT, "shared", "zarr-index.schema.json")
MANIFEST_SCHEMA_PATH = os.path.join(_REPO_ROOT, "shared", "zarr-manifest.schema.json")

# The STABLE base a client may hardcode. `data_base`/`s3_uri` say where the bytes
# happen to live today and are derived from --bucket/--region; this one is
# declared, because the whole point of publishing it is that it can stay put while
# the storage behind it moves. `--contract-base` overrides it (hallu-zarr.sh
# passes the test host in --test mode).
DEFAULT_CONTRACT_BASE = "https://zarr.nemar.org"
# Catalog the per-dataset provenance (DOI, license, HED version) is read from once
# per run for the stores' `nemar` root attribute (#1064).
DEFAULT_API_BASE = "https://api.nemar.org"

# A published index MUST name the commit it was built from. on008083 published
# `source_commit: ""` while D1 held the real SHA, which makes the index
# unreproducible and the incremental diff impossible (#1197). Enforced in
# `merge_index`, which refuses to build a document without one.
COMMIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")

# The store layout, published verbatim in every index. An MCP recipe (ADR 0025)
# has to be computable from index.json plus ONE array-metadata fetch, with no
# probing: the broker is stateless, so anything it cannot read from the index it
# has to discover by request, and discovery-by-404 is what #1178 item 2 was about.
# The index already carries `n_view_levels` and the geometry per group; these are
# the path templates and the sample-value rule that turn those numbers into
# actual reads. `const` in the schema, so a client may hardcode them after
# checking `format_version` -- and so a change to the layout is a schema change
# rather than a silent one.
INDEX_LAYOUT = {
    "level0": "<zarr>/<group>/0",
    "view": "<zarr>/<group>/view/<L>",
    "view_levels": "1..n_view_levels from the group attrs",
    "scale_offset": (
        "level-0 array attrs scale[] and offset[]; physical = digital * scale + offset"
    ),
    # Stated against data_base rather than contract_base because it is one object,
    # not a store path. Whether it EXISTS is said by the top-level
    # `events_parquet` field, which is absent for a dataset with no events (#1060)
    # -- the template here is how to read it, not a promise that it is there.
    "events": "<data_base>events.parquet",
}

# Conversion attempts a `pending` recording gets before the producer stops
# expecting it to convert and promotes it to a typed `retry_exhausted` failure.
# Matches `zarr_queue.PENDING_MAX_ROUNDS`, which caps the queue side of the same
# loop: a recording that will never convert must stop consuming the queue.
PENDING_MAX_ATTEMPTS = 5

# Per-modality canonical rate caps (Hz) passed to to_zarr. Keys are biosigIO's
# uppercase modality names; the defaults already match, set explicitly so the
# NEMAR caps are visible/auditable here rather than implied by the library.
MODALITY_RATES = {"EEG": 250, "MEG": 250, "IEEG": 1000, "EMG": 1000}

# Large recordings are converted with biosigIO's STREAMING path (bounded RAM)
# instead of the in-memory `Recording.from_file -> to_zarr`, which loads the whole
# recording at float64 2-3x and OOMs on multi-GB iEEG/MEG (e.g. nm000253's 18 GB
# BrainVision recordings). Gated on (a) size and (b) the format having a streaming
# reader that agrees with its in-memory reader exactly. That condition started out
# as "MNE-native" (BrainVision/FIF go through MNE either way) and is no longer a
# synonym for it: KIT and EDF/BDF stream too, each on its own lower threshold,
# which is why they get their own tuples below. EEGLAB `.set` is now the only
# format that never streams at any size (ADR 0030) -- `should_stream` is the
# authority, not this paragraph.
# No single version floor: EDF streaming needs biosigio>=1.2.0, MEF3/BTi discovery
# >=1.2.3, HDF5 `.set` >=1.2.4, CTF coil naming >=1.2.5. `requirements.txt` carries
# the pin and the reason for each bump; read it there rather than tracking a number
# here. Threshold is env-overridable for the Hallu cron.
# CTF `.ds` is MNE-native too (large MEG), so it streams as well. So is MEF3
# `.mefd`: `mne.io.read_raw_mef` supports `preload=False`, and biosigio's streaming
# exporter opens it lazily the same way as CTF/FIF (`_MneSource`, biosigio>=1.2.3)
# -- worth it, since a MEF3 iEEG session can be multi-gigabyte. 4D/BTi streams too
# (`mne.io.read_raw_bti(preload=False)`, same `_MneSource` lazy path) but is NOT
# extension-keyed, so it cannot join this tuple; `should_stream` below gives it its
# own extension-less branch at this SAME common threshold, deliberately not the
# lower KIT one (see the KIT comment below for why KIT differs).
# 256 MiB, matching KIT and EDF. It was 2 GiB, and that gap is what sank
# on004917: its 24 BrainVision recordings are 1.18-2.25 GB, so all but one sat
# just UNDER the threshold, took the unbounded in-memory path, and were admitted
# seven at a time against a projection running half their real cost.
#
# There was never a principled reason for BrainVision to need a threshold eight
# times higher than EDF's -- the driver's own note says BrainVision goes through
# MNE on both paths, so parity holds either way. The in-memory path survives only
# as a fast path for genuinely small recordings, where process startup and the
# scratch memmap would cost more than the load itself.
#
# This supersedes the ZARR_STREAM_MIN_BYTES=268435456 crontab override added as a
# mitigation on 2026-08-22; remove that override when this reaches the node
# (ADR 0030).
STREAM_MIN_BYTES = int(os.environ.get("ZARR_STREAM_MIN_BYTES", str(256 * 1024**2)))
STREAM_EXTS = (".vhdr", ".fif", ".ds", MEFD_EXT)
# KIT/Yokogawa .con/.sqd/.kdf load FULLY in memory (read_raw_kit has no lazy
# path), and a many-channel MEG file expands to ~5x its bytes as float64 + the
# biosigIO DataFrame + the resample copy -- so even a ~600 MB .con OOM-kills a
# pool worker at JOBS-way concurrency (which then breaks the whole pool). Route
# them through the streaming converter from the common threshold (since #1112
# common one: streaming peaks ~3 GB regardless of file size, and small KIT
# files stay on the faster in-memory path. 4D/BTi does NOT belong in this group
# even though it is also MEG and also directory-based: `read_raw_bti` DOES support
# `preload=False` (confirmed via biosigio's streaming exporter, which opens it lazily
# exactly like CTF/FIF/`.mefd`), so it has none of KIT's "no lazy path" problem and
# stays on the `STREAM_EXTS` threshold instead (see
# `should_stream`).
STREAM_KIT_EXTS = (".con", ".sqd", ".kdf")
STREAM_KIT_MIN_BYTES = int(os.environ.get("ZARR_STREAM_KIT_MIN_BYTES", str(256 * 1024**2)))

# EDF/BDF have no lazy MNE reader parity: the in-memory path reads them via
# pyedflib and MNE rescales EDF to SI volts, so streaming EDF via MNE would NOT
# match a re-run on the in-memory path. biosigIO >= 1.2.0 streams EDF/BDF via
# pyedflib (importer parity), so ONLY then may we route them to the streamer;
# on an older lib EDF stays in-memory (and is #909-skipped when too large).
# Threshold is low (like KIT) because in-memory EDF blows up ~6x and OOMs early.
STREAM_EDF_EXTS = (".edf", ".bdf")
STREAM_EDF_MIN_BYTES = int(os.environ.get("ZARR_STREAM_EDF_MIN_BYTES", str(256 * 1024**2)))


def _biosigio_streams_edf() -> bool:
    """True if the installed biosigIO streams EDF/BDF via pyedflib (>= 1.2.0,
    nemar-cli#944). Older builds read EDF via MNE in stream_to_zarr, which
    disagrees with the in-memory pyedflib units, so EDF must stay in-memory."""
    try:
        from importlib.metadata import version

        major_minor = tuple(int(p) for p in version("biosigio").split(".")[:2])
        return major_minor >= (1, 2)
    except Exception:  # noqa: BLE001 - absent/odd version string: assume no EDF streaming
        return False


# Resolved once at import; a recording-format decision must not re-probe per call.
_EDF_STREAMABLE = _biosigio_streams_edf()


def should_stream(primary_local: str, size_bytes: int) -> bool:
    """Whether a recording converts via the bounded-memory streaming path.

    EEGLAB `.set` is deliberately absent from every streaming tuple, and stays on
    the in-memory path at any size. Two independent blockers, both verified
    against the installed MNE and biosigIO:

    1. A MATLAB v7.3 `.set` is an HDF5 container. MNE refuses it outright, and
       only biosigIO's own h5py importer reads it (the `[hdf5]` extra, added in
       1.2.4 for 544 such recordings across the archive). Streaming routes through
       MNE, so routing `.set` there would turn those 544 back into failures.
    2. For a classic `.set` whose samples are embedded in the MAT struct rather
       than a sibling `.fdt`, `preload=False` is a fiction: MNE's
       `_read_segment_file` detects `is_embedded` and calls `_readmat(preload=True)`,
       materialising the whole recording and caching it. Streaming such a file
       would load everything anyway AND add the scratch memmap on top -- strictly
       worse than the in-memory path it replaced.

    Only a classic `.set` with a sibling `.fdt` could genuinely stream, which is a
    subset, and biosigIO importer parity for units and channel handling would
    still need proving before relying on it. Large `.set` recordings are instead
    protected by the RLIMIT_DATA backstop (#1110) and by the temporary-vs-permanent
    verdict split (#1111), so one cannot take down a node or be buried forever.

    Large MNE-native recordings (BrainVision/FIF, CTF `.ds`, MEF3 `.mefd`) stream
    above ``STREAM_MIN_BYTES``; KIT `.con`/`.sqd`/`.kdf` and
    -- when biosigIO >= 1.2.0 -- EDF/BDF stream above the much lower KIT/EDF
    thresholds because their in-memory float64 blow-up OOMs a worker well below
    the common threshold. Everything else uses the faster
    in-memory path.

    Called both pre-materialization (``primary_local`` is still the git-relative
    path, e.g. the RAM-admission estimate in ``main``) and post-materialization
    (a real local path, from ``convert_recording``), so every branch here must
    decide from the path STRING alone -- never ``os.path.isdir`` or another
    filesystem check, which would silently misclassify the pre-materialization
    call (nothing exists at that path yet).
    """
    ext = lower_ext(primary_local)
    if ext in STREAM_KIT_EXTS:
        return size_bytes > STREAM_KIT_MIN_BYTES
    if _EDF_STREAMABLE and ext in STREAM_EDF_EXTS:
        return size_bytes > STREAM_EDF_MIN_BYTES
    if ext in STREAM_EXTS:
        return size_bytes > STREAM_MIN_BYTES
    # 4D/BTi: BIDS gives it no extension at all (see `bti_recordings`), so it
    # can't join STREAM_EXTS by extension the way `.ds`/`.mefd` do. Every other
    # primary this converter discovers carries a real extension (PRIMARY_EXTS, or
    # `.ds`/`.mefd` via DIR_RECORDING_EXTS), so an empty extension reaching here is
    # a BTi recording by construction, not an unrelated ext-less path. It streams
    # above the SAME threshold as STREAM_EXTS -- deliberately not the
    # lower KIT one -- because `read_raw_bti` genuinely supports `preload=False`
    # (biosigIO's streaming exporter opens it lazily via the same `_MneSource`
    # path as CTF/FIF/`.mefd`); it doesn't have KIT's "no lazy reader" problem.
    if ext == "":
        return size_bytes > STREAM_MIN_BYTES
    return False


# --- Per-recording memory guard (#909) ----------------------------------------
# The in-memory path (`Recording.from_file`) loads a recording at float64 (~4x
# its int16 on-disk bytes) plus a resample copy, so a large EDF/BDF/EEGLAB
# recording -- which has no streaming reader -- OOM-kills its pool worker (and,
# via BrokenProcessPool, its concurrently-running siblings), then reruns as an
# infra failure and burns retries. The streaming path peaks ~STREAM_PEAK_BYTES
# regardless of size. We PROJECT each recording's peak RAM and skip (cleanly,
# with a deterministic reason surfaced in the index) anything that won't fit the
# node's usable RAM -- BEFORE the load, so no OOM ever happens. The ceiling is the
# whole usable node (not usable_RAM / jobs): main() admits recordings so the SUM
# of in-flight peaks stays within it, so raising --jobs adds concurrency without
# shrinking the budget or skipping more recordings.
STREAM_PEAK_BYTES = int(os.environ.get("ZARR_STREAM_PEAK_BYTES", str(4 * 1024**3)))
# Hard floor for the admission ceiling: two streaming recordings. See
# `usable_ram_bytes`.
CEILING_FLOOR_BYTES = int(
    os.environ.get("ZARR_CEILING_FLOOR_BYTES", str(2 * STREAM_PEAK_BYTES))
)

# --- Per-worker memory ceiling (#1110) ---------------------------------------
# Admission reserves a projected peak for each recording. Nothing enforced that
# reservation, so a recording that blew past it took the WHOLE NODE with it: the
# kernel OOM reaper killed the worker, ProcessPoolExecutor declared the pool
# broken, and every recording still queued behind it died too (on004998 lost 41
# of 115 that way; 96 such aborts in the log history).
#
# RLIMIT_DATA, not RLIMIT_AS. The streaming path builds a channel-major
# `np.memmap` on scratch, which is FILE-BACKED: it consumes address space without
# consuming memory, so an RLIMIT_AS sized to the budget would kill precisely the
# bounded path we want recordings to use. Since Linux 4.7 RLIMIT_DATA covers
# anonymous mappings (the float64 blow-up that actually OOMs) and excludes
# file-backed mmap. Verified on the conversion node: under a 512 MiB RLIMIT_DATA
# a file-backed 2 GiB memmap is allowed while a 1 GiB anonymous allocation raises
# a clean, catchable MemoryError.
#
# The limit is deliberately loose: `peak * SLACK`, floored so a small recording
# still gets a minimum reservation of its own (the interpreter and library
# footprint are measured and added separately; see `data_segment_bytes`), and
# capped at the node ceiling so nothing may exceed what #909 already forbids. It is a backstop
# against a runaway, NOT a tight budget -- projections are still the guessed
# `INMEM_MEM_FACTOR` and run ~2x low for BrainVision, so a tight limit here would
# fail recordings that convert fine today. #1111 makes projections
# measurement-based and can then tighten SLACK.
MEM_LIMIT_SLACK = float(os.environ.get("ZARR_MEM_LIMIT_SLACK", "3.0"))
MEM_LIMIT_FLOOR_BYTES = int(os.environ.get("ZARR_MEM_LIMIT_FLOOR_BYTES", str(4 * 1024**3)))

# The limit is applied ON TOP of the worker's data segment as it stands when the
# recording starts, not as an absolute number. RLIMIT_DATA counts every private
# writable mapping, and the scientific stack reserves a great deal of those at
# import without ever touching them: measured on the conversion node
# (2026-09-03, 32 cores), `import numpy` + `import scipy` alone put VmData at
# 2.6 GiB against 100 MB of RSS, because each bundled OpenBLAS pre-maps a buffer
# pool sized for every core. Applied as an absolute cap, the 4 GiB floor left
# ~1.3 GiB of real headroom, and a 4 MB EMG recording died on a 624 KiB
# allocation with "exceeded its memory budget" -- the same message a genuine
# runaway produces, so the failures read as data problems for days. The thread
# caps below shrink that reservation to ~220 MB; adding the baseline makes the
# backstop mean what its name says regardless of what the libraries reserve.
BLAS_THREAD_VARS = (
    "OPENBLAS_NUM_THREADS",
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
)


def cap_blas_threads(env: MutableMapping[str, str] = os.environ) -> dict[str, str]:
    """Pin BLAS/OpenMP thread pools to one thread unless the operator set them.

    Must run before numpy is first imported in this process (the pools are sized
    at import); this module imports numpy lazily, so calling it at module import
    is early enough for the driver, and pool workers inherit the environment.
    One thread is also simply correct here: the driver already runs up to
    `--jobs` recordings in parallel, so per-recording BLAS threading only
    oversubscribes the node (24 workers x 32 threads) and, per the numbers above,
    costs ~2.4 GiB of RLIMIT_DATA headroom per worker for nothing.
    Returns the values now in effect, for the log.
    """
    for var in BLAS_THREAD_VARS:
        env.setdefault(var, "1")
    return {var: env[var] for var in BLAS_THREAD_VARS}


cap_blas_threads()


def data_segment_bytes() -> int | None:
    """This process's RLIMIT_DATA-accounted footprint right now (`VmData` from
    /proc/self/status), or None where that file does not exist (macOS, Windows),
    which is also where the backstop is not applied."""
    try:
        with open("/proc/self/status", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("VmData:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        return None
    return None
# One-shot latch: a box where setrlimit is refused (a seccomp profile, an odd
# container runtime) would otherwise run with NO containment and say nothing,
# leaving everyone believing #1110 shipped when it silently did not.
_WARNED_NO_BACKSTOP = [False]
# Same latch shape for the measurement side-channel: a run that silently stops
# measuring would quietly end the #1111 feedback loop with nobody the wiser.
_WARNED_NO_RSS = [False]
_WARNED_NO_RESET = [False]
# A meminfo fallback silently changes which VERDICT an over-budget recording
# gets, so it cannot be quiet either.
_WARNED_MEMINFO = [False]


def admission_reserve_bytes(
    peak_bytes: int, ceiling_bytes: int | None, *, streamed: bool = False
) -> int:
    """What admission must CHARGE for a recording: what its worker is permitted to
    allocate.

    Slack applies to the IN-MEMORY path only. It exists to cover that path's
    projection being a guessed multiple of on-disk bytes that runs about 2x low.
    The streaming path's projection is not a guess of that kind -- it is the flat
    bound the two-pass design gives (one read window plus one channel), already
    generous. Tripling it charged 12 GiB for a recording whose real peak is in the
    hundreds of megabytes, and against this node's ~19 GiB ceiling that admitted
    exactly ONE recording at a time with --jobs 24, i.e. serial conversion of a
    1.5 TB dataset. #1112

    Once #1111's measurements land, STREAM_PEAK_BYTES itself should come down from
    4 GiB, which is where the rest of the concurrency comes back.

    Charging the bare projection instead was the flaw that made the backstop only
    half a containment. Admission bounded the SUM of nominal projections to the
    node ceiling, while each worker was separately allowed `projection * SLACK` --
    so ~12 concurrent streaming recordings on a 62 GB box were collectively
    permitted ~144 GiB before any single soft limit could fire, and the kernel
    OOM reaper still won. Reserving what we permit makes the aggregate bound hold
    by construction, at the cost of proportionally less concurrency for large
    recordings -- which is the point: the previous concurrency was overcommitted.
    """
    reserve = peak_bytes if streamed else int(peak_bytes * MEM_LIMIT_SLACK)
    return min(reserve, ceiling_bytes) if ceiling_bytes else reserve


def reset_peak_rss() -> bool:
    """Reset this process's peak-RSS high-water mark so the NEXT measurement is
    attributable to one recording.

    Pool workers are reused, and both `VmHWM` and `ru_maxrss` are per-PROCESS
    high-water marks, so without this a small recording inherits whatever the
    biggest recording that worker previously handled peaked at -- which would make
    every calibration number an upper envelope rather than a measurement. Writing
    `5` to /proc/self/clear_refs resets it (Linux >= 4.0). Verified on the
    conversion node: 611 MiB -> reset -> 12 MiB.
    """
    try:
        with open("/proc/self/clear_refs", "w") as fh:
            fh.write("5")
        return True
    except OSError:
        return False


def peak_rss_bytes() -> int | None:
    """This process's peak RSS since the last `reset_peak_rss`, or None where that
    cannot be read. Prefers /proc (bytes we can trust the units of); falls back to
    `ru_maxrss`, whose units differ by platform -- KiB on Linux, bytes on macOS."""
    try:
        with open("/proc/self/status") as fh:
            for line in fh:
                if line.startswith("VmHWM:"):
                    return int(line.split()[1]) * 1024
    except OSError:
        pass
    try:
        import resource

        maxrss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return maxrss if sys.platform == "darwin" else maxrss * 1024
    except Exception:  # noqa: BLE001 - measurement is never worth failing a run over
        return None


def worker_mem_limit_bytes(peak_bytes: int | None, ceiling_bytes: int | None) -> int | None:
    """Soft RLIMIT_DATA for one recording, or None to leave the limit alone.

    The floor is deliberately NOT charged to admission. It is the minimum
    reservation a small recording's own allocations get; the interpreter and
    library footprint is per-process baseline rather than signal data, measured
    and added on top by `apply_worker_mem_limit` rather than covered here, and
    charging either to admission would stop small EEG recordings packing
    many-wide for no real benefit. The residual overcommit
    is therefore bounded by `jobs * MEM_LIMIT_FLOOR_BYTES` of baseline, not by
    anything that scales with recording size.
    """
    if not peak_bytes:
        return None
    limit = max(admission_reserve_bytes(peak_bytes, ceiling_bytes), MEM_LIMIT_FLOOR_BYTES)
    if ceiling_bytes:
        limit = min(limit, ceiling_bytes)
    return limit


def apply_worker_mem_limit(
    peak_bytes: int | None, ceiling_bytes: int | None, *, reserved: bool = False
) -> None:
    """Cap this process's anonymous memory for the recording it is about to
    convert. Best-effort: a platform without a usable RLIMIT_DATA (macOS counts
    it differently, and it is absent on Windows) simply runs unlimited, exactly
    as before. Never raises -- failing to set a backstop must not fail a
    conversion."""
    # `reserved=True` means the caller already passed a slack-inflated reserve
    # (what admission charged), so only the floor and ceiling still apply --
    # multiplying by slack again would permit 3x what was reserved.
    if reserved and peak_bytes:
        limit = max(peak_bytes, MEM_LIMIT_FLOOR_BYTES)
        if ceiling_bytes:
            limit = min(limit, ceiling_bytes)
    else:
        limit = worker_mem_limit_bytes(peak_bytes, ceiling_bytes)
    if limit is None or not sys.platform.startswith("linux"):
        return
    try:
        import resource

        # The reservation is headroom for THIS recording's allocations; what the
        # process already holds (library buffer pools, the interpreter, a reused
        # worker's retained heap) is measured and added, not charged against it.
        # See the note above `BLAS_THREAD_VARS` for the 2.6 GiB that motivated this.
        # Deliberately NOT re-clamped to `ceiling_bytes` after this addition: the
        # ceiling is stated in resident memory (what admission charges against the
        # node), while the baseline is address space the libraries have mapped
        # and mostly never touch. Clamping the SUM would hand a recording admitted
        # at the ceiling exactly `baseline` less than it was charged -- the bug in
        # miniature. The reserve is what the ceiling caps, and it already was.
        baseline = data_segment_bytes() or 0
        limit += baseline
        # Only the hard limit is read: the soft one is what this call REPLACES.
        hard = resource.getrlimit(resource.RLIMIT_DATA)[1]
        # Keep the hard limit where it is so the next task can raise the soft
        # one back up; a task needing MORE than the previous one must not be
        # capped by it.
        if hard != resource.RLIM_INFINITY and limit > hard:
            limit = hard
        resource.setrlimit(resource.RLIMIT_DATA, (limit, hard))
    except Exception as exc:  # noqa: BLE001 - a missing backstop must not fail a conversion
        if not _WARNED_NO_BACKSTOP[0]:
            _WARNED_NO_BACKSTOP[0] = True
            print(
                f"::warning::RLIMIT_DATA backstop unavailable ({exc}); this run has "
                "NO per-recording out-of-memory containment (#1110)",
                flush=True,
            )

# Multiplier from on-disk bytes to peak RAM on the in-memory path. ONE constant
# for every format was the calibration error behind the 2026-08-22 OOMs: the
# admission controller packed seven BrainVision recordings whose real cost was
# roughly twice what it had reserved, and the node died. The cost genuinely
# differs by reader, so the factor does too.
#
# The default stays 6 for formats nothing has measured yet. BrainVision is 12,
# from its actual chain: MNE preloads at float64 (4x int16 on disk), biosigIO
# copies each channel into a DataFrame (another 4x), pandas periodically
# consolidates that fragmented frame (transiently another 4x -- this is the
# `PerformanceWarning` the log is full of), plus the resample copy. Measured
# peaks are now logged against these projections on every run
# (`::warning::under-projected`), so the next revision of this table is data
# rather than arithmetic. #1111
INMEM_MEM_FACTOR = float(os.environ.get("ZARR_INMEM_MEM_FACTOR", "6"))
INMEM_MEM_FACTOR_BY_EXT = {
    ".vhdr": float(os.environ.get("ZARR_INMEM_MEM_FACTOR_VHDR", "12")),
    # Same retention as on the streaming path (see STREAM_MEM_FACTOR_BY_EXT):
    # a MEF3 recording small enough for the in-memory path still decompresses
    # to float64 several times its RED-compressed on-disk size.
    MEFD_EXT: float(os.environ.get("ZARR_INMEM_MEM_FACTOR_MEFD", "12")),
}

# Formats that take the STREAMING path but do not stay inside its flat bound.
# MEF3 `.mefd` is read through `mne.io.read_raw_mef`, which does ask pymef for one
# time window at a time -- and the worker's resident memory still climbs to the
# whole recording decompressed at float64. Measured on the conversion node on
# 2026-09-03 (on004696, 178-256 channels x 3.3M samples, ~1 GB on disk each):
# VmHWM 7.5-10.3 GiB per worker, and every recording failed its 8 GiB RLIMIT_DATA
# on a single-window allocation after many windows, which is the signature of
# memory retained per window read rather than of one large read. Under the flat
# 4 GiB projection admission packed eight of them and the kernel killed a worker,
# which broke the pool. Until the retention is fixed at the reader, project MEF3
# as an in-memory format: on-disk bytes times this factor (RED compression means
# on-disk understates the float64 footprint several-fold). 12x covers the worst
# measured point (10.3 GiB from ~1 GB) with a small margin and admits three at a
# time against the node's ~46 GiB ceiling instead of eight. Env-overridable so
# the next measurement (the `worst .mefd at Nx its projection` line in every
# run's log) can tighten it without a deploy. #1111
STREAM_MEM_FACTOR_BY_EXT = {
    MEFD_EXT: float(os.environ.get("ZARR_STREAM_MEM_FACTOR_MEFD", "12")),
}


def stream_factor_for(primary_local: str) -> float:
    """On-disk multiplier for a streamed recording whose format is known to retain
    memory beyond the flat streaming bound; 0.0 for every other format, so the
    flat bound stands alone."""
    return STREAM_MEM_FACTOR_BY_EXT.get(lower_ext(primary_local), 0.0)


def projection_factor_hint(primary_local: str, streaming: bool) -> str:
    """Name the format-specific multiplier behind a projection, for the skip
    message, when one applied. A recording skipped as too large under a
    per-format factor is skipped because of that factor as much as because of
    its bytes on disk, so the person reading the index should see which knob
    produced the number rather than a bare "too large". For MEF3 that knob is
    what to retune once the reader stops retaining; for BrainVision the 12x is
    a measured cost (#1111) and the hint is simply where the number came from.

    The knob name is derived by convention (`ZARR_<STREAM|INMEM>_MEM_FACTOR_<EXT>`);
    every per-extension factor above follows it, and a new one must too or the
    hint names a variable that does not exist."""
    ext = lower_ext(primary_local)
    table = STREAM_MEM_FACTOR_BY_EXT if streaming else INMEM_MEM_FACTOR_BY_EXT
    if ext not in table or (streaming and table[ext] <= 0):
        return ""
    knob = f"ZARR_{'STREAM' if streaming else 'INMEM'}_MEM_FACTOR_{ext.lstrip('.').upper()}"
    return f"; projected with the {ext} factor {table[ext]:g}x ({knob})"

# Signal-Space Separation (ADR 0028) runs BEFORE conversion and costs its own peak:
# it needs a fully preloaded float64 `Raw`, which is the anonymous memory RLIMIT_DATA
# counts. The filtered copy then STREAMS, so conversion adds nothing to that peak.
#
# Measured through `apply_sss` itself on the conversion node, across both affected
# datasets rather than at one point -- the BrainVision entry above is the cautionary
# tale for a single-sample factor:
#
#     on006720 sub-197   160 MiB -> 0.78 GiB   5.0x
#     on006720 sub-155   164 MiB -> 0.79 GiB   5.0x
#     on006012 sub-01    438 MiB -> 1.87 GiB   4.4x
#     on006720 sub-155   716 MiB -> 2.95 GiB   4.2x
#
# The ratio FALLS with size as fixed overhead amortises, so the worst ratio sits where
# the absolute number is trivial and the largest recordings -- the ones that can
# actually exhaust the node -- are the cheapest per byte. 6x clears every observed
# point, and clears the largest by 43%.
#
# Note this deliberately does NOT get `MEM_LIMIT_SLACK`. Admission calls
# `admission_reserve_bytes(..., streamed=True)` for these recordings, since the
# CONVERSION streams, and that suppresses the 3x multiplier. That multiplier exists
# for factors that are "a guessed multiple of on-disk bytes"; this one is measured
# across the range it will be applied to, which is the condition the slack covers.
# Applying both would reserve ~18x on-disk and gut concurrency for no evidence.
#
# Load-bearing rather than an efficiency nicety: `apply_worker_mem_limit` sizes
# RLIMIT_DATA from this projection BEFORE the worker starts, so an under-projection
# does not merely over-schedule the node, it kills the filter mid-run. The streaming
# floor alone (4 GiB) happens to clear the largest recording by under 5%, which is
# coincidence -- that floor was sized for conversion, not for this phase.
MAXSHIELD_MEM_FACTOR = float(os.environ.get("ZARR_MAXSHIELD_MEM_FACTOR", "6"))


def note_measurement(result: dict, projections: dict, measured: dict) -> str | None:
    """Fold one `convert_one` result into ``measured``; return a warning to print
    when the recording cost more than was reserved for it, else None.

    Extracted from ``main``'s reporting closure so the bookkeeping that feeds
    calibration is testable without a live conversion. `rss is None` is checked
    explicitly rather than by truthiness: None means "not measured" (or measured
    untrustworthily) and must be dropped, while a genuine 0 would be a real
    reading and must not be silently conflated with it.
    """
    rss = result.get("peak_rss")
    primary = result.get("primary")
    proj = projections.get(primary)
    if rss is None or not proj:
        return None
    measured[primary] = rss
    # Warn at the CONTAINMENT boundary, not the bare projection. Admission charges
    # `projection * MEM_LIMIT_SLACK`, so a recording over its bare projection is
    # still comfortably inside what was reserved for it and endangered nothing --
    # warning there would put a scary line against a large share of every run's
    # recordings, in a log already too big to read, and drown the real cases.
    # "reserved" means the slack-inflated charge, matching admission's vocabulary.
    reserved = proj * MEM_LIMIT_SLACK
    if rss > reserved:
        return (
            f"::warning::under-reserved {primary}: needed {rss / 1024**3:.1f} GiB, "
            f"reserved {reserved / 1024**3:.1f} GiB ({rss / proj:.1f}x its "
            f"projection) -- see INMEM_MEM_FACTOR_BY_EXT (#1111)"
        )
    return None


def calibration_summary(
    measured: dict, projections: dict, streamed: set[str]
) -> list[dict]:
    """Per-extension measured-vs-projected peak RAM, worst case first.

    This is the feedback loop that stops `INMEM_MEM_FACTOR_BY_EXT` being folklore:
    every run reports what each format actually cost against what was reserved for
    it, so the next revision of that table is measurement. `suggested_factor` is
    the multiplier that would have covered the worst recording seen here; it is
    advisory output, never applied automatically -- one pathological recording
    should not silently re-tune the whole archive.
    """
    # Bucket by (extension, which path it took). A streamed recording's projection
    # is unrelated to its on-disk size, so mixing it in with in-memory recordings
    # of the same extension yields a "suggested factor" that looks like a blow-up
    # multiplier but is not one. Only the in-memory path has a factor to suggest.
    #
    # `streamed` is passed in rather than re-derived from `proj == STREAM_PEAK_BYTES`.
    # That test held only while a streamed projection was always the flat constant;
    # `streaming_peak_bytes` now raises it to the per-channel floor for a few-channel,
    # long, high-rate recording (ADR 0030's EMG / single-contact iEEG case), and such
    # a recording would fall through to "inmem" and be handed a bogus suggested_factor
    # -- corrupting the very feedback loop this function exists to provide.
    buckets: dict[tuple[str, str], list[tuple[int, int]]] = {}
    for path, rss in measured.items():
        proj = projections.get(path)
        if proj:
            kind = "stream" if path in streamed else "inmem"
            buckets.setdefault((lower_ext(path) or "(dir)", kind), []).append((rss, proj))
    rows = []
    for (ext, kind), pairs in buckets.items():
        # max_peak_bytes must come from the SAME recording as max_ratio, or the
        # log reads "worst .set at 4.0x its projection (peak 105 KB)" while the 4x
        # recording actually peaked at 400 bytes -- misleading exactly the person
        # trying to retune the table.
        worst_rss, worst_proj = max(pairs, key=lambda x: x[0] / x[1])
        row = {
            "ext": ext,
            "path": kind,
            "n": len(pairs),
            "max_ratio": round(worst_rss / worst_proj, 2),
            "max_peak_bytes": worst_rss,
            "max_peak_projection_bytes": worst_proj,
        }
        if kind == "inmem":
            row["suggested_factor"] = round(
                inmem_factor_for(f"x{ext}") * worst_rss / worst_proj, 1
            )
        rows.append(row)
    return sorted(rows, key=lambda r: r["max_ratio"], reverse=True)


def inmem_factor_for(primary_local: str) -> float:
    """In-memory blow-up multiplier for this recording's format."""
    return INMEM_MEM_FACTOR_BY_EXT.get(lower_ext(primary_local), INMEM_MEM_FACTOR)


class RecordingTooLarge(Exception):
    """A recording whose projected peak RAM exceeds this run's per-recording
    budget. Carries `.code` so convert_one surfaces it as a DETERMINISTIC skip
    (recorded in the index, no infra retry) -- exactly like a biosigIO data
    failure -- instead of OOM-crashing the worker. #909"""

    code = "recording_too_large"


def is_memory_exhaustion(exc: BaseException) -> bool:
    """Whether `exc` is the RLIMIT_DATA backstop (or the allocator) saying no.

    `MemoryError` is the obvious shape. Two others come from the same cause and
    used to fall through as uncoded infra failures, which breaks the worker pool
    and re-runs the recording one at a time to "find the culprit": a thread
    stack is a private writable mapping, so at the limit zarr's codec pipeline
    dies with `RuntimeError: can't start new thread` (on004696, 2026-09-03), and
    an `mmap` refused at the limit raises `OSError(ENOMEM)`.
    """
    if isinstance(exc, MemoryError):
        return True
    # CPython raises this one fixed string for ANY pthread_create failure and
    # attaches no errno, so EAGAIN (a thread-count limit such as RLIMIT_NPROC)
    # is indistinguishable here from ENOMEM. Nothing in this driver tightens a
    # thread limit, only RLIMIT_DATA, so at the limit this is the backstop; if it
    # ever recurs on a node where memory is NOT the story, this is the line that
    # turned a novel infra failure into a retryable memory verdict.
    if isinstance(exc, RuntimeError) and "can't start new thread" in str(exc):
        return True
    return isinstance(exc, OSError) and exc.errno == errno.ENOMEM


class RecordingMemoryExceeded(Exception):
    """A recording hit its RLIMIT_DATA backstop (or the allocator failed) WHILE
    converting. Deliberately distinct from `RecordingTooLarge`, which is a static
    preflight verdict on the recording alone and is therefore a permanent property
    of the data.

    A runtime out-of-memory is NOT: the same recording can OOM today under sibling
    contention and convert fine tomorrow running alone. So this code is surfaced in
    the index (the viewer can say why there is no store) but is listed in
    `RETRYABLE_CODES`, which keeps it OUT of the `deterministic` verdict -- otherwise
    a dataset whose recordings all OOM during one busy hour would be marked
    terminal by hallu-zarr.sh and never retried. #1110."""

    code = "recording_memory_exceeded"


class MaxShieldUncalibrated(Exception):
    """A MEG recording carrying raw Internal Active Shielding (MaxShield) data for
    which the site-specific calibration pair does not resolve.

    MEGIN's position, which MNE enforces by refusing to read these files at all, is
    that raw Internal Active Shielding data is not fit for analysis until the
    shielding's effect has been modelled out. ADR 0028 decides we correct it with
    Signal-Space Separation and serve the result -- but ONLY with the recording's own
    fine-calibration and cross-talk files, because uncalibrated Signal-Space
    Separation is a weaker correction whose quality varies by site and hardware, and
    serving it under the same label would make the two indistinguishable.

    So this is the honest decline: a permanent property of what the dataset ships,
    NOT in `RETRYABLE_CODES`. It exists to replace the opaque `file_read_error` that
    gave a user no way to tell an unreadable file from a policy decision."""

    code = "maxshield_uncalibrated"


class MaxShieldProbeFailed(Exception):
    """`is_maxshield_fif`'s header-only probe could not read `path` at all.

    Before #1139 the probe caught every exception itself, printed a
    `::warning::`, and returned False -- which routed the recording down the
    NORMAL conversion path. For a file the probe could not even open, that
    path failed anyway, but as an uncoded (or differently-coded, biosigIO's
    own) `file_read_error`: nothing on the public index distinguished "the
    MaxShield probe itself could not read this FIF" from any other read
    failure, so the operator lost the one clue that would have named the
    actual failure surface.

    The probe runs on `primary_local`, which `materialize_local` /
    `materialize_recording` has already fetched successfully by the time
    `convert_one` calls it -- so a header read failing here is a property of
    what the file itself contains (truncated, corrupt, a missing split
    member MNE could not resolve), not of this run. Same reasoning ADR 0028
    already applies to `MaxShieldUncalibrated`: NOT in `RETRYABLE_CODES`,
    because retrying cannot make a corrupt header become readable."""

    code = "maxshield_probe_failed"


# Coded failures that are nevertheless NOT a permanent property of the data, so a
# run consisting entirely of them must stay retryable. See `deterministic` in main().
# `maxshield_uncalibrated` is deliberately absent: the calibration pair is either
# shipped with the dataset or it is not, and retrying cannot change that.
# `maxshield_probe_failed` is absent for the same reason: the probe runs on a
# local file this same attempt already fetched successfully, so a header it
# cannot read is a property of that file's content, not of node conditions.
RETRYABLE_CODES = frozenset({RecordingMemoryExceeded.code})


def memory_failure_result(
    primary: str, exc: BaseException, peak_rss: int | None = None
) -> dict:
    """The `convert_one` result for a recording that ran out of memory mid-convert.

    A function rather than an inline dict so tests exercise the SAME construction
    production uses. Inlined, the obvious test reimplements the mapping and passes
    even if the handler is deleted or folded into the generic `except Exception`
    below it -- which would silently downgrade this to an uncoded infra failure
    that retries forever.
    """
    return {
        "ok": False,
        "primary": primary,
        "error": f"exceeded its memory budget while converting: {exc}",
        "code": RecordingMemoryExceeded.code,
        "detail": failure_detail(exc),
        "peak_rss": peak_rss,
    }


def count_infra_failures(failures: list, failure_entries: list) -> int:
    """How many of ``failures`` are infrastructure rather than a property of the
    data. Drives ``deterministic``, which the shell driver turns into a TERMINAL,
    never-retried verdict for the whole dataset when every failure is data-shaped.

    An uncoded failure (crashed worker, transient S3) is infra. A coded one
    normally is not -- except the codes in ``RETRYABLE_CODES``, which are surfaced
    to the viewer but still depend on conditions rather than on the recording, so
    they must not let one bad hour bury a dataset permanently. #1110.

    Since index v3 both of those land in the index's ``pending`` list rather than
    in ``failure_entries``, so the subtraction already counts them and the
    ``retryable_coded`` term is normally zero. It stays because the term is what
    makes the rule TRUE rather than incidentally right: if a retryable code is
    ever surfaced as a typed failure again, the verdict must not silently flip to
    terminal. This number equals ``len(pending)`` for a run, by construction.
    """
    retryable_coded = sum(1 for e in failure_entries if e.get("code") in RETRYABLE_CODES)
    return len(failures) - len(failure_entries) + retryable_coded


class ChannelCountMismatch(Exception):
    """The converted store carries fewer channels than the recording's BIDS
    `_channels.tsv` declares, so publishing it would serve a silently
    unfaithful copy (the failure mode behind nemarDatasets/on002718#1, where
    biosigio#110 truncated 74-channel EEGLAB files to one channel). Typed so
    the gate is a DETERMINISTIC data failure surfaced in the index and the
    unfaithful store is never uploaded.

    Policy: better NO store than a wrong store. On the incremental path the
    prior store survives (the gate runs before this recording's sync). Under
    ``--clean`` (the Hallu bulk path) the dataset prefix is wiped up front, so
    a gated recording ends with no serving copy at all -- intended, since a
    copy that contradicts channels.tsv must not be served, and the prior copy
    was built by the same converter lineage that just failed the check. Being
    deterministic, a gated recording does NOT self-retry: after a converter
    fix, re-run the dataset explicitly (hallu-zarr.sh --dataset <id>)."""

    code = "channel_count_mismatch"


# Pass 2 of the streaming exporter does, per channel,
# `x = np.asarray(mm[i], dtype=np.float64)` -- it materialises ONE WHOLE CHANNEL
# at native rate as anonymous float64. That term is `n_samples * 8` bytes: it
# scales with duration and sample rate and is INDEPENDENT of channel count, so
# STREAM_PEAK_BYTES is not the guaranteed bound it looks like. A many-channel
# recording splits its bytes across many short channels and stays far under it; a
# FEW-channel, long, high-rate recording (EMG, single-contact iEEG) can have one
# channel that alone approaches or exceeds it.
#
# So project the per-channel term explicitly when the channel count is known.
# `size_bytes / n_channels` is one channel's on-disk bytes; x4 takes int16 to
# float64, and the multiplier below covers the resampled copy and resample_poly's
# scratch alongside it.
STREAM_CHANNEL_EXPANSION = float(os.environ.get("ZARR_STREAM_CHANNEL_EXPANSION", "12"))


def streaming_peak_bytes(size_bytes: int, n_channels: int | None) -> int:
    """Projected peak for the streaming path: the flat floor, raised when one
    channel alone would exceed it. Falls back to the flat value when the channel
    count is unknown."""
    if not n_channels or n_channels <= 0:
        return STREAM_PEAK_BYTES
    per_channel = int(size_bytes / n_channels * STREAM_CHANNEL_EXPANSION)
    return max(STREAM_PEAK_BYTES, per_channel)


def projected_peak_bytes(
    primary_local: str,
    size_bytes: int,
    n_channels: int | None = None,
    maxshield: bool = False,
) -> int:
    """Estimated peak RAM to convert this recording: the streaming path's
    channel-aware bound, or the float64 blow-up for the in-memory path. Drives the
    skip guard (#909).

    `maxshield` adds the Signal-Space Separation phase (ADR 0028), which runs before
    conversion and peaks independently of it. The two phases are sequential and the
    `Raw` is released between them, so the recording's peak is the LARGER of the two
    rather than their sum.
    """
    if should_stream(primary_local, size_bytes):
        conversion = max(
            streaming_peak_bytes(size_bytes, n_channels),
            int(size_bytes * stream_factor_for(primary_local)),
        )
    else:
        conversion = int(size_bytes * inmem_factor_for(primary_local))
    if not maxshield:
        return conversion
    return max(conversion, int(size_bytes * MAXSHIELD_MEM_FACTOR))


def usable_ram_bytes(meminfo_path: str = "/proc/meminfo") -> int:
    """Convertible RAM: MemTotal (Linux /proc/meminfo) minus a headroom fraction.
    A conservative fallback keeps the guard active off-Linux / in tests."""
    frac = float(os.environ.get("ZARR_MEM_HEADROOM_FRAC", "0.8"))
    total: int | None = None
    # MemAvailable, not MemTotal. The conversion node is SHARED -- other tenants,
    # other jobs, and the page cache backing this run's own scratch all live in the
    # same RAM -- so MemTotal describes a machine we do not have to ourselves and
    # consistently overstates what we may allocate. MemAvailable is the kernel's own
    # estimate of what is obtainable without swapping, which is the number admission
    # actually needs. Falls back to MemTotal on a kernel too old to publish it
    # (< 3.14), and to the env/default below off-Linux. #1111
    def _meminfo() -> dict:
        fields = {}
        with open(meminfo_path) as fh:
            for line in fh:
                key = line.split(":", 1)[0]
                if key in ("MemAvailable", "MemTotal"):
                    fields[key] = int(line.split()[1]) * 1024  # kB -> bytes
        return fields

    try:
        # Median of three samples. MemAvailable is a live number on a shared box,
        # and this is read ONCE for a run that lasts hours -- so a single unlucky
        # instant (a neighbouring job's page-cache spike) would otherwise set an
        # absurdly low ceiling for everything that follows. `is not None` rather
        # than `or`: a genuine 0 must not silently fall through to MemTotal.
        samples = []
        for i in range(3):
            fields = _meminfo()
            avail = fields.get("MemAvailable")
            samples.append(avail if avail is not None else fields.get("MemTotal"))
            if i < 2:
                time.sleep(0.05)
        samples = [x for x in samples if x is not None]
        total = sorted(samples)[len(samples) // 2] if samples else None
    except OSError:
        total = None
    if total is None:
        if not _WARNED_MEMINFO[0]:
            _WARNED_MEMINFO[0] = True
            print(
                f"::warning::could not read {meminfo_path}; falling back to a fixed "
                "node-RAM figure. Admission is no longer sized to this machine, and "
                "the temporary-vs-permanent verdict split degrades to always-temporary "
                "(#1111)",
                flush=True,
            )
        total = int(os.environ.get("ZARR_NODE_RAM_BYTES", str(32 * 1024**3)))
    # Never fall below what one streaming recording needs, with room for a second.
    # Without a floor, a momentarily-loaded node yields a ceiling under
    # STREAM_PEAK_BYTES, at which point NOTHING is admissible and every recording
    # is skipped as "too large" -- a node-load artifact recorded as a property of
    # the data. #1111
    return max(int(total * frac), CEILING_FLOOR_BYTES)


def hardware_ceiling_bytes(meminfo_path: str = "/proc/meminfo") -> int:
    """The most memory this NODE could ever offer one recording: MemTotal, not
    MemAvailable.

    This is what separates a permanent verdict from a temporary one. Since the
    admission ceiling became MemAvailable (#1111) it is a live sample on a shared
    box, so "exceeds the budget" stopped meaning "too big to ever convert" and
    started meaning "too big right now" -- and the two must not share a verdict,
    because one is terminal and the other must retry.
    """
    frac = float(os.environ.get("ZARR_MEM_HEADROOM_FRAC", "0.8"))
    try:
        with open(meminfo_path) as fh:
            for line in fh:
                if line.startswith("MemTotal:"):
                    return max(int(int(line.split()[1]) * 1024 * frac), CEILING_FLOOR_BYTES)
    except OSError:
        pass
    return max(int(int(os.environ.get("ZARR_NODE_RAM_BYTES", str(32 * 1024**3))) * frac),
               CEILING_FLOOR_BYTES)


def per_recording_ceiling_bytes() -> int:
    """Largest projected peak a SINGLE recording may use: the whole usable node.
    Admission control in ``main`` keeps the SUM of concurrently-converting
    recordings within this, so a recording is #909-skipped only when it can't fit
    the node even alone -- independent of ``--jobs`` (unlike the old RAM/jobs
    split, where raising jobs shrank the budget and skipped more recordings).
    Explicit override still wins. #909"""
    override = os.environ.get("ZARR_REC_MEM_BUDGET_BYTES")
    if override:
        return int(override)
    return usable_ram_bytes()


# Fallback user-facing reasons, keyed by biosigIO error code. The authoritative
# copy lives in biosigio.exceptions.REASONS (single source of truth); we prefer
# that at runtime and use this only if the import is unavailable. Keep the codes
# in sync with biosigio's hierarchy.
_FALLBACK_REASONS = {
    "recording_memory_exceeded": (
        "This recording ran out of memory while its viewer copy was being "
        "built. It is not a defect in the data and can succeed on a later run."
    ),
    "not_continuous": (
        "This file is a trial-averaged or epoched derivative, not a continuous "
        "recording, so the time-series viewer is not available."
    ),
    "corrupt_or_truncated": (
        "This recording's data file appears truncated or corrupt, so the viewer "
        "could not be generated."
    ),
    "unsupported_format": "This file format is not yet supported by the viewer.",
    "empty_recording": "This recording contains no signal channels to display.",
    "file_read_error": "This recording could not be prepared for viewing.",
    # NEMAR-side (not a biosigIO code): a recording too large to convert on the
    # conversion node within memory limits (#909). The streaming path handles
    # multi-GB BrainVision/FIF/CTF; this is hit by a very large EDF/BDF/EEGLAB
    # recording, which has no streaming reader yet and would load fully in memory.
    "recording_too_large": (
        "This recording is too large to convert to an interactive viewer copy "
        "within the conversion node's memory limits."
    ),
    # NEMAR-side fidelity gate: the converted copy disagreed with the BIDS
    # channels.tsv ground truth, so it was withheld rather than served.
    "channel_count_mismatch": (
        "The converted viewer copy carried fewer channels than this recording's "
        "channels.tsv declares, so it was withheld pending a converter fix."
    ),
    # NEMAR-side (not a biosigIO code): ADR 0028. Surfaces MEGIN's own position,
    # which is why the file cannot simply be shown, rather than a bare read error.
    "maxshield_uncalibrated": (
        "This recording was acquired with internal active shielding, which distorts "
        "the signal until it is corrected. Correcting it needs the site's "
        "fine-calibration and cross-talk files, which this dataset does not provide "
        "for this recording, so no viewer copy is offered."
    ),
    # NEMAR-side (not a biosigIO code): ADR 0028's probe (is_maxshield_fif) could
    # not read this FIF's header at all, so it was never possible to tell whether
    # it carries raw internal active shielding or needs some other correction.
    "maxshield_probe_failed": (
        "This recording's header could not be read, so it was not possible to "
        "check whether it needs internal-active-shielding correction before "
        "converting it, and no viewer copy is offered."
    ),
    # NEMAR-side (not a biosigIO code): the producer gave up retrying. A recording
    # that fails for an INFRA reason is listed in the index's `pending` with an
    # attempt count instead of a failure; after PENDING_MAX_ATTEMPTS rounds it is
    # promoted here, so a permanently failing recording stops consuming the queue
    # and stops claiming it is about to appear. Its `detail` carries the last
    # error, which is the thing an operator actually needs. #1197
    "retry_exhausted": (
        "This recording could not be prepared for viewing after several attempts, "
        "so it is no longer being retried automatically."
    ),
}
_GENERIC_REASON = _FALLBACK_REASONS["file_read_error"]

# Longest `detail` / `last_error` string published per entry. These ride in a
# document fetched by every dataset-page visit, and #1178 item 5 is about that
# document's weight -- one pathological exception message must not undo it.
_DETAIL_MAX_CHARS = 300

# An absolute filesystem path inside an error message. `(?<![\w.])` is what keeps
# it from matching the tail of "min/max" or a URL's path; the alternation excludes
# the punctuation that normally ENDS a path in prose, so
# "corrupt file (/scratch/x.edf): ..." loses the path and keeps the sentence.
_LOCAL_PATH_RE = re.compile(r"(?<![\w.])(?:/[^\s'\"()\[\]{},;:]+)+")
# A Windows-style path, which reaches us through a library that formats one even
# on Linux (MNE embeds paths from a recording's own header) and through anyone
# running the converter on Windows. Same treatment as a POSIX path.
_WINDOWS_PATH_RE = re.compile(r"(?<![\w.])[A-Za-z]:[\\/][^\s'\"()\[\]{},;:]*")

# --- credential redaction ----------------------------------------------------
# The driver shells out to `aws` and reads HTTP, so an exception message can
# quote a presigned URL, a request header, or a key id -- and `detail` /
# `last_error` are PUBLISHED in index.json, on a public bucket, fetched by every
# dataset-page visit. Path stripping alone does not cover that: it was written
# for scratch directories, and a presigned S3 URL is not a filesystem path.
#
# Redaction is by VALUE, not by whole-message suppression: the diagnosis is the
# reason these fields exist (#1197), so "SignatureDoesNotMatch" has to survive
# while the signature does not.
_REDACTED = "[redacted]"
_SECRET_PATTERNS = (
    # `Authorization: AWS4-HMAC-SHA256 Credential=...` / `Bearer <token>`.
    re.compile(r"(?i)\b(authorization\s*[:=]\s*)\S+"),
    re.compile(r"(?i)\bbearer\s+[\w.\-+/=]+"),
    # Every AWS SigV4 query parameter, signature and credential included. Kept as
    # one alternation so a new X-Amz-* parameter is covered by the prefix rule.
    re.compile(r"(?i)([?&]x-amz-[\w-]+=)[^\s&'\"]*"),
    re.compile(r"(?i)\b(signature\s*[:=]\s*)[\w+/=%]+"),
    # Bare access-key ids, which appear in AWS error text without a URL around
    # them ("The AWS Access Key Id AKIA... does not exist"). ASIA is the STS
    # session form the Hallu profile actually uses.
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    # Any query parameter whose NAME says it is a secret, wherever it appears.
    re.compile(r"(?i)([?&](?:token|key|secret|password|passwd|sig|signature)=)[^\s&'\"]*"),
)


def redact_secrets(text: str) -> str:
    """Replace credential-shaped substrings in `text` with `[redacted]`.

    Applied to everything the converter publishes as `detail` or `last_error`.
    The failure mode this closes is narrow but real: a presigned-URL or
    credential error from `aws s3 cp` becomes an uncoded failure, whose message
    is then written verbatim into a world-readable index.json. Nothing else in
    the pipeline was going to catch that, because the message is not a path and
    not a secret the driver ever held in a variable.
    """
    for pattern in _SECRET_PATTERNS:
        # A capture group means "keep the label, drop the value"; no group means
        # the whole match is the secret.
        text = pattern.sub(
            lambda m: (m.group(1) + _REDACTED) if m.groups() else _REDACTED, text
        )
    return text


def strip_local_paths(text: str) -> str:
    """Replace absolute filesystem paths in `text` with `<path>`, POSIX and
    Windows alike.

    The conversion host's scratch directory is a fresh `mkdtemp` name every run,
    so a raw exception message publishes a directory that does not exist by the
    time anyone reads it, and makes two identical failures look different. The
    entry already carries the recording's BIDS `path`, so nothing is lost.

    Runs AFTER `redact_secrets` in `failure_detail`, deliberately: a presigned
    URL's path component would otherwise be collapsed to `<path>` first, taking
    the `X-Amz-Signature` query string with it in some messages and leaving it in
    others depending on punctuation. Redacting first makes the outcome the same
    either way.
    """
    return _WINDOWS_PATH_RE.sub("<path>", _LOCAL_PATH_RE.sub("<path>", text))


def failure_detail(exc: BaseException | str | None) -> str | None:
    """Operator-facing cause for a failed recording: the exception class plus the
    FIRST line of its message, local paths stripped, length-capped.

    This is the field that makes `file_read_error` diagnosable. on008083 published
    36 of them, every one reading "This recording could not be prepared for
    viewing" -- true, sanitized, and useless: it cannot distinguish a corrupt EDF
    from an importer gap without SSH access to the conversion node. The sanitized
    `reason` stays exactly as it was for the viewer; this rides alongside it for
    the human. #1197

    Published on a public bucket, so it is redacted (`redact_secrets`) as well as
    path-stripped: an `aws` or HTTP failure can quote a presigned URL, an
    Authorization header, or an access-key id, and none of those are paths.
    """
    if exc is None:
        return None
    if isinstance(exc, str):
        text, prefix = exc, ""
    else:
        text, prefix = str(exc), f"{type(exc).__name__}: "
    first = next((ln for ln in text.splitlines() if ln.strip()), "")
    # Redact BEFORE stripping paths -- see `strip_local_paths` for why the order
    # is load-bearing.
    detail = (prefix + strip_local_paths(redact_secrets(first))).strip()
    if not detail:
        return None
    return detail[:_DETAIL_MAX_CHARS]


def reason_for_code(code: str | None) -> str:
    """User-facing reason for a biosigIO failure code, preferring biosigIO's own
    REASONS (single source of truth) and falling back to a local copy."""
    if not code:
        return _GENERIC_REASON
    try:
        from biosigio.exceptions import REASONS  # type: ignore[import-not-found]

        if code in REASONS:
            return REASONS[code]
    except Exception:  # noqa: BLE001 - biosigio absent/old: use the local copy
        pass
    return _FALLBACK_REASONS.get(code, _GENERIC_REASON)


# The serving group + rate are driven by the recording's BIDS datatype SUFFIX, not
# by per-channel type guessing. A `*_eeg.set` is EEG (250 Hz cap) even when a few
# EOG/REF/trigger channels ride along; biosigIO's EEGLAB importer can only see an
# empty chanlocs `type` and would otherwise fall back to OTHER -> MISC, yielding a
# `misc_1024hz` group (no cap) instead of the intended `eeg_250hz`. We force every
# channel's modality from the suffix so the whole recording lands in one coherent
# group at the modality's MODALITY_RATES cap.
_SUFFIX_MODALITY = {"eeg": "EEG", "meg": "MEG", "ieeg": "IEEG", "emg": "EMG"}


def bids_suffix_modality(path: str) -> str | None:
    """Modality from a recording's BIDS suffix (`sub-01_task-rest_eeg.set` -> EEG),
    or None when the trailing `_<suffix>` is not a known datatype. The rate cap
    then follows from MODALITY_RATES (EEG/MEG 250 Hz, IEEG/EMG 1000 Hz)."""
    stem = os.path.basename(path).rsplit(".", 1)[0]
    suffix = stem.rsplit("_", 1)[-1].lower() if "_" in stem else ""
    return _SUFFIX_MODALITY.get(suffix)

ANNEX_TARGET_RE = re.compile(r"\.git/annex/objects/[A-Za-z0-9]+/[A-Za-z0-9]+/([^/]+)/\1$")
ANNEX_POINTER_CONTENT_RE = re.compile(r"^/annex/objects/(.+)$")


def lower_ext(path: str) -> str:
    return os.path.splitext(path)[1].lower()


def in_excluded_tree(path: str) -> bool:
    """True if `path` sits under `derivatives/`, `sourcedata/`, or `code/`,
    matched at the top level or nested, on a full path SEGMENT rather than a
    bare substring -- `mycode/`, `derivatives_old/`, and a task label
    containing "code" must still be discoverable. Same shape as
    `emit_records.py`'s `derivatives`/`sourcedata` exclusion in this repo."""
    return any(
        path.startswith(f"{tree}/") or f"/{tree}/" in path for tree in EXCLUDED_TREES
    )


def source_tree_for(path: str) -> str:
    """Which BIDS tree a source recording lives in: "raw", or the excluded tree
    that contains it (`derivatives` / `sourcedata` / `code`).

    Published per store as `source_tree` (#1064), where it is always "raw": ADR
    0027 made discovery raw-only, and `merge_index` DROPS a carried-over store
    whose path is excluded rather than republishing it -- those stores are being
    deleted by `purge_non_raw_stores.py`, so an index that described them would
    advertise bytes that are going away. The drop is reported (logged with the
    tree, counted as `non_raw_dropped` on the callback), never published.

    So this function's non-raw answers do not reach the index at all. They exist
    because the drop has to be able to SAY why: `excluded_reason` names the cause
    on each logged line, and "dropped a store" versus "dropped a store because it
    is under `derivatives/`" are very different lines to find in a cron log when
    an orphan-detection bug is the alternative explanation.

    Deliberately NOT the same question as the store entry's `derived`, which is
    about whether the SIGNAL was processed (ADR 0028 Signal-Space Separation). A
    recording can sit in `derivatives/` and be served unprocessed, and an
    SSS-filtered MEG store is derived while its source is raw.
    """
    for tree in EXCLUDED_TREES:
        if path.startswith(f"{tree}/") or f"/{tree}/" in path:
            return tree
    return "raw"


def is_bids_calibration_file(path: str) -> bool:
    """True for a BIDS-reserved MEG calibration filename (crosstalk or
    fine-calibration correction data), which is never a recording."""
    return path.endswith(_BIDS_CALIBRATION_SUFFIXES)


def maxshield_calibration_for(
    primary_path: str, head_files: set[str] | frozenset[str]
) -> tuple[str, str] | None:
    """The `(fine_calibration, cross_talk)` pair applying to `primary_path`, or None
    when either is absent.

    Resolved by BIDS inheritance: the nearest match in the recording's own directory
    or any ancestor, most specific winning. Both must resolve -- ADR 0028 declines
    rather than run Signal-Space Separation uncalibrated, because an uncalibrated
    correction is weaker in a way a consumer could not distinguish from a good one.

    These are exactly the files `is_bids_calibration_file` excludes from DISCOVERY.
    That is not a contradiction and the two must not be conflated: they are never
    recordings, and they are inputs to converting one. A future change that reads
    "excluded from discovery" as "irrelevant to conversion" silently breaks MaxShield
    support (ADR 0028's own warning).

    The entity-subset rule the other sidecar resolvers use does NOT work here, which
    is why this is its own function. `sub-01_acq-calibration_meg.dat` carries
    `acq=calibration`, while the recording `sub-01_task-rest_meg.fif` has no `acq` at
    all, so the subset test rejects the very file it should find. `acq` is the entity
    that NAMES these sidecars rather than scoping them, so it is exempt here.
    """
    rec_dir = os.path.dirname(primary_path)
    rec_ents = _bids_entities(filename_stem(primary_path))

    def _nearest(suffix: str) -> str | None:
        # Same two accepted spellings as the other sidecar resolvers: the
        # entity-prefixed form beside the recording, or the bare form (no leading
        # underscore) at a level that has no entities of its own.
        bare = suffix.lstrip("_")
        candidates: list[tuple[int, int, str]] = []
        for f in head_files:
            if not (f.endswith(suffix) or os.path.basename(f) == bare):
                continue
            cdir = os.path.dirname(f)
            if cdir and rec_dir != cdir and not rec_dir.startswith(cdir + "/"):
                continue
            cents = _bids_entities(filename_stem(f))
            cents.pop("acq", None)  # names the sidecar, does not scope it
            if any(rec_ents.get(k) != v for k, v in cents.items()):
                continue
            candidates.append((cdir.count("/") + (1 if cdir else 0), len(cents), f))
        if not candidates:
            return None
        candidates.sort()
        return candidates[-1][2]

    cal = _nearest("_acq-calibration_meg.dat")
    ctc = _nearest("_acq-crosstalk_meg.fif")
    return (cal, ctc) if cal and ctc else None


def is_maxshield_fif(path: str) -> bool:
    """True if `path` is a FIF carrying raw Internal Active Shielding data.

    Reads the FIF header only (`preload=False`), which is cheap even on a large
    recording -- measured at 1.6 s and 0.13 GiB of peak RSS against a 716 MiB file on
    the conversion node -- so this is affordable as a preflight on every FIF.

    `allow_maxshield="yes"` is the quiet form: it suppresses MNE's warning, which we
    do not want in the log for a file we are about to correct properly. The flag we
    read back, `info["maxshield"]`, is MNE's own; ADR 0028 established that it flips
    True -> False once Signal-Space Separation has run, so the same field serves as
    both the detector here and the verification afterwards.

    A non-FIF path is not our business: return False and let the normal
    conversion path produce its own typed failure. A FIF whose header cannot
    be read raises `MaxShieldProbeFailed` (#1139) rather than swallowing the
    exception and returning False: doing that used to route the recording
    down the NORMAL conversion path, which for a file this probe could not
    even open failed anyway -- as an uncoded (or differently-coded)
    `file_read_error`, with nothing on the public index distinguishing "the
    MaxShield probe itself could not read this FIF" from any other read
    failure. `convert_one` classifies the raised exception the same way it
    classifies every other typed failure, via `.code` and `failure_detail`.
    """
    if lower_ext(path) != ".fif":
        return False
    try:
        import mne  # type: ignore[import-not-found]  # lazy: runtime-only dep

        info = mne.io.read_raw_fif(
            path, allow_maxshield="yes", preload=False, verbose="ERROR"
        ).info
        return bool(info.get("maxshield"))
    except Exception as exc:  # reclassified as MaxShieldProbeFailed below
        raise MaxShieldProbeFailed(
            f"could not read the FIF header to test for Internal Active "
            f"Shielding: {type(exc).__name__}: {exc}"
        ) from exc


def apply_sss(raw_path: str, calibration: str, cross_talk: str, out_path: str) -> dict:
    """Signal-Space Separation filter a MaxShield recording, writing the corrected
    recording to `out_path`. Returns the disclosure recorded in the store and index.

    ADR 0028: raw Internal Active Shielding data is never served. It is corrected
    with the recording's own site-specific fine-calibration and cross-talk files, or
    it is declined. `mne.preprocessing.maxwell_filter` is an open-source
    implementation of the same Signal-Space Separation family as MEGIN's proprietary
    MaxFilter, which the conversion host cannot run.

    The result is a PROCESSED DERIVATIVE, unlike every other store this converter
    writes, which is why this returns a disclosure rather than filtering silently.
    """
    import mne  # type: ignore[import-not-found]  # lazy: runtime-only dep

    raw = mne.io.read_raw_fif(
        raw_path, allow_maxshield="yes", preload=True, verbose="ERROR"
    )
    try:
        sss = mne.preprocessing.maxwell_filter(
            raw, calibration=calibration, cross_talk=cross_talk, verbose="ERROR"
        )
    except MemoryError:
        # Genuinely transient: the node was busy, not the data wrong. Let it reach
        # the retryable `recording_memory_exceeded` verdict.
        raise
    except Exception as exc:  # noqa: BLE001 - see below
        # A calibration pair that is PRESENT but does not fit this recording (wrong
        # sensor set, wrong site, malformed file) is just as permanent a property of
        # what the dataset ships as a missing pair, so it gets the same terminal
        # verdict. Left uncoded it would fall through to the generic handler as an
        # infra failure and re-run maxwell_filter on every future pass forever --
        # the anti-pattern #1110 exists to prevent, at ~1 minute of compute a time.
        raise MaxShieldUncalibrated(
            f"Signal-Space Separation failed with this recording's calibration pair "
            f"({os.path.basename(calibration)}, {os.path.basename(cross_talk)}): "
            f"{type(exc).__name__}: {exc}"
        ) from exc
    # MNE's own guardrail, the check that refused to load the file, is satisfied by
    # the output. If it is not, the correction did not happen and serving the result
    # would be exactly the thing ADR 0028 forbids -- so fail rather than publish it.
    if sss.info.get("maxshield"):
        raise MaxShieldUncalibrated(
            "Signal-Space Separation ran but the recording is still flagged as raw "
            "Internal Active Shielding data; refusing to serve it"
        )
    sss.save(out_path, overwrite=True, verbose="ERROR")
    return {
        "applied": True,
        "method": "maxwell_filter",
        "calibration": os.path.basename(calibration),
        "cross_talk": os.path.basename(cross_talk),
        "mne_version": mne.__version__,
    }


def is_excluded_from_discovery(path: str) -> bool:
    """True if `path` can never be a servable BIDS raw recording: it sits
    under an excluded tree, or it is a reserved BIDS calibration filename.

    The single predicate every recording-discovery path runs a candidate
    through before treating it as buildable -- `is_primary`, the directory-
    recording derivations (`dir_recordings` for CTF `.ds`/MEF3 `.mefd`,
    `bti_recordings` for 4D/BTi), the diff-based companion/`_events.tsv`
    routing in `compute_worklist`, the stale-failure carry-forward in
    `merge_index`, and the `--clean` orphan-safety filter in
    `compute_clean_orphans`. One predicate used everywhere instead of
    repeating the tree/filename checks inline keeps the raw-only scope
    consistent across every entry point.
    """
    return in_excluded_tree(path) or is_bids_calibration_file(path)


def excluded_reason(path: str) -> str | None:
    """WHY `is_excluded_from_discovery` rejects `path`, or None if it does not:
    the excluded tree's name, or `bids-calibration`.

    Exists so a drop can be logged with its cause. "Dropped a store" and
    "dropped a store because it is under `derivatives/`" are very different
    lines to find in a cron log when a real orphan bug is the alternative
    explanation.
    """
    for tree in EXCLUDED_TREES:
        if path.startswith(f"{tree}/") or f"/{tree}/" in path:
            return tree
    if is_bids_calibration_file(path):
        return "bids-calibration"
    return None


def non_raw_store_paths(prior: dict | None) -> list[str]:
    """Paths in a prior index's `stores` that discovery no longer walks.

    The count `main` reports as `non_raw_dropped`. Read from the PRIOR PUBLISHED
    index rather than from `merge_index`'s filtering, because the production path
    is `--clean`: there `prior` is not passed to the merge at all, so the entries
    never enter and the filter never sees them -- yet they are still gone from
    the index a client will fetch next, which is the thing worth reporting.
    """
    return sorted(
        str(e.get("path"))
        for e in (prior or {}).get("stores", [])
        if isinstance(e, dict)
        and isinstance(e.get("path"), str)
        and is_excluded_from_discovery(e["path"])
    )


def is_primary(path: str) -> bool:
    return lower_ext(path) in PRIMARY_EXTS and not is_excluded_from_discovery(path)


def is_events_tsv(path: str) -> bool:
    return path.endswith("_events.tsv")


def filename_stem(path: str) -> str:
    """`sub-01/eeg/sub-01_task-x_eeg.vhdr` -> `sub-01_task-x_eeg`."""
    return os.path.splitext(os.path.basename(path))[0]


def entities_base(stem: str) -> str:
    """Drop the trailing BIDS suffix: `sub-01_task-x_eeg` -> `sub-01_task-x`."""
    return stem.rsplit("_", 1)[0] if "_" in stem else stem


# --- BIDS split recordings (multi-file FIF) ------------------------------
#
# MNE writes a recording larger than the FIF 2 GB limit as a chain of files
# `..._split-01_<suffix>.fif`, `..._split-02_<suffix>.fif`, ...; the first file
# holds the header and a pointer to the next, so `read_raw_fif(split-01)` follows
# the chain and returns the WHOLE recording. The other splits are not standalone
# recordings -- reading one in isolation yields only its segment. So a split group
# is ONE logical recording: the lowest-index split is the chain head (the only
# buildable primary), every split must be materialised together for MNE to follow
# the chain, and exactly one store is written (keyed at the head split's path).
_SPLIT_RE = re.compile(r"_split-(\d+)")


def split_index(path: str) -> int | None:
    """Numeric `split-NN` entity of a BIDS split file (`..._split-02_meg.fif` -> 2),
    or None when the path carries no `split-` entity."""
    m = _SPLIT_RE.search(os.path.basename(path))
    return int(m.group(1)) if m else None


def _strip_split(stem: str) -> str:
    """Remove the `_split-NN` entity token from a stem (no-op when absent)."""
    return _SPLIT_RE.sub("", stem, count=1)


def is_split_fif(path: str) -> bool:
    """True for a FIF recording carrying a `split-` entity (the only ext where the
    split chain matters; other formats are single-file)."""
    return lower_ext(path) == ".fif" and split_index(path) is not None


def split_group_key(path: str) -> str:
    """Identity of the logical recording a split file belongs to: its path with the
    `_split-NN` entity removed. `sub-03/meg/sub-03_task-x_split-02_meg.fif` ->
    `sub-03/meg/sub-03_task-x_meg.fif`. A non-split path returns unchanged."""
    d = os.path.dirname(path)
    base = _SPLIT_RE.sub("", os.path.basename(path), count=1)
    return f"{d}/{base}" if d else base


def split_heads_and_members(primaries: list[str]) -> tuple[set[str], dict[str, str]]:
    """Partition primaries into buildable heads + a non-head-split -> head map.

    `heads` is every primary that should build a store: non-split primaries
    verbatim, plus the lowest-index split of each FIF split group. `member_to_head`
    maps each NON-head split to its head, so a change to any split rebuilds the one
    head store. A degenerate group whose `split-01` is absent picks the lowest
    present split as head (best-effort; MNE then reads from there)."""
    groups: dict[str, list[str]] = {}
    heads: set[str] = set()
    for p in primaries:
        if is_split_fif(p):
            groups.setdefault(split_group_key(p), []).append(p)
        else:
            heads.add(p)
    member_to_head: dict[str, str] = {}
    for members in groups.values():
        ordered = sorted(members, key=lambda x: (split_index(x), x))
        head = ordered[0]
        heads.add(head)
        for m in ordered[1:]:
            member_to_head[m] = head
    return heads, member_to_head


def split_members_for(primary_path: str, head_files: set[str]) -> list[str]:
    """Every FIF split that shares `primary_path`'s split group, sorted by index
    (includes the head). `[]` when `primary_path` is not a split file. Used to (a)
    materialise the whole chain and (b) record the member list on the index entry so
    the browser can resolve any split file to the one store."""
    if not is_split_fif(primary_path):
        return []
    gkey = split_group_key(primary_path)
    members = [p for p in head_files if is_split_fif(p) and split_group_key(p) == gkey]
    return sorted(members, key=lambda x: (split_index(x), x))


def store_rel_for(primary_path: str) -> str:
    """`sub-01/eeg/sub-01_task-x_eeg.set` -> `sub-01/eeg/sub-01_task-x_eeg.zarr`.

    Strips the data extension and appends `.zarr`; the BIDS suffix (`_eeg`,
    `_emg`, ...) is preserved, so the rule is uniform across all primary exts and
    over a directory recording (CTF `..._meg.ds` -> `..._meg.zarr`, MEF3
    `..._ieeg.mefd` -> `..._ieeg.zarr`). A 4D/BTi directory carries no extension
    at all, so `os.path.splitext` finds none to strip and this is a plain
    `path + ".zarr"` for it (`..._meg` -> `..._meg.zarr`).
    """
    root, _ = os.path.splitext(primary_path)
    return root + ".zarr"


# --- Extension-keyed directory recordings (CTF `.ds`, MEF3 `.mefd`) -----------
#
# A CTF recording is a directory `..._meg.ds/` holding `.meg4` (data) + `.res4`/
# `.hc`/... headers. A MEF3 recording is a directory `..._ieeg.mefd/` holding one
# `<CHANNEL>.timd/<CHANNEL>-000000.segd/` per channel, each with `.tdat`/`.tidx`/
# `.tmet`. Both are directories git tracks by their inner files, never the
# directory itself, so each is derived from those files and treated as one
# primary keyed at the directory path; biosigIO/MNE reads the directory whole
# (`read_raw_ctf` / `read_raw_mef`). Generalized into one mechanism (rather than
# copy-pasting the CTF logic for MEF3) because the shape is identical: both are
# recognized by an EXTENSION on a path component, so the recording can be derived
# from any member path alone, without consulting `head_files`. Contrast 4D/BTi
# just below, which is directory-based too but has no extension and needs
# content-based detection instead.


def dir_recording_of(path: str) -> str | None:
    """The `.ds`/`.mefd` recording directory a path belongs to, or None.

    `sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4` ->
    `sub-01/meg/sub-01_task-x_meg.ds`; likewise a `.mefd` member resolves to its
    `.mefd` directory regardless of nesting depth (a MEF3 recording nests a
    `<CHANNEL>.timd/<CHANNEL>-000000.segd/*.tdat` several levels below the
    `.mefd` itself). Returns a directory path itself unchanged. Only the FIRST
    matching component counts (neither `.ds` nor `.mefd` dirs are nested)."""
    parts = path.split("/")
    for i, comp in enumerate(parts):
        lower = comp.lower()
        if any(lower.endswith(ext) for ext in DIR_RECORDING_EXTS):
            return "/".join(parts[: i + 1])
    return None


def is_dir_recording(path: str) -> bool:
    """True if `path` is exactly a `.ds`/`.mefd` recording directory (not a file
    inside one)."""
    stripped = path.lower().rstrip("/")
    return any(stripped.endswith(ext) for ext in DIR_RECORDING_EXTS)


def is_mefd(path: str) -> bool:
    """True if `path` is exactly a MEF3 `.mefd` recording directory."""
    return path.lower().rstrip("/").endswith(MEFD_EXT)


def dir_recordings(head_files) -> set[str]:
    """Every CTF `.ds` / MEF3 `.mefd` recording directory present in `head_files`
    (derived from the inner files, since the directory itself is never a tracked
    path).

    Excludes a directory under an excluded tree (derivatives/sourcedata/code): a
    directory recording's identity is directory-derived rather than an extension
    match on the recording's OWN path, so it needs its own
    `is_excluded_from_discovery` check rather than inheriting `is_primary`'s.
    """
    dirs: set[str] = set()
    for f in head_files:
        d = dir_recording_of(f)
        if d is not None and not is_excluded_from_discovery(d):
            dirs.add(d)
    return dirs


# --- Content-keyed directory recordings (4D/BTi) -------------------------------
#
# 4D/BTi is directory-based like CTF/MEF3, but BIDS gives it NO extension at all,
# so it cannot be derived from a path component the way `dir_recording_of` does.
# Detection is instead by CONTENT: a directory qualifies only when it directly
# (non-nested) contains a `c,rf*`-prefixed processed-data file (conventionally
# `c,rfDC`; a hardware-filtered copy such as `c,rfDC,fn50,o` also matches) AND a
# sibling `config` file -- exactly biosigIO's own `importers.meg._find_bti_pdf`
# gate, so this converter and biosigIO agree on what counts as a BTi recording
# (the converter decides what's a recording; biosigIO decides which file it
# reads -- if they disagreed, the index would describe a different file than was
# actually converted). `config` is checked but never sufficient by itself:
# `.datalad/config` exists in virtually every datalad-tracked dataset, and using
# it alone as the detector would treat every repo as a BTi recording.


def is_bti_marker_name(name: str) -> bool:
    """True for a basename that participates in 4D/BTi directory detection: the
    processed-data file (`c,rf*`) or its required `config` sibling. `hs_file`
    (the optional head-shape sidecar) deliberately does NOT count -- its absence
    or removal must not affect whether a directory is a BTi recording."""
    return name == _BTI_CONFIG_NAME or name.startswith(_BTI_PDF_PREFIX)


def bti_recordings(head_files) -> set[str]:
    """Every 4D/BTi recording directory present in `head_files`, detected by
    content rather than extension (see the module note above): a directory
    qualifies when it directly contains both a `c,rf*` file and a sibling
    `config` file. Excludes a directory under an excluded tree
    (derivatives/sourcedata/code), like `dir_recordings`.
    """
    names_by_dir: dict[str, set[str]] = {}
    for f in head_files:
        names_by_dir.setdefault(os.path.dirname(f), set()).add(os.path.basename(f))
    dirs: set[str] = set()
    for d, names in names_by_dir.items():
        if not d or is_excluded_from_discovery(d):
            continue
        if _BTI_CONFIG_NAME in names and any(n.startswith(_BTI_PDF_PREFIX) for n in names):
            dirs.add(d)
    return dirs


def is_bti_dir(path: str) -> bool:
    """True for a path that is a 4D/BTi recording directory keyed the
    extension-less way (see `bti_recordings`).

    A bare extension check, not a content re-check: every OTHER primary this
    converter discovers carries a real extension (`PRIMARY_EXTS`, or `.ds`/
    `.mefd` via `DIR_RECORDING_EXTS`), so this is only ever called on a path
    already known to be a recording (from the worklist), where "no extension"
    unambiguously means "4D/BTi directory."
    """
    return lower_ext(path) == ""


def bti_pdf_choice(basenames) -> tuple[str | None, bool]:
    """Which processed-data file biosigIO's `_find_bti_pdf` will read among the
    `c,rf*`-prefixed candidates in `basenames`, and whether that choice is
    AMBIGUOUS (more than one candidate present, or falling back off the
    canonical name).

    Mirrors biosigIO 1.2.3's precedence exactly: an exact `c,rfDC` always wins;
    otherwise the first candidate in `sorted()` order (filesystem listing order
    is NOT used -- verified to matter in practice, see biosigIO's module note).
    Neither side of this converter picks a file to convert -- biosigIO alone
    reads the directory -- so this exists purely to let this converter's own
    discovery/materialization logging name the SAME file biosigIO is expected
    to read, keeping the two sides verifiably in agreement (see the module note
    above: if they disagreed, the index would describe a different file than
    was actually converted). Returns (None, False) when no `c,rf*` candidate is
    present at all.
    """
    candidates = sorted(n for n in basenames if n.startswith(_BTI_PDF_PREFIX))
    if not candidates:
        return None, False
    fell_back = "c,rfDC" not in candidates
    chosen = candidates[0] if fell_back else "c,rfDC"
    ambiguous = fell_back or len(candidates) > 1
    return chosen, ambiguous


def events_sibling_for(primary_path: str) -> str:
    """BIDS events sidecar path for a recording (suffix `_events`, ext `.tsv`).

    `sub-01/eeg/sub-01_task-x_eeg.set` -> `sub-01/eeg/sub-01_task-x_events.tsv`.

    The `split-NN` entity is dropped (a split FIF recording shares one events file
    without it): `sub-03/meg/sub-03_task-x_split-01_meg.fif` ->
    `sub-03/meg/sub-03_task-x_events.tsv`.
    """
    d = os.path.dirname(primary_path)
    base = _strip_split(entities_base(filename_stem(primary_path)))
    name = f"{base}_events.tsv"
    return f"{d}/{name}" if d else name


def _bids_entities(stem: str) -> dict[str, str]:
    """Entity key->value pairs from a BIDS stem (`sub-01_task-x_run-2_eeg` ->
    {sub: 01, task: x, run: 2}); the trailing suffix token (no dash) is ignored."""
    ents: dict[str, str] = {}
    for tok in stem.split("_"):
        if "-" in tok:
            k, v = tok.split("-", 1)
            ents[k] = v
    return ents


def _read_repo_text(repo_dir: str, head: str, path: str) -> str | None:
    """Read a git-tracked text file at `head`. Uses the working tree when present
    (local/Hallu mode), else falls back to `git cat-file` -- the workflow clones
    `--no-checkout`, so there is no working tree there. None if unreadable."""
    try:
        with open(os.path.join(repo_dir, path), encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        pass
    try:
        return subprocess.check_output(
            ["git", "-C", repo_dir, "cat-file", "blob", f"{head}:{path}"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, OSError):
        return None


def power_line_frequency_for(
    repo_dir: str, primary_path: str, head_files: set[str], head: str
) -> float | None:
    """BIDS PowerLineFrequency (Hz) for a recording, resolved via the inheritance
    principle: among the `_<suffix>.json` sidecars sitting in the recording's
    directory or an ancestor whose entities are a subset of the recording's, the
    most specific one that declares PowerLineFrequency wins. Returns None when none
    declare it (so the viewer leaves the notch off).

    Sidecars are git-tracked text (not annexed); they are read at `head` from the
    working tree when present and `git cat-file` otherwise, so this works in both
    the no-checkout workflow clone and the local/Hallu working tree -- one grep of
    the head file list, then a couple of small reads, no annex download.
    """
    stem = filename_stem(primary_path)
    suffix = stem.rsplit("_", 1)[-1].lower() if "_" in stem else ""
    if not suffix:
        return None
    rec_dir = os.path.dirname(primary_path)
    rec_ents = _bids_entities(stem)
    needle = f"_{suffix}.json"
    candidates: list[tuple[int, int, str]] = []
    for f in head_files:
        if not f.endswith(needle):
            continue
        cdir = os.path.dirname(f)
        # Applicable only if the sidecar is in the recording's dir or an ancestor.
        if cdir and rec_dir != cdir and not rec_dir.startswith(cdir + "/"):
            continue
        cents = _bids_entities(filename_stem(f))
        # ...and its entities must be a subset of the recording's.
        if any(rec_ents.get(k) != v for k, v in cents.items()):
            continue
        depth = cdir.count("/") + (1 if cdir else 0)
        candidates.append((depth, len(cents), f))
    candidates.sort()  # least specific first; the most specific value overrides
    plf: float | None = None
    for _, _, f in candidates:
        text = _read_repo_text(repo_dir, head, f)
        if text is None:
            continue
        try:
            data = json.loads(text)
        except ValueError:
            continue
        if not isinstance(data, dict):
            continue
        v = data.get("PowerLineFrequency")
        if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
            plf = float(v)
    return plf


def store_total_channels(meta: dict) -> int:
    """Total channels a built store serves, summed across its groups (a group
    with a missing/None n_channels counts 0). Compared against
    ``expected_channel_count_for`` by the fidelity gate in ``convert_one``."""
    return sum(int(g.get("n_channels") or 0) for g in meta.get("groups", []))


def channels_tsv_for(primary_path: str, head_files) -> str | None:
    """Repo-relative path of the `_channels.tsv` that applies to a recording, or
    None when none does.

    BIDS inheritance, closest-file-wins: among the sidecars in the recording's
    directory or an ancestor whose entities are a subset of the recording's, the
    most specific one wins. Unlike the JSON sidecars there is no per-field merge
    across levels -- a TSV is adopted whole.

    Two callers, deliberately the same resolution: the fidelity gate reads it for
    the ground-truth channel count, and the converter hands it to biosigIO's
    `bids.apply_channels_tsv` so the served samples are in the unit the sidecar
    declares. They must agree about WHICH file applies, or the gate would be
    checking a different sidecar than the one that shaped the store.
    """
    stem = filename_stem(primary_path)
    rec_dir = os.path.dirname(primary_path)
    rec_ents = _bids_entities(stem)
    candidates: list[tuple[int, int, str]] = []
    for f in head_files:
        if not f.endswith("_channels.tsv"):
            continue
        cdir = os.path.dirname(f)
        if cdir and rec_dir != cdir and not rec_dir.startswith(cdir + "/"):
            continue
        cents = _bids_entities(filename_stem(f))
        if any(rec_ents.get(k) != v for k, v in cents.items()):
            continue
        depth = cdir.count("/") + (1 if cdir else 0)
        candidates.append((depth, len(cents), f))
    if not candidates:
        return None
    candidates.sort()
    return candidates[-1][2]  # most specific


# --- events -------------------------------------------------------------------
# ONE parse of the events.tsv a store was built from feeds BOTH the per-store
# `n_events`/`trial_types` in index.json (#1059) and the rows of
# `<id>/zarr/events.parquet` (#1060). Two parsers would eventually disagree, and
# a summary that contradicts the file a client can download is worse than no
# summary: the summary is what a client uses to decide whether to fetch at all.

# The published columns, in order (#1060). Every string one is dictionary-encoded
# in the parquet; `onset_s` is float64, `duration_s` float32, `sample_index`
# int64. A remaining events.tsv column passes through under its own name -- with
# `x_` prefixed only when that name would collide with one of these.
EVENTS_FIXED_COLUMNS = (
    "store_path",
    "subject",
    "session",
    "task",
    "run",
    "onset_s",
    "duration_s",
    "sample_index",
    "group_name",
    "trial_type",
    "value",
    "hed",
)
# events.tsv column (lower-cased) -> the fixed column it feeds. BIDS spells the
# HED column `HED`, and real datasets use both cases, so the match is
# case-insensitive; a second column that lower-cases to the same name passes
# through instead of overwriting the first.
EVENTS_SOURCE_COLUMNS = {
    "onset": "onset_s",
    "duration": "duration_s",
    "trial_type": "trial_type",
    "value": "value",
    "hed": "hed",
}
EVENTS_PASSTHROUGH_PREFIX = "x_"
# BIDS's null. A cell carrying it becomes a real null rather than three literal
# characters a client would have to know to filter out.
EVENTS_NA = "n/a"


class ParsedEvents(TypedDict):
    """A BIDS events.tsv exactly as read: the header, and the cells of each data
    row. Values stay strings here -- typing them is the row builder's job, and
    the summary needs only to count."""

    columns: list[str]
    rows: list[list[str]]


def parse_events_tsv(events_text: str | None) -> ParsedEvents | None:
    """Parse the text of the events.tsv the converter applied. `None` in, `None`
    out -- "no events.tsv applies", which is not the same as an empty one.

    Deliberately minimal (header row, tab-separated, no quoting rules), which is
    what BIDS specifies. The one non-obvious rule is the UTF-8 BOM: a
    spreadsheet-exported events.tsv starts with U+FEFF, which would otherwise
    make the first column "\\ufeffonset" -- silently costing every row its onset,
    and therefore its sample index. nm000329 ships exactly that file.

    Blank lines are dropped anywhere, so a trailing newline is not an event.
    """
    if events_text is None:
        return None
    lines = [ln for ln in events_text.lstrip("\ufeff").splitlines() if ln.strip()]
    if not lines:
        return {"columns": [], "rows": []}
    return {
        "columns": [c.strip() for c in lines[0].split("\t")],
        "rows": [ln.split("\t") for ln in lines[1:]],
    }


def events_summary_of(parsed: ParsedEvents | None) -> dict:
    """`{n_events, trial_types}` for a parsed events.tsv, or `{}` when none
    applies.

    Published per store so a client can judge whether a dataset is worth opening,
    and which epoching strategy fits, without reading a signal byte (#1059). The
    counts describe the SAME file the parquet rows are built from and the SAME
    file biosigIO was handed -- one parse, one set of numbers.

    An empty `trial_types` means the file has no `trial_type` column (or every
    row is `n/a`); the absence of both keys means there was no events.tsv at all.
    The distinction matters to a consumer deciding whether "no trial types" is a
    property of the data or of the pipeline.
    """
    if parsed is None:
        return {}
    try:
        col = [c.lower() for c in parsed["columns"]].index("trial_type")
    except ValueError:
        col = -1
    counts: dict[str, int] = {}
    if col >= 0:
        for fields in parsed["rows"]:
            if col >= len(fields):
                continue
            value = fields[col].strip()
            if not value or value.lower() == EVENTS_NA:
                continue
            counts[value] = counts.get(value, 0) + 1
    return {"n_events": len(parsed["rows"]), "trial_types": dict(sorted(counts.items()))}


def events_summary(events_text: str | None) -> dict:
    """`{n_events, trial_types}` straight from the events.tsv text. The parse the
    parquet rows come from, so the two can never disagree."""
    return events_summary_of(parse_events_tsv(events_text))


def _event_cell(fields: list[str], col: int) -> str | None:
    """One cell as a published string: `None` for missing, blank, or `n/a`."""
    if col < 0 or col >= len(fields):
        return None
    value = fields[col].strip()
    return None if not value or value.lower() == EVENTS_NA else value


def _event_number(fields: list[str], col: int) -> float | None:
    """One cell as a float, or `None` when it is absent or not a number. A
    malformed onset yields a null onset and a null `sample_index` rather than a
    dropped row: the row still says an event was declared, and a client can see
    that its position is unknown instead of silently getting one fewer event."""
    raw = _event_cell(fields, col)
    if raw is None:
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def sample_index_for(onset_s: float | None, rate: float | None) -> int | None:
    """The level-0 sample an onset falls on, or `None` when it cannot be computed.

    ``math.floor(onset_s * rate + 0.5)``, where `rate` is the group's SERVING
    rate (the level-0 `rate` attr the index republishes). Written out rather than
    called ``round()`` because the two DIFFER: Python's ``round()`` is
    banker's rounding, which breaks an exact .5 tie toward the even integer
    (``round(0.5) == 0``, ``round(1.5) == 2``), while this ties UP everywhere
    (``0.5 -> 1``, ``1.5 -> 2``). A tie is not exotic here -- an onset of 0.5 s
    at 1 Hz, or any onset landing on a half sample at the serving rate, hits it
    -- and a client that reimplements the column with ``round()`` would disagree
    with the published value on exactly those rows, which is the failure the
    column exists to prevent.

    That is the whole formula, and the reason it is this simple is worth writing
    down once, because the point of publishing the column at all is that a client
    should not have to re-derive it (#1060):

    * biosigIO resamples level 0 to ``target_rate = min(native_rate, cap)`` with
      ``scipy.signal.resample_poly(x, up, down)``, ``up/down =
      Fraction(round(target), round(native))``, and trims/pads the result to
      ``n_out = round(n_native * target / native)``. So level 0 is exactly the
      grid ``t[n] = n / target_rate`` over the same span as the source -- both
      exporters, in-memory and streaming, share ``_resample_channel``.
    * ``resample_poly`` is ZERO-PHASE: it compensates the polyphase FIR's group
      delay internally, so output sample ``n`` is at absolute time ``n / rate``
      with no delay term to subtract. This is verified against a real
      1000 Hz -> 250 Hz recording in the test suite (nm000329) by correlating the
      served level-0 signal against the native samples taken at the same absolute
      times; a filter delay would show up there as a non-zero lag.

    The index is thus the only place the relation is known exactly -- a client
    that guesses `rate` from the acquisition rate, or that subtracts a delay it
    assumes is there, is wrong by a fraction of a sample everywhere the ratio is
    not an integer.

    NOT clamped to the group's length. An onset past the end of the recording is
    a property of the data, and a clamped index would be indistinguishable from
    an event that genuinely lands on the last sample; clients bound-check against
    `groups[].n_samples`, which the index publishes beside this.
    """
    if onset_s is None or rate is None:
        return None
    try:
        rate = float(rate)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(rate) or rate <= 0 or not math.isfinite(onset_s):
        return None
    return math.floor(onset_s * rate + 0.5)


def _passthrough_column_names(columns: list[str]) -> dict[int, str]:
    """Source-column index -> published column name, for the events.tsv columns
    that are not one of the five the fixed columns consume.

    `x_` is prefixed only on a collision -- with a fixed column name, or with a
    name already taken (a duplicate header). Prefixing until free rather than
    dropping: a duplicated or awkwardly-named column is malformed input, and
    losing its values silently is the worse failure."""
    taken = set(EVENTS_FIXED_COLUMNS)
    consumed: set[str] = set()
    out: dict[int, str] = {}
    for i, raw in enumerate(columns):
        name = raw.strip()
        if not name:
            continue
        key = name.lower()
        if key in EVENTS_SOURCE_COLUMNS and key not in consumed:
            consumed.add(key)
            continue
        while name in taken:
            name = EVENTS_PASSTHROUGH_PREFIX + name
        taken.add(name)
        out[i] = name
    return out


def event_rows_for_store(
    zarr_rel: str,
    primary_path: str,
    groups: list[dict] | None,
    parsed: ParsedEvents | None,
) -> dict[str, list] | None:
    """The `events.parquet` rows for one store, as a column -> values mapping, or
    `None` when the store contributes none.

    ONE ROW PER (EVENT, CHANNEL GROUP). A store's groups are concurrent streams
    of one recording at different rates (biosigIO names them
    `<modality>_<rate>hz`), so a single onset has a different sample index in
    each; `group_name` is what tells the rows apart, and joining on it plus
    `store_path` is how a client gets the index that matches the array it is
    about to read. Rows are ordered by onset, then group name.

    `subject`/`session`/`task`/`run` come from the recording's BIDS entities so
    the file can be filtered without a join back to the index; `session` and
    `run` are null for a dataset that uses neither.
    """
    if parsed is None or not parsed["rows"]:
        return None
    named = sorted(
        (g for g in (groups or []) if isinstance(g, dict) and g.get("name")),
        key=lambda g: str(g["name"]),
    )
    if not named:
        return None

    lower = [c.lower() for c in parsed["columns"]]

    def source(name: str) -> int:
        return lower.index(name) if name in lower else -1

    onset_col = source("onset")
    duration_col = source("duration")
    trial_col = source("trial_type")
    value_col = source("value")
    hed_col = source("hed")
    passthrough = _passthrough_column_names(parsed["columns"])

    ents = _bids_entities(filename_stem(primary_path))
    subject = ents.get("sub")
    session = ents.get("ses")
    task = ents.get("task")
    run = ents.get("run")

    cols: dict[str, list] = {name: [] for name in EVENTS_FIXED_COLUMNS}
    for name in passthrough.values():
        cols[name] = []

    rows = parsed["rows"]
    onsets = [_event_number(f, onset_col) for f in rows]
    durations = [_event_number(f, duration_col) for f in rows]
    # Onset order, with unparseable onsets last and file order preserved within
    # a tie -- so the published order is deterministic for a given file.
    order = sorted(
        range(len(rows)),
        key=lambda i: (onsets[i] is None, onsets[i] if onsets[i] is not None else 0.0, i),
    )
    for i in order:
        fields = rows[i]
        for group in named:
            cols["store_path"].append(zarr_rel)
            cols["subject"].append(subject)
            cols["session"].append(session)
            cols["task"].append(task)
            cols["run"].append(run)
            cols["onset_s"].append(onsets[i])
            cols["duration_s"].append(durations[i])
            cols["sample_index"].append(sample_index_for(onsets[i], group.get("rate")))
            cols["group_name"].append(str(group["name"]))
            cols["trial_type"].append(_event_cell(fields, trial_col))
            cols["value"].append(_event_cell(fields, value_col))
            cols["hed"].append(_event_cell(fields, hed_col))
            for col, name in passthrough.items():
                cols[name].append(_event_cell(fields, col))
    return cols


def events_row_alert(
    primary_path: str,
    parsed: ParsedEvents | None,
    rows: dict[str, list] | None,
) -> str | None:
    """The `::warning::` a store's events deserve, or None when they are fine.

    Two conditions, both invisible from the outside otherwise -- the parquet
    either does not mention the store at all, or mentions it with a column of
    nulls, and neither is distinguishable from "this recording has no events":

    * The recording HAS events and the store has no named channel group, so
      there is nothing to attach a rate (and therefore a sample index) to and
      the store contributes no rows at all.
    * Every published row has a null `sample_index`: either no onset cell parsed
      as a number, or the group carries no rate. A client gets events it cannot
      epoch.

    Pure, and separate from the caller, because the first condition cannot be
    reached through a real conversion (`convert_one` refuses to publish a store
    with no channel groups) -- so a test can only reach that branch here.
    """
    if rows is None:
        if parsed and parsed["rows"]:
            return (
                f"::warning::{primary_path} has {len(parsed['rows'])} event(s) but "
                "the store has no channel groups, so it contributes no rows to "
                "events.parquet"
            )
        return None
    if rows["sample_index"] and all(v is None for v in rows["sample_index"]):
        return (
            f"::warning::no usable sample index for any event in {primary_path}: "
            f"{len(rows['sample_index'])} row(s) published with sample_index null "
            "(unparseable onsets, or a group with no rate)"
        )
    return None


def expected_channel_count_for(
    repo_dir: str, primary_path: str, head_files: set[str], head: str
) -> int | None:
    """Channel count the recording's BIDS `_channels.tsv` declares, or None when
    no applicable channels.tsv exists (nothing to check against).

    Resolution mirrors ``power_line_frequency_for``: among `_channels.tsv` files
    in the recording's directory or an ancestor whose entities are a subset of
    the recording's, the most specific wins. channels.tsv is git-tracked text
    (never annexed), so this is a head-file-list scan plus one small read.

    This is the ground truth for the post-conversion fidelity gate: a store
    whose total channel count falls short of this number is withheld
    (``ChannelCountMismatch``) instead of served.

    Unlike PLF's per-field JSON inheritance, only the single most specific
    candidate is read (BIDS TSV inheritance is closest-file-wins, not a
    merge). If that read fails or the file has no data rows, this returns
    None and the gate is silently OFF for the recording -- fail-open by
    design: no ground truth, nothing to check against.
    """
    best = channels_tsv_for(primary_path, head_files)
    if best is None:
        return None
    text = _read_repo_text(repo_dir, head, best)
    if text is None:
        # NOT the same as "no channels.tsv exists". Ground truth is present at
        # HEAD and we failed to consult it, which turns off the very gate that
        # exists to catch a repeat of biosigio#110 silently truncating a
        # 74-channel recording to one (nemarDatasets/on002718#1) -- on precisely
        # the recording most likely to be mid-incident. Fail open, but say so.
        print(
            f"::warning::could not read {best}; the channel-count fidelity gate "
            "is OFF for this recording",
            flush=True,
        )
        return None
    rows = [line for line in text.splitlines()[1:] if line.strip()]
    return len(rows) or None


def affected_primaries(
    changed_path: str,
    primaries_by_dir: dict[str, list[str]],
    member_to_head: dict[str, str] | None = None,
) -> set[str]:
    """Buildable head primaries a changed path rebuilds, restricted to those at HEAD.

    A head primary maps to itself; a non-head split FIF maps to its group head (via
    `member_to_head`), so editing any split rebuilds the one store; a companion
    (`.fdt`/`.eeg`/`.vmrk`) maps to the same-stem primary in its directory; a
    `*_events.tsv` maps to every primary in its directory sharing the events
    entities-base (the `split-NN` entity is ignored on both sides, since a split
    recording's events file carries no split).

    `primaries_by_dir` holds every buildable primary in a directory: the file
    heads AND the directory recordings (CTF `.ds`, MEF3 `.mefd`, 4D/BTi), which
    sit in the same parent directory as their sidecars. A non-head split is still
    absent from `here`, since only chain heads are buildable. Directory recordings
    reach only the companion and events branches: they are never `is_primary`
    (their extensions are not in `PRIMARY_EXTS`, and a BTi directory is not a
    tracked path at all), and never split FIFs.
    """
    d = os.path.dirname(changed_path)
    here = primaries_by_dir.get(d, [])
    if is_primary(changed_path):
        if changed_path in here:
            return {changed_path}
        # A non-head split (not itself buildable) rebuilds its group head.
        head = (member_to_head or {}).get(changed_path)
        return {head} if head in here else set()
    ext = lower_ext(changed_path)
    if ext in COMPANION_EXTS:
        stem = filename_stem(changed_path)
        return {p for p in here if filename_stem(p) == stem}
    if is_events_tsv(changed_path):
        ev_stem = filename_stem(changed_path)  # `sub-01_task-x_events`
        ev_base = ev_stem[: -len("_events")] if ev_stem.endswith("_events") else entities_base(ev_stem)
        ev_base = _strip_split(ev_base)
        return {p for p in here if _strip_split(entities_base(filename_stem(p))) == ev_base}
    return set()


def _buildable_primaries(
    head_files,
) -> tuple[list[str], dict[str, str], set[str], set[str], set[str]]:
    """Every recording discovery can build at HEAD, plus the bookkeeping the
    incremental path needs.

    Returns `(all_primaries, member_to_head, heads, dirrec_dirs, bti_dirs)`.
    Factored out of `compute_worklist` so `discover_primaries` and the worklist
    answer "what recordings exist" through the SAME code: the index's coverage
    denominator has to be the set the converter would actually attempt, not a
    second, subtly different walk of the tree.
    """
    primaries = [p for p in head_files if is_primary(p)]
    # Directory-keyed recordings are derived from the files under them, not
    # tracked paths of their own, so they are buildable primaries alongside the
    # file primaries. CTF `.ds`/MEF3 `.mefd` are extension-derived; 4D/BTi is
    # content-derived (see the two sections near the top of this file).
    dirrec_dirs = dir_recordings(head_files)
    bti_dirs = bti_recordings(head_files)
    # Collapse FIF split groups to their chain head: only the head builds a store,
    # and a change to any split routes to that head (member_to_head).
    heads, member_to_head = split_heads_and_members(primaries)
    return sorted([*heads, *dirrec_dirs, *bti_dirs]), member_to_head, heads, dirrec_dirs, bti_dirs


def discover_primaries(head_files) -> list[str]:
    """Every raw recording at HEAD, after the ADR 0027 exclusions.

    This is the index's `discovered_count` -- the denominator of coverage and the
    left-hand side of the invariant `discovered_count == store_count +
    failure_count + pending_count`. Publishing it is what lets a consumer check
    completeness without cloning the repository: on008083 served 2 stores and 36
    failures out of 43 raw recordings, and the missing five were visible nowhere
    (#1197).
    """
    return _buildable_primaries(head_files)[0]


def compute_worklist(
    head_files: list[str],
    diff_entries: list[tuple[str, str]],
    full: bool,
) -> tuple[list[str], list[str]]:
    """Return (convert, remove): primary source paths to (re)build, and store
    rel-paths (`*.zarr`) to delete.

    `diff_entries` is a list of (status, path) from `git diff --no-renames
    --name-status` (so a rename is a D + an A). `full` ignores the diff and
    converts every primary at HEAD.
    """
    head_set = set(head_files)
    all_primaries, member_to_head, heads, dirrec_dirs, bti_dirs = _buildable_primaries(
        head_files
    )
    # Keyed on ALL buildable primaries, not just the file heads. A directory
    # recording sits in the same parent directory as its sidecars -- CTF
    # `sub-01/meg/..._meg.ds` next to `sub-01/meg/..._events.tsv` -- so omitting
    # the directory forms here left `affected_primaries` with an empty bucket and
    # an events edit rebuilt NOTHING for CTF/MEF3/BTi (#1106). Events only: the
    # companion extensions are EEGLAB/BrainVision-specific, so reaching a
    # directory recording through that branch would need a same-stem `.fdt`/
    # `.eeg`/`.vmrk` beside it, which is not a valid BIDS layout.
    # Changes INSIDE a recording directory never reach this map; they are resolved
    # earlier by `dir_recording_of`/`bti_dirs`. This map is only consulted for
    # siblings alongside the recording, which is exactly the sidecar case.
    by_dir: dict[str, list[str]] = {}
    for p in all_primaries:
        by_dir.setdefault(os.path.dirname(p), []).append(p)

    if full:
        return all_primaries, []

    convert: set[str] = set()
    remove: set[str] = set()
    # Deleted splits are resolved per split GROUP after the loop: a split file gone
    # from HEAD is no longer in `member_to_head` (which is built from HEAD), so it
    # can't route through it. Group by split_group_key and decide once per group.
    deleted_split_groups: dict[str, list[str]] = {}
    for status, path in diff_entries:
        # A changed/removed path under an excluded tree (derivatives/
        # sourcedata/code) or a BIDS calibration filename never builds or
        # removes a store: it was never a candidate recording, and a
        # deletion there must not be misread as "the recording is gone from
        # HEAD" -- that would delete an already-published store this change
        # is required to leave untouched (see `compute_clean_orphans`).
        if is_excluded_from_discovery(path):
            continue
        # A change anywhere inside a CTF `.ds`/MEF3 `.mefd` is a change to that
        # one recording (extension-derived; see `dir_recording_of`).
        ds = dir_recording_of(path)
        if ds is not None:
            if ds in dirrec_dirs:  # at least one file remains -> rebuild the recording
                convert.add(ds)
            elif status == "D":  # the whole directory is gone -> drop its store
                remove.add(store_rel_for(ds))
            continue
        # A change anywhere inside a 4D/BTi directory is a change to that one
        # recording too, but BTi has no extension to derive it from -- membership
        # is content-based (`bti_dirs`, computed from the current HEAD state), so
        # a still-valid BTi dir means "rebuild." A deletion that drops the
        # directory below the c,rf*/config threshold (the last processed-data or
        # config file going away) is the removal signal instead; `hs_file` (not a
        # marker name) deliberately does NOT trigger removal on its own.
        btidir = os.path.dirname(path)
        if btidir in bti_dirs:
            convert.add(btidir)
            continue
        if status == "D" and is_bti_marker_name(os.path.basename(path)):
            remove.add(store_rel_for(btidir))
            continue
        if status == "D":
            if is_split_fif(path):
                deleted_split_groups.setdefault(split_group_key(path), []).append(path)
            elif is_primary(path):
                # A buildable recording is gone -> drop its store. (If a same-name
                # primary still exists at HEAD it lands in convert below.)
                if path not in head_set:
                    remove.add(store_rel_for(path))
            else:
                # A companion/events removal still rebuilds any sibling recording
                # that remains (e.g. events.tsv deleted -> regenerate without events).
                convert |= affected_primaries(path, by_dir, member_to_head)
        else:  # "A", "M", "T", ...
            convert |= affected_primaries(path, by_dir, member_to_head)

    # Per deleted split group: if any split still exists at HEAD, re-read the chain
    # (rebuild its head); otherwise the whole recording is gone -> drop the store,
    # which was keyed at the group's head (lowest split index seen for the group).
    for gkey, deleted in deleted_split_groups.items():
        head_here = next(
            (h for h in heads if is_split_fif(h) and split_group_key(h) == gkey), None
        )
        # All entries are split FIFs, so split_index is never None here (-1 is an
        # unreachable fallback that only quiets the type checker).
        old_lowest = min(deleted, key=lambda x: (split_index(x) or 0, x))
        if head_here is not None:
            convert.add(head_here)
            # If the deletion reaches below the surviving head, the group's head
            # index shifted up (old head removed): drop its now-orphaned store. The
            # `remove -= convert_stores` guard below protects a rebuilt store.
            if (split_index(old_lowest) or -1) < (split_index(head_here) or -1):
                remove.add(store_rel_for(old_lowest))
        else:
            remove.add(store_rel_for(old_lowest))

    # A directory recording is "present" when it still has qualifying files at HEAD.
    present = head_set | dirrec_dirs | bti_dirs
    convert &= present  # never convert something not present at HEAD
    convert_stores = {store_rel_for(p) for p in convert}
    remove -= convert_stores  # a rebuilt store must not also be deleted
    return sorted(convert), sorted(remove)


def compute_clean_orphans(prior_index: dict | None, convert: list[str]) -> set[str]:
    """Stores a `--clean` run should remove: prior index stores this run does
    not (re)produce, MINUS any store under an excluded tree
    (derivatives/sourcedata/code).

    A store's rel-path missing from `convert` normally means its recording is
    gone from HEAD. But since this converter went raw-only, a derivatives/
    sourcedata/code primary is ALSO absent from `convert` -- deliberately,
    because we stopped attempting it, not because the file disappeared. A
    store rel-path mirrors its primary's directory structure (`store_rel_for`
    only swaps the extension), so `is_excluded_from_discovery` applies to it
    directly. Without this guard, going raw-only would let `--clean`'s own
    orphan-removal delete the ~4,721 already-published non-raw stores on the
    very next run -- exactly the cleanup this change must NOT perform; that
    is separate, explicitly-authorized follow-up work
    (nemarOrg/nemar-cli#1095 / nemarOrg/nemar-cli#1097).
    """
    prior_rels = {
        e["zarr"]
        for e in (prior_index or {}).get("stores", [])
        if isinstance(e, dict) and isinstance(e.get("zarr"), str)
    }
    convert_rels = {store_rel_for(p) for p in convert}
    return {
        rel for rel in prior_rels - convert_rels if not is_excluded_from_discovery(rel)
    }


def is_commit_sha(value: object) -> bool:
    """True for a full 40-hex git commit SHA."""
    return isinstance(value, str) and bool(COMMIT_SHA_RE.match(value))


def installed_biosigio_version() -> str | None:
    """The installed biosigIO release, or None when it cannot be determined.

    Published as the index's `biosigio_version` so a store's geometry and unit
    handling can be attributed to a specific library release -- the engine stamp
    says which DISCOVERY generation ran, not which exporter wrote the bytes, and
    the two move independently. Null rather than a guess: an unattributable store
    must not claim a version.
    """
    try:
        from importlib.metadata import version

        return version("biosigio")
    except Exception as exc:  # noqa: BLE001 - absent/odd metadata is not fatal
        print(
            f"::warning::could not determine the installed biosigio version ({exc}); "
            "publishing biosigio_version: null",
            flush=True,
        )
        return None


class StoreEntry(TypedDict, total=False):
    """One published `stores[]` entry. `total=False` throughout, because the
    schema's `required` set is the contract and most keys are conditional --
    `sss` only on an ADR 0028 store, `n_events`/`trial_types` only when an
    events.tsv applies, `units_report` only when a channels.tsv did.

    Declared for the reader, not the type checker: these dicts are assembled
    from several sources (`store_metadata`'s spread, `events_summary`'s update,
    the SSS path) and a mistyped key would otherwise only be caught by the
    pre-upload schema self-check, at the end of a conversion.
    """

    path: str
    zarr: str
    updated_utc: str
    source_tree: str
    derived: bool
    modalities: list[str]
    groups: list[dict]
    power_line_frequency: float | None
    event_description_count: int
    n_events: int
    trial_types: dict[str, int]
    units_report: dict
    channels_tsv_read_error: bool
    split_members: list[str]
    sss: dict


class FailureEntry(TypedDict):
    """One published `failures[]` entry: a recording that will not convert
    without a change to the data or the converter. `reason` is the sanitized
    sentence a viewer shows; `detail` is the operator-facing cause."""

    path: str
    zarr: str
    code: str
    reason: str
    detail: str | None
    attempts: int


# The three reasons a discovered recording can be `pending`, spelled exactly as
# `zarr-index.schema.json`'s `$defs.pending.reason` enum spells them. A CLOSED
# set, unlike `FailureEntry.code`: the schema rejects a fourth value, so a typo
# or a newly-invented reason has to fail here, at the call site, rather than at
# `validate_document` after a full conversion has already run.
PendingReason = Literal["infra_failure", "memory_budget", "not_attempted"]


class PendingEntry(TypedDict):
    """One published `pending[]` entry: a discovered recording with no store
    that is still expected to convert."""

    path: str
    zarr: str
    reason: PendingReason
    attempts: int
    last_error: str | None
    last_attempt_utc: str | None


def _normalize_store_entry(entry: dict) -> StoreEntry:
    """Bring a store entry up to the v3 shape without inventing facts.

    Applied to CARRIED-OVER entries as well as this run's, so one index never
    mixes shapes: an entry written by the v1 producer carries `source_key` (which
    v3 moved to the manifest, #1178 item 5) and carries neither `source_tree` nor
    `derived`. The defaults are the only honest ones available from the entry
    alone -- a store that exists was built from a discoverable raw recording, and
    `derived` is stated by the SSS path, which also writes `sss`, so its absence
    is evidence rather than a guess.

    Every entry this reaches is raw by construction: `merge_index` drops a
    carried-over store whose path is excluded from discovery (they are being
    purged, not served), so `source_tree` is the only value the schema allows.
    """
    out: StoreEntry = {k: v for k, v in entry.items() if k != "source_key"}  # type: ignore[assignment]
    out.setdefault("source_tree", source_tree_for(str(out.get("path", ""))))
    out.setdefault("derived", bool(out.get("sss")))
    return out


def _pending_reason(value: object) -> PendingReason:
    """Coerce a `reason` read off a PUBLISHED index into the closed set.

    Carried-forward pending entries come from a document written by an earlier
    run (or hand-edited), so the value is data, not a literal. An unrecognized
    one becomes `infra_failure` -- the reading that says "no store, cause not
    established, try again" -- rather than being republished as-is, which would
    fail `validate_document` at the very END of a run, after every recording had
    already been converted, and refuse to publish the whole index over it.
    """
    return value if value in ("infra_failure", "memory_budget", "not_attempted") else "infra_failure"  # type: ignore[return-value]


def _pending_entry(
    path: str,
    reason: PendingReason,
    attempts: int,
    last_error: str | None = None,
    last_attempt_utc: str | None = None,
) -> PendingEntry:
    return {
        "path": path,
        "zarr": store_rel_for(path),
        "reason": reason,
        "attempts": attempts,
        "last_error": last_error,
        "last_attempt_utc": last_attempt_utc,
    }


def _failure_entry(
    path: str,
    code: str,
    detail: str | None = None,
    attempts: int = 0,
) -> FailureEntry:
    """A `failures[]` entry, built in ONE place.

    Mirrors `_pending_entry` for the same reason: the `zarr` rel-path and the
    user-facing `reason` are DERIVED (`store_rel_for`, `reason_for_code`), and
    three call sites were each deriving them again -- `record` in main, the
    exhaustion promotion in `merge_index`, and the retry-exhausted path. A fourth
    would have been written the same way, and a hand-built entry that skipped
    `reason_for_code` would publish a code with no explanation for the viewer.
    """
    return {
        "path": path,
        "zarr": store_rel_for(path),
        "code": code,
        "reason": reason_for_code(code),
        "detail": detail,
        "attempts": attempts,
    }


def merge_index(
    prior: dict | None,
    dataset_id: str,
    head_commit: str,
    converted: list[dict],
    removed_store_rels: list[str],
    updated_utc: str,
    # `failures` is built exclusively by `_failure_entry`, so it carries the
    # TypedDict. `converted`, `pending` and `prior_pending` deliberately do NOT:
    # `converted` is a store entry assembled by the worker, and the other two are
    # this function's INPUT -- `pending` carries only what a run observed (path,
    # reason, last_error) and `prior_pending` comes verbatim out of a PUBLISHED
    # index that this function does not re-validate. Claiming PendingEntry for
    # either would assert a shape nothing checks.
    failures: list[FailureEntry] | None = None,
    pending: list[dict] | None = None,
    *,
    discovered: list[str] | None = None,
    errors: int | None = None,
    contract_base: str = DEFAULT_CONTRACT_BASE,
    bucket: str = "nemar",
    region: str = "us-east-2",
    engine_version: str = ZARR_ENGINE_VERSION,
    biosigio_version: str | None = None,
    prior_pending: list[dict] | None = None,
    dataset_row: dict | None = None,
) -> dict:
    """Fold this run's results into the prior index and return the v3 document. Pure.

    `converted` is a list of store entries (each carries a `zarr` rel-path key);
    `removed_store_rels` are `*.zarr` rels to drop. Entries for unchanged stores
    are carried over from `prior`, normalized to the v3 shape.

    `failures` is this run's typed data failures ({path, zarr, code, reason,
    detail}) -- recordings that will not convert without a change to the data or
    the converter. They are merged like stores: prior failures carry over, a path
    that converted (or whose store was removed) this run drops out, and this run's
    failures overlay.

    `pending` is this run's INFRA failures ({path, zarr, reason, last_error,
    last_attempt_utc}) -- recordings that have no store yet but are still expected
    to convert. Before v3 these were simply omitted, which is why on008083's five
    silently-lost recordings were indistinguishable from "still generating"
    forever (#1197). `attempts` is not supplied by the caller: it is a property of
    the recording's HISTORY, so it is carried from `prior_pending` and
    incremented here. At `PENDING_MAX_ATTEMPTS` the entry is promoted to a typed
    `retry_exhausted` failure carrying its last error as `detail`, which is what
    stops a permanently failing recording from consuming the queue forever.

    `discovered` (every raw recording at HEAD) makes the coverage invariant hold
    BY CONSTRUCTION rather than by hope: entries for paths that are not discovered
    are dropped, and discovered paths in none of the three lists become
    `not_attempted` pending entries. A partial run therefore still balances.

    A path is never in more than one of `stores`, `failures`, `pending`.

    Raises ValueError when `head_commit` is not a 40-hex SHA: an index that does
    not name the commit it was built from is unreproducible and cannot seed the
    next incremental diff, and one was published (on008083, #1197). Refusing here
    means the run fails loudly instead of overwriting a good index with a broken
    one.
    """
    if not is_commit_sha(head_commit):
        raise ValueError(
            f"refusing to build an index for {dataset_id} with source_commit "
            f"{head_commit!r}: a published index must name the 40-hex commit it "
            "was built from (#1197)"
        )
    failures = failures or []
    pending = pending or []
    new_fail_paths = {f["path"] for f in failures if f.get("path")}
    new_pending_paths = {p["path"] for p in pending if p.get("path")}

    stores: dict[str, dict] = {}
    if prior and isinstance(prior.get("stores"), list):
        for entry in prior["stores"]:
            if isinstance(entry, dict) and isinstance(entry.get("zarr"), str):
                stores[entry["zarr"]] = entry
    for rel in removed_store_rels:
        stores.pop(rel, None)
    for entry in converted:
        stores[entry["zarr"]] = entry
    # A recording that newly FAILED (or is newly pending) must not keep a stale
    # store entry claiming it is served.
    stores = {
        z: e
        for z, e in stores.items()
        if e.get("path") not in new_fail_paths and e.get("path") not in new_pending_paths
    }

    # Deliberately NOT dict[str, FailureEntry]: the values below are a mix of
    # `_failure_entry` results and entries read verbatim out of a PUBLISHED
    # index, which this function does not re-validate. Claiming the TypedDict
    # here would assert a shape for a document written by an earlier engine.
    fails: dict[str, dict] = {}
    if prior and isinstance(prior.get("failures"), list):
        for f in prior["failures"]:
            # A path now excluded from discovery (derivatives/sourcedata/code,
            # or a BIDS calibration filename) will never be reconverted, so a
            # stale failure entry for it would otherwise persist in
            # index.json indefinitely -- showing users a failure for a file
            # we deliberately no longer serve at all.
            if (
                isinstance(f, dict)
                and f.get("path")
                and not is_excluded_from_discovery(f["path"])
            ):
                fails[f["path"]] = f
    converted_paths = {e["path"] for e in converted if e.get("path")}
    removed_set = set(removed_store_rels)
    # Drop prior failures that converted this run, whose recording was removed, or
    # that are now pending a retry instead.
    fails = {
        p: f
        for p, f in fails.items()
        if p not in converted_paths
        and p not in new_pending_paths
        and f.get("zarr") not in removed_set
    }
    for f in failures:
        fails[f["path"]] = f

    # --- pending -------------------------------------------------------------
    prior_attempts: dict[str, int] = {}
    for e in prior_pending or []:
        if isinstance(e, dict) and isinstance(e.get("path"), str):
            n = e.get("attempts")
            prior_attempts[e["path"]] = int(n) if isinstance(n, int) and n > 0 else 0
    # Every value here comes from `_pending_entry`, so the container carries the
    # TypedDict rather than a bare dict: a hand-built entry missing `zarr` or
    # `attempts` is then a type error at the call site instead of a schema
    # violation at the end of the run.
    pends: dict[str, PendingEntry] = {}
    for e in prior_pending or []:
        # Carry forward a recording this run never touched (an incremental run
        # converts only what changed), minus anything now resolved or excluded.
        if not (isinstance(e, dict) and isinstance(e.get("path"), str)):
            continue
        p = e["path"]
        if p in converted_paths or p in fails or is_excluded_from_discovery(p):
            continue
        pends[p] = _pending_entry(
            p,
            _pending_reason(e.get("reason")),
            prior_attempts.get(p, 0),
            e.get("last_error"),
            e.get("last_attempt_utc"),
        )
    for e in pending:
        p = e["path"]
        pends[p] = _pending_entry(
            p,
            _pending_reason(e.get("reason")),
            prior_attempts.get(p, 0) + 1,
            e.get("last_error"),
            e.get("last_attempt_utc") or updated_utc,
        )

    if discovered is not None:
        wanted = set(discovered)
        # A carried-over store whose path is EXCLUDED from discovery goes, and
        # goes NOISILY. ADR 0027 made discovery raw-only and
        # `purge_non_raw_stores.py` is the authorised deletion of what it stopped
        # producing, so a non-raw store is not something the archive serves -- an
        # index that kept describing one would advertise bytes that are being
        # removed. But dropping a store silently is how a real orphan bug would
        # hide, so each one is named with the reason it was excluded.
        dropped_non_raw = sorted(
            (str(e.get("path") or ""), excluded_reason(str(e.get("path") or "")))
            for e in stores.values()
            if e.get("path") not in wanted
            and is_excluded_from_discovery(str(e.get("path") or ""))
        )
        for path, reason in dropped_non_raw:
            print(
                f"[zarr] dropping non-raw store from the index: {path} ({reason})",
                flush=True,
            )
        stores = {z: e for z, e in stores.items() if e.get("path") in wanted}
        # Failures and pending entries are filtered the same way, and the
        # carry-forward above already refuses a now-excluded path, so neither
        # list can carry a non-raw recording either.
        fails = {p: f for p, f in fails.items() if p in wanted}
        pends = {p: e for p, e in pends.items() if p in wanted}
        accounted = {e.get("path") for e in stores.values()} | set(fails) | set(pends)
        for p in wanted - accounted:
            # Discovered, attempted by nobody this run: a `--limit`ed or
            # short-circuited run, or a recording the worklist never reached.
            # Recorded with attempts 0 so it neither ages toward exhaustion nor
            # disappears from the accounting.
            pends[p] = _pending_entry(p, "not_attempted", 0)

    # Exhaustion: stop promising a recording that has had its rounds. Done AFTER
    # the discovered reconciliation so a promoted entry is one that is still at
    # HEAD, and `not_attempted` is exempt because it has not been tried at all.
    for p, e in list(pends.items()):
        if e["reason"] == "not_attempted" or e["attempts"] < PENDING_MAX_ATTEMPTS:
            continue
        del pends[p]
        fails[p] = _failure_entry(
            p, "retry_exhausted", e.get("last_error"), e["attempts"]
        )

    ordered = [_normalize_store_entry(stores[k]) for k in sorted(stores)]
    ordered_fails = [fails[k] for k in sorted(fails)]
    ordered_pending = [pends[k] for k in sorted(pends)]

    prefix = f"{dataset_id}/zarr/"
    return {
        "format": INDEX_FORMAT,
        "format_version": INDEX_FORMAT_VERSION,
        "dataset_id": dataset_id,
        # The stable base, and the two forms of "where the bytes are today".
        # Per-dataset rather than global so a single dataset can be mirrored or
        # migrated without rewriting anyone's client (#1059).
        "contract_base": f"{contract_base.rstrip('/')}/{prefix}",
        "data_base": f"https://{bucket}.s3.{region}.amazonaws.com/{prefix}",
        "data_base_kind": "s3-public",
        "s3_uri": f"s3://{bucket}/{prefix}",
        "s3_region": region,
        "s3_anonymous": True,
        "source_commit": head_commit,
        "engine_version": engine_version,
        "biosigio_version": biosigio_version,
        "updated_utc": updated_utc,
        # Dataset-level provenance, hoisted to the top level (#1064). Already
        # fetched once per run for the store attrs, so publishing it here is
        # free -- and it saves an MCP broker or a citation tool one request per
        # dataset, which is the difference between "read the index" and "read the
        # index and then the catalog" for every recipe. Nullable throughout: the
        # catalog genuinely may not have a DOI yet.
        "doi": (dataset_row or {}).get("concept_doi") or (dataset_row or {}).get("doi") or None,
        "license": (dataset_row or {}).get("license") or None,
        "citation": dataset_citation(dataset_row),
        "hed_version": (dataset_row or {}).get("hed_version") or None,
        # How to turn this index's numbers into reads, without probing.
        "layout": dict(INDEX_LAYOUT),
        "discovered_count": (
            len(set(discovered))
            if discovered is not None
            else len(ordered) + len(ordered_fails) + len(ordered_pending)
        ),
        "store_count": len(ordered),
        # #1059 asked for `n_recordings`; it is the store count under another
        # name. The discovered total is `discovered_count`, deliberately a
        # different word, because conflating the two is how coverage went
        # unnoticed in the first place.
        "n_recordings": len(ordered),
        "errors": len(failures) + len(pending) if errors is None else errors,
        "failure_count": len(ordered_fails),
        "pending_count": len(ordered_pending),
        "stores": ordered,
        "failures": ordered_fails,
        "pending": ordered_pending,
    }


def check_index_invariant(index: dict) -> None:
    """Raise unless every discovered recording is accounted for exactly once.

    `discovered_count == store_count + failure_count + pending_count` is the whole
    of #1197's acceptance criterion, and `merge_index` makes it true by
    construction -- which is exactly why it is worth asserting separately. The
    construction is the thing that could regress, and a silently unbalanced index
    is the failure mode being fixed: it looks complete and is not.

    There is no exemption for the pre-ADR-0027 non-raw stores. They are being
    deleted, not served (`purge_non_raw_stores.py`), so a carried-over entry for
    one is dropped by `merge_index` and reported as `non_raw_dropped` on the
    callback -- it never reaches `store_count`, and the equation stays a plain
    sum.
    """
    discovered = index.get("discovered_count")
    parts = (
        index.get("store_count"),
        index.get("failure_count"),
        index.get("pending_count"),
    )
    if not isinstance(discovered, int) or any(not isinstance(n, int) for n in parts):
        raise ValueError(
            "index coverage counts are missing or non-integer: "
            f"discovered={discovered!r} store/failure/pending={parts!r}"
        )
    if discovered != sum(parts):  # type: ignore[arg-type]
        raise ValueError(
            f"index coverage does not balance for {index.get('dataset_id')}: "
            f"discovered_count={discovered} but store_count+failure_count+"
            f"pending_count={sum(parts)} "  # type: ignore[arg-type]
            f"({parts[0]}+{parts[1]}+{parts[2]})"
        )


def merge_manifest(
    prior: dict | None,
    dataset_id: str,
    entries: list[dict],
    store_rels: list[str],
    updated_utc: str,
    events_file: ManifestFileEntry | None = None,
) -> dict:
    """Build the producer manifest (`<id>/zarr/manifest.json`). Pure.

    Carries the git-annex `source_key` (and its declared size) per store. This
    used to ride in index.json, where it was 2.3 MB of nm000281's 12.8 MB and read
    by nothing: index.json is fetched on every dataset-page visit, the manifest by
    no one but us (#1178 item 5).

    Restricted to `store_rels` -- the rels the index actually publishes -- so the
    two documents can never disagree about which stores exist.

    `events_file` is `{name, size_bytes, row_count}` for the events.parquet THIS
    run uploaded, or None when it published none. Recorded rather than inferred:
    the index says the file exists and how many rows it has, and this says how
    many bytes the producer actually wrote -- which is what makes "the object on
    S3 is the one this run wrote" checkable with a HEAD instead of a download.
    Not carried over from `prior`: a run that published no file must not claim
    the previous run's bytes.
    """
    by_rel: dict[str, dict] = {}
    if prior and isinstance(prior.get("stores"), list):
        for e in prior["stores"]:
            if isinstance(e, dict) and isinstance(e.get("zarr"), str):
                by_rel[e["zarr"]] = e
    for e in entries:
        by_rel[e["zarr"]] = e
    keep = set(store_rels)
    return {
        "format": MANIFEST_FORMAT,
        "format_version": MANIFEST_FORMAT_VERSION,
        "dataset_id": dataset_id,
        "updated_utc": updated_utc,
        **({"files": [events_file]} if events_file else {}),
        "stores": [
            {
                "zarr": rel,
                "source_key": by_rel[rel].get("source_key"),
                "size_bytes": by_rel[rel].get("size_bytes"),
            }
            for rel in sorted(keep & set(by_rel))
        ],
    }


def validate_document(doc: dict, schema_path: str, label: str) -> None:
    """Validate a document against its JSON Schema before it is uploaded.

    A producer bug caught here costs one failed run; the same bug caught by a
    consumer costs every consumer. Degrades to a loud warning rather than a
    failure when `jsonschema` or the schema file is unavailable, so a node whose
    venv predates the pin still converts -- the check is a guard rail, not a
    dependency of serving.
    """
    try:
        import jsonschema  # type: ignore[import-not-found]
    except ImportError:
        print(
            f"::warning::jsonschema is not installed; the {label} was NOT validated "
            "against its schema before upload (add it: scripts/zarr/requirements.txt)",
            flush=True,
        )
        return
    try:
        with open(schema_path, encoding="utf-8") as fh:
            schema = json.load(fh)
    except OSError as exc:
        print(
            f"::warning::could not read {schema_path} ({exc}); the {label} was NOT "
            "validated against its schema before upload",
            flush=True,
        )
        return
    jsonschema.validate(doc, schema)


# --- events.parquet -----------------------------------------------------------
# One columnar file per dataset, at `<id>/zarr/events.parquet`, so a client can
# plan epochs and shards with zero signal bytes read and the MCP (ADR 0025) has a
# `get_events` source. The converter is the only party that knows the exact
# resampling relation, so `sample_index` is computed HERE rather than re-derived
# (differently, and wrong on non-integer rate ratios) by every client.
#
# Memory is the constraint that shapes the code below: nm000281 has ~25k stores,
# and a dataset's rows do not fit in one table. So rows are staged per store on
# disk as they arrive, and the file is written store by store into a
# ParquetWriter -- never one giant frame.

# Rows buffered before a row group is flushed. Big enough that a 25k-store
# dataset does not end up with 25k row groups (each carries per-column
# statistics in the footer), small enough that the buffer stays bounded.
EVENTS_ROW_GROUP_ROWS = int(os.environ.get("ZARR_EVENTS_ROW_GROUP_ROWS", "65536"))
EVENTS_PARQUET_NAME = "events.parquet"
# IANA-registered media type for Apache Parquet.
EVENTS_CONTENT_TYPE = "application/vnd.apache.parquet"


class EventsStaging:
    """This run's event rows, held on disk keyed by store, not in memory.

    A pool worker returns one store's rows as they are converted and `main` hands
    them straight to `add`, which serializes them and forgets them; `get` reads
    one store back at write time. What stays resident is the offset table (one
    entry per store) and the set of pass-through column names -- both proportional
    to the STORE count, not the event count.

    The backing file is an anonymous `tempfile.TemporaryFile`: it has no name in
    the filesystem, so it cannot be left behind by a crash the way a
    `delete=False` temp file was (#1068).
    """

    def __init__(self) -> None:
        # Deliberately long-lived and deliberately anonymous: it is written
        # to across a whole run and read at the end, and an unnamed temp file
        # cannot be left behind on the node's scratch (#1068).
        self._fh = tempfile.TemporaryFile()  # noqa: SIM115 - closed by GC/process exit
        self._index: dict[str, tuple[int, int]] = {}
        self._extras: set[str] = set()
        self.row_count = 0

    def add(self, zarr_rel: str, columns: dict[str, list]) -> None:
        blob = pickle.dumps(columns, protocol=pickle.HIGHEST_PROTOCOL)
        self._fh.seek(0, os.SEEK_END)
        offset = self._fh.tell()
        self._fh.write(blob)
        self._index[zarr_rel] = (offset, len(blob))
        self._extras.update(k for k in columns if k not in EVENTS_FIXED_COLUMNS)
        self.row_count += len(columns.get("store_path", ()))

    def __contains__(self, zarr_rel: object) -> bool:
        return zarr_rel in self._index

    def __len__(self) -> int:
        return len(self._index)

    @property
    def extras(self) -> set[str]:
        return set(self._extras)

    def get(self, zarr_rel: str) -> dict[str, list] | None:
        entry = self._index.get(zarr_rel)
        if entry is None:
            return None
        offset, size = entry
        self._fh.seek(offset)
        return pickle.loads(self._fh.read(size))


class ArrowTable(Protocol):
    """The `pyarrow.Table` surface this module actually touches.

    A structural Protocol rather than an import, because pyarrow is an OPTIONAL
    dependency loaded lazily inside the functions that need it: a node without
    it still converts, it just publishes no events file. There is therefore no
    module-scope name to annotate with, and a `TYPE_CHECKING` import would still
    make a checker's answer depend on whether the package happens to be
    installed. Stating the three members used here says the same thing, costs
    nothing at runtime, and turns `table["store_path"]` and `table.filter(mask)`
    back into checked accesses instead of attribute lookups on `object`.
    """

    @property
    def num_rows(self) -> int: ...

    def __getitem__(self, key: str) -> Any: ...

    def filter(self, mask: Any) -> ArrowTable: ...


class PriorEventRows:
    """Random access by store into the events.parquet a previous run published.

    An incremental run converts only what changed, so the stores it did NOT touch
    keep the rows they already had -- exactly how the index carries a store entry
    forward. Row groups are indexed by the stores they contain (reading one
    column, not the file), so carrying a store forward reads its rows and nothing
    else; the last row group read is cached because the caller walks stores in
    sorted order and the file is written in that same order.
    """

    def __init__(self, path: str) -> None:
        import pyarrow as pa  # type: ignore[import-not-found]  # lazy: optional dep
        import pyarrow.parquet as pq  # type: ignore[import-not-found]

        self._pa = pa
        self._file = pq.ParquetFile(path)
        self.extras = {
            name
            for name in self._file.schema_arrow.names
            if name not in EVENTS_FIXED_COLUMNS
        }
        self._by_rel: dict[str, list[int]] = {}
        for i in range(self._file.num_row_groups):
            column = self._file.read_row_group(i, columns=["store_path"])["store_path"]
            for rel in column.unique().to_pylist():
                if rel is not None:
                    self._by_rel.setdefault(rel, []).append(i)
        self._cached: tuple[int, ArrowTable] | None = None

    def __contains__(self, zarr_rel: object) -> bool:
        return zarr_rel in self._by_rel

    def _row_group(self, i: int) -> ArrowTable:
        """The i-th row group (cached: consecutive stores usually share one).

        Typed as `ArrowTable`, the structural Protocol declared above, rather
        than `object`: pyarrow is an optional dependency imported lazily inside
        the methods that need it, so there is no importable name to annotate
        with, and `object` made every `table[column]` and `table.filter(...)`
        below an unchecked attribute access on a value the checker believed had
        neither.
        """
        if self._cached is None or self._cached[0] != i:
            self._cached = (i, self._file.read_row_group(i))
        return self._cached[1]

    def table_for(self, zarr_rel: str, schema):
        """The prior rows for one store, conformed to `schema`, or None."""
        import pyarrow.compute as pc  # type: ignore[import-not-found]

        groups = self._by_rel.get(zarr_rel)
        if not groups:
            return None
        parts: list[ArrowTable] = []
        for i in groups:
            table = self._row_group(i)
            mask = pc.equal(table["store_path"].cast(self._pa.string()), zarr_rel)
            part = table.filter(mask)
            if part.num_rows:
                parts.append(part)
        if not parts:
            return None
        table = parts[0] if len(parts) == 1 else self._pa.concat_tables(parts)
        return conform_events_table(self._pa, table, schema)


def events_schema(pa, extras):
    """The parquet schema: the fixed columns (#1060) then the pass-through ones.

    Extras are sorted rather than kept in first-seen order on purpose: workers
    finish in arbitrary order, and a column order that depended on which
    recording converted first would make two runs over the same commit produce
    different files.
    """
    label = pa.dictionary(pa.int32(), pa.string())
    fields = [
        ("store_path", label),
        ("subject", label),
        ("session", label),
        ("task", label),
        ("run", label),
        ("onset_s", pa.float64()),
        ("duration_s", pa.float32()),
        ("sample_index", pa.int64()),
        ("group_name", label),
        ("trial_type", label),
        ("value", label),
        ("hed", label),
    ]
    fields += [(name, label) for name in sorted(extras)]
    return pa.schema(fields)


def events_table_from_columns(pa, schema, columns: dict[str, list]):
    """One store's staged columns as a table in the dataset-wide schema. A column
    this store's events.tsv did not have is all-null, not absent: the file has one
    schema, and a client must not have to ask which stores contributed which
    columns."""
    n = len(columns.get("store_path", ()))
    arrays = [
        pa.array(columns.get(field.name, [None] * n), type=field.type)
        for field in schema
    ]
    return pa.Table.from_arrays(arrays, schema=schema)


def conform_events_table(pa, table, schema):
    """Bring a table read back from a prior file into `schema` -- filling a column
    that file did not have with nulls, since a later run may have added one."""
    n = table.num_rows
    arrays = []
    for field in schema:
        if field.name in table.column_names:
            column = table[field.name]
            arrays.append(column if column.type == field.type else column.cast(field.type))
        else:
            arrays.append(pa.chunked_array([pa.nulls(n, field.type)]))
    return pa.Table.from_arrays(arrays, schema=schema)


def write_events_parquet(
    out_path: str,
    ordered_rels: list[str],
    staged: EventsStaging,
    prior: PriorEventRows | None = None,
    reconverted: set[str] | None = None,
) -> int:
    """Write `<id>/zarr/events.parquet` and return the row count.

    Stores are visited in the order given (the index's, i.e. sorted by `zarr`),
    and each store's rows are already ordered by onset, so the file is sorted by
    `store_path, onset_s` by construction -- no global sort, and therefore no
    point at which the whole dataset is in memory. Rows accumulate only until
    `EVENTS_ROW_GROUP_ROWS`, then become a row group.

    A store with rows from THIS run uses them. A store this run did NOT reconvert
    keeps the rows the prior file has for it. `reconverted` is what separates the
    two, and it is not `staged`: a store that WAS reconverted and produced no
    rows (its events.tsv was deleted, or emptied) must publish no rows, not
    silently inherit the ones the prior file still has for it. Passing None means
    "nothing was reconverted", the read-only shape the pure writer tests use.
    """
    import pyarrow as pa  # type: ignore[import-not-found]  # lazy: optional dep
    import pyarrow.parquet as pq  # type: ignore[import-not-found]

    schema = events_schema(pa, staged.extras | (prior.extras if prior else set()))
    total = 0
    buffered: list = []
    buffered_rows = 0
    writer = pq.ParquetWriter(out_path, schema, compression="zstd")
    try:
        for rel in ordered_rels:
            columns = staged.get(rel)
            if columns is not None:
                table = events_table_from_columns(pa, schema, columns)
            elif prior is not None and not (reconverted and rel in reconverted):
                table = prior.table_for(rel, schema)
            else:
                table = None
            if table is None or not table.num_rows:
                continue
            buffered.append(table)
            buffered_rows += table.num_rows
            total += table.num_rows
            if buffered_rows >= EVENTS_ROW_GROUP_ROWS:
                writer.write_table(pa.concat_tables(buffered))
                buffered, buffered_rows = [], 0
        if buffered:
            writer.write_table(pa.concat_tables(buffered))
    finally:
        writer.close()
    return total


def parse_annex_key(blob_text: str) -> str | None:
    """Annex key from a locked-mode symlink target or an unlocked pointer blob."""
    t = blob_text.strip()
    m = ANNEX_TARGET_RE.search(t)
    if m:
        return m.group(1)
    m = ANNEX_POINTER_CONTENT_RE.match(t)
    return m.group(1) if m else None


# --- I/O (git, S3, conversion) ------------------------------------------


def _run(cmd: list[str], cwd: str | None = None) -> str:
    return subprocess.check_output(cmd, cwd=cwd, text=True)


def git_ls_files(repo_dir: str, ref: str) -> list[str]:
    out = _run(["git", "-C", repo_dir, "ls-tree", "-r", "--name-only", ref])
    return [line for line in out.splitlines() if line]


def git_diff_name_status(repo_dir: str, base: str, head: str) -> list[tuple[str, str]]:
    out = _run(
        ["git", "-C", repo_dir, "diff", "--no-renames", "--name-status", f"{base}..{head}"]
    )
    entries: list[tuple[str, str]] = []
    for line in out.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) >= 2:
            entries.append((parts[0].strip()[:1], parts[-1].strip()))
    return entries


def is_ancestor(repo_dir: str, maybe_ancestor: str, head: str) -> bool:
    """True iff `maybe_ancestor` is an ancestor of `head`.

    `merge-base --is-ancestor` exits 0 (yes), 1 (no), or other (git error, e.g.
    an unknown commit after a history rewrite). A git error is treated as "not
    an ancestor" (so the run falls back to a full rebuild, which is correct for
    a rewritten prior commit) but is logged so it isn't mistaken for a clean no.
    """
    res = subprocess.run(
        ["git", "-C", repo_dir, "merge-base", "--is-ancestor", maybe_ancestor, head],
        capture_output=True,
        text=True,
    )
    if res.returncode not in (0, 1):
        print(
            f"::warning::merge-base --is-ancestor {maybe_ancestor[:8]}..{head[:8]} "
            f"exited {res.returncode}: {res.stderr.strip()}; treating as non-ancestor",
            flush=True,
        )
    return res.returncode == 0


def safe_store_prefix(bucket: str, dataset_id: str, rel_store: str) -> str:
    """Build the S3 prefix for a store, validating `rel_store` first.

    This prefix feeds `aws s3 sync --delete` and `aws s3 rm --recursive`, so an
    empty or path-traversal value could wipe an unintended prefix (e.g. the
    whole `<id>/zarr/`). Reject anything that isn't a clean `*.zarr` rel-path.
    """
    if not rel_store or not rel_store.endswith(".zarr"):
        raise ValueError(f"unsafe store rel-path {rel_store!r}: empty or not a .zarr")
    parts = rel_store.split("/")
    if rel_store.startswith("/") or "" in parts or ".." in parts:
        raise ValueError(f"unsafe store rel-path {rel_store!r}: traversal or empty segment")
    return f"s3://{bucket}/{dataset_id}/zarr/{rel_store}/"


def validate_store(store_local: str) -> None:
    """Raise if biosigIO produced an empty/partial store.

    Guards the `aws s3 sync --delete` below: syncing an empty local directory to
    a populated destination would DELETE a previously-valid store. A biosigIO
    Zarr v3 store always has a root `zarr.json`.
    """
    if not os.path.isdir(store_local) or not os.path.exists(os.path.join(store_local, "zarr.json")):
        raise RuntimeError(f"biosigIO wrote no zarr.json at {store_local}; store is empty/partial")


_AWS_RETRIES = int(os.environ.get("ZARR_AWS_RETRIES", "4"))
# Per-read socket timeout: the PRIMARY defense against a wedged S3 connection.
# Symptom (observed repeatedly from Hallu): aws opens several sockets to S3, the
# TCP handshakes complete, then a signed request stalls -- Send-Q backs up, no
# response bytes ever arrive, and the op sits burning a trickle of CPU on retries
# that reuse the dead socket. A SHORT read timeout is the cure: botocore abandons
# the wedged socket and reconnects (AWS_MAX_ATTEMPTS, below), and a fresh
# connection to a healthy S3 IP answers in ~200 ms, so the op recovers in seconds.
# The old 300 s made every wedge cost 5 minutes, so a recursive rm of an
# already-empty prefix could spin for hours before landing a good socket. 30 s
# reaps the wedge fast while far exceeding any healthy read gap -- a live transfer
# streams body bytes continuously, so 30 s of total silence is always a stall,
# never a legitimately slow-but-progressing read. Override with
# ZARR_AWS_READ_TIMEOUT.
_AWS_READ_TIMEOUT = os.environ.get("ZARR_AWS_READ_TIMEOUT", "30")
_AWS_TIMEOUTS = ["--cli-connect-timeout", "30", "--cli-read-timeout", _AWS_READ_TIMEOUT]
# Hard wall-clock cap per aws invocation (seconds) for transfers (cp/sync). A
# wedged process is killed and retried rather than hanging a worker forever.
# Generous so a legitimately slow multi-GB transfer never trips it; override with
# ZARR_AWS_TIMEOUT.
_AWS_OP_TIMEOUT = int(os.environ.get("ZARR_AWS_TIMEOUT", "1800"))
# Recursive deletes (`aws s3 rm --recursive` on a whole `<id>/zarr/` prefix or a
# store) are a different beast: a big dataset's prefix holds hundreds of stores x
# thousands of chunk objects = millions of keys, and DeleteObjects batches 1000 at
# a time, so a legitimate wipe can run far longer than a single transfer. Give it
# a much larger ceiling (and FEWER retries, so a true wedge fails in bounded time
# instead of N x the ceiling). The 1800 s transfer cap was killing real wipes of
# large datasets (e.g. on005261, 318 stores) mid-delete -> rebuild then 404'd.
_AWS_RM_TIMEOUT = int(os.environ.get("ZARR_AWS_RM_TIMEOUT", str(4 * 3600)))
_AWS_RM_RETRIES = int(os.environ.get("ZARR_AWS_RM_RETRIES", "2"))


def _aws_env() -> dict:
    """Environment for an aws subprocess: more internal API retries for transient
    throttle/5xx (the CLI honors ``AWS_MAX_ATTEMPTS``). The per-process S3
    transfer concurrency (``s3.max_concurrent_requests``) is config-only and is
    pinned low on the runner's profile out of band, so JOBS-way parallelism does
    not fan out to hundreds of concurrent connections (the cause of multipart
    download races and ``Need to rewind the stream`` upload failures)."""
    env = dict(os.environ)
    env.setdefault("AWS_MAX_ATTEMPTS", "10")
    return env


def _aws(
    cmd: list[str], *, timeout: int = _AWS_OP_TIMEOUT, retries: int = _AWS_RETRIES
) -> None:
    """Run an aws CLI command with a wall-clock timeout + backoff retry.

    A transfer that errors (throttle, multipart race) OR wedges past ``timeout``
    is retried; both `CalledProcessError` and `TimeoutExpired` (the wedge) count
    as a failed attempt. Raises RuntimeError after the last attempt.
    """
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            subprocess.run([*cmd, *_AWS_TIMEOUTS], check=True, timeout=timeout, env=_aws_env())
            return
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            last = exc
            if attempt < retries:
                time.sleep(min(2**attempt, 30))
    raise RuntimeError(f"aws {' '.join(cmd[1:3])} failed after {retries} attempts: {last}")


def _s3_prefix_empty(bucket: str, prefix: str) -> bool:
    """True only when a LIST of ``s3://bucket/prefix`` confirmably returns 0 keys.

    Lets the ``--clean`` wipe skip ``aws s3 rm --recursive`` when the serving
    prefix is already empty -- the common first-conversion / backfill case. The
    recursive rm still opens sockets and, if one wedges, spins on a prefix with
    nothing to delete; a single cheap LIST (short read timeout, so a wedge is
    reaped fast) sidesteps that entirely. Any error or ambiguity returns False so
    the caller falls through to the real rm rather than skipping a needed wipe.
    """
    try:
        res = subprocess.run(
            [
                "aws", "s3api", "list-objects-v2", "--bucket", bucket,
                "--prefix", prefix, "--max-items", "1",
                "--query", "Contents[0].Key", "--output", "text",
                *_AWS_TIMEOUTS,
            ],
            capture_output=True, text=True, timeout=_AWS_OP_TIMEOUT, env=_aws_env(),
        )
    except (subprocess.SubprocessError, OSError):
        return False
    if res.returncode != 0:
        return False
    # `--query Contents[0].Key --output text` prints the first key, or "None" when
    # the prefix holds no objects.
    return res.stdout.strip() in ("", "None")


# How many `aws s3 rm --recursive` processes to shard a big prefix across. Each
# inherits the runner profile's own (deliberately low) per-process request
# concurrency, so this multiplies delete throughput without raising the transfer
# concurrency that was pinned low to stop JOBS-way uploads causing multipart
# races. A single rm measured 13.8k objects/min on Hallu; the wipes that remain
# after the --clean change are rare (recovery via --wipe) but can still be huge.
_AWS_RM_SHARDS = int(os.environ.get("ZARR_AWS_RM_SHARDS", "8"))


def _s3_child_prefixes(url: str) -> list[str]:
    """Immediate child prefixes of an ``s3://bucket/prefix/`` URL (delimited LIST).

    ``[]`` means the prefix genuinely HAS no subdirectories. A failed listing
    RAISES: the empty list and the failure used to be the same answer, which is
    only harmless for the caller this was written for. ``_rm_recursive`` reads
    ``[]`` as "nothing to shard" and falls back to one unsharded delete, so it is
    correct either way -- but ``purge_non_raw_stores.list_dataset_ids`` reads the
    same ``[]`` as "this bucket holds no datasets" and ``discover_excluded_stores``
    as "this tree has no stranded stores", and both then report a clean, empty
    result for a run that could not see the bucket at all.

    Same rule as ``s3_read_json`` and ``s3_download_file``, for the same reason:
    an absence is an answer, an error is not.
    """
    rest = url[len("s3://") :]
    bucket, _, prefix = rest.partition("/")
    res = subprocess.run(
        [
            "aws", "s3api", "list-objects-v2", "--bucket", bucket,
            "--prefix", prefix, "--delimiter", "/",
            "--query", "CommonPrefixes[].Prefix", "--output", "text",
            *_AWS_TIMEOUTS,
        ],
        capture_output=True, text=True, timeout=_AWS_OP_TIMEOUT, env=_aws_env(),
        check=False,  # the return code is inspected below rather than raised on
    )
    if res.returncode != 0:
        raise RuntimeError(
            f"_s3_child_prefixes: aws s3api list-objects-v2 {url} exited "
            f"{res.returncode}: {res.stderr.strip()}"
        )
    if res.stdout.strip() in ("", "None"):
        return []
    return [f"s3://{bucket}/{p}" for p in res.stdout.split() if p and p != "None"]


def _rm_recursive(url: str) -> None:
    """Recursively delete an S3 prefix, sharded across child prefixes.

    `aws s3 rm --recursive` is single-process and paces at its profile's request
    concurrency, so a large prefix serializes into a long, near-idle wall-clock
    block. Splitting by child prefix lets N of them run at once. Falls back to one
    unsharded rm when the prefix has no children (or the LIST fails), and always
    finishes with an unsharded sweep so any key directly under `url` -- which no
    child prefix covers -- is deleted too.
    """
    # A failed LIST is not fatal HERE, and only here: the unsharded delete below
    # removes the whole prefix on its own, so sharding is a speed-up whose
    # failure costs time, not correctness. Every other caller of
    # `_s3_child_prefixes` reads its result as a fact about the bucket and must
    # see the error, which is why the tolerance lives at this call site rather
    # than inside the helper.
    try:
        children = _s3_child_prefixes(url) if _AWS_RM_SHARDS > 1 else []
    except (RuntimeError, subprocess.SubprocessError, OSError) as exc:
        print(
            f"::warning::could not list shards for {url} ({exc}); deleting unsharded",
            flush=True,
        )
        children = []
    if children:
        print(f"[zarr] deleting {url} across {len(children)} shard(s)", flush=True)
        errors: list[BaseException] = []
        with ThreadPoolExecutor(max_workers=min(_AWS_RM_SHARDS, len(children))) as pool:
            futures = {
                pool.submit(
                    _aws,
                    ["aws", "s3", "rm", child, "--recursive", "--only-show-errors"],
                    timeout=_AWS_RM_TIMEOUT,
                    retries=_AWS_RM_RETRIES,
                ): child
                for child in children
            }
            for fut in futures:
                try:
                    fut.result()
                except BaseException as exc:  # noqa: BLE001 -- re-raised below
                    errors.append(exc)
        if errors:
            # Surface the first failure; a partially-deleted prefix must not be
            # reported as a clean wipe.
            raise errors[0]
    # Sweep: catches loose keys at the top level, and is a cheap no-op once the
    # shards have done the bulk.
    _aws(
        ["aws", "s3", "rm", url, "--recursive", "--only-show-errors"],
        timeout=_AWS_RM_TIMEOUT,
        retries=_AWS_RM_RETRIES,
    )


def aws_cp(src: str, dst: str, *, extra: list[str] | None = None) -> None:
    # --only-show-errors drops the per-file transfer progress meter; with JOBS
    # workers each streaming a blob, that meter otherwise floods the log.
    _aws(["aws", "s3", "cp", src, dst, "--only-show-errors", *(extra or [])])


def annex_key_size(key: str | None) -> int | None:
    """Byte size a git-annex SHA256E/MD5E key declares in its ``-s<N>`` field
    (``SHA256E-s628291820--<hash>.con`` -> ``628291820``). ``None`` when the key
    carries no size (e.g. a URL/WORM key)."""
    m = re.search(r"-s(\d+)", key or "")
    return int(m.group(1)) if m else None


def _blob_key_and_size(repo_dir: str, path: str, head: str) -> tuple[str | None, int]:
    """For a tracked path at ``head``: ``(annex_key, in_git_blob_bytes)``. An
    annexed path returns ``(key, 0)`` -- its size lives in the key's ``-s`` field;
    a small in-git blob returns ``(None, len(blob))``. Reads pointers only, never
    downloads S3 content. Mirrors ``_fetch_blob``'s annex-vs-in-git decision."""
    meta = _run(["git", "-C", repo_dir, "ls-tree", head, "--", path]).strip()
    if not meta:
        return None, 0
    mode, _, rest = meta.split(" ", 2)
    sha = rest.split("\t", 1)[0].strip()
    blob = subprocess.check_output(["git", "-C", repo_dir, "cat-file", "blob", sha])
    if mode == "120000" or len(blob) < 1024:
        key = parse_annex_key(blob.decode("utf-8", "replace"))
        if key:
            return key, 0
    return None, len(blob)


def recording_size_from_pointers(
    repo_dir: str, primary_path: str, head_files: set[str], head: str
) -> int:
    """On-disk bytes of a recording's whole file set, read from git-annex pointers
    at ``head`` WITHOUT downloading: primary + same-stem companions + FIF split
    members, or every file under a directory recording (CTF ``.ds``/MEF3
    ``.mefd``/4D-BTi). Mirrors ``materialize_recording``'s wanted set and
    ``_recording_size_bytes`` so the parent's admission estimate (main) lines up
    with the worker's #909 preflight."""
    if is_dir_recording(primary_path):
        members: list[str] = [p for p in head_files if dir_recording_of(p) == primary_path]
    elif is_bti_dir(primary_path):
        # 4D/BTi: extension-less directory, so membership is exact-dirname
        # matching rather than `dir_recording_of`'s ancestor-component match.
        members = [p for p in head_files if os.path.dirname(p) == primary_path]
    else:
        d = os.path.dirname(primary_path)
        stem = filename_stem(primary_path)
        siblings = [
            p for p in head_files
            if os.path.dirname(p) == d and filename_stem(p) == stem
        ]
        members = list(
            dict.fromkeys([primary_path, *siblings, *split_members_for(primary_path, head_files)])
        )
    total = 0
    for path in members:
        key, blob_size = _blob_key_and_size(repo_dir, path, head)
        total += (annex_key_size(key) or 0) if key else blob_size
    return total


def download_blob(src: str, dst: str, expected_size: int | None) -> None:
    """Download an annex blob to ``dst`` robustly: a unique temp + atomic rename
    + size check against the key's declared size, retried with backoff.

    Large MEG/iEEG blobs (KIT ``.con`` ~1 GB, BrainVision ``.eeg`` >10 GB, split
    FIF >2 GB) intermittently arrive truncated under JOBS-way parallelism, which
    then surfaces downstream as ``not EDF compliant (Filesize)`` or a split chain
    that can't read its next file. A short/zero copy must never reach the reader:
    verify the byte count, and on any mismatch/transfer error drop the temp and
    retry rather than convert a corrupt file into a wrong store.
    """
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    last: Exception | None = None
    for attempt in range(1, _AWS_RETRIES + 1):
        tmp = f"{dst}.part.{os.getpid()}.{attempt}"
        try:
            subprocess.run(
                ["aws", "s3", "cp", src, tmp, "--only-show-errors", *_AWS_TIMEOUTS],
                check=True,
                timeout=_AWS_OP_TIMEOUT,
                env=_aws_env(),
            )
            got = os.path.getsize(tmp)
            if expected_size is not None and got != expected_size:
                raise RuntimeError(
                    f"truncated download: got {got} of {expected_size} bytes"
                )
            os.replace(tmp, dst)
            return
        except Exception as exc:  # noqa: BLE001 - any failure -> drop temp + retry
            last = exc
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass
            if attempt < _AWS_RETRIES:
                time.sleep(min(2**attempt, 30))
    raise RuntimeError(f"download {src} -> {dst} failed after {_AWS_RETRIES} attempts: {last}")


def s3_read_json(bucket: str, key: str) -> dict | None:
    """Read a JSON object from S3.

    Returns None ONLY for a genuine 404 (NoSuchKey) -- the legitimate first-run
    case. Any other non-zero exit (credentials, network, wrong bucket) RAISES:
    silently treating it as "no prior index" would send the run full AND drop
    every prior store from the rewritten index. A corrupt body raises for the
    same reason (absent != corrupt).
    """
    res = subprocess.run(
        ["aws", "s3", "cp", f"s3://{bucket}/{key}", "-", *_AWS_TIMEOUTS],
        capture_output=True,
        text=True,
        timeout=_AWS_OP_TIMEOUT,
        env=_aws_env(),
    )
    if res.returncode != 0:
        err = res.stderr.lower()
        if "nosuchkey" in err or "404" in err or "not found" in err:
            return None
        raise RuntimeError(
            f"s3_read_json: aws s3 cp s3://{bucket}/{key} exited {res.returncode}: "
            f"{res.stderr.strip()}"
        )
    try:
        return json.loads(res.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"corrupt JSON at s3://{bucket}/{key}: {exc}") from exc


class IndexPreconditionFailed(Exception):
    """The live `index.json` changed between the read a rewrite was computed from
    and the write. The write is REFUSED rather than forced: the other writer
    published a whole document, and replaying a merge computed from the old one
    would silently roll it back.
    """


def read_index_with_etag(bucket: str, dataset_id: str) -> tuple[dict | None, str | None]:
    """`(index, etag)` for a dataset's live `index.json`, or `(None, None)` when
    there is none.

    One `get-object` call for both, on purpose: the ETag has to be the one the
    body that produced this merge actually had, and a separate `head-object`
    could observe a different version. Raises for any failure that is not a
    genuine absence -- the same rule `s3_read_json` follows, for the same reason
    (treating a credentials or network error as "no index" would rewrite the
    document from nothing).

    Shared with `purge_non_raw_stores.py`, which imports it: both writers of this
    one object have to agree on how the ETag is read and sent back, or the
    conditional write protecting them from each other is decorative.
    """
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as fh:
        tmp_path = fh.name
    try:
        res = subprocess.run(
            [
                "aws", "s3api", "get-object", "--bucket", bucket,
                "--key", f"{dataset_id}/zarr/index.json", tmp_path,
                "--query", "ETag", "--output", "text", *_AWS_TIMEOUTS,
            ],
            capture_output=True, text=True, timeout=_AWS_OP_TIMEOUT, env=_aws_env(),
            check=False,  # the return code IS the answer: absent vs failed
        )
        if res.returncode != 0:
            err = res.stderr.lower()
            if "nosuchkey" in err or "404" in err or "not found" in err:
                return None, None
            raise RuntimeError(
                f"read_index_with_etag: aws s3api get-object exited "
                f"{res.returncode}: {res.stderr.strip()}"
            )
        with open(tmp_path, encoding="utf-8") as fh:
            index = json.load(fh)
        # `--output text` prints the quoted ETag; S3 wants it back verbatim on
        # `--if-match`, so only the surrounding whitespace is stripped.
        return index, res.stdout.strip()
    finally:
        with contextlib.suppress(OSError):
            os.unlink(tmp_path)


def write_index(bucket: str, dataset_id: str, index: dict, *, if_match: str | None) -> str | None:
    """Write `index.json` to S3 CONDITIONALLY. Returns the new object's ETag as
    the PUT reports it (quoted, as S3 spells it), or None when the response
    carried none.

    `index.json`'s destination is a single S3 object, so a single PUT is already
    atomic there: a reader sees the previous full body or the new full body,
    never a partial one. Atomic is not the same as safe, though, and that is what
    `if_match` is for. Two processes write this document -- a converter run
    (`generate_zarr.main`) and the non-raw purge (`purge_non_raw_stores.py`) --
    and both read it, work for minutes to hours, then write it back. An
    unconditional PUT from either silently reverts whatever the other published
    in that window, taking every store it added (or every store it deleted) with
    it. So the write carries `--if-match` with the ETag the document was computed
    from and S3 refuses it (412) if anything else has written since.

    `if_match=None` is not "skip the check" -- there is no such mode. It means
    the object did not exist at read time, and the write is then conditional on
    it still not existing (`--if-none-match "*"`), so a first index published in
    the meantime is not clobbered either.

    Single attempt, deliberately: `_aws`'s retry loop would re-send a conditional
    PUT whose first attempt may in fact have succeeded, turning a lost response
    into a phantom conflict. The CALLER decides what a conflict means -- the
    purge abandons its rewrite, the converter re-reads and re-merges once.
    """
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(index, fh, separators=(",", ":"))
        tmp_path = fh.name
    condition = ["--if-match", if_match] if if_match else ["--if-none-match", "*"]
    try:
        res = subprocess.run(
            [
                "aws", "s3api", "put-object", "--bucket", bucket,
                "--key", f"{dataset_id}/zarr/index.json", "--body", tmp_path,
                "--content-type", "application/json",
                "--cache-control", "public, max-age=60",
                *condition, *_AWS_TIMEOUTS,
            ],
            capture_output=True, text=True, timeout=_AWS_OP_TIMEOUT, env=_aws_env(),
            check=False,  # a 412 is a verdict to report, not an exception to raise
        )
    finally:
        with contextlib.suppress(OSError):
            os.unlink(tmp_path)
    if res.returncode == 0:
        # The PUT's own response names the version THIS call wrote. A follow-up
        # `head-object` would not: it can observe a newer writer's document,
        # which is precisely the race the conditional write exists to expose.
        try:
            etag = json.loads(res.stdout or "{}").get("ETag")
        except json.JSONDecodeError:
            etag = None
        return etag if isinstance(etag, str) else None
    err = res.stderr.lower()
    if "preconditionfailed" in err or "412" in err or "conditionalrequestconflict" in err:
        raise IndexPreconditionFailed(
            f"index.json for {dataset_id} changed between this run's read and its "
            f"write (if-match {if_match or '<absent>'}); the write was NOT applied "
            "and the newer document is untouched"
        )
    raise RuntimeError(
        f"write_index: aws s3api put-object exited {res.returncode}: {res.stderr.strip()}"
    )


def s3_download_file(bucket: str, key: str, dest: str) -> bool:
    """Download an S3 object to `dest`. False for a genuine 404, True on success.

    Same rule as `s3_read_json`, for the same reason: "the object is not there"
    is a legitimate first-run answer, and every OTHER failure (credentials,
    network, wrong bucket) raises rather than being flattened into it. The caller
    of this one carries rows forward from the object, so a swallowed error would
    silently republish a file with those rows missing.
    """
    res = subprocess.run(
        ["aws", "s3", "cp", f"s3://{bucket}/{key}", dest, "--only-show-errors", *_AWS_TIMEOUTS],
        capture_output=True,
        text=True,
        timeout=_AWS_OP_TIMEOUT,
        env=_aws_env(),
    )
    if res.returncode == 0:
        return True
    err = res.stderr.lower()
    if "nosuchkey" in err or "404" in err or "not found" in err:
        return False
    raise RuntimeError(
        f"s3_download_file: aws s3 cp s3://{bucket}/{key} exited {res.returncode}: "
        f"{res.stderr.strip()}"
    )


class ManifestFileEntry(TypedDict):
    """One entry of the manifest's `files[]`: a dataset-level object this run
    published beside index.json, with the size it wrote.

    Mirrors `zarr-manifest.schema.json`'s `files[]` items exactly, including the
    single-member `name` enum -- index.json and manifest.json describe
    themselves, so the events file is the only object that needs describing
    (#1060). Named as a type because both readers of it index it by key
    (`merge_manifest` embeds the whole entry; `main` reads `row_count` onto the
    index and the callback), and a bare `dict` let a renamed key typecheck
    everywhere and fail schema validation at the end of a conversion instead.
    """

    name: str
    size_bytes: int
    row_count: int


class EventsPublication(TypedDict):
    """What a run did about `<id>/zarr/events.parquet`.

    `file` is None whenever nothing was published, and the index must then point
    at nothing. `failed` separates the reason: "this dataset has no events" and
    "we could not say what its events are" must not look the same from outside.
    """

    file: ManifestFileEntry | None
    failed: bool


def publish_events_parquet(
    staged: EventsStaging,
    ordered_rels: list[str],
    *,
    bucket: str,
    dataset_id: str,
    reconverted: set[str],
) -> EventsPublication:
    """Build and upload `<id>/zarr/events.parquet`.

    Publishes nothing when the dataset has no events at all, `pyarrow` is
    missing, or this run could not write/upload the file -- the last of which
    sets `failed` and is reported on the callback.

    `reconverted` is every store this run rebuilt, INCLUDING the ones that
    produced no rows, and it is the thing "carried over" is defined against.
    Defining it against the staged rows instead is wrong twice over: a
    reconverted store whose events.tsv was deleted would keep republishing its
    old rows from the prior file forever, and on a first `--clean` run every
    event-less store would be reported as an unrecoverable carry-over it is not.

    Best-effort throughout, exactly like manifest.json: the stores and index.json
    are the serving copy, and ADR 0005 says partial data still serves. A failure
    here leaves the PREVIOUS file in place on S3, unreferenced by the new index
    until a later run republishes it.
    """
    carried = [rel for rel in ordered_rels if rel not in reconverted]
    if not staged.row_count and not carried:
        return {"file": None, "failed": False}
    try:
        import pyarrow  # type: ignore[import-not-found]  # noqa: F401 - probe only
    except ImportError:
        print(
            "::warning::pyarrow is not installed; "
            f"{dataset_id}/zarr/events.parquet was NOT written and the index will "
            "not advertise one (add it: scripts/zarr/requirements.txt)",
            flush=True,
        )
        return {"file": None, "failed": False}

    prior: PriorEventRows | None = None
    prior_local: str | None = None
    local: str | None = None
    try:
        if carried:
            # Only an INCREMENTAL run reaches this: `--clean` (the Hallu path)
            # rebuilds every store, so nothing is carried and nothing is fetched.
            with tempfile.NamedTemporaryFile(suffix=".parquet", delete=False) as fh:
                prior_local = fh.name
            if s3_download_file(bucket, f"{dataset_id}/zarr/{EVENTS_PARQUET_NAME}", prior_local):
                prior = PriorEventRows(prior_local)
        with tempfile.NamedTemporaryFile(suffix=".parquet", delete=False) as fh:
            local = fh.name
        rows = write_events_parquet(local, ordered_rels, staged, prior, reconverted)
        if not rows:
            # Every store's events.tsv was absent or empty. Publishing an empty
            # file would tell a client "no events" no more clearly than the
            # absent `events_parquet` field does, and costs a fetch to learn it.
            return {"file": None, "failed": False}
        aws_cp(
            local,
            f"s3://{bucket}/{dataset_id}/zarr/{EVENTS_PARQUET_NAME}",
            extra=["--content-type", EVENTS_CONTENT_TYPE,
                   "--cache-control", "public, max-age=60"],
        )
        missing = [rel for rel in carried if prior is None or rel not in prior]
        if missing:
            # Stores this run did NOT reconvert whose rows are in no prior file
            # either: the first incremental run after this shipped, or a prior
            # file that predates them. Their events are simply absent from the
            # file until the store is reconverted, and a client joining on
            # `store_path` cannot tell that from "this recording has no
            # events.tsv" -- so say it here, where an operator can see how many
            # and re-run with --clean. A store this run DID reconvert is never
            # in this list, however few rows it produced: nothing is missing
            # about a store whose events were just re-read.
            print(
                f"::warning::{len(missing)} carried-over store(s) contribute no rows "
                f"to {dataset_id}/zarr/events.parquet (no prior rows to carry); "
                "a --clean run rebuilds them",
                flush=True,
            )
        return {
            "file": {
                "name": EVENTS_PARQUET_NAME,
                "size_bytes": os.path.getsize(local),
                "row_count": rows,
            },
            "failed": False,
        }
    except Exception as exc:  # noqa: BLE001 - never fail a good conversion over this
        print(
            f"::warning::{dataset_id}/zarr/{EVENTS_PARQUET_NAME} was not published: "
            f"{redact_secrets(str(exc))}",
            flush=True,
        )
        return {"file": None, "failed": True}
    finally:
        for path in (local, prior_local):
            if path:
                with contextlib.suppress(OSError):
                    os.unlink(path)


def _fetch_blob(
    repo_dir: str, bucket: str, dataset_id: str, path: str, head: str, local: str
) -> tuple[bool, str | None]:
    """Materialize one tracked path to `local`. Returns (found, annex_key).

    Annex content (locked symlink or unlocked pointer) is pulled from S3 with
    authenticated `aws s3 cp`; an in-git blob is written directly. `found=False`
    when the path is absent from `ls-tree head` (caller decides if that is fatal).
    Reads against the pinned `head` SHA so it matches the worklist's tree.
    """
    meta = _run(["git", "-C", repo_dir, "ls-tree", head, "--", path]).strip()
    if not meta:
        return False, None
    mode, _, rest = meta.split(" ", 2)
    sha = rest.split("\t", 1)[0].strip()
    blob = subprocess.check_output(["git", "-C", repo_dir, "cat-file", "blob", sha])
    key = None
    if mode == "120000" or len(blob) < 1024:
        key = parse_annex_key(blob.decode("utf-8", "replace"))
    os.makedirs(os.path.dirname(local) or ".", exist_ok=True)
    if key:
        download_blob(f"s3://{bucket}/{dataset_id}/objects/{key}", local, annex_key_size(key))
    else:
        with open(local, "wb") as fh:
            fh.write(blob)
    return True, key


def _materialize_dir_members(
    repo_dir: str,
    bucket: str,
    dataset_id: str,
    dir_path: str,
    inner: list[str],
    head_files: set[str],
    head: str,
    work_dir: str,
    kind: str,
) -> tuple[str, str | None, str | None]:
    """Shared download step for a directory-keyed recording (CTF `.ds`, MEF3
    `.mefd`, or 4D/BTi): materialize the already-resolved `inner` member paths
    into `work_dir`, preserving the directory's internal layout the reader
    expects, plus the BIDS events sidecar if present. `kind` (e.g. ``"CTF"``,
    ``"MEF3"``, ``"4D/BTi"``) only flavors error/warning text -- the download
    logic itself is identical for all three, which is the point of factoring it
    out rather than repeating it per format. Returns (local_dir, events_local|
    None, None) -- a directory recording carries no single git-annex key of its
    own (see `materialize_recording`).
    """
    local_dir = os.path.join(work_dir, os.path.basename(dir_path))
    if not inner:
        raise RuntimeError(f"{kind} recording {dir_path!r} has no files at ls-tree {head[:8]}")
    for path in inner:
        rel = path[len(dir_path) + 1 :]  # path relative to the recording dir
        found, _ = _fetch_blob(repo_dir, bucket, dataset_id, path, head, os.path.join(local_dir, rel))
        if not found:
            # Every inner file came from `ls-tree head`; a missing one means a real
            # tree/pack desync. The recording is read as a whole, and we cannot tell
            # a mandatory file from an optional sidecar, so FAIL rather than convert
            # a partial recording into a wrong store that would then
            # `aws s3 sync --delete` over a good one.
            raise RuntimeError(
                f"{kind} file {path!r} absent from ls-tree {head[:8]}; refusing to convert a "
                "partial recording"
            )
    events_path = events_sibling_for(dir_path)
    events_local = None
    if events_path in head_files:
        events_local = os.path.join(work_dir, os.path.basename(events_path))
        found, _ = _fetch_blob(repo_dir, bucket, dataset_id, events_path, head, events_local)
        if not found:
            # Sidecar tracked at HEAD but unfetchable -> don't claim a phantom path
            # (downstream would silently embed no events); warn and drop it.
            print(f"::warning::{kind} events {events_path!r} absent from ls-tree {head[:8]}; skipping", flush=True)
            events_local = None
    return local_dir, events_local, None


def _materialize_dir_recording(
    repo_dir: str,
    bucket: str,
    dataset_id: str,
    dir_path: str,
    head_files: set[str],
    head: str,
    work_dir: str,
) -> tuple[str, str | None, str | None]:
    """Download every file under a CTF `.ds` or MEF3 `.mefd` recording directory
    (extension-derived membership; see `dir_recording_of`)."""
    inner = sorted(p for p in head_files if dir_recording_of(p) == dir_path)
    kind = "MEF3" if is_mefd(dir_path) else "CTF"
    return _materialize_dir_members(
        repo_dir, bucket, dataset_id, dir_path, inner, head_files, head, work_dir, kind
    )


def _materialize_bti(
    repo_dir: str,
    bucket: str,
    dataset_id: str,
    bti_dir: str,
    head_files: set[str],
    head: str,
    work_dir: str,
) -> tuple[str, str | None, str | None]:
    """Download every file directly inside a 4D/BTi recording directory (see
    `bti_recordings`). BIDS gives it no extension, so unlike `.ds`/`.mefd` its
    members are exact-dirname matches rather than ancestor-derived."""
    inner = sorted(p for p in head_files if os.path.dirname(p) == bti_dir)
    # Name, in this converter's own log, the same file biosigIO's `_find_bti_pdf`
    # is expected to choose (see `bti_pdf_choice`) whenever the choice is
    # ambiguous -- so an operator reading THIS converter's output can already see
    # which processed-data file will end up in the store, without cross-
    # referencing biosigIO's separate warning.
    chosen, ambiguous = bti_pdf_choice({os.path.basename(p) for p in inner})
    if chosen and ambiguous:
        print(
            f"::warning::4D/BTi {bti_dir!r} has multiple processed-data candidates; "
            f"biosigio is expected to read {chosen!r}",
            flush=True,
        )
    return _materialize_dir_members(
        repo_dir, bucket, dataset_id, bti_dir, inner, head_files, head, work_dir, "4D/BTi"
    )


def materialize_recording(
    repo_dir: str,
    bucket: str,
    dataset_id: str,
    primary_path: str,
    head_files: set[str],
    head: str,
    work_dir: str,
) -> tuple[str, str | None, str | None]:
    """Reconstruct a recording's file set into `work_dir`.

    Downloads the primary + every same-stem companion (annex content via
    authenticated `aws s3 cp`, in-git blobs written directly) and the BIDS
    `_events.tsv` sidecar if present. A directory recording (CTF `.ds`/MEF3
    `.mefd`/4D-BTi) is handled by `_materialize_dir_recording`/`_materialize_bti`
    instead. Returns (primary_local_path, events_local_path|None,
    primary_annex_key|None).
    """
    if is_dir_recording(primary_path):
        return _materialize_dir_recording(repo_dir, bucket, dataset_id, primary_path, head_files, head, work_dir)
    if is_bti_dir(primary_path):
        return _materialize_bti(repo_dir, bucket, dataset_id, primary_path, head_files, head, work_dir)

    d = os.path.dirname(primary_path)
    stem = filename_stem(primary_path)
    siblings = [
        p
        for p in head_files
        if os.path.dirname(p) == d and filename_stem(p) == stem
    ]
    # For a split FIF, pull every split in the group (read_raw_fif(split-01) follows
    # the chain on disk; without split-02.. present the head read raises). Their
    # basenames are distinct, so they land beside the head under their BIDS names
    # and MNE resolves the chain. [] for non-split recordings.
    split_members = split_members_for(primary_path, head_files)
    events_path = events_sibling_for(primary_path)
    wanted = list(dict.fromkeys([primary_path, *siblings, *split_members]))
    if events_path in head_files:
        wanted.append(events_path)

    primary_key: str | None = None
    events_fetched = False
    for path in wanted:
        local = os.path.join(work_dir, os.path.basename(path))
        found, key = _fetch_blob(repo_dir, bucket, dataset_id, path, head, local)
        if not found:
            if path == primary_path:
                raise RuntimeError(
                    f"primary {path!r} in the worklist but absent from ls-tree {head[:8]} "
                    "(possible pack corruption or path-encoding issue)"
                )
            if path == events_path:
                # events_path only reaches `wanted` when it IS in head_files, so
                # "not found" here is a tree/pack desync rather than the ordinary
                # "this recording has no events.tsv". Say so distinctly: the
                # generic companion line below reads identically to the benign
                # case and would hide a real repository problem.
                print(
                    f"::warning::events sidecar {path!r} is tracked at {head[:8]} but "
                    "could not be fetched; converting WITHOUT behavioral annotations",
                    flush=True,
                )
            else:
                print(
                    f"::warning::companion {path!r} absent from ls-tree {head[:8]}; skipping",
                    flush=True,
                )
            continue
        if path == primary_path:
            primary_key = key
        if path == events_path:
            events_fetched = True
    return (
        os.path.join(work_dir, os.path.basename(primary_path)),
        # Derived from the fetch actually succeeding, not from tree membership.
        # `_materialize_dir_members` already does it this way; this returned a
        # path to a file it had not written whenever the events fetch failed.
        # Every caller happens to guard with os.path.exists, so nothing is
        # mis-served today -- but the value was a claim this function could not
        # back, and one unguarded caller away from being a real bug.
        os.path.join(work_dir, os.path.basename(events_path)) if events_fetched else None,
        primary_key,
    )


def store_metadata(store_path: str) -> dict:
    """Read the small per-store summary the viewer/index needs from the written
    store's attrs (biosigIO contract: root `channel_groups`, group `rate`/
    `n_channels`/`n_samples`/`modality`). Best-effort: returns {} on any error.
    """
    try:
        import zarr  # type: ignore

        root = zarr.open_group(store_path, mode="r")
        ra = dict(root.attrs)
        groups = []
        modalities: set[str] = set()
        for gname in ra.get("channel_groups", []):
            ga = dict(root[gname].attrs)
            rate = ga.get("rate")
            nsamp = ga.get("n_samples")
            mod = ga.get("modality")
            if mod:
                modalities.add(str(mod).lower())
            group = {
                "name": gname,
                "modality": mod,
                "rate": rate,
                "n_channels": ga.get("n_channels"),
                "n_samples": nsamp,
                "duration_s": (nsamp / rate) if rate and nsamp else None,
            }
            # Serving GEOMETRY, republished from the store's own attrs
            # (biosigio>=1.2.6, biosigio#126). A reader that has the index has
            # then already paid for the store's shape: `n_view_levels` removes
            # the probe-until-404 walk over view/1..N, and `view_chunk_columns`
            # says how many requests a viewport-sized read costs at any level
            # (#1178 items 1-2). `source_rate_hz` is the ACQUISITION rate, the
            # thing `rate` above is not -- `rate` is the NEMAR modality cap.
            # Copied only when present, so an older store simply omits them.
            for key in ("n_view_levels", "view_chunk_columns"):
                if key in ga:
                    group[key] = ga[key]
            try:
                la = dict(root[gname]["0"].attrs)
            except Exception:  # noqa: BLE001 - level 0 absent/unreadable: omit
                la = {}
            for key in ("source_rate_hz", "chunk_samples", "shard_samples"):
                if key in la:
                    group[key] = la[key]
            groups.append(group)
        # Count event descriptions when the events group exists and carries them.
        event_description_count: int | None = None
        if "events" in root:
            vd = dict(root["events"].attrs).get("value_descriptions")
            if isinstance(vd, dict):
                event_description_count = len(vd)
        result: dict = {
            "modalities": sorted(modalities),
            "groups": groups,
            "power_line_frequency": ra.get("power_line_frequency"),
        }
        if event_description_count is not None:
            result["event_description_count"] = event_description_count
        # biosigIO's own account of what the BIDS channels.tsv `units` column did
        # (biosigio#125), which it records in the recording metadata and `to_zarr`
        # serializes into the store root. Republished so a unit that could NOT be
        # adopted is visible on the PUBLIC surface: a store whose report says
        # `kept_importer_unit` is serving numbers the sidecar disagrees with, and
        # before this that was only discoverable by reading the conversion log.
        # Absence means "no channels.tsv applied to this recording" -- either the
        # dataset ships none that inherits to it, or the read failed and the
        # driver said so. It never means "applied cleanly".
        #
        # Two locations, on purpose. The in-memory path records it in the
        # recording metadata, which `to_zarr` serializes into
        # `recording_metadata`; the streaming exporter never builds a Recording,
        # so biosigio#128 writes it as a ROOT attr instead. Root wins when both
        # exist -- it is the exporter-level statement, made after any importer's.
        rec_meta = ra.get("recording_metadata")
        for candidate in (
            ra.get("channels_tsv_units"),
            rec_meta.get("channels_tsv_units") if isinstance(rec_meta, dict) else None,
        ):
            if isinstance(candidate, dict):
                result["units_report"] = candidate
                break
        return result
    except Exception as exc:  # noqa: BLE001 - best-effort metadata, never fatal
        print(f"::warning::store_metadata failed for {store_path}: {exc}", flush=True)
        # Carry the cause so the caller's error names it, instead of the two
        # halves only being reconstructable by grepping the log for timestamps.
        # Keyed `_error` and stripped before the entry is built: `meta` is spread
        # into the PUBLISHED index, and diagnostic state must not ride along.
        return {"_error": str(exc)}


def materialize_local(
    repo_dir: str, primary_path: str, head_files: set[str]
) -> tuple[str, str | None, str | None]:
    """Local-mode materialisation (e.g. Hallu after `nemar dataset download`).

    The dataset working tree already holds the annex content (the data files are
    symlinks resolving to local annex objects), so biosigIO reads the
    working-tree paths directly and companions resolve beside the primary --
    no S3 download. Returns (primary_local, events_local|None, annex_key|None);
    the key is read from the symlink target for index provenance, best-effort.
    """
    primary_local = os.path.join(repo_dir, primary_path)
    events_rel = events_sibling_for(primary_path)
    events_local = os.path.join(repo_dir, events_rel) if events_rel in head_files else None
    primary_key: str | None = None
    try:
        if os.path.islink(primary_local):
            primary_key = parse_annex_key(os.readlink(primary_local))
    except OSError:
        primary_key = None
    return primary_local, events_local, primary_key


def embed_attr(meta_path: str, key: str, value: object) -> None:
    """Write a key into the `attributes` dict of an arbitrary Zarr v3 group zarr.json.

    Reads `meta_path`, sets `attributes[key] = value`, and writes back in place.
    Preserves all other fields. Use `embed_root_attr` for the store-root shorthand.
    """
    with open(meta_path, encoding="utf-8") as fh:
        doc = json.load(fh)
    doc.setdefault("attributes", {})[key] = value
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh)


def embed_root_attr(store_path: str, key: str, value: object) -> None:
    """Write a scalar into the Zarr v3 root group's attributes (its `zarr.json`)
    after biosigIO has written the store. Carries a display hint the converter knows
    from BIDS context but biosigIO does not (PowerLineFrequency), so the viewer reads
    it straight from the store with no extra fetch."""
    embed_attr(os.path.join(store_path, "zarr.json"), key, value)


def fix_source_file_attr(store_path: str, bids_relpath: str) -> None:
    """Overwrite the store's `recording_metadata.source_file` root attribute
    with the repository-relative BIDS path.

    Every biosigIO importer calls ``rec.set_metadata("source_file", filepath)``
    with whatever path this driver handed it -- the conversion host's scratch
    materialisation (``.../zarr-scratch/tmpXXXXXXXX/work/...``), a fresh
    ``mkdtemp`` name every run. Left as-is, re-converting the same recording at
    the same source commit produces byte-different store metadata (defeating
    reproducibility), needlessly publishes the conversion host's internal
    directory layout, and names a directory that no longer exists by the time
    anyone reads it. ``bids_relpath`` is the same ``path`` this recording is
    already keyed at in index.json, so it is stable and known here without any
    extra lookup. biosigIO itself is untouched; this only corrects what NEMAR
    publishes downstream, after biosigIO has written the store and before it
    is validated/uploaded. nemarOrg/nemar-cli#1102.
    """
    meta_path = os.path.join(store_path, "zarr.json")
    with open(meta_path, encoding="utf-8") as fh:
        doc = json.load(fh)
    # `or {}` rather than a `{}` default: an explicit `"attributes": null` makes
    # `.get("attributes", {})` return None, and the chained .get would then raise.
    rec_meta = (doc.get("attributes") or {}).get("recording_metadata")
    if not isinstance(rec_meta, dict):
        # Unexpected biosigIO version/shape: nothing to correct, and we must
        # not fabricate a key biosigIO did not write.
        print(
            f"::warning::no recording_metadata attribute at {meta_path}; "
            "source_file scratch-path fix skipped",
            flush=True,
        )
        return
    rec_meta["source_file"] = bids_relpath
    # Write to a sibling temp file then os.replace: opening `meta_path` with "w"
    # truncates it first, so an interruption mid-dump would leave a truncated
    # zarr.json behind -- and validate_store only checks that the file EXISTS,
    # not that it parses, so a corrupt one could pass the gate. os.replace is
    # atomic within a directory, so the store metadata is never half-written.
    tmp_path = f"{meta_path}.tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
        os.replace(tmp_path, meta_path)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


# Matches `publisher` in backend/src/services/datacite.ts, shortened to the form a
# reference list actually carries.
_CITATION_PUBLISHER = "NEMAR"


def dataset_citation(row: dict | None) -> str | None:
    """A ready-to-paste citation string for a dataset, or None when the catalog
    row does not carry enough to make one honestly.

    #1064's point: a client that reads the data has the citation at the moment it
    needs it, rather than reconstructing it later or not at all -- which has a
    disproportionate effect on whether NEMAR gets cited correctly. Composed here
    rather than fetched because the catalog has no citation column; every part
    comes from the public row, and a missing part omits its segment instead of
    printing an empty one.
    """
    if not isinstance(row, dict):
        return None
    name = str(row.get("name") or "").strip()
    if not name:
        return None
    authors = str(row.get("authors") or "").strip()
    doi = str(row.get("concept_doi") or row.get("doi") or "").strip()
    version = str(row.get("latest_version") or "").strip()
    year = str(row.get("created_at") or "")[:4]
    parts: list[str] = []
    if authors:
        parts.append(authors)
    if year.isdigit():
        parts.append(f"({year})")
    parts.append(f"{name}{f' ({version})' if version else ''}.")
    parts.append(f"{_CITATION_PUBLISHER}.")
    if doi:
        parts.append(f"https://doi.org/{doi.removeprefix('doi:')}")
    return " ".join(parts)


def nemar_store_attrs(
    dataset_id: str,
    source_commit: str,
    source_tree: str,
    derived: bool,
    engine_version: str,
    contract_url: str,
    row: dict | None = None,
    provenance_fetch_failed: bool = False,
) -> dict:
    """The `nemar` root attribute written on every store (#1064). Pure.

    Store attributes carried provenance as PROSE -- a free-text `note` saying the
    copy is derived and the BIDS source is authoritative. That is fine for a human
    reading the JSON and useless to a client deciding whether the data is suitable,
    and the population reading these stores is increasingly machine. This is the
    structured half; biosigIO's own attributes (including that note) are left
    exactly as they are.

    DOI, license and citation especially: a store that carries its own attribution
    can be cited by whoever opens it. `row` is the public catalog row (GET
    /datasets/<id>); a field the catalog does not have stays None rather than
    being invented, so "unknown license" is distinguishable from "no license".
    `provenance_fetch_failed` carries the third case: the nulls are there because
    the catalog could not be read at all, which is a property of the RUN and is
    fixed by re-converting rather than by editing the dataset.
    """
    row = row if isinstance(row, dict) else {}
    doi = row.get("concept_doi") or row.get("doi")
    return {
        "dataset_id": dataset_id,
        "doi": doi or None,
        "license": row.get("license") or None,
        "citation": dataset_citation(row),
        "source_commit": source_commit,
        # Which BIDS tree the source sits in, vs whether the SIGNAL was
        # processed. #1064 flagged that "derivative" collides semantically
        # between the two senses; carrying both, named apart, is the fix.
        "source_tree": source_tree,
        "derived": derived,
        "hed_version": row.get("hed_version") or None,
        "engine_version": engine_version,
        # The stable URL for THIS store, so a copy of the store that has been
        # moved or vendored can still say where it came from.
        "contract_url": contract_url,
        # True when the catalog read FAILED, so the nulls above are a property of
        # this run rather than of the dataset. Present either way: a consumer
        # that has to check `"provenance_fetch_failed" in attrs` to know whether
        # an absence is meaningful is back where it started.
        "provenance_fetch_failed": provenance_fetch_failed,
    }


def fetch_dataset_row(api_base: str, dataset_id: str) -> tuple[dict | None, bool]:
    """`(row, fetch_failed)` for `GET <api_base>/datasets/<id>`.

    Read ONCE per run in `main` and passed to the workers, not fetched per
    recording: a dataset with 25k recordings would otherwise make 25k identical
    requests to the catalog. Best-effort by design -- the provenance attrs are
    written either way, with the catalog-sourced fields left None, because a
    catalog blip must not cost a conversion.

    The second element is why this returns a tuple rather than an optional row.
    "The catalog has no DOI for this dataset" and "we could not reach the
    catalog" both produce `doi: null` in the store attrs, and they mean opposite
    things: the first is a fact about the dataset, the second is a fact about the
    run, fixed by re-converting. Without the flag, a catalog outage silently
    publishes a whole conversion wave's worth of stores that claim to have no
    license -- afterwards indistinguishable from datasets that genuinely have
    none. `fetch_failed` is True ONLY for a transport/parse failure, never for a
    row that simply lacks a field.
    """
    url = f"{api_base.rstrip('/')}/datasets/{dataset_id}"
    try:
        req = urllib.request.Request(
            url, headers={"Accept": "application/json", "User-Agent": USER_AGENT}
        )
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 - fixed https base
            body = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - provenance is best-effort
        print(
            f"::warning::could not read {url} ({exc}); store provenance attrs will "
            "omit doi/license/citation/hed_version and are flagged "
            "provenance_fetch_failed",
            flush=True,
        )
        return None, True
    # The route wraps the row in `{dataset: {...}}` on some paths and returns it
    # bare on others; accept either rather than coupling to one shape.
    if isinstance(body, dict):
        inner = body.get("dataset")
        return (inner if isinstance(inner, dict) else body), False
    # A 200 whose body is not an object is a broken catalog, not an absent field.
    print(
        f"::warning::{url} returned a non-object body; store provenance attrs are "
        "flagged provenance_fetch_failed",
        flush=True,
    )
    return None, True


def electrode_positions_for(
    repo_dir: str, primary_path: str, head_files: set[str], head: str
) -> dict | None:
    """BIDS electrode positions for a recording, resolved via the inheritance
    principle: among the `_electrodes.tsv` sidecars in the recording's directory
    or an ancestor whose entities are a subset of the recording's, the most
    specific one wins. A sibling `_coordsystem.json` is resolved the same way.

    The TSV is parsed by its header row to find the `name`/`x`/`y`/`z` columns
    (robust to extra columns like type/impedance and to column-order variation).
    Rows where any of x/y/z is missing, non-numeric, or "n/a" are skipped.

    Returns ``{"positions": {label: [x, y, z]}, "coordinate_system": str,
    "coordinate_units": str}`` or None when no `_electrodes.tsv` resolves or it
    contains no valid rows.
    """
    stem = filename_stem(primary_path)
    rec_dir = os.path.dirname(primary_path)
    rec_ents = _bids_entities(stem)

    def _resolve_sidecar(needle: str) -> str | None:
        """Return the most-specific applicable sidecar path, or None.

        `needle` is an entity-prefixed suffix like ``_electrodes.tsv``.
        A file matches when its basename ends with `needle` (e.g.
        ``sub-01_task-rest_electrodes.tsv``) or its basename is exactly
        the bare form without the leading underscore (e.g. ``electrodes.tsv``
        at the dataset root). Both forms carry empty entities, so the entity
        subset check still applies correctly.
        """
        bare = needle.lstrip("_")  # "electrodes.tsv" from "_electrodes.tsv"
        candidates: list[tuple[int, int, str]] = []
        for f in head_files:
            bname = os.path.basename(f)
            if not (f.endswith(needle) or bname == bare):
                continue
            cdir = os.path.dirname(f)
            if cdir and rec_dir != cdir and not rec_dir.startswith(cdir + "/"):
                continue
            cents = _bids_entities(filename_stem(f))
            if any(rec_ents.get(k) != v for k, v in cents.items()):
                continue
            depth = cdir.count("/") + (1 if cdir else 0)
            candidates.append((depth, len(cents), f))
        if not candidates:
            return None
        candidates.sort()
        # most specific = last after ascending sort
        return candidates[-1][2]

    elec_path = _resolve_sidecar("_electrodes.tsv")
    if elec_path is None:
        return None
    elec_text = _read_repo_text(repo_dir, head, elec_path)
    if not elec_text:
        return None

    # Parse the TSV by its header to locate name/x/y/z columns.
    lines = elec_text.splitlines()
    if not lines:
        return None
    header = [col.strip().lower() for col in lines[0].split("\t")]
    try:
        name_i = header.index("name")
        x_i = header.index("x")
        y_i = header.index("y")
        z_i = header.index("z")
    except ValueError:
        return None  # required columns absent

    positions: dict[str, list[float]] = {}
    for row_line in lines[1:]:
        if not row_line.strip():
            continue
        cols = row_line.split("\t")
        if len(cols) <= max(name_i, x_i, y_i, z_i):
            continue
        label = cols[name_i].strip()
        if not label:
            continue
        try:
            xv = cols[x_i].strip()
            yv = cols[y_i].strip()
            zv = cols[z_i].strip()
            if xv.lower() == "n/a" or yv.lower() == "n/a" or zv.lower() == "n/a":
                continue
            positions[label] = [float(xv), float(yv), float(zv)]
        except (ValueError, IndexError):
            continue

    if not positions:
        return None

    # Resolve the sibling coordsystem.json for coordinate metadata.
    coord_system = ""
    coord_units = ""
    cs_path = _resolve_sidecar("_coordsystem.json")
    if cs_path is not None:
        cs_text = _read_repo_text(repo_dir, head, cs_path)
        if cs_text:
            try:
                cs_data = json.loads(cs_text)
                if isinstance(cs_data, dict):
                    sys_val = cs_data.get("EEGCoordinateSystem") or cs_data.get(
                        "iEEGCoordinateSystem"
                    ) or cs_data.get("MEGCoordinateSystem") or ""
                    units_val = cs_data.get("EEGCoordinateUnits") or cs_data.get(
                        "iEEGCoordinateUnits"
                    ) or cs_data.get("MEGCoordinateUnits") or ""
                    coord_system = str(sys_val) if sys_val else ""
                    coord_units = str(units_val) if units_val else ""
            except ValueError:
                pass

    return {
        "positions": positions,
        "coordinate_system": coord_system,
        "coordinate_units": coord_units,
    }


def event_descriptions_for(
    repo_dir: str, primary_path: str, head_files: set[str], head: str
) -> dict[str, str]:
    """BIDS event-code descriptions for a recording, resolved via the inheritance
    principle: among the `_events.json` sidecars sitting in the recording's
    directory or an ancestor whose entities are a subset of the recording's, the
    most specific one wins (overrides less specific). Returns a flat mapping of
    event code -> description string (empty dict when none apply or no Levels are
    declared).

    Each applicable `_events.json` sidecar is parsed as a BIDS column-metadata
    object. For every top-level value that is a dict containing a ``"Levels"`` dict,
    its ``{str: str}`` entries are merged (most-specific sidecar wins). This supports
    multiple columns declaring Levels (e.g. ``value``, ``trial_type``).

    Sidecars are small JSON files tracked in git (not annexed); read via the working
    tree when present and ``git cat-file`` otherwise, matching the no-checkout
    workflow clone behaviour.
    """
    stem = filename_stem(primary_path)
    rec_dir = os.path.dirname(primary_path)
    rec_ents = _bids_entities(stem)
    needle = "_events.json"
    candidates: list[tuple[int, int, str]] = []
    for f in head_files:
        if not f.endswith(needle):
            continue
        cdir = os.path.dirname(f)
        # Applicable only if the sidecar is in the recording's dir or an ancestor.
        if cdir and rec_dir != cdir and not rec_dir.startswith(cdir + "/"):
            continue
        cents = _bids_entities(filename_stem(f))
        # ...and its entities must be a subset of the recording's.
        if any(rec_ents.get(k) != v for k, v in cents.items()):
            continue
        depth = cdir.count("/") + (1 if cdir else 0)
        candidates.append((depth, len(cents), f))
    candidates.sort()  # least specific first; the most specific value overrides
    result: dict[str, str] = {}
    for _, _, f in candidates:
        text = _read_repo_text(repo_dir, head, f)
        if text is None:
            continue
        try:
            data = json.loads(text)
        except ValueError:
            continue
        if not isinstance(data, dict):
            continue
        for col_meta in data.values():
            if not isinstance(col_meta, dict):
                continue
            levels = col_meta.get("Levels")
            if not isinstance(levels, dict):
                continue
            for code, desc in levels.items():
                if isinstance(code, str) and code and isinstance(desc, str) and desc:
                    result[code] = desc
    return result


def _recording_size_bytes(primary_local: str) -> int:
    """On-disk size of a recording: its primary file + same-stem companions
    (`.eeg`/`.vmrk` for BrainVision; FIF is single-file), or every file under a
    directory recording. The `os.path.isdir` branch is format-agnostic, so it
    already covers CTF `.ds`, MEF3 `.mefd` (a real MEF3 session's bulk lives in
    its many `.timd/.../.tdat` channel-segment files, not any single header), and
    a 4D/BTi directory (whose bulk is the `c,rf*` processed-data file) with no
    extension-specific code -- summing the whole tree is correct for all three.
    Drives the streaming decision -- the bulk lives in the `.eeg` companion /
    `.meg4` / `.tdat` / `c,rf*`, not the tiny header files beside it.

    On any stat/listing error this returns a value that FORCES the (bounded-memory)
    streaming path rather than an undercount/zero, which would misroute a large
    recording to the OOM-prone in-memory path. Only MNE-native exts reach streaming,
    so over-forcing a small file there is at worst slower, never wrong."""
    force = 1 << 62  # exceeds any real STREAM_MIN_BYTES -> routes to streaming
    # Any directory recording (CTF `.ds` / MEF3 `.mefd` / 4D-BTi): sum the whole
    # directory tree. `os.path.isdir` alone decides this -- no extension check
    # needed, which is exactly why this branch already covers `.mefd`/BTi too.
    if os.path.isdir(primary_local):
        errored = False

        def _onerr(_exc: OSError) -> None:
            nonlocal errored
            errored = True

        total = 0
        for root, _dirs, files in os.walk(primary_local, onerror=_onerr):
            for fn in files:
                try:
                    total += os.path.getsize(os.path.join(root, fn))
                except OSError:
                    errored = True
        if errored:
            print(f"::warning::could not fully stat recording dir {primary_local!r}; forcing streaming", flush=True)
            return force
        return total
    d = os.path.dirname(primary_local) or "."
    try:
        entries = os.listdir(d)
    except OSError:
        print(f"::warning::could not list {d!r}; forcing streaming", flush=True)
        return force
    # A split FIF's bulk lives in split-02.., which carry DIFFERENT stems
    # (`_split-02_meg` vs `_split-01_meg`); summing only split-01's same-stem
    # companions undercounts the chain, so should_stream misroutes a multi-GB
    # recording onto the OOM-prone in-memory path (read_raw_fif follows the whole
    # chain on disk). Sum every local member of the split group instead. #909
    if is_split_fif(primary_local):
        gkey = split_group_key(primary_local)
        total = 0
        for fn in entries:
            full = os.path.join(d, fn)  # split_group_key keeps the dir; compare on full paths
            if is_split_fif(full) and split_group_key(full) == gkey:
                try:
                    total += os.path.getsize(full)
                except OSError:
                    print(f"::warning::could not stat split member {fn!r}; forcing streaming", flush=True)
                    return force
        return total
    stem = filename_stem(primary_local)
    total = 0
    for fn in entries:
        if os.path.splitext(fn)[0] == stem:
            try:
                total += os.path.getsize(os.path.join(d, fn))
            except OSError:
                print(f"::warning::could not stat {fn!r}; forcing streaming", flush=True)
                return force
    return total


def bids_channels_arg(channels_local: str | None) -> str:
    """The `bids_channels` value for both biosigIO exporters: the resolved sidecar
    path, or "off".

    Never "auto" (biosigIO's default), and that is the whole point. "auto" looks
    for a SIBLING `_channels.tsv` next to the file it was handed, which is the
    wrong question twice over:

    * The file this driver hands the exporter is not the recording's own path. It
      is a scratch materialisation in `work/`, and on the ADR 0028 MaxShield path
      it is the Signal-Space-Separated copy at `work/sss_<basename>`. Sibling
      detection there finds whatever this driver happened to stage, or nothing.
    * BIDS inheritance is not siblinghood. The sidecar that applies to
      `sub-01/eeg/..._eeg.edf` may live in `sub-01/` or at the dataset root; the
      resolution that finds it is `channels_tsv_for`, which is also what the
      channel-count fidelity gate consults. The gate and the conversion must
      agree about WHICH sidecar applies, or the gate is checking a different file
      than the one that shaped the store.

    So the path is always resolved from the ORIGINAL BIDS `primary` and passed
    explicitly, and "off" says "there is no applicable sidecar" rather than
    leaving the exporter to guess. biosigio>=1.2.7 accepts the path form on
    `Recording.from_file` AND `stream_to_zarr` and acts on it (biosigio#128,
    closing #127); on 1.2.6 the streaming exporter had no such parameter and
    `from_file` accepted a path and silently ignored it, which is why the pin is
    a floor and not a preference.
    """
    return channels_local if channels_local and os.path.exists(channels_local) else "off"


def convert_recording(
    primary_local: str,
    events_local: str | None,
    store_path: str,
    power_line_frequency: float | None = None,
    value_descriptions: dict[str, str] | None = None,
    electrode_positions: dict | None = None,
    mem_budget_bytes: int | None = None,
    hard_ceiling_bytes: int | None = None,
    projected_peak: int | None = None,
    channels_local: str | None = None,
) -> None:
    modality = bids_suffix_modality(primary_local)
    size_bytes = _recording_size_bytes(primary_local)
    streaming = should_stream(primary_local, size_bytes)
    # Preflight (#909): skip -- BEFORE any load -- a recording whose projected
    # peak RAM won't fit this run's budget, so it can never OOM-crash the worker
    # and BrokenProcessPool-cascade its siblings. Raised as a typed, coded failure
    # -> a DETERMINISTIC skip surfaced in the index, not an infra retry.
    if mem_budget_bytes is not None:
        # Use the projection ADMISSION computed, not a fresh blind one. Phase 4
        # made `projected_peak_bytes` channel-aware but only updated main()'s call
        # site; recomputing here without the channel count always yielded the flat
        # STREAM_PEAK_BYTES floor for a streaming recording -- and since the
        # ceiling is itself floored at 2x that value, `peak > mem_budget` was then
        # unsatisfiable for EVERY streaming recording, making the permanent
        # `RecordingTooLarge` verdict dead code on that whole path. One number,
        # computed once, is also simply the right shape.
        peak = (
            projected_peak
            if projected_peak is not None
            else projected_peak_bytes(primary_local, size_bytes)
        )
        # Injectable so the two verdicts can be tested without reloading the module
        # (a reload rebinds the exception classes and breaks assertRaises).
        hard_ceiling = (
            hardware_ceiling_bytes() if hard_ceiling_bytes is None else hard_ceiling_bytes
        )
        # The permanent verdict requires the two ceilings to be DISTINGUISHABLE.
        # When /proc/meminfo is unreadable both fall back to the same fixed figure,
        # which makes `peak <= hard_ceiling` unsatisfiable whenever
        # `peak > mem_budget_bytes` -- so every over-budget recording would be
        # marked permanently too-large, silently defeating the whole reason #1111
        # split these verdicts apart. If we cannot tell the two apart, prefer the
        # retryable verdict: being wrong that way costs one re-attempt, the other
        # way buries a dataset forever.
        if hard_ceiling <= mem_budget_bytes:
            hard_ceiling = None
        if peak > mem_budget_bytes and (hard_ceiling is None or peak <= hard_ceiling):
            # Fits the node, just not what is free right now. A TEMPORARY
            # condition on a shared box, so it must retry rather than mark the
            # dataset terminal -- otherwise one busy hour permanently buries a
            # dataset that converts fine an hour later. #1111
            raise RecordingMemoryExceeded(
                f"projected peak ~{peak // 1024**3} GiB exceeds the "
                f"~{mem_budget_bytes // 1024**3} GiB free on the node right now "
                f"(the node itself could hold it); will retry"
            )
        if peak > mem_budget_bytes:
            raise RecordingTooLarge(
                f"projected peak ~{peak // 1024**3} GiB exceeds the "
                f"~{mem_budget_bytes // 1024**3} GiB per-recording budget for this run "
                f"(on-disk {size_bytes // 1024**3} GiB via the "
                f"{'streaming' if streaming else 'in-memory'} path"
                f"{projection_factor_hint(primary_local, streaming)}; "
                "the budget is the node's usable RAM and does NOT change with --jobs)"
            )
    def _convert_in_memory() -> None:
        from biosigio import Recording, bids  # type: ignore[import-not-found]  # lazy: runtime-only dep

        # mixed_rate="resample": a Zarr store is a derived serving copy (viewing + ML),
        # not the authoritative recording, so for a mixed-sampling-rate EDF/BDF (e.g.
        # polysomnography: EEG ~200 Hz + SpO2 ~12.5 Hz) upsample the slow channels onto
        # the fastest channel's grid rather than failing the conversion. biosigIO
        # defaults to "error" everywhere else so no one gets resampled data unknowingly
        # (requires biosigio>=1.1.4; ignored for non-EDF formats). See nemar-cli#737.
        # `bids_channels` is the resolved sidecar path or "off", never "auto" --
        # see `bids_channels_arg` for why sibling auto-detection is the wrong
        # question for a scratch materialisation. The importer applies it before
        # the suffix override below, which deliberately has the last word on
        # modality (see its comment), and records what the `units` column did in
        # `rec.metadata["channels_tsv_units"]` -> the store's `recording_metadata`
        # -> the index entry's `units_report`.
        rec = Recording.from_file(
            primary_local,
            mixed_rate="resample",
            bids_channels=bids_channels_arg(channels_local),
        )
        if events_local and os.path.exists(events_local):
            bids.apply_events_tsv(rec, events_local)
        # Suffix-driven modality: group + resample the whole recording by its BIDS
        # datatype (an _eeg file -> eeg_250hz), regardless of what the importer guessed
        # per channel. Without this, EEGLAB's empty chanlocs type -> MISC -> misc_1024hz.
        if modality:
            for label in rec.channels:
                rec.channels[label]["modality"] = modality
        rec.to_zarr(store_path, dtype="int16", modality_rates=MODALITY_RATES)

    # Large recordings use the streaming converter so peak RAM stays bounded; the
    # in-memory path would load them at float64 2-3x and OOM. (multi-GB BrainVision/
    # FIF/CTF/MEF3/4D-BTi, KIT, and EDF/BDF via
    # pyedflib on biosigio>=1.2.0 -- see should_stream.)
    if streaming:
        from biosigio import stream_to_zarr  # type: ignore[import-not-found]  # lazy
        from biosigio.bids import read_events_tsv  # type: ignore[import-not-found]  # lazy
        from biosigio.exceptions import MixedSamplingRateError  # type: ignore[import-not-found]

        events_df = (
            read_events_tsv(events_local)
            if events_local and os.path.exists(events_local)
            else None
        )
        try:
            stream_to_zarr(
                primary_local,
                store_path,
                force_modality=modality,
                modality_rates=MODALITY_RATES,
                dtype="int16",
                events_df=events_df,
                # Keep the temp channel-major memmap on the same (fast) scratch volume as
                # the store; it is a sibling temp dir, not synced to S3.
                scratch_dir=os.path.dirname(store_path) or None,
                # The same explicit sidecar the in-memory path uses, so the two
                # exporters cannot disagree about a recording's units -- the
                # disagreement that held the engine bump back until biosigio#128
                # gave `stream_to_zarr` this parameter. See `bids_channels_arg`.
                bids_channels=bids_channels_arg(channels_local),
            )
        except MixedSamplingRateError:
            # A mixed per-channel-rate EDF can't stream on a single grid; the
            # in-memory path resamples it (mixed_rate="resample"). Re-check the
            # (larger) in-memory budget before the full-load fallback so a big
            # mixed-rate EDF is #909-skipped rather than OOMing.
            if mem_budget_bytes is not None:
                inmem_peak = int(size_bytes * inmem_factor_for(primary_local))
                if inmem_peak > mem_budget_bytes and inmem_peak <= (
                    hardware_ceiling_bytes() if hard_ceiling_bytes is None
                    else hard_ceiling_bytes
                ):
                    raise RecordingMemoryExceeded(
                        f"mixed-rate EDF needs the in-memory resample path "
                        f"(projected ~{inmem_peak // 1024**3} GiB > "
                        f"~{mem_budget_bytes // 1024**3} GiB free right now); will retry"
                    )
                if inmem_peak > mem_budget_bytes:
                    raise RecordingTooLarge(
                        f"mixed-rate EDF needs the in-memory resample path "
                        f"(projected ~{inmem_peak // 1024**3} GiB > "
                        f"~{mem_budget_bytes // 1024**3} GiB budget); the budget is the node's usable RAM and does NOT change with --jobs"
                    ) from None
            _convert_in_memory()
    else:
        _convert_in_memory()
    if power_line_frequency is not None:
        embed_root_attr(store_path, "power_line_frequency", power_line_frequency)
    if value_descriptions:
        events_meta = os.path.join(store_path, "events", "zarr.json")
        if os.path.exists(events_meta):
            embed_attr(events_meta, "value_descriptions", value_descriptions)
    if electrode_positions is not None:
        embed_root_attr(store_path, "electrode_positions", electrode_positions["positions"])
        embed_root_attr(store_path, "electrode_coordinate_system", electrode_positions["coordinate_system"])
        embed_root_attr(store_path, "electrode_coordinate_units", electrode_positions["coordinate_units"])


# --- Parallel conversion ------------------------------------------------------
# Recordings are independent (distinct S3 store prefixes), so they convert in a
# ProcessPoolExecutor: each worker streams its own annex blob, converts, validates,
# and `aws s3 sync`s its store, then returns the index entry. Conversion is
# CPU-bound (resample + zstd), so processes (not threads) give real parallelism.
# The shared context (repo, bucket, head, the head file set) is pickled once per
# worker via the initializer, not once per task.

_CTX: dict = {}


def _init_worker(ctx: dict) -> None:
    _CTX.clear()
    _CTX.update(ctx)


def convert_one(primary: str, peak_bytes: int | None = None) -> dict:
    """Convert + upload one recording in a pool worker. Returns
    {"ok": True, "primary", "entry"} or {"ok": False, "primary", "error"}.
    Self-contained and picklable; reads shared inputs from the worker `_CTX`."""
    c = _CTX
    # `work`/`store_local` are bound before the try so the `finally` can always
    # reference them, even when setup itself is what failed. `rss_trusted` needs
    # the same treatment for the `except MemoryError` handler: it is assigned
    # AFTER apply_worker_mem_limit tightens RLIMIT_DATA, so on a reused worker
    # still holding the previous recording's memory the very next allocation --
    # inside reset_peak_rss's own open() -- can raise MemoryError before the name
    # exists. The handler reads it, so that path raised UnboundLocalError and
    # escaped convert_one uncoded, retrying forever: exactly the failure the
    # limit call sits inside the try to prevent (#1110). Default to untrusted,
    # which is correct anyway when the reset never ran.
    work = store_local = None
    rss_trusted = False
    try:
        # Backstop this recording before any allocation: exceeding the reservation
        # admission made for it must raise in-process, not take the node down.
        # Inside the try, so a MemoryError during SETUP is typed like any other
        # rather than escaping convert_one uncoded and retrying forever (#1110).
        apply_worker_mem_limit(peak_bytes, c.get("mem_budget"), reserved=True)
        # Reset the high-water mark so what we read at the end belongs to THIS
        # recording and not to whatever this reused worker converted before it.
        # A failed reset means the next reading is this WORKER's lifetime peak
        # across every recording it has handled, not this recording's -- an
        # inflated number that would drive false "under-projected" warnings and,
        # if believed, a pointless factor increase. Mark the sample untrusted
        # rather than blend it into calibration.
        rss_trusted = reset_peak_rss()
        if not rss_trusted and not _WARNED_NO_RESET[0]:
            _WARNED_NO_RESET[0] = True
            print(
                "::warning::cannot reset the peak-RSS mark (/proc/self/clear_refs); "
                "peak-RAM measurements are unattributable this run and are being "
                "discarded rather than reported wrong (#1111)",
                flush=True,
            )
        rel_store = store_rel_for(primary)
        work = os.path.join(c["tmp"], "work", primary.replace("/", "_"))
        store_local = os.path.join(c["tmp"], "stores", rel_store)
        os.makedirs(work, exist_ok=True)
        os.makedirs(os.path.dirname(store_local), exist_ok=True)
        if c["local"]:
            primary_local, events_local, primary_key = materialize_local(
                c["repo"], primary, c["head_files"]
            )
        else:
            primary_local, events_local, primary_key = materialize_recording(
                c["repo"], c["bucket"], c["dataset_id"], primary, c["head_files"], c["head"], work
            )
        # ADR 0028. Substituted HERE rather than inside convert_recording, which
        # derives modality, size and the streaming decision from the path it is given
        # (a late rebind would leave all three describing the unfiltered file). The
        # filtered copy lands in `work`, which the `finally` below already removes,
        # and fix_source_file_attr still rewrites source_file to the BIDS path, so the
        # scratch name never reaches the store.
        sss_meta = None
        if is_maxshield_fif(primary_local):
            pair = maxshield_calibration_for(primary, c["head_files"])
            if pair is None:
                raise MaxShieldUncalibrated(
                    "recording carries raw Internal Active Shielding data and this "
                    "dataset provides no fine-calibration / cross-talk pair for it"
                )
            cal_rel, ctc_rel = pair
            cal_local = os.path.join(work, os.path.basename(cal_rel))
            ctc_local = os.path.join(work, os.path.basename(ctc_rel))
            if c["local"]:
                cal_local = os.path.join(c["repo"], cal_rel)
                ctc_local = os.path.join(c["repo"], ctc_rel)
                # The remote branch below decides cleanly when a tracked file cannot
                # be materialised; local mode has to check for itself. A working tree
                # can hold a git-annex POINTER whose content was never fetched, and
                # `os.path.exists` is False for a dangling symlink -- so this catches
                # the realistic case rather than letting apply_sss fail uncoded and
                # retry the filter on every future run.
                missing = [r for r, p in ((cal_rel, cal_local), (ctc_rel, ctc_local))
                           if not os.path.exists(p)]
                if missing:
                    raise MaxShieldUncalibrated(
                        "calibration input(s) present in the tree but without local "
                        f"content (run `git annex get`): {', '.join(missing)}"
                    )
            else:
                for rel, dest in ((cal_rel, cal_local), (ctc_rel, ctc_local)):
                    found, _ = _fetch_blob(
                        c["repo"], c["bucket"], c["dataset_id"], rel, c["head"], dest
                    )
                    if not found:
                        # Tracked at HEAD but unfetchable. Falling through to serve
                        # the recording unfiltered is exactly what ADR 0028 forbids.
                        raise MaxShieldUncalibrated(
                            f"calibration input {rel!r} is tracked at "
                            f"{c['head'][:8]} but could not be fetched"
                        )
            filtered = os.path.join(work, "sss_" + os.path.basename(primary_local))
            sss_meta = apply_sss(primary_local, cal_local, ctc_local, filtered)
            primary_local = filtered
        plf = power_line_frequency_for(c["repo"], primary, c["head_files"], c["head"])
        descs = event_descriptions_for(c["repo"], primary, c["head_files"], c["head"])
        elec = electrode_positions_for(c["repo"], primary, c["head_files"], c["head"])
        # channels.tsv is git-tracked TEXT (never annexed), so it is read from the
        # repo and staged beside the recording rather than fetched from S3. It is
        # handed to biosigIO so the served samples carry the sidecar's units
        # (biosigio#125); the same resolution already feeds the fidelity gate.
        channels_local = None
        channels_read_failed = False
        channels_rel = channels_tsv_for(primary, c["head_files"])
        if channels_rel:
            channels_text = _read_repo_text(c["repo"], c["head"], channels_rel)
            if channels_text is None:
                # NOT the same as "this dataset ships no channels.tsv". A sidecar
                # that applies is present at HEAD and we failed to read it, so the
                # store is served with importer units and NOTHING on the public
                # surface would say why -- `units_report` is simply absent, which
                # is the same shape as a dataset that has no sidecar at all. The
                # fidelity gate makes the same distinction and warns for the same
                # reason (`expected_channel_count_for`). Recorded on the entry.
                channels_read_failed = True
                print(
                    f"::warning::could not read {channels_rel}; channels.tsv units "
                    f"are NOT applied to {primary}",
                    flush=True,
                )
            else:
                channels_local = os.path.join(work, os.path.basename(channels_rel))
                with open(channels_local, "w", encoding="utf-8") as fh:
                    fh.write(channels_text)
        convert_recording(
            primary_local, events_local, store_local, plf, descs or None, elec,
            mem_budget_bytes=c.get("mem_budget"),
            hard_ceiling_bytes=c.get("hard_ceiling"),
            projected_peak=(c.get("projections") or {}).get(primary),
            channels_local=channels_local,
        )
        # biosigIO stamped recording_metadata.source_file with the scratch path
        # it was handed (this run's tmpdir); overwrite it with the stable,
        # reproducible BIDS-repo-relative path before validating/uploading.
        # nemarOrg/nemar-cli#1102.
        fix_source_file_attr(store_local, primary)
        if sss_meta:
            # In the store as well as the index: a consumer reading the store
            # directly (the ML streaming path) must not have to fetch index.json to
            # learn that this signal is a processed derivative.
            embed_root_attr(store_local, "sss", sss_meta)
        # Structured provenance, in the store rather than only in the index
        # (#1064). The population reading these stores is increasingly machine,
        # and a client that has the store has the DOI, license and citation at the
        # moment it needs them. biosigIO's own attributes are untouched.
        embed_root_attr(
            store_local,
            "nemar",
            nemar_store_attrs(
                dataset_id=c["dataset_id"],
                source_commit=c["head"],
                source_tree=source_tree_for(primary),
                derived=bool(sss_meta),
                engine_version=c["engine_version"],
                contract_url=f"{c['contract_base'].rstrip('/')}/{c['dataset_id']}/zarr/{rel_store}/",
                row=c.get("dataset_row"),
                provenance_fetch_failed=bool(c.get("provenance_fetch_failed")),
            ),
        )
        # Guard the --delete sync: an empty/partial store would otherwise wipe a
        # previously-valid one. zarr.json => v3 root.
        validate_store(store_local)
        meta = store_metadata(store_local)
        if not meta.get("groups"):
            # store_metadata swallows its exception and returns {}, so without
            # carrying the reason here the operator sees "no channel groups" (a
            # data problem) while the real cause sits in an uncorrelated warning
            # line somewhere in a multi-megabyte log.
            why = meta.get("_error")
            raise RuntimeError(
                f"store has no channel groups: {store_local}"
                + (f" (reading it failed: {why})" if why else "")
            )
        # Fidelity gate: the BIDS channels.tsv is ground truth for how many
        # channels this recording has. A store that comes up short means the
        # importer silently dropped signals (biosigio#110 served 74-channel
        # EEGLAB recordings as 1 channel for weeks, nemarDatasets/on002718#1);
        # withhold it as a typed data failure rather than publish an unfaithful
        # copy. Runs BEFORE the sync, so on the incremental path this
        # recording's previous store survives untouched; under --clean the
        # prefix was already wiped and the recording simply stays absent (see
        # the ChannelCountMismatch docstring for why absent beats unfaithful,
        # and note a gated recording needs an explicit re-run after a fix).
        expected = expected_channel_count_for(
            c["repo"], primary, c["head_files"], c["head"]
        )
        if expected:
            total = store_total_channels(meta)
            if total < expected:
                raise ChannelCountMismatch(
                    f"store has {total} channel(s) but {primary}'s channels.tsv "
                    f"declares {expected}; refusing to publish an unfaithful copy"
                )
        # Latest-only: --delete drops stale chunk objects a smaller new store no
        # longer needs. Long origin TTL; the callback purges zarr.json/index.json.
        # Through `_aws` for the wall-clock timeout + retry: a store is thousands of
        # tiny chunk PUTs, which under contention intermittently fail ("Need to
        # rewind the stream") or wedge; sync is idempotent so a retry just re-PUTs
        # whatever is missing.
        _aws([
            "aws", "s3", "sync", store_local,
            safe_store_prefix(c["bucket"], c["dataset_id"], rel_store),
            "--delete", "--only-show-errors",
            "--cache-control", "public, max-age=86400",
        ])
        # `source_key` is deliberately NOT here any more: it moved to the sibling
        # producer manifest in v3 (#1178 item 5). It was ~90 bytes per store that
        # no consumer read -- 2.3 MB of nm000281's 12.8 MB index, fetched on every
        # dataset-page visit.
        entry = {
            "path": primary,
            "zarr": rel_store,
            "updated_utc": c["updated"],
            "source_tree": source_tree_for(primary),
            "derived": bool(sss_meta),
            # `_`-prefixed keys are diagnostics, never published.
            **{k: v for k, v in meta.items() if not k.startswith("_")},
        }
        # Counted from the SAME events.tsv biosigIO was handed, so the numbers
        # describe what is actually in the store (#1059).
        events_text = None
        if events_local and os.path.exists(events_local):
            try:
                with open(events_local, encoding="utf-8", errors="replace") as fh:
                    events_text = fh.read()
            except OSError as exc:
                print(
                    f"::warning::could not re-read {events_local} for the event "
                    f"summary of {primary}: {exc}",
                    flush=True,
                )
        # ONE parse, feeding both the per-store summary published in the index
        # and the rows `main` stages for events.parquet (#1060). The parsed rows
        # travel back with the result rather than being re-read there: the events
        # sidecar may be annexed, and this worker is the only place it is
        # materialised.
        parsed_events = parse_events_tsv(events_text)
        entry.update(events_summary_of(parsed_events))
        # Which channels.tsv shaped this store, and that the converter chose it
        # rather than the exporter stumbling on a sibling. On the MaxShield path
        # the exporter is handed `work/sss_<basename>`, where sibling detection
        # finds nothing, so "a report is present" and "the right sidecar was
        # used" are separate claims and both belong on the public surface.
        if channels_rel and isinstance(entry.get("units_report"), dict):
            entry["units_report"] = {
                **entry["units_report"],
                "sidecar": channels_rel,
                "sidecar_supplied": True,
            }
        if channels_read_failed:
            entry["channels_tsv_read_error"] = True
        # For a split FIF, record all member source paths so the browser can map any
        # split file (e.g. a click on split-02) to this single head store.
        members = split_members_for(primary, c["head_files"])
        if members:
            entry["split_members"] = members
        # ADR 0028 requires this to be DISCLOSED, not merely auditable. Every other
        # store is the source signal quantised and rate-capped and nothing more; this
        # one has been processed. A model training across datasets would otherwise
        # silently mix filtered and unfiltered MEG with no signal that it was doing
        # so. MNE writes the parameters into the recording's own proc_history, but
        # biosigIO's importer does not carry that into the store, so state it here
        # (and in the store's root attributes) rather than assume it survives.
        if sss_meta:
            entry["sss"] = sss_meta
        return {
            "ok": True,
            "primary": primary,
            "entry": entry,
            # The events.tsv this store was built from, parsed once. `main` turns
            # it into the store's events.parquet rows using the same `groups` it
            # publishes in the entry, so the rates behind `sample_index` are the
            # rates the index states.
            "events": parsed_events,
            # The producer-only half of the entry: which annex blob this store was
            # built from. Published in manifest.json, never in the index.
            "manifest": {
                "zarr": rel_store,
                "source_key": primary_key,
                "size_bytes": annex_key_size(primary_key),
            },
            "peak_rss": peak_rss_bytes() if rss_trusted else None,
        }
    except MemoryError as exc:
        # The RLIMIT_DATA backstop fired (or the allocator genuinely ran out).
        # This is the same verdict #909's preflight reaches -- this recording does
        # not fit the memory it was given -- so report it with the same code
        # rather than as a nameless infra failure that retries forever. Reporting
        # it typed also means a dataset made ENTIRELY of such recordings is marked
        # terminal instead of burning its five attempts.
        # Measure here as well: a recording that hit the backstop is the strongest
        # evidence its format is under-projected, and excluding it made the
        # calibration summary look cleanest exactly where it was most wrong.
        return memory_failure_result(
            primary, exc, peak_rss_bytes() if rss_trusted else None
        )
    except Exception as exc:  # noqa: BLE001 - isolate one bad recording
        # The backstop does not always surface as MemoryError: see
        # `is_memory_exhaustion`. Same verdict, same code, same measurement.
        if is_memory_exhaustion(exc):
            return memory_failure_result(
                primary, exc, peak_rss_bytes() if rss_trusted else None
            )
        # biosigIO read failures carry a stable `.code` (not_continuous,
        # corrupt_or_truncated, ...) so the index can tell the viewer WHY a
        # recording has no store. Infra failures (a plain RuntimeError, a crashed
        # worker) have no code -> not surfaced, they retry on the next run.
        #
        # Print the traceback for the uncoded ones before it is lost. This runs in
        # a ProcessPoolExecutor worker, so once the exception is reduced to
        # `str(exc)` for the return value the stack is gone for good, and a NOVEL
        # bug surfaces on an unattended cron as a bare "list index out of range"
        # with no file or line. That is the same undiagnosable shape that left the
        # MaxShield cause unexplained across 396 recordings. Coded failures are
        # already self-explaining and stay quiet, or every derivative in the
        # archive would print a stack.
        if getattr(exc, "code", None) is None:
            import traceback

            print(
                f"::warning::{primary!r} failed with an uncoded error; traceback follows "
                f"so the cause is not reduced to one line:\n{traceback.format_exc()}",
                flush=True,
            )
        return {
            "ok": False,
            "primary": primary,
            "error": str(exc),
            "code": getattr(exc, "code", None),
            # Published on the entry (typed) or as `last_error` (pending), which
            # is the only way an uncoded failure says anything at all from
            # outside the conversion node. #1197
            "detail": failure_detail(exc),
        }
    finally:
        # Parallel workers share the NVMe scratch; reclaim each recording's copy
        # right after upload so N concurrent stores don't accumulate on disk.
        for d in (store_local, work):
            if d:
                shutil.rmtree(d, ignore_errors=True)


def _next_admission(
    pending_peaks: list[int], in_flight_count: int, running_peak: int,
    cpu_cap: int, ram_ceiling: int,
) -> int | None:
    """Index into ``pending_peaks`` of the next recording to dispatch, or ``None``
    to wait for a running one to finish. Admittable when a worker slot is free AND
    either nothing is in flight (it runs alone, guaranteeing progress) or it fits
    the remaining RAM ceiling. Picks the first pending recording that fits, so a
    head-of-line giant doesn't starve smaller ones behind it."""
    if in_flight_count >= cpu_cap:
        return None
    idle = in_flight_count == 0
    return next(
        (j for j, pk in enumerate(pending_peaks)
         if idle or running_peak + pk <= ram_ceiling),
        None,
    )


def _drain_with_admission(
    convert, peaks, cpu_cap, ram_ceiling, ctx, record, worker=None
) -> tuple[int, int]:
    """Run ``convert_one`` over ``convert`` in a pool of up to ``cpu_cap`` workers,
    dispatching a recording only while the SUM of in-flight projected peaks stays
    within ``ram_ceiling`` (see ``_next_admission``). Results are reported via
    ``record(r, i)`` in completion order.

    A worker that dies (OOM kill, segfault) poisons the whole
    ``ProcessPoolExecutor``: every subsequent ``submit`` raises
    ``BrokenProcessPool``, so before #1110 one kill aborted the run and abandoned
    everything still queued -- on004998 converted 74 of 115 and lost the
    remaining 41, none of which had anything to do with the memory pressure, and
    the log carries 96 such aborts.

    Recovery is two-pass, because when a pool breaks you cannot tell WHICH of the
    in-flight recordings killed it:

    1. Parallel pass over the queue. On a break, the in-flight recordings are set
       aside as suspects and the executor is rebuilt to drain the rest.
    2. Serial pass over the suspects, one worker. A recording that dies here was
       running alone, so it is provably the culprit and only it is reported
       failed; every innocent suspect converts normally.

    Retrying suspects in PARALLEL instead would be wrong: the culprit kills the
    pool again, and an innocent recording that happened to be in flight for both
    breaks gets blamed. That is not hypothetical -- the tests caught exactly it.
    """
    worker = worker or convert_one
    done = 0
    pool_breaks = 0

    def report(r: dict) -> None:
        nonlocal done
        done += 1
        record(r, done)

    def drain_once(queue: list, cap: int) -> list:
        """Drain ``queue`` (mutated in place) with up to ``cap`` workers until it
        is empty or the pool breaks. Returns the recordings that were in flight
        at the moment of the break -- empty when the pass completed cleanly."""
        nonlocal pool_breaks
        in_flight: dict = {}
        running_peak = 0
        # One pass observes at most one pool death, but it can surface twice (a
        # future resolving with BrokenProcessPool, and again from `submit`). Latch
        # it so the count is events, not observations -- `max(pool_breaks, 1)`
        # previously absorbed a genuine SECOND break in a later pass.
        broke = False
        # Recordings whose future resolved with the pool's death rather than a
        # fault of their own. They are suspects, not failures: when a pool dies
        # EVERY outstanding future raises BrokenProcessPool, so reporting them
        # here would blame each in-flight sibling for the one crash.
        broken: list = []

        def admit() -> None:
            nonlocal running_peak
            while queue:
                idx = _next_admission(
                    [peaks[p] for p in queue], len(in_flight), running_peak,
                    cap, ram_ceiling,
                )
                if idx is None:
                    break
                # Submit BEFORE popping. `ex.submit` is exactly where a broken
                # pool surfaces, and popping first would leave the recording in
                # neither the queue nor in_flight -- silently dropped, which is
                # the very failure this recovery exists to prevent.
                p = queue[idx]
                fut = ex.submit(worker, p, peaks[p])
                queue.pop(idx)
                in_flight[fut] = (p, peaks[p])
                running_peak += peaks[p]

        try:
            with ProcessPoolExecutor(
                max_workers=cap, initializer=_init_worker, initargs=(ctx,)
            ) as ex:
                admit()
                while in_flight:
                    finished, _ = wait(list(in_flight), return_when=FIRST_COMPLETED)
                    for fut in finished:
                        p, peak = in_flight.pop(fut)
                        running_peak -= peak
                        try:
                            r = fut.result()
                        except BrokenProcessPool:
                            broken.append(p)
                            continue
                        except Exception as exc:  # noqa: BLE001 - this worker died
                            r = {
                                "ok": False,
                                "primary": p,
                                "error": f"worker crashed: {exc}",
                                "detail": failure_detail(exc),
                            }
                        report(r)
                    admit()
        except BrokenProcessPool:
            broke = True
        if broke or broken:
            pool_breaks += 1
        return broken + [p for p, _peak in in_flight.values()]

    pending = list(convert)
    suspects: list = []
    # How many recordings the parallel pass ever had to set aside at once. Tests
    # need this to tell "a sibling really was caught in the crossfire" from "only
    # the culprit was in flight" -- `pool_breaks` cannot, because the serial
    # confirmation pass always breaks too, pinning it at 2 either way.
    max_suspects_at_once = 0
    while pending:
        batch = drain_once(pending, cpu_cap)
        max_suspects_at_once = max(max_suspects_at_once, len(batch))
        suspects.extend(batch)

    if suspects:
        print(
            f"::warning::worker pool broke; re-running {len(suspects)} in-flight "
            "recording(s) one at a time to find the culprit",
            flush=True,
        )
    while suspects:
        culprits = drain_once(suspects, 1)
        # cap=1, so at most one recording was in flight: it died running alone.
        for p in culprits:
            killed = ("killed its worker process while running alone "
                      "(out of memory, or a native crash in the reader)")
            report({
                "ok": False,
                "primary": p,
                "error": killed,
                "detail": failure_detail(killed),
            })

    if pool_breaks:
        # ::warning:: not [zarr]: on the cron this lands in a multi-megabyte plain
        # log with no annotation parsing, so chronic node pressure needs to look
        # different from routine progress. It is also reported in the callback.
        print(
            f"::warning::recovered from {pool_breaks} worker-pool break(s); the run "
            "continued instead of abandoning its queue, but a worker being killed "
            "means the node is under memory pressure (#1110)",
            flush=True,
        )
    return pool_breaks, max_suspects_at_once


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate NEMAR Zarr serving copies")
    ap.add_argument("--dataset-id", required=True)
    ap.add_argument("--repo-dir", required=True, help="cloned dataset repo (full history)")
    ap.add_argument("--bucket", default="nemar")
    ap.add_argument("--region", default="us-east-2")
    ap.add_argument("--full", action="store_true", help="convert every recording")
    ap.add_argument(
        "--clean",
        action="store_true",
        help="full-rebuild every recording and rewrite the index fresh (no merge). "
        "Each store is uploaded with `aws s3 sync --delete`, so its contents are "
        "reconciled exactly; stores for recordings no longer at HEAD are removed "
        "afterwards. Does NOT erase the serving prefix up front -- see --wipe. "
        "Implies --full.",
    )
    ap.add_argument(
        "--wipe",
        action="store_true",
        help="erase s3://<bucket>/<id>/zarr/ before rebuilding. Recovery only (a "
        "corrupt prefix, or an index that no longer describes what is on S3): it "
        "destroys the serving copy before the replacement exists, so the dataset "
        "has no viewer for the length of the run. Use with --clean.",
    )
    ap.add_argument(
        "--local",
        action="store_true",
        help="read recordings from the local working tree (annex content present, "
        "e.g. on Hallu after `nemar dataset download`) instead of downloading the "
        "annex blobs from S3",
    )
    ap.add_argument(
        "--contract-base",
        default=DEFAULT_CONTRACT_BASE,
        help="the STABLE base URL clients may hardcode, published as the index's "
        "`contract_base` (<base>/<id>/zarr/) and as each store's `contract_url`. "
        f"Default {DEFAULT_CONTRACT_BASE}; the --test Hallu instance passes its own "
        "host so a test index never advertises the production one.",
    )
    ap.add_argument(
        "--api-base",
        default=DEFAULT_API_BASE,
        help="catalog to read this dataset's DOI / license / HED version from, "
        "once per run, for the stores' structured `nemar` provenance attribute "
        f"(#1064). Default {DEFAULT_API_BASE}. Best-effort: an unreachable catalog "
        "warns and leaves those fields null.",
    )
    ap.add_argument("--callback-out", required=True, help="write the zarr-ready body here")
    ap.add_argument(
        "--jobs",
        type=int,
        default=1,
        help="convert this many recordings in parallel (ProcessPoolExecutor). "
        "Default 1 (serial). The Hallu cron raises it; cap to keep N concurrent "
        "multi-GB recordings within local scratch + RAM.",
    )
    args = ap.parse_args()

    dataset_id = args.dataset_id
    bucket = args.bucket
    repo = args.repo_dir
    head = _run(["git", "-C", repo, "rev-parse", "HEAD"]).strip()
    updated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # --clean rebuilds every recording from scratch: no diff, and the index is
    # rewritten fresh (no carry-forward of stale entries) rather than merged.
    # The prior index is still READ -- purely to find orphaned stores below, not
    # to seed the merge or the diff.
    #
    # Read ONCE, with the ETag, whichever branch wants the document: that ETag is
    # what the publish below writes back under `--if-match`, so it has to belong
    # to the exact body this run merged from. `--clean` needs it too -- the merge
    # is handed `prior=None`, but the OBJECT still exists on S3, and a
    # `--if-none-match "*"` write derived from "the merge had no prior" would 412
    # on every clean run.
    live_index, live_index_etag = read_index_with_etag(bucket, dataset_id)
    prior_for_orphans: dict | None = None
    if args.clean:
        prior, prior_commit, full = None, None, True
        prior_for_orphans = live_index
    else:
        prior = live_index
        prior_commit = (prior or {}).get("source_commit")
        full = args.full or not prior_commit or not is_ancestor(repo, prior_commit, head)
    # The producer manifest tracks exactly the index's store set, so it is merged
    # on the same terms: carried on the incremental path, rebuilt from this run
    # under --clean (which reconverts every recording anyway).
    prior_manifest = (
        None if args.clean else s3_read_json(bucket, f"{dataset_id}/zarr/manifest.json")
    )

    head_files = git_ls_files(repo, head)
    if full:
        diff: list[tuple[str, str]] = []
    else:
        assert prior_commit  # full is False only when prior_commit is a real ancestor SHA
        diff = git_diff_name_status(repo, prior_commit, head)
    convert, remove = compute_worklist(head_files, diff, full)
    # Coverage denominator: every raw recording at HEAD, whether or not this run
    # touches it. Publishing it is what lets a consumer check completeness without
    # cloning the repo (#1197).
    discovered = discover_primaries(head_files)
    # `pending` attempt counts are a property of the RECORDING's history, not of
    # this run, so they are carried even under --clean -- which otherwise rebuilds
    # the index from nothing. Without this a recording would reset to attempt 1
    # every run on the Hallu path (which always passes --clean) and could never
    # reach the exhaustion cap.
    # The prior index as PUBLISHED, whichever branch read it. `--clean` passes
    # `prior=None` to the merge (the index is rewritten fresh) but still reads the
    # document for orphan detection, and two facts have to come from what was
    # actually published rather than from what the merge is given: the pending
    # attempt counts, and how many non-raw stores this run removes from the index.
    prior_index_doc = prior if prior is not None else prior_for_orphans
    prior_pending = (prior_index_doc or {}).get("pending")
    dropped_non_raw_paths = non_raw_store_paths(prior_index_doc)
    non_raw_dropped = len(dropped_non_raw_paths)
    if dropped_non_raw_paths:
        # Named individually, at most a handful of lines for the datasets that
        # have them, because "the index lost 92 stores" needs a cause attached
        # when the alternative reading is an orphan-detection bug (#1095/#1097;
        # the deletion itself is purge_non_raw_stores.py's job, not this run's).
        print(
            f"[zarr] {non_raw_dropped} non-raw store(s) from the prior index will "
            "not be republished (ADR 0027 raw-only; see purge_non_raw_stores.py):",
            flush=True,
        )
        for path in dropped_non_raw_paths:
            print(f"[zarr]   - {path} ({excluded_reason(path)})", flush=True)

    # --clean no longer wipes the serving prefix up front.
    #
    # It used to, and that dominated the run: nm000338 (a v1.0.1 -> v1.0.2 bump)
    # spent ~45 min deleting ~620k objects at 13.8k/min before converting a single
    # recording, with 30 of 32 cores idle -- then re-uploaded almost exactly what
    # it had just deleted. The wipe was never what made the copy exact: each store
    # is uploaded with `aws s3 sync --delete`, which already reconciles that
    # store's contents precisely (stale chunks, renamed groups, a shortened
    # recording). The ONLY thing the wipe added was dropping stores for recordings
    # that no longer exist at HEAD.
    #
    # So compute exactly those, and hand them to the `remove` path that the
    # incremental branch already uses -- which deletes per store, AFTER a
    # successful conversion, instead of pre-emptively destroying a good serving
    # copy. A recording that is still at HEAD but fails to convert is in `convert`,
    # never an orphan, so it keeps its previous store (ADR 0005: partial data
    # still serves) instead of being deleted by a wipe that ran before we knew.
    #
    # `--wipe` keeps the old behaviour for recovery (a corrupt prefix, an index
    # that no longer describes what is on S3).
    if args.clean:
        # `compute_clean_orphans` also protects already-published stores under
        # an excluded tree (derivatives/sourcedata/code) from this removal: a
        # raw-only `convert` no longer contains them, but that must not be
        # misread as "gone from HEAD" -- see its docstring.
        orphans = compute_clean_orphans(prior_for_orphans, convert)
        if orphans:
            print(
                f"[zarr] --clean: {len(orphans)} store(s) no longer at HEAD; "
                "removing those, keeping the rest in place",
                flush=True,
            )
        # Stays a sorted LIST: `remove` is JSON-serialized into the callback and
        # the index, and a set would blow up json.dump.
        remove = sorted(set(remove) | orphans)
    if args.wipe and convert:
        prefix = f"{dataset_id}/zarr/"
        if _s3_prefix_empty(bucket, prefix):
            print(f"[zarr] --wipe: s3://{bucket}/{prefix} already empty; skipping wipe", flush=True)
        else:
            print(f"[zarr] --wipe: erasing s3://{bucket}/{prefix} before full rebuild", flush=True)
            _rm_recursive(f"s3://{bucket}/{prefix}")
    print(
        f"[zarr] {dataset_id} head={head[:8]} prior={(prior_commit or 'none')[:8]} "
        f"full={full} convert={len(convert)} remove={len(remove)}",
        flush=True,
    )

    head_set = set(head_files)
    converted_entries: list[dict] = []
    manifest_entries: list[dict] = []
    failures: list[str] = []
    failure_entries: list[FailureEntry] = []
    # NOT PendingEntry: these are the merge's INPUT, carrying only what this run
    # observed (path, reason, last_error, last_attempt_utc). `merge_index` is
    # what derives `zarr` and the attempt count and produces the published
    # entries -- see `_pending_entry`.
    pending_entries: list[dict] = []
    # Event rows go to disk as each recording finishes, never into a list that
    # grows with the dataset: nm000281 is ~25k stores (#1060).
    events_staging = EventsStaging()
    # Every store this run rebuilt, whether or not it produced event rows. This
    # -- not the set of stores WITH rows -- is what "carried over from the prior
    # events file" is defined against.
    reconverted_rels: set[str] = set()
    # Stores whose events could not be turned into usable rows: no channel
    # groups to attach them to, or no usable sample index on any row. Counted
    # for the callback so the condition is visible off-node.
    events_stores_without_rows = 0

    n = len(convert)

    def record(r: dict, i: int) -> None:
        nonlocal events_stores_without_rows
        # Log each recording as it finishes (live progress over a long backfill),
        # not all at once at the end.
        # Under-projection is the defect that caused the 2026-08-22 OOMs, and it is
        # invisible until the node dies. Say so per recording, while the path that
        # caused it is still on screen.
        warning = note_measurement(r, projections, measured)
        if warning:
            print(warning, flush=True)
        elif r["ok"] and r.get("peak_rss") is None and not _WARNED_NO_RSS[0]:
            _WARNED_NO_RSS[0] = True
            print(
                "::warning::peak RAM could not be measured; this run contributes "
                "nothing to calibration and `calibration` will be empty for reasons "
                "unrelated to what converted (#1111)",
                flush=True,
            )
        if r["ok"]:
            converted_entries.append(r["entry"])
            if r.get("manifest"):
                manifest_entries.append(r["manifest"])
            # Staged here rather than in the worker so the rows are built from the
            # entry's OWN groups -- the same rates the index publishes are the
            # rates `sample_index` is computed against.
            rel_store = r["entry"]["zarr"]
            reconverted_rels.add(rel_store)
            parsed = r.get("events")
            rows = event_rows_for_store(
                rel_store, r["primary"], r["entry"].get("groups"), parsed
            )
            if rows:
                events_staging.add(rel_store, rows)
            alert = events_row_alert(r["primary"], parsed, rows)
            if alert:
                events_stores_without_rows += 1
                print(alert, flush=True)
            print(f"[zarr] [{i}/{n}] converted {r['primary']} -> {r['entry']['zarr']}", flush=True)
        else:
            failures.append(r["primary"])
            # Two destinations, and which one is the whole of #1197.
            #
            # A typed, non-retryable biosigIO/NEMAR failure is a property of the
            # DATA (or a converter gap): it goes to `failures` with the code, the
            # user-facing reason, AND the importer's own first line as `detail`,
            # so an opaque `file_read_error` is diagnosable from the public index.
            #
            # Everything else -- an uncoded failure (crashed worker, transient S3)
            # or a RETRYABLE code (the memory budget, which is a condition on a
            # shared node, not a property of the recording) -- goes to `pending`.
            # These used to be dropped on the floor so they would "retry next
            # run", but a run where anything converted is marked `done`, so they
            # never did: on008083 lost five recordings that appeared in neither
            # list and were indistinguishable from "still generating" forever.
            code = r.get("code")
            detail = r.get("detail") or failure_detail(r.get("error"))
            if code and code not in RETRYABLE_CODES:
                failure_entries.append(_failure_entry(r["primary"], code, detail))
            else:
                pending_entries.append({
                    "path": r["primary"],
                    "reason": "memory_budget" if code else "infra_failure",
                    "last_error": detail,
                    "last_attempt_utc": updated,
                })
            print(f"::warning::[{i}/{n}] conversion failed for {r['primary']}: {r['error']}", flush=True)

    cpu_cap = max(1, args.jobs)
    ram_ceiling = per_recording_ceiling_bytes()
    # RAM-admission control: workers are sized to CPU (cpu_cap), but a recording is
    # dispatched only while the SUM of in-flight projected peaks stays within the
    # node's usable RAM. Small (EEG) recordings pack many-wide -> cores stay busy;
    # large (MEG) ones self-limit concurrency -> no OOM; and a recording is
    # #909-skipped only when it can't fit the node even alone (independent of jobs).
    # Peaks are projected from git-annex pointers (no download) so the estimate is
    # cheap and matches the worker's preflight.
    # Charge admission what each worker is PERMITTED (projection * slack), not the
    # bare projection -- otherwise the in-flight sum is bounded while the memory
    # those workers may actually take is not. See `admission_reserve_bytes`.
    sizes = {p: recording_size_from_pointers(repo, p, head_set, head) for p in convert}
    # channels.tsv is already the fidelity gate's ground truth; reuse it so the
    # streaming projection can account for its per-channel term (see
    # `streaming_peak_bytes`). Best-effort: an unreadable sidecar falls back to
    # the flat bound rather than failing the run.
    channel_counts: dict[str, int | None] = {}
    for p in convert:
        try:
            channel_counts[p] = expected_channel_count_for(repo, p, head_set, head)
        except Exception:  # noqa: BLE001 - a projection input must not fail a run
            channel_counts[p] = None
    # Whether a recording will need the Signal-Space Separation phase cannot be known
    # here: that is `info["maxshield"]` inside the FIF, and admission deliberately
    # projects from git-annex pointers WITHOUT downloading. The BIDS sidecar carries
    # no MaxShield marker either. So use the one signal that IS available from
    # `head_files` alone -- a resolvable fine-calibration / cross-talk pair -- and let
    # the worker do the real detection. A dataset that ships the pair for a FIF that
    # turns out not to be MaxShield is merely over-reserved for, which costs
    # concurrency; under-reserving costs the node.
    maxshield_hint = {
        p: lower_ext(p) == ".fif" and maxshield_calibration_for(p, head_set) is not None
        for p in convert
    }
    projections = {
        p: projected_peak_bytes(
            p, sizes[p], channel_counts.get(p), maxshield=maxshield_hint[p]
        )
        for p in convert
    }
    # Which path each recording will take. Computed once and reused: admission
    # needs it to skip MEM_LIMIT_SLACK for streamed recordings, and the calibration
    # summary needs it to bucket them apart from in-memory ones.
    streamed_paths = {p for p in convert if should_stream(p, sizes[p])}
    peaks = {
        p: admission_reserve_bytes(proj, ram_ceiling, streamed=p in streamed_paths)
        for p, proj in projections.items()
    }
    # Measured peak RSS per recording, so the factors above stop being guesses.
    measured: dict[str, int] = {}
    # Every tunable here is env-overridable, and ADR 0030 expects one such
    # override (ZARR_STREAM_MIN_BYTES, applied to the crontab as an emergency
    # mitigation) to be REMOVED once this ships. Nothing would otherwise tell
    # anyone if a stale override diverged from the coded default later -- a future
    # retune driven by calibration data would silently no-op on the node. Print
    # what is actually in force.
    overrides = sorted(k for k in os.environ if k.startswith("ZARR_"))
    if overrides:
        print(
            "[zarr] active env overrides: "
            + ", ".join(f"{k}={os.environ[k]}" for k in overrides),
            flush=True,
        )

    # Admission is RAM-only. Each streaming recording also writes a scratch memmap
    # of `n_channels * n_samples * 4` bytes, and raising concurrency raises the
    # CONCURRENT scratch peak proportionally -- the per-recording cleanup in
    # convert_one's `finally` bounds accumulation over a run, not the peak at one
    # instant. There is no disk admission control; report the headroom so a
    # shortage is visible before it becomes a mid-run write failure. #1112
    try:
        scratch_root = tempfile.gettempdir()
        scratch_free = shutil.disk_usage(scratch_root).free
        print(
            f"[zarr] scratch free: {scratch_free / 1024**3:.0f} GiB at {scratch_root} "
            "(not admission-controlled; streaming writes a per-recording memmap)",
            flush=True,
        )
    except OSError as exc:  # visibility only; never fail a run over a stat
        print(f"::warning::could not stat scratch: {exc}", flush=True)

    print(
        f"[zarr] admission: up to {cpu_cap} worker(s), RAM ceiling "
        f"~{ram_ceiling // 1024**3} GiB; a recording projected above it alone is "
        f"skipped (#909)",
        flush=True,
    )
    # Per-dataset provenance for the stores' `nemar` root attribute (#1064).
    # Skipped when there is nothing to convert, so a no-op run makes no request.
    dataset_row, provenance_fetch_failed = (
        fetch_dataset_row(args.api_base, dataset_id) if convert else (None, False)
    )
    with tempfile.TemporaryDirectory() as tmp:
        ctx = {
            "repo": repo, "bucket": bucket, "dataset_id": dataset_id, "head": head,
            "head_files": head_set, "local": args.local, "tmp": tmp, "updated": updated,
            "contract_base": args.contract_base,
            "engine_version": ZARR_ENGINE_VERSION,
            # Read ONCE per run, not per recording: nm000281 has 25k of them.
            "dataset_row": dataset_row,
            "provenance_fetch_failed": provenance_fetch_failed,
            "mem_budget": ram_ceiling,
            # Computed once here rather than re-derived per worker from a second,
            # independent /proc/meminfo read, which could disagree with this one.
            "hard_ceiling": hardware_ceiling_bytes(),
            "projections": projections,
        }
        pool_breaks = 0
        if cpu_cap == 1 or n <= 1:
            _init_worker(ctx)
            for i, p in enumerate(convert, 1):
                record(convert_one(p, peaks[p]), i)
        else:
            pool_breaks, _max_suspects = _drain_with_admission(
                convert, peaks, cpu_cap, ram_ceiling, ctx, record
            )

    calibration = calibration_summary(measured, projections, streamed_paths)
    if calibration:
        worst = calibration[0]
        print(
            f"[zarr] peak RAM measured for {len(measured)}/{len(convert)} recording(s); "
            f"worst {worst['ext']} at {worst['max_ratio']}x its projection "
            f"(peak {worst['max_peak_bytes'] / 1024**3:.1f} GiB)",
            flush=True,
        )
    elif convert:
        print(
            f"[zarr] peak RAM measured for 0/{len(convert)} recording(s); "
            "calibration is empty because nothing could be measured, not because "
            "nothing converted (#1111)",
            flush=True,
        )

    for rel_store in remove:
        _rm_recursive(safe_store_prefix(bucket, dataset_id, rel_store))
        print(f"[zarr] removed store {rel_store}", flush=True)

    # `deterministic` = every failure is a typed DATA failure (biosigIO carries a
    # `.code`); none are infra (crashed worker / transient S3). The driver uses
    # this to mark a total failure terminal (`data_failed`, no retry) vs infra
    # (bounded retry) — and the backend records it for the failures dashboard.
    # See nemarOrg/nemar-cli#774.
    infra_failures = count_infra_failures(failures, failure_entries)
    # Recordings that failed for a reason that is NOT a property of the data. On a
    # run where anything converted, `main` returns 0 and the driver marks the
    # dataset `done`, so these are not retried by the queue on their own -- say so
    # loudly rather than let the index carry a failure nobody revisits. #1113
    retryable_failures = infra_failures
    deterministic = bool(failures) and infra_failures == 0

    # Set by the events.parquet step below. Bound HERE, before
    # `write_failed_callback` closes over them, because the total-failure exit
    # calls that callback before the events step has run -- and a name that only
    # exists on the happy path would raise NameError inside the very handler
    # whose job is to make a failure visible.
    events_file: ManifestFileEntry | None = None
    events_upload_failed = False

    def write_failed_callback(error: str | None = None) -> None:
        """Write the `status: "failed"` callback body for a run that publishes
        nothing.

        Every exit that returns 1 goes through here, and that is the point. The
        driver POSTs whatever this file contains; if a failure path writes NO
        file, `hallu-zarr.sh` posts nothing, the `converting` signal it sent at
        the start is never superseded, and D1 sits at `zarr_status='pending'`
        forever -- the dataset reads as "still converting" on the dashboard with
        nothing running. That is exactly the invisible-failure shape #774 fixed
        for the total-failure branch, and the two refuse-to-publish guards below
        (a bad index, a bad manifest) reintroduced it: they were added later and
        returned 1 directly.
        """
        with open(args.callback_out, "w") as fh:
            json.dump(
                {
                    "dataset_id": dataset_id,
                    "status": "failed",
                    "store_count": int((prior or {}).get("store_count", 0) or 0),
                    "commit": head,
                    "converted": [],
                    "removed": [],
                    "errors": len(failures),
                    "failed": failures,
                    "failure_count": len(failure_entries),
                    "data_failures": failure_entries,
                    "deterministic": deterministic,
                    "pool_breaks": pool_breaks,
                    # Coverage (#1197). Reported even here, where the index was
                    # NOT rewritten: the queue's pending-driven requeue needs to
                    # know a total failure left recordings outstanding, and
                    # `discovered_count` is what makes "2 of 43" sayable at all.
                    "pending_count": len(pending_entries),
                    "discovered_count": len(discovered),
                    "not_attempted_count": sum(
                        1 for e in pending_entries if e.get("reason") == "not_attempted"
                    ),
                    "provenance_fetch_failed": provenance_fetch_failed,
                    # The events file, on the failure path too (#1060). A refused
                    # index can still have been preceded by a successful
                    # events.parquet upload, and an operator reading only the
                    # callback would otherwise have no idea an object on S3 was
                    # replaced by a run that then published nothing.
                    "events_row_count": events_file["row_count"] if events_file else None,
                    "events_upload_failed": events_upload_failed,
                    "events_stores_without_rows": events_stores_without_rows,
                    # What went wrong, when it was the PRODUCER rather than the
                    # recordings: a schema violation or an unbalanced index has no
                    # per-recording failure to point at, so without this the
                    # callback would say "failed" and name no cause.
                    **({"error": error} if error else {}),
                },
                fh,
            )

    # Hard fail: every attempted conversion errored and nothing was removed. Do
    # NOT advance the checkpoint or rewrite the index (that would strand the
    # failed recordings); return non-zero. Still write the callback (status
    # "failed") so the driver can classify data-vs-infra and the backend records
    # WHAT failed even on a total failure (#774 — previously no callback was
    # written here, so total failures were invisible).
    if convert and not converted_entries and not remove:
        print(f"::error::all {len(convert)} conversion(s) failed; index left untouched", flush=True)
        write_failed_callback()
        return 1

    # Advance source_commit to HEAD unless there are INFRA failures to retry. A
    # typed data failure (a derivative, a corrupt file) is permanent -- retrying it
    # never helps and would pin the checkpoint forever on a derivative-heavy
    # dataset -- so it does not hold the commit back; it's recorded in the index's
    # `failures` instead. An infra failure keeps the prior commit so the next run
    # re-diffs and retries it.
    # (`infra_failures` / `deterministic` computed above, before the total-fail path.)
    #
    # The old fallback for "infra failures but no usable prior commit" was `""`,
    # which is how on008083 came to publish an EMPTY source_commit while D1 held
    # the real SHA (#1197). There is no longer anything to fall back FOR: those
    # recordings are now listed in `pending`, and the queue re-queues a `done`
    # dataset that has any (zarr_queue.reconcile), which re-runs it with --clean.
    # So publish the commit the stores were actually built from.
    # The trailing `and prior_commit` in the condition is not redundant with
    # `is_commit_sha`: that call narrows the value at runtime but not for a
    # reader or a type checker, so the extra term is what makes the ternary's
    # first branch visibly a `str` rather than `str | None`. `head_commit` is
    # published as the index's `source_commit`, where None would serialize as
    # JSON null -- the on008083 shape (#1197) that took an empty commit all the
    # way into a published document.
    index_commit = (
        prior_commit if (infra_failures and is_commit_sha(prior_commit) and prior_commit) else head
    )
    biosigio_version = installed_biosigio_version()

    def build_index(merge_prior: dict | None, merge_pending: list | None) -> dict:
        """Merge this run's results onto a prior document and check the coverage
        invariant. A function rather than a straight line because the publish
        below re-runs it against a NEWER live document when the conditional write
        loses a race -- re-merging is the only way to keep both writers' work.
        """
        merged = merge_index(
            merge_prior,
            dataset_id,
            index_commit,
            converted_entries,
            remove,
            updated,
            failure_entries,
            pending_entries,
            discovered=discovered,
            errors=len(failures),
            contract_base=args.contract_base,
            bucket=bucket,
            region=args.region,
            biosigio_version=biosigio_version,
            prior_pending=merge_pending,
            dataset_row=dataset_row,
        )
        check_index_invariant(merged)
        return merged

    try:
        index = build_index(prior, prior_pending)
        # SCHEMA FIRST, UPLOADS SECOND. A refused index means this run publishes
        # nothing -- and "nothing" has to include events.parquet, which is a
        # destructive overwrite of a file the LIVE index still describes. So the
        # document is validated here, before anything is uploaded, in the exact
        # shape it will take: the events pair is filled in with the values this
        # run would use (the URL is deterministic; the row count is a
        # placeholder, and `minimum: 0` makes 0 the strictest stand-in). A bug in
        # either field therefore aborts BEFORE the overwrite rather than after
        # it.
        events_url = f"{index['data_base']}{EVENTS_PARQUET_NAME}"
        validate_document(
            {**index, "events_parquet": events_url, "events_row_count": 0},
            INDEX_SCHEMA_PATH,
            "index",
        )
        # events.parquet then goes up BEFORE index.json, so `events_parquet`
        # never names a file that is not there. It is best-effort and cannot fail
        # the run; when it does not publish, the two fields stay absent and a
        # client reads that as "this dataset has no events file", which is
        # exactly what is true of the new index.
        published_events = publish_events_parquet(
            events_staging,
            [e["zarr"] for e in index["stores"]],
            bucket=bucket,
            dataset_id=dataset_id,
            reconverted=reconverted_rels,
        )
        events_file = published_events["file"]
        events_upload_failed = published_events["failed"]
        if events_file:
            index["events_parquet"] = events_url
            index["events_row_count"] = events_file["row_count"]
        # Validate what is about to be published, not a copy of it. The pre-flight
        # above checked the same document with a stand-in row count; this checks
        # the real one, so nothing reaches S3 unvalidated.
        validate_document(index, INDEX_SCHEMA_PATH, "index")
    except Exception as exc:  # noqa: BLE001 - refuse to publish a bad index
        print(
            f"::error::refusing to publish {dataset_id}/zarr/index.json: {exc}",
            flush=True,
        )
        write_failed_callback(f"index refused: {exc}")
        return 1

    def build_manifest(index_doc: dict) -> dict:
        """The producer manifest tracks EXACTLY the index's store set, so it is
        derived from the document that is actually published -- including the
        re-merged one a conditional-write retry produces, whose store list can
        differ from the first attempt's. Validated here so a bad manifest still
        refuses the publish rather than being uploaded.
        """
        doc = merge_manifest(
            prior_manifest,
            dataset_id,
            manifest_entries,
            [e["zarr"] for e in index_doc["stores"]],
            updated,
            events_file=events_file,
        )
        validate_document(doc, MANIFEST_SCHEMA_PATH, "manifest")
        return doc

    try:
        manifest = build_manifest(index)
    except Exception as exc:  # noqa: BLE001 - refuse to publish a bad manifest
        print(
            f"::error::refusing to publish {dataset_id}/zarr/manifest.json: {exc}",
            flush=True,
        )
        write_failed_callback(f"manifest refused: {exc}")
        return 1

    # The index publish is a CONDITIONAL write, and its own temp-file handling
    # lives in `write_index` (shared with purge_non_raw_stores.py).
    #
    # It used to be an unconditional `aws_cp` followed by a `head-object` for the
    # ETag. Two processes write this object -- a converter run and the non-raw
    # purge -- and both read it, work for minutes to hours, then write back what
    # they merged from that read. Whichever finished second silently reverted the
    # other: a purge that had just deleted 92 non-raw stores would be undone, or a
    # conversion's newly added stores would vanish from the document while their
    # chunks sat on S3 unreferenced. Nothing anywhere reported it -- both runs
    # exited 0 and both callbacks said "ready".
    #
    # So the PUT carries `--if-match` with the ETag read at the top of this run
    # (or `--if-none-match "*"` when there was no document then). A 412 means the
    # premise changed, and it is recoverable exactly once: re-read, re-merge this
    # run's results onto the NEWER document, and write again against its ETag.
    # The re-merge covers the document only -- the objects this run uploaded and
    # deleted are already on S3 and are not redone. A second 412 is abandoned
    # loudly through `write_failed_callback`: a third attempt has no reason to
    # win, and publishing an index computed from a body that is already stale
    # again is exactly the silent rollback this replaces.
    def publish_index() -> tuple[dict, dict, str | None]:
        try:
            return index, manifest, write_index(
                bucket, dataset_id, index, if_match=live_index_etag
            )
        except IndexPreconditionFailed as first:
            print(
                f"::warning::{dataset_id}/zarr/index.json changed under this run "
                f"({first}); re-reading and re-merging once",
                flush=True,
            )
        newer, newer_etag = read_index_with_etag(bucket, dataset_id)
        # `--clean` hands the merge no prior (the document is rebuilt from this
        # run), exactly as the first attempt did; the pending attempt history
        # still comes from the published document, newer one included.
        remerged = build_index(None if args.clean else newer, (newer or {}).get("pending"))
        if events_file:
            remerged["events_parquet"] = f"{remerged['data_base']}{EVENTS_PARQUET_NAME}"
            remerged["events_row_count"] = events_file["row_count"]
        # Re-validated, not assumed: the retry publishes a document built from a
        # body this run has not otherwise inspected. The manifest follows the
        # re-merged store set for the same reason -- it is defined as exactly the
        # index's stores, and pairing a retried index with the first attempt's
        # manifest would publish the disagreement `manifest_upload_failed` exists
        # to report.
        validate_document(remerged, INDEX_SCHEMA_PATH, "index")
        try:
            remerged_manifest = build_manifest(remerged)
        except Exception as exc:  # noqa: BLE001 - abandon the publish, do not skip it
            raise RuntimeError(f"manifest refused after index re-merge: {exc}") from exc
        return remerged, remerged_manifest, write_index(
            bucket, dataset_id, remerged, if_match=newer_etag
        )

    try:
        index, manifest, put_etag = publish_index()
    except IndexPreconditionFailed as exc:
        print(
            f"::error::refusing to publish {dataset_id}/zarr/index.json: {exc}",
            flush=True,
        )
        write_failed_callback(f"index publish conflict: {exc}")
        return 1
    except Exception as exc:  # noqa: BLE001 - the run has nothing to serve without this
        # Includes an `aws` too old to know `--if-match` on put-object (S3 gained
        # conditional writes in Nov 2024): that is a node-provisioning failure,
        # and it has to read as a loud failed run rather than a silent one.
        print(
            f"::error::publishing {dataset_id}/zarr/index.json failed: {exc}",
            flush=True,
        )
        write_failed_callback(f"index publish failed: {exc}")
        return 1
    # The ETag the PUT itself reported, not a follow-up read: a `head-object`
    # here could hand the backend a version this run did not write.
    etag = (put_etag or "").strip().strip('"') or None

    # The manifest is producer-only bookkeeping, so it is uploaded AFTER the index
    # and a failure here does not fail the run: the serving copy and its entry
    # point are already correct, and ADR 0005 says partial data still serves. The
    # next run rewrites it.
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(manifest, fh, separators=(",", ":"))
        manifest_local = fh.name
    manifest_upload_failed = False
    try:
        aws_cp(
            manifest_local,
            f"s3://{bucket}/{dataset_id}/zarr/manifest.json",
            extra=["--content-type", "application/json", "--cache-control", "public, max-age=60"],
        )
    except Exception as exc:  # noqa: BLE001 - never fail a good conversion over this
        # Non-fatal by design (the index and the stores are already correct), but
        # reported: the manifest is where `source_key` lives now, so a silent
        # failure leaves the producer unable to say which blob a store came from,
        # and a warning in a multi-megabyte cron log is not a signal anyone sees.
        manifest_upload_failed = True
        print(f"::warning::manifest.json upload failed for {dataset_id}: {exc}", flush=True)
    finally:
        with contextlib.suppress(OSError):
            os.unlink(manifest_local)

    # status stays "ready": the stores that converted + the index are on S3, so
    # the latest-only state is real and worth recording even on a partial run.
    # `errors`/`failed` carry the per-recording skips; the workflow flags the run
    # red on errors>0 AFTER posting this, so the callback always fires.
    callback = {
        "dataset_id": dataset_id,
        "status": "ready",
        "store_count": index["store_count"],
        "index_etag": etag,
        "commit": head,
        "converted": [e["zarr"] for e in converted_entries],
        "removed": remove,
        "errors": len(failures),
        "failed": failures,
        # Typed data failures (recordings the viewer should explain, not retry).
        "failure_count": index["failure_count"],
        "data_failures": failure_entries,
        # On a partial run the dataset is still `done` (the index has what
        # converted); `deterministic` only tells the backend whether the skipped
        # recordings are data (won't retry) vs infra. See #774.
        "deterministic": deterministic,
        # Worker-pool breaks recovered during this run. Zero is the healthy
        # value; a non-zero trend means the node is under memory pressure and
        # is only visible here -- the log is far too large to watch. #1110.
        "pool_breaks": pool_breaks,
        # Measured peak RAM vs what was reserved, per format. The only way the
        # projection factors stop being guesses. #1111
        "calibration": calibration,
        # Measured vs attempted, so an empty `calibration` can be told apart
        # from a run where measurement itself was unavailable.
        "measured_count": len(measured),
        # Failures that could succeed on a later run. A partially successful
        # run is still marked `done` by the queue, so these need an explicit
        # requeue; they are reported here so that is visible. #1113
        "retryable_failures": retryable_failures,
        # Coverage (#1197). These are what the queue turns into an AUTOMATIC
        # re-queue of a `done` dataset (see zarr_queue.mark_done / reconcile), so
        # #1113's "needs an explicit requeue" above is no longer the whole story;
        # and what the backend records alongside the failure summary so a
        # dashboard can rank datasets by coverage without reading every index.
        "pending_count": index["pending_count"],
        "discovered_count": index["discovered_count"],
        # The subset of `pending_count` that was never ATTEMPTED, as opposed to
        # attempted and failed. They need a re-queue, not a backoff: nothing has
        # gone wrong with them yet, so they must not consume the retry rounds a
        # genuinely failing recording gets (see zarr_queue's pending policy).
        "not_attempted_count": sum(
            1 for e in index["pending"] if e.get("reason") == "not_attempted"
        ),
        # Carried-over stores dropped because their source sits in a tree
        # discovery no longer walks (ADR 0027 raw-only) or is a BIDS calibration
        # file. Reported rather than published: the index describes what IS
        # served, and these are being deleted by `purge_non_raw_stores.py`, so
        # the only place the number belongs is the operational record.
        "non_raw_dropped": non_raw_dropped,
        # True when the catalog could not be read, so this wave's stores carry
        # null doi/license/citation/hed_version because of the RUN, not the data.
        "provenance_fetch_failed": provenance_fetch_failed,
        # True when index.json is published but manifest.json is not, so the two
        # documents disagree about which stores exist until the next run.
        "manifest_upload_failed": manifest_upload_failed,
        # Rows in the events.parquet this run published, or null when it
        # published none (#1060). Null covers three different things -- the
        # dataset has no events, pyarrow is absent from the node's venv, or the
        # build/upload failed -- so `events_upload_failed` separates the last one:
        # "no events" and "we could not say what the events are" must not read
        # the same from outside.
        "events_row_count": events_file["row_count"] if events_file else None,
        "events_upload_failed": events_upload_failed,
        # Stores whose events could not be turned into usable rows: no channel
        # group to attach them to, or no usable sample index on any row. Zero is
        # the healthy value. Each one is warned about by name as it happens, but
        # a warning in a multi-megabyte cron log is not a signal anyone sees, so
        # the count rides here as well (the same argument as `pool_breaks`).
        "events_stores_without_rows": events_stores_without_rows,
    }
    with open(args.callback_out, "w") as fh:
        json.dump(callback, fh)

    if failures:
        print(f"::error::{len(failures)} recording(s) failed to convert: {failures}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
