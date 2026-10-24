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
    expect(res).toEqual({
      ok: false,
      error: "OpenNeuro GraphQL answered HTTP 503",
      transport: true,
    });
  });

  test("a body that is not JSON is a failure", async () => {
    standin.setText("<html>not json</html>");
    const res = await fetchSnapshotFilePair("ds003082", "1.0.0", "1.0.1", {
      graphqlUrl: standin.url,
    });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ transport: true });
  });

  test("a hang past the timeout is a failure", async () => {
    standin.setHang();
    const res = await fetchSnapshotFilePair("ds003082", "1.0.0", "1.0.1", {
      graphqlUrl: standin.url,
      timeoutMs: 200,
    });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ transport: true });
  });

  test("an unreachable endpoint is a failure, not a throw", async () => {
    const res = await fetchSnapshotFilePair("ds003082", "1.0.0", "1.0.1", {
      graphqlUrl: "http://127.0.0.1:1/crn/graphql",
      timeoutMs: 2000,
    });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ transport: true });
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
    // OpenNeuro answered; the answer is unusable for this dataset. That is not an outage.
    expect(res.transport).toBe(false);
  });

  test("a files value that is not a list is a failure, never []", async () => {
    // Built: OpenNeuro does not send this today; the rule is what stops a wrong zero delta.
    standin.setText(JSON.stringify({ data: { a: { files: {} }, b: { files: [] } } }));
    const res = await fetchSnapshotFilePair("ds003082", "1.0.0", "1.0.1", {
      graphqlUrl: standin.url,
    });
    expect(res).toMatchObject({ ok: false, transport: false });
  });

  // Built from the recorded entry shape: OpenNeuro does not send these today, and each is a
  // listing that, taken at face value, would turn into a confident wrong delta.
  const entry = (over: Record<string, unknown> = {}) => ({
    id: "26414282e75bda90d0f3a4c80b3dabfd9586aa9f",
    filename: "dataset_description.json",
    size: 755,
    annexed: false,
    directory: false,
    ...over,
  });
  const GOOD = [entry()];
  /** Serves `a` and `b` as the two listings and returns what the reader makes of them. */
  async function read(a: unknown[], b: unknown[], extra: Record<string, unknown> = {}) {
    standin.setText(JSON.stringify({ data: { a: { files: a }, b: { files: b } }, ...extra }));
    return fetchSnapshotFilePair("ds003082", "1.0.0", "1.0.1", { graphqlUrl: standin.url });
  }

  test("a well-formed small listing is read", async () => {
    const res = await read(GOOD, [entry({ id: "other" })]);
    expect(res.ok).toBe(true);
  });

  test("an empty listing is a failure naming the snapshot, whichever side is empty", async () => {
    for (const [a, b, tag] of [
      [[], [], "1.0.0"],
      [[], GOOD, "1.0.0"],
      [GOOD, [], "1.0.1"],
    ] as const) {
      const res = await read([...a], [...b]);
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.error).toContain("empty file list");
      expect(res.error).toContain(tag);
    }
  });

  test("a listing of directories only is empty", async () => {
    const res = await read([entry({ filename: "sub-01", directory: true })], GOOD);
    expect(res.ok).toBe(false);
  });

  test("a listing without a root dataset_description.json is not a snapshot", async () => {
    const res = await read(GOOD, [entry({ filename: "sub-01/dataset_description.json" })]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("no root dataset_description.json");
    expect(res.error).toContain("1.0.1");
  });

  test("data beside errors[] fails the pair, whatever the data says", async () => {
    const res = await read(GOOD, GOOD, { errors: [{ message: "resolver exploded", path: ["b"] }] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("resolver exploded");
  });

  test("a negative or non-integer size fails; a null size is allowed", async () => {
    expect((await read(GOOD, [entry({ size: -1 })])).ok).toBe(false);
    expect((await read(GOOD, [entry({ size: 1.5 })])).ok).toBe(false);
    expect((await read(GOOD, [entry({ size: null })])).ok).toBe(true);
  });

  test("two entries with one filename are a malformed listing", async () => {
    const res = await read(GOOD, [entry(), entry({ id: "other" })]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("twice");
  });

  test("each field of an entry is checked: annexed, id, filename, directory, size", async () => {
    for (const bad of [
      { annexed: "yes" },
      { annexed: undefined },
      { id: 7 },
      { id: undefined },
      { filename: 7 },
      { filename: undefined },
      { directory: "no" },
      { size: "big" },
      { size: undefined },
    ]) {
      const res = await read(GOOD, [entry(), entry({ filename: "README", ...bad })]);
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.error).toContain("malformed file entry");
      expect(res.error).toContain("entry 1");
      expect(res.transport).toBe(false);
    }
  });
});
