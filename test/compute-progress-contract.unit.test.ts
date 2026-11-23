/**
 * The live progress contract, `nemar.progress.v1` (ADR 0134 decision 3, epic #2324 phase 2).
 *
 * Pins: every word and number written out a second time. Behaviour: the object is closed at every
 * level and the response is open. Agreement: a corpus (a valid object, a key removed, a key of the wrong
 * type, an unknown key at each level, a value at and one past each bound, each pattern broken) is
 * judged by Ajv on the shared JSON Schema and by zod, and both must give the verdict the corpus names.
 * Neuroschema: every counts object the contract accepts, the vendored neuroschema `checkpointCounts`
 * accepts, and the regexes agree with neuroschema's `processingTypes` on a string corpus.
 */

import { describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020";
import {
  PROGRESS_BODY_MAX_BYTES,
  PROGRESS_CHECKPOINT_RE,
  PROGRESS_FAILURE_CODE_RE,
  PROGRESS_FORMAT,
  PROGRESS_MAX_BYTES,
  PROGRESS_MAX_CHECKPOINTS,
  PROGRESS_MAX_FAILURES,
  PROGRESS_MAX_RECORDINGS,
  PROGRESS_MIN_INTERVAL_SECONDS,
  PROGRESS_PATH_MAX,
  PROGRESS_PATH_RE,
  PROGRESS_REPORT_SECONDS,
  PROGRESS_STALLED_CADENCES,
  PROGRESS_STEP_RE,
  ProgressReportResponseSchema,
  ProgressSchema,
} from "../shared/contract/compute-progress";
import progressSchema from "../shared/contract/compute-progress.schema.json";
import * as contractIndex from "../shared/contract/index";
import { compileNeuroschemaValidator } from "./contract/neuroschema-validator.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(progressSchema);
const ajvProgress = ajv.getSchema(`${progressSchema.$id}#/$defs/Progress`);
const ajvResponse = ajv.getSchema(`${progressSchema.$id}#/$defs/ProgressReportResponse`);
if (!ajvProgress || !ajvResponse) throw new Error("progress schema members not found");

const counts = (passed: number, failed: number, skipped: number, total: number) => ({
  passed,
  failed,
  skipped,
  total,
});

const valid = () => ({
  format: PROGRESS_FORMAT,
  checkpoint: "preprocess",
  counts: {
    import: counts(9, 1, 0, 12),
    preprocess: counts(7, 1, 1, 12),
    quality: counts(6, 0, 2, 12),
  },
  failures: [
    {
      path: "sub-01/eeg/sub-01_task-rest_eeg.set",
      code: "load_failed",
      step: "load",
      checkpoint: "import",
    },
    {
      path: "sub-02/eeg/sub-02_task-rest_eeg.set",
      code: "step_failed",
      step: null,
      checkpoint: "preprocess",
    },
  ],
});

type Doc = ReturnType<typeof valid>;
const both = (doc: unknown) => ({
  ajv: ajvProgress(doc) as boolean,
  zod: ProgressSchema.safeParse(doc).success,
});

describe("the words and numbers", () => {
  test("are the contract's", () => {
    expect(PROGRESS_FORMAT).toBe("nemar.progress.v1");
    expect(PROGRESS_REPORT_SECONDS).toBe(60);
    expect(PROGRESS_MIN_INTERVAL_SECONDS).toBe(50);
    expect(PROGRESS_STALLED_CADENCES).toBe(3);
    expect(PROGRESS_MAX_CHECKPOINTS).toBe(8);
    expect(PROGRESS_MAX_FAILURES).toBe(10);
    expect(PROGRESS_PATH_MAX).toBe(256);
    expect(PROGRESS_MAX_RECORDINGS).toBe(1_000_000);
    expect(PROGRESS_MAX_BYTES).toBe(8192);
    expect(PROGRESS_BODY_MAX_BYTES).toBe(16_384);
  });

  test("the server floor is under the cadence, and a stall is three missed cadences", () => {
    expect(PROGRESS_MIN_INTERVAL_SECONDS).toBeLessThan(PROGRESS_REPORT_SECONDS);
    expect(PROGRESS_STALLED_CADENCES * PROGRESS_REPORT_SECONDS).toBe(180);
  });

  test("the index re-exports the module", () => {
    expect(contractIndex.ProgressSchema).toBe(ProgressSchema);
    expect(contractIndex.PROGRESS_FORMAT).toBe(PROGRESS_FORMAT);
  });
});

describe("the object", () => {
  test("a valid object passes both", () => {
    expect(both(valid())).toEqual({ ajv: true, zod: true });
  });

  test("is closed at every level", () => {
    const top = { ...valid(), extra: 1 };
    const inCounts = valid();
    (inCounts.counts.import as Record<string, number>).remaining = 1;
    const inFailure = valid();
    (inFailure.failures[0] as Record<string, unknown>).detail = "x";
    for (const doc of [top, inCounts, inFailure])
      expect(both(doc)).toEqual({ ajv: false, zod: false });
  });

  test("the response is open", () => {
    expect(ProgressReportResponseSchema.safeParse({ ok: true, extra: 1 }).success).toBe(true);
    expect(ajvResponse({ ok: true, extra: 1 })).toBe(true);
    expect(ProgressReportResponseSchema.safeParse({ ok: false }).success).toBe(false);
    expect(ajvResponse({ ok: false })).toBe(false);
  });

  test("the largest object the schema accepts serializes within PROGRESS_MAX_BYTES", () => {
    const name = (i: number) => `c${String(i).padStart(31, "0")}`.slice(0, 32);
    const big: Record<string, unknown> = {
      format: PROGRESS_FORMAT,
      checkpoint: name(0),
      counts: Object.fromEntries(
        Array.from({ length: PROGRESS_MAX_CHECKPOINTS }, (_, i) => [
          name(i),
          counts(
            PROGRESS_MAX_RECORDINGS,
            PROGRESS_MAX_RECORDINGS,
            PROGRESS_MAX_RECORDINGS,
            PROGRESS_MAX_RECORDINGS,
          ),
        ]),
      ),
      failures: Array.from({ length: PROGRESS_MAX_FAILURES }, () => ({
        path: "a".repeat(PROGRESS_PATH_MAX),
        code: `a${"b".repeat(63)}`,
        step: `A${"b".repeat(63)}`,
        checkpoint: name(0),
      })),
    };
    expect(both(big)).toEqual({ ajv: true, zod: true });
    expect(new TextEncoder().encode(JSON.stringify(big)).length).toBeLessThanOrEqual(
      PROGRESS_MAX_BYTES,
    );
  });
});

describe("agreement corpus: Ajv and zod give the named verdict", () => {
  const DROP = Symbol("drop");
  /** A copy of the valid object with the value at `path` replaced, or removed with DROP. */
  const at = (path: (string | number)[], value: unknown): unknown => {
    const doc = structuredClone(valid()) as unknown as Record<string | number, unknown>;
    let node = doc;
    for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
    const last = path[path.length - 1];
    if (value === DROP) {
      if (Array.isArray(node)) node.splice(Number(last), 1);
      else node = Object.fromEntries(Object.entries(node).filter(([k]) => k !== last));
      return path.length === 1 ? node : setParent(doc, path.slice(0, -1), node);
    }
    node[last] = value;
    return doc;
  };
  const setParent = (
    doc: Record<string | number, unknown>,
    path: (string | number)[],
    value: unknown,
  ) => {
    let node = doc;
    for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
    node[path[path.length - 1]] = value;
    return doc;
  };
  const nCounts = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, counts(0, 0, 0, 1)]));
  const nFailures = (n: number) => Array.from({ length: n }, () => ({ ...valid().failures[0] }));
  const f0 = (key: string, value: unknown) => at(["failures", 0, key], value);
  const cases: Array<[string, unknown, boolean]> = [
    ["valid", valid(), true],
    ["format missing", at(["format"], DROP), false],
    ["format v2", at(["format"], "nemar.progress.v2"), false],
    ["checkpoint missing", at(["checkpoint"], DROP), false],
    ["checkpoint capitalized", at(["checkpoint"], "Import"), false],
    ["counts missing", at(["counts"], DROP), false],
    ["counts empty", at(["counts"], {}), false],
    ["counts at 8", at(["counts"], nCounts(8)), true],
    ["counts at 9", at(["counts"], nCounts(9)), false],
    ["count key not a name", at(["counts", "Bad-Name"], counts(0, 0, 0, 1)), false],
    ["count negative", at(["counts", "import", "passed"], -1), false],
    ["count fractional", at(["counts", "import", "passed"], 1.5), false],
    ["count at max", at(["counts", "import", "total"], PROGRESS_MAX_RECORDINGS), true],
    ["count past max", at(["counts", "import", "total"], PROGRESS_MAX_RECORDINGS + 1), false],
    ["count a string", at(["counts", "import", "total"], "12"), false],
    ["count key missing", at(["counts", "import", "skipped"], DROP), false],
    ["failures missing", at(["failures"], DROP), false],
    ["failures empty", at(["failures"], []), true],
    ["failures at 10", at(["failures"], nFailures(10)), true],
    ["failures at 11", at(["failures"], nFailures(11)), false],
    ["path at 256", f0("path", "a".repeat(256)), true],
    ["path at 257", f0("path", "a".repeat(257)), false],
    ["path empty", f0("path", ""), false],
    ["path absolute", f0("path", "/sub-01/a.set"), false],
    ["path with ..", f0("path", "sub-01/../a.set"), false],
    ["path ending in ..", f0("path", "sub-01/.."), false],
    ["path with a scheme", f0("path", "https://x/a.set"), false],
    ["path with a backslash", f0("path", "sub-01\\a.set"), false],
    ["path not ASCII", f0("path", "sub-01/\u00e9.set"), false],
    ["path with a newline", f0("path", "a\nb"), false],
    ["path with a trailing newline", f0("path", "a.set\n"), false],
    ["path with dots in a name", f0("path", "a/..b/c...set"), true],
    ["code capitalized", f0("code", "Load_failed"), false],
    ["code missing", f0("code", DROP), false],
    ["step null", f0("step", null), true],
    ["step missing", f0("step", DROP), false],
    ["step with a space", f0("step", "bad step"), false],
    ["failure checkpoint not a name", f0("checkpoint", "9x"), false],
  ];
  test.each(cases)("%s", (_label, doc, verdict) => {
    expect(both(doc)).toEqual({ ajv: verdict, zod: verdict });
  });

  test("the corpus helper really removes and replaces", () => {
    expect(Object.hasOwn(at(["format"], DROP) as object, "format")).toBe(false);
    const noSkipped = at(["counts", "import", "skipped"], DROP) as Doc;
    expect(Object.hasOwn(noSkipped.counts.import, "skipped")).toBe(false);
    expect((f0("code", DROP) as Doc).failures[0]).not.toHaveProperty("code");
  });
});

