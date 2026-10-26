/**
 * The unattended run's rules (`src/lib/repull/execute/automatic.ts`; epic #1046 phase 7, #1913;
 * ADR 0111, decision 6 and the Phase 7d amendment), each with a test that fails when its line is
 * changed:
 *  - the dispatch is exactly the nine keys the Worker's own builder writes, `repull_id` absent on
 *    a first dispatch, each of the shape the builder checks: a tenth key, a missing one, another
 *    type or another shape is `dispatch-invalid`, and no message carries a value;
 *  - the event is a `run-upstream-repull` repository dispatch;
 *  - the token on the command line, a CLI that is not the release the dispatch names, verbose or
 *    debug output, another kind of run or another dataset, and no App token each refuse, the token
 *    first;
 *  - every line the run prints has the fixed grammar, and a value off it is never printed;
 *  - the automatic path takes only an executable plan of the current planner with zero
 *    unexplained paths, conflicts and corrections, each stated, and a copy of known size within the
 *    bound;
 *  - a report carries the body the Worker's callback schema takes, the token only in its header,
 *    a code from the closed list, and the marker only for a terminal report the Worker stored; it
 *    and the token probe refuse a redirect rather than follow it;
 *  - the App token's hour: the copy's budget leaves the settle's share and the other steps', a run
 *    that cannot tell when its token was minted is refused, and a step whose work would pass the
 *    usable hour is refused before it starts, on an injected clock;
 *  - a crash after the Worker stored a terminal report ends with what it stored, and exits 1
 *    whatever happens while it writes its last lines.
 *
 * The happy path of a report reaches the REAL callback in `test/repull-automatic-cli.test.ts`;
 * here a fetch stand-in answers the statuses a callback can answer, for the error paths and the
 * retries (`.rules/testing.md`: HTTP fixtures for error paths and network failures).
 *
 * CI TIER: unit-pure. Pure functions, a temp directory, no server.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UPSTREAM_REPULL_EVENT,
  type UpstreamRepullDispatchFields,
  buildUpstreamRepullPayload,
} from "../backend/src/services/github/dispatch";
import { repullStateSchema } from "../backend/src/services/upstream-repull-dispatch";
import {
  APP_TOKEN_USABLE_SECONDS,
  AUTO_AFTER_COPY_SECONDS,
  AUTO_COPY_BUDGET_SECONDS,
  AUTO_COPY_BYTES_PER_SECOND,
  AUTO_MAX_COPY_BYTES,
  AUTO_OTHER_STEPS_SECONDS,
  AUTO_SETTLE_RESERVE_SECONDS,
  CURRENT_PLANNER_VERSION,
  DISPATCH_CODES,
  DISPATCH_FINAL_CODES,
  DISPATCH_ID_MAX,
  automaticCopySeconds,
  opensTheSameUtcDay,
} from "../shared/repull-state";
import {
  AUTOMATIC_LINE_RE,
  type AutomaticContext,
  type AutomaticSink,
  DISPATCH_EVENT,
  DISPATCH_PAYLOAD_KEYS,
  PRODUCTION_API,
  RESULT_LINE_RE,
  TOKEN_SINCE_ENV,
  appTokenRefused,
  assertAutomaticCounts,
  assertAutomaticPlan,
  automaticContext,
  automaticLine,
  automaticRefusal,
  copyBudgetSeconds,
  dispatchCodeOf,
  isAutomaticApi,
  isAutomaticInvocation,
  parseDispatchPayload,
  planCopySeconds,
  readDispatchEvent,
  reportDispatch,
  runUrlOf,
  tokenHourLeftMs,
  tokenHourRefusal,
  tokenOnArgvRefusal,
  tokenSinceOf,
} from "../src/lib/repull/execute/automatic";
import { automaticHooks } from "../src/lib/repull/execute/run";
import { SETTLE_QUIET_MS } from "../src/lib/repull/execute/settle";
import { ExecuteRefused } from "../src/lib/repull/execute/verify-plan";

const TOKEN = "c0ffee".repeat(11).slice(0, 64);

const fields = (
  over: Partial<UpstreamRepullDispatchFields> = {},
): UpstreamRepullDispatchFields => ({
  mode: "open",
  datasetId: "on099999",
  upstreamDs: "ds099999",
  fromTag: "1.0.0",
  toTag: "1.1.0",
  dispatchId: 7,
  repullId: null,
  token: TOKEN,
  cliVersion: "0.10.24",
  ...over,
});

/** The payload the Worker sends, through its own builder. */
const sent = (over: Partial<UpstreamRepullDispatchFields> = {}) =>
  buildUpstreamRepullPayload(fields(over)).client_payload;

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "nemar-repull-automatic-unit-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function refusalOf(fn: () => unknown): ExecuteRefused {
  try {
    fn();
  } catch (err) {
    if (err instanceof ExecuteRefused) return err;
    throw err;
  }
  throw new Error("nothing was refused");
}

