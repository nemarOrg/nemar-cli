/**
 * `fetchSnapshotFilePair` (epic #1046 phase 4c, #1910): one request for two snapshots' recursive
 * file listings, read from a local stand-in serving the REAL recorded listings. The error paths
 * are the point: a failure is `{ ok: false }` with a reason and is never an empty listing, because
 * an empty listing would make `summarizeSnapshotDelta` report a confident, wrong delta.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { fetchSnapshotFilePair } from "../src/lib/openneuro";
import { startOpenNeuroFilesStandin } from "./helpers/openneuro-files-standin";

const standin = startOpenNeuroFilesStandin();
afterAll(() => standin.stop());
beforeEach(() => {
  standin.requests.length = 0;
  standin.setRecorded();
});

describe("fetchSnapshotFilePair", () => {
  test("reads both recorded listings in one request, ids only in variables", async () => {
    const res = await fetchSnapshotFilePair("ds003082", "1.0.0", "1.0.1", {
      graphqlUrl: standin.url,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.from.length).toBe(82);
    expect(res.to.length).toBe(83);
    expect(res.from.every((f) => typeof f.directory === "boolean")).toBe(true);
    expect(standin.requests.length).toBe(1);
    const sent = standin.requests[0];
    expect(sent?.userAgent).toBe("nemar-cli");
    expect(sent?.query).toContain("$ds: ID!");
    expect(sent?.query).not.toContain("ds003082");
    expect(sent?.query).not.toContain("1.0.1");
  });

  test("an HTTP error is a failure with the status, not an empty listing", async () => {
    standin.setStatus(503);
    const res = await fetchSnapshotFilePair("ds003082", "1.0.0", "1.0.1", {
      graphqlUrl: standin.url,
    });
    expect(res).toEqual({ ok: false, error: "OpenNeuro GraphQL answered HTTP 503" });
  });

  test("a body that is not JSON is a failure", async () => {
    standin.setText("<html>not json</html>");
    const res = await fetchSnapshotFilePair("ds003082", "1.0.0", "1.0.1", {
      graphqlUrl: standin.url,
    });
    expect(res.ok).toBe(false);
  });

  test("a hang past the timeout is a failure", async () => {
    standin.setHang();
    const res = await fetchSnapshotFilePair("ds003082", "1.0.0", "1.0.1", {
      graphqlUrl: standin.url,
      timeoutMs: 200,
    });
    expect(res.ok).toBe(false);
  });

  test("an unreachable endpoint is a failure, not a throw", async () => {
    const res = await fetchSnapshotFilePair("ds003082", "1.0.0", "1.0.1", {
      graphqlUrl: "http://127.0.0.1:1/crn/graphql",
      timeoutMs: 2000,
    });
    expect(res.ok).toBe(false);
  });

  test("a snapshot OpenNeuro could not serve is a failure that carries its message", async () => {
    standin.setPartial();
    const res = await fetchSnapshotFilePair("ds003082", "1.0.0", "1.0.1", {
      graphqlUrl: standin.url,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("1.0.1");
    expect(res.error).toContain("not found");
  });

  test("a files value that is not a list is a failure, never []", async () => {
    // Built: OpenNeuro does not send this today; the rule is what stops a wrong zero delta.
    standin.setText(JSON.stringify({ data: { a: { files: {} }, b: { files: [] } } }));
    const res = await fetchSnapshotFilePair("ds003082", "1.0.0", "1.0.1", {
      graphqlUrl: standin.url,
    });
    expect(res.ok).toBe(false);
  });

  test("a malformed entry is a failure naming the entry", async () => {
    standin.setText(
      JSON.stringify({
        data: {
          a: { files: [{ id: "x", filename: "a", size: 1, annexed: false, directory: false }] },
          b: { files: [{ id: "y", filename: "a", size: "big", annexed: false, directory: false }] },
        },
      }),
    );
    const res = await fetchSnapshotFilePair("ds003082", "1.0.0", "1.0.1", {
      graphqlUrl: standin.url,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("entry 0");
  });

  test("an empty listing that OpenNeuro really sent is an empty listing", async () => {
    standin.setText(JSON.stringify({ data: { a: { files: [] }, b: { files: [] } } }));
    const res = await fetchSnapshotFilePair("ds003082", "1.0.0", "1.0.1", {
      graphqlUrl: standin.url,
    });
    expect(res).toEqual({ ok: true, from: [], to: [] });
  });
});
