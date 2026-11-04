/**
 * The re-pull dispatch the Worker sends (epic #1046 phase 7, #1913; ADR 0111): the payload
 * builder and the call to GitHub's `repository_dispatch` on the central workflow repository.
 *
 * GitHub is a loopback stand-in (the `NEMAR_GITHUB_API_URL` override the other GitHub-facing
 * suites use) that records every request and answers the status it is told to, or never answers;
 * a lost connection is a real one (a server that was stopped). Nothing reaches GitHub.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - every field is checked and a malformed one throws before anything is sent, with a message
 *    that never carries a value (one of them is the token);
 *  - the CLI version must be a release, so a development build never dispatches;
 *  - the payload is strings only, at most nine keys, and `repull_id` only when one is continued;
 *  - a 2xx is `sent`, a 4xx is `refused` with its status, and a 5xx, a lost connection or the
 *    timeout is `unknown`, because GitHub may have queued the event and lost only the answer;
 *  - a send with no answer is logged by its error's class only, never its text.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  UPSTREAM_REPULL_EVENT,
  type UpstreamRepullDispatchFields,
  buildUpstreamRepullPayload,
  errorClassName,
  triggerUpstreamRepullRun,
} from "../src/services/github/dispatch";

const TOKEN = "ab".repeat(32);

const fields = (
  over: Partial<UpstreamRepullDispatchFields> = {},
): UpstreamRepullDispatchFields => ({
  mode: "open",
  datasetId: "on099991",
  upstreamDs: "ds099991",
  fromTag: "1.0.0",
  toTag: "1.0.1",
  dispatchId: 7,
  repullId: null,
  token: TOKEN,
  cliVersion: "0.10.24",
  ...over,
});

interface Seen {
  path: string;
  authorization: string | null;
  body: unknown;
}

let server: Server;
let answer: number | "hang" = 204;
const seen: Seen[] = [];
let previousBase: string | undefined;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push({
        path: new URL(req.url).pathname,
        authorization: req.headers.get("authorization"),
        body: await req.json(),
      });
      if (answer === "hang") return new Promise<Response>(() => {});
      return new Response(answer === 204 ? null : "GitHub's own words", { status: answer });
    },
  });
  const g = globalThis as { NEMAR_GITHUB_API_URL?: string };
  previousBase = g.NEMAR_GITHUB_API_URL;
  g.NEMAR_GITHUB_API_URL = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = previousBase;
  server.stop(true);
});

beforeEach(() => {
  answer = 204;
  seen.length = 0;
});

describe("buildUpstreamRepullPayload", () => {
  test("a first dispatch: the event, strings only, and no repull_id", () => {
    const p = buildUpstreamRepullPayload(fields());
    expect(p.event_type).toBe(UPSTREAM_REPULL_EVENT);
    expect(p.event_type).toBe("run-upstream-repull");
    expect(p.client_payload).toEqual({
      mode: "open",
      dataset_id: "on099991",
      upstream_ds: "ds099991",
      from_tag: "1.0.0",
      to_tag: "1.0.1",
      dispatch_id: "7",
      dispatch_token: TOKEN,
      cli_version: "0.10.24",
    });
  });

  test("a resume and a finish name their re-pull, within GitHub's ten top-level keys", () => {
    for (const mode of ["open", "finish"] as const) {
      const p = buildUpstreamRepullPayload(fields({ mode, repullId: 42 }));
      expect(p.client_payload.repull_id).toBe("42");
      expect(p.client_payload.mode).toBe(mode);
      expect(Object.keys(p.client_payload).length).toBeLessThanOrEqual(9);
      for (const v of Object.values(p.client_payload)) expect(typeof v).toBe("string");
    }
  });

  test("every malformed field throws, and no message carries a value", () => {
    const cases: Array<Partial<UpstreamRepullDispatchFields>> = [
      { mode: "close" as "open" },
      { datasetId: "xx090001" },
      { datasetId: "on09999" },
      { upstreamDs: "ds09999x" },
      { fromTag: "1.0.0; rm -rf /" },
      { toTag: "../main" },
      { toTag: "1.0.0" },
      { toTag: "v1.0.0" },
      { dispatchId: 0 },
      { dispatchId: 1.5 },
      // Past the one bound the Worker, the workflow and the CLI share (`DISPATCH_ID_MAX`).
      { dispatchId: 1_000_000_000_000_000 },
      { repullId: 1_000_000_000_000_000 },
      { repullId: 0 },
      { mode: "finish", repullId: null },
      { token: "AB".repeat(32) },
      { token: `${TOKEN}0` },
      { token: "" },
      { cliVersion: "0.10.24-dev11" },
      { cliVersion: "v0.10.24" },
      { cliVersion: "0.10" },
      { cliVersion: "" },
    ];
    for (const over of cases) {
      let message = "";
      try {
        buildUpstreamRepullPayload(fields(over));
      } catch (err) {
        message = (err as Error).message;
      }
      expect([over, message]).toEqual([over, expect.stringMatching(/is malformed$/)]);
      // `mode` is one of two fixed words, which a message may name; every other value it may not.
      for (const [k, v] of Object.entries(over)) {
        if (k !== "mode" && typeof v === "string" && v.length > 2) {
          expect(message).not.toContain(v);
        }
      }
      expect(message).not.toContain(TOKEN);
    }
  });

  test("a development build of the Worker never dispatches", () => {
    // The run installs nemar-cli@<the Worker's version>; a dev version is not on npm as a release.
    expect(() => buildUpstreamRepullPayload(fields({ cliVersion: "0.10.24-dev11" }))).toThrow(
      /CLI version is malformed/,
    );
    expect(
      buildUpstreamRepullPayload(fields({ cliVersion: "1.2.3" })).client_payload.cli_version,
    ).toBe("1.2.3");
  });
});

describe("triggerUpstreamRepullRun", () => {
  const payload = () => buildUpstreamRepullPayload(fields());

  test("a 2xx is sent: one POST to the central repository's dispatches, with the payload", async () => {
    expect(await triggerUpstreamRepullRun(payload(), "pat-1")).toBe("sent");
    expect(seen).toEqual([
      {
        path: "/repos/nemarDatasets/.github/dispatches",
        authorization: "Bearer pat-1",
        body: payload(),
      },
    ]);
  });

  test("a 4xx is refused with its status: GitHub created no event", async () => {
    for (const status of [401, 403, 404, 422]) {
      answer = status;
      expect(await triggerUpstreamRepullRun(payload(), "pat")).toEqual({ refused: status });
    }
  });

  test("a 5xx is unknown, never refused: GitHub's edge may answer after it queued the event", async () => {
    for (const status of [500, 502, 503, 504]) {
      answer = status;
      expect(await triggerUpstreamRepullRun(payload(), "pat")).toBe("unknown");
    }
  });

  test("a hung answer is unknown after the timeout", async () => {
    answer = "hang";
    const started = Date.now();
    expect(await triggerUpstreamRepullRun(payload(), "pat", { timeoutMs: 150 })).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen).toHaveLength(1);
  });

  test("a lost connection is unknown, and nothing throws", async () => {
    const gone = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) });
    const base = `http://127.0.0.1:${gone.port}`;
    gone.stop(true);
    const g = globalThis as { NEMAR_GITHUB_API_URL?: string };
    const kept = g.NEMAR_GITHUB_API_URL;
    g.NEMAR_GITHUB_API_URL = base;
    try {
      expect(await triggerUpstreamRepullRun(payload(), "pat", { timeoutMs: 2_000 })).toBe(
        "unknown",
      );
    } finally {
      g.NEMAR_GITHUB_API_URL = kept;
    }
  });

  test("a send with no answer is logged by its error's class only, never its text or the token", async () => {
    const lines: string[] = [];
    const real = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    const message = `refused at ${TOKEN} for on099991`;
    try {
      // A failure on this side with a message that carries the token: only the class may show.
      const failing = (async () => {
        throw new TypeError(message);
      }) as unknown as typeof fetch;
      expect(await triggerUpstreamRepullRun(payload(), "pat", { fetchImpl: failing })).toBe(
        "unknown",
      );
      answer = "hang";
      expect(await triggerUpstreamRepullRun(payload(), "pat", { timeoutMs: 150 })).toBe("unknown");
    } finally {
      console.error = real;
    }
    expect(lines).toEqual([
      "[repull-dispatch] the dispatch got no answer: TypeError",
      "[repull-dispatch] the dispatch got no answer: TimeoutError",
    ]);
    for (const line of lines) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain("refused at");
    }
  });
});

describe("errorClassName", () => {
  test("a plain identifier is kept; anything else, or no error, reads Error", () => {
    expect(errorClassName(new RangeError("x"))).toBe("RangeError");
    const odd = new Error("x");
    odd.name = "not a name: with text";
    expect(errorClassName(odd)).toBe("Error");
    expect(errorClassName("a string")).toBe("Error");
    expect(errorClassName(null)).toBe("Error");
  });
});