describe("the dispatch is the nine keys the Worker sends", () => {
  test("the key list is the builder's, with repull_id the one that may be absent", () => {
    const resume = sent({ repullId: 42 });
    expect([...DISPATCH_PAYLOAD_KEYS].sort()).toEqual(Object.keys(resume).sort());
    expect(DISPATCH_PAYLOAD_KEYS).toHaveLength(9);
    expect(Object.keys(sent()).sort()).toEqual(
      DISPATCH_PAYLOAD_KEYS.filter((k) => k !== "repull_id").sort(),
    );
    expect(DISPATCH_EVENT).toBe(UPSTREAM_REPULL_EVENT);
  });

  test("whatever the builder sends is read back as it was built", () => {
    for (const over of [
      {},
      { repullId: 42 },
      { mode: "finish" as const, repullId: 9 },
      { fromTag: "00001", toTag: "v1.2.0" },
      { dispatchId: DISPATCH_ID_MAX, repullId: DISPATCH_ID_MAX },
    ]) {
      const f = fields(over);
      expect(parseDispatchPayload(sent(over))).toEqual({
        mode: f.mode,
        datasetId: f.datasetId,
        upstreamDs: f.upstreamDs,
        fromTag: f.fromTag,
        toTag: f.toTag,
        dispatchId: f.dispatchId,
        repullId: f.repullId,
        token: f.token,
        cliVersion: f.cliVersion,
      });
    }
  });

  test("a tenth key, a missing key, or a value that is not a string is refused", () => {
    const cases: Array<Record<string, unknown>> = [
      { ...sent(), callback_url: "https://example.org/x" },
      { ...sent({ repullId: 3 }), extra: "x" },
      (({ cli_version: _, ...rest }) => rest)(sent()),
      (({ dispatch_token: _, ...rest }) => rest)(sent()),
      (({ mode: _, ...rest }) => rest)(sent()),
      { ...sent(), dispatch_id: 7 },
      { ...sent(), repull_id: 3 },
      { ...sent(), mode: ["open"] },
    ];
    for (const c of cases) {
      const err = refusalOf(() => parseDispatchPayload(c));
      expect(err.code).toBe("dispatch-invalid");
      expect(err.message).not.toContain(TOKEN);
    }
    for (const notObject of [null, "x", 1, [sent()]]) {
      expect(refusalOf(() => parseDispatchPayload(notObject)).code).toBe("dispatch-invalid");
    }
  });

  test("every value the builder would refuse to send is refused here, naming no value", () => {
    const cases: Array<[string, string]> = [
      ["mode", "close"],
      ["dataset_id", "xx090001"],
      ["dataset_id", "on09999"],
      ["upstream_ds", "ds09999x"],
      ["from_tag", "1.0.0; rm -rf /"],
      ["to_tag", "../main"],
      ["to_tag", "1.0.0"],
      ["to_tag", "v1.0.0"],
      ["dispatch_id", "0"],
      ["dispatch_id", "07"],
      ["dispatch_id", "1.5"],
      ["dispatch_id", "99999999999999999"],
      // Sixteen digits: past the one bound the Worker, the workflow and the CLI share.
      ["dispatch_id", "1000000000000000"],
      ["repull_id", "1000000000000000"],
      ["repull_id", "0"],
      ["repull_id", "-1"],
      ["dispatch_token", TOKEN.toUpperCase()],
      ["dispatch_token", `${TOKEN}0`],
      ["dispatch_token", ""],
      ["cli_version", "0.10.24-dev11"],
      ["cli_version", "v0.10.24"],
      ["cli_version", "0.10"],
    ];
    for (const [key, value] of cases) {
      const err = refusalOf(() => parseDispatchPayload({ ...sent(), [key]: value }));
      expect([key, value, err.code]).toEqual([key, value, "dispatch-invalid"]);
      if (value.length > 2) expect(err.message).not.toContain(value);
      expect(err.message).not.toContain(TOKEN);
    }
    // A finish names its re-pull.
    const finish = { ...sent({ mode: "finish", repullId: 4 }) };
    finish.repull_id = undefined as unknown as string;
    expect(refusalOf(() => parseDispatchPayload(JSON.parse(JSON.stringify(finish)))).code).toBe(
      "dispatch-invalid",
    );
  });
});

describe("the event is the run-upstream-repull dispatch GitHub delivered", () => {
  const eventFile = (event: unknown) => {
    const path = join(tempDir(), "event.json");
    writeFileSync(path, typeof event === "string" ? event : JSON.stringify(event));
    return path;
  };

  test("the dispatch is read from the event file", () => {
    const path = eventFile({ action: "run-upstream-repull", client_payload: sent() });
    expect(readDispatchEvent({ GITHUB_EVENT_PATH: path }).dispatchId).toBe(7);
  });

  test("no event file at all is the runner's failure, not the dispatch's", () => {
    expect(refusalOf(() => readDispatchEvent({})).code).toBe("runner-failed");
    expect(
      refusalOf(() => readDispatchEvent({ GITHUB_EVENT_PATH: join(tempDir(), "absent.json") }))
        .code,
    ).toBe("runner-failed");
  });

  test("another event, an unreadable one or one too large is refused", () => {
    for (const event of [
      { action: "run-pr-review", client_payload: sent() },
      { client_payload: sent() },
      "{not json",
      [sent()],
      { action: "run-upstream-repull", client_payload: sent(), pad: "x".repeat(1024 * 1024) },
    ]) {
      const path = eventFile(event);
      expect(refusalOf(() => readDispatchEvent({ GITHUB_EVENT_PATH: path })).code).toBe(
        "dispatch-invalid",
      );
    }
  });

  test("the option must name the event's dispatch", () => {
    const path = eventFile({ action: "run-upstream-repull", client_payload: sent() });
    const sink = recordingSink();
    expect(automaticContext("7", { GITHUB_EVENT_PATH: path }, sink).dispatch.dispatchId).toBe(7);
    expect(refusalOf(() => automaticContext("8", { GITHUB_EVENT_PATH: path }, sink)).code).toBe(
      "dispatch-mismatch",
    );
    expect(refusalOf(() => automaticContext("x7", { GITHUB_EVENT_PATH: path }, sink)).code).toBe(
      "dispatch-invalid",
    );
  });

  test("the run's page is reported only for a run of the central repository on github.com", () => {
    const run = {
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "nemarDatasets/.github",
      GITHUB_RUN_ID: "123456",
    };
    expect(runUrlOf(run)).toBe("https://github.com/nemarDatasets/.github/actions/runs/123456");
    expect(runUrlOf({ ...run, GITHUB_REPOSITORY: "someone/.github" })).toBeNull();
    expect(runUrlOf({ ...run, GITHUB_SERVER_URL: "https://ghe.example.org" })).toBeNull();
    expect(runUrlOf({ ...run, GITHUB_RUN_ID: "12/../3" })).toBeNull();
    expect(runUrlOf({})).toBeNull();
  });

  test("the API the run talks to is production's or the suites' loopback, and nothing else", () => {
    for (const url of [
      "https://api.nemar.org",
      "https://api.nemar.org/",
      "http://127.0.0.1:4321",
      "http://localhost:80",
      "http://[::1]:9",
    ]) {
      expect([url, isAutomaticApi(url)]).toEqual([url, true]);
    }
    for (const url of [
      "https://api.test.nemar.org",
      "https://nemar-api-dev.workers.dev",
      "http://api.nemar.org",
      "https://api.nemar.org:8443",
      "https://api.nemar.org/nemar",
      "https://user:pass@api.nemar.org",
      "https://api.nemar.org.evil.example",
      "https://127.0.0.1",
      "http://10.0.0.5",
      "not a url",
      "",
    ]) {
      expect([url, isAutomaticApi(url)]).toEqual([url, false]);
    }
    expect(PRODUCTION_API).toBe("https://api.nemar.org");
  });

  test("the option is seen in either spelling", () => {
    expect(isAutomaticInvocation(["admin", "repull", "plan", "--automatic-dispatch", "7"])).toBe(
      true,
    );
    expect(isAutomaticInvocation(["admin", "repull", "plan", "--automatic-dispatch=7"])).toBe(true);
    expect(isAutomaticInvocation(["admin", "repull", "plan", "on099999"])).toBe(false);
  });
});

