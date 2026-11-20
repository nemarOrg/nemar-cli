/**
 * The bridge from N.0.1 to the iEEG geometry pipeline (`src/lib/repull/pipeline-run.ts`; ADR 0111,
 * the amendment of 2026-11-19; iEEG geometry plan, ruling 28), on real git repositories and a real
 * subprocess. The program the bridge runs is the stand-in `helpers/ieeg-geometry-standin.ts`, which
 * keeps the package's contract (arguments, report, what it may write) and none of its science; one
 * suite runs the package itself, offline, where `uv` is installed.
 *
 * The properties, each with a test:
 *  - the files come from the snapshot: a changed input changes the outputs, an unchanged one gives
 *    byte-identical outputs, in a second run and in another commit with the same input;
 *  - an owned file the run still makes is changed in place, one it no longer makes is removed;
 *  - upstream's file at an owned path wins: the path is not written, removed or listed again;
 *  - a run that fails, names another version or snapshot, prints no report, writes what it did not
 *    report, or writes a file git would annex, is a failure with a code and no files;
 *  - the program is only ever a test's: the override needs an absolute path beside the test base.
 *
 * CI TIER: unit-pure (local git repositories in a temporary directory; no server, no network).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { which } from "bun";
import { runCommand } from "../src/lib/git-annex/run-command";
import {
  IEEG_GEOMETRY_PIPELINE_VERSION,
  OWNERSHIP_PATH,
  readPipelineOwned,
  withoutOwnedPaths,
} from "../src/lib/repull/pipeline-owned";
import {
  type PipelineFiles,
  type Regeneration,
  isEmptyRegeneration,
  regenerate,
} from "../src/lib/repull/pipeline-run";

const STANDIN = resolve(import.meta.dir, "helpers/ieeg-geometry-standin.ts");
const PROJECT = resolve(import.meta.dir, "../scripts/ieeg_geometry");
const TABLE = "sub-01/ieeg/sub-01_electrodes.tsv";
const OUT = "sub-01/ieeg/sub-01_space-fsaverage_electrodes.tsv";
const SIDECAR = "sub-01/ieeg/sub-01_space-fsaverage_coordsystem.json";
const ID = "xx090123";
const ENV = { NEMAR_REPULL_ORIGIN_BASE: "/nonexistent", NEMAR_IEEG_GEOMETRY_RUNNER: STANDIN };

async function git(dir: string, args: string[], stdin?: string): Promise<string> {
  const r = await runCommand(["git", ...args], {
    cwd: dir,
    ...(stdin !== undefined ? { stdin } : {}),
    env: {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

let dir: string;
/** A commit of `files` (path to text), alone on its own root: a snapshot. */
async function snapshot(files: Record<string, string>): Promise<string> {
  const index = join(dir, `index-${Math.random()}`);
  const env = { GIT_INDEX_FILE: index };
  await runCommand(["git", "read-tree", "--empty"], { cwd: dir, env });
  const lines: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    const oid = await git(dir, ["hash-object", "-w", "--stdin"], content);
    lines.push(`100644 ${oid}\t${path}`);
  }
  await runCommand(["git", "update-index", "-z", "--index-info"], {
    cwd: dir,
    env,
    stdin: `${lines.join("\0")}\0`,
  });
  const tree = (await runCommand(["git", "write-tree"], { cwd: dir, env })).stdout.trim();
  return git(dir, ["commit-tree", tree, "-m", "snapshot"]);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nemar-pipeline-run-"));
  await git(dir, ["init", "-q", "--bare"]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  for (const k of ["STANDIN_MODE", "STANDIN_VERSION"]) Reflect.deleteProperty(process.env, k);
});

const run = (
  commit: string,
  over: {
    owned?: string[];
    upstreamWins?: string[];
    env?: Record<string, string>;
  } = {},
) =>
  regenerate({
    datasetId: ID,
    version: "2.0.0",
    commit,
    repo: dir,
    owned: new Set(over.owned ?? []),
    upstreamWins: new Set(over.upstreamWins ?? []),
    env: over.env ?? ENV,
  });

