#!/usr/bin/env python3
"""Unit tests for the SQLite conversion queue (scripts/zarr/zarr_queue.py).

Real SQLite (a temp db per test), no mocks: exercises the enqueue / claim /
done / fail transitions, retry-backoff, version-bump requeue, the crash
recovery (stale `inprogress` -> `pending`), the engine-version stamp and its
migration (#1172), and the pure decision logic of the directory-format backfill
sweep. The HTTP fetches are not tested here (they hit the live API/data plane,
validated by the cron run and by a dry-run sweep).

Run: python3 scripts/zarr/test_zarr_queue.py
"""

from __future__ import annotations

import contextlib
import io
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from zarr_queue import (  # type: ignore[import-not-found]  # noqa: E402
    ZARR_ENGINE_VERSION,
    backoff_seconds,
    claim_next,
    classify_backfill,
    connect,
    dir_format_recordings,
    index_failure_keys,
    index_store_keys,
    mark_done,
    mark_fail,
    may_carry_dir_formats,
    migrate_schema,
    missing_dir_format_stores,
    partition_dir_format_recordings,
    reconcile,
    requeue,
)


class QueueTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = connect(os.path.join(self._tmp.name, "q.db"))

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def status(self, dataset_id):
        r = self.conn.execute(
            "SELECT status FROM jobs WHERE dataset_id=?", (dataset_id,)
        ).fetchone()
        return r["status"] if r else None

    def test_reconcile_enqueues_new(self):
        res = reconcile(self.conn, [("nm000001", "1.0.0"), ("on000002", "1.0.0")], 3600)
        self.assertEqual(res["enqueued"], 2)
        self.assertEqual(self.status("nm000001"), "pending")

    def test_reconcile_filters_invalid_and_test_id(self):
        reconcile(self.conn, [("nm099999", "1"), ("bad", "1"), ("nm000001", "1.0.0")], 3600)
        ids = [r["dataset_id"] for r in self.conn.execute("SELECT dataset_id FROM jobs").fetchall()]
        self.assertEqual(ids, ["nm000001"])

    def test_done_then_reconcile_skips_same_version(self):
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        claim_next(self.conn)
        mark_done(self.conn, "nm000001", "1.0.0")
        res = reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        self.assertEqual(res["enqueued"], 0)
        self.assertEqual(self.status("nm000001"), "done")

    def test_version_bump_requeues_done(self):
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        claim_next(self.conn)
        mark_done(self.conn, "nm000001", "1.0.0")
        res = reconcile(self.conn, [("nm000001", "1.1.0")], 3600)
        self.assertEqual(res["enqueued"], 1)
        self.assertEqual(self.status("nm000001"), "pending")

    def test_bare_vs_tagged_same_version_does_not_requeue(self):
        # A done row converted at the bare "1.0.0"; nemar-cli #899 flips the
        # catalog latest_version to the tag "v1.0.0". These are the SAME version
        # and must NOT re-queue (else the queue re-drains every already-converted
        # dataset). Guards against the format-flip compute burst.
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        claim_next(self.conn)
        mark_done(self.conn, "nm000001", "1.0.0")
        res = reconcile(self.conn, [("nm000001", "v1.0.0")], 3600)
        self.assertEqual(res["enqueued"], 0)
        self.assertEqual(self.status("nm000001"), "done")
        # And the reverse (tagged converted, bare latest) is likewise a no-op.
        res2 = reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        self.assertEqual(res2["enqueued"], 0)

    def test_claim_marks_inprogress_then_empty(self):
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        row = claim_next(self.conn)
        self.assertEqual(row["dataset_id"], "nm000001")
        self.assertEqual(self.status("nm000001"), "inprogress")
        self.assertIsNone(claim_next(self.conn))

    def test_claim_orders_by_enqueued(self):
        reconcile(self.conn, [("nm000002", "1"), ("nm000001", "1")], 3600)
        self.conn.execute("UPDATE jobs SET enqueued_at='2026-01-01T00:00:01Z' WHERE dataset_id='nm000002'")
        self.conn.execute("UPDATE jobs SET enqueued_at='2026-01-01T00:00:00Z' WHERE dataset_id='nm000001'")
        self.conn.commit()
        self.assertEqual(claim_next(self.conn)["dataset_id"], "nm000001")
        self.assertEqual(claim_next(self.conn)["dataset_id"], "nm000002")

    def test_fail_reschedules_with_backoff_then_terminal(self):
        reconcile(self.conn, [("nm000001", "1")], 3600)
        claim_next(self.conn)
        self.assertEqual(mark_fail(self.conn, "nm000001", "boom", 3, 1800), "pending")
        # in backoff -> not yet claimable
        self.assertIsNone(claim_next(self.conn))
        for expect in ("pending", "failed"):
            self.conn.execute("UPDATE jobs SET next_retry_at=0 WHERE dataset_id='nm000001'")
            self.conn.commit()
            claim_next(self.conn)
            self.assertEqual(mark_fail(self.conn, "nm000001", "boom", 3, 1800), expect)
        self.assertEqual(self.status("nm000001"), "failed")

    def test_stale_inprogress_recovered(self):
        reconcile(self.conn, [("nm000001", "1")], 3600)
        claim_next(self.conn)  # -> inprogress
        self.conn.execute(
            "UPDATE jobs SET updated_at=? WHERE dataset_id='nm000001'", (int(time.time()) - 99999,)
        )
        self.conn.commit()
        res = reconcile(self.conn, [("nm000001", "1")], 3600)
        self.assertEqual(res["recovered_stale"], 1)
        self.assertEqual(self.status("nm000001"), "pending")

    def test_backoff_capped(self):
        self.assertEqual(backoff_seconds(1, 100), 100)
        self.assertEqual(backoff_seconds(2, 100), 200)
        self.assertEqual(backoff_seconds(3, 100), 400)
        self.assertEqual(backoff_seconds(100, 100), 6 * 3600)

    # --- #774: deterministic data failures are terminal, don't re-queue --------

    def test_deterministic_fail_is_terminal_data_failed(self):
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        claim_next(self.conn)
        # One deterministic failure -> terminal data_failed immediately, even
        # though max_attempts is high (no retry).
        self.assertEqual(
            mark_fail(self.conn, "nm000001", "MaxShield .fif", 5, 1800, deterministic=True),
            "data_failed",
        )
        self.assertEqual(self.status("nm000001"), "data_failed")

    def test_reconcile_does_not_requeue_terminal_same_version(self):
        # The bug #774 fixes: a failed/data_failed row was re-queued on every
        # reconcile (converted_version is NULL != latest), wedging the queue.
        reconcile(self.conn, [("nm000001", "1.0.0"), ("nm000002", "1.0.0")], 3600)
        claim_next(self.conn)
        mark_fail(self.conn, "nm000001", "boom", 1, 1800)  # -> failed (infra, exhausted)
        claim_next(self.conn)
        mark_fail(self.conn, "nm000002", "unreadable", 5, 1800, deterministic=True)  # -> data_failed
        res = reconcile(self.conn, [("nm000001", "1.0.0"), ("nm000002", "1.0.0")], 3600)
        self.assertEqual(res["enqueued"], 0)
        self.assertEqual(self.status("nm000001"), "failed")
        self.assertEqual(self.status("nm000002"), "data_failed")

    def test_reconcile_requeues_terminal_on_new_version(self):
        # A genuinely new snapshot DOES retry a terminal failure from scratch.
        reconcile(self.conn, [("nm000001", "1.0.0"), ("nm000002", "1.0.0")], 3600)
        claim_next(self.conn)
        mark_fail(self.conn, "nm000001", "boom", 1, 1800)  # -> failed
        claim_next(self.conn)
        mark_fail(self.conn, "nm000002", "unreadable", 5, 1800, deterministic=True)  # -> data_failed
        res = reconcile(self.conn, [("nm000001", "2.0.0"), ("nm000002", "2.0.0")], 3600)
        self.assertEqual(res["enqueued"], 2)
        self.assertEqual(self.status("nm000001"), "pending")
        self.assertEqual(self.status("nm000002"), "pending")
        # attempts reset so the new version gets its full retry budget.
        row = self.conn.execute(
            "SELECT attempts, last_error FROM jobs WHERE dataset_id='nm000001'"
        ).fetchone()
        self.assertEqual(row["attempts"], 0)
        self.assertIsNone(row["last_error"])

    def test_data_failed_not_claimable(self):
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        claim_next(self.conn)
        mark_fail(self.conn, "nm000001", "unreadable", 5, 1800, deterministic=True)
        # terminal -> never handed back out by claim_next
        self.assertIsNone(claim_next(self.conn))

    def converted_version(self, dataset_id):
        r = self.conn.execute(
            "SELECT converted_version FROM jobs WHERE dataset_id=?", (dataset_id,)
        ).fetchone()
        return r["converted_version"] if r else None

    def test_mark_done_stores_canonical_v_tag(self):
        # A bare version from the catalog must land in the column as the canonical
        # tag, so `converted_version` is uniform for any future comparison written
        # without _vtag (222 live rows had drifted to the bare form).
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        claim_next(self.conn)
        mark_done(self.conn, "nm000001", "1.0.0")
        self.assertEqual(self.converted_version("nm000001"), "v1.0.0")

    def test_mark_done_leaves_tagged_version_untouched(self):
        reconcile(self.conn, [("nm000001", "v1.2.3")], 3600)
        claim_next(self.conn)
        mark_done(self.conn, "nm000001", "v1.2.3")
        self.assertEqual(self.converted_version("nm000001"), "v1.2.3")

    def test_mark_done_normalization_does_not_requeue(self):
        # The normalized write must still compare equal to a bare catalog version
        # on the next reconcile -- otherwise every dataset re-converts forever.
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        claim_next(self.conn)
        mark_done(self.conn, "nm000001", "1.0.0")
        res = reconcile(self.conn, [("nm000001", "1.0.0")], 3600)
        self.assertEqual(res["enqueued"], 0)
        self.assertEqual(self.status("nm000001"), "done")



