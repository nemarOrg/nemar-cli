---
name: sqlite-check-change-needs-table-rebuild
description: SQLite cannot alter a CHECK constraint; changing one is a table rebuild, and the rebuild must copy the rows before it creates any trigger that applies deltas
metadata:
  type: project
  recorded: 2026-11-04
  revalidate_after: 2027-02-04
---

`ALTER TABLE` in SQLite (and so on D1) cannot change or drop a CHECK constraint.
The only way to change one is the rebuild: create the new table, copy the rows, drop the old table, rename the new one, and recreate its indexes and triggers.
Found during the compute program (2026-11).

**The order inside the rebuild matters.**
If a trigger that applies deltas (a balance or a counter updated on insert) exists on the new table when the rows are copied, the copy fires it once per row and the totals are applied a second time on top of the values the rows already carry.
Copy the rows first, then create the triggers.

**What to do:**

- In the migration, `INSERT INTO new SELECT ... FROM old` before any `CREATE TRIGGER` on `new`, and recreate every index and trigger the old table had (a dropped table takes its triggers with it).
- Check the totals before and after the rebuild on a database with rows in it; an empty test database hides this.
- Run the migration against real local D1 and with `bun run migrations:d1-check` (`.memory/bun-test-lenient-vs-workerd.md`).
