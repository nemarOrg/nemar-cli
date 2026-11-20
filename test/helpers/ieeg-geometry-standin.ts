#!/usr/bin/env bun
/**
 * A stand-in for `python -m ieeg_geometry run <id> --workdir DIR --version V --apply`, for the
 * re-pull suites (`NEMAR_IEEG_GEOMETRY_RUNNER`). It keeps the package's contract and none of its
 * science: it reads the git work tree at `DIR/<id>` (a clone the caller made), derives a
 * `space-fsaverage` electrodes table and coordinate-system sidecar from every subject's electrodes
 * table that has no `space-` entity (the output is a function of the input's git blob id and the
 * pipeline version, so a changed input changes the output and an unchanged one does not), writes
 * them and `.nemar/ieeg-geometry.json`, and prints one report with `changes.add/change/remove/kept`.
 *
 * It follows the package's rules for what it may write: an output that is absent is added; one whose
 * bytes are the owned `output_sha256` is changed; one that differs and is not that is kept (a
 * hand-edited file, or a file upstream holds); an owned file the run no longer produces is removed
 * while its bytes are still the owned ones.
 *
 * `STANDIN_MODE`: `noop` reports no change and writes nothing; `fail` exits 1; `not-json` prints text; `undeclared` also writes a file it does not
 * report; `big` writes an output over 1 MiB; `wrong-commit` names another commit in the report.
 * `STANDIN_VERSION` is the pipeline version it reports (0.1.0 by default).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name: string) => argv[argv.indexOf(name) + 1] as string;
const id = argv[1] as string;
const clone = join(flag("--workdir"), id);
const mode = process.env.STANDIN_MODE ?? "ok";
const version = process.env.STANDIN_VERSION ?? "0.1.0";

if (argv[0] !== "run" || !argv.includes("--apply") || !flag("--version")) {
  console.error("stand-in: expected run <id> --workdir DIR --version V --apply");
  process.exit(1);
}
if (mode === "fail") {
  console.error("refused: stand-in failure");
  process.exit(1);
}

// The package is not given the CLI's credentials: a run that finds one fails loudly.
if (
  ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "GH_TOKEN", "NEMAR_API_KEY"].some(
    (k) => k in process.env,
  )
) {
  console.error("stand-in: a credential reached the child");
  process.exit(3);
}

const git = (args: string[], stdin?: string): string => {
  const r = Bun.spawnSync(["git", ...args], {
    cwd: clone,
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return r.stdout.toString();
};
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const blobId = (b: Buffer) =>
  createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b]))
    .digest("hex");

const commit = git(["rev-parse", "HEAD"]).trim();
const report = (changes: object, source = commit) =>
  JSON.stringify({
    schema: "nemar-ieeg-geometry-report",
    version: 1,
    dataset: id,
    dataset_version: flag("--version"),
    source_commit: source,
    pipeline_version: version,
    mode: "apply",
    warnings: [],
    files: [],
    counts: {},
    changes,
  });
const tracked = git(["ls-tree", "-r", "-z", "--name-only", "HEAD"]).split("\0").filter(Boolean);
const inputs = tracked
  .filter((p) => /^sub-.*_electrodes\.tsv$/.test(p) && !/_space-/.test(p))
  .sort();
const OWNERSHIP = ".nemar/ieeg-geometry.json";
const selected = tracked.filter((p) => /^sub-.*_(electrodes\.tsv|coordsystem\.json)$/.test(p));
const pathspec = [...selected, ...(tracked.includes(OWNERSHIP) ? [OWNERSHIP] : [])].filter(
  (p) => !existsSync(join(clone, p)),
);
if (pathspec.length > 0) {
  git(
    ["checkout", "HEAD", "--pathspec-from-file=-", "--pathspec-file-nul"],
    `${pathspec.join("\0")}\0`,
  );
}

if (mode === "noop") {
  console.log(report({ add: [], change: [], remove: [], kept: [] }));
  process.exit(0);
}

type Entry = {
  kind: string;
  inputs: Array<{ blob: string; path: string }>;
  method: string;
  output_sha256: string;
  verification: null;
};
const owned: Record<string, Entry> = existsSync(join(clone, OWNERSHIP))
  ? (JSON.parse(readFileSync(join(clone, OWNERSHIP), "utf8")).paths ?? {})
  : {};

// What the run would write.
const desired = new Map<string, { data: Buffer; entry: Entry }>();
for (const input of inputs) {
  const bytes = readFileSync(join(clone, input));
  const blob = blobId(bytes);
  const stem = input.replace(/_electrodes\.tsv$/, "_space-fsaverage");
  const table = Buffer.from(
    `derived-from\t${blob}\t${version}\n${bytes.toString("utf8")}${mode === "big" ? "x".repeat(1_100_000) : ""}`,
  );
  const sidecar = Buffer.from(
    `${JSON.stringify({ iEEGCoordinateSystem: "fsaverage", PipelineVersion: version }, null, 2)}\n`,
  );
  for (const [path, data, kind] of [
    [`${stem}_electrodes.tsv`, table, "electrodes"],
    [`${stem}_coordsystem.json`, sidecar, "coordsystem"],
  ] as const) {
    desired.set(path, {
      data,
      entry: {
        kind,
        inputs: [{ blob, path: input }],
        method: "stand-in",
        output_sha256: sha256(data),
        verification: null,
      },
    });
  }
}

const changes = {
  add: [] as string[],
  change: [] as string[],
  remove: [] as string[],
  kept: [] as string[],
};
const next: Record<string, Entry> = {};
for (const [path, { data, entry }] of [...desired].sort(([a], [b]) => (a < b ? -1 : 1))) {
  const file = join(clone, path);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    changes.add.push(path);
    next[path] = entry;
  } else if (readFileSync(file).equals(data)) {
    next[path] = entry;
  } else if (owned[path] && sha256(readFileSync(file)) === owned[path]?.output_sha256) {
    writeFileSync(file, data);
    changes.change.push(path);
    next[path] = entry;
  } else {
    changes.kept.push(path);
    if (owned[path]) next[path] = owned[path] as Entry;
  }
}
for (const [path, entry] of Object.entries(owned)) {
  if (desired.has(path)) continue;
  const file = join(clone, path);
  if (!existsSync(file)) continue;
  if (sha256(readFileSync(file)) === entry.output_sha256) {
    unlinkSync(file);
    changes.remove.push(path);
  } else {
    changes.kept.push(path);
    next[path] = entry;
  }
}

const sorted = (o: Record<string, Entry>) =>
  Object.fromEntries(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]]),
  );
const record = `${JSON.stringify({ paths: sorted(next), pipeline_version: version, schema: 1 }, null, 2)}\n`;
const ownershipFile = join(clone, OWNERSHIP);
const before = existsSync(ownershipFile) ? readFileSync(ownershipFile, "utf8") : null;
if (Object.keys(next).length > 0 || before !== null) {
  mkdirSync(dirname(ownershipFile), { recursive: true });
  if (before !== record) {
    writeFileSync(ownershipFile, record);
    (before === null ? changes.add : changes.change).push(OWNERSHIP);
  }
}
if (mode === "undeclared") {
  mkdirSync(join(clone, "sub-01"), { recursive: true });
  writeFileSync(join(clone, "sub-01", "stray.txt"), "not reported\n");
}
rmSync(join(flag("--workdir"), ".surfaces-standin"), { recursive: true, force: true });

if (mode === "not-json") {
  console.log("done");
} else {
  console.log(report(changes, mode === "wrong-commit" ? "0".repeat(40) : commit));
}
