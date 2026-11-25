/**
 * `nemar dataset publish request --note | --note-file`, the question asked after a denial, and how
 * an administrator reads the note (ADR 0139, decision 5, card B3), through the real command against
 * the real backend app (`helpers/admin-publish-cli.ts`): the CLI is a spawned child, the NEMAR API is
 * the backend's own routes over bun:sqlite with every migration applied, and only GitHub and Resend
 * are stand-ins. A test reads the database the command wrote.
 *
 * The question is asked only after a DENIAL that was not a withdrawal (ADR 0104 stores a withdrawal
 * as denied, with `withdrawn_at`), at a terminal (a pseudo-terminal, so `process.stdin.isTTY` is
 * true), and never in a session with no terminal, which is told a note can be added and goes on.
 *
 * CI TIER: unit-pure. Hermetic: an in-process backend over a local database, the CLI spawned
 * against it, stand-ins only at GitHub and Resend, no live network; it sets its own default
 * timeout.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTO_DENY_AUDIT_ACTION, RESUBMISSION_NOTE_OFFER } from "../shared/resubmission-note";
import { type CliResult, startPublishCli } from "./helpers/admin-publish-cli";

setDefaultTimeout(60_000);

const DATASET = "nm000471";
const OWNER_KEY = "note-cli-owner-key-0123456789abcdef0123456789abcdef";
const ADMIN_KEY = "note-cli-admin-key-0123456789abcdef0123456789abcdef";

const h = startPublishCli();
afterAll(() => h.stop());

let ownerId: number;
let adminId: number;

/** Everything the command printed. The spinner writes its verdict to standard error. */
const output = (r: CliResult) => `${r.stdout}\n${r.stderr}`;

beforeEach(async () => {
  h.reset();
  ownerId = await h.user("cliowner", "member", OWNER_KEY);
  adminId = await h.admin("cliadmin", ADMIN_KEY);
  h.db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox, github_repo)
     VALUES (?, 'A sufficiently descriptive title', ?, 'active', 'private', 0, ?)`,
    [DATASET, ownerId, `nemarDatasets/${DATASET}`],
  );
});

/** A finished request, as a denial or a withdrawal leaves it (the shapes of routes and 0097). */
function seedEnded(kind: "denied" | "withdrawn"): number {
  h.db.run(
    `INSERT INTO publication_requests (dataset_id, requested_by, status, requested_at, updated_at,
                                       denied_at, denied_by, denied_reason, withdrawn_at)
     VALUES (?, ?, 'denied', '2026-11-20 10:00:00', '2026-11-20 10:00:00',
             CASE WHEN ? = 'denied' THEN '2026-11-21 09:30:00' END,
             CASE WHEN ? = 'denied' THEN ? END,
             CASE WHEN ? = 'denied' THEN 'README missing' END,
             CASE WHEN ? = 'withdrawn' THEN '2026-11-21 09:30:00' END)`,
    [DATASET, ownerId, kind, kind, adminId, kind, kind],
  );
  return (
    h.db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get() as { id: number }
  ).id;
}

interface Stored {
  id: number;
  status: string;
  resubmission_note: string | null;
  previous_request_id: number | null;
}

function newest(): Stored | null {
  return h.db
    .query<Stored, [string]>(
      `SELECT id, status, resubmission_note, previous_request_id
         FROM publication_requests WHERE dataset_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(DATASET);
}

const request = (...extra: string[]) => ["dataset", "publish", "request", DATASET, ...extra];

/** The line of a transcript that holds the question, with the terminal's wrapping undone. */
const flat = (text: string) => text.replace(/\s+/g, " ");

