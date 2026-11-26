/**
 * The backend's `dataQuality` checks (ADR 0137 decision 8 and its amendment, epic #2324 phase B1, #2341):
 * the zod mirrors in `backend/src/services/quality-documents.ts` against Ajv on the vendored neuroschema
 * 0.6.0 bundle, the writer's rules run again, `nemar.record-checks.v1` against its vectors, and the two
 * projections over nemar-ica's real product, copied from nemar-process P7 (`test/fixtures/quality/
 * ica-views`, held to its SHA256SUMS.json).
 *
 * What is pinned, each case by the mutation it names:
 *  - every pattern the mirror checks is the bundle's own text;
 *  - zod and Ajv agree on every document of the corpora below (a mirror that accepts what the schema
 *    refuses, or refuses what it accepts, fails);
 *  - the record checks reproduce all nine vectors;
 *  - the dataset summary of the fixture is kept, and each writer rule, identity, digest, count and metric
 *    name refusal has its own case;
 *  - a recording's entry is the recipe's metrics (`extensions.nemar.metrics`) and each plugin step's
 *    `qualityMetrics`, never `summaryMetrics`; its views skipped may carry nemar-process's own words; it is
 *    refused for each word of `RECORD_ENTRY_REFUSALS`.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DatasetQualityDocumentSchema,
  QUALITY_PATTERNS,
  type QualityDocumentContext,
  RecordRecipeResultsSchema,
  checkDatasetQualityDocument,
  recordQualityEntry,
  writerRuleBroken,
} from "../backend/src/services/quality-documents";
import { wideEdgesDocument } from "../backend/test/helpers/quality-fixture";
import { findRecipe, recipeQualityPlugins } from "../shared/compute-recipes";
import {
  DATA_QUALITY_MAX_BYTES,
  RECORD_CHECK_WORDS,
  VIEWS_SKIPPED_NEMAR_PROCESS_WORDS,
  VIEWS_SKIPPED_NEUROSCHEMA_WORDS,
  recordChecks,
} from "../shared/contract/data-quality";
import { compileNeuroschemaValidator, formatAjvErrors } from "./contract/neuroschema-validator";

// --- The fixture ---------------------------------------------------------------------------------------

const FIXTURE = join(import.meta.dir, "fixtures/quality/ica-views");
const PRODUCT = join(FIXTURE, "product");
const RECORDING_RECORD = join(
  PRODUCT,
  "sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_desc-nemarica_signalJourney.json",
);
const bytesOf = (file: string): Uint8Array => new Uint8Array(readFileSync(file));
const jsonOf = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const DOCUMENT = jsonOf(join(PRODUCT, "desc-nemarica_dataquality.json"));
const DATASET_RECORD = bytesOf(join(PRODUCT, "desc-nemarica_signalJourney.json"));
// biome-ignore lint/suspicious/noExplicitAny: documents are mutated field by field below
type Loose = Record<string, any>;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const ICA = findRecipe("nemar-ica") as NonNullable<ReturnType<typeof findRecipe>>;
const FLOOR = findRecipe("nemar-floor") as NonNullable<ReturnType<typeof findRecipe>>;

/** What the fixture's run is checked against: its stamp, its dataset record and its recordings table. */
async function fixtureContext(): Promise<QualityDocumentContext> {
  return {
    stamp: { recipe: "nemar-ica", recipeVersion: ICA.version, version: "v1.0.0", input: "bids" },
    plugins: recipeQualityPlugins(ICA),
    recordSha256: await sha256Hex(DATASET_RECORD),
    // desc-nemarica_recordings.tsv: one recording, succeeded.
    counts: { passed: 1, failed: 0, skipped: 0, total: 1 },
  };
}

/** Git run against a nemar-process checkout: never fetching a missing object, and bounded in time. */
function git(dir: string, args: string[], input?: string) {
  return spawnSync("git", ["-C", dir, ...args], {
    input,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20_000,
    // A sparse CI checkout is a partial clone: without this, asking for an object it lacks fetches it
    // from GitHub, one round trip per file (the 5-second timeout of #2375's first CI run).
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  });
}

/**
 * The pinned nemar-process files the fixture copies, read from a checkout in one `git cat-file --batch`,
 * or why they cannot be: no `NEMAR_PROCESS_DIR`, a checkout that does not hold the pinned commit (CI's
 * `dev` checkout), or one that lacks a file's object (a blob-less partial clone).
 */
function pinnedCopies(
  dir: string | undefined,
  commit: string,
  files: readonly { source: string }[],
): { ok: true; blobs: Map<string, Buffer> } | { ok: false; reason: string } {
  if (dir === undefined || dir === "") return { ok: false, reason: "NEMAR_PROCESS_DIR is not set" };
  if (!existsSync(dir)) return { ok: false, reason: `NEMAR_PROCESS_DIR ${dir} does not exist` };
  if (git(dir, ["cat-file", "-e", `${commit}^{commit}`]).status !== 0) {
    return { ok: false, reason: `the checkout does not hold ${commit.slice(0, 8)}` };
  }
  const specs = files.map((f) => `${commit}:${f.source}`);
  const read = git(dir, ["cat-file", "--batch"], `${specs.join("\n")}\n`);
  if (read.status !== 0 || read.stdout === null) {
    return {
      ok: false,
      reason: `git cat-file --batch failed (${read.error?.message ?? read.status})`,
    };
  }
  const out = read.stdout as Buffer;
  const blobs = new Map<string, Buffer>();
  let at = 0;
  for (const [i, spec] of specs.entries()) {
    const eol = out.indexOf(0x0a, at);
    const header = out.subarray(at, eol).toString("utf8");
    if (header.endsWith(" missing")) {
      return { ok: false, reason: `the checkout lacks ${spec.slice(commit.length + 1)}` };
    }
    const size = Number(header.split(" ")[2]);
    blobs.set(files[i].source, out.subarray(eol + 1, eol + 1 + size));
    at = eol + 1 + size + 1;
  }
  return { ok: true, blobs };
}

