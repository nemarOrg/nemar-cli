/**
 * Where a job's wishes come from and which one wins (epic #2021 phase D3b, #2024): the CLI layer around
 * `shared/compute-header.ts`, whose own parser table is `compute-header.unit.test.ts`. Real files in a real
 * temporary directory; nothing is stood in for.
 *
 * What is pinned: a header is found in a Python script, a MATLAB script and a folder's `nemar-job.toml`;
 * every parser error becomes a sentence that names the file and the line and never quotes the line;
 * a flag reads `--mem` and `--time` the way a header does and names itself in an error; and the
 * precedence is FLAGS, then the script's HEADER, then the folder's FILE, then the DEFAULTS, key by key,
 * with a list replaced as a whole. The mutation that lets a header beat a flag fails the precedence table
 * (recorded in the phase report).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEADER_ERROR_CODES } from "../shared/compute-header";
import {
  HEADER_ERROR_SENTENCES,
  SPEC_DEFAULTS,
  defaultJobName,
  flagsToFields,
  headerKindForFile,
  mergeSpecFields,
  readFolderHeader,
  readScriptHeader,
} from "../src/lib/compute/header";

const dir = mkdtempSync(join(tmpdir(), "nemar-header-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

const BODY = ['name = "eeg-floor"', "cores = 8", 'memory = "16G"', 'time = "1h30m"', "gpus = 0"];

describe("a header is found in each of its three homes", () => {
  test("Python, MATLAB and nemar-job.toml give the same specification fields", () => {
    const py = write(
      "a.py",
      ["# /// nemar", ...BODY.map((l) => `# ${l}`), "# ///", "print(1)"].join("\n"),
    );
    const m = write(
      "a.m",
      ["% /// nemar", ...BODY.map((l) => `% ${l}`), "% ///", "disp(1)"].join("\n"),
    );
    const toml = mkdtempSync(join(dir, "folder-"));
    write(`${toml.split("/").pop()}/nemar-job.toml`, BODY.join("\n"));
    const expected = { name: "eeg-floor", cores: 8, memory_mb: 16384, minutes: 90, gpus: 0 };
    for (const read of [
      readScriptHeader(py, "a.py"),
      readScriptHeader(m, "a.m"),
      readFolderHeader(toml),
    ]) {
      expect(read).toEqual({ ok: true, found: true, fields: expected });
    }
  });

  test("a script with no block, a file kind with no header comment and a folder with no file are found:false", () => {
    expect(readScriptHeader(write("plain.py", "print(1)\n"), "plain.py")).toEqual({
      ok: true,
      found: false,
      fields: {},
    });
    expect(
      readScriptHeader(write("tool.sh", "# /// nemar\n# cores = 2\n# ///\n"), "tool.sh"),
    ).toEqual({
      ok: true,
      found: false,
      fields: {},
    });
    expect(readFolderHeader(mkdtempSync(join(dir, "empty-")))).toEqual({
      ok: true,
      found: false,
      fields: {},
    });
  });

  test("the kind of a file is its extension", () => {
    expect(headerKindForFile("x/run.PY")).toBe("python");
    expect(headerKindForFile("run.m")).toBe("matlab");
    expect(headerKindForFile("run.R")).toBeNull();
  });

  test("a large script is read by its prefix and a block near the top still parses", () => {
    const text = `# /// nemar\n# cores = 3\n# ///\n${"x = 1\n".repeat(80_000)}`;
    expect(readScriptHeader(write("big.py", text), "big.py")).toEqual({
      ok: true,
      found: true,
      fields: { cores: 3 },
    });
  });
});

describe("every error names the file and the line and never quotes the line", () => {
  const SECRET_LOOKING = "value-that-must-not-be-echoed";
  const cases: Array<[string, string, number]> = [
    ["unknown_key", `# /// nemar\n# wheel = "${SECRET_LOOKING}"\n# ///\n`, 2],
    ["duplicate_key", "# /// nemar\n# cores = 1\n# cores = 2\n# ///\n", 3],
    ["bad_line", `# /// nemar\n# ${SECRET_LOOKING}\n# ///\n`, 2],
    ["unsupported_value", "# /// nemar\n# cores = 1.5\n# ///\n", 2],
    ["bad_string", `# /// nemar\n# name = "${SECRET_LOOKING}\n# ///\n`, 2],
    ["unterminated_block", "# /// nemar\n# cores = 1\nprint(1)\n", 1],
    ["duplicate_block", "# /// nemar\n# cores = 1\n# ///\n# /// nemar\n# cores = 2\n# ///\n", 4],
  ];
  for (const [code, text, line] of cases) {
    test(`${code}, at line ${line}`, () => {
      const read = readScriptHeader(write(`e-${code}.py`, text), `e-${code}.py`);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.problems[0]).toBe(
        `e-${code}.py:${line}: ${HEADER_ERROR_SENTENCES[code as keyof typeof HEADER_ERROR_SENTENCES]}`,
      );
      expect(read.problems.join("\n")).not.toContain(SECRET_LOOKING);
    });
  }

  test("a value the mapping cannot read (memory, time, a dataset) is refused at its line", () => {
    const bad = write(
      "m.py",
      '# /// nemar\n# memory = "plenty"\n# time = "soon"\n# datasets = ["nm0001"]\n# ///\n',
    );
    const read = readScriptHeader(bad, "m.py");
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems.map((p) => p.split(": ")[0])).toEqual(["m.py:2", "m.py:3", "m.py:4"]);
  });

  test("input_too_large has a sentence, and every parser code has one", () => {
    for (const code of HEADER_ERROR_CODES)
      expect(HEADER_ERROR_SENTENCES[code].length).toBeGreaterThan(10);
  });

  test("a nemar-job.toml error names the file", () => {
    const folder = mkdtempSync(join(dir, "bad-"));
    writeFileSync(join(folder, "nemar-job.toml"), "cores = 1\nwheels = 4\n");
    const read = readFolderHeader(folder);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problems[0]).toMatch(/^nemar-job\.toml:2: unknown key/);
  });
});

describe("the flags", () => {
  test("--mem and --time read as a header does, and numbers are whole", () => {
    expect(
      flagsToFields({
        mem: "16G",
        time: "1h30m",
        nodes: "2",
        cores: "8",
        gpus: "0",
        partition: "compute",
      }),
    ).toEqual({
      ok: true,
      fields: { memory_mb: 16384, minutes: 90, nodes: 2, cores: 8, gpus: 0, partition: "compute" },
    });
    expect(flagsToFields({ time: "2h" })).toEqual({ ok: true, fields: { minutes: 120 } });
  });

  test("--dataset takes id@version; --entry, --name and --runtime pass through", () => {
    expect(
      flagsToFields({
        dataset: ["nm000104@1.0.2", "ds002718@1.0.5"],
        entry: "run.py",
        name: "x",
        runtime: "python",
      }),
    ).toEqual({
      ok: true,
      fields: {
        datasets: [
          { id: "nm000104", version: "1.0.2" },
          { id: "ds002718", version: "1.0.5" },
        ],
        entry: "run.py",
        name: "x",
        runtime: "python",
      },
    });
  });

  test("a bad flag is refused naming the FLAG", () => {
    const read = flagsToFields({
      mem: "lots",
      time: "soon",
      dataset: ["nm1"],
      nodes: "two",
      cores: "0",
    });
    expect(read).toEqual({
      ok: false,
      problems: [
        "--nodes is a whole number.",
        "--dataset is a dataset id and version like nm000104@1.0.2.",
        "--cores must be at least 1.",
        "--mem is a size like 16G, 512M or 1T.",
        "--time is a duration like 2h, 1h30m or 45m.",
      ],
    });
  });
});

describe("the precedence: flags, then header, then folder file, then defaults", () => {
  const defaults = SPEC_DEFAULTS;

  test("each key takes the first source that has it, and says which", () => {
    const merged = mergeSpecFields({
      flags: { cores: 16 },
      header: { cores: 8, nodes: 2, name: "from-header" },
      file: { cores: 4, nodes: 3, name: "from-file", partition: "compute", gpus: 1 },
      defaults,
    });
    expect(merged.fields).toEqual({
      cores: 16,
      nodes: 2,
      name: "from-header",
      partition: "compute",
      gpus: 1,
      minutes: 60,
    });
    expect(merged.from).toEqual({
      cores: "flag",
      nodes: "header",
      name: "header",
      partition: "file",
      gpus: "file",
      minutes: "default",
    });
  });

  test("a flag beats a header for that key only", () => {
    const merged = mergeSpecFields({
      flags: { minutes: 30 },
      header: { minutes: 90, cores: 8 },
      file: {},
      defaults,
    });
    expect(merged.fields.minutes).toBe(30);
    expect(merged.fields.cores).toBe(8);
  });

  test("a list is replaced whole by the first source that has it, never merged", () => {
    const merged = mergeSpecFields({
      flags: { datasets: [{ id: "nm000104", version: "1.0.2" }] },
      header: { datasets: [{ id: "ds002718", version: "1.0.5" }], args: ["--a"] },
      file: { args: ["--b", "--c"] },
      defaults,
    });
    expect(merged.fields.datasets).toEqual([{ id: "nm000104", version: "1.0.2" }]);
    expect(merged.fields.args).toEqual(["--a"]);
  });

  test("an empty source changes nothing and the defaults fill the rest", () => {
    const merged = mergeSpecFields({ flags: {}, header: {}, file: {}, defaults });
    expect(merged.fields).toEqual({ ...defaults });
    expect(Object.values(merged.from).every((v) => v === "default")).toBe(true);
  });
});

describe("the default name", () => {
  test("is the file's stem, made to fit the name pattern", () => {
    expect(defaultJobName("analysis.py")).toBe("analysis");
    expect(defaultJobName("/x/my script (1).py")).toBe("my script -1");
    expect(defaultJobName("_hidden.py")).toBe("hidden");
    expect(defaultJobName("....py")).toBe("job");
    expect(defaultJobName(`${"a".repeat(200)}.py`)).toHaveLength(80);
  });
});
