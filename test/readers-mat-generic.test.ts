/**
 * The generic `.mat` reader and the shared MATLAB layer (`shared/readers/mat-generic.ts`, card
 * A5): version dispatch, the v7.3 entries, the unscanned-text rule and the free-text rules. The
 * real file is OpenNeuro ds003490's `code/ONOFF_4Oddball.mat` (CC0, compressed);
 * `test/fixtures/mat/README.md` records it.
 *
 * CI TIER: unit-pure.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hdf5Entry } from "../shared/hdf5-meta";
import { bufferSource, readerFor } from "../shared/identifier-readers";
import type { MatEntry } from "../shared/mat-meta";
import {
  MAT_GENERIC_READER,
  foldFindings,
  fromHdf5,
  scanMatEntries,
  unscannedMat,
  walkMatForReader,
} from "../shared/readers/mat-generic";
import { FREE_TEXT_MAX_CHARS } from "../shared/readers/text-header";

const MAT = join(import.meta.dir, "fixtures", "mat");
const load = (name: string) => new Uint8Array(readFileSync(join(MAT, name)));
const LIMITS = MAT_GENERIC_READER.limits;
const char = (fields: string[], ...rows: string[]): MatEntry => ({
  fields,
  class: "char",
  dims: [rows.length, rows[0]?.length ?? 0],
  value: rows,
});

describe("the generic .mat reader", () => {
  test(".mat is the generic reader's", () => {
    expect(readerFor("sourcedata/export.MAT")?.id).toBe("mat");
  });

  test("the real compressed file is complete and holds no finding", async () => {
    const result = await MAT_GENERIC_READER.scan(
      bufferSource(load("oddball-onoff.mat")),
      "a.mat",
      LIMITS,
    );
    expect(result).toEqual({ findings: [], coverage: "complete" });
  });

  test("every character array goes through the free-text rules, under mat.variable", () => {
    const found = scanMatEntries([
      char(["cfg", "experimenter"], "Marlow"),
      char(["cfg", "notes"], "/home/qmarlow/raw"),
      // A location field is not read.
      char(["cfg", "datadir"], "/home/qmarlow/raw"),
      char(["cfg", "task"], "oddball"),
    ]);
    expect(found.map((f) => `${f.kind}/${f.severity}/${f.field}`)).toEqual([
      "mat-freetext-name/identifier/mat.variable",
      "mat-freetext/review/mat.variable",
    ]);
  });

  test("every file kind is told by its content", async () => {
    // A file that is another format: not-applicable.
    const text = new TextEncoder().encode("# a plain text table\n1 2 3\n");
    expect((await MAT_GENERIC_READER.scan(bufferSource(text), "a.mat", LIMITS)).coverage).toBe(
      "not-applicable",
    );
    // An empty file is a damaged one, not another format.
    expect(await MAT_GENERIC_READER.scan(bufferSource(new Uint8Array(0)), "a.mat", LIMITS)).toEqual(
      {
        findings: [],
        coverage: "partial",
        incomplete: "corrupt",
      },
    );
    // A Level 4 file: partial, unsupported-version.
    const v4 = new Uint8Array(40);
    const view = new DataView(v4.buffer);
    view.setInt32(4, 1, true);
    view.setInt32(8, 1, true);
    view.setInt32(16, 2, true);
    v4[20] = "x".charCodeAt(0);
    expect((await walkMatForReader(bufferSource(v4), LIMITS)).incomplete).toBe(
      "unsupported-version",
    );
  });
});

describe("one finding per kind and field per file", () => {
  test("repeats fold into the first, with their count and no value", () => {
    const shapeOnly = scanMatEntries([char(["a", "experimenter"], "Marlow")])[0];
    const folded = foldFindings([
      ...scanMatEntries([char(["a", "experimenter"], "Marlow")]),
      ...scanMatEntries([char(["b", "operator"], "Quillfeather")]),
      ...scanMatEntries([char(["c", "notes"], "/home/qmarlow/x")]),
    ]);
    expect(folded).toEqual([
      { ...shapeOnly, occurrences: 2 } as never,
      expect.objectContaining({ kind: "mat-freetext" }),
    ]);
    expect(folded[1]?.occurrences).toBeUndefined();
    expect(JSON.stringify(folded)).not.toContain("Marlow");
  });
});

describe("text listed and not read makes the read partial", () => {
  test("a skipped char array, an overlong line, a skipped identifier key, an unsupported class", () => {
    expect(unscannedMat([char(["a"], "short")])).toBeNull();
    expect(
      unscannedMat([
        { fields: ["a"], class: "char", dims: [1, 9e5], value: null, skipped: "size" },
      ]),
    ).toBe("limit");
    expect(unscannedMat([char(["a"], "x".repeat(FREE_TEXT_MAX_CHARS + 1))])).toBe("limit");
    // Lines are counted one by one: a long history of short lines is read whole.
    expect(unscannedMat([char(["a"], `${"x".repeat(4000)}\n${"y".repeat(4000)}`)])).toBeNull();
    const big: MatEntry = {
      fields: ["PatientID"],
      class: "double",
      dims: [1, 100],
      value: null,
      skipped: "size",
    };
    expect(unscannedMat([big])).toBe("limit");
    // The twin: a skipped signal under any other name is not text.
    expect(unscannedMat([{ ...big, fields: ["data"] }])).toBeNull();
    expect(
      unscannedMat([{ fields: ["t"], class: "opaque", dims: [], value: null, skipped: "type" }]),
    ).toBe("unsupported-datatype");
  });
});

describe("v7.3 entries", () => {
  const attr = (path: string, name: string, value: Hdf5Entry["value"]): Hdf5Entry => ({
    path,
    kind: "attribute",
    name,
    dtype: "string",
    shape: [],
    value,
  });
  const ds = (
    path: string,
    value: Hdf5Entry["value"],
    extra: Partial<Hdf5Entry> = {},
  ): Hdf5Entry => ({
    path,
    kind: "dataset",
    name: path.split("/").pop() as string,
    dtype: "uint16",
    shape: [5, 1],
    value,
    ...extra,
  });

  test("classes, empties, references and unsupported classes", () => {
    const entries = fromHdf5([
      attr("/EEG/subject", "MATLAB_class", "char"),
      ds("/EEG/subject", ["Marlo"]),
      attr("/EEG/group", "MATLAB_class", "char"),
      attr("/EEG/group", "MATLAB_empty", [1]),
      ds("/EEG/group", [0, 0], { dtype: "uint64" }),
      ds("/EEG/event/type", null, { dtype: "reference", skipped: "type" }),
      attr("/#refs#/a", "MATLAB_class", "canonical empty"),
      ds("/#refs#/a", [0, 0]),
      attr("/#refs#/b", "MATLAB_class", "char"),
      ds("/#refs#/b", ["S  1"]),
      attr("/EEG/tbl", "MATLAB_class", "table"),
      ds("/EEG/tbl", [1, 2, 3], { dtype: "uint32" }),
      attr("/EEG/notes", "MATLAB_class", "char"),
      ds("/EEG/notes", null, { skipped: "size" }),
    ]);
    expect(entries).toEqual([
      { fields: ["EEG", "subject"], class: "char", dims: [1, 5], value: ["Marlo"] },
      { fields: ["EEG", "group"], class: "char", dims: [0, 0], value: [] },
      { fields: ["#refs#"], class: "char", dims: [1, 5], value: ["S  1"] },
      { fields: ["EEG", "tbl"], class: "opaque", dims: [1, 5], value: null, skipped: "type" },
      { fields: ["EEG", "notes"], class: "char", dims: [1, 5], value: null, skipped: "size" },
    ]);
    expect(unscannedMat(entries)).toBe("unsupported-datatype");
  });

  test("the v7.3 file is read through the HDF5 walker with its char arrays as text", async () => {
    const walk = await walkMatForReader(bufferSource(load("eeglab-data-v73-edited.set")), LIMITS);
    expect(walk.format).toBe("v7.3");
    expect(walk.incomplete).toBeUndefined();
    const history = walk.entries.find((e) => e.fields.join("/") === "EEG/history");
    expect(history?.class).toBe("char");
    expect((history?.value as string[])[0]?.length).toBeGreaterThan(64);
  });
});