describe("what a run checks before it acts", () => {
  const d = parseDispatchPayload(sent());
  const NOW_MS = 1_790_000_000_000;
  const MINTED = String(NOW_MS / 1000 - 120);
  const ok = {
    mode: "open" as const,
    datasetId: "on099999",
    argv: ["bun", "index.ts", "admin", "repull", "plan", "on099999", "--automatic-dispatch", "7"],
    env: { GH_TOKEN: "ghs_app", [TOKEN_SINCE_ENV]: MINTED } as Record<string, string>,
    ownVersion: "0.10.24",
    devBuild: false,
    verbose: false,
    nowMs: NOW_MS,
  };

  test("a run that may act is not refused", () => {
    expect(automaticRefusal(d, ok)).toBeNull();
  });

  test("each reason refuses with its word", () => {
    const cases: Array<[Partial<typeof ok>, string]> = [
      [{ argv: [...ok.argv, "--out", `/tmp/${TOKEN}.json`] }, "auto-token-on-argv"],
      [{ ownVersion: "0.10.24-dev11" }, "auto-cli-version"],
      [{ ownVersion: "0.10.25" }, "auto-cli-version"],
      [{ devBuild: true }, "auto-cli-version"],
      [{ verbose: true }, "auto-verbose"],
      [{ mode: "finish" }, "dispatch-mismatch"],
      [{ datasetId: "on004362" }, "dispatch-mismatch"],
      [{ env: {} }, "auto-no-app-token"],
      [{ env: { GH_TOKEN: "   " } }, "auto-no-app-token"],
      // When the App token was minted is not known, or not a time this clock can trust.
      [{ env: { GH_TOKEN: "ghs_app" } }, "auto-token-clock"],
      [{ env: { GH_TOKEN: "ghs_app", [TOKEN_SINCE_ENV]: "" } }, "auto-token-clock"],
      [{ env: { GH_TOKEN: "ghs_app", [TOKEN_SINCE_ENV]: "soon" } }, "auto-token-clock"],
      [
        { env: { GH_TOKEN: "ghs_app", [TOKEN_SINCE_ENV]: String(NOW_MS / 1000 + 301) } },
        "auto-token-clock",
      ],
    ];
    for (const [over, code] of cases) {
      const r = automaticRefusal(d, { ...ok, ...over });
      expect([over, r?.code]).toEqual([over, code]);
      expect(r?.message).not.toContain(TOKEN);
    }
  });

  test("the token on the command line is found on its own, before anything that reads a file", () => {
    expect(tokenOnArgvRefusal(d, ok.argv)).toBeNull();
    expect(tokenOnArgvRefusal(d, [...ok.argv, `--out=/tmp/${TOKEN}`])?.code).toBe(
      "auto-token-on-argv",
    );
  });

  test("the token on the command line is refused first, so the report ends the dispatch", () => {
    const r = automaticRefusal(d, {
      ...ok,
      argv: [...ok.argv, TOKEN],
      ownVersion: "0.0.0-dev1",
      verbose: true,
      env: {},
    });
    expect(r?.code).toBe("auto-token-on-argv");
  });

  test("verbose and debug on the command line refuse when not told otherwise", () => {
    const { verbose: _, ...rest } = ok;
    expect(automaticRefusal(d, { ...rest, argv: [...ok.argv, "--verbose"] })?.code).toBe(
      "auto-verbose",
    );
    expect(automaticRefusal(d, { ...rest, argv: [...ok.argv, "--debug"] })?.code).toBe(
      "auto-verbose",
    );
  });
});