function files(r: Regeneration): PipelineFiles {
  if (!r.ok) throw new Error(`regeneration failed: ${r.code}`);
  return r.files;
}

const table = (n: number) => `name\tx\nA1\t${n}\n`;

describe("the files come from the snapshot", () => {
  test("a snapshot with a subject's electrodes table gets its outputs and the ownership record", async () => {
    const out = files(await run(await snapshot({ [TABLE]: table(1) })));
    expect([...out.write.keys()].sort()).toEqual([SIDECAR, OUT, OWNERSHIP_PATH].sort());
    expect(out.write.get(OUT)).toContain(table(1));
    expect(out.remove).toEqual([]);
    const record = JSON.parse(out.write.get(OWNERSHIP_PATH) as string);
    expect(Object.keys(record.paths).sort()).toEqual([SIDECAR, OUT].sort());
    expect(readPipelineOwned(Buffer.from(out.write.get(OWNERSHIP_PATH) as string)).paths).toEqual(
      [SIDECAR, OUT].sort(),
    );
  });

  test("an unchanged input gives byte-identical outputs, again and in another commit", async () => {
    const first = files(await run(await snapshot({ [TABLE]: table(1), "README.md": "a\n" })));
    const again = files(await run(await snapshot({ [TABLE]: table(1), "README.md": "b\n" })));
    expect([...again.write]).toEqual([...first.write]);
  });

  test("a changed input changes the outputs", async () => {
    const a = files(await run(await snapshot({ [TABLE]: table(1) })));
    const b = files(await run(await snapshot({ [TABLE]: table(2) })));
    expect(b.write.get(OUT)).not.toBe(a.write.get(OUT));
    expect(b.write.get(OUT)).toContain(table(2));
  });

  test("a snapshot with no electrodes table and no ownership record changes nothing", async () => {
    const out = files(await run(await snapshot({ "README.md": "a\n" })));
    expect(isEmptyRegeneration(out)).toBe(true);
  });
});

describe("the child's environment", () => {
  test("no credential of the CLI's reaches it", async () => {
    const secrets = {
      AWS_ACCESS_KEY_ID: "AKIAFIXTUREFIXTURE",
      AWS_SECRET_ACCESS_KEY: "fixture-secret-fixture-secret",
      AWS_SESSION_TOKEN: "fixture-session-token",
      GH_TOKEN: "ghs_fixturefixturefixture",
      NEMAR_API_KEY: "nemar_fixture_key_fixture",
    };
    Object.assign(process.env, secrets);
    try {
      const r = await run(await snapshot({ [TABLE]: table(1) }));
      expect(r.ok, JSON.stringify(r)).toBe(true);
    } finally {
      for (const k of Object.keys(secrets)) Reflect.deleteProperty(process.env, k);
    }
  });
});

describe("owned files", () => {
  test("an owned file the run still makes is changed, with the new ownership record", async () => {
    const first = files(await run(await snapshot({ [TABLE]: table(1) })));
    const old = Object.fromEntries(first.write);
    const out = files(
      await run(await snapshot({ ...old, [TABLE]: table(2) }), { owned: [OUT, SIDECAR] }),
    );
    expect(out.write.get(OUT)).toContain(table(2));
    expect(out.write.has(SIDECAR)).toBe(false);
    expect(out.write.has(OWNERSHIP_PATH)).toBe(true);
  });

  test("an owned file the run no longer makes is removed with its ownership entry", async () => {
    const first = files(await run(await snapshot({ [TABLE]: table(1) })));
    const out = files(
      await run(await snapshot({ ...Object.fromEntries(first.write) }), { owned: [OUT, SIDECAR] }),
    );
    expect(out.remove.sort()).toEqual([SIDECAR, OUT].sort());
    expect(JSON.parse(out.write.get(OWNERSHIP_PATH) as string).paths).toEqual({});
  });

  test("a hand-edited owned file is kept as it is", async () => {
    const first = files(await run(await snapshot({ [TABLE]: table(1) })));
    const old = Object.fromEntries(first.write);
    old[OUT] = "edited by hand\n";
    const out = files(await run(await snapshot({ ...old, [TABLE]: table(2) }), { owned: [OUT] }));
    expect(out.write.has(OUT)).toBe(false);
    expect(out.kept).toBeGreaterThan(0);
  });

  test("upstream's file at an owned path wins: it is left alone and leaves the ownership record", async () => {
    const first = files(await run(await snapshot({ [TABLE]: table(1) })));
    const old = Object.fromEntries(first.write);
    old[SIDECAR] = '{"iEEGCoordinateSystem": "upstream"}\n';
    const out = files(
      await run(await snapshot({ ...old, [TABLE]: table(1) }), {
        owned: [OUT, SIDECAR],
        upstreamWins: [SIDECAR],
      }),
    );
    expect(out.write.has(SIDECAR)).toBe(false);
    expect(out.remove).not.toContain(SIDECAR);
    const record = JSON.parse(out.write.get(OWNERSHIP_PATH) as string);
    expect(Object.keys(record.paths)).toEqual([OUT]);
  });
});

