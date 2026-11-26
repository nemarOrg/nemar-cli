/**
 * `nemar admin dataset publish restore` reverses a denial (ADR 0139, decision 4).
 *
 * Real command, real backend app over a real D1 (`helpers/admin-publish-cli.ts`): the command posts
 * to `POST /admin/publish/:id/restore`, the Worker restores the dataset's newest denied request and
 * writes the audit row, and a refusal is the Worker's own sentence and a non-zero exit.
 *
 * CI TIER: unit-pure. Hermetic: an in-process backend over a local database, the CLI spawned
 * against it, stand-ins only at GitHub and Resend, no live network; it sets its own default
 * timeout.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { RESTORE_REFUSAL_TEXT } from "../shared/publication-auto-deny";
import { type CliResult, startPublishCli } from "./helpers/admin-publish-cli";
import { DATASET, seedUnstarted } from "./helpers/approve-seeds";

setDefaultTimeout(60_000);

const ADMIN_KEY = "restore-admin-key-0123456789abcdef0123456789abcdef";

const h = startPublishCli();
afterAll(() => h.stop());

beforeEach(async () => {
  h.reset();
  await h.admin("restoreadmin", ADMIN_KEY);
});

const output = (r: CliResult) => `${r.stdout}\n${r.stderr}`;
const restores = () => h.posted.filter((p) => p.path.endsWith("/restore"));
const row = (id: number) =>
  h.db
    .query<{ status: string; auto_denied: number }, [number]>(
      "SELECT status, auto_denied FROM publication_requests WHERE id = ?",
    )
    .get(id);

function deny(id: number, auto: boolean): void {
  h.db.run(
    `UPDATE publication_requests SET status = 'denied', denied_at = datetime('now'),
            denied_reason = 'question_failed', auto_denied = ? WHERE id = ?`,
    [auto ? 1 : 0, id],
  );
}

describe("restore", () => {
  test("restores the newest denied request, with --request-id, and writes the audit row", async () => {
    const id = seedUnstarted(h.db);
    deny(id, true);
    const r = await h.cli([
      "admin",
      "dataset",
      "publish",
      "restore",
      DATASET,
      "--request-id",
      String(id),
      "--yes",
    ]);
    expect(r.exitCode).toBe(0);
    expect(output(r)).toContain(`Request #${id} of ${DATASET} restored`);
    expect(restores()).toHaveLength(1);
    expect(restores()[0]?.body).toEqual({ request_id: id });
    expect(row(id)).toEqual({ status: "requested", auto_denied: 0 });
    const audit = h.db
      .query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'publication_restore'")
      .get() as { n: number };
    expect(audit.n).toBe(1);
  });

  test("a request that is not denied is refused in the Worker's words, and exits 1", async () => {
    const id = seedUnstarted(h.db);
    const r = await h.cli(["admin", "dataset", "publish", "restore", DATASET, "--yes"]);
    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(RESTORE_REFUSAL_TEXT.not_denied);
    expect(row(id)?.status).toBe("requested");
  });

  test("a --request-id that is not a number is refused before anything is sent", async () => {
    seedUnstarted(h.db);
    const r = await h.cli([
      "admin",
      "dataset",
      "publish",
      "restore",
      DATASET,
      "--request-id",
      "abc",
      "--yes",
    ]);
    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("--request-id needs a request number");
    expect(restores()).toHaveLength(0);
  });
});
