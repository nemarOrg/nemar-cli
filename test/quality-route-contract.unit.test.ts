/**
 * `shared/contract/quality-route.ts`: the quality view route's paths, words, bounds and file headers (ADR 0137
 * decision 7, epic #2324 phase B2), held to the vendored neuroschema 0.6.0 registry and schemas they restate.
 * The view digest's vectors are replayed by `test/view-digest-contract.unit.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  QUALITY_ADMIN_ROUTE_WORDS,
  QUALITY_FILE_MAX_BYTES,
  QUALITY_FORMAT_MEDIA_TYPES,
  QUALITY_PUBLIC_MAX_AGE,
  QUALITY_RECORDING_PATH_MAX,
  QUALITY_ROUTE_WORDS,
  isQualityRecordingPath,
  qualityAdminFilePath,
  qualityAdminForwardPath,
  qualityAdminRecordPath,
  qualityAdminRest,
  qualityCacheTag,
  qualityFileHeaders,
  qualityFilePath,
  qualityRecordPath,
} from "../shared/contract/quality-route.js";

// biome-ignore lint/suspicious/noExplicitAny: vendored documents are read field by field
type Loose = any;
const NS = join(import.meta.dir, "../shared/contract/neuroschema");
const REGISTRY: Loose = JSON.parse(readFileSync(join(NS, "views/registry.json"), "utf8"));
const BUNDLE: Loose = JSON.parse(readFileSync(join(NS, "dataset.bundle.json"), "utf8"));
const schema = (id: string): Loose => BUNDLE.schemas.find((s: Loose) => s.$id === id);

describe("bounds restate neuroschema's", () => {
  test("a view file is at most the registry's bytes per role, the schema's size maximum", () => {
    expect(QUALITY_FILE_MAX_BYTES).toBe(REGISTRY.caps.bytes_per_role);
    const view = schema("nsc:/definitions/view.schema.json");
    expect(view.$defs.viewData.properties.size.maximum).toBe(QUALITY_FILE_MAX_BYTES);
    expect(view.$defs.fileInput.properties.size.maximum).toBe(QUALITY_FILE_MAX_BYTES);
  });

  test("a recording path is at most relativeLocation's length", () => {
    const types = schema("nsc:/definitions/processingTypes.schema.json");
    expect(types.$defs.relativeLocation.maxLength).toBe(QUALITY_RECORDING_PATH_MAX);
  });

  test("the formats served inline are the registry's, with its media types", () => {
    expect(Object.keys(QUALITY_FORMAT_MEDIA_TYPES).sort()).toEqual(
      Object.keys(REGISTRY.formats).sort(),
    );
    for (const [format, media] of Object.entries(QUALITY_FORMAT_MEDIA_TYPES)) {
      expect(media.split(";")[0]).toBe(REGISTRY.formats[format].media_type);
    }
  });

  test("a browser keeps a public answer at most 300 seconds (ADR 0137 decision 7)", () => {
    expect(QUALITY_PUBLIC_MAX_AGE).toBeLessThanOrEqual(300);
    expect(qualityCacheTag("nm000103")).toBe("nemar-dq-nm000103");
  });
});

describe("words", () => {
  test("each word has its fixed status, and only corruption and an unreadable record are 5xx", () => {
    expect(QUALITY_ROUTE_WORDS).toEqual({
      quality_not_found: 404,
      recording_path_invalid: 400,
      views_expired: 410,
      view_not_declared: 404,
      view_data_missing: 404,
      view_data_corrupt: 502,
      record_unreadable: 502,
    });
  });
});

describe("paths", () => {
  test("segments are encoded one by one; the recording's slashes stay", () => {
    expect(qualityRecordPath("nm000103", "nemar-ica", "sub-01/eeg/sub-01_task-a b_eeg.edf")).toBe(
      "/nm000103/quality/v1/nemar-ica/record/sub-01/eeg/sub-01_task-a%20b_eeg.edf",
    );
    expect(
      qualityFilePath(
        "nm000103",
        "nemar-ica",
        "a".repeat(64),
        "b".repeat(64),
        "sub-01/eeg/x_eeg.edf",
      ),
    ).toBe(
      `/nm000103/quality/v1/nemar-ica/file/${"a".repeat(64)}/${"b".repeat(64)}/sub-01/eeg/x_eeg.edf`,
    );
  });
});

describe("file headers (RFC 6266, nosniff)", () => {
  test("a listed format is served inline as its media type", () => {
    expect(qualityFileHeaders("sub-01/eeg/a_spectrum.tsv", "tsv")).toEqual({
      "Content-Type": "text/tab-separated-values; charset=utf-8",
      "Content-Disposition": "inline; filename*=UTF-8''a_spectrum.tsv",
      "X-Content-Type-Options": "nosniff",
    });
    expect(qualityFileHeaders("a.json", "json")["Content-Type"]).toBe("application/json");
  });

  test("any other format, or none, is an octet-stream attachment, so a declared page is never rendered", () => {
    for (const [location, format] of [
      ["sub-01/eeg/a.html", "html"],
      ["sub-01/eeg/a.svg", "svg"],
      ["sub-01/eeg/a.npy", null],
      ["a.tsv", "constructor"],
      ["a.tsv", "__proto__"],
    ] as const) {
      const h = qualityFileHeaders(location, format);
      expect(h["Content-Type"]).toBe("application/octet-stream");
      expect(h["Content-Disposition"].startsWith("attachment; filename*=UTF-8''")).toBe(true);
      expect(h["X-Content-Type-Options"]).toBe("nosniff");
    }
  });

  test("the file name is percent-encoded, quotes and parentheses included", () => {
    expect(qualityFileHeaders('d/it\'s (µ) "x".tsv', "tsv")["Content-Disposition"]).toBe(
      "inline; filename*=UTF-8''it%27s%20%28%C2%B5%29%20%22x%22.tsv",
    );
  });
});

describe("the admin mount's grammar (epic #2324 phase B3b), which the website's proxy enforces too", () => {
  const REC = "sub-01/eeg/sub-01_task-rest_eeg.edf";
  const SHA = "a".repeat(64);

  test("the two shapes, decoded", () => {
    expect(qualityAdminRest(`record/${REC}`)).toEqual({ kind: "record", recording: REC });
    expect(qualityAdminRest(`file/${SHA}/${REC}`)).toEqual({
      kind: "file",
      sha256: SHA,
      recording: REC,
    });
    expect(qualityAdminRest("record/sub-01/eeg/sub-01_task-a%20b_eeg.edf")).toEqual({
      kind: "record",
      recording: "sub-01/eeg/sub-01_task-a b_eeg.edf",
    });
  });

  test("every path the builders make is inside the grammar and names its recording again", () => {
    for (const recording of [REC, "sub-01_task-x_eeg.set", "a/b/c (1)/sub-µ_task-x_eeg.edf"]) {
      const record = qualityAdminRecordPath(7, recording);
      const file = qualityAdminFilePath(7, SHA, recording);
      const prefix = "/admin/compute/pipeline/runs/7/quality/";
      expect(record.startsWith(prefix)).toBe(true);
      expect(file.startsWith(prefix)).toBe(true);
      expect(qualityAdminRest(record.slice(prefix.length))).toEqual({ kind: "record", recording });
      expect(qualityAdminRest(file.slice(prefix.length))).toEqual({
        kind: "file",
        sha256: SHA,
        recording,
      });
    }
  });

  test("anything else is outside it: traversal, encoded separators, forged digests, other kinds", () => {
    for (const rest of [
      "",
      "record",
      "record/",
      `record/${REC}/`,
      `record//${REC}`,
      `record/../${REC}`,
      `record/./${REC}`,
      "record/sub-01/..",
      `record/%2E%2E/${REC}`,
      `record/.%2e/${REC}`,
      `record/%2e/${REC}`,
      "record/sub-01%2Feeg%2Fsub-01_task-rest_eeg.edf",
      "record/sub-01%2feeg/sub-01_task-rest_eeg.edf",
      "record/sub-01%5Ceeg/sub-01_task-rest_eeg.edf",
      "record/sub-01\\eeg/sub-01_task-rest_eeg.edf",
      "record/sub-01/eeg/sub-01_task-rest_eeg.edf%00",
      "record/sub-01/eeg/sub-01_task-rest%0A_eeg.edf",
      "record/sub-01/eeg/sub-01_task-rest%7F_eeg.edf",
      "record/sub-01/eeg/sub-01_task-rest%ZZ_eeg.edf",
      "record/sub-01/eeg/sub-01_task-rest%E0%A4_eeg.edf",
      "record/sub-01/eeg/sub-01?x_eeg.edf",
      "record/sub-01/eeg/sub-01#x_eeg.edf",
      "record/sub 01/eeg/sub-01_task-rest_eeg.edf",
      `file/${SHA.toUpperCase()}/${REC}`,
      `file/${SHA.slice(1)}/${REC}`,
      `file/${SHA}0/${REC}`,
      `file/${SHA}`,
      `file/${SHA}/`,
      `file/${REC}`,
      `views/${REC}`,
      `RECORD/${REC}`,
      `record/${"a/".repeat(600)}x_eeg.edf`,
      // Decoded, each breaks the recording rule (the delta review of #2390).
      "record/sub-01/eeg/sub-01_task-rest%C2%85_eeg.edf",
      "record/sub-01/eeg/sub-01_task-rest_eeg.edf%3F",
      "record/sub-01/eeg/sub-01_task-rest_eeg.edf%23x",
      "record/sub-01/eeg/sub-01_task-%E2%80%AErest_eeg.edf",
      "record/sub-01%252Feeg/sub-01_task-rest_eeg.edf",
      "record/sub-01/eeg/sub-01_task-rest_channels.tsv",
      "record/%20sub-01/eeg/sub-01_task-rest_eeg.edf",
      "record/http:/eeg/sub-01_task-rest_eeg.edf",
    ]) {
      expect([rest, qualityAdminRest(rest)]).toEqual([rest, null]);
    }
  });

  test("the admin words extend the public route's, each with its status", () => {
    for (const [word, status] of Object.entries(QUALITY_ROUTE_WORDS)) {
      expect(QUALITY_ADMIN_ROUTE_WORDS[word as keyof typeof QUALITY_ADMIN_ROUTE_WORDS]).toBe(
        status,
      );
    }
    expect(QUALITY_ADMIN_ROUTE_WORDS).toMatchObject({
      stamp_not_found: 404,
      derivative_not_keyed: 404,
      derivative_copying: 409,
      derivative_failed: 409,
      method_not_allowed: 405,
      quality_unavailable: 503,
    });
  });
});

describe("the proxy's forward path (epic #2324 phase B3b, the delta review of #2390)", () => {
  const REC = "sub-01/eeg/sub-01_task-rest_eeg.edf";
  const SHA = "b".repeat(64);

  test("a stamp id and a rest inside the grammar give the canonical path, built from the raw strings", () => {
    expect(qualityAdminForwardPath("7", `record/${REC}`)).toBe(
      `/admin/compute/pipeline/runs/7/quality/record/${REC}`,
    );
    expect(qualityAdminForwardPath("7", `file/${SHA}/${REC}`)).toBe(
      qualityAdminFilePath(7, SHA, REC),
    );
    const encoded = "record/sub-01/eeg/sub-01_task-a%20b_eeg.edf";
    expect(qualityAdminForwardPath("12", encoded)).toBe(
      `/admin/compute/pipeline/runs/12/quality/${encoded}`,
    );
  });

  test("a stamp that is not a stamp id is refused", () => {
    for (const stamp of [
      "",
      "0",
      "01",
      "-1",
      "1e3",
      "1.0",
      " 1",
      "99999999999999999",
      "9999999999999999",
      "5/..",
      "%35",
    ]) {
      expect([stamp, qualityAdminForwardPath(stamp, `record/${REC}`)]).toEqual([stamp, null]);
    }
  });

  test("the reviewer's dot-segment repro: a rest that a URL parser would resolve out of the mount is refused", () => {
    // Forwarded as is, these resolve to another admin route (`.../runs/7/users/...`) with the caller's
    // credential; the helper refuses each before anything is forwarded.
    for (const rest of [
      "record/%2e%2e/%2e%2e/%2e%2e/users/x_eeg.edf",
      "record/.%2e/.%2e/.%2e/users/x_eeg.edf",
      "record/%2E./%2E./users/x_eeg.edf",
      "record/../../../users/x_eeg.edf",
      `file/${SHA}/%2e%2e/%2e%2e/%2e%2e/%2e%2e/users`,
      "record/sub-01/./eeg/sub-01_task-rest_eeg.edf",
      `record/${REC}?x=1`,
      `record/${REC}?`,
      `record/${REC}#x`,
    ]) {
      expect([rest, qualityAdminForwardPath("7", rest)]).toEqual([rest, null]);
    }
  });

  test("every path the helper returns is one a URL parser leaves exactly as it is", () => {
    for (const recording of [REC, "a/b/c (1)/sub-µ_task-x_eeg.edf", "sub-01_task-x_eeg.set"]) {
      for (const built of [
        qualityAdminRecordPath(3, recording),
        qualityAdminFilePath(3, SHA, recording),
      ]) {
        const rest = built.slice("/admin/compute/pipeline/runs/3/quality/".length);
        const forwarded = qualityAdminForwardPath("3", rest);
        expect(forwarded).toBe(built);
        const parsed = new URL(forwarded as string, "https://example.invalid");
        expect(parsed.pathname).toBe(forwarded as string);
        expect(parsed.search).toBe("");
      }
    }
  });

  test("the grammar's recording rule is the backend's: isQualityRecordingPath", () => {
    expect(isQualityRecordingPath(REC)).toBe(true);
    for (const bad of [
      "",
      "sub-01/eeg/a.tsv",
      "sub-01/../x_eeg.edf",
      "x\u0085_eeg.edf",
      "x\u202e_eeg.edf",
      `${"a".repeat(1020)}_eeg.edf`,
    ]) {
      expect([bad, isQualityRecordingPath(bad)]).toEqual([bad, false]);
    }
  });
});

describe("the forward path, under a seeded generator of rests", () => {
  /** mulberry32: a small deterministic generator, so a failure names a seed that reproduces it. */
  function generator(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const SEED = 2390;
  const CASES = 5000;
  // Raw characters, escapes (allowed and forbidden) and pieces a forger reaches for.
  const PIECES = [
    "a",
    "Z",
    "0",
    "-",
    "_",
    ".",
    "~",
    "(",
    ")",
    "+",
    ",",
    ";",
    "=",
    ":",
    "@",
    "!",
    "$",
    "&",
    "'",
    "*",
    "..",
    "%20",
    "%C2%B5",
    "%2E",
    "%2e",
    "%2F",
    "%2f",
    "%5C",
    "%25",
    "%252F",
    "%3F",
    "%23",
    "%00",
    "%0A",
    "%7F",
    "%C2%85",
    "%E2%80%AE",
    "%ZZ",
    "%",
    "?",
    "#",
    " ",
    "\\",
    "µ",
    "sub-01",
    "task-rest",
  ];
  const ENDINGS = ["_eeg.edf", "_eeg.set", "_eeg.bdf", "_channels.tsv", "", ".", "/"];

  function rest(next: () => number): string {
    const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
    const segments: string[] = [];
    const count = 1 + Math.floor(next() * 4);
    for (let i = 0; i < count; i++) {
      let segment = "";
      const parts = Math.floor(next() * 4);
      for (let j = 0; j < parts; j++) segment += pick(PIECES);
      if (next() < 0.1) segment = pick([".", "..", "%2e%2e", ".%2E", ""]);
      segments.push(segment);
    }
    segments[segments.length - 1] = `${segments[segments.length - 1] || "x"}${pick(ENDINGS)}`;
    const head =
      next() < 0.5
        ? "record"
        : `file/${next() < 0.9 ? "c".repeat(64) : pick(["C".repeat(64), "c".repeat(63), "x"])}`;
    return `${head}/${segments.join("/")}`;
  }

  test(`${CASES} generated rests (seed ${SEED}): every accepted one parses back to itself`, () => {
    const next = generator(SEED);
    let accepted = 0;
    for (let i = 0; i < CASES; i++) {
      const raw = rest(next);
      const stamp = String(1 + Math.floor(next() * 1_000_000));
      const forward = qualityAdminForwardPath(stamp, raw);
      if (forward === null) continue;
      accepted++;
      const parsed = new URL(forward, "https://example.invalid");
      expect([raw, parsed.pathname]).toEqual([raw, forward]);
      expect([raw, parsed.search, parsed.hash]).toEqual([raw, "", ""]);
      expect(forward.startsWith(`/admin/compute/pipeline/runs/${stamp}/quality/`)).toBe(true);
    }
    // Not vacuous: a share of the generated rests are inside the grammar, and most are not.
    expect(accepted).toBeGreaterThan(CASES / 20);
    expect(accepted).toBeLessThan(CASES / 2);
  });
});

describe("the contract's imports stay leaves", () => {
  const imports = (file: string): string[] =>
    [
      ...readFileSync(join(import.meta.dir, "..", file), "utf8").matchAll(
        /^import[^;]*from "([^"]+)";/gm,
      ),
    ].map((m) => m[1] as string);

  test("quality-route.ts imports only the recording-name rule and the stamp pattern, and those import nothing", () => {
    expect(imports("shared/contract/quality-route.ts").sort()).toEqual([
      "../compute-naming.js",
      "./compute-stamp.js",
    ]);
    expect(imports("shared/compute-naming.ts")).toEqual([]);
    expect(imports("shared/contract/compute-stamp.ts")).toEqual([]);
  });
});