describe("--note and --note-file", () => {
  test("--note is stored with the request and linked to the denial it answers", async () => {
    const denied = seedEnded("denied");
    const r = await h.cli(request("--note", "Added participants.tsv in the new commit"));
    expect(r.exitCode).toBe(0);
    expect(newest()?.resubmission_note).toBe("Added participants.tsv in the new commit");
    expect(newest()?.previous_request_id).toBe(denied);
    expect(output(r)).toContain("Your note is recorded with the request");
    // A note given on the command line is the answer: no question and no offer.
    expect(output(r)).not.toContain(RESUBMISSION_NOTE_OFFER);
  });

  test("--note-file is read whole, a Windows line end included, and stored trimmed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nemar-note-cli-"));
    try {
      const file = join(dir, "note.txt");
      writeFileSync(file, "First paragraph.\r\n\r\nSecond paragraph.\r\n");
      const r = await h.cli(request("--note-file", file));
      expect(r.exitCode).toBe(0);
      expect(newest()?.resubmission_note).toBe("First paragraph.\n\nSecond paragraph.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a note over 2000 characters is refused before anything is sent", async () => {
    const r = await h.cli(request("--note", "x".repeat(2001)));
    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("longer than 2000 characters");
    expect(output(r)).toContain("Nothing was requested");
    expect(h.posted).toEqual([]);
    expect(newest()).toBeNull();
  });

  test("control: exactly 2000 characters is sent", async () => {
    const r = await h.cli(request("--note", "x".repeat(2000)));
    expect(r.exitCode).toBe(0);
    expect(newest()?.resubmission_note?.length).toBe(2000);
  });

  test("a control character is refused before anything is sent", async () => {
    const r = await h.cli(request("--note", "bell\u0007here"));
    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("control character");
    expect(h.posted).toEqual([]);
  });

  test("--note and --note-file together are refused", async () => {
    const r = await h.cli(request("--note", "a", "--note-file", "/nonexistent/note.txt"));
    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("either --note or --note-file");
    expect(h.posted).toEqual([]);
  });

  test("a note file that cannot be read is refused, naming the file and not its error", async () => {
    const r = await h.cli(request("--note-file", "/nonexistent/note.txt"));
    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("Could not read the note file /nonexistent/note.txt");
    expect(h.posted).toEqual([]);
  });

  test("an empty --note is no note, and asks nothing", async () => {
    seedEnded("denied");
    const r = await h.cli(request("--note", ""));
    expect(r.exitCode).toBe(0);
    expect(newest()?.resubmission_note).toBeNull();
    expect(output(r)).not.toContain(RESUBMISSION_NOTE_OFFER);
  });
});

describe("with no terminal, after a denial", () => {
  test("a note can be added, and the request goes on without one", async () => {
    seedEnded("denied");
    const r = await h.cli(request());
    expect(r.exitCode).toBe(0);
    expect(output(r)).toContain(RESUBMISSION_NOTE_OFFER);
    expect(newest()?.status).toBe("requested");
    expect(newest()?.resubmission_note).toBeNull();
  });

  test("control: after a withdrawal there is nothing to say", async () => {
    seedEnded("withdrawn");
    const r = await h.cli(request());
    expect(r.exitCode).toBe(0);
    expect(output(r)).not.toContain(RESUBMISSION_NOTE_OFFER);
    expect(newest()?.previous_request_id).toBeNull();
  });

  test("control: a first request has nothing to say either", async () => {
    const r = await h.cli(request());
    expect(r.exitCode).toBe(0);
    expect(output(r)).not.toContain(RESUBMISSION_NOTE_OFFER);
  });
});