describe("the fixture is nemar-process's product, byte for byte", () => {
  const sums = jsonOf(join(FIXTURE, "SHA256SUMS.json")) as {
    source_commit: string;
    files: { path: string; source: string; size: number; sha256: string }[];
  };

  test("every copy matches SHA256SUMS.json, and SHA256SUMS.json lists every file (MUTATION: flip one byte)", async () => {
    const onDisk = (readdirSync(FIXTURE, { recursive: true, encoding: "utf8" }) as string[])
      .filter((p) => p !== "SHA256SUMS.json" && statSync(join(FIXTURE, p)).isFile())
      .sort();
    expect(sums.files.map((f) => f.path).sort()).toEqual(onDisk);
    for (const f of sums.files) {
      const bytes = bytesOf(join(FIXTURE, f.path));
      expect(bytes.byteLength, f.path).toBe(f.size);
      expect(await sha256Hex(bytes), f.path).toBe(f.sha256);
    }
  });

  const held = pinnedCopies(process.env.NEMAR_PROCESS_DIR, sums.source_commit, sums.files);
  // A skipped test's title is not printed by every reporter: the reason is logged as well.
  if (!held.ok)
    console.log(`[quality fixture] byte comparison with nemar-process skipped: ${held.reason}`);
  test.skipIf(!held.ok)(
    `each copy is the nemar-process file at the pinned commit${held.ok ? "" : ` (skipped: ${held.reason})`}`,
    () => {
      if (!held.ok) return;
      for (const f of sums.files) {
        const pinned = held.blobs.get(f.source);
        expect(pinned, f.source).toBeDefined();
        expect(
          Buffer.compare(pinned as Buffer, Buffer.from(bytesOf(join(FIXTURE, f.path)))),
          f.path,
        ).toBe(0);
      }
    },
  );
});

// --- Patterns ------------------------------------------------------------------------------------------

describe("the mirror's patterns are the bundle's", () => {
  const bundle = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../shared/contract/neuroschema/dataset.bundle.json"),
      "utf8",
    ),
  ) as { schemas: Loose[] };
  const types = bundle.schemas.find((s) => s.$id === "nsc:/definitions/processingTypes.schema.json")
    ?.$defs as Loose;
  const expected: Record<keyof typeof QUALITY_PATTERNS, string> = {
    recipeId: types.recipeId.pattern,
    version: types.version.pattern,
    sha256: types.sha256.pattern,
    failureCode: types.failureCode.pattern,
    metricName: types.metricName.pattern,
    relativeLocation: types.relativeLocation.pattern,
    viewKey: types.viewKey.pattern,
    kindName: types.kindName.pattern,
    pluginName: types.plugin.properties.name.pattern,
  };
  for (const [name, pattern] of Object.entries(expected)) {
    test(`${name} (MUTATION: change one character of it)`, () => {
      const mine = QUALITY_PATTERNS[name as keyof typeof QUALITY_PATTERNS];
      // Ajv compiles a pattern with the `u` flag; `source` escapes `/` and a line break alike for both.
      expect(mine.flags).toBe("u");
      expect(mine.source).toBe(new RegExp(pattern, "u").source);
    });
  }
});

// --- Record checks -------------------------------------------------------------------------------------

describe("nemar.record-checks.v1 vectors", () => {
  const vectors = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../shared/contract/neuroschema/views/vectors/record-checks.v1.json"),
      "utf8",
    ),
  ) as {
    format: string;
    cases: { name: string; recipe: string; entry: unknown; expected: unknown[] }[];
  };

  test("nine cases of the format, every word among them", () => {
    expect(vectors.format).toBe("nemar.record-checks.v1");
    expect(vectors.cases).toHaveLength(9);
    const words = new Set(vectors.cases.flatMap((c) => c.expected.map((f) => (f as Loose).word)));
    expect([...words].sort()).toEqual([...RECORD_CHECK_WORDS].sort());
  });

  for (const c of vectors.cases) {
    test(`case ${c.name} (MUTATION: drop a rule, or check a plugin view's source)`, () => {
      expect(recordChecks(c.recipe, c.entry)).toEqual(c.expected as never);
    });
  }
});

// --- The dataset summary -------------------------------------------------------------------------------

const validateDocument = compileNeuroschemaValidator("nsc:/extensions/dataQuality.schema.json");

/** The fixture document with one change made by `edit` to its nemar-ica entry (or the whole document). */
function edited(edit: (doc: Loose, entry: Loose) => void): Loose {
  const doc = clone(DOCUMENT) as Loose;
  edit(doc, doc.recipes["nemar-ica"]);
  return doc;
}

