/**
 * `nemar admin mail` (epic #1893, phase 4), driven through the real entry point
 * (`bun run src/index.ts ...`) against a local HTTP server that answers with the admin API's
 * response shapes (shared/contract/mail-admin.ts) and records every request. What is asserted is
 * what the CLI sends and prints, and the exit code. No mocks of CLI logic.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server;
 * it touches no live backend and holds no secret, so it also passes offline.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

setDefaultTimeout(30_000);

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  headers: Headers;
}

type Handler = (call: Call) => Response | Promise<Response>;

const NOW = "2026-10-20T10:00:00.000Z";

function ticket(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    ref: "NEM-42",
    queue_tag: "support",
    restricted: false,
    status: "open",
    assignee_user_id: 7,
    requester_email: "person@example.org",
    requester_user_id: null,
    subject: "Cannot upload",
    created_at: NOW,
    updated_at: NOW,
    last_message_at: NOW,
    has_summary: false,
    purged: false,
    ...over,
  };
}

const USERS: Record<string, number> = { admin1: 1, alice: 7, bob: 8, "12345": 77 };
const NAMES: Record<number, string> = {
  1: "admin1",
  7: "alice",
  8: "bob",
  9: "eve\u001b[31m\u202e",
};

/** The server: user routes are built in; a test supplies the mail routes it cares about. */
function startServer(routes: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      const call: Call = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: text ? JSON.parse(text) : undefined,
        headers: req.headers,
      };
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      calls.push(call);
      const override = routes[`${req.method} ${url.pathname}`];
      if (override) return override(call);
      if (url.pathname === "/users/me") {
        return Response.json({
          user: {
            id: 1,
            username: "admin1",
            email: "admin1@example.org",
            github_username: null,
            role: "admin",
          },
        });
      }
      const byId = url.pathname.match(/^\/admin\/users\/by-id\/(\d+)$/);
      if (byId) {
        const name = NAMES[Number(byId[1])];
        return name
          ? Response.json({ user: { id: Number(byId[1]), username: name } })
          : Response.json({ error: "User not found" }, { status: 404 });
      }
      const byName = url.pathname.match(/^\/admin\/users\/([^/]+)$/);
      if (byName && req.method === "GET") {
        const id = USERS[decodeURIComponent(byName[1])];
        return id
          ? Response.json({ user: { id, username: decodeURIComponent(byName[1]) } })
          : Response.json({ error: "User not found" }, { status: 404 });
      }
      const handler = routes[`${req.method} ${url.pathname}`];
      if (handler) return handler(call);
      return Response.json(
        { error: "Not Found", message: `Route ${req.method} ${url.pathname} not found` },
        { status: 404 },
      );
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    calls,
    mail: () => calls.filter((c) => c.path.startsWith("/admin/mail")),
    stop: () => server.stop(true),
  };
}

/** Whether text still holds an ESC, BEL, RLO or RLM character. */
const hasRaw = (text: string) =>
  ["\u001b", "\u0007", "\u202e", "\u200f"].some((c) => text.includes(c));

const err = (status: number, code: string, error = `${code} sentence`) =>
  Response.json({ error, code }, { status });

