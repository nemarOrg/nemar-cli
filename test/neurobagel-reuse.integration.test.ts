/**
 * The reuse generator and the curation check against the live data plane and the pinned upstream
 * commit (epic #1586, phase 5).
 *
 * Read-only public GETs of data.nemar.org, api.github.com and raw.githubusercontent.com, so this is
 * an *.integration.test.ts (CI's required unit tier skips that suffix) and opt-in:
 *   NEUROBAGEL_LIVE=1 bun test test/neurobagel-reuse.integration.test.ts
 *
 * What it proves that the fixtures cannot: the generator, run from the command line against what
 * the servers hold today, writes the entry that is committed (so the committed sample is neither
 * stale nor hand-edited), and every committed entry still fits the live data plane.
 * An entry that stops fitting is the signal this test exists to give: a mirror changed, and the
 * entry needs a regeneration or a new review.
 * Without NEUROBAGEL_LIVE=1 every test below is reported as skipped, not passed.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCuration } from "../scripts/neurobagel/fixtures-io";
import { canonicalJson } from "../shared/neurobagel/canonical-json";

const live = process.env.NEUROBAGEL_LIVE === "1";
/** Each test starts a command that makes real requests; bun's 5 second default is not enough. */
const LIVE_TIMEOUT = 120_000;
if (!live) {
  console.warn(
    "neurobagel-reuse.integration: skipped (set NEUROBAGEL_LIVE=1 to read the live servers)",
  );
}

describe.skipIf(!live)("reuse of upstream annotations, live", () => {
  test(
    "the command line writes the committed entry for a reused dataset, byte for byte",
    async () => {
      const id = "on003568";
      const committed = loadCuration().entries.get(id);
      expect(committed).toBeDefined();
      const dir = mkdtempSync(join(tmpdir(), "nemar-reuse-"));
      try {
        const out = join(dir, "entries.json");
        const proc = Bun.spawn(
          [
            "bun",
            "run",
            "scripts/neurobagel/reuse-openneuro-annotations.ts",
            "--date",
            committed?.evidence.date as string,
            "--out",
            out,
            id,
          ],
          { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
        );
        expect(await proc.exited).toBe(0);
        const written = JSON.parse(readFileSync(out, "utf8")) as {
          datasets: Record<string, unknown>;
        };
        const file = JSON.parse(
          readFileSync(join(import.meta.dir, "../shared/neurobagel/curation.json"), "utf8"),
        ) as { datasets: Record<string, unknown> };
        expect(canonicalJson(written.datasets[id] as never)).toBe(
          canonicalJson(file.datasets[id] as never),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    LIVE_TIMEOUT,
  );

  test(
    "every committed entry still fits the data plane today",
    async () => {
      const proc = Bun.spawn(["bun", "run", "scripts/neurobagel/curation-check.ts", "--live"], {
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stdout).text();
      expect(output).toContain(
        `${loadCuration().entries.size} entries, ${loadCuration().entries.size} applied`,
      );
      expect(await proc.exited).toBe(0);
    },
    LIVE_TIMEOUT,
  );
});