const DOCUMENT_CORPUS: [string, Loose][] = [
  ["the fixture", edited(() => {})],
  [
    "a member beside level and recipes",
    edited((d) => {
      d.views = [];
    }),
  ],
  [
    "a record-level document",
    edited((d) => {
      d.level = "record";
    }),
  ],
  ["no level", edited((d) => Reflect.deleteProperty(d, "level"))],
  [
    "a recipe id with a capital",
    edited((d) => {
      d.recipes = { "Nemar-ica": d.recipes["nemar-ica"] };
    }),
  ],
  [
    "two recipes",
    edited((d) => {
      d.recipes["nemar-floor"] = clone(d.recipes["nemar-ica"]);
    }),
  ],
  [
    "an unknown member of an entry",
    edited((_, e) => {
      e.views = [];
    }),
  ],
  ["no unit", edited((_, e) => Reflect.deleteProperty(e.distributions.icaRank, "unit"))],
  [
    "a unit of 33 characters",
    edited((_, e) => {
      e.distributions.icaRank.unit = "u".repeat(33);
    }),
  ],
  [
    "a unit of 32 astral code points (64 UTF-16 units)",
    edited((_, e) => {
      e.distributions.icaRank.unit = "\u{1d707}".repeat(32);
    }),
  ],
  [
    "an empty description",
    edited((_, e) => {
      e.distributions.icaRank.description = "";
    }),
  ],
  [
    "no description",
    edited((_, e) => Reflect.deleteProperty(e.distributions.icaRank, "description")),
  ],
  [
    "a negative count",
    edited((_, e) => {
      e.counts.failed = -1;
    }),
  ],
  [
    "a count of 2^53",
    edited((_, e) => {
      e.counts.total = 2 ** 53;
    }),
  ],
  [
    "a count that is not an integer",
    edited((_, e) => {
      e.counts.total = 1.5;
    }),
  ],
  [
    "a null dataset version",
    edited((_, e) => {
      e.dataset_version = null;
    }),
  ],
  [
    "a zarr input of the archive",
    edited((_, e) => {
      e.input_kind = "zarr";
    }),
  ],
  [
    "a zarr input of the serving copy",
    edited((_, e) => Object.assign(e, { input_kind: "zarr", profile: "serving" })),
  ],
  [
    "a digest in capitals",
    edited((_, e) => {
      e.record_sha256 = e.record_sha256.toUpperCase();
    }),
  ],
  [
    "a metric name with two colons",
    edited((_, e) => {
      e.observed_range["a:b:c"] = { min: 1, max: 2 };
    }),
  ],
  [
    "a metric name of 129 characters",
    edited((_, e) => {
      e.observed_range[`m${"x".repeat(128)}`] = { min: 1, max: 2 };
    }),
  ],
  [
    "an open range",
    edited((_, e) => {
      e.observed_range.icaRank = { min: null, max: null };
    }),
  ],
  [
    "a range with a third member",
    edited((_, e) => {
      e.observed_range.icaRank.mean = 1;
    }),
  ],
  [
    "a histogram without missing",
    edited((_, e) => Reflect.deleteProperty(e.distributions.icaRank.histogram, "missing")),
  ],
  [
    "a histogram member more",
    edited((_, e) => {
      e.distributions.icaRank.histogram.bins = 8;
    }),
  ],
  [
    "one edge",
    edited((_, e) => {
      e.distributions.icaRank.histogram.edges = [0];
    }),
  ],
  [
    "no counts",
    edited((_, e) => {
      e.distributions.icaRank.histogram.counts = [];
    }),
  ],
  [
    "a string median",
    edited((_, e) => {
      e.distributions.icaRank.median = "18";
    }),
  ],
  [
    "a listed recording",
    edited((_, e) => {
      e.not_processed = [{ path: "sub-01/eeg/a.edf", status: "failed", code: "load_failed" }];
    }),
  ],
  [
    "a listed path with ..",
    edited((_, e) => {
      e.not_processed = [{ path: "sub-01/../a.edf", status: "failed", code: "x" }];
    }),
  ],
  [
    "a listed path with %",
    edited((_, e) => {
      e.not_processed = [{ path: "sub-01/a%20.edf", status: "failed", code: "x" }];
    }),
  ],
  [
    "a listed path with a bidi control",
    edited((_, e) => {
      e.not_processed = [{ path: "sub-01/a\u202e.edf", status: "failed", code: "x" }];
    }),
  ],
  [
    "a listed non-ASCII path",
    edited((_, e) => {
      e.not_processed = [{ path: "sub-01/\u00e9.edf", status: "failed", code: "x" }];
    }),
  ],
  [
    "a listed recording that succeeded",
    edited((_, e) => {
      e.not_processed = [{ path: "a.edf", status: "succeeded", code: "x" }];
    }),
  ],
  [
    "a listed code in capitals",
    edited((_, e) => {
      e.not_processed = [{ path: "a.edf", status: "failed", code: "X" }];
    }),
  ],
  [
    "201 listed recordings",
    edited((_, e) => {
      e.not_processed = Array.from({ length: 201 }, (_, i) => ({
        path: `r${i}.edf`,
        status: "failed",
        code: "x",
      }));
    }),
  ],
];

describe("the dataset document mirror agrees with Ajv", () => {
  for (const [name, doc] of DOCUMENT_CORPUS) {
    test(`${name} (MUTATION: open the root, drop a cap, or count UTF-16 units)`, () => {
      const ajv = validateDocument(doc);
      const zod = DatasetQualityDocumentSchema.safeParse(doc).success;
      expect(zod, ajv ? "zod refused what Ajv accepts" : formatAjvErrors(validateDocument)).toBe(
        ajv,
      );
    });
  }

  test("the corpus has documents on both sides", () => {
    const verdicts = DOCUMENT_CORPUS.map(([, d]) => validateDocument(d));
    expect(verdicts.filter(Boolean).length).toBeGreaterThanOrEqual(8);
    expect(verdicts.filter((v) => !v).length).toBeGreaterThanOrEqual(20);
  });
});