describe("a crash prints only the fixed lines", () => {
  const AUTOMATIC_MODULE = join(
    import.meta.dir,
    "..",
    "src",
    "lib",
    "repull",
    "execute",
    "automatic.ts",
  );
  /** What a crash's report would name, were it printed: a path, a key and a subject. */
  const SECRET_TEXT = "/home/runner/work/sub-01/sub-01_task-rest_eeg.edf SHA256E-s1--deadbeef.edf";

  async function crash(how: string, before = "", preamble = "") {
    const dir = tempDir();
    const script = join(dir, "crash.ts");
    writeFileSync(
      script,
      [
        `import { installAutomaticQuiet } from ${JSON.stringify(AUTOMATIC_MODULE)};`,
        preamble,
        "const sink = installAutomaticQuiet();",
        'sink.emit("start", { command: "plan" });',
        before,
        how,
        // Kept alive long enough for the timer or the rejection to land.
        "setTimeout(() => {}, 2000);",
      ].join("\n"),
    );
    const proc = Bun.spawn(["bun", "run", script], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode, lines: stdout.split("\n").filter(Boolean) };
  }

  test("a timer that throws ends the run failed, with nothing but the fixed lines", async () => {
    const r = await crash(
      `setTimeout(() => { throw new Error(${JSON.stringify(SECRET_TEXT)}); }, 10);`,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("");
    for (const line of r.lines) expect(line).toMatch(AUTOMATIC_LINE_RE);
    expect(r.lines.at(-1)).toBe("repull-auto: result phase=failed code=runner-failed");
    expect(r.stdout).not.toContain("sub-01");
  });

  test("an unhandled rejection ends the run failed, with nothing but the fixed lines", async () => {
    const r = await crash(`Promise.reject(new Error(${JSON.stringify(SECRET_TEXT)}));`);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("");
    for (const line of r.lines) expect(line).toMatch(AUTOMATIC_LINE_RE);
    expect(r.lines.at(-1)).toBe("repull-auto: result phase=failed code=runner-failed");
    expect(r.stdout).not.toContain("sub-01");
  });

  test("a crash after the run said it succeeded says it failed; one after a refusal keeps its word", async () => {
    const after = await crash(
      `setTimeout(() => { throw new Error(${JSON.stringify(SECRET_TEXT)}); }, 10);`,
      'sink.emit("result", { phase: "planned" });',
    );
    expect(after.lines.at(-1)).toBe("repull-auto: result phase=failed code=runner-failed");
    const refused = await crash(
      `setTimeout(() => { throw new Error(${JSON.stringify(SECRET_TEXT)}); }, 10);`,
      'sink.emit("result", { phase: "refused", code: "auto-not-clean-plan" });',
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toBe("");
    expect(refused.lines.at(-1)).toBe("repull-auto: result phase=refused code=auto-not-clean-plan");
  });

  const THROW = `setTimeout(() => { throw new Error(${JSON.stringify(SECRET_TEXT)}); }, 10);`;

  test("a crash after the Worker stored a terminal report ends with what it stored", async () => {
    // Stored, then the crash before the result line: the line says what the Worker holds.
    const opened = await crash(THROW, 'sink.time("copy", 7); sink.stored("opened");');
    expect(opened.exitCode).toBe(1);
    expect(opened.stderr).toBe("");
    for (const line of opened.lines) expect(line).toMatch(AUTOMATIC_LINE_RE);
    expect(opened.lines.slice(-3)).toEqual([
      "repull-auto: quiet suppressed=1 copy_s=7",
      "repull-auto: report-stands phase=opened",
      "repull-auto: result phase=opened",
    ]);
    const failed = await crash(THROW, 'sink.stored("failed", "head-unreadable");');
    expect(failed.lines.at(-1)).toBe("repull-auto: result phase=failed code=head-unreadable");
    // Stored and said: the crash adds nothing, and the run's word stands.
    const said = await crash(
      THROW,
      'sink.stored("opened"); sink.emit("result", { phase: "opened" });',
    );
    expect(said.exitCode).toBe(1);
    expect(said.lines.at(-1)).toBe("repull-auto: result phase=opened");
    expect(said.lines.filter((l) => l.startsWith("repull-auto: result"))).toHaveLength(1);
    // A run that exits without its result line after a stored report ends with that report too.
    const exited = await crash("process.exit(0);", 'sink.stored("finished");');
    expect(exited.lines.at(-1)).toBe("repull-auto: result phase=finished");
  });

  test("a crash whose last lines cannot be written still exits 1, and prints nothing of its own", async () => {
    const broken = await crash(
      THROW,
      "broken = true;",
      [
        "let broken = false;",
        "const real = process.stdout.write.bind(process.stdout);",
        "process.stdout.write = ((...a: unknown[]) => {",
        '  if (broken) throw new Error("the log is gone");',
        "  return (real as (...b: unknown[]) => boolean)(...a);",
        "}) as typeof process.stdout.write;",
      ].join("\n"),
    );
    expect(broken.exitCode).toBe(1);
    expect(broken.stderr).toBe("");
    expect(broken.stdout).not.toContain("sub-01");
  });
});

describe("the output grammar", () => {
  test("a line of counts and fixed words is printed as it is", () => {
    const line = automaticLine("plan", { executable: true, delta_paths: 12, status: "pr_open" });
    expect(line).toBe("repull-auto: plan executable=yes delta_paths=12 status=pr_open");
    expect(line).toMatch(AUTOMATIC_LINE_RE);
    expect(automaticLine("result", { phase: "refused", code: "auto-not-clean-plan" })).toMatch(
      RESULT_LINE_RE,
    );
  });

  test("a value that could be a path, a name or a message is never printed", () => {
    for (const value of [
      "sub-01/eeg/sub-01_task-rest_eeg.edf",
      "SHA256E-s100--abc.edf",
      "The plan is not executable.",
      "a b",
      "",
      "x".repeat(65),
    ]) {
      expect(automaticLine("plan", { path: value })).toBe("repull-auto: unprintable-line");
    }
    expect(automaticLine("Plan", {})).toBe("repull-auto: unprintable-line");
    expect(automaticLine("plan", { "Bad-Key": "x" })).toBe("repull-auto: unprintable-line");
    expect(automaticLine("plan", { n: -1 })).toBe("repull-auto: plan n=invalid");
    expect(automaticLine("plan", { n: 1.5 })).toBe("repull-auto: plan n=invalid");
  });
});

describe("the plan the automatic path takes", () => {
  const body = (counts: Record<string, unknown>, planner: number = CURRENT_PLANNER_VERSION) =>
    ({ planner, counts }) as never;
  const clean = {
    unexplained: 0,
    conflicts: 0,
    corrections: 0,
    copy_bytes: 4096,
    copy_bytes_unknown: 0,
    copy_items: 3,
    local_uploads: 1,
    local_bytes: 512,
    local_bytes_unknown: 0,
  };
  const budgetBytes = AUTO_COPY_BUDGET_SECONDS * AUTO_COPY_BYTES_PER_SECOND;
  const none = { copy_items: 0, local_uploads: 0, local_bytes: 0 };

  test("an executable clean plan of known size, inside the time budget, is taken", () => {
    expect(() => assertAutomaticPlan({ executable: true, body: body(clean) })).not.toThrow();
    // At the budget exactly, by bytes and by objects.
    for (const c of [
      { ...clean, ...none, copy_bytes: budgetBytes },
      { ...clean, ...none, copy_bytes: 0, copy_items: AUTO_COPY_BUDGET_SECONDS },
    ]) {
      expect(() => assertAutomaticPlan({ executable: true, body: body(c) })).not.toThrow();
    }
    expect(automaticCopySeconds({ bytes: budgetBytes, objects: 0 })).toBe(AUTO_COPY_BUDGET_SECONDS);
  });

  test("a copy the estimate puts past the App token's hour is refused, the uploads included", () => {
    for (const c of [
      { ...clean, ...none, copy_bytes: budgetBytes + 1 },
      { ...clean, ...none, copy_bytes: 0, copy_items: AUTO_COPY_BUDGET_SECONDS + 1 },
      { ...clean, ...none, copy_bytes: 0, local_bytes: budgetBytes + 1 },
      { ...clean, ...none, copy_bytes: 0, local_uploads: AUTO_COPY_BUDGET_SECONDS + 1 },
      // A count left out, or a size of an upload not known, is never zero.
      { ...clean, copy_items: undefined },
      { ...clean, local_bytes: undefined },
      { ...clean, local_uploads: undefined },
      { ...clean, local_bytes_unknown: 1 },
      { ...clean, local_bytes_unknown: undefined },
    ]) {
      expect([
        c,
        refusalOf(() => assertAutomaticPlan({ executable: true, body: body(c) })).code,
      ]).toEqual([c, "auto-copy-too-long"]);
    }
    // The budget is twenty minutes of the token's hour, and the size bound is still checked first.
    expect(AUTO_COPY_BUDGET_SECONDS).toBe(20 * 60);
    expect(
      refusalOf(() =>
        assertAutomaticPlan({
          executable: true,
          body: body({ ...clean, copy_bytes: AUTO_MAX_COPY_BYTES + 1 }),
        }),
      ).code,
    ).toBe("auto-copy-too-large");
  });

  test("the budget can be shortened for a suite, never lengthened", () => {
    expect(copyBudgetSeconds({})).toBe(AUTO_COPY_BUDGET_SECONDS);
    expect(copyBudgetSeconds({ NEMAR_REPULL_COPY_BUDGET_SECONDS: "1" })).toBe(1);
    expect(copyBudgetSeconds({ NEMAR_REPULL_COPY_BUDGET_SECONDS: "999999" })).toBe(
      AUTO_COPY_BUDGET_SECONDS,
    );
    expect(copyBudgetSeconds({ NEMAR_REPULL_COPY_BUDGET_SECONDS: "-5" })).toBe(
      AUTO_COPY_BUDGET_SECONDS,
    );
    expect(copyBudgetSeconds({ NEMAR_REPULL_COPY_BUDGET_SECONDS: "1e9" })).toBe(
      AUTO_COPY_BUDGET_SECONDS,
    );
  });

  test("each way a plan is not one the path takes refuses with its word", () => {
    const cases: Array<[{ executable: boolean; body: never }, string]> = [
      [{ executable: false, body: body(clean) }, "not-executable"],
      [
        { executable: true, body: body(clean, CURRENT_PLANNER_VERSION - 1) },
        "auto-planner-version",
      ],
      [{ executable: true, body: body({ ...clean, corrections: 1 }) }, "auto-not-clean-plan"],
      [{ executable: true, body: body({ ...clean, conflicts: 1 }) }, "auto-not-clean-plan"],
      [{ executable: true, body: body({ ...clean, unexplained: 1 }) }, "auto-not-clean-plan"],
      // A count left out is unknown, never zero.
      [
        { executable: true, body: body({ ...clean, corrections: undefined }) },
        "auto-not-clean-plan",
      ],
      [
        { executable: true, body: body({ ...clean, copy_bytes_unknown: 1 }) },
        "auto-copy-too-large",
      ],
      [
        { executable: true, body: body({ ...clean, copy_bytes_unknown: undefined }) },
        "auto-copy-too-large",
      ],
      [
        { executable: true, body: body({ ...clean, copy_bytes: undefined }) },
        "auto-copy-too-large",
      ],
      [
        { executable: true, body: body({ ...clean, copy_bytes: AUTO_MAX_COPY_BYTES + 1 }) },
        "auto-copy-too-large",
      ],
    ];
    for (const [plan, code] of cases) {
      expect(refusalOf(() => assertAutomaticPlan(plan)).code).toBe(code);
    }
    // The counts alone, for a record taken up past `prepared`.
    expect(refusalOf(() => assertAutomaticCounts(body({ ...clean, corrections: 2 }))).code).toBe(
      "auto-not-clean-plan",
    );
  });
});

describe("the App token's hour", () => {
  const S = 1_790_000_000;
  const at = (secondsAfterMint: number) => (S + secondsAfterMint) * 1000;
  /** What must be left before a step that has `work` seconds of its own to do. */
  const need = (work: number) => work + AUTO_AFTER_COPY_SECONDS + AUTO_SETTLE_RESERVE_SECONDS;

  test("the copy's budget is what the usable hour leaves once the settle and the other steps are kept", () => {
    expect(AUTO_COPY_BUDGET_SECONDS + AUTO_SETTLE_RESERVE_SECONDS + AUTO_OTHER_STEPS_SECONDS).toBe(
      APP_TOKEN_USABLE_SECONDS,
    );
    expect(APP_TOKEN_USABLE_SECONDS).toBeLessThan(60 * 60);
    // The settle's share holds its quiet window and a minute of reads.
    expect(AUTO_SETTLE_RESERVE_SECONDS).toBeGreaterThanOrEqual(SETTLE_QUIET_MS / 1000 + 60);
    expect(AUTO_AFTER_COPY_SECONDS).toBeLessThanOrEqual(AUTO_OTHER_STEPS_SECONDS);
  });

  test("a plan that would fit the hour only if the settle had no share is refused", () => {
    const counts = {
      unexplained: 0,
      conflicts: 0,
      corrections: 0,
      copy_bytes_unknown: 0,
      copy_items: 0,
      local_uploads: 0,
      local_bytes: 0,
      local_bytes_unknown: 0,
    };
    const plan = (seconds: number) =>
      ({
        executable: true,
        body: {
          planner: CURRENT_PLANNER_VERSION,
          counts: { ...counts, copy_bytes: seconds * AUTO_COPY_BYTES_PER_SECOND },
        },
      }) as never;
    // The copy, the other steps and the settle together fit the usable hour exactly.
    expect(() => assertAutomaticPlan(plan(AUTO_COPY_BUDGET_SECONDS))).not.toThrow();
    // Inside the hour were the settle not kept back, and refused because it is.
    for (const s of [
      AUTO_COPY_BUDGET_SECONDS + 1,
      AUTO_COPY_BUDGET_SECONDS + AUTO_SETTLE_RESERVE_SECONDS,
    ]) {
      expect([s, refusalOf(() => assertAutomaticPlan(plan(s))).code]).toEqual([
        s,
        "auto-copy-too-long",
      ]);
    }
  });

  test("when the token was minted is read as whole epoch seconds, never from the future", () => {
    const now = at(0);
    expect(tokenSinceOf({ [TOKEN_SINCE_ENV]: String(S) }, now)).toBe(S);
    expect(tokenSinceOf({ [TOKEN_SINCE_ENV]: ` ${S}\n` }, now)).toBe(S);
    // Up to five minutes of a clock running ahead of this one, and no more.
    expect(tokenSinceOf({ [TOKEN_SINCE_ENV]: String(S + 300) }, now)).toBe(S + 300);
    for (const raw of [
      undefined,
      "",
      "0",
      "017",
      "1.5",
      "-5",
      "1e9",
      "1234567890123",
      `${S + 301}`,
    ]) {
      expect([raw, tokenSinceOf({ [TOKEN_SINCE_ENV]: raw }, now)]).toEqual([raw, null]);
    }
  });

  test("a step is refused once its work and what follows it would pass the usable hour", () => {
    expect(tokenHourLeftMs(S, at(0))).toBe(APP_TOKEN_USABLE_SECONDS * 1000);
    expect(tokenHourLeftMs(S, at(APP_TOKEN_USABLE_SECONDS + 1))).toBe(-1000);
    for (const work of [0, 90, 600]) {
      const last = APP_TOKEN_USABLE_SECONDS - need(work);
      expect([work, tokenHourRefusal(S, at(last), work)]).toEqual([work, null]);
      const late = tokenHourRefusal(S, at(last) + 1, work);
      expect([work, late?.code]).toEqual([work, "auto-token-hour"]);
      expect(late?.resumable).not.toBe(true);
    }
    // Fifty-six minutes in, nothing is started, whatever its size.
    expect(tokenHourRefusal(S, at(56 * 60), 0)?.code).toBe("auto-token-hour");
  });

  test("the copy's own estimate is the plan's copy, by its bytes and its objects", () => {
    const body = {
      counts: { copy_bytes: 90 * AUTO_COPY_BYTES_PER_SECOND, copy_items: 4 },
    } as never;
    expect(planCopySeconds(body)).toBe(
      automaticCopySeconds({ bytes: 90 * AUTO_COPY_BYTES_PER_SECOND, objects: 4 }),
    );
    expect(planCopySeconds(body)).toBeGreaterThanOrEqual(90);
  });

  test("a dispatched run checks the hour before each step, the copy with its estimate, and times each", () => {
    const copySeconds = 600;
    const body = {
      counts: { copy_bytes: copySeconds * AUTO_COPY_BYTES_PER_SECOND, copy_items: 0 },
    } as never;
    const estimate = planCopySeconds(body);
    let t = at(APP_TOKEN_USABLE_SECONDS - need(0));
    const timed: Array<[string, number]> = [];
    const hooks = automaticHooks(
      {
        dispatchId: 7,
        token: TOKEN,
        repullId: null,
        settle: { maxWaitMs: 0, quietMs: 0, pollMs: 0 },
        tokenSince: S,
        now: () => t,
        measured: (step, seconds) => timed.push([step, seconds]),
      },
      body,
    );
    // A push with nothing of its own to do still fits; the copy, with its estimate, does not.
    expect(() => hooks.beforeStep?.("register")).not.toThrow();
    expect(() => hooks.beforeStep?.("pr")).not.toThrow();
    expect(refusalOf(() => hooks.beforeStep?.("copy")).code).toBe("auto-token-hour");
    t = at(APP_TOKEN_USABLE_SECONDS - need(estimate));
    expect(() => hooks.beforeStep?.("copy")).not.toThrow();
    t += 1;
    expect(refusalOf(() => hooks.beforeStep?.("copy")).code).toBe("auto-token-hour");
    hooks.timed?.("copy", 61_400);
    expect(timed).toEqual([["copy", 61]]);
    // An administrator's run has no hooks.
    expect(automaticHooks(undefined, body)).toEqual({});
  });
});

describe("a run whose App token GitHub no longer takes", () => {
  function github(answer: number | "network") {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      if (answer === "network") throw new TypeError("fetch failed");
      return Response.json({ message: "x" }, { status: answer });
    }) as typeof fetch;
    return { seen, fetchImpl };
  }

  test("a 401 for the dataset's repository is an expired token", async () => {
    const g = github(401);
    expect(await appTokenRefused("on099999", { GH_TOKEN: "ghs_old" }, g.fetchImpl)).toBe(true);
    expect(g.seen).toEqual([
      { url: "https://api.github.com/repos/nemarDatasets/on099999", auth: "Bearer ghs_old" },
    ]);
  });

  test("any other answer, none, or no token is not taken as expiry", async () => {
    for (const answer of [200, 403, 404, 500, "network"] as const) {
      const g = github(answer);
      expect([answer, await appTokenRefused("on099999", { GH_TOKEN: "t" }, g.fetchImpl)]).toEqual([
        answer,
        false,
      ]);
    }
    const none = github(401);
    expect(await appTokenRefused("on099999", {}, none.fetchImpl)).toBe(false);
    expect(none.seen).toEqual([]);
  });
});

