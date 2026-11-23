/**
 * The local launch specification, `nemar.local-launch.v1` (ADR 0134 decision 8, epic #2324 phase 6).
 *
 * Shared members: runtime, entry, command, args, bundle, image, env and resources, and the oneOf and
 * if/then rules, equal the launch specification's JSON Schema value for value, and the zod schema takes
 * them from `LaunchSpecSchema`. Separation: a launch specification is refused here and a local one is
 * refused by `LaunchSpecSchema`. Agreement: a corpus judged by Ajv on the shared JSON Schema and by zod
 * gives the verdict it names (cross-field rules are zod's only, as in the launch specification).
 */

import { describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020";
import { LAUNCH_SPEC_MAX_DATASETS, LaunchSpecSchema } from "../shared/contract/compute-launch";
import launchSchema from "../shared/contract/compute-launch.schema.json";
import {
  LOCAL_DATASET_NAME_RE,
  LOCAL_LAUNCH_FORMAT,
  LOCAL_LAUNCH_MAX_BYTES,
  LOCAL_LAUNCH_MAX_DATASETS,
  LocalLaunchSpecSchema,
} from "../shared/contract/compute-local-launch";
import localSchema from "../shared/contract/compute-local-launch.schema.json";
import * as contractIndex from "../shared/contract/index";

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
const ajvLocal = ajv.compile(localSchema);
const ajvLaunch = ajv.compile(launchSchema);

const HEX = "ab".repeat(32);
const DIGEST = `sha256:${HEX}`;

const valid = () => ({
  format: LOCAL_LAUNCH_FORMAT,
  runtime: "python" as const,
  entry: "run.py",
  args: ["--input", "/data/eeg"],
  bundle: { sha256: "cd".repeat(32), size: 1024 },
  image: { uri: `ghcr.io/nemarorg/nemar-python@${DIGEST}`, digest: DIGEST, sif: `${HEX}.sif` },
  env: {},
  resources: { gpus: 0 },
  datasets: [{ name: "eeg" }, { name: "ds002718.v1" }],
});

const launch = () => ({
  job_id: `job_${"0".repeat(24)}`,
  runtime: "python",
  entry: "run.py",
  args: [],
  bundle: { sha256: "cd".repeat(32), size: 1024 },
  datasets: [{ id: "nm000103", version: "latest" }],
  api_base: "https://api.nemar.org",
  image: { uri: `ghcr.io/nemarorg/nemar-python@${DIGEST}`, digest: DIGEST, sif: `${HEX}.sif` },
  env: {},
  resources: { gpus: 0 },
  limits: { max_files: 10, max_total_bytes: 100 },
  job_token: "t".repeat(43),
});

const both = (doc: unknown) => ({
  ajv: ajvLocal(doc) as boolean,
  zod: LocalLaunchSpecSchema.safeParse(doc).success,
});

describe("the words and numbers", () => {
  test("are the contract's", () => {
    expect(LOCAL_LAUNCH_FORMAT).toBe("nemar.local-launch.v1");
    expect(LOCAL_LAUNCH_MAX_BYTES).toBe(65536);
    expect(LOCAL_LAUNCH_MAX_DATASETS).toBe(20);
    expect(LOCAL_DATASET_NAME_RE.source).toBe("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
    expect(localSchema.properties.format.const).toBe(LOCAL_LAUNCH_FORMAT);
    expect(localSchema.properties.datasets.maxItems).toBe(LOCAL_LAUNCH_MAX_DATASETS);
    expect(localSchema.properties.datasets.maxItems).toBe(
      launchSchema.properties.datasets.maxItems,
    );
    expect(LOCAL_LAUNCH_MAX_DATASETS).toBe(LAUNCH_SPEC_MAX_DATASETS);
    expect(localSchema.properties.datasets.items.properties.name.pattern).toBe(
      "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\\s\\S])",
    );
  });

  test("the contract index re-exports the module", () => {
    expect(contractIndex.LocalLaunchSpecSchema).toBe(LocalLaunchSpecSchema);
    expect(contractIndex.LOCAL_LAUNCH_FORMAT).toBe(LOCAL_LAUNCH_FORMAT);
  });
});

describe("the members shared with the launch specification", () => {
  const SHARED = ["runtime", "entry", "command", "args", "bundle", "image", "env", "resources"];

  test("are the launch specification's JSON Schema members, value for value", () => {
    const launchProps = launchSchema.properties as Record<string, unknown>;
    const localProps = localSchema.properties as Record<string, unknown>;
    for (const key of SHARED) expect(localProps[key], key).toEqual(launchProps[key]);
    expect(localSchema.oneOf).toEqual(launchSchema.oneOf);
    expect(localSchema.if).toEqual(launchSchema.if);
    expect(localSchema.then).toEqual(launchSchema.then);
  });

  test("the local schema has exactly the shared members plus format and datasets", () => {
    expect(Object.keys(localSchema.properties).sort()).toEqual(
      [...SHARED, "format", "datasets"].sort(),
    );
    expect(localSchema.additionalProperties).toBe(false);
    const launchRequired = new Set(launchSchema.required);
    const sharedRequired = SHARED.filter((k) => launchRequired.has(k));
    expect([...localSchema.required].sort()).toEqual(
      [...sharedRequired, "format", "datasets"].sort(),
    );
  });

  test("zod takes the shared members from LaunchSpecSchema", () => {
    const launchShape = LaunchSpecSchema.innerType().shape;
    const localShape = LocalLaunchSpecSchema.innerType().shape;
    for (const key of SHARED) {
      expect(localShape[key as keyof typeof localShape], key).toBe(
        launchShape[key as keyof typeof launchShape],
      );
    }
  });
});

describe("the shared descriptions are read for the service path", () => {
  test("the top-level description gives the standalone equivalents", () => {
    expect(localSchema.description).toContain("describe the service path");
    expect(localSchema.description).toContain("--code FILE");
    expect(localSchema.description).toContain("--sif-root DIR");
  });
});

describe("a local and a launch specification are never taken for each other", () => {
  test("the valid documents are valid on their own side", () => {
    expect(both(valid())).toEqual({ ajv: true, zod: true });
    expect(ajvLaunch(launch())).toBe(true);
    expect(LaunchSpecSchema.safeParse(launch()).success).toBe(true);
  });

  test("a launch specification is refused as a local one, and the reverse", () => {
    expect(both(launch())).toEqual({ ajv: false, zod: false });
    expect(ajvLaunch(valid())).toBe(false);
    expect(LaunchSpecSchema.safeParse(valid()).success).toBe(false);
  });
});

describe("Ajv and zod agree", () => {
  type Case = [string, (d: ReturnType<typeof valid>) => unknown, boolean];
  const cases: Case[] = [
    ["valid", (d) => d, true],
    [
      "a command instead of an entry",
      ({ entry: _e, bundle: _b, ...d }) => ({ ...d, command: ["python", "-V"] }),
      true,
    ],
    ["no datasets", (d) => ({ ...d, datasets: [] }), true],
    ["format missing", ({ format: _f, ...d }) => d, false],
    ["another format", (d) => ({ ...d, format: "nemar.launch-spec.v1" }), false],
    ["datasets missing", ({ datasets: _d, ...d }) => d, false],
    ["an unknown key", (d) => ({ ...d, job_id: `job_${"0".repeat(24)}` }), false],
    ["api_base given", (d) => ({ ...d, api_base: "https://api.nemar.org" }), false],
    [
      "an unknown dataset key",
      (d) => ({ ...d, datasets: [{ name: "eeg", id: "nm000103" }] }),
      false,
    ],
    [
      "a NEMAR dataset item",
      (d) => ({ ...d, datasets: [{ id: "nm000103", version: "latest" }] }),
      false,
    ],
    ["a name starting with a dot", (d) => ({ ...d, datasets: [{ name: ".eeg" }] }), false],
    ["a name with a slash", (d) => ({ ...d, datasets: [{ name: "a/b" }] }), false],
    [
      "a name of 64 characters",
      (d) => ({ ...d, datasets: [{ name: `a${"b".repeat(63)}` }] }),
      true,
    ],
    [
      "a name of 65 characters",
      (d) => ({ ...d, datasets: [{ name: `a${"b".repeat(64)}` }] }),
      false,
    ],
    ["a name ending in a newline", (d) => ({ ...d, datasets: [{ name: "eeg\n" }] }), false],
    [
      "20 datasets",
      (d) => ({ ...d, datasets: Array.from({ length: 20 }, (_, i) => ({ name: `d${i}` })) }),
      true,
    ],
    [
      "21 datasets",
      (d) => ({ ...d, datasets: Array.from({ length: 21 }, (_, i) => ({ name: `d${i}` })) }),
      false,
    ],
    ["a name given twice", (d) => ({ ...d, datasets: [{ name: "eeg" }, { name: "eeg" }] }), false],
    ["both entry and command", (d) => ({ ...d, command: ["python"] }), false],
    ["neither entry nor command", ({ entry: _e, ...d }) => d, false],
    ["an entry without its bundle", ({ bundle: _b, ...d }) => d, false],
    ["an unknown env key", (d) => ({ ...d, env: { PATH: "/bin" } }), false],
    ["a gpu count past 8", (d) => ({ ...d, resources: { gpus: 9 } }), false],
  ];
  for (const [name, build, expected] of cases) {
    test(name, () => {
      expect(both(build(valid()))).toEqual({ ajv: expected, zod: expected });
    });
  }
});

describe("the cross-field image rules are zod's, as in the launch specification", () => {
  test("an image file not named for the digest is refused by zod only", () => {
    const doc = { ...valid(), image: { ...valid().image, sif: `${"ef".repeat(32)}.sif` } };
    expect(both(doc)).toEqual({ ajv: true, zod: false });
  });

  test("an image reference not pinned to the digest is refused by zod only", () => {
    const other = `sha256:${"ef".repeat(32)}`;
    const doc = {
      ...valid(),
      image: { ...valid().image, uri: `ghcr.io/nemarorg/nemar-python@${other}` },
    };
    expect(both(doc)).toEqual({ ajv: true, zod: false });
  });
});
