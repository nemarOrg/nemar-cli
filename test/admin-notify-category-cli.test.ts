/**
 * CLI `nemar admin notify --category` (epic #2260 phase 3): argument validation, the recall's typed
 * confirmation, the dry-run and status rendering, and the site-notice lines. Driven through the real
 * entry point against a real local HTTP server via TEST_API_URL (a provably fake host: the server
 * is a `Bun.serve` on localhost, never a real repository or API), with an isolated NEMAR_CONFIG_DIR.
 * Same harness as test/admin-notify-cli.test.ts, plus the request bodies the server received.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const RECALL_BODY = "## What is affected\n\nnm000104 v1.0.0.\n\n## What to do\n\nDelete your copy.";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-admin-notify-category-cli-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "categoryadmin",
      accounts: { categoryadmin: { apiKey: "test-admin-key" } },
    }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function startServer(routes: Record<string, unknown>) {
  const requests: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      requests.push(`${req.method} ${url.pathname}`);
      if (req.method === "POST") bodies.push((await req.json()) as Record<string, unknown>);
      const body = routes[`${req.method} ${url.pathname}`];
      return body === undefined ? new Response("{}", { status: 404 }) : Response.json(body);
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    requests,
    bodies,
    stop: () => server.stop(true),
  };
}

async function runCli(args: string[], testApiUrl: string) {
  const env = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: testApiUrl,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  env.FORCE_COLOR = undefined;
  env.CLICOLOR_FORCE = undefined;
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

const QUEUED = {
  broadcast_id: 7,
  status: "queued",
  recipient_count: 10,
  failure_count: 0,
  failed_recipients: [],
  suppressed_count: 0,
};

const NEWS = ["admin", "notify", "--to", "all", "--subject", "S", "--body", "B"];
const RECALL = [
  "admin",
  "notify",
  "--to",
  "all",
  "--category",
  "recall",
  "--subject",
  "Problem",
  "--body",
  RECALL_BODY,
  "--recall-ref",
  "nm000104@v1.0.0",
];

describe("argument validation, before any request", () => {
  test("a group send without --category is refused and names the choices", async () => {
    const server = startServer({ "POST /admin/notify": QUEUED });
    try {
      const r = await runCli([...NEWS, "--yes"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("A group send needs --category <news|rfcs|maintenance|recall>");
      expect(server.requests).not.toContain("POST /admin/notify");
    } finally {
      server.stop();
    }
  });

  test("an unknown category is refused, and the retired announcements is not one", async () => {
    const server = startServer({ "POST /admin/notify": QUEUED });
    try {
      const r = await runCli([...NEWS, "--category", "announcements", "--yes"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Invalid category: announcements");
      expect(server.requests).not.toContain("POST /admin/notify");
    } finally {
      server.stop();
    }
  });

  test("--user is direct contact and takes no category", async () => {
    const server = startServer({ "POST /admin/notify": QUEUED });
    try {
      const r = await runCli(
        ["admin", "notify", "--user", "bob", "--category", "news", "--subject", "S", "--body", "B"],
        server.url,
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--user is direct contact");
      expect(server.requests).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("a recall needs a well-formed reference, and the headings, and the other categories take no reference", async () => {
    const server = startServer({ "POST /admin/notify": QUEUED });
    try {
      const noRef = await runCli(
        RECALL.filter((_, i) => i < RECALL.length - 2),
        server.url,
      );
      expect(noRef.exitCode).toBe(1);
      expect(noRef.stderr).toContain("--recall-ref is required");

      const badRef = await runCli([...RECALL.slice(0, -1), "it is bad"], server.url);
      expect(badRef.exitCode).toBe(1);
      expect(badRef.stderr).toContain("--recall-ref is required");

      const noHeadings = await runCli(
        RECALL.map((a) => (a === RECALL_BODY ? "Delete nm000104 now." : a)),
        server.url,
      );
      expect(noHeadings.exitCode).toBe(1);
      expect(noHeadings.stderr).toContain('"What is affected" and "What to do"');

      const wrongCategory = await runCli(
        [...NEWS, "--category", "news", "--recall-ref", "nm000104", "--yes"],
        server.url,
      );
      expect(wrongCategory.exitCode).toBe(1);
      expect(wrongCategory.stderr).toContain("belong to --category recall only");
      expect(server.requests).not.toContain("POST /admin/notify");
    } finally {
      server.stop();
    }
  });
});

describe("a categorized send", () => {
  test("posts the category and prints the queued line", async () => {
    const server = startServer({ "POST /admin/notify": { ...QUEUED, category: "rfcs" } });
    try {
      const r = await runCli(
        [...NEWS, "--category", "rfcs", "--allow-repeat", "--yes"],
        server.url,
      );
      expect(r.exitCode).toBe(0);
      expect(server.bodies[0]).toEqual({
        to: "all",
        category: "rfcs",
        allow_repeat: true,
        subject: "S",
        body: "B",
      });
      expect(r.stderr).toContain("Queued 10 announcement(s) (ID 7)");
    } finally {
      server.stop();
    }
  });

  test("without --yes and without a terminal nothing is sent", async () => {
    const server = startServer({ "POST /admin/notify": QUEUED });
    try {
      const r = await runCli([...NEWS, "--category", "news"], server.url);
      expect(server.requests).not.toContain("POST /admin/notify");
      expect(r.stdout + r.stderr).not.toContain("Queued");
    } finally {
      server.stop();
    }
  });

  test("a dry run prints counts and a redacted sample, and never an address the server did not send", async () => {
    const server = startServer({
      "POST /admin/notify": {
        dry_run: true,
        category: "news",
        recipient_group: "all",
        recipient_count: 5,
        deliverable_count: 4,
        counts: { all: 5, admins: 2, members: 3 },
        sample: ["a***@nemar.test", "b***@nemar.test", "c***@nemar.test"],
        blockers: ["mail_link_secret_unset"],
      },
    });
    try {
      const r = await runCli([...NEWS, "--category", "news", "--dry-run"], server.url);
      expect(r.exitCode).toBe(0);
      expect(server.bodies[0]).toMatchObject({ dry_run: true, category: "news" });
      expect(r.stderr).toContain('Dry run: 5 recipient(s) for "all" (news)');
      expect(r.stdout).toContain("Audience by group: all 5, admins 2, members 3");
      expect(r.stdout).toContain("4 of 5 would be delivered");
      expect(r.stdout).toContain("A real send would be refused now: mail_link_secret_unset");
      expect(r.stdout).toContain("Sample (redacted): a***@nemar.test");
      expect(r.stdout).toContain("Addresses are listed in production only");
    } finally {
      server.stop();
    }
  });

  test("a dry run says when a real send would be refused as a repeat", async () => {
    const server = startServer({
      "POST /admin/notify": {
        dry_run: true,
        category: "news",
        recipient_group: "all",
        recipient_count: 5,
        would_refuse: "duplicate_send",
        duplicate_of: 12,
      },
    });
    try {
      const r = await runCli([...NEWS, "--category", "news", "--dry-run"], server.url);
      expect(r.stdout).toContain("refused as a repeat of announcement 12");
      expect(r.stdout).toContain("--allow-repeat");
    } finally {
      server.stop();
    }
  });

  test("a production dry run still lists the addresses the server returns", async () => {
    const server = startServer({
      "POST /admin/notify": {
        dry_run: true,
        category: "news",
        recipient_group: "all",
        recipient_count: 1,
        recipients: ["person@nemar.test"],
      },
    });
    try {
      const r = await runCli([...NEWS, "--category", "news", "--dry-run"], server.url);
      expect(r.stdout).toContain("person@nemar.test");
    } finally {
      server.stop();
    }
  });
});

describe("a recall", () => {
  test("--yes alone never stands in for the typed confirmation: nothing is sent", async () => {
    const server = startServer({ "POST /admin/notify": QUEUED });
    try {
      const r = await runCli([...RECALL, "--yes"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Recall not sent");
      expect(server.requests).not.toContain("POST /admin/notify");
    } finally {
      server.stop();
    }
  });

  test("a wrong typed confirmation sends nothing", async () => {
    const server = startServer({ "POST /admin/notify": QUEUED });
    try {
      const r = await runCli([...RECALL, "--confirm-recall", "nm000104", "--yes"], server.url);
      expect(r.exitCode).toBe(1);
      expect(server.requests).not.toContain("POST /admin/notify");
    } finally {
      server.stop();
    }
  });

  test("the reference typed back sends it, carrying the reference and the confirmation, and reports the site notice", async () => {
    const server = startServer({
      "POST /admin/notify": { ...QUEUED, category: "recall", notice_id: 42 },
    });
    try {
      const r = await runCli(
        [...RECALL, "--confirm-recall", "nm000104@v1.0.0", "--yes"],
        server.url,
      );
      expect(r.exitCode).toBe(0);
      expect(server.bodies[0]).toMatchObject({
        to: "all",
        category: "recall",
        recall_reference: "nm000104@v1.0.0",
        confirm_recall: "nm000104@v1.0.0",
      });
      expect(r.stdout).toContain("RECALL: reaches every account");
      expect(r.stdout).toContain("Site notice #42 published");
      expect(r.stdout).toContain("nemar admin notice clear 42");
    } finally {
      server.stop();
    }
  });

  test("when no site notice was published, the owner is told the step and the command", async () => {
    const server = startServer({
      "POST /admin/notify": { ...QUEUED, category: "recall", notice_error: "notice_failed" },
    });
    try {
      const r = await runCli(
        [...RECALL, "--confirm-recall", "nm000104@v1.0.0", "--yes"],
        server.url,
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("OWNER STEP: a recall also needs a public site notice");
      expect(r.stdout).toContain("nemar admin notice set --level critical");
    } finally {
      server.stop();
    }
  });

  test("a recall canary says the send to all publishes the notice, not that the owner must", async () => {
    const server = startServer({
      "POST /admin/notify": { ...QUEUED, category: "recall", notice_skipped: "canary" },
    });
    try {
      const r = await runCli(
        [...RECALL, "--confirm-recall", "nm000104@v1.0.0", "--yes"],
        server.url,
      );
      expect(r.stdout).toContain("The send to all publishes it");
      expect(r.stdout).not.toContain("OWNER STEP");
    } finally {
      server.stop();
    }
  });

  test("a recall that queued nothing says so instead of claiming the owner step", async () => {
    const server = startServer({
      "POST /admin/notify": {
        ...QUEUED,
        recipient_count: 0,
        category: "recall",
        notice_skipped: "nothing_queued",
        error: "queue_enqueue_failed",
      },
    });
    try {
      const r = await runCli(
        [...RECALL, "--confirm-recall", "nm000104@v1.0.0", "--yes"],
        server.url,
      );
      expect(r.stdout).toContain("No site notice was published because nothing was queued");
      expect(r.stdout).not.toContain("OWNER STEP");
    } finally {
      server.stop();
    }
  });

  test("a recall's dry run needs no confirmation", async () => {
    const server = startServer({
      "POST /admin/notify": {
        dry_run: true,
        category: "recall",
        recipient_group: "all",
        recipient_count: 9,
        sample: [],
      },
    });
    try {
      const r = await runCli([...RECALL, "--dry-run"], server.url);
      expect(r.exitCode).toBe(0);
      expect(server.bodies[0]).toMatchObject({ dry_run: true, category: "recall" });
      expect(server.bodies[0]).not.toHaveProperty("confirm_recall");
    } finally {
      server.stop();
    }
  });
});

describe("--status", () => {
  test("shows the category and a recall's reference", async () => {
    const server = startServer({
      "GET /admin/notify/7": {
        id: 7,
        status: "done",
        subject: "[NEMAR recall] Problem",
        recipient_group: "all",
        category: "recall",
        recall_reference: "nm000104@v1.0.0",
        queued_count: 3,
        delivered_count: 2,
        failure_count: 0,
        unknown_count: 0,
        skipped_count: 1,
        failed_recipients: [],
        sent_at: "2026-11-20 12:00:00",
      },
    });
    try {
      const r = await runCli(["admin", "notify", "--status", "7"], server.url);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Category: recall");
      expect(r.stdout).toContain("Recall reference: nm000104@v1.0.0");
      expect(r.stdout).toContain("Skipped: 1");
    } finally {
      server.stop();
    }
  });

  test("a send from before the categories prints no category line", async () => {
    const server = startServer({
      "GET /admin/notify/7": {
        id: 7,
        status: "sent",
        subject: "Old",
        recipient_group: "all",
        category: null,
        recall_reference: null,
        queued_count: 0,
        delivered_count: 0,
        failure_count: 0,
        unknown_count: 0,
        failed_recipients: [],
        sent_at: "2026-10-01 12:00:00",
      },
    });
    try {
      const r = await runCli(["admin", "notify", "--status", "7"], server.url);
      expect(r.stdout).not.toContain("Category:");
    } finally {
      server.stop();
    }
  });
});
