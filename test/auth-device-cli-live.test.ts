/**
 * Live end-to-end tests for `nemar auth login`/`signup`/`status`/`keys`/
 * `logout` over the device authorization grant (RFC 8628; epic #1272 phase
 * 3, #1283; ADR 0047) -- the CLI subprocess half of what
 * test/auth-device-flow.test.ts already drives directly against the REST
 * routes.
 *
 * Targets a deployed backend (set TEST_API_URL; defaults to api.nemar.org
 * per test/setup.ts). The dev worker deploys only from `dev`
 * (.github/workflows/deploy-backend.yml's push trigger), so this phase's
 * CLI-facing wiring is not guaranteed to
 * be live on whatever backend TEST_API_URL points at until the epic branch
 * reaches dev. This file probes `POST /auth/device/start` first; a 404
 * means the routes are not deployed yet, and every case below skips itself
 * with a loud console message rather than failing.
 *
 * Prod-traffic safeguard, matching test/auth-device-flow.test.ts and
 * test/auth-passwordless.test.ts: if TEST_API_URL points at api.nemar.org or
 * data.nemar.org, the suite skips itself unless TEST_ALLOW_PROD=1.
 *
 * The CLI side runs as a REAL subprocess (`bun run src/index.ts ...`),
 * streamed so a test can read the printed user code off stdout and act on
 * it from the "browser" side (a seeded web session, via the same
 * `POST /auth/code/request` + echoed `dev_code` + `POST /auth/code/verify`
 * passwordless flow test/auth-device-flow.test.ts uses) while the CLI is
 * still polling in the background.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import "./setup";
import { TEST_CONFIG } from "./setup";

const API = TEST_CONFIG.apiUrl;
const ORIGIN = "https://app.nemar.org";
const POINTS_AT_PROD = API.includes("api.nemar.org") || API.includes("data.nemar.org");
const PROD_GUARD_ACTIVE = POINTS_AT_PROD && !process.env.TEST_ALLOW_PROD;

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

const baseHeaders: Record<string, string> = TEST_CONFIG.bypassToken
  ? { "X-Test-Bypass": TEST_CONFIG.bypassToken }
  : {};

function freshEmail(label: string): string {
  return `dcli-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@nemar.test`;
}

async function postJson(
  path: string,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...baseHeaders, ...extra },
    body: JSON.stringify(body),
  });
}

/** Returns the seeded row's numeric id (`{ user: { id, email, status } }`,
 *  backend/src/routes/admin/users.ts) -- the same id `POST
 *  /admin/revoke/by-id/:id` takes, so a caller that needs to revoke this
 *  fixture mid-test does not have to invent a second lookup for it. */
