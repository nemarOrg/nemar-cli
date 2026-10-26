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
 *    a code from the closed list, and the marker only for a terminal report the Worker stored.
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
  AUTO_MAX_COPY_BYTES,
  CURRENT_PLANNER_VERSION,
  DISPATCH_CODES,
  opensTheSameUtcDay,
} from "../shared/repull-state";
import {
  AUTOMATIC_LINE_RE,
  type AutomaticContext,
  type AutomaticSink,
  DISPATCH_EVENT,
  DISPATCH_PAYLOAD_KEYS,
  RESULT_LINE_RE,
  assertAutomaticCounts,
  assertAutomaticPlan,
  automaticContext,
  automaticLine,
  automaticRefusal,
  dispatchCodeOf,
  isAutomaticInvocation,
  parseDispatchPayload,
  readDispatchEvent,
  reportDispatch,
  runUrlOf,
} from "../src/lib/repull/execute/automatic";
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
      { dispatchId: Number.MAX_SAFE_INTEGER },
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

  test("no event, another event, an unreadable one or one too large is refused", () => {
    expect(refusalOf(() => readDispatchEvent({})).code).toBe("dispatch-invalid");
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
    expect(
      refusalOf(() => readDispatchEvent({ GITHUB_EVENT_PATH: join(tempDir(), "absent.json") }))
        .code,
    ).toBe("dispatch-invalid");
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
  const ok = {
    mode: "open" as const,
    datasetId: "on099999",
    argv: ["bun", "index.ts", "admin", "repull", "plan", "on099999", "--automatic-dispatch", "7"],
    env: { GH_TOKEN: "ghs_app" },
    ownVersion: "0.10.24",
    devBuild: false,
    verbose: false,
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
    ];
    for (const [over, code] of cases) {
      const r = automaticRefusal(d, { ...ok, ...over });
      expect([over, r?.code]).toEqual([over, code]);
      expect(r?.message).not.toContain(TOKEN);
    }
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
  };

  test("an executable clean plan of known size is taken", () => {
    expect(() => assertAutomaticPlan({ executable: true, body: body(clean) })).not.toThrow();
    expect(() =>
      assertAutomaticPlan({
        executable: true,
        body: body({ ...clean, copy_bytes: AUTO_MAX_COPY_BYTES }),
      }),
    ).not.toThrow();
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
    ]) {
      expect((DISPATCH_CODES as readonly string[]).includes(w)).toBe(true);
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

function recordingSink(): AutomaticSink & { lines: string[] } {
  const lines: string[] = [];
  let dropped = 0;
  return {
    lines,
    emit: (event, f) => lines.push(automaticLine(event, f)),
    drop: () => {
      dropped++;
    },
    dropped: () => dropped,
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

  function ctxOf(marker: string | null): AutomaticContext & { sink: { lines: string[] } } {
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
    await reportDispatch(ctxOf(marker), "started", {}, { fetchImpl: stand([]).fetchImpl });
    expect(existsSync(marker)).toBe(false);
    const { fetchImpl } = stand([{ status: 401, code: "invalid-token" }]);
    expect(await reportDispatch(ctxOf(marker), "opened", { repullId: 1 }, { fetchImpl })).toEqual({
      stored: false,
      code: "invalid-token",
    });
    expect(existsSync(marker)).toBe(false);
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