describe("a redirect is refused, never followed", () => {
  /** A loopback server that records what reaches it, and one that sends everything there. */
  function servers(answer: number) {
    const reached: string[] = [];
    const target = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        reached.push(new URL(req.url).pathname);
        return Response.json({}, { status: answer });
      },
    });
    const redirector = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const to = `http://127.0.0.1:${target.port}${new URL(req.url).pathname}`;
        return new Response(null, { status: 307, headers: { Location: to } });
      },
    });
    return {
      reached,
      base: `http://127.0.0.1:${redirector.port}`,
      stop() {
        target.stop(true);
        redirector.stop(true);
      },
    };
  }

  test("the token probe does not follow GitHub's answer elsewhere, nor take it as expiry", async () => {
    const s = servers(401);
    try {
      const env = { GH_TOKEN: "ghs_app", NEMAR_GITHUB_API_URL: s.base };
      expect(await appTokenRefused("on099999", env)).toBe(false);
      expect(s.reached).toEqual([]);
    } finally {
      s.stop();
    }
  });

  test("a report does not follow the API elsewhere, and is not stored", async () => {
    const s = servers(200);
    const saved = process.env.TEST_API_URL;
    process.env.TEST_API_URL = s.base;
    try {
      const ctx = {
        dispatch: parseDispatchPayload(sent()),
        runUrl: null,
        marker: null,
        sink: recordingSink(),
      };
      expect(
        await reportDispatch(ctx, "failed", { code: "runner-failed" }, { attempts: 1 }),
      ).toEqual({ stored: false, code: "report-unanswered" });
      expect(s.reached).toEqual([]);
      expect(ctx.sink.reported).toEqual([]);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "TEST_API_URL");
      else process.env.TEST_API_URL = saved;
      s.stop();
    }
  });
});