async function seedWebUser(
  email: string,
  status: "pending" | "verified" | "approved" | "revoked",
): Promise<{ id: number }> {
  const r = await fetch(`${API}/admin/test-fixtures/seed-web-user`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_CONFIG.adminApiKey}`,
      ...baseHeaders,
    },
    body: JSON.stringify({ email, status }),
  });
  if (r.status !== 200) {
    throw new Error(`seedWebUser failed (${r.status}): ${await r.text()}`);
  }
  const body = (await r.json()) as { user: { id: number } };
  return { id: body.user.id };
}

interface CodeRequestResponse {
  ok: boolean;
  dev_code?: string;
  dev_skip?: string;
  error?: string;
}

/** Sign in via the passwordless flow and return the `nemar_session` cookie
 *  header value -- the "browser" side of every case below. */
async function signIn(email: string): Promise<string> {
  const req = await postJson("/auth/code/request", { email });
  const reqBody = (await req.json()) as CodeRequestResponse;
  if (!reqBody.dev_code) {
    throw new Error(`no dev_code for ${email}: ${JSON.stringify(reqBody)}`);
  }
  const verify = await postJson(
    "/auth/code/verify",
    { email, code: reqBody.dev_code, remember: false },
    { Origin: ORIGIN },
  );
  const setCookie = verify.headers.get("Set-Cookie");
  const m = setCookie?.match(/nemar_session=([^;]+)/);
  if (!m) throw new Error(`sign-in did not set a session cookie for ${email}: ${verify.status}`);
  return `nemar_session=${m[1]}`;
}

let deviceRoutesDeployed = false;

beforeAll(async () => {
  if (PROD_GUARD_ACTIVE) return;
  const probe = await postJson("/auth/device/start", { machine_name: "deploy-probe" });
  deviceRoutesDeployed = probe.status !== 404;
  if (!deviceRoutesDeployed) {
    console.warn(
      "[auth-device-cli-live] SKIPPING every case: POST /auth/device/start answered 404. " +
        "The dev worker deploys only from `dev` (.github/workflows/deploy-backend.yml's " +
        "push trigger), so this phase's routes are not live on the backend TEST_API_URL " +
        "points at yet -- expected until the epic branch reaches dev.",
    );
  }
});

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-auth-device-cli-live-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

/** Spawns the CLI and resolves `codeReady` with the printed user code the
 *  moment it appears in stdout -- the CLI keeps polling in the background,
 *  so the caller can act on the "browser" side (confirm/deny) before
 *  awaiting `finished`. */
function runCliStreaming(args: string[]) {
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NEMAR_CONFIG_DIR: configDir,
      TEST_API_URL: API,
      NEMAR_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
      NEMAR_NO_BROWSER: "1",
      FORCE_COLOR: undefined,
      CLICOLOR_FORCE: undefined,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let stdoutAcc = "";
  let resolveCode: (code: string) => void;
  const codeReady = new Promise<string>((resolve) => {
    resolveCode = resolve;
  });
  let codeSeen = false;

  const stdoutDone = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      stdoutAcc += chunk;
      if (!codeSeen) {
        const match = stdoutAcc.match(/Code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/);
        if (match) {
          codeSeen = true;
          resolveCode(match[1]);
        }
      }
    }
    return stdoutAcc;
  })();
  const stderrDone = new Response(proc.stderr).text();

  const finished = (async () => {
    const stdout = await stdoutDone;
    const stderr = await stderrDone;
    const exitCode = await proc.exited;
    return { stdout, stderr, out: `${stdout}${stderr}`, exitCode };
  })();

  return { proc, codeReady, finished };
}

async function runCli(args: string[]) {
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NEMAR_CONFIG_DIR: configDir,
      TEST_API_URL: API,
      NEMAR_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
      NEMAR_NO_BROWSER: "1",
      FORCE_COLOR: undefined,
      CLICOLOR_FORCE: undefined,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, out: `${stdout}${stderr}`, exitCode };
}

describe.skipIf(PROD_GUARD_ACTIVE)(
  "nemar auth login/status/keys/logout, live (#1283, ADR 0047)",
  () => {
    test("the full loop: login, status, keys shows current, logout revokes it", async () => {
      if (!deviceRoutesDeployed) return;
      const email = freshEmail("full-loop");
      await seedWebUser(email, "verified");
      const cookie = await signIn(email);

      const cli = runCliStreaming(["auth", "login", "--no-open"]);
      const userCode = await cli.codeReady;

      const confirmRes = await postJson(
        "/auth/device/confirm",
        { code: userCode },
        { Origin: ORIGIN, Cookie: cookie },
      );
      expect(confirmRes.status).toBe(200);

      const result = await cli.finished;
      expect(result.exitCode).toBe(0);
      expect(result.out).toContain("Welcome");

      const status = await runCli(["auth", "status"]);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("Key:");

      const keys = await runCli(["auth", "keys"]);
      expect(keys.exitCode).toBe(0);
      expect(keys.stdout).toContain("(this machine)");

      // Read the minted key straight from the config file the device flow
      // just wrote, BEFORE logout clears it -- the CLI never prints a login's
      // own key value to stdout (only `keys create` does).
      const mintedKey = readMintedApiKey(configDir);
      const meBefore = await fetch(`${API}/users/me`, {
        headers: { ...baseHeaders, Authorization: `Bearer ${mintedKey}` },
      });
      expect(meBefore.status).toBe(200);

      const logout = await runCli(["auth", "logout", "-y"]);
      expect(logout.exitCode).toBe(0);

      // The revoked key no longer authenticates.
      const meAfter = await fetch(`${API}/users/me`, {
        headers: { ...baseHeaders, Authorization: `Bearer ${mintedKey}` },
      });
      expect(meAfter.status).toBe(401);
    }, 60000);

    test("deny: the CLI prints the contract sentence and exits 1", async () => {
      if (!deviceRoutesDeployed) return;
      const email = freshEmail("deny");
      await seedWebUser(email, "verified");
      const cookie = await signIn(email);

      const cli = runCliStreaming(["auth", "login", "--no-open"]);
      const userCode = await cli.codeReady;

      const denyRes = await postJson(
        "/auth/device/deny",
        { code: userCode },
        { Origin: ORIGIN, Cookie: cookie },
      );
      expect(denyRes.status).toBe(200);

      const result = await cli.finished;
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain(
        "This sign-in was declined in the browser. Run `nemar auth login` again if that was a mistake.",
      );
    }, 60000);

    test("a pending account cannot confirm (REST-level; matches test/auth-device-flow.test.ts)", async () => {
      if (!deviceRoutesDeployed) return;
      const email = freshEmail("pending-confirm");
      await seedWebUser(email, "pending");
      const cookie = await signIn(email);
      const started = await postJson("/auth/device/start", { machine_name: "e2e-pending-machine" });
      const { user_code: userCode } = (await started.json()) as { user_code: string };
      const res = await postJson(
        "/auth/device/confirm",
        { code: userCode },
        { Origin: ORIGIN, Cookie: cookie },
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("account_pending");
    });

    test("an account revoked between confirm and collect: the CLI's terminal sentence", async () => {
      if (!deviceRoutesDeployed) return;
      const email = freshEmail("revoke-midflight");
      const { id } = await seedWebUser(email, "verified");
      const cookie = await signIn(email);

      const cli = runCliStreaming(["auth", "login", "--no-open"]);
      const userCode = await cli.codeReady;

      const confirmRes = await postJson(
        "/auth/device/confirm",
        { code: userCode },
        { Origin: ORIGIN, Cookie: cookie },
      );
      expect(confirmRes.status).toBe(200);

      // Revoke the account before the CLI's next poll collects the key, by
      // the id seedWebUser returned -- not best-effort: a revoke that did
      // not actually land would make this test pass for the wrong reason
      // (a poll that happens to hit some OTHER terminal state).
      const revokeRes = await fetch(`${API}/admin/revoke/by-id/${id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_CONFIG.adminApiKey}`, ...baseHeaders },
      });
      expect(revokeRes.status).toBe(200);

      const result = await cli.finished;
      expect(result.exitCode).toBe(1);
    }, 60000);

    test("signup with flags lands the PATCH and the upload-access request", async () => {
      if (!deviceRoutesDeployed) return;
      const email = freshEmail("signup-flags");
      // A brand-new email that has never signed in before is exactly the
      // "ORCID creates the account" case this phase's signup targets, but
      // driving REAL ORCID consent is out of reach for an automated test --
      // seedWebUser instead plants a verified account it can sign into,
      // which exercises the SAME completion path (device flow, then
      // profile_gaps-driven completion) without a from-scratch ORCID
      // account. That gap is a known limit; nemarOrg/nemar-cli#1283 records
      // the manual walk-through for the true from-scratch path.
      await seedWebUser(email, "verified");
      const cookie = await signIn(email);

      const cli = runCliStreaming([
        "auth",
        "signup",
        "--no-open",
        "--github",
        "octocat",
        "--city",
        "San Diego",
        "--country",
        "USA",
        "--why",
        "Depositing our lab's 64-channel EEG study of motor imagery, 40 participants.",
      ]);
      const userCode = await cli.codeReady;
      const confirmRes = await postJson(
        "/auth/device/confirm",
        { code: userCode },
        { Origin: ORIGIN, Cookie: cookie },
      );
      expect(confirmRes.status).toBe(200);

      const result = await cli.finished;
      expect(result.exitCode).toBe(0);
    }, 60000);

    test.todo("a service account cannot sign in via the device flow (phase 4)");
  },
);

/** The active account's `apiKey`, read straight off the on-disk config the
 *  CLI just wrote. The CLI itself never prints a login's own key value to
 *  stdout (only `keys create` does), so a test that needs to act AS the
 *  key it just minted -- proving a later logout actually revoked it --
 *  has to read it from the same file `nemar auth status` does. */
function readMintedApiKey(dir: string): string {
  const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as {
    activeAccount?: string;
    accounts?: Record<string, { apiKey?: string }>;
  };
  const active = raw.activeAccount ? raw.accounts?.[raw.activeAccount] : undefined;
  if (!active?.apiKey) throw new Error(`no active account with an apiKey in ${dir}/config.json`);
  return active.apiKey;
}