describe("the fixture's dataset summary", () => {
  test("is valid and keeps every writer rule", () => {
    if (!validateDocument(DOCUMENT)) throw new Error(formatAjvErrors(validateDocument));
    const parsed = DatasetQualityDocumentSchema.parse(DOCUMENT);
    expect(writerRuleBroken(parsed.recipes["nemar-ica"], false)).toBeNull();
  });

  test("nemar-quality ran (P7): percentBrainComponents summarizes one recording, as the record reports it", () => {
    const entry = (DOCUMENT as Loose).recipes["nemar-ica"];
    const brain = entry.distributions["nemar-quality:percentBrainComponents"];
    expect(brain.n).toBe(1);
    const record = jsonOf(RECORDING_RECORD) as Loose;
    const step = record.processingSteps.find((s: Loose) => s.stepId === "nemar-quality");
    expect(brain.min).toBe(step.qualityMetrics["nemar-quality:percentBrainComponents"].value);
  });

  test("lineNoiseBeforeDb is the number extensions.nemar.metrics holds, not summaryMetrics' table", () => {
    const entry = (DOCUMENT as Loose).recipes["nemar-ica"];
    const record = jsonOf(RECORDING_RECORD) as Loose;
    expect(entry.distributions.lineNoiseBeforeDb.min).toBe(
      record.extensions.nemar.metrics.lineNoiseBeforeDb.value,
    );
    expect(typeof record.summaryMetrics.lineNoiseBeforeDb).toBe("object");
  });
});

describe("the writer's rules, run again", () => {
  const ruleOf = (edit: (e: Loose) => void, unsafe = false) => {
    const doc = edited((_, e) => edit(e));
    const parsed = DatasetQualityDocumentSchema.safeParse(doc);
    if (!parsed.success) throw new Error("the case must pass the schema");
    return writerRuleBroken(parsed.data.recipes["nemar-ica"], unsafe);
  };
  const rank = (e: Loose) => e.distributions.icaRank;

  test("counts add up to the total (MUTATION: drop the rule)", () => {
    expect(
      ruleOf((e) => {
        e.counts.total = 2;
      }),
    ).toBe("counts_unbalanced");
  });
  test("the listed and the left out are the failed and the skipped (MUTATION: drop the rule)", () => {
    expect(
      ruleOf((e) => {
        e.not_processed_truncated = 1;
      }),
    ).toBe("listing_mismatch");
    expect(
      ruleOf((e) => {
        e.counts = { passed: 0, failed: 1, skipped: 0, total: 1 };
      }),
    ).toBe("listing_mismatch");
  });
  test("n is the bins, the underflow and the overflow (MUTATION: count missing in n, or drop the rule)", () => {
    expect(
      ruleOf((e) => {
        rank(e).histogram.overflow = 1;
      }),
    ).toBe("distribution_invalid");
    expect(
      ruleOf((e) => {
        rank(e).histogram.missing = 3;
      }),
    ).toBeNull();
    expect(
      ruleOf((e) => {
        rank(e).histogram.underflow = 1;
        rank(e).n = 2;
      }),
    ).toBeNull();
  });
  test("one count fewer than the edges, and edges that strictly rise", () => {
    expect(ruleOf((e) => rank(e).histogram.counts.push(0))).toBe("distribution_invalid");
    expect(
      ruleOf((e) => {
        rank(e).histogram.edges[1] = 0;
      }),
    ).toBe("distribution_invalid");
  });
  test("min, median and max are null exactly when n is 0, and ordered otherwise", () => {
    expect(
      ruleOf((e) => {
        rank(e).median = null;
      }),
    ).toBe("distribution_invalid");
    expect(
      ruleOf((e) => {
        rank(e).median = 19;
      }),
    ).toBe("distribution_invalid");
    expect(
      ruleOf((e) => {
        Object.assign(rank(e), { n: 0, min: 18, median: null, max: null });
        rank(e).histogram.counts = rank(e).histogram.counts.map(() => 0);
      }),
    ).toBe("distribution_invalid");
    expect(
      ruleOf((e) => {
        Object.assign(rank(e), { n: 0, min: null, median: null, max: null });
        rank(e).histogram.counts = rank(e).histogram.counts.map(() => 0);
        e.observed_range.icaRank = { min: null, max: null };
      }),
    ).toBeNull();
  });
  test("observed_range is each distribution's min and max, no more and no fewer (MUTATION: drop the rule)", () => {
    expect(
      ruleOf((e) => {
        e.observed_range.icaRank.max = 19;
      }),
    ).toBe("observed_range_mismatch");
    expect(ruleOf((e) => Reflect.deleteProperty(e.observed_range, "icaRank"))).toBe(
      "observed_range_mismatch",
    );
    expect(
      ruleOf((e) => {
        e.observed_range.extra = { min: 1, max: 1 };
      }),
    ).toBe("observed_range_mismatch");
  });
  test("an integer literal beyond 2^53 - 1 anywhere (MUTATION: ignore the reader's flag)", () => {
    expect(ruleOf(() => {}, true)).toBe("integer_unsafe");
  });
});