describe("agreement with neuroschema 0.5.0", () => {
  const nscCounts = compileNeuroschemaValidator("nsc:/definitions/checkpointCounts.schema.json");
  const nscTypes = (def: string) =>
    compileNeuroschemaValidator(`nsc:/definitions/processingTypes.schema.json#/$defs/${def}`);

  test("every counts object the contract accepts, neuroschema checkpointCounts accepts, with the same keys", () => {
    for (const c of [
      counts(0, 0, 0, 0),
      counts(1, 2, 3, 6),
      counts(PROGRESS_MAX_RECORDINGS, 0, 0, PROGRESS_MAX_RECORDINGS),
    ]) {
      expect(nscCounts(c)).toBe(true);
    }
    const def = progressSchema.$defs.CheckpointCounts;
    const bundled = compileNeuroschemaValidator("nsc:/definitions/checkpointCounts.schema.json")
      .schema as { required: string[]; properties: Record<string, unknown> };
    expect([...def.required].sort()).toEqual([...bundled.required].sort());
    expect(Object.keys(def.properties).sort()).toEqual(Object.keys(bundled.properties).sort());
  });

  test.each([
    [
      "checkpointName",
      PROGRESS_CHECKPOINT_RE,
      [
        "import",
        "ica",
        "a",
        `a${"b".repeat(31)}`,
        "Import",
        "9a",
        "",
        `a${"b".repeat(32)}`,
        "a-b",
        "a\n",
      ],
    ],
    [
      "failureCode",
      PROGRESS_FAILURE_CODE_RE,
      ["load_failed", "a", `a${"b".repeat(63)}`, `a${"b".repeat(64)}`, "Load", "a-b", "_a", "a\n"],
    ],
    [
      "stepId",
      PROGRESS_STEP_RE,
      [
        "load",
        "line_noise_50",
        "A.b-c",
        `a${"b".repeat(63)}`,
        `a${"b".repeat(64)}`,
        "-a",
        "a b",
        "a\n",
      ],
    ],
  ] as const)("the %s regex agrees with neuroschema processingTypes", (def, re, corpus) => {
    const nsc = nscTypes(def);
    for (const s of corpus) expect(re.test(s), JSON.stringify(s)).toBe(nsc(s) as boolean);
  });

  test("every path the contract accepts, neuroschema relativeLocation accepts", () => {
    const nsc = nscTypes("relativeLocation");
    for (const s of ["a.set", "sub-01/eeg/a.set", "a/..b", "./a", "a//b", "a b.set", "~x/y"]) {
      expect(PROGRESS_PATH_RE.test(s), s).toBe(true);
      expect(nsc(s), s).toBe(true);
    }
  });
});
