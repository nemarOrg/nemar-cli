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
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
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


def fetch_public_datasets(api_base: str) -> tuple[list[tuple[str, str]], bool]:
    """Every public dataset as (dataset_id, latest_version), plus completeness.

    Paginates: `GET /datasets` caps a page at 200 regardless of `limit`, so we
    walk `offset` until `total_count`. A non-default User-Agent is required --
    api.nemar.org sits behind Cloudflare, which 403s the default Python-urllib UA
    as a bot.

    The second return value says whether every page was actually seen. A short
    read is benign for enqueueing (the missing datasets are simply picked up next
    run) but NOT for reconcile's `unlisted` sweep, which would read a truncated
    catalog as "these datasets are gone" and park the queue. So the walk stops
    on an empty page rather than looping forever, and reports the shortfall
    instead of hiding it (#1048).
    """
    base = api_base.rstrip("/")
    out: list[tuple[str, str]] = []
    offset, page, total = 0, 200, 0
    while True:
        url = f"{base}/datasets?limit={page}&offset={offset}"
        req = urllib.request.Request(url, headers={"User-Agent": "nemar-zarr-cron/1.0"})
        with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 - trusted NEMAR API
            payload = json.loads(resp.read().decode("utf-8"))
        rows = payload.get("datasets", []) or []
        total = int(payload.get("total_count", 0) or 0)
        for d in rows:
            if d.get("visibility") != "public":
                continue
            out.append((str(d.get("dataset_id", "")), str(d.get("latest_version") or "")))
        offset += len(rows)
        if not rows or offset >= total:
            break
    return out, bool(total) and offset >= total


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
