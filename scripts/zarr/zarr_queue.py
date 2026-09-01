#!/usr/bin/env python3
"""Persistent SQLite conversion queue for the NEMAR Hallu zarr cron (epic #684).

The Hallu cron drives Zarr conversion off this queue instead of re-deriving work
each run, so a long backfill (hundreds of datasets) drains gracefully, failures
retry with backoff, and the whole thing is **crash-safe**: the queue lives on
disk (WAL SQLite), and `reconcile` resets any `inprogress` job left behind by a
killed/rebooted run back to `pending`. As long as the machine is on, the cron
fires and the queue picks up exactly where it left off.

One row per dataset:
    jobs(dataset_id PK, latest_version, converted_version,
         status,            -- pending | inprogress | done | failed | data_failed
         attempts, last_error, next_retry_at (epoch),
         enqueued_at (ISO), updated_at (epoch),
         engine_version)    -- the discovery generation it was converted under

`failed` is an INFRA failure that exhausted its bounded retries (transient: a
crashed worker / S3 blip — could be re-tried manually). `data_failed` is a
deterministic DATA failure (a recording biosigIO can't read, e.g. a MaxShield
MEG `.fif`); it fails identically every run, so it is terminal immediately and
is NOT re-queued by reconcile until a genuinely new dataset version appears
(nemarOrg/nemar-cli#774 — previously every reconcile re-queued failed rows from
scratch, which wedged the queue on a single unconvertible dataset).

Subcommands (all take --db):
    reconcile --api-base URL [--stale-seconds N] [--no-engine-requeue]
        Pull GET /datasets, enqueue (status=pending) every public nm/on dataset
        whose latest_version != converted_version OR whose `done` row was
        converted by an older engine (see ZARR_ENGINE_VERSION), reset stale
        `inprogress` rows to `pending`, and park rows the catalog no longer lists
        as `unlisted` (withdrawn or returned to private -- see `reconcile`).
        Idempotent.
    next [--max-attempts N]
        Atomically claim the oldest eligible job -> `inprogress`; print
        "<dataset_id>\t<latest_version>" (nothing if the queue is drained).
    done DATASET VERSION         mark converted at VERSION (stamps the engine).
    fail DATASET "ERROR" [--max-attempts N] [--backoff-base S]
        attempts++; reschedule (pending + next_retry_at) until max-attempts, then
        terminal `failed`.
    stats                        counts by status (+ a few recent failures).
    backfill-dir-formats [--execute]
        One-off sweep for the cohort stranded BEFORE the engine stamp existed:
        MEG/iEEG datasets marked `done` whose published index has no store for a
        directory-format recording (`.mefd`/`.ds`/4D-BTi). Dry run by default.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
  dataset_id        TEXT PRIMARY KEY,
  latest_version    TEXT,
  converted_version TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  next_retry_at     INTEGER NOT NULL DEFAULT 0,
  enqueued_at       TEXT,
  updated_at        INTEGER NOT NULL DEFAULT 0,
  engine_version    TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
"""

DATASET_ID_RE = re.compile(r"^(nm|on)[0-9]{6}$")

# The generation of DISCOVERY/DISPATCH rules a `done` row was converted under.
#
# **Bump this whenever discovery or dispatch WIDENS** -- that is the whole point
# of the column, and it is what triggers the automatic backfill: `reconcile`
# resets every `done` row carrying an older stamp back to `pending`, so the back
# catalog is reconverted under the wider rules instead of sitting invisibly
# stranded at store_count 0 (nemarOrg/nemar-cli#1172).
#
# "1" retroactively denotes the pre-directory-format engine: everything before
# epic #1095 (merged 2026-08-22) taught discovery to see MEF3 `.mefd`, CTF `.ds`,
# and 4D/BTi recording DIRECTORIES as recordings. It is a documented zero point
# for the numbering, not a value any row actually wears -- rows that predate this
# column are seeded to the CURRENT version by `migrate_schema`, deliberately;
# read the note there before changing that.
#
# A NARROWING must not bump this. Raw-only discovery (ADR 0027) removes stores
# rather than adding them, so a mass requeue would buy nothing and cost a full
# archive reconversion. Bump for "the engine can now see something it could not
# see before", and for nothing else.
ZARR_ENGINE_VERSION = "2"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _now() -> int:
    return int(time.time())


def _vtag(v: str | None) -> str:
    """Canonical ``v``-prefixed version tag ("" for empty/None).

    Makes reconcile's version comparisons agnostic to whether the catalog API
    emits a bare version ("1.0.0") or the canonical tag ("v1.0.0"). nemarOrg/
    nemar-cli epic #896 (#899) normalized the catalog ``latest_version`` to the
    tag form; without this, every dataset whose ``converted_version`` was stored
    bare would read as a new version on the first post-#899 reconcile, flip back
    to ``pending``, and re-drain the whole queue -- a full, needless Zarr rebuild
    of every already-converted public dataset.
    """
    if not v:
        return ""
    return v if v.startswith("v") else f"v{v}"


def migrate_schema(conn: sqlite3.Connection, engine_version: str = ZARR_ENGINE_VERSION) -> int:
    """Add `engine_version` to a pre-existing `jobs` table and seed it.

    Returns how many rows were seeded (0 on a brand-new or already-migrated DB).
    Additive and guarded by `pragma_table_info`, so it is a no-op on every run
    after the first -- `CREATE TABLE IF NOT EXISTS` cannot add a column to a
    table that already exists, which is why this is here at all.

    **A NULL stamp must NEVER mean "requeue me", and this is where that is
    decided.** On the first run against the production queue every one of the
    ~667 `done` rows has a NULL `engine_version`, because it was written before
    the column existed. Reading NULL as "converted by an unknown, therefore old,
    engine" would hand `reconcile` the entire archive to re-convert on the very
    next cron tick -- days of Hallu compute, an S3 rewrite of every store, and a
    `--clean` pass over datasets that are perfectly fine. So the migration seeds
    them to the CURRENT version instead: they are declared up-to-date.

    That is deliberately a lie about the stranded cohort, and it is the right
    one. The datasets #1172 is about -- MEG/iEEG datasets whose `.mefd`/`.ds`/BTi
    directories the pre-#1095 engine could not see -- are recovered by the
    TARGETED `backfill-dir-formats` sweep below, which finds them by evidence
    (an empty or dir-format-missing published index) rather than by re-converting
    667 datasets on the chance that a few dozen need it. Seeding buys the precise
    thing the column is for: from here on, a bump of `ZARR_ENGINE_VERSION`
    requeues exactly the rows that predate the bump, automatically.
    """
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(jobs)")}
    if "engine_version" in cols:
        return 0
    conn.execute("ALTER TABLE jobs ADD COLUMN engine_version TEXT")
    seeded = conn.execute(
        "UPDATE jobs SET engine_version=? WHERE engine_version IS NULL",
        (engine_version,),
    ).rowcount
    conn.commit()
    return seeded


def connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=60)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=60000")
    conn.executescript(SCHEMA)
    seeded = migrate_schema(conn)
    if seeded:
        # One line, once, on the run that migrates. The alternative -- a silent
        # migration -- would leave no evidence anywhere that ~667 rows were
        # declared current rather than requeued, which is the single most
        # consequential thing this file does to a live queue.
        print(
            f"migrated: seeded engine_version={ZARR_ENGINE_VERSION} on {seeded} pre-existing"
            " row(s) (NOT requeued; see backfill-dir-formats for the stranded cohort)",
            file=sys.stderr,
        )
    return conn


def backoff_seconds(attempts: int, base: int, cap: int = 6 * 3600) -> int:
    """Exponential backoff, capped: base, 2*base, 4*base, ... <= cap."""
    return min(base * (2 ** max(0, attempts - 1)), cap)


# --- transition helpers (exercised by the unit tests) -------------------------


def _engine_is_stale(stamp: str | None, current: str) -> bool:
    """True when a `done` row was converted by a DIFFERENT engine generation.

    A NULL stamp is deliberately not stale. `migrate_schema` seeds every
    pre-existing row to the current version precisely so NULL never reaches
    here, and the explicit `is not None` is the second half of that guarantee:
    if a NULL ever does appear (a row written by a driver older than this file,
    a hand-edited DB), it must fail SAFE -- leave the row alone -- rather than
    trigger the archive-wide reconversion the seeding exists to prevent.

    Any difference counts, not just a lower value: the stamp is an identity, not
    an ordering. A deliberate roll-back of `ZARR_ENGINE_VERSION` is then a
    requeue too, which is the honest reading -- the rows were converted by an
    engine that is no longer the one in force.
    """
    return stamp is not None and stamp != current