describe("checkDatasetQualityDocument, against the fixture's run", () => {
  test("keeps the fixture's entry, member for member", async () => {
    const check = checkDatasetQualityDocument(
      bytesOf(join(PRODUCT, "desc-nemarica_dataquality.json")),
      await fixtureContext(),
    );
    if (!check.ok) throw new Error(check.reason);
    expect(JSON.parse(check.entryText)).toEqual((DOCUMENT as Loose).recipes["nemar-ica"]);
    expect(check.entryText).toBe(JSON.stringify((DOCUMENT as Loose).recipes["nemar-ica"]));
  });

  const refusal = async (bytes: Uint8Array, over: Partial<QualityDocumentContext> = {}) => {
    const check = checkDatasetQualityDocument(bytes, { ...(await fixtureContext()), ...over });
    return check.ok ? "kept" : check.reason;
  };

  test("a document over 65,536 bytes (MUTATION: drop the size check)", async () => {
    const big = new Uint8Array(DATA_QUALITY_MAX_BYTES + 1).fill(0x20);
    expect(await refusal(big)).toBe("document_too_large");
  });

  test("text that is not UTF-8 I-JSON: a byte order mark, a hidden duplicate, a bad byte", async () => {
    const text = readFileSync(join(PRODUCT, "desc-nemarica_dataquality.json"), "utf8");
    const enc = new TextEncoder();
    expect(await refusal(enc.encode(`\ufeff${text}`))).toBe("document_unreadable");
    // A second `level`, escaped: JSON.parse would keep the last one silently.
    expect(
      await refusal(enc.encode(text.replace('"level"', '"\\u006cevel": "record", "level"'))),
    ).toBe("document_unreadable");
    expect(await refusal(new Uint8Array([0x7b, 0xff, 0x7d]))).toBe("document_unreadable");
  });

  test("a document the schema refuses", async () => {
    expect(
      await refusal(
        encode(
          edited((d) => {
            d.extra = 1;
          }),
        ),
      ),
    ).toBe("document_invalid");
  });

  test("an entry that is not the stamp's recipe alone (MUTATION: take the first entry)", async () => {
    expect(
      await refusal(
        encode(
          edited((d) => {
            d.recipes["nemar-floor"] = clone(d.recipes["nemar-ica"]);
          }),
        ),
      ),
    ).toBe("recipe_mismatch");
    const ctx = await fixtureContext();
    expect(
      await refusal(encode(DOCUMENT), { stamp: { ...ctx.stamp, recipe: "nemar-floor" } }),
    ).toBe("recipe_mismatch");
  });

  test("a writer rule broken", async () => {
    expect(
      await refusal(
        encode(
          edited((_, e) => {
            e.counts.total = 2;
          }),
        ),
      ),
    ).toBe("counts_unbalanced");
    const text = readFileSync(join(PRODUCT, "desc-nemarica_dataquality.json"), "utf8");
    // An integer literal past 2^53 - 1 where the schema has a number (icaIterations' last edge, 4000), so
    // only the writer rule sees it: the edges still rise and no count moves.
    const unsafe = text.replace(
      /(\n\s+)4000(\n)/,
      (_, before, after) => `${before}9007199254740993${after}`,
    );
    expect(unsafe).not.toBe(text);
    expect(await refusal(new TextEncoder().encode(unsafe))).toBe("integer_unsafe");
  });

  test("an identity that is not the stamp's (MUTATION: drop any one comparison)", async () => {
    const ctx = await fixtureContext();
    const doc = encode(DOCUMENT);
    expect(await refusal(doc, { stamp: { ...ctx.stamp, recipeVersion: "1.0.0-b3" } })).toBe(
      "identity_mismatch",
    );
    expect(await refusal(doc, { stamp: { ...ctx.stamp, version: "v1.0.1" } })).toBe(
      "identity_mismatch",
    );
    expect(await refusal(doc, { stamp: { ...ctx.stamp, input: "zarr" } })).toBe(
      "identity_mismatch",
    );
    expect(
      await refusal(
        encode(
          edited((_, e) => {
            e.dataset_version = null;
          }),
        ),
      ),
    ).toBe("identity_mismatch");
  });

  test("a digest that is not the dataset record's (MUTATION: skip the digest check)", async () => {
    expect(await refusal(encode(DOCUMENT), { recordSha256: "0".repeat(64) })).toBe(
      "record_digest_mismatch",
    );
  });

  test("counts that are not the recordings table's (MUTATION: drop any one count)", async () => {
    const doc = encode(DOCUMENT);
    for (const counts of [
      { passed: 0, failed: 1, skipped: 0, total: 1 },
      { passed: 1, failed: 0, skipped: 0, total: 2 },
      { passed: 1, failed: 0, skipped: 1, total: 1 },
    ]) {
      expect(await refusal(doc, { counts })).toBe("counts_mismatch");
    }
  });

  test("a metric of a plugin the recipe does not run (MUTATION: accept any prefix)", async () => {
    // nemar-floor runs no plugin: nemar-quality's metric cannot be its own.
    expect(await refusal(encode(DOCUMENT), { plugins: recipeQualityPlugins(FLOOR) })).toBe(
      "metric_unknown_plugin",
    );
    expect(
      await refusal(
        encode(
          edited((_, e) => {
            e.distributions["evil:x"] = clone(e.distributions.icaRank);
            e.observed_range["evil:x"] = clone(e.observed_range.icaRank);
          }),
        ),
      ),
    ).toBe("metric_unknown_plugin");
  });

  test("an entry that outgrows the column, written again, is refused (MUTATION: drop the entry size check)", async () => {
    // The review's construction (#2375): 62,641 bytes as written, every rule kept, edges `1000e17, ...`.
    const bytes = wideEdgesDocument();
    expect(bytes.byteLength).toBe(62_641);
    expect(bytes.byteLength).toBeLessThanOrEqual(DATA_QUALITY_MAX_BYTES);
    const entry = (JSON.parse(new TextDecoder().decode(bytes)) as Loose).recipes["nemar-ica"];
    expect(JSON.stringify(entry).length).toBeGreaterThan(DATA_QUALITY_MAX_BYTES);
    if (!validateDocument(JSON.parse(new TextDecoder().decode(bytes)))) {
      throw new Error(formatAjvErrors(validateDocument));
    }
    expect(await refusal(bytes)).toBe("entry_too_large");
  });

  test("a metric named __proto__ is refused by the schema, never taken as a prototype", async () => {
    const text = readFileSync(join(PRODUCT, "desc-nemarica_dataquality.json"), "utf8");
    const enc = new TextEncoder();
    for (const value of ["7", '{"max": 1, "min": 0}']) {
      const proto = text.replace(
        '"observed_range": {',
        `"observed_range": {"__proto__": ${value},`,
      );
      expect(proto).not.toBe(text);
      expect(await refusal(enc.encode(proto))).toBe("document_invalid");
    }
  });

  test("the recipe's plugins are its quality checkpoint's plugin steps", () => {
    expect(recipeQualityPlugins(ICA)).toEqual(["nemar-quality", "nemar-spectrum"]);
    expect(recipeQualityPlugins(FLOOR)).toEqual([]);
  });
});

