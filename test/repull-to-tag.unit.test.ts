/**
 * The re-pull plan's `to-tag` check orders tags by OpenNeuro's creation order through the one
 * helper the staleness report uses (`upstreamSnapshotOrder`, ADR 0111's Phase 4a amendment), and
 * an order the answer cannot establish leaves the check `unchecked`, which makes the plan not
 * executable. The numbers are never compared.
 *
 * `toTagCheck` and the helper are pure, so the answers below are OpenNeuro's as the shared parser
 * returns them. `fetchOpenNeuroSnapshots` is driven against a loopback stand-in for its retry and
 * failure paths only; the planner's own runs against the fixture are in `repull-plan.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type UpstreamRead,
  type UpstreamSnapshot,
  upstreamSnapshotOrder,
} from "../shared/upstream-staleness";
import { fetchOpenNeuroSnapshots } from "../src/lib/openneuro";
import { toTagCheck } from "../src/lib/repull/preflight";

const snap = (tag: string, created: string | null): UpstreamSnapshot => ({ tag, created });
const read = (latest: UpstreamSnapshot | null, snapshots: UpstreamSnapshot[]): UpstreamRead => ({
  kind: "snapshot",
  latest,
  snapshots,
});
const MIRROR = ["00006", "1.0.0", "1.0.1", "1.1.0", "2.0.0"];

function check(upstream: UpstreamRead, fromTag: string | null, flag?: string) {
  return toTagCheck({ flag, mirrorTags: MIRROR, fromTag, upstream }).check;
}

describe("upstreamSnapshotOrder", () => {
  const list = [snap("00006", "2018-03-01T00:00:00Z"), snap("1.0.0", "2020-05-01T00:00:00Z")];

  test("newer by creation time even where the number is smaller", () => {
    expect(upstreamSnapshotOrder(list[1] as UpstreamSnapshot, list, "00006")).toEqual({
      kind: "newer",
      latestCreated: "2020-05-01T00:00:00Z",
    });
  });

  test("each reason the order is not established", () => {
    const latest = list[1] as UpstreamSnapshot;
    expect(upstreamSnapshotOrder(latest, list, "1.0.0").kind).toBe("same");
    expect(
      upstreamSnapshotOrder(snap("1.0.0", null), [list[0] as UpstreamSnapshot], "00006"),
    ).toEqual({ kind: "latest_undated" });
    // The latest's own date is unreadable, but its entry in the list reads.
    expect(upstreamSnapshotOrder(snap("1.0.0", "not a date"), list, "00006").kind).toBe("newer");
    expect(upstreamSnapshotOrder(list[0] as UpstreamSnapshot, list, "1.0.0")).toEqual({
      kind: "latest_inconsistent",
      later: "1.0.0",
    });
    expect(upstreamSnapshotOrder(latest, list, "0.9.0").kind).toBe("recorded_absent");
    expect(upstreamSnapshotOrder(latest, [snap("00006", null), latest], "00006").kind).toBe(
      "recorded_undated",
    );
    expect(
      upstreamSnapshotOrder(latest, [snap("00006", "2020-05-01T00:00:00Z"), latest], "00006").kind,
    ).toBe("not_after");
  });
});

describe("the to-tag check orders by OpenNeuro's creation order", () => {
  test("OpenNeuro's latest created after from_tag is ok, though its number is smaller", () => {
    const latest = snap("1.0.0", "2020-05-01T00:00:00Z");
    expect(check(read(latest, [snap("00006", "2018-03-01T00:00:00Z"), latest]), "00006")).toEqual({
      name: "to-tag",
      status: "ok",
      detail: "1.0.0 (OpenNeuro's latest)",
    });
  });

  test("a larger number OpenNeuro did not create later is never ok", () => {
    // 2.0.0 is numerically after 1.0.1, and OpenNeuro made both at the same moment.
    const latest = snap("2.0.0", "2026-01-01T00:00:00Z");
    const c = check(read(latest, [snap("1.0.1", "2026-01-01T00:00:00Z"), latest]), "1.0.1");
    expect(c).toMatchObject({ status: "unchecked", code: "order-unverified" });
    expect(c.detail).toContain("was not created after the mirrored 1.0.1");
  });

  test("every order the answer cannot establish is unchecked, never ok and never refused", () => {
    const latest = snap("1.1.0", "2026-06-01T00:00:00Z");
    const cases: Array<[UpstreamRead, string]> = [
      [read(snap("1.1.0", null), [snap("1.0.0", "2026-01-01T00:00:00Z")]), "is unreadable"],
      [
        read(latest, [latest, snap("1.0.0", "2026-01-01T00:00:00Z"), snap("1.0.1", "2027-01-01")]),
        "1.0.1 in its own list was created later",
      ],
      [read(latest, [latest]), "is not among OpenNeuro's snapshots"],
      [read(latest, [snap("1.0.0", null), latest]), "the mirrored 1.0.0 is unreadable"],
    ];
    for (const [answer, words] of cases) {
      const c = check(answer, "1.0.0");
      expect(c, words).toMatchObject({ status: "unchecked", code: "order-unverified" });
      expect(c.detail, words).toContain(words);
    }
  });

  test("a tag that is not OpenNeuro's latest, and any tag while OpenNeuro cannot say, are unchecked", () => {
    const latest = snap("1.1.0", "2026-06-01T00:00:00Z");
    expect(
      check(read(latest, [snap("1.0.0", "2026-01-01"), latest]), "1.0.0", "1.0.1"),
    ).toMatchObject({ status: "unchecked", code: "order-unverified" });
    expect(check({ kind: "error", reason: "HTTP 503" }, "1.0.0", "1.1.0")).toMatchObject({
      status: "unchecked",
      code: "order-unverified",
    });
    // With nothing to order against, it is not ok either.
    expect(check(read(latest, [latest]), null)).toMatchObject({
      status: "unchecked",
      code: "order-unverified",
    });
  });

  test("with no --to-tag, no answer, a deleted dataset or no snapshot plans nothing", () => {
    for (const [answer, words] of [
      [{ kind: "error", reason: "OpenNeuro GraphQL answered HTTP 503" }, "HTTP 503"],
      [{ kind: "deleted", reason: "Dataset ds000001 has been deleted." }, "has been deleted"],
      [read(null, []), "names no snapshot"],
      [read(snap("1..2", "2026-01-01"), []), "unexpected shape"],
    ] as Array<[UpstreamRead, string]>) {
      const c = check(answer, "1.0.0");
      expect(c, words).toMatchObject({ status: "refused", code: "latest-unknown" });
      expect(c.detail, words).toContain(words);
    }
  });
});

describe("fetchOpenNeuroSnapshots", () => {
  const state = { failures: 0, body: null as unknown, seen: [] as unknown[] };
  let server: ReturnType<typeof Bun.serve>;
  let url: string;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        state.seen.push(await req.json());
        if (state.failures > 0) {
          state.failures--;
          return new Response("busy", { status: 503 });
        }
        return Response.json(state.body);
      },
    });
    url = `http://127.0.0.1:${server.port}/crn/graphql`;
  });
  afterAll(() => server.stop(true));

  test("asks the staleness report's query for one id, and retries a transient failure", async () => {
    state.seen = [];
    state.failures = 1;
    state.body = {
      data: {
        a0: {
          id: "ds000001",
          latestSnapshot: { tag: "1.0.0", created: "2020-05-01T00:00:00Z" },
          snapshots: [{ tag: "00006", created: "2018-03-01T00:00:00Z" }],
        },
      },
    };
    const got = await fetchOpenNeuroSnapshots("ds000001", { graphqlUrl: url, retryDelayMs: 1 });
    expect(got).toEqual({
      kind: "snapshot",
      latest: { tag: "1.0.0", created: "2020-05-01T00:00:00Z" },
      snapshots: [{ tag: "00006", created: "2018-03-01T00:00:00Z" }],
    });
    expect(state.seen).toHaveLength(2);
    expect(state.seen[1]).toMatchObject({ variables: { a0: "ds000001" } });
    expect(JSON.stringify(state.seen[1])).toContain("snapshots { tag created }");
  });

  test("a failure that outlasts the attempts is an error read, never a verdict", async () => {
    state.failures = 5;
    const got = await fetchOpenNeuroSnapshots("ds000001", {
      graphqlUrl: url,
      attempts: 2,
      retryDelayMs: 1,
    });
    expect(got).toEqual({ kind: "error", reason: "OpenNeuro GraphQL answered HTTP 503" });
    state.failures = 0;
  });

  test("an answer is final: a node for another dataset is an error read, not retried", async () => {
    state.seen = [];
    state.body = { data: { a0: { id: "ds000002", latestSnapshot: null, snapshots: [] } } };
    const got = await fetchOpenNeuroSnapshots("ds000001", { graphqlUrl: url, retryDelayMs: 1 });
    expect(got.kind).toBe("error");
    expect(state.seen).toHaveLength(1);
  });
});