class RequeueTest(unittest.TestCase):
    """#1113: recovering datasets the OOM defect and its misclassification buried."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = connect(os.path.join(self._tmp.name, "q.db"))
        reconcile(self.conn, [("nm000001", "v1"), ("nm000002", "v1"), ("nm000003", "v1")], 3600)
        # nm1: retry budget exhausted on infra errors.
        for _ in range(5):
            mark_fail(self.conn, "nm000001", "worker crashed", max_attempts=5, backoff_base=1)
        # nm2: terminal by the (previously wrong) deterministic classifier.
        mark_fail(self.conn, "nm000002", "all data failures", 5, 1, deterministic=True)
        # nm3 stays pending and must not be touched.

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def _status(self, dataset_id):
        return self.conn.execute(
            "SELECT status, attempts FROM jobs WHERE dataset_id=?", (dataset_id,)
        ).fetchone()

    def test_setup_is_what_we_think(self):
        self.assertEqual(self._status("nm000001")["status"], "failed")
        self.assertEqual(self._status("nm000001")["attempts"], 5)
        self.assertEqual(self._status("nm000002")["status"], "data_failed")
        self.assertEqual(self._status("nm000003")["status"], "pending")

    def test_dry_run_reports_without_changing_anything(self):
        # Requeue un-does a deliberate give-up, so seeing the scope first is the
        # default rather than an option.
        rows = requeue(self.conn, ("failed",))
        self.assertEqual([r[0] for r in rows], ["nm000001"])
        self.assertEqual(self._status("nm000001")["status"], "failed")

    def test_execute_resets_status_and_the_retry_budget(self):
        # attempts must reset too: the budget was spent on a defect that no
        # longer exists, so leaving it at 5 would give the dataset one attempt.
        requeue(self.conn, ("failed",), execute=True)
        row = self._status("nm000001")
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["attempts"], 0)

    def test_failed_only_leaves_data_failed_alone(self):
        requeue(self.conn, ("failed",), execute=True)
        self.assertEqual(self._status("nm000002")["status"], "data_failed")

    def test_all_covers_both_terminal_states(self):
        requeue(self.conn, ("failed", "data_failed"), execute=True)
        self.assertEqual(self._status("nm000001")["status"], "pending")
        self.assertEqual(self._status("nm000002")["status"], "pending")

    def test_a_single_dataset_can_be_targeted(self):
        for _ in range(5):
            mark_fail(self.conn, "nm000003", "worker crashed", max_attempts=5, backoff_base=1)
        requeue(self.conn, ("failed",), dataset_id="nm000001", execute=True)
        self.assertEqual(self._status("nm000001")["status"], "pending")
        self.assertEqual(self._status("nm000003")["status"], "failed")

    def test_multiple_statuses_and_a_dataset_filter_together(self):
        # The parameter shape most likely to hide a placeholder/order slip: two
        # status placeholders AND an appended dataset_id, in both the SELECT and
        # the UPDATE. Nothing else covers it, and this is the function where a
        # wrong requeue resets the wrong production rows.
        for _ in range(5):
            mark_fail(self.conn, "nm000003", "worker crashed", max_attempts=5, backoff_base=1)
        rows = requeue(
            self.conn, ("failed", "data_failed"), dataset_id="nm000002", execute=True
        )
        self.assertEqual([r[0] for r in rows], ["nm000002"])
        self.assertEqual(self._status("nm000002")["status"], "pending")
        # The other terminal rows in BOTH statuses must be untouched.
        self.assertEqual(self._status("nm000001")["status"], "failed")
        self.assertEqual(self._status("nm000003")["status"], "failed")

    def test_done_is_reachable_but_never_swept_up_by_all(self):
        # A run where anything converted is marked `done`, so a recording that
        # failed for a retryable reason is stranded in a `done` row (#1113).
        # Requeue must be able to reach it -- but `all` must NOT include it, or a
        # routine recovery would re-convert the entire archive.
        mark_done(self.conn, "nm000003", "v1")
        self.assertEqual(self._status("nm000003")["status"], "done")

        requeue(self.conn, ("failed", "data_failed"), execute=True)
        self.assertEqual(
            self._status("nm000003")["status"], "done", "`all` must not touch done"
        )

        requeue(self.conn, ("done",), dataset_id="nm000003", execute=True)
        self.assertEqual(self._status("nm000003")["status"], "pending")

    def test_healthy_jobs_are_never_touched(self):
        before = self._status("nm000003")["attempts"]
        requeue(self.conn, ("failed", "data_failed"), execute=True)
        self.assertEqual(self._status("nm000003")["status"], "pending")
        self.assertEqual(self._status("nm000003")["attempts"], before)

    def test_requeued_jobs_are_immediately_claimable(self):
        # next_retry_at must clear, or a requeued job sits behind a backoff that
        # was set when it last failed.
        requeue(self.conn, ("failed",), execute=True)
        claimed = set()
        while (row := claim_next(self.conn)) is not None:
            claimed.add(row["dataset_id"])
        self.assertIn("nm000001", claimed)

    def test_requeueing_nothing_is_not_an_error(self):
        self.assertEqual(requeue(self.conn, ("failed",), dataset_id="nope"), [])


class UnlistedSweepTest(unittest.TestCase):
    """Datasets the catalog stops listing must stop being converted (#1048).

    Withdrawn datasets sat `pending` forever: every run cloned them, failed on
    content that is 0-byte by design, and wrote failure lines. They vanish from
    `GET /datasets` on withdrawal, so reconcile never sees them again and its
    add-and-update-only logic left the rows untouched.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = connect(os.path.join(self._tmp.name, "q.db"))
        reconcile(self.conn, [("nm000001", "1.0.0"), ("on000002", "1.0.0")], 3600)

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def status(self, dataset_id):
        r = self.conn.execute(
            "SELECT status FROM jobs WHERE dataset_id=?", (dataset_id,)
        ).fetchone()
        return r["status"] if r else None

    def test_absent_dataset_is_parked(self):
        res = reconcile(self.conn, [("nm000001", "1.0.0")], 3600, listing_complete=True)
        self.assertEqual(res["unlisted"], 1)
        self.assertEqual(self.status("on000002"), "unlisted")
        self.assertEqual(self.status("nm000001"), "pending")

    def test_parked_dataset_is_never_claimed(self):
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600, listing_complete=True)
        claimed = set()
        while (row := claim_next(self.conn)) is not None:
            claimed.add(row["dataset_id"])
        self.assertEqual(claimed, {"nm000001"})

    def test_partial_catalog_read_parks_nothing(self):
        """The guard that stops a truncated fetch from emptying the queue."""
        res = reconcile(self.conn, [("nm000001", "1.0.0")], 3600, listing_complete=False)
        self.assertEqual(res["unlisted"], 0)
        self.assertEqual(self.status("on000002"), "pending")

    def test_relisted_dataset_returns_to_pending(self):
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600, listing_complete=True)
        self.assertEqual(self.status("on000002"), "unlisted")
        res = reconcile(
            self.conn,
            [("nm000001", "1.0.0"), ("on000002", "1.0.0")],
            3600,
            listing_complete=True,
        )
        self.assertEqual(res["unlisted"], 0)
        self.assertEqual(self.status("on000002"), "pending")

    def test_parking_preserves_converted_version(self):
        """Parked, not deleted: a dataset that comes back must not reconvert
        work we already have."""
        mark_done(self.conn, "on000002", "1.0.0")
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600, listing_complete=True)
        row = self.conn.execute(
            "SELECT converted_version FROM jobs WHERE dataset_id=?", ("on000002",)
        ).fetchone()
        self.assertEqual(row["converted_version"], "v1.0.0")

    def test_inprogress_row_is_left_to_its_converter(self):
        """A worker holds that row right now; its own completion decides."""
        claim_next(self.conn)  # nm000001, the older row
        claimed = claim_next(self.conn)
        self.assertEqual(claimed["dataset_id"], "on000002")
        res = reconcile(self.conn, [("nm000001", "1.0.0")], 3600, listing_complete=True)
        self.assertEqual(res["unlisted"], 0)
        self.assertEqual(self.status("on000002"), "inprogress")

    def test_terminal_rows_are_parked_too(self):
        """A withdrawn dataset that already burned its retries still stops
        showing up in the failure listing."""
        mark_fail(self.conn, "on000002", "boom", max_attempts=1, backoff_base=1)
        self.assertEqual(self.status("on000002"), "failed")
        reconcile(self.conn, [("nm000001", "1.0.0")], 3600, listing_complete=True)
        self.assertEqual(self.status("on000002"), "unlisted")

    def test_unrecognized_ids_are_counted_not_silently_dropped(self):
        """An ID the queue cannot parse never enters it. Counting that is the
        only way the log distinguishes it from an ordinary quiet run, where most
        rows are already `done` and `enqueued` is legitimately 0."""
        res = reconcile(
            self.conn,
            [("nm000001", "1.0.0"), ("NM000001", "1.0.0"), ("ds000117", "1.0.0")],
            3600,
        )
        self.assertEqual(res["rejected"], 2)

    def test_the_e2e_fixture_is_an_expected_skip_not_a_rejection(self):
        """nm099999 is deliberately never converted; counting it as rejected
        would put a permanent non-zero anomaly in every single run's summary."""
        res = reconcile(self.conn, [("nm000001", "1.0.0"), ("nm099999", "1.0.0")], 3600)
        self.assertEqual(res["rejected"], 0)

    def test_relisting_an_exhausted_row_restores_its_full_retry_budget(self):
        """A row that failed its way to terminal, was parked, and later came back
        must convert again -- not arrive one failure from terminal.

        The relist branch resets attempts/last_error/next_retry_at precisely so
        the row is not judged on failures that happened while the dataset was in
        a different state. Without that reset the dataset would go straight back
        to terminal on its next hiccup and silently stay unconverted.
        """
        mark_fail(self.conn, "on000002", "boom", max_attempts=1, backoff_base=1)
        self.assertEqual(self.status("on000002"), "failed")
        row = self.conn.execute(
            "SELECT attempts, last_error FROM jobs WHERE dataset_id='on000002'"
        ).fetchone()
        self.assertGreater(row["attempts"], 0)  # guard: the case is real
        self.assertIsNotNone(row["last_error"])

        reconcile(self.conn, [("nm000001", "1.0.0")], 3600, listing_complete=True)
        self.assertEqual(self.status("on000002"), "unlisted")

        reconcile(
            self.conn,
            [("nm000001", "1.0.0"), ("on000002", "1.0.0")],
            3600,
            listing_complete=True,
        )
        self.assertEqual(self.status("on000002"), "pending")
        back = self.conn.execute(
            "SELECT attempts, last_error, next_retry_at FROM jobs WHERE dataset_id='on000002'"
        ).fetchone()
        self.assertEqual(back["attempts"], 0)
        self.assertIsNone(back["last_error"])
        self.assertEqual(back["next_retry_at"], 0)


