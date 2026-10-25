/**
 * The re-pull commit's two trailers, read as git reads them (`src/lib/repull/trailers.ts`; ADR
 * 0111, decision 2, and the privacy ledger's fresh-clone proof of ADR 0085), and the squash
 * message the merge gate writes (`squashMessage`). The real `git interpret-trailers`, no stand-in.
 *
 * The property: a message is accepted only when its last paragraph carries both trailers, once
 * each, with the record's own values, as the proof's patterns read them. GitHub's default squash
 * message, which lists each commit as a bullet and so puts the trailers mid-message, is refused.
 *
 * CI TIER: unit (runs git, reads no repository).
 */

import { describe, expect, test } from "bun:test";
import type { RepullRow } from "../shared/repull-state";
import { squashMessage } from "../src/lib/repull/merge";
import { repullTrailerLines, trailersProblem } from "../src/lib/repull/trailers";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const ROW = { upstream_ds: "ds004362", to_tag: "1.0.1", plan_digest: DIGEST };
const [SNAPSHOT, PLAN] = repullTrailerLines(ROW);

describe("the trailers, as git reads them", () => {
  test("the gate's own squash message carries both as its last paragraph", async () => {
    const row = {
      ...ROW,
      id: 3,
      to_version: "2.0.0",
      from_tag: "1.0.0",
    } as unknown as RepullRow;
    const m = squashMessage(row, 12);
    expect(m.title).toBe("Release v2.0.0 (#12)");
    expect(await trailersProblem(`${m.title}\n\n${m.message}`, ROW)).toBeNull();
  });

  test("GitHub's default squash message, bullets with the trailers mid-message, is refused", async () => {
    const github = [
      "Release v2.0.0 (#12)",
      "",
      "* Re-pull ds004362 1.0.0 to 1.0.1 as v2.0.0",
      "",
      "Upstream's snapshot 1.0.1, replayed as one commit.",
      "",
      SNAPSHOT,
      PLAN,
      "",
      "* Update .nemar/metadata.json",
    ].join("\n");
    expect(await trailersProblem(github, ROW)).toMatch(/no Upstream-Snapshot: trailer/);
  });

  test("one trailer, two of a kind, or another value is refused", async () => {
    const msg = (...last: string[]) =>
      ["Release v2.0.0 (#12)", "", "Body.", "", ...last].join("\n");
    expect(await trailersProblem(msg(SNAPSHOT), ROW)).toMatch(/no Repull-Plan: trailer/);
    expect(await trailersProblem(msg(SNAPSHOT, SNAPSHOT, PLAN), ROW)).toMatch(
      /2 Upstream-Snapshot/,
    );
    expect(
      await trailersProblem(msg(SNAPSHOT, `Repull-Plan: sha256:${"cd".repeat(32)}`), ROW),
    ).toMatch(/not the re-pull's own/);
    expect(await trailersProblem(msg(SNAPSHOT, PLAN), ROW)).toBeNull();
  });

  test("a value the proof's pattern cannot read is refused even when it is the record's", async () => {
    const odd = { ...ROW, to_tag: "1.0.1 (final)" };
    const [s, p] = repullTrailerLines(odd);
    expect(await trailersProblem(`Title\n\nBody.\n\n${s}\n${p}`, odd)).toMatch(
      /not the re-pull's own/,
    );
  });
});
