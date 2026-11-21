/**
 * CLI `nemar auth mail` (epic #2260 phase 4, ADR 0132), driven through the real entry point
 * (`bun run src/index.ts auth mail ...`) against a Bun.serve stand-in reached via TEST_API_URL, the
 * harness of test/auth-request-upload-access-cli.test.ts. No mocks: the stand-in answers the two
 * routes with what the backend answers, and keeps the state a PUT sets.
 *
 * What it holds: `auth mail` and `auth mail show` print the four categories with their account-copy
 * labels and on or off, recalls as always on with the sentence that says why; `set <category> <on|off>`
 * sends exactly that one key; `set all off` sends all three as false; `all on`, a bad category,
 * `recall` and a bad value are refused before any request; a backend refusal's sentence reaches the
 * terminal; and an unauthenticated run sends nothing and exits 1.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { ACCOUNT_COPY } from "../shared/contract/account-copy.js";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const PATH = "/users/me/email-preferences";

interface StandIn {
  url: string;
  puts: unknown[];
  requests: string[];
  stop: () => void;
}

/** Answers the two preference routes; a PUT merges its body into the state, like the backend. */
function startStandIn(
  initial = { news: true, rfcs: false, maintenance: true },
  refusal?: { status: number; body: unknown },
): StandIn {
  const state: Record<string, boolean> = { ...initial };
  const puts: unknown[] = [];
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      if (url.pathname === PATH) {
        requests.push(req.method);
        if (req.headers.get("authorization") !== "Bearer test-user-key") {
          return Response.json({ error: "Missing Authorization header" }, { status: 401 });
        }
        if (req.method === "PUT") {
          const body = (await req.json()) as Record<string, boolean>;
          puts.push(body);
          if (refusal) return Response.json(refusal.body, { status: refusal.status });
          Object.assign(state, body);
        }
        return Response.json({ ...state, recall: { on: true, locked: true } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    puts,
    requests,
    stop: () => server.stop(true),
  };
}

let configDir: string;

function seedAuthenticatedConfig(): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "reader",
      accounts: { reader: { apiKey: "test-user-key" } },
    }),
  );
}

async function runCli(
  args: string[],
  testApiUrl: string,
): Promise<{ stdout: string; stderr: string; out: string; exitCode: number }> {
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
  const exitCode = await proc.exited;
  return { stdout, stderr, out: `${stdout}${stderr}`, exitCode };
}