describe("the words a run reports", () => {
  test("a listed word is reported as it is, any other as no-code", () => {
    expect(dispatchCodeOf("auto-not-clean-plan")).toBe("auto-not-clean-plan");
    // The planner builds this word at run time (`marker-<status>`), and the list does not hold it.
    expect(dispatchCodeOf("marker-absent")).toBe("no-code");
    expect(dispatchCodeOf(undefined)).toBe("no-code");
    for (const w of [
      "dispatch-invalid",
      "auto-cli-version",
      "auto-token-on-argv",
      "auto-verbose",
      "auto-option",
      "finish-incomplete",
      "report-unanswered",
      "runner-credentials",
      "runner-disk",
      "runner-failed",
      "head-foreign",
      "finish-not-merged",
      "auto-no-app-token",
      "auto-token-hour",
      "auto-token-clock",
    ]) {
      expect((DISPATCH_CODES as readonly string[]).includes(w)).toBe(true);
    }
  });

  test("token-expired is final for the tag; the token hour's own words are not", () => {
    const final = DISPATCH_FINAL_CODES as readonly string[];
    expect(final.includes("token-expired")).toBe(true);
    for (const w of ["auto-token-hour", "auto-token-clock", "head-unreadable"]) {
      expect([w, final.includes(w)]).toEqual([w, false]);
    }
  });

  test("a dispatch claimed at the daily tick's hour, or late in the day, opens the same day", () => {
    expect(opensTheSameUtcDay(3)).toBe(true);
    expect(opensTheSameUtcDay(15)).toBe(true);
    // 17:59 plus an hour of queueing plus 330 minutes ends at 00:29 the next day.
    expect(opensTheSameUtcDay(17)).toBe(false);
    expect(opensTheSameUtcDay(-1)).toBe(false);
    expect(opensTheSameUtcDay(24)).toBe(false);
  });
});