class EngineStampMigrationTest(unittest.TestCase):
    """#1172: the migration that must NOT requeue the archive.

    The production queue predates the `engine_version` column, so every one of
    its ~667 `done` rows arrives NULL. Reading NULL as "old engine" would put the
    whole archive back through conversion on the next cron tick; the migration
    therefore seeds them to the CURRENT version and leaves the genuinely stranded
    cohort to the targeted `backfill-dir-formats` sweep.
    """

    # The jobs table exactly as it stood before this change: a real pre-migration
    # database, not a stand-in for one.
    PRE_MIGRATION_SCHEMA = """
    CREATE TABLE IF NOT EXISTS jobs (
      dataset_id        TEXT PRIMARY KEY,
      latest_version    TEXT,
      converted_version TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      attempts          INTEGER NOT NULL DEFAULT 0,
      last_error        TEXT,
      next_retry_at     INTEGER NOT NULL DEFAULT 0,
      enqueued_at       TEXT,
      updated_at        INTEGER NOT NULL DEFAULT 0
    );
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self._tmp.name, "old.db")
        old = sqlite3.connect(self.db)
        old.executescript(self.PRE_MIGRATION_SCHEMA)
        old.executemany(
            "INSERT INTO jobs(dataset_id, latest_version, converted_version, status,"
            " enqueued_at, updated_at) VALUES(?,?,?,?,?,?)",
            [
                ("nm000001", "v1.0.0", "v1.0.0", "done", "2026-01-01T00:00:00Z", 0),
                ("on000002", "v2.0.0", "v2.0.0", "done", "2026-01-01T00:00:01Z", 0),
                ("nm000003", "v1.0.0", None, "pending", "2026-01-01T00:00:02Z", 0),
            ],
        )
        old.commit()
        old.close()

    def tearDown(self):
        self._tmp.cleanup()

    def _open(self):
        """connect() with its one-time migration notice captured, not printed."""
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            conn = connect(self.db)
        return conn, buf.getvalue()

    def stamps(self, conn):
        return {
            r["dataset_id"]: r["engine_version"]
            for r in conn.execute("SELECT dataset_id, engine_version FROM jobs")
        }

    def test_the_pre_migration_db_really_lacks_the_column(self):
        # Guard on the fixture itself: if this ever passes trivially, every other
        # assertion in this class is testing nothing.
        raw = sqlite3.connect(self.db)
        cols = {r[1] for r in raw.execute("PRAGMA table_info(jobs)")}
        raw.close()
        self.assertNotIn("engine_version", cols)

    def test_connect_adds_the_column_and_seeds_every_null_to_current(self):
        conn, _ = self._open()
        self.addCleanup(conn.close)
        self.assertEqual(
            self.stamps(conn),
            {
                "nm000001": ZARR_ENGINE_VERSION,
                "on000002": ZARR_ENGINE_VERSION,
                "nm000003": ZARR_ENGINE_VERSION,
            },
        )

    def test_the_migration_announces_itself(self):
        # The single most consequential thing this file does to a live queue is
        # declare hundreds of rows current instead of requeuing them. It must
        # leave a trace in the cron log.
        _, notice = self._open()
        self.assertIn("3", notice)
        self.assertIn("engine_version", notice)

    def test_migrated_rows_are_not_requeued_by_the_next_reconcile(self):
        """The whole point: no mass reconversion on the first post-upgrade run."""
        conn, _ = self._open()
        self.addCleanup(conn.close)
        res = reconcile(conn, [("nm000001", "v1.0.0"), ("on000002", "v2.0.0")], 3600)
        self.assertEqual(res["enqueued"], 0)
        self.assertEqual(res["engine_stale"], 0)
        self.assertEqual(res["engine_requeued"], 0)
        statuses = {
            r["dataset_id"]: r["status"]
            for r in conn.execute("SELECT dataset_id, status FROM jobs")
        }
        self.assertEqual(statuses["nm000001"], "done")
        self.assertEqual(statuses["on000002"], "done")

    def test_migration_is_idempotent(self):
        conn, _ = self._open()
        self.addCleanup(conn.close)
        self.assertEqual(migrate_schema(conn), 0)
        conn2, notice = self._open()
        self.addCleanup(conn2.close)
        self.assertEqual(notice, "")

    def test_a_fresh_db_has_the_column_and_seeds_nothing(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            conn = connect(os.path.join(tmp.name, "new.db"))
        self.addCleanup(conn.close)
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(jobs)")}
        self.assertIn("engine_version", cols)
        self.assertEqual(buf.getvalue(), "")


class EngineStampRequeueTest(unittest.TestCase):
    """#1172: a widened engine reaches the back catalog through the stamp.

    An engine upgrade bumps no dataset version, so before this the version
    comparison in `reconcile` was the only requeue trigger and every
    already-converted dataset stayed on the rules it was converted under.
    """

    OLD_ENGINE = "1"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = connect(os.path.join(self._tmp.name, "q.db"))
        reconcile(self.conn, [("nm000001", "v1.0.0")], 3600)
        claim_next(self.conn)

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def row(self, dataset_id="nm000001"):
        return self.conn.execute(
            "SELECT status, latest_version, converted_version, engine_version, attempts"
            " FROM jobs WHERE dataset_id=?",
            (dataset_id,),
        ).fetchone()

    def test_done_stamps_the_current_engine(self):
        mark_done(self.conn, "nm000001", "v1.0.0")
        self.assertEqual(self.row()["engine_version"], ZARR_ENGINE_VERSION)

    def test_a_stale_stamp_requeues_at_the_same_version(self):
        mark_done(self.conn, "nm000001", "v1.0.0", engine_version=self.OLD_ENGINE)
        res = reconcile(self.conn, [("nm000001", "v1.0.0")], 3600)
        self.assertEqual(res["enqueued"], 1)
        self.assertEqual(res["engine_stale"], 1)
        self.assertEqual(res["engine_requeued"], 1)
        self.assertEqual(self.row()["status"], "pending")

    def test_a_current_stamp_is_left_alone(self):
        mark_done(self.conn, "nm000001", "v1.0.0")
        res = reconcile(self.conn, [("nm000001", "v1.0.0")], 3600)
        self.assertEqual((res["enqueued"], res["engine_stale"]), (0, 0))
        self.assertEqual(self.row()["status"], "done")

    def test_the_guard_flag_suppresses_the_requeue_but_still_counts_it(self):
        # `--no-engine-requeue` exists so the cost of a bump can be read off a
        # run before it is paid; a suppressed requeue that also reported zero
        # would make the flag useless.
        mark_done(self.conn, "nm000001", "v1.0.0", engine_version=self.OLD_ENGINE)
        res = reconcile(self.conn, [("nm000001", "v1.0.0")], 3600, engine_requeue=False)
        self.assertEqual(res["engine_stale"], 1)
        self.assertEqual(res["engine_requeued"], 0)
        self.assertEqual(res["enqueued"], 0)
        self.assertEqual(self.row()["status"], "done")

    def test_a_null_stamp_is_never_stale(self):
        """Fail-safe: a NULL that escaped the migration must not requeue.

        `migrate_schema` seeds every pre-existing row, so this should be
        unreachable -- which is exactly why the behaviour needs pinning. If a
        NULL ever does appear (an older driver writing into a migrated DB, a
        hand-edited row), the wrong reading of it re-converts the entire archive.
        """
        mark_done(self.conn, "nm000001", "v1.0.0")
        self.conn.execute("UPDATE jobs SET engine_version=NULL WHERE dataset_id='nm000001'")
        self.conn.commit()
        res = reconcile(self.conn, [("nm000001", "v1.0.0")], 3600)
        self.assertEqual((res["enqueued"], res["engine_stale"]), (0, 0))
        self.assertEqual(self.row()["status"], "done")

    def test_a_version_change_still_requeues_and_is_not_double_counted(self):
        # A row with both a new version and a stale stamp would re-convert
        # anyway, so it is attributed to the version -- `engine_requeued` reports
        # the MARGINAL cost of a bump, not the overlap.
        mark_done(self.conn, "nm000001", "v1.0.0", engine_version=self.OLD_ENGINE)
        res = reconcile(self.conn, [("nm000001", "v2.0.0")], 3600)
        self.assertEqual(res["enqueued"], 1)
        self.assertEqual(res["engine_stale"], 1)
        self.assertEqual(res["engine_requeued"], 0)
        row = self.row()
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["latest_version"], "v2.0.0")

    def test_a_stamp_only_requeue_keeps_the_version_to_convert(self):
        # The drain reads `latest_version` off the claimed row; blanking it would
        # hand the converter an empty target.
        mark_done(self.conn, "nm000001", "v1.0.0", engine_version=self.OLD_ENGINE)
        reconcile(self.conn, [("nm000001", "")], 3600)
        row = self.row()
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["latest_version"], "v1.0.0")

    def test_the_requeued_row_converts_and_restamps_to_current(self):
        mark_done(self.conn, "nm000001", "v1.0.0", engine_version=self.OLD_ENGINE)
        reconcile(self.conn, [("nm000001", "v1.0.0")], 3600)
        claimed = claim_next(self.conn)
        self.assertEqual(claimed["dataset_id"], "nm000001")
        mark_done(self.conn, "nm000001", claimed["latest_version"])
        self.assertEqual(self.row()["engine_version"], ZARR_ENGINE_VERSION)
        # ... and the next reconcile is quiet again, so a bump requeues once.
        res = reconcile(self.conn, [("nm000001", "v1.0.0")], 3600)
        self.assertEqual((res["enqueued"], res["engine_stale"]), (0, 0))

    def test_the_stamp_governs_done_rows_only(self):
        # A terminal row is terminal for reasons the stamp knows nothing about
        # (#774). Widening discovery does not make an unreadable recording
        # readable, so an engine bump must not revive `failed`/`data_failed`.
        mark_fail(self.conn, "nm000001", "unreadable", 5, 1800, deterministic=True)
        self.conn.execute("UPDATE jobs SET engine_version=? WHERE dataset_id='nm000001'", ("1",))
        self.conn.commit()
        res = reconcile(self.conn, [("nm000001", "v1.0.0")], 3600)
        self.assertEqual((res["enqueued"], res["engine_stale"]), (0, 0))
        self.assertEqual(self.row()["status"], "data_failed")


class DirFormatDetectionTest(unittest.TestCase):
    """#1172: which datasets the one-off sweep considers, and what it looks for.

    The detectors themselves are imported from `generate_zarr` rather than
    restated, so these assert the wiring and the exclusions that matter here --
    not a second copy of the format rules.
    """

    def test_meg_and_ieeg_are_the_carriers(self):
        for modalities in ("meg", "ieeg", "anat,meg", "beh,ieeg", "eeg,meg", "MEG"):
            self.assertTrue(may_carry_dir_formats(modalities), modalities)
        for modalities in ("eeg", "emg", "beh,eeg", "anat,eeg,func"):
            self.assertFalse(may_carry_dir_formats(modalities), modalities)

    def test_an_unknown_modality_is_probed_not_skipped(self):
        # A catalog row with no modalities is what an un-backfilled OpenNeuro
        # import looks like (nemar-cli#512) -- exactly the under-described shape
        # this sweep exists to find, so it must not be filtered out.
        self.assertTrue(may_carry_dir_formats(""))
        self.assertTrue(may_carry_dir_formats(None))
        self.assertTrue(may_carry_dir_formats("  ,  "))

    def test_directory_recordings_are_found_from_their_member_files(self):
        paths = {
            "sub-01/ieeg/sub-01_task-x_ieeg.mefd/c1.timd/c1-000000.segd/c1.tdat",
            "sub-02/meg/sub-02_task-y_meg.ds/sub-02_task-y_meg.meg4",
            "sub-03/meg/sub-03_task-z_meg/c,rfDC",
            "sub-03/meg/sub-03_task-z_meg/config",
            "sub-04/eeg/sub-04_task-w_eeg.set",
            "participants.tsv",
        }
        self.assertEqual(
            dir_format_recordings(paths),
            {
                "sub-01/ieeg/sub-01_task-x_ieeg.mefd",
                "sub-02/meg/sub-02_task-y_meg.ds",
                "sub-03/meg/sub-03_task-z_meg",
            },
        )

    def test_a_bare_config_file_is_not_a_bti_recording(self):
        # `.datalad/config` exists in virtually every dataset here; treating
        # `config` alone as the marker would report every repo as a stranded
        # BTi recording and requeue the archive.
        self.assertEqual(
            dir_format_recordings({".datalad/config", "dataset_description.json"}), set()
        )

    def test_excluded_trees_are_not_counted_as_missing(self):
        # The converter would not build these either (ADR 0027), so a dataset is
        # not stranded for lacking them.
        paths = {
            "derivatives/pipe/sub-01/meg/sub-01_task-x_meg.ds/x.meg4",
            "sourcedata/sub-01/ieeg/sub-01_task-x_ieeg.mefd/c1.timd/c1.tdat",
            "code/demo_meg.ds/x.meg4",
        }
        self.assertEqual(dir_format_recordings(paths), set())


class BackfillClassificationTest(unittest.TestCase):
    """#1172: is this dataset stranded, and on what evidence."""

    MEFD = "sub-01/ieeg/sub-01_task-x_ieeg.mefd"
    PATHS = {
        f"{MEFD}/c1.timd/c1-000000.segd/c1.tdat",
        "sub-01/eeg/sub-01_task-x_eeg.set",
        "participants.tsv",
    }

    ZARR = "sub-01/ieeg/sub-01_task-x_ieeg.zarr"

    def index(self, stores, failures=None):
        failures = failures or []
        return {
            "dataset_id": "on004696",
            "format": "nemar-zarr-index",
            "store_count": len(stores),
            "stores": stores,
            "failure_count": len(failures),
            "failures": failures,
        }

    def test_a_recorded_failure_is_not_a_discovery_miss(self):
        """The precision rule, found by running the sweep against production.

        A directory recording listed in `failures` was SEEN by the converter: the
        pre-#1095 engine could not have put it there, since it did not recognise
        the directory as a recording at all. Counting it as missing re-queues
        datasets whose `.ds` recordings a current engine has already tried and
        rejected -- on005752 alone would have re-queued 471 CTF MEG recordings.
        """
        doc = self.index(
            [{"path": "sub-01/eeg/x.set", "zarr": "sub-01/eeg/x.zarr"}],
            failures=[{"path": self.MEFD, "zarr": self.ZARR, "code": "unreadable"}],
        )
        got = classify_backfill("on004696", doc, self.PATHS)
        self.assertFalse(got["affected"], "a known failure is #1113's problem, not this one")
        self.assertEqual(got["reason"], "served")
        self.assertEqual(got["missing"], [])
        self.assertEqual(got["known_failed"], [self.MEFD])

    def test_the_two_buckets_are_reported_separately(self):
        # A dataset can have both, and the report must not merge them: one is
        # this sweep's business and the other is not.
        other = "sub-02/meg/sub-02_task-y_meg.ds"
        paths = set(self.PATHS) | {f"{other}/sub-02_task-y_meg.meg4"}
        doc = self.index(
            [{"path": "sub-01/eeg/x.set", "zarr": "sub-01/eeg/x.zarr"}],
            failures=[{"path": other, "zarr": "sub-02/meg/sub-02_task-y_meg.zarr"}],
        )
        unseen, failed = partition_dir_format_recordings(paths, doc)
        self.assertEqual(unseen, [self.MEFD])
        self.assertEqual(failed, [other])
        got = classify_backfill("on004696", doc, paths)
        self.assertTrue(got["affected"])
        self.assertEqual(got["reason"], "dir_stores_missing")

    def test_a_served_recording_is_in_neither_bucket(self):
        doc = self.index([{"path": self.MEFD, "zarr": self.ZARR}])
        self.assertEqual(partition_dir_format_recordings(self.PATHS, doc), ([], []))

    def test_a_failure_matched_by_its_zarr_rel_path_alone_still_counts(self):
        doc = self.index(
            [{"path": "sub-01/eeg/x.set", "zarr": "sub-01/eeg/x.zarr"}],
            failures=[{"zarr": self.ZARR}],
        )
        self.assertEqual(partition_dir_format_recordings(self.PATHS, doc), ([], [self.MEFD]))

    def test_index_failure_keys_reads_the_failures_list(self):
        paths, rels = index_failure_keys(
            {"failures": [{"path": "a.ds", "zarr": "a.zarr"}, "junk", {}]}
        )
        self.assertEqual(paths, {"a.ds"})
        self.assertEqual(rels, {"a.zarr"})
        self.assertEqual(index_failure_keys(None), (set(), set()))
        self.assertEqual(index_failure_keys({"stores": [{"path": "a.ds"}]}), (set(), set()))

    def test_an_empty_index_stays_affected_even_with_recorded_failures(self):
        # store_count 0 is decisive on its own; the failure list only refines
        # which recordings are named as unseen.
        doc = self.index([], failures=[{"path": self.MEFD, "zarr": self.ZARR}])
        got = classify_backfill("on004696", doc, self.PATHS)
        self.assertTrue(got["affected"])
        self.assertEqual(got["reason"], "empty_index")
        self.assertEqual(got["missing"], [])
        self.assertEqual(got["known_failed"], [self.MEFD])

    def test_no_published_index_at_all(self):
        got = classify_backfill("on004696", None)
        self.assertTrue(got["affected"])
        self.assertEqual(got["reason"], "index_missing")

    def test_the_reference_case_empty_index(self):
        # on004696 as observed: store_count 0, failure_count 0 -- the pre-#1095
        # engine saw the `.mefd` directories as nothing at all, so they landed in
        # neither list and the run was marked done.
        got = classify_backfill("on004696", self.index([]), self.PATHS)
        self.assertTrue(got["affected"])
        self.assertEqual(got["reason"], "empty_index")
        self.assertEqual(got["store_count"], 0)
        self.assertEqual(got["missing"], [self.MEFD])

    def test_an_empty_index_is_affected_even_without_a_probe(self):
        got = classify_backfill("on004696", self.index([]))
        self.assertTrue(got["affected"])
        self.assertEqual(got["reason"], "empty_index")
        self.assertEqual(got["missing"], [])

    def test_the_partial_case_some_stores_but_no_directory_store(self):
        # What rule (a) alone cannot see: an EEG store exists, so the index is
        # not empty, but the dataset's one `.mefd` recording was never converted.
        got = classify_backfill(
            "on004696",
            self.index(
                [
                    {
                        "path": "sub-01/eeg/sub-01_task-x_eeg.set",
                        "zarr": "sub-01/eeg/sub-01_task-x_eeg.zarr",
                    }
                ]
            ),
            self.PATHS,
        )
        self.assertTrue(got["affected"])
        self.assertEqual(got["reason"], "dir_stores_missing")
        self.assertEqual(got["missing"], [self.MEFD])

    def test_a_served_directory_recording_is_not_affected(self):
        got = classify_backfill(
            "on004696",
            self.index(
                [
                    {"path": self.MEFD, "zarr": "sub-01/ieeg/sub-01_task-x_ieeg.zarr"},
                    {
                        "path": "sub-01/eeg/sub-01_task-x_eeg.set",
                        "zarr": "sub-01/eeg/sub-01_task-x_eeg.zarr",
                    },
                ]
            ),
            self.PATHS,
        )
        self.assertFalse(got["affected"])
        self.assertEqual(got["reason"], "served")

    def test_a_store_matched_by_its_zarr_rel_path_alone_still_counts_as_served(self):
        # Either key identifies a store; a half-written entry must not be read
        # as a missing conversion and re-converted.
        got = classify_backfill(
            "on004696",
            self.index([{"zarr": "sub-01/ieeg/sub-01_task-x_ieeg.zarr"}]),
            self.PATHS,
        )
        self.assertFalse(got["affected"])

    def test_unprobed_is_reported_but_never_requeued(self):
        # `--no-probe` cannot rule out the partial case, and requeuing on an
        # unfinished check would re-convert datasets on no evidence.
        got = classify_backfill(
            "on004696",
            self.index([{"path": "sub-01/eeg/x.set", "zarr": "sub-01/eeg/x.zarr"}]),
        )
        self.assertFalse(got["affected"])
        self.assertEqual(got["reason"], "not_probed")

    def test_the_entries_outrank_a_disagreeing_store_count(self):
        # The viewer reads the entries, so judge the document by what it serves.
        doc = self.index([])
        doc["store_count"] = 7
        self.assertEqual(classify_backfill("on004696", doc)["store_count"], 0)

    def test_index_store_keys_tolerates_a_malformed_document(self):
        paths, rels = index_store_keys(
            {"stores": ["not-a-dict", {"path": "a.set"}, {"zarr": "b.zarr"}, {}]}
        )
        self.assertEqual(paths, {"a.set"})
        self.assertEqual(rels, {"b.zarr"})
        self.assertEqual(index_store_keys(None), (set(), set()))
        self.assertEqual(index_store_keys({}), (set(), set()))

    def test_missing_is_sorted_for_a_stable_report(self):
        paths = {
            "sub-02/meg/sub-02_meg.ds/x.meg4",
            "sub-01/ieeg/sub-01_ieeg.mefd/c1.timd/c1.tdat",
        }
        self.assertEqual(
            missing_dir_format_stores(paths, {"stores": []}),
            ["sub-01/ieeg/sub-01_ieeg.mefd", "sub-02/meg/sub-02_meg.ds"],
        )


if __name__ == "__main__":
    unittest.main()