describe("a regeneration that cannot be trusted is a failure with no files", () => {
  const failure = async (mode: string, env: Record<string, string> = {}) => {
    process.env.STANDIN_MODE = mode;
    const r = await run(await snapshot({ [TABLE]: table(1) }), { env: { ...ENV, ...env } });
    expect(r.ok).toBe(false);
    return r.ok ? "" : r.code;
  };

  test("the program fails", async () => expect(await failure("fail")).toBe("pipeline-run-failed"));
  test("it prints no report", async () =>
    expect(await failure("not-json")).toBe("pipeline-report"));
  test("its report is of another snapshot", async () =>
    expect(await failure("wrong-commit")).toBe("pipeline-report"));
  test("it writes a file it did not report", async () =>
    expect(await failure("undeclared")).toBe("pipeline-undeclared-write"));
  test("it writes a file git would annex", async () =>
    expect(await failure("big")).toBe("pipeline-output-invalid"));

  test("its version is not the one this release runs", async () => {
    process.env.STANDIN_VERSION = "9.9.9";
    const r = await run(await snapshot({ [TABLE]: table(1) }));
    expect(r).toMatchObject({ ok: false, code: "pipeline-version" });
  });

  test("the new main is not in the repository", async () => {
    const r = await run("0".repeat(40));
    expect(r).toMatchObject({ ok: false, code: "pipeline-snapshot" });
  });

  test("the override is refused unless it is an absolute path beside the test base", async () => {
    const commit = await snapshot({ [TABLE]: table(1) });
    for (const env of [
      { NEMAR_REPULL_ORIGIN_BASE: "/x", NEMAR_IEEG_GEOMETRY_RUNNER: "standin" },
      { NEMAR_IEEG_GEOMETRY_RUNNER: STANDIN },
    ]) {
      expect(await run(commit, { env })).toMatchObject({ ok: false, code: "pipeline-unavailable" });
    }
  });

  test("a project directory without the package is refused", async () => {
    const commit = await snapshot({ [TABLE]: table(1) });
    expect(await run(commit, { env: { NEMAR_IEEG_GEOMETRY_DIR: dir } })).toMatchObject({
      ok: false,
      code: "pipeline-unavailable",
    });
  });
});

