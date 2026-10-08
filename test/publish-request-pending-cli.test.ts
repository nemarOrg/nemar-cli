/**
 * `nemar dataset publish request` when BIDS validation has not finished yet
 * (issue #1646), driven through the real CLI entry point.
 *
 * Right after an upload the backend records the request as blocked and answers
 * 422 with block_reason `bids_validation_pending` or `bids_validation_in_progress`.
 * That is a pending state, not a rejection: the CLI says so in the info style and
 * exits 0, and it never waits or asks again on its own. A real refusal (a failed
 * validation, a missing minimum, a request already open, an identifier finding)
 * still exits 1 with its own text.
 *
 * The CLI is a real subprocess (`bun run src/index.ts ...`) pointed at a local
 * stand-in backend through config.json (the account's apiUrl) with a placeholder
 * key. The stand-in answers the two calls every invocation makes on its own
 * (the notices banner and the facets refresh) and the one route under test; it
 * is the HTTP condition the CLIENT is checked against, not a replacement for any
 * CLI logic. Nothing here may reach the network, the real API or a real
 * repository.
 *
 * test.yml sorts a test file into the integration-dev tier when its TEXT matches a
 * grep for the live-backend environment variable, the request helper or the
 * CLI-runner helper, and that grep reads comments too, so none of those three
 * names appears anywhere in this file: it stays in the offline unit-pure tier.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const REPO_ROOT = join(import.meta.dir, "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "index.ts");
const DATASET_ID = "nm099999";
const SPAWN_KILL_MS = 20_000;
const SPAWN_TEST_TIMEOUT_MS = 30_000;
// Variables kept out of the child. A proxy can send even a loopback request
// elsewhere; color forcing would change the text the tests read (the one test
// that WANTS color asks for it explicitly).
const SCRUBBED_ENV = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "FORCE_COLOR",
  "CLICOLOR_FORCE",
  "NO_COLOR",
];

// ANSI sequences for red text, in the forms a 16-, 256- and true-color terminal
// get: the error styling the pending state must not carry.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point
const RED = /\u001b\[(?:[0-9;]*;)?(?:31|91)m|\u001b\[38;5;(?:1|9|160|196)m|\u001b\[38;2;2[0-9]{2};/;
const FAIL_MARK = /[✖×]/;

// What the backend sends for each refusal, taken from the shapes
// backend/src/routes/datasets/publication.ts returns.
const PENDING_BODY = {
  status: "blocked",
  block_reason: "bids_validation_pending",
  message:
    "BIDS validation has not run yet. Please wait for CI to complete, then re-request publication.",
  dataset_id: DATASET_ID,
  anonymous: false,
};
const IN_PROGRESS_BODY = {
  ...PENDING_BODY,
  block_reason: "bids_validation_in_progress",
  message:
    "BIDS validation is currently running. Please wait for it to complete, then re-request publication.",
};
const FAILED_BODY = {
  ...PENDING_BODY,
  block_reason: "bids_validation_failed",
  message:
    "BIDS validation is failing on your dataset. Please check the repository CI and fix validation errors, then re-request publication.",
};
const MINIMUMS_BODY = {
  ...PENDING_BODY,
  block_reason: "min_requirements_failed",
  message:
    "The dataset does not meet the minimum submission requirements. Fix the stated items and re-request publication.",
  reasons: ["The dataset name is shorter than 25 characters.", "No ethics statement was found."],
  policy_url: "https://docs.nemar.org/policy/submission/",
  details: {
    reasons: ["The dataset name is shorter than 25 characters.", "No ethics statement was found."],
    policy_url: "https://docs.nemar.org/policy/submission/",
  },
};
const SCREEN_BODY = {
  ...PENDING_BODY,
  block_reason: "identifier_screen_findings",
  message:
    "The identifier screen found information that identifies a participant. Remove it, push the change, and request publication again.",
};
const ACCEPTED_BODY = {
  message: "Publication request submitted",
  dataset_id: DATASET_ID,
  status: "requested",
  anonymous: false,
  identifier_screen: {
    state: "pending",
    headline: "Identifier screen: running",
    tone: "note",
    lines: [],
  },
};

interface Reply {
  status: number;
  body: unknown;
}

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

let configDir: string;
let backendUrl: string;
let backend: ReturnType<typeof Bun.serve>;
// Every request the stand-in saw, as "METHOD /path", and the request bodies.
const hits: string[] = [];
const bodies: string[] = [];
let reply: Reply;

beforeAll(() => {
  backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      // The two calls every invocation makes on its own: the notices banner
      // (a preAction hook) and a fire-and-forget facets refresh.
      if (pathname === "/notices") return Response.json({ notices: [] });
      if (pathname === "/datasets/facets") return Response.json({});
      hits.push(`${req.method} ${pathname}`);
      bodies.push(await req.text());
      if (pathname === `/datasets/${DATASET_ID}/publish/request`) {
        return Response.json(reply.body, { status: reply.status });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  backendUrl = `http://127.0.0.1:${backend.port}`;
});

afterAll(() => {
  backend.stop(true);
});

beforeEach(() => {
  hits.length = 0;
  bodies.length = 0;
  reply = { status: 200, body: ACCEPTED_BODY };
  configDir = mkdtempSync(join(tmpdir(), "nemar-publish-pending-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "pending-cli",
      accounts: { "pending-cli": { apiUrl: backendUrl, apiKey: "placeholder-key" } },
    }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

async function spawnCli(args: string[], opts: { color?: boolean } = {}): Promise<Run> {
  // Drop every TEST_* variable and the scrubbed set, in either case, so nothing
  // ambient can override the config.json URL or reroute the request.
  const env: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("TEST_") && !SCRUBBED_ENV.includes(key.toUpperCase()),
    ),
  );
  env.NEMAR_CONFIG_DIR = configDir;
  env.NEMAR_NO_UPDATE_CHECK = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  if (opts.color) env.FORCE_COLOR = "1";
  else env.NO_COLOR = "1";
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: SPAWN_KILL_MS,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // Bun's timeout ends the process with SIGTERM. A command that waits or polls
  // would end up here, which is the failure to report as itself.
  if (proc.signalCode) {
    throw new Error(
      `nemar ${args.join(" ")} was ended by ${proc.signalCode} after ${SPAWN_KILL_MS}ms`,
    );
  }
  return { stdout, stderr, exitCode };
}

const request = (...extra: string[]) =>
  spawnCli(["dataset", "publish", "request", DATASET_ID, ...extra]);
const posts = () => hits.filter((h) => h === `POST /datasets/${DATASET_ID}/publish/request`);
const all = (r: Run) => `${r.stdout}\n${r.stderr}`;

describe("a CI-pending refusal is a pending state", () => {
  test(
    "not started: exits 0, says it is recorded, and points at the CI command",
    async () => {
      reply = { status: 422, body: PENDING_BODY };
      const r = await request();
      expect(r.exitCode).toBe(0);
      expect(all(r)).toContain("Request recorded: BIDS validation has not started yet.");
      expect(r.stdout).toContain("nemar dataset ci nm099999");
      expect(r.stdout).toContain("nemar dataset publish request nm099999");
      expect(r.stdout).toContain("re-checks the request automatically");
      // The server's own refusal sentence is not repeated as an error.
      expect(all(r)).not.toContain("re-request publication");
      expect(all(r)).not.toContain("Failed");
      // Once. No waiting, no asking again.
      expect(posts()).toHaveLength(1);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "running: exits 0 and the clause says so, not 'not started'",
    async () => {
      reply = { status: 422, body: IN_PROGRESS_BODY };
      const r = await request();
      expect(r.exitCode).toBe(0);
      expect(all(r)).toContain("Request recorded: BIDS validation is still running.");
      expect(all(r)).not.toContain("has not started yet");
      expect(r.stdout).toContain("nemar dataset ci nm099999");
      expect(posts()).toHaveLength(1);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "not started does not say it is running",
    async () => {
      reply = { status: 422, body: PENDING_BODY };
      const r = await request();
      expect(all(r)).not.toContain("still running");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "it carries no error styling: no red, no failure mark, on either stream",
    async () => {
      for (const body of [PENDING_BODY, IN_PROGRESS_BODY]) {
        reply = { status: 422, body };
        const r = await spawnColored();
        expect(r.exitCode).toBe(0);
        const text = all(r);
        // The next test proves this detector sees red when there is some.
        expect(text).not.toMatch(RED);
        expect(text).not.toMatch(FAIL_MARK);
        expect(text).toContain("Request recorded");
      }
    },
    SPAWN_TEST_TIMEOUT_MS * 2,
  );

  test(
    "control: the same detector does see red on a real refusal",
    async () => {
      reply = { status: 422, body: FAILED_BODY };
      const r = await spawnColored();
      expect(r.exitCode).toBe(1);
      expect(all(r)).toMatch(RED);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "an anonymous request is handed its flag back in the command to run again",
    async () => {
      reply = { status: 422, body: { ...PENDING_BODY, anonymous: true } };
      const r = await request("--anonymous");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("'nemar dataset publish request nm099999 --anonymous' again");
      expect(r.stdout).not.toContain("WARNING");
      expect(bodies[0]).toContain('"anonymous":true');
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "a plain request is not told to add the flag",
    async () => {
      reply = { status: 422, body: PENDING_BODY };
      const r = await request();
      expect(r.stdout).toContain("'nemar dataset publish request nm099999' again");
      expect(r.stdout).not.toContain("--anonymous");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "an anonymous request the server did not record as anonymous is warned about",
    async () => {
      reply = { status: 422, body: { ...PENDING_BODY, anonymous: undefined } };
      const r = await request("--anonymous");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("you asked for an anonymous release, but the server did not");
      expect(r.stdout).toContain("nemar dataset publish status nm099999");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("a real refusal still exits 1 with its own text", () => {
  test(
    "bids_validation_failed",
    async () => {
      reply = { status: 422, body: FAILED_BODY };
      const r = await request();
      expect(r.exitCode).toBe(1);
      expect(all(r)).toContain(FAILED_BODY.message);
      expect(all(r)).not.toContain("Request recorded");
      expect(posts()).toHaveLength(1);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "min_requirements_failed prints each reason and the policy",
    async () => {
      reply = { status: 422, body: MINIMUMS_BODY };
      const r = await request();
      expect(r.exitCode).toBe(1);
      expect(all(r)).toContain(MINIMUMS_BODY.message);
      expect(r.stdout).toContain("Not accepted for publication:");
      expect(r.stdout).toContain("The dataset name is shorter than 25 characters.");
      expect(r.stdout).toContain("No ethics statement was found.");
      expect(r.stdout).toContain("Policy: https://docs.nemar.org/policy/submission/");
      expect(all(r)).not.toContain("Request recorded");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "identifier_screen_findings",
    async () => {
      reply = { status: 422, body: SCREEN_BODY };
      const r = await request();
      expect(r.exitCode).toBe(1);
      expect(all(r)).toContain("The identifier screen found information that identifies");
      expect(all(r)).not.toContain("Request recorded");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "409, a request is already open",
    async () => {
      reply = {
        status: 409,
        body: { error: "A publication request for this dataset is already open." },
      };
      const r = await request();
      expect(r.exitCode).toBe(1);
      expect(all(r)).toContain("A publication request for this dataset is already open.");
      expect(r.stdout).toContain("nemar dataset publish resend");
      expect(all(r)).not.toContain("Request recorded");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "403, not the owner",
    async () => {
      reply = { status: 403, body: { error: "Only the dataset owner can request publication" } };
      const r = await request();
      expect(r.exitCode).toBe(1);
      expect(all(r)).toContain("Only the dataset owner can request publication");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "the pending reason on any other status is not a pending state",
    async () => {
      // The reason is read from a 422. The same word on a 500 is a server
      // fault, which keeps its error treatment and its exit code.
      reply = { status: 500, body: { ...PENDING_BODY, error: "Internal error" } };
      const r = await request();
      expect(r.exitCode).toBe(1);
      expect(all(r)).not.toContain("Request recorded");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("an accepted request", () => {
  test(
    "exits 0 and is told, among the rest, when it will be emailed",
    async () => {
      reply = { status: 200, body: ACCEPTED_BODY };
      const r = await request();
      expect(r.exitCode).toBe(0);
      const flat = r.stdout.replace(/\s+/g, " ");
      expect(flat).toContain("Your request was received.");
      expect(flat).toContain("NEMAR is checking publication eligibility.");
      expect(flat).toContain(
        "You will be emailed if a check needs your attention, and when an administrator decides.",
      );
      expect(flat).toContain("nemar dataset publish status nm099999");
      expect(all(r)).not.toContain("Request recorded");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("there is no --wait", () => {
  test(
    "the flag is refused as unknown and no request is sent",
    async () => {
      reply = { status: 422, body: PENDING_BODY };
      const r = await request("--wait");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("unknown option '--wait'");
      expect(posts()).toHaveLength(0);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "--help-all says validation runs after the upload and how to follow it",
    async () => {
      // The detailed text sits behind --help-all, as for every command.
      const r = await spawnCli(["dataset", "publish", "request", "--help-all"]);
      expect(r.exitCode).toBe(0);
      const flat = r.stdout.replace(/\s+/g, " ");
      expect(flat).toContain("BIDS validation runs after the upload and must complete first.");
      expect(flat).toContain("A request made earlier is recorded and proceeds on its own");
      expect(flat).toContain("nemar dataset ci <dataset-id>");
      expect(r.stdout).not.toContain("--wait");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

/** The pending/refused command with color forced on (the error styling is visible only then). */
function spawnColored(): Promise<Run> {
  return spawnCli(["dataset", "publish", "request", DATASET_ID], { color: true });
}