def reconcile(
    conn: sqlite3.Connection,
    datasets: list[tuple[str, str]],
    stale_seconds: int,
    listing_complete: bool = False,
    engine_requeue: bool = True,
    engine_version: str = ZARR_ENGINE_VERSION,
) -> dict:
    """Enqueue datasets needing (re)conversion + recover stale inprogress rows.

    `datasets` is a list of (dataset_id, latest_version). A dataset is enqueued
    `pending` when it is new or its latest_version differs from the version we
    last converted. A row already `done`/`failed` at the same latest_version is
    left alone (a new version flips it back to pending). `inprogress` rows whose
    `updated_at` is older than `stale_seconds` are assumed crashed and reset to
    `pending` so they run again.

    A `done` row is ALSO requeued when its `engine_version` is not the current
    one (`ZARR_ENGINE_VERSION`), which is how a widening of the discovery rules
    reaches the back catalog: an engine upgrade bumps no dataset version, so
    before this the version comparison above was the only trigger and every
    already-converted dataset stayed stranded under the old rules
    (nemarOrg/nemar-cli#1172). `engine_requeue=False` (CLI:
    `--no-engine-requeue`) suppresses the requeue while still COUNTING it, so an
    operator can see what a bump would cost before paying for it. Either way the
    returned `engine_stale` says how many `done` rows the current stamp
    disagrees with; `engine_requeued` says how many were requeued for that
    reason ALONE (a row whose version also changed is counted as an ordinary
    version requeue, since it would have re-converted regardless -- what an
    operator wants from this number is the MARGINAL cost of the bump).

    `listing_complete` enables the `unlisted` sweep: a row for a dataset the
    catalog no longer lists is parked as `unlisted` so `claim_next` stops handing
    it out. Withdrawal is the case that motivated this (#1048) -- ten withdrawn
    datasets sat `pending` forever, each run cloning them, failing on content
    that is 0-byte by design, and writing failure lines that made the conversion
    log look worse than it was. A dataset merely returned to private looks
    identical from here, which is why the status says `unlisted` rather than
    `withdrawn`: absence from the public catalog is all this process can observe.

    The sweep is gated because it is the one destructive thing reconcile does.
    A short read from a paginated catalog fetch would otherwise unlist the whole
    queue, so the caller must have verified it saw every page (see
    :func:`fetch_public_datasets`). Parking rather than deleting keeps
    `converted_version` intact, and a dataset that reappears in the catalog goes
    straight back to `pending` below.
    """
    now_iso, now = _now_iso(), _now()
    enq = 0
    # IDs the queue refuses, kept as a COUNT rather than dropped on the floor.
    # `seen` counts every row the catalog returned and nothing else did, so a
    # dataset rejected here simply never appeared -- indistinguishable in the log
    # from a healthy steady state where most rows are already `done`. A catalog
    # that starts emitting an unexpected ID shape would go unconverted forever
    # with no line saying so.
    rejected = 0
    engine_stale = 0
    engine_requeued = 0
    for dataset_id, latest in datasets:
        # nm099999 is the private E2E fixture, deliberately never converted; it is
        # an expected skip, not an anomaly, so it is not counted as rejected.
        if dataset_id == "nm099999":
            continue
        if not DATASET_ID_RE.match(dataset_id):
            rejected += 1
            continue
        row = conn.execute(
            "SELECT status, converted_version, latest_version, engine_version FROM jobs"
            " WHERE dataset_id=?",
            (dataset_id,),
        ).fetchone()
        if row is None:
            conn.execute(
                "INSERT INTO jobs(dataset_id, latest_version, status, enqueued_at, updated_at)"
                " VALUES(?,?, 'pending', ?, ?)",
                (dataset_id, latest, now_iso, now),
            )
            enq += 1
            continue
        status = row["status"]
        if status == "done":
            # Re-convert when a version newer than the one we converted appears,
            # OR when the engine that converted it is no longer the current one
            # (#1172 -- an engine upgrade bumps no dataset version, so without
            # this the row would never be looked at again).
            version_changed = bool(latest) and _vtag(latest) != _vtag(row["converted_version"])
            stale_engine = _engine_is_stale(row["engine_version"], engine_version)
            if stale_engine:
                engine_stale += 1
            if version_changed or (stale_engine and engine_requeue):
                conn.execute(
                    "UPDATE jobs SET latest_version=?, status='pending', attempts=0,"
                    " next_retry_at=0, updated_at=? WHERE dataset_id=?",
                    # `version_changed` guarantees a non-empty `latest`; a
                    # stamp-only requeue may not have one (a catalog row with no
                    # latest_version), so fall back to the version already on the
                    # row rather than blanking the drain's conversion target.
                    (latest or row["latest_version"], now, dataset_id),
                )
                enq += 1
                if stale_engine and not version_changed:
                    engine_requeued += 1
        elif status in ("failed", "data_failed"):
            # Terminal for THIS version (#774). Only a genuinely NEW snapshot
            # (latest != the version we already gave up on) retries -- compare
            # against latest_version, NOT converted_version (which is NULL on a
            # failure, so the old check re-queued every reconcile and wedged the
            # queue on one unconvertible dataset).
            if latest and _vtag(latest) != _vtag(row["latest_version"]):
                conn.execute(
                    "UPDATE jobs SET latest_version=?, status='pending', attempts=0,"
                    " next_retry_at=0, last_error=NULL, updated_at=? WHERE dataset_id=?",
                    (latest, now, dataset_id),
                )
                enq += 1
        elif status == "unlisted":
            # Back in the catalog, so it is convertible again. Reset attempts:
            # whatever failed before was about a dataset in a different state.
            conn.execute(
                "UPDATE jobs SET latest_version=?, status='pending', attempts=0,"
                " next_retry_at=0, last_error=NULL, updated_at=? WHERE dataset_id=?",
                (latest or row["latest_version"], now, dataset_id),
            )
            enq += 1
        else:
            # pending / inprogress -- refresh the target version only. Do NOT
            # touch updated_at: it is the inprogress heartbeat the stale-recovery
            # sweep below relies on.
            if latest and _vtag(latest) != _vtag(row["latest_version"]):
                conn.execute(
                    "UPDATE jobs SET latest_version=? WHERE dataset_id=?",
                    (latest, dataset_id),
                )

    unlisted = 0
    if listing_complete:
        # Compare against a temp table rather than an inlined `NOT IN (?, ?, ...)`:
        # the catalog is already ~800 rows and SQLite caps host parameters.
        conn.execute("CREATE TEMP TABLE IF NOT EXISTS listed(dataset_id TEXT PRIMARY KEY)")
        conn.execute("DELETE FROM listed")
        conn.executemany(
            "INSERT OR IGNORE INTO listed(dataset_id) VALUES(?)",
            [(dataset_id,) for dataset_id, _ in datasets],
        )
        # `inprogress` is excluded on purpose: a converter is holding that row
        # right now, and its own completion decides the outcome. If the dataset
        # really is gone the run fails and the next reconcile parks it.
        unlisted = conn.execute(
            "UPDATE jobs SET status='unlisted', next_retry_at=0, updated_at=?"
            " WHERE status NOT IN ('unlisted', 'inprogress')"
            " AND dataset_id NOT IN (SELECT dataset_id FROM listed)",
            (now,),
        ).rowcount

    recovered = conn.execute(
        "UPDATE jobs SET status='pending', next_retry_at=0, updated_at=?"
        " WHERE status='inprogress' AND updated_at < ?",
        (now, now - stale_seconds),
    ).rowcount
    conn.commit()
    return {
        "enqueued": enq,
        "recovered_stale": recovered,
        "unlisted": unlisted,
        "rejected": rejected,
        "engine_stale": engine_stale,
        "engine_requeued": engine_requeued,
    }


def claim_next(conn: sqlite3.Connection) -> sqlite3.Row | None:
    """Claim the oldest eligible pending job (respecting next_retry_at) and mark
    it inprogress. Atomic under the connection's write lock."""
    row = conn.execute(
        "SELECT dataset_id, latest_version FROM jobs"
        " WHERE status='pending' AND next_retry_at <= ?"
        " ORDER BY enqueued_at ASC LIMIT 1",
        (_now(),),
    ).fetchone()
    if row is None:
        return None
    conn.execute(
        "UPDATE jobs SET status='inprogress', updated_at=? WHERE dataset_id=?",
        (_now(), row["dataset_id"]),
    )
    conn.commit()
    return row


def mark_done(
    conn: sqlite3.Connection,
    dataset_id: str,
    version: str,
    engine_version: str = ZARR_ENGINE_VERSION,
) -> None:
    # Store the canonical tag, not whatever the caller happened to hold. `_vtag`
    # already makes reconcile's comparisons prefix-agnostic, so a bare value is
    # harmless TODAY -- but it left 222 rows carrying "1.0.0" against a
    # "v1.0.0" latest_version, which is a trap for the next comparison written
    # without _vtag. Normalize on write so the column is uniform.
    #
    # `engine_version` records WHICH discovery generation produced this
    # conversion, so a later widening can find the row again (#1172). It is a
    # parameter rather than a bare constant read so a test can express "this row
    # was converted by the old engine" through the real code path instead of
    # writing the column by hand.
    conn.execute(
        "UPDATE jobs SET status='done', converted_version=?, last_error=NULL,"
        " next_retry_at=0, engine_version=?, updated_at=? WHERE dataset_id=?",
        (_vtag(version), engine_version, _now(), dataset_id),
    )
    conn.commit()


