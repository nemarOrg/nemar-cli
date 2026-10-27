/**
 * The re-pull commit's two trailers, read as git reads them (`src/lib/repull/trailers.ts`; ADR
 * 0111, decision 2, and the privacy ledger's fresh-clone proof of ADR 0085), and the squash
 * message the merge gate writes (`squashMessage`). The real `git interpret-trailers`, no stand-in.
 *
 * The property: a message is accepted only when its last paragraph carries both trailers, once
 * each, with the record's own values, as the proof's patterns read them. GitHub's default squash
 * message, which lists each commit as a bullet and so puts the trailers mid-message, is refused.
 *
 * CI TIER: unit-pure (runs git, reads no repository).
 */

import { describe, expect, test } from "bun:test";
import { REPULL_PLAN_TRAILER, UPSTREAM_SNAPSHOT_TRAILER } from "../scripts/scrub/git/git-lib";
import {
  PLAN_TRAILER_VALUE_RE,
  SNAPSHOT_TRAILER_VALUE_RE,
  repullPatchTrailerLine,
  repullSquashMessage,
  trailerValuesProblem,
} from "../shared/repull-squash";
import type { RepullRow } from "../shared/repull-state";
import { releaseBody } from "../src/lib/repull/execute/pull-request";
import { squashMessage } from "../src/lib/repull/merge";
import { patchMessage } from "../src/lib/repull/patch";
import { patchBody } from "../src/lib/repull/patch-turn";
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

describe("the Worker's squash message (ADR 0111, the Phase 7g amendment)", () => {
  const row = (over: Partial<typeof ROW> = {}) =>
    ({ ...ROW, ...over, id: 3, to_version: "2.0.0", from_tag: "1.0.0" }) as unknown as RepullRow;

  test("the Worker checks the values with the ledger proof's own patterns, not copies of them", () => {
    // The proof's patterns are the trailer key, one space, and these values, as one line.
    expect(UPSTREAM_SNAPSHOT_TRAILER.source).toBe(
      `^Upstream-Snapshot: ${SNAPSHOT_TRAILER_VALUE_RE.source.slice(1)}`,
    );
    expect(REPULL_PLAN_TRAILER.source).toBe(
      `^Repull-Plan: ${PLAN_TRAILER_VALUE_RE.source.slice(1)}`,
    );
  });

  test("the message the Worker sends is read by git as the two trailers, as the gate's is", async () => {
    for (const tag of ["1.0.1", "00002", "2.1.0-rc1", "v1.0.1", "A.b_c-9"]) {
      const r = row({ to_tag: tag });
      const m = repullSquashMessage(r, 12, "n0", "worker");
      expect(m.title).toBe("Release v2.0.0 (#12)");
      expect(trailerValuesProblem(r)).toBeNull();
      expect([tag, await trailersProblem(`${m.title}\n\n${m.message}`, r)]).toEqual([tag, null]);
    }
  });

  test("a value git would not read as the proof reads it, the Worker refuses before anything", async () => {
    for (const over of [
      { to_tag: "1.0.1 (final)" },
      { to_tag: "-1.0.1" },
      { upstream_ds: "ds04362" },
      { plan_digest: "sha256:abc" },
    ]) {
      const r = row(over);
      const m = repullSquashMessage(r, 12, "n0", "worker");
      expect([over, trailerValuesProblem(r) !== null]).toEqual([over, true]);
      expect([over, await trailersProblem(`${m.title}\n\n${m.message}`, r)]).not.toEqual([
        over,
        null,
      ]);
    }
  });

  test("only the first paragraph says who merged it", () => {
    const gate = repullSquashMessage(row(), 12, "n0", "gate");
    const worker = repullSquashMessage(row(), 12, "n0", "worker");
    expect(worker.title).toBe(gate.title);
    expect(worker.message.split("\n\n").slice(1)).toEqual(gate.message.split("\n\n").slice(1));
    expect(gate.message).toBe(squashMessage(row(), 12).message);
  });
});

// ----------------------------------------------------------------------------
// One builder (#1972): no writer formats the lines itself
// ----------------------------------------------------------------------------

/** The lines between a body's first pair of code fences: what an administrator is told to expect. */
function fencedLines(body: string): string[] {
  const lines = body.split("\n");
  const open = lines.indexOf("```");
  const close = lines.indexOf("```", open + 1);
  if (open === -1 || close === -1) throw new Error("the body has no fenced block");
  return lines.slice(open + 1, close);
}

describe("every writer of the trailers carries the builder's lines, byte for byte (#1972)", () => {
  // A tag with the characters the proof allows beyond digits and dots, and a digest that is not
  // all one byte, so a writer that formats a line itself and drifts cannot match by accident.
  const row = {
    id: 9,
    dataset_id: "on004362",
    upstream_ds: "ds004362",
    from_tag: "1.0.0",
    to_tag: "2.1.0-rc1",
    to_version: "2.0.0",
    patch_version: "2.0.1",
    plan_digest: `sha256:${"0f".repeat(32)}`,
    counts: { corrections: 7 },
  } as unknown as RepullRow;
  const lines = repullTrailerLines(row);
  const withPatch = [...lines, repullPatchTrailerLine(7)];
  const selection = { paths: [], keys: [], corrections: 7, resolutions: 0, unresolved: 0 };

  test("N.0.0's pull request body lists exactly the two lines", () => {
    const body = releaseBody({
      datasetId: row.dataset_id,
      repullId: row.id,
      ds: row.upstream_ds,
      fromTag: row.from_tag,
      toTag: row.to_tag,
      toVersion: row.to_version,
      patchVersion: row.patch_version,
      digest: row.plan_digest,
      doiCount: 1,
      counts: {},
    });
    expect(fencedLines(body)).toEqual(lines);
  });

  test("N.0.1's pull request body lists exactly the two lines and the patch line", () => {
    expect(fencedLines(patchBody(row, selection, "2.0.1"))).toEqual(withPatch);
  });

  test("N.0.1's commit message ends with the same three lines", () => {
    const message = patchMessage(row, selection, "2.0.1");
    expect(message.endsWith(`\n\n${withPatch.join("\n")}\n`)).toBe(true);
  });

  test("the squash messages end with the two lines, and N.0.1's with the three", () => {
    for (const merger of ["gate", "worker"] as const) {
      expect(
        repullSquashMessage(row, 12, "n0", merger).message.endsWith(`\n\n${lines.join("\n")}`),
      ).toBe(true);
      expect(
        repullSquashMessage(row, 12, "n1", merger).message.endsWith(`\n\n${withPatch.join("\n")}`),
      ).toBe(true);
    }
  });

  test("the patch line is the key, one space and the count, and nothing else", () => {
    expect(repullPatchTrailerLine(0)).toBe("Repull-Patch: corrections=0");
    expect(repullPatchTrailerLine(12)).toBe("Repull-Patch: corrections=12");
  });
});
