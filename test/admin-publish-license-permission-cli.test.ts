/**
 * `nemar admin dataset publish license-permission` records license evidence (ADR 0139, decision 7,
 * amendment of 2026-11-25; epic #2182, card B6).
 *
 * Real command, real backend app over a real D1 (`helpers/admin-publish-cli.ts`): the command posts
 * to `POST /admin/publish/:id/license-permission`; without --apply nothing is written, with it the
 * Worker writes the permission and its audit row; a refusal is the Worker's own sentence and a
 * non-zero exit; and the evidence text is never printed back.
 *
 * CI TIER: unit-pure. Hermetic: an in-process backend over a local database, the CLI spawned
 * against it, stand-ins only at GitHub and Resend, no live network; it sets its own default
 * timeout.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  evidenceFor,
  goodPublicationReport,
  seedPublicationReview,
} from "../backend/test/helpers/publication-review";
import { LICENSE_PERMISSION_REFUSAL_TEXT } from "../shared/license-permission";
import { PUBLICATION_PROMPT_VERSION, REVIEW_INPUTS } from "../shared/publication-review";
import { type CliResult, startPublishCli } from "./helpers/admin-publish-cli";
import { DATASET, seedUnstarted } from "./helpers/approve-seeds";

setDefaultTimeout(60_000);

const ADMIN_KEY = "licperm-cli-admin-key-0123456789abcdef0123456789";
const SOURCE = "10.18112/openneuro.ds000001.v1.0.0";
const EVIDENCE = "EVIDENCE-SENTINEL the authors' email accepts cc-by for this copy";

const h = startPublishCli();
afterAll(() => h.stop());

beforeEach(async () => {
  h.reset();
  await h.admin("licpermcliadmin", ADMIN_KEY);
});

const output = (r: CliResult) => `${r.stdout}\n${r.stderr}`;
const posts = () => h.posted.filter((p) => p.path.endsWith("/license-permission"));
const count = (sql: string) => (h.db.query(sql).get() as { n: number }).n;

/** The dataset's request, its review reported with a lineage that needs permission and its basis. */
function seeded(): { requestId: number; ticketId: number } {
  const requestId = seedUnstarted(h.db);
  const reviewId = seedPublicationReview(h.db, {
    requestId,
    datasetId: DATASET,
    state: "reported",
    report: goodPublicationReport({
      v: 2,
      evidence: {
        ...evidenceFor(),
        inputs: Object.fromEntries(REVIEW_INPUTS.map((i) => [i, "absent"])),
        lineage: { outcome: "needs_permission", credited: true },
      },
      note_answer: "not_asked",
      record: {
        prompt_version: PUBLICATION_PROMPT_VERSION,
        models: [{ model: "claude-haiku-5-5", effort: "high" }],
        input_digest: "ef".repeat(32),
        resolver_version: null,
        enrichment_source: null,
      },
    }),
  });
  h.db.run("UPDATE publication_reviews SET lineage_basis = ? WHERE id = ?", [
    JSON.stringify({
      outcome: "needs_permission",
      target_license: "cc-by",
      sources: [
        { id: SOURCE, license: "cc-by-nc-nd", license_version: "4.0", outcome: "needs_permission" },
      ],
    }),
    reviewId,
  ]);
  const ticket = h.db
    .query<{ id: number }, []>(
      `INSERT INTO mail_tickets (ref, queue_tag, requester_email)
       VALUES ('amber-falcon-river', 'support', 'authors@example.org') RETURNING id`,
    )
    .get();
  return { requestId, ticketId: ticket?.id as number };
}

const command = (ticket: string, ...rest: string[]) => [
  "admin",
  "dataset",
  "publish",
  "license-permission",
  DATASET,
  "--ticket",
  ticket,
  "--evidence",
  EVIDENCE,
  ...rest,
];

describe("license-permission", () => {
  test("a dry run prints the request, the outcome and the sources, and records nothing", async () => {
    const { requestId, ticketId } = seeded();
    const r = await h.cli(command(String(ticketId)));
    expect(r.exitCode).toBe(0);
    const out = output(r);
    expect(out).toContain(`request ${requestId}`);
    expect(out).toContain("License lineage: needs_permission");
    expect(out).toContain(`${SOURCE}: needs_permission; license cc-by-nc-nd 4.0`);
    expect(out).toContain("Dry run: nothing was recorded.");
    expect(out).not.toContain("EVIDENCE-SENTINEL");
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.body).toEqual({ ticket_id: ticketId, evidence: EVIDENCE });
    expect(count("SELECT COUNT(*) AS n FROM license_permissions")).toBe(0);
  });

  test("--apply records the permission and its audit row", async () => {
    const { ticketId } = seeded();
    const r = await h.cli(command(String(ticketId), "--apply"));
    expect(r.exitCode).toBe(0);
    const out = output(r);
    expect(out).toMatch(
      new RegExp(
        `License permission recorded on \\d{4}-\\d{2}-\\d{2} by licpermcliadmin, ticket ${ticketId}\\.`,
      ),
    );
    expect(out).not.toContain("EVIDENCE-SENTINEL");
    expect(count("SELECT COUNT(*) AS n FROM license_permissions")).toBe(1);
    expect(
      count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'license_permission_recorded'"),
    ).toBe(1);
  });

  test("an unknown ticket is refused in the Worker's words, and exits 1", async () => {
    seeded();
    const r = await h.cli(command("999999", "--apply"));
    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(LICENSE_PERMISSION_REFUSAL_TEXT.ticket_not_found);
    expect(count("SELECT COUNT(*) AS n FROM license_permissions")).toBe(0);
  });

  test("a --ticket that is not a number is refused before anything is sent", async () => {
    seeded();
    const r = await h.cli(command("abc"));
    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("--ticket needs a ticket number");
    expect(posts()).toHaveLength(0);
  });
});