// --- One recording's entry -----------------------------------------------------------------------------

const validateRecordEntry = compileNeuroschemaValidator(
  "nsc:/extensions/dataQuality.schema.json#/$defs/recordRecipeResults",
);
const STAMP = {
  recipe: "nemar-ica",
  recipeVersion: ICA.version,
  input: "bids" as const,
  plugins: recipeQualityPlugins(ICA),
};
const RECORD = jsonOf(RECORDING_RECORD) as Loose;

/** The record with one change, as bytes. */
const recordWith = (edit: (r: Loose) => void): Uint8Array => {
  const r = clone(RECORD);
  edit(r);
  return encode(r);
};
const nemarQualityStep = (r: Loose) =>
  r.processingSteps.find((s: Loose) => s.stepId === "nemar-quality");

async function entryOf(bytes: Uint8Array): Promise<Loose> {
  const got = await recordQualityEntry(bytes, STAMP);
  if (!got.ok) throw new Error(`${got.reason} ${JSON.stringify(got.findings ?? [])}`);
  return got.entry;
}
const reasonOf = async (bytes: Uint8Array) => {
  const got = await recordQualityEntry(bytes, STAMP);
  return got.ok ? "projected" : got.reason;
};

describe("recordQualityEntry over the fixture's recording", () => {
  test("an integer literal beyond 2^53 - 1 anywhere in the record is integer_unsafe (MUTATION: ignore the reader's flag; B1 review, left to B2)", async () => {
    const text = readFileSync(RECORDING_RECORD, "utf8");
    expect(text).toContain('"clean_channels.ransac": 5489');
    const enc = new TextEncoder();
    expect(await reasonOf(enc.encode(text))).toBe("projected");
    expect(
      await reasonOf(
        enc.encode(
          text.replace(
            '"clean_channels.ransac": 5489',
            '"clean_channels.ransac": 9007199254740992',
          ),
        ),
      ),
    ).toBe("integer_unsafe");
    // 2^53 - 1 is the cap, and is kept.
    expect(
      await reasonOf(
        enc.encode(
          text.replace(
            '"clean_channels.ransac": 5489',
            '"clean_channels.ransac": 9007199254740991',
          ),
        ),
      ),
    ).toBe("projected");
  });

  test("a plugin view's plugin must be one the recipe version runs at quality (MUTATION: drop the check; B1 review, left to B2)", async () => {
    expect(STAMP.plugins).toEqual(["nemar-quality", "nemar-spectrum"]);
    const spectrum = (r: Loose) =>
      r.extensions.nemar.views.find((v: Loose) => v.key === "spectrum");
    expect(
      await reasonOf(
        recordWith((r) => {
          spectrum(r).source.plugin.name = "nemar-other";
        }),
      ),
    ).toBe("view_unknown_plugin");
    expect(
      await recordQualityEntry(bytesOf(RECORDING_RECORD), { ...STAMP, plugins: ["nemar-quality"] }),
    ).toMatchObject({ ok: false, reason: "view_unknown_plugin" });
    // A recipe's own view is the record checks' to judge, not this rule's.
    const got = await recordQualityEntry(bytesOf(RECORDING_RECORD), STAMP);
    expect(got.ok && got.of).toEqual({
      dataset: RECORD.extensions.nemar.dataset.id,
      recording: RECORD.extensions.nemar.recording.path,
    });
  });

  test("is nemar-process's record_entry: the recipe's metrics, then each plugin step's, the views, the digest", async () => {
    const bytes = bytesOf(RECORDING_RECORD);
    const entry = await entryOf(bytes);
    const nemar = RECORD.extensions.nemar;
    const expected: Loose = {
      recipe_version: nemar.recipe.version,
      input_kind: "bids",
      profile: nemar.mask_grid.profile,
      record_sha256: await sha256Hex(bytes),
      metrics: { ...nemar.metrics, ...nemarQualityStep(RECORD).qualityMetrics },
      views: nemar.views,
    };
    expect(entry).toEqual(expected);
    expect(Object.keys(entry.metrics)).toContain("nemar-quality:percentBrainComponents");
    expect(entry.views.map((v: Loose) => v.key)).toEqual([
      "icmaps",
      "icactivity",
      "midsegment",
      "icclasses",
      "spectrum",
    ]);
    if (!validateRecordEntry(entry)) throw new Error(formatAjvErrors(validateRecordEntry));
    expect(recordChecks("nemar-ica", entry)).toEqual([]);
  });

  test("lineNoiseBeforeDb comes from extensions.nemar.metrics; summaryMetrics is never read (MUTATION: read summaryMetrics)", async () => {
    const entry = await entryOf(
      recordWith((r) => {
        r.summaryMetrics.lineNoiseBeforeDb = 99;
        r.summaryMetrics["nemar-quality:percentBrainComponents"] = 1;
      }),
    );
    expect(entry.metrics.lineNoiseBeforeDb.value).toBe(7.48);
    expect(entry.metrics["nemar-quality:percentBrainComponents"].value).toBe(44.4444);
  });

  test("a plugin that did not run reports nothing (MUTATION: merge every plugin step)", async () => {
    const entry = await entryOf(
      recordWith((r) => {
        r.extensions.nemar.plugins[0].status = "skipped";
      }),
    );
    expect(Object.keys(entry.metrics)).not.toContain("nemar-quality:percentBrainComponents");
  });

  test("views skipped carry neuroschema's words and nemar-process's own (MUTATION: close reason to an enum)", async () => {
    const words = [...VIEWS_SKIPPED_NEUROSCHEMA_WORDS, ...VIEWS_SKIPPED_NEMAR_PROCESS_WORDS];
    const entry = await entryOf(
      recordWith((r) => {
        r.extensions.nemar.views_skipped = words.map((reason, i) => ({
          key: `skipped_${i}`,
          kind: "nemar.lines",
          reason,
        }));
      }),
    );
    expect(entry.views_skipped.map((s: Loose) => s.reason)).toEqual(words);
    if (!validateRecordEntry(entry)) throw new Error(formatAjvErrors(validateRecordEntry));
  });

  test("refusals: unreadable text, another identity, the shape of the record", async () => {
    const text = readFileSync(RECORDING_RECORD, "utf8");
    const enc = new TextEncoder();
    expect(
      await reasonOf(enc.encode(text.replace('"metrics":', '"m\\u0065trics": {}, "metrics":'))),
    ).toBe("record_unreadable");
    expect(
      await reasonOf(
        recordWith((r) => {
          r.extensions.nemar.recipe.version = "1.0.0-b3";
        }),
      ),
    ).toBe("identity_mismatch");
    expect(
      await reasonOf(
        recordWith((r) => {
          r.extensions.nemar.recipe.id = "nemar-floor";
        }),
      ),
    ).toBe("identity_mismatch");
    expect(await reasonOf(recordWith((r) => Reflect.deleteProperty(r.extensions, "nemar")))).toBe(
      "record_shape",
    );
    expect(
      await reasonOf(
        recordWith((r) => {
          r.extensions.nemar.plugins = {};
        }),
      ),
    ).toBe("record_shape");
  });

  test("a recipe metric is bare, a plugin step's carries its plugin's name, a plugin is the recipe's", async () => {
    expect(
      await reasonOf(
        recordWith((r) => {
          r.extensions.nemar.metrics["nemar-quality:x"] = clone(
            nemarQualityStep(r).qualityMetrics["nemar-quality:percentBrainComponents"],
          );
        }),
      ),
    ).toBe("metric_not_bare");
    expect(
      await reasonOf(
        recordWith((r) => {
          const qm = nemarQualityStep(r).qualityMetrics;
          qm.percentBrainComponents = qm["nemar-quality:percentBrainComponents"];
          Reflect.deleteProperty(qm, "nemar-quality:percentBrainComponents");
        }),
      ),
    ).toBe("metric_not_prefixed");
    expect(
      await reasonOf(
        recordWith((r) => {
          const step = nemarQualityStep(r);
          step.stepId = "evil";
          r.extensions.nemar.plugins[0].name = "evil";
          step.qualityMetrics = {
            "evil:x": step.qualityMetrics["nemar-quality:percentBrainComponents"],
          };
        }),
      ),
    ).toBe("metric_unknown_plugin");
  });

  test("an entry the schema refuses: a bare metric credited to a plugin, a serving store in an archive entry", async () => {
    expect(
      await reasonOf(
        recordWith((r) => {
          const m = r.extensions.nemar.metrics.icaRank;
          m.plugin = { name: "nemar-quality", version: "0.1.0" };
          Reflect.deleteProperty(m, "recipe");
        }),
      ),
    ).toBe("entry_invalid");
    const serving = recordWith((r) => {
      r.extensions.nemar.views[1].inputs[1].store.profile = "serving";
    });
    expect(await reasonOf(serving)).toBe("entry_invalid");
  });

  test("a metric named __proto__, a number or an object, is refused before it is copied (MUTATION: copy before checking the name)", async () => {
    const compact = JSON.stringify(RECORD);
    const enc = new TextEncoder();
    expect(compact.split('"metrics":{').length).toBe(2);
    for (const value of ["7", JSON.stringify(RECORD.extensions.nemar.metrics.icaRank)]) {
      const own = compact.replace('"metrics":{', `"metrics":{"__proto__":${value},`);
      expect(await reasonOf(enc.encode(own))).toBe("entry_invalid");
    }
    // In a plugin step's qualityMetrics too.
    const step = '"qualityMetrics":{"nemar-quality:percentBrainComponents"';
    expect(compact.split(step).length).toBe(2);
    const reported = compact.replace(
      step,
      `"qualityMetrics":{"__proto__":${JSON.stringify(RECORD.extensions.nemar.metrics.icaRank)},"nemar-quality:percentBrainComponents"`,
    );
    expect(await reasonOf(enc.encode(reported))).toBe("entry_invalid");
  });

  test("record checks refuse an entry (MUTATION: skip the record checks)", async () => {
    const credited = await recordQualityEntry(
      recordWith((r) => {
        nemarQualityStep(r).qualityMetrics["nemar-quality:percentBrainComponents"].plugin.name =
          "nemar-spectrum";
      }),
      STAMP,
    );
    expect(credited).toEqual({
      ok: false,
      reason: "record_checks",
      findings: [
        { word: "metric_producer_mismatch", at: "metrics/nemar-quality:percentBrainComponents" },
      ],
    });
    const repeated = await recordQualityEntry(
      recordWith((r) => {
        r.extensions.nemar.views[4].key = "icmaps";
        r.extensions.nemar.views[2].source = {
          recipe: { name: "nemar-floor", version: "1.0.0-b2" },
        };
      }),
      STAMP,
    );
    expect(repeated).toMatchObject({
      ok: false,
      reason: "record_checks",
      findings: [
        { word: "view_source_mismatch", at: "views/2/source" },
        { word: "view_key_repeated", at: "views/4/key" },
      ],
    });
  });
});