let configDir: string;
let scratch: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-mail-cli-"));
  scratch = mkdtempSync(join(tmpdir(), "nemar-mail-cli-files-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ activeAccount: "mailcli", accounts: { mailcli: { apiKey: "k" } } }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

async function runCli(args: string[], apiUrl: string, stdin?: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: apiUrl,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  env.FORCE_COLOR = undefined;
  env.CLICOLOR_FORCE = undefined;
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "admin", "mail", ...args],
    cwd: REPO_ROOT,
    env,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

describe("mail list", () => {
  test("filters become the query string, and names replace ids", async () => {
    const server = startServer({
      "GET /admin/mail/tickets": () => Response.json({ tickets: [ticket()], next_cursor: null }),
    });
    try {
      const r = await runCli(
        [
          "list",
          "--status",
          "pending",
          "--queue",
          "support",
          "--assignee",
          "bob",
          "--search",
          "upload",
          "--limit",
          "10",
        ],
        server.url,
      );
      expect(r.exitCode).toBe(0);
      expect(server.mail()[0].query).toEqual({
        status: "pending",
        queue: "support",
        assignee: "8",
        q: "upload",
        limit: "10",
      });
      expect(r.stdout).toContain("NEM-42");
      expect(r.stdout).toContain("alice");
      expect(r.stdout).toContain("Cannot upload");
    } finally {
      server.stop();
    }
  });

  test("--mine asks for 'me' and --assignee none for unassigned", async () => {
    const server = startServer({
      "GET /admin/mail/tickets": () => Response.json({ tickets: [], next_cursor: null }),
    });
    try {
      await runCli(["list", "--mine"], server.url);
      await runCli(["list", "--assignee", "none"], server.url);
      const q = server.mail().map((c) => c.query.assignee);
      expect(q).toEqual(["me", "none"]);
      const both = await runCli(["list", "--mine", "--assignee", "bob"], server.url);
      expect(both.exitCode).toBe(2);
    } finally {
      server.stop();
    }
  });

  test("--all follows next_cursor to the last page", async () => {
    const server = startServer({
      "GET /admin/mail/tickets": (call) =>
        call.query.cursor === "c2"
          ? Response.json({ tickets: [ticket({ id: 2, ref: "NEM-2" })], next_cursor: null })
          : call.query.cursor === "c1"
            ? Response.json({ tickets: [ticket({ id: 1, ref: "NEM-1" })], next_cursor: "c2" })
            : Response.json({ tickets: [ticket({ id: 3, ref: "NEM-3" })], next_cursor: "c1" }),
    });
    try {
      const r = await runCli(["list", "--all", "--json"], server.url);
      expect(r.exitCode).toBe(0);
      const body = JSON.parse(r.stdout);
      expect(body.tickets.map((t: { id: number }) => t.id)).toEqual([3, 1, 2]);
      expect(body.next_cursor).toBeNull();
      expect(server.mail().map((c) => c.query.cursor)).toEqual([undefined, "c1", "c2"]);
      expect(server.mail()[0].query.limit).toBe("100");
    } finally {
      server.stop();
    }
  });

  test("a bad --status is a usage error and sends nothing", async () => {
    const server = startServer();
    try {
      const r = await runCli(["list", "--status", "bogus"], server.url);
      expect(r.exitCode).toBe(2);
      expect(server.mail()).toHaveLength(0);
    } finally {
      server.stop();
    }
  });
});

describe("mail show", () => {
  const hostile = {
    ticket: ticket({ subject: "Pay now\u001b[2J \u202egnp.exe" }),
    tags: ["billing\u001b[1m"],
    messages: [
      {
        id: 3,
        direction: "out",
        message_id: "<m3@example.org>",
        from_addr: "support@example.org",
        to_addr: "person@example.org",
        subject: "Re: Pay now",
        text_body: "second message",
        spf: "",
        dkim: "",
        dmarc: "",
        author_user_id: 7,
        created_at: "2026-10-20T12:00:00.000Z",
      },
      {
        id: 1,
        direction: "in",
        message_id: "<m1@example.org>",
        from_addr: "person@example.org",
        to_addr: "support@example.org",
        subject: "Pay now\u001b[2J",
        text_body: "first message\u001b]0;owned\u0007\nline two \u202eevil\ttabbed",
        spf: "pass",
        dkim: "fail",
        dmarc: "none",
        author_user_id: null,
        created_at: "2026-10-20T10:00:00.000Z",
      },
    ],
    events: [
      {
        id: 1,
        kind: "created",
        actor_user_id: null,
        detail: { note: "x\u001by" },
        created_at: NOW,
      },
    ],
  };

  test("renders the thread oldest first and escapes terminal and bidi characters", async () => {
    const server = startServer({ "GET /admin/mail/tickets/42": () => Response.json(hostile) });
    try {
      const r = await runCli(["show", "42"], server.url);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain("\u001b");
      expect(r.stdout).not.toContain("\u202e");
      expect(r.stdout).not.toContain("\u0007");
      expect(r.stdout).toContain("\\x1b[2J");
      expect(r.stdout).toContain("\\u202e");
      expect(r.stdout).toContain("\\x07");
      // A newline and a tab in a body survive.
      expect(r.stdout).toContain("line two");
      expect(r.stdout).toContain("\ttabbed");
      expect(r.stdout.indexOf("first message")).toBeLessThan(r.stdout.indexOf("second message"));
      expect(r.stdout).toContain("spf=pass dkim=fail dmarc=none");
      expect(r.stdout).toContain("billing");
      expect(r.stdout).toContain("alice");
    } finally {
      server.stop();
    }
  });

  test("--json returns the hostile text verbatim", async () => {
    const server = startServer({ "GET /admin/mail/tickets/42": () => Response.json(hostile) });
    try {
      const r = await runCli(["show", "42", "--json"], server.url);
      expect(r.exitCode).toBe(0);
      const body = JSON.parse(r.stdout);
      expect(body.ticket.subject).toBe("Pay now\u001b[2J \u202egnp.exe");
      expect(body.messages[1].text_body).toContain("\u001b]0;owned\u0007");
    } finally {
      server.stop();
    }
  });

  test("a non-numeric id is a usage error", async () => {
    const server = startServer();
    try {
      const r = await runCli(["show", "abc"], server.url);
      expect(r.exitCode).toBe(2);
      expect(server.mail()).toHaveLength(0);
    } finally {
      server.stop();
    }
  });
});

describe("mail reply", () => {
  const sent = { message_id: "9", header_message_id: "<h9@example.org>", status: "pending" };

  test("message_id 0 says the reply was sent but not recorded because the ticket was purged", async () => {
    const server = startServer({
      "POST /admin/mail/tickets/42/reply": () => Response.json({ ...sent, message_id: 0 }),
    });
    try {
      const r = await runCli(["reply", "42", "--text", "Hello there", "--yes"], server.url);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("sent, but not recorded");
      expect(r.stdout).toContain("purged");
      expect(r.stdout).not.toContain("message 0");
    } finally {
      server.stop();
    }
  });

  test("sends a generated Idempotency-Key and prints it to stderr first", async () => {
    const server = startServer({ "POST /admin/mail/tickets/42/reply": () => Response.json(sent) });
    try {
      const r = await runCli(["reply", "42", "--text", "Hello there", "--yes"], server.url);
      expect(r.exitCode).toBe(0);
      const call = server.mail()[0];
      expect(call.body).toEqual({ text: "Hello there" });
      const key = call.headers.get("Idempotency-Key") ?? "";
      expect(key).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
      expect(r.stderr).toContain(`Idempotency-Key: ${key}`);
      expect(r.stdout).toContain("Reply sent");
    } finally {
      server.stop();
    }
  });

  test("a supplied key is passed through, and the body can come from stdin or a file", async () => {
    const server = startServer({ "POST /admin/mail/tickets/42/reply": () => Response.json(sent) });
    try {
      const a = await runCli(
        ["reply", "42", "-", "--yes", "--idempotency-key", "work-item:17"],
        server.url,
        "from stdin\n",
      );
      expect(a.exitCode).toBe(0);
      expect(server.mail()[0].headers.get("Idempotency-Key")).toBe("work-item:17");
      expect(server.mail()[0].body).toEqual({ text: "from stdin" });

      const file = join(scratch, "reply.txt");
      writeFileSync(file, "from a file");
      const b = await runCli(["reply", "42", "--file", file, "--yes"], server.url);
      expect(b.exitCode).toBe(0);
      expect(server.mail()[1].body).toEqual({ text: "from a file" });
    } finally {
      server.stop();
    }
  });

  test("without --yes and without a terminal it refuses with exit 2 and sends nothing", async () => {
    const server = startServer({ "POST /admin/mail/tickets/42/reply": () => Response.json(sent) });
    try {
      const r = await runCli(["reply", "42", "--text", "Hello"], server.url);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("--yes");
      expect(server.mail()).toHaveLength(0);
    } finally {
      server.stop();
    }
  });

  test("an empty body and a malformed key are refused locally", async () => {
    const server = startServer();
    try {
      const empty = await runCli(["reply", "42", "--text", "   ", "--yes"], server.url);
      expect(empty.exitCode).toBe(2);
      const none = await runCli(["reply", "42", "--yes"], server.url);
      expect(none.exitCode).toBe(2);
      const key = await runCli(
        ["reply", "42", "--text", "hi", "--yes", "--idempotency-key", "bad key!"],
        server.url,
      );
      expect(key.exitCode).toBe(2);
      expect(server.mail()).toHaveLength(0);
    } finally {
      server.stop();
    }
  });

  test("409 reply_in_progress gives retry guidance with the key and exits 1", async () => {
    const server = startServer({
      "POST /admin/mail/tickets/42/reply": () => err(409, "reply_in_progress", "Still sending."),
    });
    try {
      const r = await runCli(
        ["reply", "42", "--text", "hi", "--yes", "--idempotency-key", "k-1"],
        server.url,
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Still sending.");
      expect(r.stderr).toContain("--idempotency-key k-1");
    } finally {
      server.stop();
    }
  });

  test("502 reply_delivery_unknown says the key will never send and does not advise a retry", async () => {
    const server = startServer({
      "POST /admin/mail/tickets/42/reply": () => err(502, "reply_delivery_unknown", "Unknown."),
    });
    try {
      const r = await runCli(["reply", "42", "--text", "hi", "--yes"], server.url);
      expect(r.exitCode).toBe(1);
      const key = server.mail()[0].headers.get("Idempotency-Key") ?? "";
      expect(key).not.toBe("");
      // The key is still printed (before sending), but no retry is advised.
      expect(r.stderr).toContain(key);
      expect(r.stderr).not.toContain("Retry with:");
      expect(r.stderr).toContain("will never send it again");
    } finally {
      server.stop();
    }
  });

  test("--json reports the failure as {error, code} on stderr, with the key it was sent under", async () => {
    const server = startServer({
      "POST /admin/mail/tickets/42/reply": () => err(502, "reply_delivery_unknown", "Unknown."),
    });
    try {
      const r = await runCli(
        ["reply", "42", "--text", "hi", "--yes", "--json", "--idempotency-key", "k-2"],
        server.url,
      );
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      const last = JSON.parse(r.stderr.trim().split("\n").at(-1) ?? "");
      expect(last).toMatchObject({
        error: "Unknown.",
        code: "reply_delivery_unknown",
        idempotency_key: "k-2",
      });
    } finally {
      server.stop();
    }
  });

  test("a lost connection also says to retry with the key", async () => {
    const server = startServer();
    const url = server.url;
    server.stop();
    const r = await runCli(
      ["reply", "42", "--text", "hi", "--yes", "--idempotency-key", "k-3"],
      url,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--idempotency-key k-3");
  });
});

describe("people: me, none, ids and usernames", () => {
  test("assign resolves a username, me, an id and none", async () => {
    const server = startServer({
      "POST /admin/mail/tickets/42/assign": (call) =>
        Response.json({
          ticket: ticket({ assignee_user_id: (call.body as { user_id: number | null }).user_id }),
        }),
    });
    try {
      const byName = await runCli(["assign", "42", "bob"], server.url);
      expect(byName.exitCode).toBe(0);
      expect(byName.stdout).toContain("bob");
      await runCli(["assign", "42", "me"], server.url);
      await runCli(["assign", "42", "7"], server.url);
      await runCli(["assign", "42", "none"], server.url);
      const bodies = server.mail().map((c) => c.body);
      expect(bodies).toEqual([{ user_id: 8 }, { user_id: 1 }, { user_id: 7 }, { user_id: null }]);
      expect(server.calls.some((c) => c.path === "/admin/users/bob")).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("an unknown username is not found (exit 3) and sends nothing to the ticket", async () => {
    const server = startServer();
    try {
      const r = await runCli(["assign", "42", "nobody"], server.url);
      expect(r.exitCode).toBe(3);
      expect(server.mail()).toHaveLength(0);
    } finally {
      server.stop();
    }
  });

  test("a malformed user is a usage error", async () => {
    const server = startServer();
    try {
      const r = await runCli(["assign", "42", "bad name!"], server.url);
      expect(r.exitCode).toBe(2);
    } finally {
      server.stop();
    }
  });
});

describe("status, close, note and escalate", () => {
  const acted = (status: string) => () => Response.json({ ticket: ticket({ status }) });

  test("status and close send the status; escalated is refused locally", async () => {
    const server = startServer({ "POST /admin/mail/tickets/42/status": acted("closed") });
    try {
      expect((await runCli(["status", "42", "pending"], server.url)).exitCode).toBe(0);
      expect((await runCli(["close", "42"], server.url)).exitCode).toBe(0);
      expect(server.mail().map((c) => c.body)).toEqual([
        { status: "pending" },
        { status: "closed" },
      ]);
      expect((await runCli(["status", "42", "escalated"], server.url)).exitCode).toBe(2);
      expect(server.mail()).toHaveLength(2);
    } finally {
      server.stop();
    }
  });

  test("note and escalate send their bodies", async () => {
    const server = startServer({
      "POST /admin/mail/tickets/42/note": () => Response.json({ message_id: 5 }),
      "POST /admin/mail/tickets/42/escalate": acted("escalated"),
    });
    try {
      expect((await runCli(["note", "42", "--text", "internal"], server.url)).exitCode).toBe(0);
      expect(
        (await runCli(["escalate", "42", "--reason", "needs owner"], server.url)).exitCode,
      ).toBe(0);
      expect((await runCli(["escalate", "42"], server.url)).exitCode).toBe(0);
      expect(server.mail().map((c) => c.body)).toEqual([
        { text: "internal" },
        { reason: "needs owner" },
        {},
      ]);
    } finally {
      server.stop();
    }
  });

  test("a refusal prints the API sentence and the guidance, exit 1", async () => {
    const server = startServer({
      "POST /admin/mail/tickets/42/status": () =>
        err(409, "restriction_mismatch", "Cannot reopen."),
    });
    try {
      const r = await runCli(["status", "42", "open"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Cannot reopen.");
      expect(r.stderr).toContain("restricted flag");
    } finally {
      server.stop();
    }
  });
});

describe("exit code 3", () => {
  test("a ticket that is not found or not visible", async () => {
    const server = startServer({
      "GET /admin/mail/tickets/42": () => err(404, "not_found", "No such ticket."),
    });
    try {
      const r = await runCli(["show", "42"], server.url);
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toContain("No such ticket.");
      const j = await runCli(["show", "42", "--json"], server.url);
      expect(j.exitCode).toBe(3);
      expect(JSON.parse(j.stderr.trim())).toEqual({ error: "No such ticket.", code: "not_found" });
    } finally {
      server.stop();
    }
  });

  test("forbidden is exit 4, not found stays 3", async () => {
    const server = startServer({
      "POST /admin/mail/reprocess": () => err(403, "forbidden", "Only an owner can do that."),
    });
    try {
      const raw = "inbound/raw/2026/10/20/123e4567-e89b-12d3-a456-426614174000.eml";
      const r = await runCli(["reprocess", raw], server.url);
      expect(r.exitCode).toBe(4);
      expect(r.stderr).toContain("Only an owner can do that.");
    } finally {
      server.stop();
    }
  });
});

describe("queues and away", () => {
  const queue = {
    tag: "support",
    restricted: false,
    strategy: "round_robin",
    assignee_user_id: null,
    backup_user_id: 8,
    rr_members: [7, 8],
    escalation_user_id: 1,
    open_tickets: 3,
  };

  test("queues lists with usernames", async () => {
    const server = startServer({
      "GET /admin/mail/queues": () => Response.json({ queues: [queue] }),
    });
    try {
      const r = await runCli(["queues"], server.url);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("support");
      expect(r.stdout).toContain("alice, bob");
    } finally {
      server.stop();
    }
  });

  test("queues set sends only the options given", async () => {
    const server = startServer({
      "PUT /admin/mail/queues/support": () => Response.json({ queue }),
    });
    try {
      const r = await runCli(
        [
          "queues",
          "set",
          "support",
          "--strategy",
          "round_robin",
          "--members",
          "alice,8",
          "--backup",
          "bob",
          "--escalation",
          "me",
          "--assignee",
          "none",
          "--restricted",
          "false",
        ],
        server.url,
      );
      expect(r.exitCode).toBe(0);
      expect(server.mail()[0].body).toEqual({
        strategy: "round_robin",
        restricted: false,
        assignee_user_id: null,
        backup_user_id: 8,
        escalation_user_id: 1,
        rr_members: [7, 8],
      });
      const none = await runCli(["queues", "set", "support"], server.url);
      expect(none.exitCode).toBe(2);
    } finally {
      server.stop();
    }
  });

  test("an owner-only refusal surfaces the API message", async () => {
    const server = startServer({
      "PUT /admin/mail/queues/support": () => err(403, "forbidden", "Only an owner can do that."),
    });
    try {
      const r = await runCli(["queues", "set", "support", "--strategy", "pool"], server.url);
      expect(r.stderr).toContain("Only an owner can do that.");
      expect(r.exitCode).toBe(4);
    } finally {
      server.stop();
    }
  });

  test("restricted_flag_busy carries its guidance", async () => {
    const server = startServer({
      "PUT /admin/mail/queues/security": () =>
        err(409, "restricted_flag_busy", "Queue has open tickets."),
    });
    try {
      const r = await runCli(["queues", "set", "security", "--restricted", "false"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("close or move them first");
    } finally {
      server.stop();
    }
  });

  const window = {
    user_id: 1,
    away_from: "2026-11-01T00:00:00.000Z",
    away_until: "2026-11-10T00:00:00.000Z",
    backup_user_id: 8,
    note: "travelling",
  };

  test("away set sends an ISO window, away clear sends all nulls, away shows it", async () => {
    const server = startServer({
      "PUT /admin/mail/availability": () => Response.json({ availability: window }),
      "GET /admin/mail/availability": () => Response.json({ availability: window }),
    });
    try {
      const set = await runCli(
        [
          "away",
          "set",
          "--from",
          "2026-11-01T00:00:00Z",
          "--until",
          "2026-11-10T00:00:00Z",
          "--backup",
          "bob",
          "--note",
          "travelling",
        ],
        server.url,
      );
      expect(set.exitCode).toBe(0);
      expect(server.mail()[0].body).toEqual({
        away_until: "2026-11-10T00:00:00.000Z",
        away_from: "2026-11-01T00:00:00.000Z",
        backup_user_id: 8,
        note: "travelling",
      });
      const clear = await runCli(["away", "clear"], server.url);
      expect(clear.exitCode).toBe(0);
      expect(server.mail()[1].body).toEqual({
        away_from: null,
        away_until: null,
        backup_user_id: null,
        note: null,
      });
      const show = await runCli(["away"], server.url);
      expect(show.exitCode).toBe(0);
      expect(show.stdout).toContain("travelling");
      expect(show.stdout).toContain("bob");
    } finally {
      server.stop();
    }
  });

  test("away --user addresses another person's window, and a bad date is a usage error", async () => {
    const server = startServer({
      "PUT /admin/mail/availability/7": () =>
        Response.json({ availability: { ...window, user_id: 7 } }),
    });
    try {
      const r = await runCli(
        ["away", "set", "--until", "2026-12-01T00:00:00+00:00", "--user", "alice"],
        server.url,
      );
      expect(r.exitCode).toBe(0);
      const bad = await runCli(["away", "set", "--until", "someday"], server.url);
      expect(bad.exitCode).toBe(2);
      for (const loose of ["2026-12-01", "2026-12-01T10:00:00", "2026-12-01 10:00:00Z"]) {
        const r = await runCli(["away", "set", "--until", loose], server.url);
        expect(r.exitCode, loose).toBe(2);
      }
      expect(server.mail()).toHaveLength(1);
      const order = await runCli(
        ["away", "set", "--from", "2026-12-02T00:00:00Z", "--until", "2026-12-01T00:00:00Z"],
        server.url,
      );
      expect(order.exitCode).toBe(2);
    } finally {
      server.stop();
    }
  });
});

describe("reprocess and help", () => {
  test("reprocess sends the raw key and prints the outcome", async () => {
    const raw = "inbound/raw/2026/10/20/123e4567-e89b-12d3-a456-426614174000.eml";
    const server = startServer({
      "POST /admin/mail/reprocess": () =>
        Response.json({ outcome: "created", ticket_id: 42, status: "open" }),
    });
    try {
      const r = await runCli(["reprocess", raw], server.url);
      expect(r.exitCode).toBe(0);
      expect(server.mail()[0].body).toEqual({ raw_key: raw });
      expect(r.stdout).toContain("created");
      expect((await runCli(["reprocess", "nope"], server.url)).exitCode).toBe(2);
    } finally {
      server.stop();
    }
  });

  test("--help names the exit codes and --help-all lists them", async () => {
    const server = startServer();
    try {
      const plain = await runCli(["--help"], server.url);
      expect(plain.stdout).toContain("exit: 0 ok, 1 error, 2 usage, 3 not found, 4 not permitted");
      const all = await runCli(["--help-all"], server.url);
      expect(all.stdout).toContain("Exit codes:");
      expect(all.stdout).toMatch(/3\s+not found or not visible/);
      expect(all.stdout).toMatch(/2\s+usage/);
    } finally {
      server.stop();
    }
  });
});

describe("reply retry advice for unknown outcomes", () => {
  const retry = async (respond: () => Response, extra: string[] = []) => {
    const server = startServer({ "POST /admin/mail/tickets/42/reply": respond });
    try {
      const r = await runCli(
        ["reply", "42", "--text", "hi", "--yes", "--idempotency-key", "k-9", ...extra],
        server.url,
      );
      return r;
    } finally {
      server.stop();
    }
  };

  test("an HTML 504 from a gateway says to retry with the key", async () => {
    const r = await retry(() => new Response("<html>", { status: 504 }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--idempotency-key k-9");
  });

  test("a 500 internal and a maintenance 503 do too, and --json carries the key", async () => {
    const a = await retry(() => err(500, "internal", "Boom."), ["--json"]);
    expect(a.exitCode).toBe(1);
    expect(JSON.parse(a.stderr.trim().split("\n").at(-1) ?? "")).toMatchObject({
      code: "internal",
      idempotency_key: "k-9",
    });
    const b = await retry(() =>
      Response.json({ mode: "full", message: "Down for maintenance." }, { status: 503 }),
    );
    expect(b.stderr).toContain("--idempotency-key k-9");
  });

  test("a definite 4xx refusal does not suggest a retry", async () => {
    const r = await retry(() => err(409, "ticket_closed", "It is closed."), ["--json"]);
    expect(r.exitCode).toBe(1);
    const last = JSON.parse(r.stderr.trim().split("\n").at(-1) ?? "");
    expect(last.idempotency_key).toBeUndefined();
    const human = await retry(() => err(409, "ticket_closed", "It is closed."));
    expect(human.stderr).not.toContain("Retry with");
  });
});

describe("exit codes 3 and 4", () => {
  test("404 is 3 and 403 is 4 on the same route", async () => {
    let status = 404;
    const server = startServer({
      "GET /admin/mail/tickets/42": () =>
        status === 404 ? err(404, "not_found", "No such ticket.") : err(403, "forbidden", "No."),
    });
    try {
      expect((await runCli(["show", "42"], server.url)).exitCode).toBe(3);
      status = 403;
      expect((await runCli(["show", "42"], server.url)).exitCode).toBe(4);
      const j = await runCli(["show", "42", "--json"], server.url);
      expect(JSON.parse(j.stderr.trim())).toMatchObject({ code: "forbidden" });
    } finally {
      server.stop();
    }
  });
});

describe("Commander usage errors exit 2", () => {
  test("a missing argument, with and without --json", async () => {
    const server = startServer();
    try {
      const plain = await runCli(["show"], server.url);
      expect(plain.exitCode).toBe(2);
      expect(plain.stderr).toContain("missing required argument");
      const json = await runCli(["show", "--json"], server.url);
      expect(json.exitCode).toBe(2);
      expect(json.stdout).toBe("");
      const body = JSON.parse(json.stderr.trim());
      expect(body.code).toBe("usage");
      expect(body.error).toContain("missing required argument");
      expect(server.mail()).toHaveLength(0);
    } finally {
      server.stop();
    }
  });

  test("a missing required option and an unknown option", async () => {
    const server = startServer();
    try {
      const plain = await runCli(["away", "set"], server.url);
      expect(plain.exitCode).toBe(2);
      expect(plain.stderr).toContain("--until");
      const json = await runCli(["away", "set", "--json"], server.url);
      expect(json.exitCode).toBe(2);
      expect(JSON.parse(json.stderr.trim())).toMatchObject({ code: "usage" });
      const unknown = await runCli(["list", "--bogus", "--json"], server.url);
      expect(unknown.exitCode).toBe(2);
      expect(JSON.parse(unknown.stderr.trim())).toMatchObject({ code: "usage" });
      const cmd = await runCli(["nonsense"], server.url);
      expect(cmd.exitCode).toBe(2);
    } finally {
      server.stop();
    }
  });
});

describe("names", () => {
  const hostileShow = {
    ticket: ticket({ assignee_user_id: 9 }),
    tags: [],
    messages: [],
    events: [
      { id: 1, kind: "assigned", actor_user_id: 9, detail: null, created_at: NOW },
      { id: 2, kind: "note", actor_user_id: 9, detail: null, created_at: NOW },
    ],
  };

  test("a hostile username is escaped every time it is shown, not only the first", async () => {
    const server = startServer({ "GET /admin/mail/tickets/42": () => Response.json(hostileShow) });
    try {
      const r = await runCli(["show", "42"], server.url);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain("\u001b");
      expect(r.stdout).not.toContain("\u202e");
      expect(r.stdout.split("eve\\x1b[31m\\u202e").length - 1).toBe(3);
      // One lookup serves all three.
      expect(server.calls.filter((c) => c.path === "/admin/users/by-id/9")).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  test("a 404 on the name lookup degrades to #id", async () => {
    const server = startServer({
      "GET /admin/mail/tickets/42": () =>
        Response.json({ ...hostileShow, ticket: ticket({ assignee_user_id: 55 }), events: [] }),
    });
    try {
      const r = await runCli(["show", "42"], server.url);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("#55");
    } finally {
      server.stop();
    }
  });

  test("any other lookup failure fails the command", async () => {
    for (const status of [401, 429, 500]) {
      const server = startServer({
        "GET /admin/mail/tickets/42": () => Response.json(hostileShow),
        "GET /admin/users/by-id/9": () => err(status, "x", "Lookup refused."),
      });
      try {
        const r = await runCli(["show", "42"], server.url);
        expect(r.exitCode, String(status)).not.toBe(0);
        expect(r.stderr).toContain("Lookup refused.");
        // Nothing of the ticket is printed before the failure.
        expect(r.stdout, String(status)).toBe("");
      } finally {
        server.stop();
      }
    }
  });

  test("bare digits are a user id and @name is always a username", async () => {
    const server = startServer({
      "POST /admin/mail/tickets/42/assign": (call) =>
        Response.json({
          ticket: ticket({ assignee_user_id: (call.body as { user_id: number }).user_id }),
        }),
    });
    try {
      await runCli(["assign", "42", "12345"], server.url);
      await runCli(["assign", "42", "@12345"], server.url);
      await runCli(["assign", "42", "@bob"], server.url);
      expect(server.mail().map((c) => c.body)).toEqual([
        { user_id: 12345 },
        { user_id: 77 },
        { user_id: 8 },
      ]);
    } finally {
      server.stop();
    }
  });
});

describe("failures part way through", () => {
  test("a repeated cursor under --all is an error and prints nothing", async () => {
    const server = startServer({
      "GET /admin/mail/tickets": () => Response.json({ tickets: [ticket()], next_cursor: "same" }),
    });
    try {
      const json = await runCli(["list", "--all", "--json"], server.url);
      expect(json.exitCode).toBe(1);
      expect(json.stdout).toBe("");
      expect(JSON.parse(json.stderr.trim())).toHaveProperty("error");
      const human = await runCli(["list", "--all"], server.url);
      expect(human.exitCode).toBe(1);
      expect(human.stdout).toBe("");
    } finally {
      server.stop();
    }
  });

  test("a page that fails under --all leaves standard output empty", async () => {
    const server = startServer({
      "GET /admin/mail/tickets": (call) =>
        call.query.cursor
          ? err(500, "internal", "Second page failed.")
          : Response.json({ tickets: [ticket()], next_cursor: "c1" }),
    });
    try {
      const r = await runCli(["list", "--all", "--json"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
    } finally {
      server.stop();
    }
  });
});

describe("server-generated fields are escaped too", () => {
  test("ref, status, queue and dates in list and show", async () => {
    const bad = ticket({ ref: "R\u001b[1m", status: "open\u202e", queue_tag: "q\u0007" });
    const server = startServer({
      "GET /admin/mail/tickets": () => Response.json({ tickets: [bad], next_cursor: null }),
      "GET /admin/mail/tickets/42": () =>
        Response.json({ ticket: bad, tags: [], messages: [], events: [] }),
    });
    try {
      for (const args of [["list"], ["show", "42"]]) {
        const r = await runCli(args, server.url);
        expect(hasRaw(r.stdout), args[0]).toBe(false);
        expect(r.stdout).toContain("R\\x1b[1m");
      }
    } finally {
      server.stop();
    }
  });
});

describe("summaries and retention", () => {
  test("summarize sends PUT with the trimmed text from --text, --file and stdin", async () => {
    const server = startServer({
      "PUT /admin/mail/tickets/42/summary": () =>
        Response.json({ ticket: ticket({ status: "closed", has_summary: true }) }),
    });
    try {
      const file = join(scratch, "summary.txt");
      writeFileSync(file, "From a file.\n");
      expect(
        (await runCli(["summarize", "42", "--text", "  From text.  "], server.url)).exitCode,
      ).toBe(0);
      expect((await runCli(["summarize", "42", "--file", file], server.url)).exitCode).toBe(0);
      const viaStdin = await runCli(["summarize", "42", "-"], server.url, "From stdin.\n");
      expect(viaStdin.exitCode).toBe(0);
      expect(viaStdin.stdout).toContain("Summary saved on ticket #42");
      expect(server.mail().map((c) => [c.method, c.path, c.body])).toEqual([
        ["PUT", "/admin/mail/tickets/42/summary", { summary: "From text." }],
        ["PUT", "/admin/mail/tickets/42/summary", { summary: "From a file." }],
        ["PUT", "/admin/mail/tickets/42/summary", { summary: "From stdin." }],
      ]);
    } finally {
      server.stop();
    }
  });

  test("--json prints the API answer verbatim", async () => {
    const answer = { ticket: ticket({ has_summary: true }) };
    const server = startServer({
      "PUT /admin/mail/tickets/42/summary": () => Response.json(answer),
    });
    try {
      const r = await runCli(["summarize", "42", "--text", "ok", "--json"], server.url);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual(answer);
    } finally {
      server.stop();
    }
  });

  test("input rules: exactly one source, not empty, at most 4000 characters; nothing is sent", async () => {
    const server = startServer();
    try {
      expect((await runCli(["summarize", "42"], server.url)).exitCode).toBe(2);
      expect((await runCli(["summarize", "42", "--text", "   "], server.url)).exitCode).toBe(2);
      const long = await runCli(["summarize", "42", "--text", "x".repeat(4001)], server.url);
      expect(long.exitCode).toBe(2);
      expect(long.stderr).toContain("limit is 4000");
      expect((await runCli(["summarize", "abc", "--text", "x"], server.url)).exitCode).toBe(2);
      expect(server.mail()).toHaveLength(0);
    } finally {
      server.stop();
    }
  });

  test("summary_has_address and ticket_purged print the API sentence and guidance", async () => {
    const server = startServer({
      "PUT /admin/mail/tickets/42/summary": () =>
        err(400, "summary_has_address", "Has an address."),
      "PUT /admin/mail/tickets/43/summary": () => err(409, "ticket_purged", "Purged."),
    });
    try {
      const a = await runCli(["summarize", "42", "--text", "mail me@example.org"], server.url);
      expect(a.exitCode).toBe(1);
      expect(a.stderr).toContain("Has an address.");
      expect(a.stderr).toContain("without names");
      const b = await runCli(["summarize", "43", "--text", "late"], server.url);
      expect(b.exitCode).toBe(1);
      expect(b.stderr).toContain("Purged.");
      expect(b.stderr).toContain("only its summary remains");
    } finally {
      server.stop();
    }
  });

  test("help says what a summary must not contain", async () => {
    const server = startServer();
    try {
      const r = await runCli(["summarize", "--help-all"], server.url);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("email addresses");
      expect(r.stdout).toContain("quoted message text");
      expect(r.stdout).toContain("1 to 4000 characters");
    } finally {
      server.stop();
    }
  });

  test("list --needs-summary asks for summary=missing", async () => {
    const server = startServer({
      "GET /admin/mail/tickets": () => Response.json({ tickets: [], next_cursor: null }),
    });
    try {
      expect((await runCli(["list", "--needs-summary"], server.url)).exitCode).toBe(0);
      await runCli(["list"], server.url);
      expect(server.mail().map((c) => c.query.summary)).toEqual(["missing", undefined]);
    } finally {
      server.stop();
    }
  });

  test("list marks a purged ticket", async () => {
    const server = startServer({
      "GET /admin/mail/tickets": () =>
        Response.json({
          tickets: [ticket({ status: "closed", purged: true, requester_email: "", subject: "" })],
          next_cursor: null,
        }),
    });
    try {
      const r = await runCli(["list", "--status", "closed"], server.url);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("closed (purged)");
    } finally {
      server.stop();
    }
  });

  test("show of a purged ticket prints the purge date and the summary, with no thread", async () => {
    const detail = {
      ticket: ticket({
        status: "closed",
        purged: true,
        has_summary: true,
        requester_email: "",
        subject: "",
      }),
      tags: ["support"],
      messages: [],
      events: [{ id: 1, kind: "purged", actor_user_id: null, detail: null, created_at: NOW }],
      summary: "Upload failed; fixed by retry.",
      summary_author_user_id: 7,
      summarized_at: NOW,
      purged_at: "2026-10-24 12:00:00",
    };
    const server = startServer({ "GET /admin/mail/tickets/42": () => Response.json(detail) });
    try {
      const r = await runCli(["show", "42"], server.url);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Purged on:  2026-10-24 12:00:00");
      expect(r.stdout).toContain("Summary (by alice");
      expect(r.stdout).toContain("Upload failed; fixed by retry.");
      expect(r.stdout).toContain("(no messages)");
    } finally {
      server.stop();
    }
  });

  test("a hostile summary is escaped in human output and verbatim in --json", async () => {
    const detail = {
      ticket: ticket(),
      tags: [],
      messages: [],
      events: [],
      summary: "Bad\u001b[2J \u202etext\u0007",
      summary_author_user_id: 9,
      summarized_at: "2026\u001b-10",
      purged_at: null,
    };
    const server = startServer({ "GET /admin/mail/tickets/42": () => Response.json(detail) });
    try {
      const human = await runCli(["show", "42"], server.url);
      expect(hasRaw(human.stdout)).toBe(false);
      expect(human.stdout).toContain("\\x1b[2J");
      const json = await runCli(["show", "42", "--json"], server.url);
      expect(JSON.parse(json.stdout).summary).toBe(detail.summary);
    } finally {
      server.stop();
    }
  });
});

describe("note idempotency key", () => {
  const added = () => Response.json({ message_id: 5 });

  test("sends a generated Idempotency-Key and prints it to stderr first", async () => {
    const server = startServer({ "POST /admin/mail/tickets/42/note": added });
    try {
      const r = await runCli(["note", "42", "--text", "internal"], server.url);
      expect(r.exitCode).toBe(0);
      const call = server.mail()[0];
      expect(call.body).toEqual({ text: "internal" });
      const key = call.headers.get("Idempotency-Key") ?? "";
      expect(key).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
      expect(r.stderr).toContain(`Idempotency-Key: ${key}`);
      expect(r.stdout).toContain("Note added");
    } finally {
      server.stop();
    }
  });

  test("a supplied key is passed through, and a malformed one is refused locally", async () => {
    const server = startServer({ "POST /admin/mail/tickets/42/note": added });
    try {
      const ok = await runCli(
        ["note", "42", "--text", "x", "--idempotency-key", "work-item:17"],
        server.url,
      );
      expect(ok.exitCode).toBe(0);
      expect(server.mail()[0].headers.get("Idempotency-Key")).toBe("work-item:17");
      const bad = await runCli(
        ["note", "42", "--text", "x", "--idempotency-key", "bad key!"],
        server.url,
      );
      expect(bad.exitCode).toBe(2);
      expect(server.mail()).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  test("a 503 says to retry with the key, and --json carries it", async () => {
    const server = startServer({
      "POST /admin/mail/tickets/42/note": () =>
        Response.json({ mode: "full", message: "Down for maintenance." }, { status: 503 }),
    });
    try {
      const r = await runCli(["note", "42", "--text", "x", "--idempotency-key", "n-9"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Retry with: --idempotency-key n-9");
      expect(r.stderr).toContain("never stores the note twice");
      const j = await runCli(
        ["note", "42", "--text", "x", "--idempotency-key", "n-9", "--json"],
        server.url,
      );
      expect(JSON.parse(j.stderr.trim().split("\n").at(-1) ?? "")).toMatchObject({
        idempotency_key: "n-9",
      });
    } finally {
      server.stop();
    }
  });

  test("a network failure says to retry with the key", async () => {
    const server = startServer({});
    const url = server.url;
    server.stop();
    const r = await runCli(["note", "42", "--text", "x", "--idempotency-key", "n-8"], url);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Retry with: --idempotency-key n-8");
  });

  test("408 and 429 advise a retry with the key for a note, but not for a reply", async () => {
    for (const status of [408, 429]) {
      const n = startServer({
        "POST /admin/mail/tickets/42/note": () => err(status, "slow", "Try later."),
      });
      try {
        const r = await runCli(["note", "42", "--text", "x", "--idempotency-key", "n-7"], n.url);
        expect(r.stderr).toContain("Retry with: --idempotency-key n-7");
      } finally {
        n.stop();
      }
      const rep = startServer({
        "POST /admin/mail/tickets/42/reply": () => err(status, "slow", "Try later."),
      });
      try {
        const r = await runCli(
          ["reply", "42", "--text", "x", "--yes", "--idempotency-key", "r-7"],
          rep.url,
        );
        expect(r.exitCode).toBe(1);
        expect(r.stderr).not.toContain("Retry with");
      } finally {
        rep.stop();
      }
    }
  });

  test("a definite 4xx refusal does not suggest a retry", async () => {
    const server = startServer({
      "POST /admin/mail/tickets/42/note": () => err(409, "ticket_purged", "Purged."),
    });
    try {
      const r = await runCli(["note", "42", "--text", "x"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).not.toContain("Retry with");
    } finally {
      server.stop();
    }
  });
});
