---
name: d1-triggers-check-and-conflict-clauses
description: on D1, BEFORE INSERT triggers run before CHECK constraints, the outer statement's conflict clause overrides the one inside a trigger body, and REPLACE does not fire DELETE triggers; an append-only table needs triggers that refuse bad rows whatever the conflict clause, plus a source scan
metadata:
  type: project
  recorded: 2026-11-04
  revalidate_after: 2027-02-04
---

Three SQLite behaviours that matter together when a table is meant to be append-only (a ledger, an audit log), found during the compute program (2026-11):

1. **A BEFORE INSERT trigger runs before the table's CHECK constraints.**
   A row that a CHECK would reject has already been seen by the trigger, so a trigger that applies a delta (a balance, a counter) acts on a row the table was about to refuse.
2. **A conflict clause on the OUTER statement overrides the one inside a trigger body.**
   `INSERT OR IGNORE`, `OR FAIL` and `OR REPLACE` on the statement that fires the trigger decide how a conflict is handled, whatever the trigger's own statements say.
3. **`REPLACE` does not fire a DELETE trigger.**
   Recursive triggers cannot be enabled on D1, so the delete that `INSERT OR REPLACE` performs is invisible to an append-only DELETE trigger, and the old row can be overwritten without the trigger seeing it.

**Why it matters:** a table whose append-only guarantee rests on a DELETE trigger, or on a CHECK, can be changed by the right conflict clause on a plain-looking write.

**What to do:**

- Put the refusal in BEFORE triggers that reject a bad row themselves (so the outcome does not depend on the outer conflict clause) rather than relying on a CHECK or on a DELETE trigger alone.
- Add a source scan test that fails when any code writes to the table with `OR IGNORE`, `OR REPLACE`, `OR FAIL` or `REPLACE INTO`.
- Prove it the way `.rules/testing.md` says: run the real statement with each conflict clause against a migrated database and watch the guard hold, then remove the guard and watch the test fail.
- Run the migration against real local D1 before merging (`.memory/bun-test-lenient-vs-workerd.md`): `bun:sqlite` is a different engine build.