describe.skipIf(process.platform === "win32")("on a terminal", () => {
  test("after a denial it asks once, naming the date and an administrator, and sends the answer", async () => {
    const denied = seedEnded("denied");
    const r = await h.cli(request(), {
      terminal: async (t) => {
        const asked = await t.waitFor("optional, Enter to skip");
        expect(flat(t.transcript())).toContain(
          "This dataset's last request was denied on 2026-11-21, by an administrator. Tell the reviewer what changed, or why the decision was wrong (optional, Enter to skip)",
        );
        t.type("The license field is fixed now\n");
        await t.waitFor("Publication request submitted", { after: asked });
      },
    });
    expect(r.exitCode).toBe(0);
    expect(newest()?.resubmission_note).toBe("The license field is fixed now");
    expect(newest()?.previous_request_id).toBe(denied);
  });

  test("Enter skips it, and the request is made without a note", async () => {
    seedEnded("denied");
    const r = await h.cli(request(), {
      terminal: async (t) => {
        const asked = await t.waitFor("optional, Enter to skip");
        t.type("\n");
        await t.waitFor("Publication request submitted", { after: asked });
      },
    });
    expect(r.exitCode).toBe(0);
    expect(newest()?.resubmission_note).toBeNull();
    expect(newest()?.status).toBe("requested");
  });

  test("a denial the agent made is said to be the agent's", async () => {
    const denied = seedEnded("denied");
    h.db.run(
      "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, ?, 'dataset', ?, ?)",
      [adminId, AUTO_DENY_AUDIT_ACTION, DATASET, JSON.stringify({ request_id: denied })],
    );
    await h.cli(request(), {
      terminal: async (t) => {
        await t.waitFor("optional, Enter to skip");
        expect(flat(t.transcript())).toContain("denied on 2026-11-21, by an automated agent.");
        t.type("\n");
        await t.waitFor("Publication request submitted");
      },
    });
  });

  test("after a withdrawal it asks nothing and just requests", async () => {
    seedEnded("withdrawn");
    const r = await h.cli(request(), {
      terminal: async (t) => {
        await t.waitFor("Publication request submitted");
        expect(t.transcript()).not.toContain("Enter to skip");
      },
    });
    expect(r.exitCode).toBe(0);
    expect(newest()?.resubmission_note).toBeNull();
  });

  test("an answer that breaks the rule is asked again, and a valid one is then sent", async () => {
    seedEnded("denied");
    const r = await h.cli(request(), {
      terminal: async (t) => {
        const asked = await t.waitFor("optional, Enter to skip");
        t.type(`${"y".repeat(2001)}\n`);
        await t.waitFor("longer than 2000 characters", { after: asked });
        expect(h.posted).toEqual([]);
        // Clear the line the prompt wrote the refused text back onto, and answer again.
        t.type("\u0015Shorter now\n");
        await t.waitFor("Publication request submitted", { after: asked });
      },
    });
    expect(r.exitCode).toBe(0);
    expect(newest()?.resubmission_note).toBe("Shorter now");
  });

  test("Ctrl+C at the question exits 130 and sends nothing", async () => {
    seedEnded("denied");
    const r = await h.cli(request(), {
      terminal: async (t) => {
        await t.waitFor("optional, Enter to skip");
        t.type("\u0003");
        await t.waitFor("Nothing was requested");
      },
    });
    expect(r.exitCode).toBe(130);
    expect(h.posted).toEqual([]);
    expect(newest()?.status).toBe("denied");
  });

  test("a denial whose author the server did not say is not called an administrator's", async () => {
    seedEnded("denied");
    // A backend of an older version sends no author: the real route's answer, one field gone.
    h.rewrite(`GET /datasets/${DATASET}/publish/status`, (body) => {
      Reflect.deleteProperty(body, "denied_by_kind");
    });
    await h.cli(request(), {
      terminal: async (t) => {
        await t.waitFor("optional, Enter to skip");
        const asked = flat(t.transcript());
        expect(asked).toContain("denied on 2026-11-21. Tell the reviewer");
        expect(asked).not.toContain("by an administrator");
        expect(asked).not.toContain("by an automated agent");
        t.type("\n");
        await t.waitFor("Publication request submitted");
      },
    });
  });
});

describe("what an administrator reads", () => {
  test("show prints the note quoted under a label naming its author, and the denial it answers", async () => {
    const denied = seedEnded("denied");
    await h.cli(request("--note", "Line one\nLine two <b>kept as text</b>"));
    const r = await h.cli(["admin", "dataset", "publish", "show", DATASET], { as: "cliadmin" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Depositor's note");
    expect(r.stdout).toContain("Written by the depositor");
    expect(r.stdout).toContain("    > Line one");
    expect(r.stdout).toContain("    > Line two <b>kept as text</b>");
    expect(r.stdout).toContain(`It answers the denial of request ${denied}.`);
  });

  test("show --json carries the note", async () => {
    await h.cli(request("--note", "For the reviewer"));
    const r = await h.cli(["admin", "dataset", "publish", "show", DATASET, "--json"], {
      as: "cliadmin",
    });
    const detail = JSON.parse(r.stdout) as { resubmission_note: string | null };
    expect(detail.resubmission_note).toBe("For the reviewer");
  });

  test("control: show prints no note block for a request without one", async () => {
    await h.cli(request());
    const r = await h.cli(["admin", "dataset", "publish", "show", DATASET], { as: "cliadmin" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("Depositor's note");
  });

  test("list marks a request that carries a note, and only that one", async () => {
    await h.cli(request("--note", "For the reviewer"));
    const marked = await h.cli(["admin", "dataset", "publish", "list"], { as: "cliadmin" });
    expect(marked.stdout).toContain("Depositor's note");
    expect(marked.stdout).toContain(`nemar admin dataset publish show ${DATASET}`);

    h.db.run("UPDATE publication_requests SET resubmission_note = NULL");
    const plain = await h.cli(["admin", "dataset", "publish", "list"], { as: "cliadmin" });
    expect(plain.stdout).not.toContain("Depositor's note");
  });
});