def mark_fail(
    conn: sqlite3.Connection,
    dataset_id: str,
    error: str,
    max_attempts: int,
    backoff_base: int,
    deterministic: bool = False,
) -> str:
    """Record a failure and return the resulting status.

    `deterministic=True` (a typed DATA failure — biosigIO can't read the
    recording) is terminal **immediately** as `data_failed`: it would fail
    identically on every retry, so retrying only wedges the queue (#774). An
    infra failure reschedules (pending + backoff) until max_attempts, then
    terminal `failed`.
    """
    row = conn.execute("SELECT attempts FROM jobs WHERE dataset_id=?", (dataset_id,)).fetchone()
    attempts = (row["attempts"] if row else 0) + 1
    if deterministic:
        status, next_retry = "data_failed", 0
    elif attempts >= max_attempts:
        status, next_retry = "failed", 0
    else:
        status, next_retry = "pending", _now() + backoff_seconds(attempts, backoff_base)
    conn.execute(
        "UPDATE jobs SET status=?, attempts=?, last_error=?, next_retry_at=?, updated_at=?"
        " WHERE dataset_id=?",
        (status, attempts, error[:1000], next_retry, _now(), dataset_id),
    )
    conn.commit()
    return status


def requeue(
    conn: sqlite3.Connection,
    statuses: tuple[str, ...],
    dataset_id: str | None = None,
    execute: bool = False,
) -> list[tuple[str, str, int]]:
    """Reset terminal jobs to `pending` so the drain loop picks them up again.

    Returns the rows it would touch (or did) as (dataset_id, status, attempts).
    Read-only unless ``execute`` is set, because this un-does a deliberate
    give-up decision and a dry run should be the default way to see its scope.

    Distinct from ``reconcile``, which already revives a terminal job when a
    genuinely NEW version appears. This is for the same version: the give-up was
    wrong on its own terms, not superseded.

    Two reasons a terminal job deserves another chance:

    `failed` means the retry budget ran out on INFRA errors. Most of that budget
    was spent on OOM-killed workers taking whole datasets down with them
    (nemarOrg/nemar-cli#1110), so the attempts were consumed by a defect that no
    longer exists rather than by anything about the dataset.

    `data_failed` is terminal-by-design for typed DATA failures, but the
    classifier itself was wrong: a runtime out-of-memory used to be recorded as
    `recording_too_large`, a permanent property of the recording, when it is
    really a property of what else was running (#1111). Datasets buried by that
    misclassification are indistinguishable here from genuine ones, so requeue
    them and let the corrected classifier re-decide -- a genuine data failure
    simply returns to `data_failed` on the next run, at the cost of one
    conversion attempt.
    """
    placeholders = ",".join("?" for _ in statuses)
    params: list = list(statuses)
    sql = f"SELECT dataset_id, status, attempts FROM jobs WHERE status IN ({placeholders})"
    if dataset_id:
        sql += " AND dataset_id=?"
        params.append(dataset_id)
    rows = [
        (r["dataset_id"], r["status"], r["attempts"])
        for r in conn.execute(sql + " ORDER BY dataset_id", params)
    ]
    if execute and rows:
        conn.execute(
            f"UPDATE jobs SET status='pending', attempts=0, next_retry_at=0,"
            f" last_error='', updated_at=? WHERE status IN ({placeholders})"
            + (" AND dataset_id=?" if dataset_id else ""),
            [_now(), *params],
        )
        conn.commit()
    return rows


# --- I/O: fetch the dataset list ----------------------------------------------


# api.nemar.org and data.nemar.org sit behind Cloudflare, which 403s the default
# Python-urllib User-Agent as a bot. Every request in this file must set one.
USER_AGENT = "nemar-zarr-cron/1.0"


def _get_json(url: str, timeout: int = 60):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - trusted NEMAR host
        return json.loads(resp.read().decode("utf-8"))


def fetch_public_catalog_rows(api_base: str) -> tuple[list[dict], bool]:
    """Every public catalog row (the full JSON object), plus completeness.

    Paginates: `GET /datasets` caps a page at 200 regardless of `limit`, so we
    walk `offset` until `total_count`.

    The second return value says whether every page was actually seen. A short
    read is benign for enqueueing (the missing datasets are simply picked up next
    run) but NOT for reconcile's `unlisted` sweep, which would read a truncated
    catalog as "these datasets are gone" and park the queue. So the walk stops
    on an empty page rather than looping forever, and reports the shortfall
    instead of hiding it (#1048).

    `offset` advances by the number of rows the page RETURNED, not the number
    kept: filtering to public here must not desynchronise the paging arithmetic.
    """
    base = api_base.rstrip("/")
    out: list[dict] = []
    offset, page, total = 0, 200, 0
    while True:
        payload = _get_json(f"{base}/datasets?limit={page}&offset={offset}")
        rows = payload.get("datasets", []) or []
        total = int(payload.get("total_count", 0) or 0)
        out.extend(d for d in rows if d.get("visibility") == "public")
        offset += len(rows)
        if not rows or offset >= total:
            break
    return out, bool(total) and offset >= total


def fetch_public_datasets(api_base: str) -> tuple[list[tuple[str, str]], bool]:
    """Every public dataset as (dataset_id, latest_version), plus completeness.

    The shape `reconcile` consumes; `fetch_public_catalog_rows` owns the paging
    and the public filter so the backfill sweep below cannot drift from it.
    """
    rows, complete = fetch_public_catalog_rows(api_base)
    return (
        [(str(d.get("dataset_id", "")), str(d.get("latest_version") or "")) for d in rows],
        complete,
    )