/** The line of `out` that starts with a category's label, whitespace collapsed. */
function lineFor(out: string, label: string): string {
  const line = out.split("\n").find((l) => l.trim().startsWith(`${label} `));
  return (line ?? "").replace(/\s+/g, " ").trim();
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-auth-mail-cli-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("nemar auth mail", () => {
  for (const args of [
    ["auth", "mail"],
    ["auth", "mail", "show"],
  ]) {
    test(`${args.join(" ")} prints the four categories with their labels and state`, async () => {
      seedAuthenticatedConfig();
      const standIn = startStandIn();
      try {
        const result = await runCli(args, standIn.url);
        expect(result.exitCode).toBe(0);
        expect(standIn.requests).toEqual(["GET"]);
        expect(lineFor(result.stdout, ACCOUNT_COPY["mail.category.news.label"])).toBe(
          `${ACCOUNT_COPY["mail.category.news.label"]} on ${ACCOUNT_COPY["mail.category.news.description"]}`,
        );
        expect(lineFor(result.stdout, ACCOUNT_COPY["mail.category.rfcs.label"])).toBe(
          `${ACCOUNT_COPY["mail.category.rfcs.label"]} off ${ACCOUNT_COPY["mail.category.rfcs.description"]}`,
        );
        expect(lineFor(result.stdout, ACCOUNT_COPY["mail.category.maintenance.label"])).toBe(
          `${ACCOUNT_COPY["mail.category.maintenance.label"]} on ${ACCOUNT_COPY["mail.category.maintenance.description"]}`,
        );
        expect(lineFor(result.stdout, ACCOUNT_COPY["mail.category.recall.label"])).toBe(
          `${ACCOUNT_COPY["mail.category.recall.label"]} always on ${ACCOUNT_COPY["mail.category.recall.description"]}`,
        );
        expect(result.stdout).toContain(ACCOUNT_COPY["mail.recall.why"]);
      } finally {
        standIn.stop();
      }
    });
  }

  test("not signed in: sends nothing and exits 1", async () => {
    const standIn = startStandIn();
    try {
      const result = await runCli(["auth", "mail"], standIn.url);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Not authenticated");
      expect(standIn.requests).toEqual([]);
    } finally {
      standIn.stop();
    }
  });
});

describe("nemar auth mail set", () => {
  test("set news off sends that one key and prints the new state", async () => {
    seedAuthenticatedConfig();
    const standIn = startStandIn();
    try {
      const result = await runCli(["auth", "mail", "set", "news", "off"], standIn.url);
      expect(result.exitCode).toBe(0);
      expect(standIn.puts).toEqual([{ news: false }]);
      expect(result.out).toContain(`${ACCOUNT_COPY["mail.category.news.label"]} turned off`);
      expect(lineFor(result.stdout, ACCOUNT_COPY["mail.category.news.label"])).toStartWith(
        `${ACCOUNT_COPY["mail.category.news.label"]} off`,
      );
    } finally {
      standIn.stop();
    }
  });

  test("set rfcs on sends that one key", async () => {
    seedAuthenticatedConfig();
    const standIn = startStandIn();
    try {
      const result = await runCli(["auth", "mail", "set", "rfcs", "on"], standIn.url);
      expect(result.exitCode).toBe(0);
      expect(standIn.puts).toEqual([{ rfcs: true }]);
      expect(lineFor(result.stdout, ACCOUNT_COPY["mail.category.rfcs.label"])).toStartWith(
        `${ACCOUNT_COPY["mail.category.rfcs.label"]} on`,
      );
    } finally {
      standIn.stop();
    }
  });

  test("set all off sends all three categories as false", async () => {
    seedAuthenticatedConfig();
    const standIn = startStandIn();
    try {
      const result = await runCli(["auth", "mail", "set", "all", "off"], standIn.url);
      expect(result.exitCode).toBe(0);
      expect(standIn.puts).toEqual([{ news: false, rfcs: false, maintenance: false }]);
      expect(result.out).toContain("Every category that can be turned off is off");
      expect(lineFor(result.stdout, ACCOUNT_COPY["mail.category.recall.label"])).toStartWith(
        `${ACCOUNT_COPY["mail.category.recall.label"]} always on`,
      );
    } finally {
      standIn.stop();
    }
  });

  test("set all on is refused before any request", async () => {
    seedAuthenticatedConfig();
    const standIn = startStandIn();
    try {
      const result = await runCli(["auth", "mail", "set", "all", "on"], standIn.url);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("'all' only turns everything off");
      expect(standIn.requests).toEqual([]);
    } finally {
      standIn.stop();
    }
  });

  test("recall is refused with the sentence that says why", async () => {
    seedAuthenticatedConfig();
    const standIn = startStandIn();
    try {
      const result = await runCli(["auth", "mail", "set", "recall", "off"], standIn.url);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(ACCOUNT_COPY["mail.recall.why"]);
      expect(standIn.requests).toEqual([]);
    } finally {
      standIn.stop();
    }
  });

  test("a bad category and a bad value are refused before any request", async () => {
    seedAuthenticatedConfig();
    const standIn = startStandIn();
    try {
      const badCategory = await runCli(["auth", "mail", "set", "newsletter", "off"], standIn.url);
      expect(badCategory.exitCode).toBe(1);
      expect(badCategory.stderr).toContain("Expected one of news, rfcs, maintenance, or all");

      const badValue = await runCli(["auth", "mail", "set", "news", "maybe"], standIn.url);
      expect(badValue.exitCode).toBe(1);
      expect(badValue.stderr).toContain("Expected on or off");

      expect(standIn.requests).toEqual([]);
    } finally {
      standIn.stop();
    }
  });

  test("a backend refusal prints its sentence, not its code, and exits 1", async () => {
    seedAuthenticatedConfig();
    const sentence = "news must be true or false.";
    const standIn = startStandIn(undefined, {
      status: 400,
      body: { error: "invalid_mail_preference", field: "news", message: sentence },
    });
    try {
      const result = await runCli(["auth", "mail", "set", "news", "off"], standIn.url);
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain(sentence);
    } finally {
      standIn.stop();
    }
  });
});
