#!/usr/bin/env python3
"""Unit tests for the SQLite conversion queue (scripts/zarr/zarr_queue.py).

Real SQLite (a temp db per test), no mocks: exercises the enqueue / claim /
done / fail transitions, retry-backoff, version-bump requeue, and the crash
recovery (stale `inprogress` -> `pending`). The HTTP fetch is not tested here
(it hits the live API, validated by the cron run).

Run: python3 scripts/zarr/test_zarr_queue.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from zarr_queue import (  # type: ignore[import-not-found]  # noqa: E402
    backoff_seconds,
    claim_next,
    connect,
    mark_done,
    mark_fail,
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


if __name__ == "__main__":
    unittest.main()
