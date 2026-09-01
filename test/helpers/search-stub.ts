/**
 * A local stub of the search endpoint for CLI subprocess tests (#1174
 * follow-up).
 *
 * The Phase 6 renderer tests originally spawned `nemar dataset search` against
 * the LIVE production API. They passed standalone and failed inside a full
 * `bun test` run: dozens of other suites hit the same host in the same run,
 * and the backend's per-IP rate limiter starts refusing, so the CLI exits 1
 * and the assertion fails on `exitCode`. That is a real defect in the tests,
 * not flakiness to retry around -- a renderer test has no business depending
 * on a production service being reachable and unthrottled.
 *
 * A stub also makes the fixtures deterministic, which these tests actually
 * need: they assert on a snippet, a modality list and a score, and live data
 * can change any of them without warning.
 *
 * Answers `/notices` and `/datasets/facets` too, because every real CLI
 * invocation fires those (the preAction notices hook, and phase 5b's
 * opportunistic completion refresh). Without them the CLI would still work
 * but would spend real time failing those calls.
 */
import type { Server } from "bun";

export interface SearchStub {
  url: string;
  stop: () => void;
}

/** One result carrying every field the renderer reads, including a snippet
 *  with a `<mark>` term and a multi-token modality list. */
export const STUB_SEARCH_BODY = {
  results: [
    {
      id: "nm900111",
      name: "Stub P300 Oddball Dataset With A Deliberately Long Name",
      modalities: "anat,eeg,fmap",
      participants: 58,
      doi: "",
      tasks: "p300",
      authors: "Stub Author",
      has_hed: 1,
      score: 0.0315,
      snippet: "\u2026Target (<mark>P300</mark> expected) and Non-Target\u2026",
    },
    {
      id: "nm900222",
      name: "Second Stub Dataset",
      modalities: "eeg",
      participants: 12,
      doi: "",
      tasks: "rest",
      authors: "Other Author",
      has_hed: null,
      score: 0.0164,
    },
  ],
  count: 2,
  method: "semantic",
};

export function startSearchStub(body: unknown = STUB_SEARCH_BODY): SearchStub {
  const server: Server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      return Response.json(body);
    },
  });
  return { url: server.url.toString(), stop: () => server.stop(true) };
}