# --- One-off: the pre-stamp directory-format backfill (#1172) ------------------
#
# `migrate_schema` declares every pre-existing `done` row current, which is right
# for the ~667 datasets that genuinely are, and wrong for the handful that are
# not: MEG/iEEG datasets converted BEFORE epic #1095 (2026-08-22), whose MEF3
# `.mefd`, CTF `.ds` and 4D/BTi recording DIRECTORIES the engine of the day could
# not see at all. Those landed in neither `stores` nor `failures` -- the run
# found nothing, succeeded, and was marked `done`. on004696 is the reference
# case: `store_count: 0`, `failure_count: 0`, invisible in the viewer ever since.
#
# The engine stamp cannot recover them (it did not exist when they converted) and
# a blanket requeue of every `done` row would re-convert the whole archive to
# find a few dozen. So this sweep identifies them by EVIDENCE instead, from the
# two documents that already say what happened:
#
#   (a) the published index (`zarr.nemar.org/<id>/zarr/index.json`) -- missing
#       entirely, or listing no stores at all; and
#   (b) the dataset's own file list (`data.nemar.org/<id>/<v>/manifest.json`) --
#       a directory-format recording present in the tree that the index neither
#       serves as a store NOR blames as a failure.
#
# Rule (b) is what catches a PARTIAL miss (a dataset with EEG stores whose one
# `.ds` MEG session never converted), which rule (a) alone cannot see. The
# "nor blames" half is what keeps it precise -- see `index_failure_keys`.
#
# The detection rules are IMPORTED from `generate_zarr`, never restated: if this
# sweep and the converter disagreed about what a directory recording is, the
# sweep would requeue datasets the converter will not fix, or miss ones it would.
#
# `manifest.json` is the probe rather than the `?format=json` directory listings
# because it returns the entire file tree in ONE request. Walking listings costs
# one request per directory -- hundreds per dataset, tens of thousands across the
# sweep -- to compute the same set. One request per dataset is both gentler on
# the data plane and the only version of this that is reasonable to re-run.

DIR_FORMAT_MODALITIES = ("meg", "ieeg")


