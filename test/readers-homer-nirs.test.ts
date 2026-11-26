/**
 * The Homer2 `.nirs` reader (`shared/readers/homer-nirs.ts`, card A5). The real file is Homer3's
 * `Simple_Probe.nirs` (BSD 2-Clause, `test/fixtures/mat/README.md`); rules over single arrays
 * are checked on arrays built here, each with a twin.
 *
 * CI TIER: unit-pure.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bufferSource, cachedSource, readerFor } from "../shared/identifier-readers";
import type { MatEntry } from "../shared/mat-meta";
import { HOMER_NIRS_READER, scanHomerEntries } from "../shared/readers/homer-nirs";

const bytes = new Uint8Array(
  readFileSync(join(import.meta.dir, "fixtures", "mat", "homer2-simple-probe.nirs")),
);
const char = (fields: string[], v: string): MatEntry => ({
  fields,
  class: "char",
  dims: [1, v.length],
  value: [v],
});
const kinds = (entries: MatEntry[]) =>
  scanHomerEntries(entries).map((f) => `${f.kind}/${f.severity}/${f.field}`);

describe("the Homer2 .nirs reader", () => {
  test(".nirs is Homer's", () => {
    expect(readerFor("sourcedata/run1.NIRS")?.id).toBe("homer-nirs");
  });

  test("the real file is complete, holds no finding, and its signals are not inflated", async () => {
    const src = cachedSource(bufferSource(bytes), HOMER_NIRS_READER.limits);
    const result = await HOMER_NIRS_READER.scan(src, "a.nirs", HOMER_NIRS_READER.limits);
    expect(result).toEqual({ findings: [], coverage: "complete" });
  });

  test("text goes through the free-text rules: person fields, identifier keys, paths", () => {
    expect(kinds([char(["subject"], "Quillfeather Marlow")])).toEqual([
      "mat-freetext-name/identifier/nirs.variable",
    ]);
    expect(kinds([char(["notes"], "data in /Users/qmarlow/fnirs")])).toEqual([
      "mat-freetext/review/nirs.variable",
    ]);
    expect(kinds([char(["SD", "SpatialUnit"], "mm"), char(["CondNames"], "Tapping")])).toEqual([]);
    const mrn: MatEntry = { fields: ["MRN"], class: "double", dims: [1, 1], value: [123456] };
    expect(kinds([mrn])).toEqual(["mat-identifier-field/identifier/mrn"]);
    // The twin: a placeholder number holds nothing.
    expect(kinds([{ ...mrn, value: [0] }])).toEqual([]);
  });

  test("a truncated file is partial, never clean", async () => {
    const cut = bytes.subarray(0, bytes.length - 2000);
    const result = await HOMER_NIRS_READER.scan(
      bufferSource(cut),
      "a.nirs",
      HOMER_NIRS_READER.limits,
    );
    expect(result.coverage).toBe("partial");
  });
});