describe("the ownership record", () => {
  const record = (paths: unknown) => Buffer.from(JSON.stringify({ schema: 1, paths }));

  test("lists only paths shaped like the pipeline's outputs", () => {
    const owned = readPipelineOwned(
      record({
        [OUT]: {},
        [SIDECAR]: {},
        "dataset_description.json": {},
        "sub-01/eeg/sub-01_task-rest_eeg.edf": {},
        "sub-01/../README_electrodes.tsv": {},
        "/sub-01/ieeg/sub-01_electrodes.tsv": {},
        ".nemar/corrections.jsonl": {},
      }),
    );
    expect(owned).toEqual({ status: "ok", paths: [SIDECAR, OUT].sort(), ignored: 5 });
  });

  test("a file that does not parse, or is not the record, is unreadable, never none", () => {
    for (const bytes of [
      Buffer.from("{ not json"),
      Buffer.from("[]"),
      Buffer.from(JSON.stringify({ schema: 2, paths: {} })),
      Buffer.from(JSON.stringify({ schema: 1, paths: [] })),
      Buffer.from("null"),
    ]) {
      expect(readPipelineOwned(bytes).status).toBe("unreadable");
    }
    expect(readPipelineOwned(null)).toEqual({ status: "absent", paths: [], ignored: 0 });
  });

  test("dropping a path leaves the rest, sorted; dropping none leaves the bytes", () => {
    const bytes = Buffer.from(
      `${JSON.stringify({ paths: { [SIDECAR]: { a: 1 }, [OUT]: { b: 2 } }, pipeline_version: "0.1.0", schema: 1 }, null, 2)}\n`,
    );
    expect(withoutOwnedPaths(bytes, new Set())).toBe(bytes);
    const dropped = JSON.parse(withoutOwnedPaths(bytes, new Set([SIDECAR])).toString());
    expect(dropped).toEqual({ paths: { [OUT]: { b: 2 } }, pipeline_version: "0.1.0", schema: 1 });
  });
});

describe("the pipeline's version", () => {
  test("this release's pin is the package's own version", () => {
    const toml = readFileSync(join(PROJECT, "pyproject.toml"), "utf8");
    expect(/^version = "([^"]+)"$/m.exec(toml)?.[1]).toBe(IEEG_GEOMETRY_PIPELINE_VERSION);
  });
});

// The package itself, where `uv` and its locked environment are available: the real report, the
// real tracks, the real ownership record. Offline: the snapshot is a committed fixture with no
// annexed input, and the version is given, so the run reaches no network.
describe.skipIf(which("uv") === null)("the package itself", () => {
  const FIXTURE = join(PROJECT, "tests/fixtures/labels/on006107");
  const COORD = "sub-01/ses-01/ieeg/sub-01_ses-01_coordsystem.json";
  const real = async (files: Record<string, string>, over = {}) =>
    regenerate({
      datasetId: "on006107",
      version: "2.0.0",
      commit: await snapshot(files),
      repo: dir,
      owned: new Set(),
      upstreamWins: new Set(),
      env: {},
      ...over,
    });
  const readFixture = () => {
    const tmp = mkdtempSync(join(tmpdir(), "nemar-pipeline-fixture-"));
    cpSync(FIXTURE, tmp, { recursive: true });
    const out: Record<string, string> = { "README.md": "Electrodes are in fsaverage space.\n" };
    for (const rel of [
      "sub-01/ses-01/ieeg/sub-01_ses-01_electrodes.tsv",
      "sub-01/ses-01/ieeg/sub-01_ses-01_task-sws_run-01_channels.tsv",
    ]) {
      out[rel] = readFileSync(join(tmp, rel), "utf8");
    }
    rmSync(tmp, { recursive: true, force: true });
    return out;
  };

  test("writes the label track's sidecar and its ownership record, the same every time", async () => {
    const tree = readFixture();
    const first = await real(tree);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const out = files(first);
    expect([...out.write.keys()].sort()).toEqual([COORD, OWNERSHIP_PATH].sort());
    const again = files(
      await real({ ...tree, "README.md": "Electrodes are in fsaverage space.\n" }),
    );
    expect([...again.write]).toEqual([...out.write]);
    expect(JSON.parse(out.write.get(OWNERSHIP_PATH) as string).pipeline_version).toBe(
      IEEG_GEOMETRY_PIPELINE_VERSION,
    );
  });

  test("a snapshot that already holds the outputs changes nothing", async () => {
    const tree = readFixture();
    const out = files(await real(tree));
    const held = { ...tree, ...Object.fromEntries(out.write) };
    const next = files(await real(held, { owned: new Set([COORD]) }));
    expect(isEmptyRegeneration(next)).toBe(true);
  });
});