def _detection_rules():
    """`generate_zarr`'s own directory-recording detectors, imported not copied.

    Lazy on purpose. This module is the crash-safe core of the cron -- `next`,
    `done` and `fail` run for every dataset of every drain -- and it must not
    acquire a hard import dependency on the 3,700-line converter sitting beside
    it. Only the backfill sweep needs these, so only the backfill sweep pays for
    them, and a converter that failed to import breaks the sweep rather than the
    queue.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    from generate_zarr import (  # type: ignore[import-not-found]  (sibling module)
        bti_recordings,
        dir_recordings,
        store_rel_for,
    )

    return dir_recordings, bti_recordings, store_rel_for


def may_carry_dir_formats(modalities: str | None) -> bool:
    """True when a catalog row's modalities could involve a directory format.

    MEG (CTF `.ds`, 4D/BTi) and iEEG (MEF3 `.mefd`) are the only carriers, so
    the sweep probes those and skips the rest -- 131 of 755 datasets when this
    was written, which is most of what bounds a full run.

    An EMPTY modality string is treated as "could be", not "is not". A catalog
    row with no modalities is exactly what an OpenNeuro import that never got
    backfilled looks like (nemarOrg/nemar-cli#512), and skipping those would
    silently exclude precisely the under-described datasets this sweep exists to
    find. There happen to be none today; the cost of the guard is zero and the
    cost of being wrong about it is a cohort that stays stranded.
    """
    tokens = {t.strip().lower() for t in (modalities or "").split(",") if t.strip()}
    if not tokens:
        return True
    return bool(tokens & set(DIR_FORMAT_MODALITIES))


def _entry_keys(entries) -> tuple[set[str], set[str]]:
    """(recording paths, `.zarr` rel-paths) named by a list of index entries.

    Both keys are collected because either identifies a recording and a
    hand-edited or half-written index may carry only one of them; a match on
    EITHER counts.
    """
    paths: set[str] = set()
    rels: set[str] = set()
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        if isinstance(entry.get("path"), str):
            paths.add(entry["path"])
        if isinstance(entry.get("zarr"), str):
            rels.add(entry["zarr"])
    return paths, rels


def index_store_keys(index_doc: dict | None) -> tuple[set[str], set[str]]:
    """The recordings the published index lists as SERVED stores."""
    return _entry_keys((index_doc or {}).get("stores"))


def index_failure_keys(index_doc: dict | None) -> tuple[set[str], set[str]]:
    """The recordings the published index lists as typed conversion FAILURES.

    A recording here was **seen** by the converter and could not be converted,
    which is a different problem from the one this sweep exists to find -- and
    the distinction is what keeps the sweep precise. The pre-#1095 engine did not
    recognise `.mefd`/`.ds`/BTi directories as recordings at all, so a
    directory-format recording it processed landed in NEITHER list; one sitting
    in `failures` therefore proves a POST-#1095 engine already looked at it and
    failed on the data.

    Measured against the live archive before this distinction existed: of 41
    datasets the sweep flagged, ten were flagged only because their `.ds`
    recordings were recorded failures -- on005752 alone would have re-queued 471
    CTF MEG recordings a current engine has already tried. Retrying those is the
    `--requeue` decision (#1113), not this one.
    """
    return _entry_keys((index_doc or {}).get("failures"))


def dir_format_recordings(paths) -> set[str]:
    """Every directory-format recording among `paths`, by `generate_zarr`'s rules.

    Extension-keyed (`.mefd`, `.ds`) via `dir_recordings`, plus content-keyed
    4D/BTi via `bti_recordings` (a directory holding both a `c,rf*` file and a
    sibling `config`). Both already exclude `derivatives/`, `sourcedata/` and
    `code/` (ADR 0027), so a recording under one of those is not counted as
    missing -- the converter would not build it either.
    """
    dir_recordings, bti_recordings, _ = _detection_rules()
    paths = set(paths)
    return dir_recordings(paths) | bti_recordings(paths)


def partition_dir_format_recordings(
    manifest_paths, index_doc: dict | None
) -> tuple[list[str], list[str]]:
    """Split the tree's directory recordings into (never seen, seen and failed).

    `manifest_paths` is the dataset's full file list (every path, not just
    recordings) -- the same input shape `generate_zarr`'s detectors take, which
    is why they can be applied to it unmodified. Both lists are sorted, and a
    recording that has a store appears in neither.

    The first list is the #1172 cohort: a recording in the tree that the index
    neither serves nor blames. The second is a recording the converter tried and
    failed on, which is a real problem but a different one -- see
    `index_failure_keys` for why conflating them re-converts hundreds of
    recordings that a current engine has already rejected.
    """
    _, _, store_rel_for = _detection_rules()
    served_paths, served_rels = index_store_keys(index_doc)
    failed_paths, failed_rels = index_failure_keys(index_doc)
    unseen: list[str] = []
    failed: list[str] = []
    for rec in dir_format_recordings(manifest_paths):
        rel = store_rel_for(rec)
        if rec in served_paths or rel in served_rels:
            continue
        if rec in failed_paths or rel in failed_rels:
            failed.append(rec)
        else:
            unseen.append(rec)
    return sorted(unseen), sorted(failed)


def missing_dir_format_stores(manifest_paths, index_doc: dict | None) -> list[str]:
    """The directory recordings the index neither serves nor blames."""
    unseen, _ = partition_dir_format_recordings(manifest_paths, index_doc)
    return unseen


def classify_backfill(
    dataset_id: str,
    index_doc: dict | None,
    manifest_paths=None,
) -> dict:
    """Decide whether one dataset is stranded, and say why. Pure.

    `index_doc` is the parsed `index.json` (None when it 404s -- nothing was ever
    published). `manifest_paths` is the dataset's file list, or None when the
    probe was skipped or unavailable.

    Reasons, in the order they are checked:
      `index_missing`     -- no published index at all.
      `empty_index`       -- an index that lists zero stores.
      `dir_stores_missing`-- a directory-format recording in the tree that the
                             index neither serves nor blames (the partial case).
      `served`            -- nothing unaccounted for.
      `not_probed`        -- stores exist and no manifest was read, so the
                             partial case could not be ruled out. NOT affected:
                             requeuing on an unfinished check would re-convert
                             datasets on no evidence.

    `known_failed` carries the directory recordings the index records as typed
    conversion failures. They are reported and never counted as missing --
    the converter has already seen them, so they are #1113's problem, not this
    sweep's.
    """
    if index_doc is None:
        return {
            "dataset_id": dataset_id,
            "affected": True,
            "reason": "index_missing",
            "store_count": 0,
            "failure_count": 0,
            "missing": [],
            "known_failed": [],
        }
    # Count the entries rather than trusting `store_count`: the entries are what
    # the viewer reads, so a document where the two disagree should be judged by
    # what it actually serves.
    stores = index_doc.get("stores")
    store_count = (
        len(stores) if isinstance(stores, list) else int(index_doc.get("store_count") or 0)
    )
    failures = index_doc.get("failures")
    failure_count = (
        len(failures) if isinstance(failures, list) else int(index_doc.get("failure_count") or 0)
    )
    result = {
        "dataset_id": dataset_id,
        "affected": False,
        "reason": "served",
        "store_count": store_count,
        "failure_count": failure_count,
        "missing": [],
        "known_failed": [],
    }
    if manifest_paths is not None:
        result["missing"], result["known_failed"] = partition_dir_format_recordings(
            manifest_paths, index_doc
        )
    if store_count == 0:
        result["affected"] = True
        result["reason"] = "empty_index"
        return result
    if manifest_paths is None:
        result["reason"] = "not_probed"
        return result
    if result["missing"]:
        result["affected"] = True
        result["reason"] = "dir_stores_missing"
    return result


# --- I/O for the sweep ---------------------------------------------------------


def _get_json_retrying(url: str, timeout: int, attempts: int = 3, backoff: float = 2.0):
    """`_get_json` with a small bounded retry on transient server/network errors.

    The sweep touches ~131 live endpoints in one pass, and a single 503 (observed
    on the very first trial run) otherwise costs a whole dataset its answer. A
    4xx is NEVER retried -- a 404 is a finding, not a hiccup -- and the backoff
    keeps this well short of hammering.

    Deliberately not applied to `fetch_public_catalog_rows`: `reconcile` relies
    on that call failing loudly and immediately, so the cron aborts rather than
    draining an under-populated queue (see hallu-zarr.sh's reconcile guard).
    """
    for attempt in range(1, attempts + 1):
        try:
            return _get_json(url, timeout=timeout)
        except urllib.error.HTTPError as exc:
            if exc.code < 500 or attempt == attempts:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == attempts:
                raise
        time.sleep(backoff * attempt)
    raise RuntimeError("unreachable")  # pragma: no cover - loop always returns or raises


def fetch_zarr_index(zarr_base: str, dataset_id: str) -> dict | None:
    """The published `index.json`, or None when there is none (404).

    Only a 404 becomes None -- "nothing was ever published here" is a finding.
    Every other failure raises, so a 500 or a timeout is reported as an error
    against that dataset instead of being read as an empty index and requeued.
    """
    url = f"{zarr_base.rstrip('/')}/{dataset_id}/zarr/index.json"
    try:
        return _get_json_retrying(url, timeout=30)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def fetch_manifest_paths(data_base: str, dataset_id: str, version: str) -> set[str] | None:
    """Every file path in the dataset at `version`, from one manifest.json read.

    The literal alias `latest` is used when the catalog has no version for the
    row; the data plane resolves it to the newest published version.

    None when there is no manifest to read (404). That is not an error: a
    published dataset can have no `dataset_versions` row at all (on005691 does),
    so the tree cannot be listed and the probe simply did not happen -- which is
    exactly what `not_probed` says. Raising instead would file a permanent
    property of the dataset as a transient failure, on every run forever.
    """
    tag = _vtag(version) or "latest"
    url = f"{data_base.rstrip('/')}/{dataset_id}/{tag}/manifest.json"
    try:
        rows = _get_json_retrying(url, timeout=120)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    if not isinstance(rows, list):
        raise ValueError(f"manifest.json for {dataset_id} is not a list")
    return {r["path"] for r in rows if isinstance(r, dict) and isinstance(r.get("path"), str)}


def sweep_dir_format_backfill(
    conn: sqlite3.Connection,
    api_base: str,
    data_base: str,
    zarr_base: str,
    dataset: str | None = None,
    limit: int = 0,
    sleep_seconds: float = 0.5,
    probe: bool = True,
    execute: bool = False,
) -> dict:
    """Enumerate (and optionally requeue) the stranded directory-format cohort.

    Sequential with a pause between datasets: this is a one-off recovery, not a
    hot path, and the archive it reads is the one serving live traffic.

    A per-dataset failure is recorded and the sweep continues. Aborting would
    make the whole run's usefulness hostage to one flaky read, and the run is
    idempotent -- re-running it re-examines the datasets that errored.
    """
    rows, complete = fetch_public_catalog_rows(api_base)
    candidates = [
        r
        for r in rows
        if DATASET_ID_RE.match(str(r.get("dataset_id", "")))
        and may_carry_dir_formats(r.get("modalities"))
        and (dataset is None or r.get("dataset_id") == dataset)
    ]
    if dataset and not candidates:
        # Silence here would read as "checked, nothing wrong". Say which of the
        # two filters rejected it instead.
        print(
            f"{dataset} is not a candidate: it is not a public nm/on dataset, or its"
            " modalities carry no directory format (MEG/iEEG)"
        )
    findings: list[dict] = []
    errors: list[tuple[str, str]] = []
    requeued: list[str] = []
    skipped: list[tuple[str, str]] = []
    examined = 0
    for row in candidates:
        if limit and examined >= limit:
            break
        dataset_id = str(row["dataset_id"])
        examined += 1
        if examined > 1 and sleep_seconds:
            time.sleep(sleep_seconds)
        try:
            index_doc = fetch_zarr_index(zarr_base, dataset_id)
            manifest_paths = None
            # An index that is missing or empty is already decisive, so the
            # multi-megabyte manifest read is skipped for it. That is not just
            # speed: it is most of what makes this sweep gentle, because the
            # stranded datasets are exactly the ones that would need it.
            if probe and index_doc is not None and (index_doc.get("stores") or []):
                manifest_paths = fetch_manifest_paths(
                    data_base, dataset_id, str(row.get("latest_version") or "")
                )
                if manifest_paths is None:
                    # Not affected and not an error, but not checked either --
                    # and a dataset that quietly falls out of both buckets is the
                    # kind of gap this sweep is supposed to close, not create.
                    print(
                        f"note {dataset_id}: no manifest to read (no published version),"
                        " so the partial case could not be checked",
                        flush=True,
                    )
            finding = classify_backfill(dataset_id, index_doc, manifest_paths)
        except Exception as exc:  # noqa: BLE001 - one dataset must not end the sweep
            errors.append((dataset_id, f"{type(exc).__name__}: {exc}"))
            # Reported where it happens, not batched to the end: this sweep runs
            # for minutes against live hosts, usually into a log an operator is
            # tailing, and `flush` is what makes that tail move.
            print(f"error {dataset_id}: {type(exc).__name__}: {exc}", flush=True)
            continue
        job = conn.execute(
            "SELECT status, converted_version, engine_version FROM jobs WHERE dataset_id=?",
            (dataset_id,),
        ).fetchone()
        finding["queue_status"] = job["status"] if job else "(no row)"
        finding["converted_version"] = (job["converted_version"] if job else None) or ""
        finding["engine_version"] = (job["engine_version"] if job else None) or "(unset)"
        findings.append(finding)
        if not finding["affected"]:
            continue
        print(
            f"affected {dataset_id}: {finding['reason']}"
            f" (stores={finding['store_count']}, failures={finding['failure_count']},"
            f" unseen_dir_recordings={len(finding['missing'])},"
            f" already_failed={len(finding['known_failed'])},"
            f" queue={finding['queue_status']}"
            f"{'@' + finding['converted_version'] if finding['converted_version'] else ''},"
            f" engine={finding['engine_version']})",
            flush=True,
        )
        for rec in finding["missing"][:5]:
            print(f"    no store for {rec}")
        if len(finding["missing"]) > 5:
            print(f"    ... and {len(finding['missing']) - 5} more")
        if finding["known_failed"]:
            # Named, not hidden: these are real gaps in the serving copy, they
            # just are not THIS gap, and an operator reading the report should
            # not have to rediscover that they exist.
            print(
                f"    ({len(finding['known_failed'])} more directory recording(s) are"
                " recorded conversion FAILURES, not discovery misses; see --requeue)"
            )
        if not execute:
            continue
        # `requeue` filters on status itself, so a dataset that is not `done`
        # (already pending, in flight, or terminal) is a no-op here BY
        # CONSTRUCTION rather than by a check that could drift from it.
        touched = requeue(conn, ("done",), dataset_id=dataset_id, execute=True)
        if touched:
            requeued.append(dataset_id)
            print(f"  requeued {dataset_id} (done -> pending)")
        else:
            skipped.append((dataset_id, finding["queue_status"]))
            print(
                f"  not requeued {dataset_id}: queue status is"
                f" {finding['queue_status']}, not done"
            )
    affected = [f for f in findings if f["affected"]]
    print(
        f"backfill-dir-formats: candidates={len(candidates)} examined={examined}"
        f" affected={len(affected)} errors={len(errors)}"
        f" requeued={len(requeued)} not_requeued={len(skipped)}"
        + ("" if complete else " (PARTIAL catalog read; some datasets were not examined)")
    )
    if affected and not execute:
        print("re-run with --execute to requeue the affected datasets")
    return {
        "candidates": len(candidates),
        "examined": examined,
        "findings": findings,
        "affected": affected,
        "errors": errors,
        "requeued": requeued,
        "not_requeued": skipped,
        "catalog_complete": complete,
    }


# --- CLI ----------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description="NEMAR zarr conversion queue (SQLite)")
    ap.add_argument("--db", required=True)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("reconcile")
    p.add_argument("--api-base", default="https://api.nemar.org")
    p.add_argument("--stale-seconds", type=int, default=6 * 3600)
    p.add_argument(
        "--no-engine-requeue",
        action="store_true",
        help="do NOT requeue `done` rows converted by an older engine; the run still"
        " reports how many rows the current ZARR_ENGINE_VERSION would requeue, so the"
        " cost of a bump can be read off a dry run before it is paid",
    )

    sub.add_parser("next")

    p = sub.add_parser("done")
    p.add_argument("dataset")
    p.add_argument("version")

    p = sub.add_parser("fail")
    p.add_argument("dataset")
    p.add_argument("error")
    p.add_argument("--max-attempts", type=int, default=5)
    p.add_argument("--backoff-base", type=int, default=1800)
    p.add_argument(
        "--deterministic",
        action="store_true",
        help="typed DATA failure: terminal `data_failed` now, no retry/requeue (#774)",
    )

    p = sub.add_parser(
        "requeue",
        help="reset terminal jobs (failed / data_failed) back to pending",
    )
    p.add_argument(
        "--status",
        choices=("failed", "data_failed", "done", "all"),
        default="failed",
        help="`done` reaches datasets that converted PARTIALLY: a run where "
        "anything succeeded is marked done, so recordings that failed for a "
        "retryable reason are stranded there. Scope it with --dataset -- "
        "requeuing `done` re-converts the whole dataset.",
    )
    p.add_argument("--dataset", default=None, help="just this dataset")
    p.add_argument(
        "--execute",
        action="store_true",
        help="actually requeue; without it the command only reports what it would do",
    )

    sub.add_parser("stats")

    p = sub.add_parser(
        "backfill-dir-formats",
        help="one-off (#1172): find MEG/iEEG datasets marked `done` whose published"
        " index has no store for a directory-format recording (.mefd/.ds/4D-BTi),"
        " and requeue them",
    )
    p.add_argument("--api-base", default="https://api.nemar.org")
    p.add_argument("--data-base", default="https://data.nemar.org")
    p.add_argument("--zarr-base", default="https://zarr.nemar.org")
    p.add_argument("--dataset", default=None, help="examine just this dataset")
    p.add_argument("--limit", type=int, default=0, help="stop after N candidates (0 = all)")
    p.add_argument(
        "--sleep",
        type=float,
        default=0.5,
        help="seconds between datasets; this reads the live serving archive",
    )
    p.add_argument(
        "--no-probe",
        action="store_true",
        help="index-only: skip the manifest read, so a dataset that serves SOME stores"
        " is reported `not_probed` instead of being checked for a partial miss",
    )
    p.add_argument(
        "--execute",
        action="store_true",
        help="actually requeue the affected datasets (`done` -> `pending`);"
        " without it the sweep only reports",
    )

    args = ap.parse_args()
    conn = connect(args.db)

    if args.cmd == "reconcile":
        datasets, complete = fetch_public_datasets(args.api_base)
        res = reconcile(
            conn,
            datasets,
            args.stale_seconds,
            listing_complete=complete,
            engine_requeue=not args.no_engine_requeue,
        )
        # `engine_stale` is printed on every run, not only when it is non-zero:
        # an engine bump is the one reconcile outcome that can requeue hundreds
        # of datasets at once, and a steady `engine_stale=0` in the cron log is
        # what makes the run that says otherwise legible.
        print(
            f"reconcile: seen={len(datasets)} enqueued={res['enqueued']} "
            f"recovered_stale={res['recovered_stale']} unlisted={res['unlisted']} "
            f"rejected={res['rejected']} engine={ZARR_ENGINE_VERSION} "
            f"engine_stale={res['engine_stale']} engine_requeued={res['engine_requeued']}"
            + (
                " (engine requeue SUPPRESSED by --no-engine-requeue)"
                if args.no_engine_requeue and res["engine_stale"]
                else ""
            )
            + ("" if complete else " (PARTIAL catalog read; unlisted sweep skipped)")
        )
        return 0

    if args.cmd == "next":
        row = claim_next(conn)
        if row is not None:
            print(f"{row['dataset_id']}\t{row['latest_version']}")
        return 0

    if args.cmd == "done":
        mark_done(conn, args.dataset, args.version)
        return 0

    if args.cmd == "requeue":
        # `all` deliberately does NOT include `done`: that would re-convert every
        # dataset in the archive. Reaching `done` has to be asked for by name.
        statuses = ("failed", "data_failed") if args.status == "all" else (args.status,)
        rows = requeue(conn, statuses, args.dataset, args.execute)
        verb = "requeued" if args.execute else "would requeue"
        for dataset_id, status, attempts in rows:
            print(f"{verb} {dataset_id} ({status}, attempts={attempts})")
        print(f"{verb} {len(rows)} job(s) from {'/'.join(statuses)}")
        if rows and not args.execute:
            print("re-run with --execute to apply")
        return 0

    if args.cmd == "backfill-dir-formats":
        res = sweep_dir_format_backfill(
            conn,
            api_base=args.api_base,
            data_base=args.data_base,
            zarr_base=args.zarr_base,
            dataset=args.dataset,
            limit=args.limit,
            sleep_seconds=args.sleep,
            probe=not args.no_probe,
            execute=args.execute,
        )
        # A sweep that could not read some datasets did not answer the question
        # for them. Exit non-zero so a scripted run cannot record "no datasets
        # affected" when the truth is "some were never examined".
        return 1 if res["errors"] or not res["catalog_complete"] else 0

    if args.cmd == "fail":
        status = mark_fail(
            conn,
            args.dataset,
            args.error,
            args.max_attempts,
            args.backoff_base,
            deterministic=args.deterministic,
        )
        print(f"{args.dataset} -> {status}")
        return 0

    if args.cmd == "stats":
        rows = conn.execute("SELECT status, COUNT(*) n FROM jobs GROUP BY status").fetchall()
        print("status: " + (", ".join(f"{r['status']}={r['n']}" for r in rows) or "(empty)"))
        # Engine stamps of the `done` rows only: those are the rows the stamp
        # governs, and the one number an operator needs after a bump is "how
        # much of the archive is still on the old engine".
        engines = conn.execute(
            "SELECT COALESCE(engine_version, '(unset)') e, COUNT(*) n FROM jobs"
            " WHERE status='done' GROUP BY e ORDER BY e"
        ).fetchall()
        print(
            f"engine (current={ZARR_ENGINE_VERSION}), done rows by stamp: "
            + (", ".join(f"{r['e']}={r['n']}" for r in engines) or "(none)")
        )
        fails = conn.execute(
            "SELECT dataset_id, status, attempts, last_error FROM jobs"
            " WHERE status IN ('failed', 'data_failed')"
            " ORDER BY updated_at DESC LIMIT 5"
        ).fetchall()
        for r in fails:
            print(
                f"  {r['status']} {r['dataset_id']} attempts={r['attempts']}:"
                f" {(r['last_error'] or '')[:120]}"
            )
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())