describe("the record entry mirror agrees with Ajv (identity, metrics, views skipped)", () => {
  const BASE = (async () => entryOf(bytesOf(RECORDING_RECORD)))();
  const corpus: [string, (e: Loose) => void][] = [
    ["the fixture's entry", () => {}],
    [
      "a member more",
      (e) => {
        e.extra = 1;
      },
    ],
    [
      "a zarr input of the archive",
      (e) => {
        e.input_kind = "zarr";
      },
    ],
    ["no views", (e) => Reflect.deleteProperty(e, "views")],
    ["no views skipped", (e) => Reflect.deleteProperty(e, "views_skipped")],
    [
      "33 views",
      (e) => {
        e.views = Array.from({ length: 33 }, () => e.views[0]);
      },
    ],
    [
      "a metric with both producers",
      (e) => {
        e.metrics.icaRank.plugin = { name: "p", version: "1" };
      },
    ],
    ["a metric with no producer", (e) => Reflect.deleteProperty(e.metrics.icaRank, "recipe")],
    [
      "a bare metric of a plugin",
      (e) => {
        e.metrics.icaRank.plugin = { name: "p", version: "1" };
        Reflect.deleteProperty(e.metrics.icaRank, "recipe");
      },
    ],
    [
      "a prefixed metric of a recipe",
      (e) => {
        e.metrics["p:x"] = clone(e.metrics.icaRank);
      },
    ],
    [
      "a null value",
      (e) => {
        e.metrics.icaRank.value = null;
      },
    ],
    [
      "an open bound",
      (e) => {
        e.metrics.icaRank.bounds = { min: 0, max: null };
      },
    ],
    [
      "a unit of 33",
      (e) => {
        e.metrics.icaRank.unit = "u".repeat(33);
      },
    ],
    [
      "a description of 501",
      (e) => {
        e.metrics.icaRank.description = "d".repeat(501);
      },
    ],
    [
      "a plugin name of 65",
      (e) => {
        const m = e.metrics["nemar-quality:percentBrainComponents"];
        m.plugin.name = `p${"x".repeat(64)}`;
      },
    ],
    [
      "a skipped view with a nemar-process word",
      (e) => {
        e.views_skipped = [{ key: "spectrum", kind: "nemar.spectrum", reason: "frame_rotated" }];
      },
    ],
    [
      "a skipped view with a capital word",
      (e) => {
        e.views_skipped = [{ key: "spectrum", kind: "nemar.spectrum", reason: "Frame" }];
      },
    ],
    [
      "a skipped view with no kind",
      (e) => {
        e.views_skipped = [{ key: "spectrum", reason: "x" }];
      },
    ],
    [
      "a skipped view with a member more",
      (e) => {
        e.views_skipped = [{ key: "a", kind: "nemar.lines", reason: "x", why: "y" }];
      },
    ],
    [
      "33 skipped views",
      (e) => {
        e.views_skipped = Array.from({ length: 33 }, (_, i) => ({
          key: `k${i}`,
          kind: "nemar.lines",
          reason: "x",
        }));
      },
    ],
    [
      "a serving store in an archive entry",
      (e) => {
        e.views[1].inputs[1].store.profile = "serving";
      },
    ],
    [
      "a view with two sources",
      (e) => {
        e.views[0].source.plugin = { name: "p", version: "1" };
      },
    ],
  ];
  for (const [name, edit] of corpus) {
    test(`${name} (MUTATION: drop a producer rule, a cap, or the store profile rule)`, async () => {
      const entry = clone(await BASE);
      edit(entry);
      const ajv = validateRecordEntry(entry);
      const zod = RecordRecipeResultsSchema.safeParse(entry).success;
      expect(zod, ajv ? "zod refused what Ajv accepts" : formatAjvErrors(validateRecordEntry)).toBe(
        ajv,
      );
    });
  }
});
