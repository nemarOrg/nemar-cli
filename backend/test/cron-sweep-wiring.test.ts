/**
 * Cron wiring pin for the backfill sweeps (#1164).
 *
 * A sweep service is only half a feature. The other half is the recurring
 * driver that drains it, and nothing in this repo asserted that the two were
 * ever connected. Epic #1144 Phase 2b shipped `runSignalDefaultsSweep` with a
 * service, an admin endpoint and two test files, and never added it to
 * `scheduled()`. Its Phase 2 sibling `runRecordingStatsSweep` WAS wired, so the
 * omission looked like nothing: both sweeps had tests, both had endpoints, and
 * `signal_defaults` simply stayed empty for the whole catalog because the only
 * thing that ever called it was a human.
 *
 * These tests close that specific gap and generalize it, so the next sweep
 * cannot repeat it. The generalized test is the point; the named-sweep test
 * below is the regression for the one that actually happened.
 *
 * Structural (it reads the production source rather than invoking the Worker
 * `scheduled()` handler), matching this repo's admin-route-inventory and
 * api-export-surface convention. Invoking the real handler would require a full
 * Bindings env and would fire every other daily job as a side effect, which
 * buys nothing here: the failure mode being pinned is a missing call site, and
 * a missing call site is visible in the source.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SERVICES_DIR = join(import.meta.dir, "../src/services");
const INDEX_PATH = join(import.meta.dir, "../src/index.ts");

/**
 * Sweeps that deliberately have no cron driver, each with the reason. Adding a
 * name here is a decision to drain it by hand forever, so it needs a reason
 * that survives being read a year later, not just an entry.
 */
const ADMIN_ONLY_SWEEPS: Record<string, string> = {};

/** Every `run<X>Sweep` exported from a service module. */
function discoverSweepExports(): string[] {
  const names: string[] = [];
  for (const file of readdirSync(SERVICES_DIR).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(SERVICES_DIR, file), "utf-8");
    for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+(run\w*Sweep)\s*\(/gm)) {
      names.push(m[1]);
    }
  }
  return names.sort();
}

/**
 * The body of the `if (prodOnlyJobs) { ... }` block in `scheduled()`, found by
 * brace matching rather than by a line range, so an edit above it does not
 * silently shift what this test reads.
 */
function prodOnlyBlock(src: string): string {
  const marker = "if (prodOnlyJobs) {";
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("prod-only cron block not found in index.ts");
  let depth = 0;
  for (let i = start + marker.length - 1; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start + marker.length, i);
    }
  }
  throw new Error("prod-only cron block is unbalanced");
}

/** Strip line and block comments so a sweep NAMED in prose is not read as a
 *  call site. Without this, the comment above each block would satisfy the
 *  assertion on its own and the test would pass with the call deleted. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("every sweep service has a recurring driver", () => {
  const sweeps = discoverSweepExports();
  const indexSrc = readFileSync(INDEX_PATH, "utf-8");
  const scheduledProdOnly = stripComments(prodOnlyBlock(indexSrc));

  test("discovery finds the known sweeps, so an empty list cannot pass vacuously", () => {
    // Without this the whole describe block would pass if the regex stopped
    // matching: zero sweeps trivially satisfy "every sweep is wired".
    expect(sweeps.length).toBeGreaterThanOrEqual(3);
    expect(sweeps).toContain("runRecordingStatsSweep");
    expect(sweeps).toContain("runSignalDefaultsSweep");
  });

  for (const name of discoverSweepExports()) {
    test(`${name} is wired into the daily cron or explicitly admin-only`, () => {
      if (name in ADMIN_ONLY_SWEEPS) {
        expect(ADMIN_ONLY_SWEEPS[name].length).toBeGreaterThan(0);
        return;
      }
      expect(scheduledProdOnly).toContain(`${name}(env)`);
    });
  }
});

describe("the two epic #1144 backfill sweeps run on the prod-only branch", () => {
  const indexSrc = readFileSync(INDEX_PATH, "utf-8");
  const stripped = stripComments(indexSrc);
  const prodOnly = stripComments(prodOnlyBlock(indexSrc));

  // The regression for #1164 itself, named rather than derived, so the failure
  // message says which sweep lost its driver.
  for (const name of ["runRecordingStatsSweep", "runSignalDefaultsSweep"]) {
    test(`${name} is called inside the prod-only block`, () => {
      expect(prodOnly).toContain(`${name}(env)`);
    });

    test(`${name} is called ONLY inside the prod-only block`, () => {
      // Both sweeps reach the shared nemarDatasets org or the prod bucket, so a
      // second call site outside the guard would run them on the dev worker
      // against the prod-mirror D1. Counting occurrences catches a copy that
      // was moved out of the guard as well as one that was added beside it.
      const total = stripped.split(`${name}(env)`).length - 1;
      const guarded = prodOnly.split(`${name}(env)`).length - 1;
      expect(total).toBe(guarded);
      expect(guarded).toBe(1);
    });
  }
});
