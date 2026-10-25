/**
 * How execution pushes and how it finds or opens the pull request (`push.ts`, `pull-request.ts`;
 * ADR 0111, decision 2; epic #1046 phase 6, #1912).
 *
 * Pushes are the REAL `git push --porcelain` to real local bare repositories, one with a
 * `pre-receive` hook, one that has moved, one that does not exist, an HTTP address nobody listens
 * on and an HTTP server that refuses credentials. GitHub is a `Bun.serve()` stand-in that answers
 * the open-pull-request list and the create call as scripted. No mocks of the code under test.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRelease, pushRelease } from "../src/lib/repull/execute/pull-request";
import { guardedPush } from "../src/lib/repull/execute/push";
import { ExecuteRefused } from "../src/lib/repull/execute/verify-plan";

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function g(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: dir, env: ENV });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const VERSION = "2.0.0";
const REF = `refs/heads/release/v${VERSION}`;
const CTX = { versions: [VERSION] };

let root: string;
let work: string;
let origin: string;
let sha: string;

function commit(dir: string, file: string, content: string): string {
  writeFileSync(join(dir, file), content);
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", file);
  return g(dir, "rev-parse", "HEAD");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nemar-repull-push-"));
  origin = join(root, "origin.git");
  g(root, "init", "-q", "--bare", "-b", "main", origin);
  work = join(root, "work");
  mkdirSync(work);
  g(work, "init", "-q", "-b", "main");
  sha = commit(work, "a.txt", "a\n");
  g(work, "remote", "add", "origin", origin);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function hook(body: string): void {
  const path = join(origin, "hooks", "pre-receive");
  mkdirSync(join(origin, "hooks"), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

describe("a push is told apart by what happened to it", () => {
  test("a new branch is pushed, and the same commit again is up to date", async () => {
    expect(await guardedPush(work, [`${sha}:${REF}`], CTX, ENV)).toEqual({
      outcome: "pushed",
      cause: null,
    });
    expect(g(origin, "rev-parse", REF)).toBe(sha);
    expect(await guardedPush(work, [`${sha}:${REF}`], CTX, ENV)).toEqual({
      outcome: "up-to-date",
      cause: null,
    });
  });

  test("a branch that moved under the push is rejected as a race, to be read again", async () => {
    // Origin's branch holds a commit that is not an ancestor of the one pushed.
    const other = join(root, "other");
    mkdirSync(other);
    g(other, "init", "-q", "-b", "main");
    const moved = commit(other, "b.txt", "b\n");
    g(other, "push", "-q", origin, `${moved}:${REF}`);
    expect(await guardedPush(work, [`${sha}:${REF}`], CTX, ENV)).toEqual({
      outcome: "rejected",
      cause: "moved",
    });
    expect(g(origin, "rev-parse", REF)).toBe(moved);
  });

  test("a hook on the remote that declines is a remote rejection, not a race", async () => {
    hook('echo "declined by policy" >&2\nexit 1');
    const result = await guardedPush(work, [`${sha}:${REF}`], CTX, ENV);
    expect(result).toEqual({ outcome: "remote-rejected", cause: "hook-declined" });
  });

  test("a protected-branch refusal is named as one", async () => {
    hook('echo "GH006: Protected branch update failed" >&2\nexit 1');
    const result = await guardedPush(work, [`${sha}:${REF}`], CTX, ENV);
    expect(result).toEqual({ outcome: "remote-rejected", cause: "protected-branch" });
  });

  test("a failed push carries a cause: a missing repository, an unreachable server, refused credentials", async () => {
    g(work, "remote", "set-url", "origin", join(root, "nowhere.git"));
    const missing = await guardedPush(work, [`${sha}:${REF}`], CTX, ENV);
    expect(missing.outcome).toBe("failed");
    expect(missing.cause).toBe("unknown");

    g(work, "remote", "set-url", "origin", "http://127.0.0.1:1/x.git");
    const unreachable = await guardedPush(work, [`${sha}:${REF}`], CTX, ENV);
    expect(unreachable).toEqual({ outcome: "failed", cause: "network" });

    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("no", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="x"' } }),
    });
    try {
      g(work, "remote", "set-url", "origin", `http://127.0.0.1:${server.port}/x.git`);
      const refused = await guardedPush(work, [`${sha}:${REF}`], CTX, ENV);
      expect(refused).toEqual({ outcome: "failed", cause: "authentication" });
    } finally {
      server.stop(true);
    }
  });

  test("the guard still runs first: a push outside the list never reaches git", async () => {
    await expect(guardedPush(work, [`${sha}:refs/heads/main`], CTX, ENV)).rejects.toThrow(
      "write guard",
    );
    expect(Bun.spawnSync(["git", "rev-parse", "main"], { cwd: origin }).exitCode).not.toBe(0);
  });
});

describe("the release branch push", () => {
  test("a remote's own refusal stops at once, names the class, and is not tried a second time", async () => {
    const counter = join(root, "attempts");
    hook(`echo x >> "${counter}"\nexit 1`);
    const err = await pushRelease({
      work,
      synthSha: sha,
      version: VERSION,
      push: CTX,
      env: ENV,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ExecuteRefused);
    expect((err as ExecuteRefused).code).toBe("push-refused");
    expect((err as ExecuteRefused).message).toContain("a hook on the remote declined it");
    expect(await Bun.file(counter).text()).toBe("x\n");
  });

  test("a failed push says why", async () => {
    g(work, "remote", "set-url", "origin", "http://127.0.0.1:1/x.git");
    const err = await pushRelease({
      work,
      synthSha: sha,
      version: VERSION,
      push: CTX,
      env: ENV,
    }).catch((e) => e);
    expect((err as ExecuteRefused).code).toBe("origin-unreadable");
  });
});

// ---------------------------------------------------------------------------------------------
// The pull request: found among the open ones, or opened.
// ---------------------------------------------------------------------------------------------

const DS = "xx099971";
const OWN = `nemarDatasets/${DS}`;
const HEAD = "a".repeat(40);

interface Scripted {
  list: { status: number; body: unknown };
  create: { status: number; body: unknown; raw?: string };
}

let gh: ReturnType<typeof Bun.serve>;
let script: Scripted;
let posts: number;

beforeAll(() => {
  gh = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (req.method === "GET")
        return Response.json(script.list.body, { status: script.list.status });
      posts++;
      await req.text();
      if (script.create.raw !== undefined) {
        return new Response(script.create.raw, { status: script.create.status });
      }
      return Response.json(script.create.body, { status: script.create.status });
    },
  });
});

afterAll(() => gh?.stop(true));

beforeEach(() => {
  script = { list: { status: 200, body: [] }, create: { status: 201, body: {} } };
  posts = 0;
});

function pull(over: {
  number?: number;
  ref?: string;
  sha?: string;
  repo?: string | null;
  base?: string;
}) {
  return {
    number: over.number ?? 7,
    state: "open",
    head: {
      ref: over.ref ?? `release/v${VERSION}`,
      sha: over.sha ?? HEAD,
      repo: over.repo === null ? null : { full_name: over.repo ?? OWN },
    },
    base: { ref: over.base ?? "main" },
  };
}

type Verdict = "ok" | "foreign" | "unreadable";

async function open(
  verdict: Verdict = "ok",
): Promise<ExecuteRefused | Awaited<ReturnType<typeof openRelease>>> {
  try {
    return await openRelease({
      token: "t",
      base: `http://127.0.0.1:${gh.port}`,
      datasetId: DS,
      version: VERSION,
      body: "body",
      acceptHead: async () => verdict,
    });
  } catch (err) {
    if (err instanceof ExecuteRefused) return err;
    throw err;
  }
}

function code(r: unknown): string {
  expect(r).toBeInstanceOf(ExecuteRefused);
  return (r as ExecuteRefused).code;
}

describe("finding the open pull request", () => {
  test("the dataset's own pull request into main at an accepted head is reused, and nothing is opened", async () => {
    script.list.body = [pull({})];
    expect(await open()).toEqual({ number: 7, head: HEAD, reused: true });
    expect(posts).toBe(0);
  });

  test("a fork's pull request from a branch of the same name is not reused", async () => {
    script.list.body = [pull({ repo: "someone/xx099971" })];
    expect(code(await open())).toBe("release-pr-open");
    expect(posts).toBe(0);
  });

  test("a pull request whose head repository GitHub no longer names (a deleted fork) fails closed", async () => {
    script.list.body = [pull({ repo: null })];
    expect(code(await open())).toBe("release-pr-open");
    expect(posts).toBe(0);
  });

  test("a found pull request into another base is refused, and the head is not even judged", async () => {
    script.list.body = [pull({ base: "dev" })];
    expect(code(await open("ok"))).toBe("pr-foreign");
    expect(posts).toBe(0);
  });

  test("a found pull request at a foreign head is refused; one that cannot be read is another word", async () => {
    script.list.body = [pull({})];
    expect(code(await open("foreign"))).toBe("pr-foreign");
    expect(code(await open("unreadable"))).toBe("pr-unreadable");
    expect(posts).toBe(0);
  });

  test("another release pull request open refuses, and 100 open or an unreadable list cannot be judged", async () => {
    script.list.body = [pull({ number: 3, ref: "release/v1.1.0" })];
    expect(code(await open())).toBe("release-pr-open");
    script.list.body = Array.from({ length: 100 }, (_, i) => pull({ number: i + 1, ref: `f${i}` }));
    expect(code(await open())).toBe("github-unreadable");
    script.list = { status: 500, body: {} };
    expect(code(await open())).toBe("github-unreadable");
    script.list = { status: 200, body: [{ number: "x" }] };
    expect(code(await open())).toBe("github-unreadable");
    expect(posts).toBe(0);
  });
});

describe("opening it", () => {
  test("a 201 whose answer names the branch, main and an accepted head is the new pull request", async () => {
    script.create = { status: 201, body: pull({ number: 9 }) };
    expect(await open()).toEqual({ number: 9, head: HEAD, reused: false });
    expect(posts).toBe(1);
  });

  test("a 422 or a 403 is refused with a fixed word and the reason GitHub gave", async () => {
    for (const status of [422, 403]) {
      script.create = { status, body: { message: "Validation Failed" } };
      const r = await open();
      expect(code(r)).toBe("pr-create-refused");
      expect((r as ExecuteRefused).message).toContain(`HTTP ${status}`);
    }
  });

  test("a 201 whose body does not parse is reported as created with an unreadable answer, not as refused", async () => {
    script.create = { status: 201, body: null, raw: "<html>not json</html>" };
    const r = await open();
    expect(code(r)).toBe("pr-created-unreadable");
    expect((r as ExecuteRefused).message).toContain("opened");
    expect((r as ExecuteRefused).message).not.toContain("refused");
    script.create = { status: 201, body: { number: 4 } };
    expect(code(await open())).toBe("pr-created-unreadable");
  });

  test("a 5xx is unknown, and a created pull request at another head, branch or base is foreign", async () => {
    script.create = { status: 502, body: {} };
    expect(code(await open())).toBe("pr-create-unknown");
    script.create = { status: 201, body: pull({ ref: "release/v9.9.9" }) };
    expect(code(await open())).toBe("pr-foreign");
    script.create = { status: 201, body: pull({ base: "dev" }) };
    expect(code(await open())).toBe("pr-foreign");
    script.create = { status: 201, body: pull({}) };
    expect(code(await open("foreign"))).toBe("pr-foreign");
    expect(code(await open("unreadable"))).toBe("pr-unreadable");
  });
});

describe("a ref that moves under a push is a race, whoever reports it", () => {
  test("origin moving after git read it is rejected as moved, to be written again, not as a remote refusal", async () => {
    // Push once so origin has the branch, then move it from a pre-push hook of the working clone.
    expect((await guardedPush(work, [`${sha}:${REF}`], CTX, ENV)).outcome).toBe("pushed");
    const next = commit(work, "b.txt", "b\n");
    const hooks = join(root, "hooks");
    mkdirSync(hooks);
    writeFileSync(
      join(hooks, "pre-push"),
      `#!/bin/sh\nparent=$(git --git-dir="${origin}" rev-parse ${REF})\ntree=$(git --git-dir="${origin}" rev-parse "$parent^{tree}")\nc=$(git --git-dir="${origin}" commit-tree "$tree" -p "$parent" -m race)\ngit --git-dir="${origin}" update-ref ${REF} "$c"\n`,
    );
    chmodSync(join(hooks, "pre-push"), 0o755);
    g(work, "config", "core.hooksPath", hooks);
    expect(await guardedPush(work, [`${next}:${REF}`], CTX, ENV)).toEqual({
      outcome: "rejected",
      cause: "moved",
    });
  });
});