function recordingSink(): AutomaticSink & {
  lines: string[];
  reported: Array<[string, string | undefined]>;
} {
  const lines: string[] = [];
  const reported: Array<[string, string | undefined]> = [];
  const times: Record<string, number> = {};
  let dropped = 0;
  return {
    lines,
    reported,
    emit: (event, f) => lines.push(automaticLine(event, f)),
    drop: () => {
      dropped++;
    },
    dropped: () => dropped,
    stored: (phase, code) => reported.push([phase, code]),
    time: (key, seconds) => {
      times[`${key}_s`] = seconds;
    },
    quietFields: () => ({ suppressed: dropped, ...times }),
  };
}

describe("a report", () => {
  interface Seen {
    url: string;
    token: string | null;
    body: unknown;
  }

  function stand(answers: Array<{ status: number; code?: string } | "network">) {
    const seen: Seen[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(url),
        token: headers.get("X-Repull-Token"),
        body: JSON.parse(String(init?.body)),
      });
      const next = answers.shift() ?? { status: 200, code: "stored" };
      if (next === "network") throw new TypeError("fetch failed");
      return Response.json(
        next.code ? { error: "The Worker's own sentence.", code: next.code } : {},
        { status: next.status },
      );
    }) as typeof fetch;
    return { seen, fetchImpl };
  }

  function ctxOf(
    marker: string | null,
  ): AutomaticContext & { sink: ReturnType<typeof recordingSink> } {
    return {
      dispatch: parseDispatchPayload(sent()),
      runUrl: "https://github.com/nemarDatasets/.github/actions/runs/99",
      marker,
      sink: recordingSink(),
    };
  }

  test("a stored terminal report carries the callback's body, the token in its header only, and leaves the marker", async () => {
    const marker = join(tempDir(), "repull-reported");
    const ctx = ctxOf(marker);
    const { seen, fetchImpl } = stand([{ status: 200, code: "stored" }]);
    expect(
      await reportDispatch(ctx, "refused", { code: "auto-not-clean-plan" }, { fetchImpl }),
    ).toEqual({ stored: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toEndWith("/webhooks/repull-state");
    expect(seen[0]?.token).toBe(TOKEN);
    expect(JSON.stringify(seen[0]?.body)).not.toContain(TOKEN);
    expect(repullStateSchema.safeParse(seen[0]?.body).success).toBe(true);
    expect(seen[0]?.body).toEqual({
      dispatch_id: 7,
      dataset_id: "on099999",
      phase: "refused",
      code: "auto-not-clean-plan",
      workflow_run_url: "https://github.com/nemarDatasets/.github/actions/runs/99",
    });
    expect(readFileSync(marker, "utf8")).toBe("refused\n");
    expect(ctx.sink.lines).toEqual(["repull-auto: report phase=refused answer=stored"]);
    // The sink holds what the Worker stored, for a crash's last line.
    expect(ctx.sink.reported).toEqual([["refused", "auto-not-clean-plan"]]);
  });

  test("each phase's body is one the Worker's callback takes", async () => {
    for (const [phase, extra] of [
      ["started", {}],
      ["opened", { repullId: 5 }],
      ["finished", {}],
      ["failed", { code: "head-foreign" }],
      ["failed", { code: "a-word-nobody-listed" }],
    ] as const) {
      const { seen, fetchImpl } = stand([{ status: 200, code: "stored" }]);
      await reportDispatch(ctxOf(null), phase, extra, { fetchImpl });
      expect([phase, repullStateSchema.safeParse(seen[0]?.body).success]).toEqual([phase, true]);
    }
  });

  test("a started report, or one the Worker refused, leaves no marker", async () => {
    const marker = join(tempDir(), "repull-reported");
    const started = ctxOf(marker);
    await reportDispatch(started, "started", {}, { fetchImpl: stand([]).fetchImpl });
    expect(existsSync(marker)).toBe(false);
    expect(started.sink.reported).toEqual([]);
    const { fetchImpl } = stand([{ status: 401, code: "invalid-token" }]);
    const opened = ctxOf(marker);
    expect(await reportDispatch(opened, "opened", { repullId: 1 }, { fetchImpl })).toEqual({
      stored: false,
      code: "invalid-token",
    });
    expect(existsSync(marker)).toBe(false);
    expect(opened.sink.reported).toEqual([]);
  });

  test("a refusal is not tried again; a lost answer and a 5xx are, and then say so", async () => {
    const refused = stand([{ status: 409, code: "already-started" }]);
    expect(
      await reportDispatch(
        ctxOf(null),
        "started",
        {},
        { fetchImpl: refused.fetchImpl, backoffMs: 1 },
      ),
    ).toEqual({ stored: false, code: "already-started" });
    expect(refused.seen).toHaveLength(1);

    const lost = stand(["network", { status: 502 }, { status: 200, code: "stored" }]);
    expect(
      await reportDispatch(
        ctxOf(null),
        "finished",
        {},
        { fetchImpl: lost.fetchImpl, backoffMs: 1 },
      ),
    ).toEqual({ stored: true });
    expect(lost.seen).toHaveLength(3);

    const gone = stand(["network", "network", "network"]);
    expect(
      await reportDispatch(
        ctxOf(null),
        "finished",
        {},
        { fetchImpl: gone.fetchImpl, backoffMs: 1 },
      ),
    ).toEqual({ stored: false, code: "report-unanswered" });
    expect(gone.seen).toHaveLength(3);
  });

  test("an answer whose word is off the list is never passed on, and the sentence never read", async () => {
    const ctx = ctxOf(null);
    const { fetchImpl } = stand([{ status: 400, code: "Some Sentence" }]);
    expect(await reportDispatch(ctx, "failed", { code: "runner-failed" }, { fetchImpl })).toEqual({
      stored: false,
      code: "report-unanswered",
    });
    for (const line of ctx.sink.lines) {
      expect(line).toMatch(AUTOMATIC_LINE_RE);
      expect(line).not.toContain("Sentence");
    }
  });
});
