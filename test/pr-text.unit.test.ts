/**
 * The words a pull request opened by the CLI carries (`nemar dataset update`, `nemar dataset push
 * --pr`), and the CHANGES entry `update` writes for the version it releases.
 *
 * Three layers, each driven the way production reaches it:
 *
 *  1. The text checks and builders, on strings a person really types: each refusal with the
 *     sentences that trigger it, and beside it the ordinary sentences that must still pass. The
 *     real title of nemarDatasets/nm000456 pull request 1 (a naming rule where the new name
 *     belonged) is one of the refused strings.
 *  2. The parsers and the CHANGES writer, on output from the REAL git. "The entry is one the
 *     review recognizes" is the review's own reader answering (`gatherGitFacts`, the function the
 *     review job runs), not this file's regular expression.
 *  3. The commands, through the real entry point (`bun run src/index.ts`) in a real git
 *     repository with a local bare remote. Only the two boundaries are stood in: the GitHub CLI (a
 *     script that records the arguments of `pr create` and prints a URL) and the NEMAR API (a local
 *     `Bun.serve` answering the reads `update` makes). The CLI runs with a clean environment, no
 *     GitHub token and an empty `gh` configuration directory, so neither stand-in can be bypassed
 *     into a real repository, and the repository the stand-in API names is one that cannot exist.
 *
 * CI TIER: unit-pure. Everything is local and offline.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "bun";
import { gatherGitFacts } from "../scripts/ci/pr-review-evidence";
import {
  type ChangedFile,
  MAX_NAMED_FILES,
  MAX_TITLE_LENGTH,
  TEXT_PROBLEMS,
  type TextKind,
  type TextProblemCode,
  addChangelogEntry,
  buildUpdateBody,
  buildUpdateTitle,
  describeChangelogWrite,
  describeTextProblem,
  findTextProblem,
  hasChangelogHeading,
  localIsoDate,
  normalizeTitle,
  parsePorcelainPaths,
  parseStagedChanges,
  summarizeChangedFiles,
  writeChangelogEntry,
} from "../src/lib/pr-text";

// Each command test starts the CLI (a transpile) and git, and the interactive ones wait on prompts.
setDefaultTimeout(60_000);

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------------------------
// 1. The text checks
// ---------------------------------------------------------------------------------------------

/** The title of nemarDatasets/nm000456 pull request 1: the rule's pattern, not the new name. */
const NM000456_TITLE =
  "Rename dataset to the atlas naming rule FirstAuthorSurname-year-keyword-paperDOI (v1.0.1)";
const SHA256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

/**
 * Every refusal, with the sentences that trigger it, and the ordinary sentences that must still
 * pass beside it. `passes` is run as a title AND as a description. The keys are checked against
 * `TEXT_PROBLEMS`, so a refusal added without a case here fails the suite.
 */
const CASES: Record<TextProblemCode, { refused: [TextKind, string][]; passes: string[] }> = {
  empty: {
    refused: [
      ["title", ""],
      ["title", "   \n\t "],
      ["description", ""],
      ["description", "\n \n"],
    ],
    passes: ["Fixed typo."],
  },
  machine_output: {
    refused: [
      ["title", SHA256],
      ["title", "a1b2c3d"],
      ["title", `sha256:${SHA256}`],
      ["description", '{"Name": "Resting EEG", "Version": "1.0.1"}'],
      ["title", "[1, 2, 3]"],
    ],
    passes: [
      `Fix checksum ${SHA256} mismatch`,
      "Defaced", // only hex letters: a word, not a digest
      '"Fix the thing"', // a JSON string is a sentence in quotes
      "[Fix] typos in [participants.tsv]", // brackets at both ends, and not JSON
    ],
  },
  placeholder: {
    refused: [
      ["title", "Save changes"],
      ["title", "SAVE CHANGES."],
      ["title", "Update from branch update/nm000456-mvauf3hk"],
      ["title", "Update nm000104 to v1.0.1"],
      ["description", "Update xx090001 to 2.0.0"],
      ["title", "TBD"],
      ["description", "n/a"],
      ["description", "Lorem ipsum dolor sit amet"],
      ["title", "title"],
    ],
    passes: [
      "Save changes to the channel locations after re-digitizing",
      "Update nm000104 documentation after the reanalysis",
      "Update from the original recordings, which fixes the sampling rate",
      "Test the new epoching parameters on sub-01",
    ],
  },
  template_field: {
    refused: [
      ["title", NM000456_TITLE],
      ["title", "Add {{title}} data"],
      ["title", "Add ${N} subjects"],
      ["title", "<your title here>"],
      ["description", "[describe the change]"],
      ["description", "FirstAuthorSurname"],
    ],
    passes: [
      // BIDS field and label names are CamelCase by specification: the vocabulary of an update.
      "Set PowerLineFrequency to 50 in every EEG sidecar",
      "Add DatasetDOI to dataset_description.json",
      "Rename task-RestingStateEyesClosed to task-restEC in all events files",
      // Brackets that name a BIDS label do not ask the reader to write anything.
      "Rename files to sub-<label>_task-<label>_eeg.edf",
      "[WIP] Add sub-21 recordings",
      "Remove the {} left in the README",
    ],
  },
  no_words: {
    refused: [
      ["title", "..."],
      ["title", "v1.0.1"],
      ["description", "12345"],
      ["title", "x y z"],
      ["description", "🙂🙂🙂"],
    ],
    passes: ["Fixes #12", "更新数据", "Añadir doce sujetos"],
  },
  too_long: {
    refused: [["title", "Add recordings ".repeat(14)]],
    passes: ["Add twelve subjects with resting-state EEG recordings"],
  },
};

describe("findTextProblem", () => {
  test("every refusal has a case here", () => {
    expect(Object.keys(CASES).sort()).toEqual([...TEXT_PROBLEMS].sort());
  });

  for (const [code, { refused, passes }] of Object.entries(CASES) as [
    TextProblemCode,
    (typeof CASES)[TextProblemCode],
  ][]) {
    describe(code, () => {
      for (const [kind, text] of refused) {
        test(`refuses the ${kind} ${JSON.stringify(text.slice(0, 50))}`, () => {
          expect(findTextProblem(kind, text)?.code).toBe(code);
        });
      }
      for (const text of passes) {
        test(`passes the ordinary sentence ${JSON.stringify(text.slice(0, 60))}`, () => {
          expect(findTextProblem("title", text)).toBeNull();
          expect(findTextProblem("description", text)).toBeNull();
        });
      }
    });
  }

  test("text that was never given is empty", () => {
    expect(findTextProblem("title", undefined)?.code).toBe("empty");
    expect(findTextProblem("description", undefined)?.code).toBe("empty");
  });

  test("a title is judged as the one line it becomes", () => {
    // Two lines that are each fine, and one that is a placeholder once joined, are one title.
    expect(findTextProblem("title", "Add twelve subjects\nwith EEG recordings")).toBeNull();
    expect(normalizeTitle("  Add   twelve\nsubjects\t(v2) ")).toBe("Add twelve subjects (v2)");
  });

  test("a title may be exactly as long as the limit and no longer", () => {
    // 39 four-letter words and a space after each, then a last word that decides the length.
    const stem = "word ".repeat(39);
    const atLimit = `${stem}${"w".repeat(MAX_TITLE_LENGTH - stem.length)}`;
    expect(atLimit).toHaveLength(MAX_TITLE_LENGTH);
    expect(findTextProblem("title", atLimit)).toBeNull();
    const over = `${atLimit}w`;
    expect(over).toHaveLength(MAX_TITLE_LENGTH + 1);
    expect(findTextProblem("title", over)?.code).toBe("too_long");
  });

  test("a description has no length limit", () => {
    expect(findTextProblem("description", "Adds new recordings. ".repeat(500))).toBeNull();
  });

  test("a placeholder is refused as a description too, and says which text it saw", () => {
    const problem = findTextProblem("description", "Save changes");
    expect(problem?.code).toBe("placeholder");
    if (!problem) throw new Error("expected a problem");
    expect(describeTextProblem("The description (--description)", problem)).toBe(
      'The description (--description) is placeholder text ("Save changes"); say what actually changed.',
    );
  });

  test("the nm000456 title names the field it left unfilled", () => {
    const problem = findTextProblem("title", NM000456_TITLE);
    expect(problem?.reason).toContain('"FirstAuthorSurname"');
  });
});

// ---------------------------------------------------------------------------------------------
// Real git, for everything that reads or writes a repository
// ---------------------------------------------------------------------------------------------

let root: string;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.org",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.org",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** git's output untouched: `-z` output has meaning in its NULs and its leading spaces. */
function gitRaw(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

function git(dir: string, ...args: string[]): string {
  return gitRaw(dir, ...args).trim();
}

function write(dir: string, rel: string, content: string) {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function desc(version: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify(
    { Name: "Resting EEG of volunteers", BIDSVersion: "1.9.0", Version: version, ...extra },
    null,
    2,
  )}\n`;
}

let counter = 0;
function fresh(prefix: string): string {
  counter += 1;
  return join(root, `${prefix}-${counter}`);
}

/** A repository on `main` with one commit holding `files`. */
function makeRepo(files: Record<string, string>): string {
  const dir = fresh("repo");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pr-text-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// 2. The parsers, on what git really prints
// ---------------------------------------------------------------------------------------------

describe("the changed-file parsers", () => {
  test("the first changed path keeps its first character (nm000456 pull request 1)", () => {
    const dir = makeRepo({ "dataset_description.json": desc("1.0.0"), "README.md": "# x\n" });
    // A change in the work tree only: git reports it as " M dataset_description.json".
    write(dir, "dataset_description.json", desc("1.0.0", { Name: "Renamed" }));

    const raw = gitRaw(dir, "status", "--porcelain", "-z");
    expect(raw.startsWith(" M dataset_description.json\0")).toBe(true);
    expect(parsePorcelainPaths(raw)).toEqual(["dataset_description.json"]);

    // The reading this replaced, on this very repository: it trimmed the output as a block, which
    // removed the leading space of the first line only, and cut every line at its third character.
    // Kept to show the fixture is the case that broke it, so this test can fail.
    const replaced = gitRaw(dir, "status", "--porcelain")
      .trim()
      .split("\n")
      .map((line) => line.substring(3).trim());
    expect(replaced).toEqual(["ataset_description.json"]);
  });

  test("porcelain paths: modified, staged, untracked, deleted, renamed, odd names", () => {
    const dir = makeRepo({
      "dataset_description.json": desc("1.0.0"),
      "participants.tsv": "participant_id\nsub-01\n",
      "old name.tsv": "a\n",
      "gone.tsv": "b\n",
    });
    write(dir, "dataset_description.json", desc("1.0.0", { Name: "Renamed" })); // unstaged
    git(dir, "mv", "old name.tsv", "été run.tsv"); // staged rename
    rmSync(join(dir, "gone.tsv")); // unstaged delete
    write(dir, "sub-02/eeg/sub-02_task-rest_eeg.json", "{}\n"); // untracked, in a new directory
    write(dir, "new file.tsv", "c\n");
    git(dir, "add", "new file.tsv"); // staged add

    const paths = parsePorcelainPaths(gitRaw(dir, "status", "--porcelain", "-z")).sort();
    expect(paths).toEqual(
      ["dataset_description.json", "gone.tsv", "new file.tsv", "sub-02/", "été run.tsv"].sort(),
    );
    // A rename is the new path once: its original is not a changed path of its own.
    expect(paths).not.toContain("old name.tsv");
  });

  test("staged changes: added, modified and removed, with names git would quote", () => {
    const dir = makeRepo({
      "dataset_description.json": desc("1.0.0"),
      "gone.tsv": "b\n",
      "kept.tsv": "k\n",
    });
    write(dir, "dataset_description.json", desc("1.0.1"));
    rmSync(join(dir, "gone.tsv"));
    write(dir, "sub-03/été run.tsv", "x\n");
    write(dir, "CHANGES", "1.0.1 2026-10-16\n");
    git(dir, "add", "-A");

    const staged = parseStagedChanges(
      gitRaw(dir, "diff", "--cached", "--name-status", "-z", "--no-renames"),
    );
    expect([...staged].sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual([
      { status: "added", path: "CHANGES" },
      { status: "modified", path: "dataset_description.json" },
      { status: "removed", path: "gone.tsv" },
      { status: "added", path: "sub-03/été run.tsv" },
    ]);
  });

  test("a rename reported with its two paths reads as the file that exists now", () => {
    const dir = makeRepo({
      "participants.tsv": "participant_id\nsub-01\nsub-02\n",
      "a.tsv": "z\n",
    });
    git(dir, "mv", "participants.tsv", "participants_v2.tsv");
    // No `--no-renames`: git pairs the two paths and prints "R100", the old path, the new path.
    const raw = gitRaw(dir, "diff", "--cached", "--name-status", "-z");
    expect(raw.startsWith("R100\0participants.tsv\0participants_v2.tsv\0")).toBe(true);
    expect(parseStagedChanges(raw)).toEqual([{ status: "modified", path: "participants_v2.tsv" }]);
  });

  test("nothing staged is no files", () => {
    expect(parseStagedChanges("")).toEqual([]);
    expect(parsePorcelainPaths("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The text the CLI builds around the author's
// ---------------------------------------------------------------------------------------------

function filesNamed(status: ChangedFile["status"], paths: string[]): ChangedFile[] {
  return paths.map((path) => ({ status, path }));
}

describe("the changed-file summary", () => {
  test("a short list is named, with what happened to each file", () => {
    const files: ChangedFile[] = [
      { status: "modified", path: "participants.tsv" },
      { status: "added", path: "CHANGES" },
      { status: "removed", path: "sub-01/eeg/old.tsv" },
    ];
    expect(summarizeChangedFiles(files)).toBe(
      [
        "- `CHANGES` (added)",
        "- `participants.tsv` (modified)",
        "- `sub-01/eeg/old.tsv` (removed)",
      ].join("\n"),
    );
  });

  test("up to the limit is named; one more is a summary", () => {
    const paths = Array.from({ length: MAX_NAMED_FILES + 1 }, (_, i) => `sub-01/f${i}.tsv`);
    const atLimit = summarizeChangedFiles(filesNamed("added", paths.slice(0, MAX_NAMED_FILES)));
    expect(atLimit.split("\n")).toHaveLength(MAX_NAMED_FILES);
    expect(atLimit).toContain("`sub-01/f0.tsv` (added)");

    const over = summarizeChangedFiles(filesNamed("added", paths));
    expect(over).toContain("21 files changed: 21 added.");
    expect(over).not.toContain("f0.tsv");
  });

  test("a long list is a total, the files at the root by name, and a count per folder", () => {
    const files: ChangedFile[] = [
      ...filesNamed(
        "added",
        Array.from({ length: 30 }, (_, i) => `sub-01/eeg/sub-01_run-${i}_eeg.edf`),
      ),
      ...filesNamed(
        "modified",
        Array.from({ length: 5 }, (_, i) => `sub-02/eeg/sub-02_ch-${i}_channels.tsv`),
      ),
      { status: "modified", path: "dataset_description.json" },
      { status: "added", path: "CHANGES" },
    ];
    const summary = summarizeChangedFiles(files);
    expect(summary).toBe(
      [
        "37 files changed: 31 added, 6 modified.",
        "",
        "- `CHANGES` (added)",
        "- `dataset_description.json` (modified)",
        "- `sub-01/`: 30 files (30 added)",
        "- `sub-02/`: 5 files (5 modified)",
      ].join("\n"),
    );
    // Never the paths inside a folder: a bulk change must not bury the author's sentence.
    expect(summary).not.toContain("run-");
  });

  test("hundreds of folders stay a few lines", () => {
    const paths = Array.from({ length: 300 }, (_, i) => `sub-${String(i).padStart(3, "0")}/x.tsv`);
    const lines = summarizeChangedFiles(filesNamed("added", paths)).split("\n");
    expect(lines[0]).toBe("300 files changed: 300 added.");
    expect(lines[2]).toBe("- `sub-000/`: 1 file (1 added)");
    expect(lines[11]).toBe("- `sub-009/`: 1 file (1 added)");
    expect(lines[12]).toBe("- and 290 more folders (290 files)");
    expect(lines).toHaveLength(13);
  });

  test("files at the root beyond the limit are counted, not dumped", () => {
    const root25 = Array.from({ length: 25 }, (_, i) => `file-${String(i).padStart(2, "0")}.txt`);
    const summary = summarizeChangedFiles([
      ...filesNamed("added", root25),
      ...filesNamed("added", ["sub-01/a.tsv"]),
    ]);
    expect(summary).toContain("`file-19.txt` (added)");
    expect(summary).not.toContain("file-20.txt");
    expect(summary).toContain("- and 5 more files at the dataset root");
  });

  test("a path cannot break out of its code span or its line", () => {
    const summary = summarizeChangedFiles([{ status: "added", path: "odd`name\nsecond line.tsv" }]);
    expect(summary).toBe("- `odd?name?second line.tsv` (added)");
  });
});

describe("the pull request title and body of an update", () => {
  test("the title is the author's, then the version", () => {
    expect(buildUpdateTitle("Add twelve subjects", "1.0.1")).toBe("Add twelve subjects (v1.0.1)");
  });

  test("the body is the author's words, the version, and the accurate file list", () => {
    const body = buildUpdateBody({
      description: "  Adds sub-03 with a resting-state recording.  ",
      datasetId: "nm000456",
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
      files: [
        { status: "modified", path: "dataset_description.json" },
        { status: "added", path: "CHANGES" },
      ],
    });
    expect(body).toBe(
      [
        "Adds sub-03 with a resting-state recording.",
        "",
        "Bumps nm000456 from 1.0.0 to 1.0.1.",
        "",
        "### Changed files",
        "",
        "- `CHANGES` (added)",
        "- `dataset_description.json` (modified)",
      ].join("\n"),
    );
    // What the body of that pull request said before: a heading that says nothing, and a path
    // missing its first letter.
    expect(body).not.toContain("## Dataset Update");
    expect(body).not.toContain("ataset_description.json\n");
  });
});

// ---------------------------------------------------------------------------------------------
// The CHANGES entry
// ---------------------------------------------------------------------------------------------

describe("hasChangelogHeading", () => {
  const headings = [
    "1.0.1 2026-10-16",
    "## 1.0.1",
    "[1.0.1] - 2026-10-16",
    "## [1.0.1]",
    "v1.0.1",
    "Version 1.0.1:",
    "release 1.0.1",
    "  1.0.1",
  ];
  const notHeadings = [
    "  - 1.0.1 fixed the sidecars",
    "1.0.10 2026-10-16",
    "1.0.1-beta",
    "1.0.1.2",
    "released 1.0.1 yesterday",
    "2026-10-16",
    "version history",
  ];
  for (const line of headings) {
    test(`${JSON.stringify(line)} is a heading for 1.0.1`, () => {
      expect(hasChangelogHeading(`1.0.0 2026-01-01\n${line}\n`, "1.0.1")).toBe(true);
    });
  }
  for (const line of notHeadings) {
    test(`${JSON.stringify(line)} is not a heading for 1.0.1`, () => {
      expect(hasChangelogHeading(`1.0.0 2026-01-01\n${line}\n`, "1.0.1")).toBe(false);
    });
  }
});

describe("addChangelogEntry", () => {
  const add = (existing: string | null) =>
    addChangelogEntry(existing, "1.0.1", "Add subject 03", "2026-10-16");

  test("a new log is the heading, a blank line and the author's title", () => {
    expect(add(null)).toBe("1.0.1 2026-10-16\n\n  - Add subject 03\n");
    expect(add("")).toBe("1.0.1 2026-10-16\n\n  - Add subject 03\n");
    expect(add("\n \n")).toBe("1.0.1 2026-10-16\n\n  - Add subject 03\n");
  });

  test("the newest entry goes first and the older ones are untouched", () => {
    expect(add("1.0.0 2026-01-01\n  - Initial release\n")).toBe(
      "1.0.1 2026-10-16\n\n  - Add subject 03\n\n1.0.0 2026-01-01\n  - Initial release\n",
    );
  });

  test("a title line above the entries stays above them", () => {
    expect(add("Revision history for the dataset\n\n1.0.0 2026-01-01\n  - Initial release\n")).toBe(
      "Revision history for the dataset\n\n1.0.1 2026-10-16\n\n  - Add subject 03\n\n1.0.0 2026-01-01\n  - Initial release\n",
    );
  });

  test("a log with no version heading gets the entry on top and keeps its text", () => {
    expect(add("Notes from the lab\n")).toBe(
      "1.0.1 2026-10-16\n\n  - Add subject 03\n\nNotes from the lab\n",
    );
  });

  test("a log with Windows line endings keeps them", () => {
    expect(add("1.0.0 2026-01-01\r\n  - Initial release\r\n")).toBe(
      "1.0.1 2026-10-16\r\n\r\n  - Add subject 03\r\n\r\n1.0.0 2026-01-01\r\n  - Initial release\r\n",
    );
  });

  test("the date is the author's calendar day", () => {
    expect(localIsoDate(new Date(2026, 9, 16, 23, 59, 59))).toBe("2026-10-16");
    expect(localIsoDate(new Date(2026, 0, 5, 0, 0, 1))).toBe("2026-01-05");
  });
});

describe("writeChangelogEntry", () => {
  function dirWith(files: Record<string, string>): string {
    const dir = fresh("changes");
    mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
    return dir;
  }
  const entry = (dir: string) => writeChangelogEntry(dir, "1.0.1", "Add subject 03", "2026-10-16");

  test("creates CHANGES when the dataset has none", () => {
    const dir = dirWith({ "README.md": "# x\n" });
    expect(entry(dir)).toEqual({ file: "CHANGES", outcome: "created" });
    expect(readFileSync(join(dir, "CHANGES"), "utf8")).toBe(
      "1.0.1 2026-10-16\n\n  - Add subject 03\n",
    );
  });

  test("adds to the CHANGES that is there", () => {
    const dir = dirWith({ CHANGES: "1.0.0 2026-01-01\n  - Initial release\n" });
    expect(entry(dir)).toEqual({ file: "CHANGES", outcome: "added" });
    expect(readFileSync(join(dir, "CHANGES"), "utf8")).toBe(
      "1.0.1 2026-10-16\n\n  - Add subject 03\n\n1.0.0 2026-01-01\n  - Initial release\n",
    );
  });

  test("writes into CHANGES.md when that is the dataset's change log, and creates nothing else", () => {
    const dir = dirWith({ "CHANGES.md": "## 1.0.0\n- Initial release\n" });
    expect(entry(dir)).toEqual({ file: "CHANGES.md", outcome: "added" });
    expect(existsSync(join(dir, "CHANGES"))).toBe(false);
    expect(readFileSync(join(dir, "CHANGES.md"), "utf8").startsWith("1.0.1 2026-10-16\n")).toBe(
      true,
    );
  });

  test("prefers CHANGES to CHANGELOG.md when a dataset has both", () => {
    const dir = dirWith({ CHANGES: "1.0.0 2026-01-01\n", "CHANGELOG.md": "# Log\n" });
    expect(entry(dir).file).toBe("CHANGES");
  });

  test("an entry the author already wrote is left exactly as it is", () => {
    const authored = "1.0.1 2026-10-15\n\n  - Added subject 03 myself.\n\n1.0.0 2026-01-01\n";
    const dir = dirWith({ CHANGES: authored });
    expect(entry(dir)).toEqual({ file: "CHANGES", outcome: "present" });
    expect(readFileSync(join(dir, "CHANGES"), "utf8")).toBe(authored);
  });

  test("an entry in any change log counts, as the review reads them all as one", () => {
    const dir = dirWith({ CHANGES: "1.0.0 2026-01-01\n", "CHANGELOG.md": "## 1.0.1\n- Done.\n" });
    expect(entry(dir).outcome).toBe("present");
    expect(readFileSync(join(dir, "CHANGES"), "utf8")).toBe("1.0.0 2026-01-01\n");
  });

  test("refuses a change log that is a directory, rather than writing beside it", () => {
    const dir = dirWith({ "CHANGES/keep.txt": "x\n" });
    expect(() => entry(dir)).toThrow("CHANGES exists but is not a regular file");
  });

  test("refuses a change log that is a symbolic link, rather than writing through it", () => {
    const dir = dirWith({ "target.txt": "1.0.0 2026-01-01\n" });
    symlinkSync(join(dir, "target.txt"), join(dir, "CHANGES"));
    expect(() => entry(dir)).toThrow("CHANGES exists but is not a regular file");
    expect(readFileSync(join(dir, "target.txt"), "utf8")).toBe("1.0.0 2026-01-01\n");
  });

  test("says in a line what it did", () => {
    expect(describeChangelogWrite({ file: "CHANGES", outcome: "created" }, "1.0.1")).toBe(
      "Created CHANGES with an entry for 1.0.1",
    );
    expect(describeChangelogWrite({ file: "CHANGES", outcome: "added" }, "1.0.1")).toBe(
      "Added an entry for 1.0.1 to CHANGES",
    );
    expect(describeChangelogWrite({ file: "CHANGES.md", outcome: "present" }, "1.0.1")).toBe(
      "CHANGES.md already has an entry for 1.0.1; left as it is",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The review reads what the writer wrote
// ---------------------------------------------------------------------------------------------

describe("the review's own reader on a pull request update would open", () => {
  /** What `update` does to a clone on `main`: branch, bump, write the entry, stage, commit. */
  function updateAsTheCliDoes(dir: string): { base: string; head: string } {
    const base = git(dir, "rev-parse", "main");
    git(dir, "checkout", "-q", "-b", "update/x");
    write(dir, "dataset_description.json", desc("1.0.1"));
    writeChangelogEntry(dir, "1.0.1", "Add subject 03", "2026-10-16");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "Add subject 03");
    return { base, head: git(dir, "rev-parse", "HEAD") };
  }

  const base = { "dataset_description.json": desc("1.0.0"), "README.md": "# x\n" };

  const scenarios: [string, Record<string, string>][] = [
    ["no change log at all", base],
    ["an empty CHANGES", { ...base, CHANGES: "" }],
    [
      "a CHANGES with earlier entries",
      { ...base, CHANGES: "1.0.0 2026-01-01\n - Initial release\n" },
    ],
    ["only a CHANGES.md", { ...base, "CHANGES.md": "## 1.0.0\n- Initial release\n" }],
    [
      "a title above the entries",
      { ...base, CHANGES: "Revision history\n\n1.0.0 2026-01-01\n  - Initial release\n" },
    ],
    ["Windows line endings", { ...base, CHANGES: "1.0.0 2026-01-01\r\n  - Initial release\r\n" }],
  ];

  for (const [name, files] of scenarios) {
    test(`${name}: the review sees a new heading for the version`, () => {
      const dir = makeRepo(files);
      const { base: baseSha, head } = updateAsTheCliDoes(dir);
      const facts = gatherGitFacts(dir, baseSha, head);
      expect(facts.changelogEntry).toBe("added");
      expect(facts.changelogTouched).toBe(true);
      expect(facts.versionBefore).toBe("1.0.0");
      expect(facts.versionAfter).toBe("1.0.1");
    });
  }

  test("an entry the author wrote first is the one the review sees", () => {
    const dir = makeRepo({ ...base, CHANGES: "1.0.0 2026-01-01\n  - Initial release\n" });
    const baseSha = git(dir, "rev-parse", "main");
    git(dir, "checkout", "-q", "-b", "update/x");
    const authored = "1.0.1 2026-10-15\n\n  - Added subject 03 myself.\n\n1.0.0 2026-01-01\n";
    write(dir, "CHANGES", authored);
    write(dir, "dataset_description.json", desc("1.0.1"));
    expect(writeChangelogEntry(dir, "1.0.1", "Add subject 03", "2026-10-16").outcome).toBe(
      "present",
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "Add subject 03");
    const facts = gatherGitFacts(dir, baseSha, git(dir, "rev-parse", "HEAD"));
    expect(facts.changelogEntry).toBe("added");
    expect(readFileSync(join(dir, "CHANGES"), "utf8")).toBe(authored);
  });

  test("control: without the entry the same review says it is missing", () => {
    // The reader is not saying "added" for everything: bump the version and write nothing.
    const withLog = makeRepo({ ...base, CHANGES: "1.0.0 2026-01-01\n  - Initial release\n" });
    const withoutLog = makeRepo(base);
    for (const [dir, expected] of [
      [withLog, "not_added"],
      [withoutLog, "no_file"],
    ] as const) {
      const baseSha = git(dir, "rev-parse", "main");
      git(dir, "checkout", "-q", "-b", "update/x");
      write(dir, "dataset_description.json", desc("1.0.1"));
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "bump");
      expect(gatherGitFacts(dir, baseSha, git(dir, "rev-parse", "HEAD")).changelogEntry).toBe(
        expected,
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The commands, through the real entry point
// ---------------------------------------------------------------------------------------------

const DATASET_ID = "xx000000"; // two letters and six digits, and in no band a dataset is given
const STANDIN_REPO = "nemar-pr-text-standin/xx000000"; // a repository that is not there

let binDir: string;
let ghRecord: string;
let api: ReturnType<typeof Bun.serve>;
let apiPaths: string[] = [];

const GH_STANDIN = `#!/bin/sh
# Stands in for the GitHub CLI: answers the version probe, records \`pr create\`, prints a URL.
if [ "$1" = "--version" ]; then echo "gh version 0.0.0 (stand-in)"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  printf '%s\\0' "$@" > "$STANDIN_GH_RECORD"
  echo "https://github.invalid/standin/pull/1"
  exit 0
fi
echo "stand-in gh: unexpected arguments: $*" >&2
exit 2
`;

beforeAll(() => {
  binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "gh"), GH_STANDIN);
  chmodSync(join(binDir, "gh"), 0o755);
  ghRecord = join(root, "gh-record");

  api = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      apiPaths.push(path);
      if (path === "/notices") return Response.json({ notices: [] });
      if (path === `/datasets/${DATASET_ID}`) {
        return Response.json({
          dataset: {
            id: 1,
            dataset_id: DATASET_ID,
            name: "A dataset the stand-in API describes",
            description: null,
            owner_username: "standin",
            status: "active",
            visibility: "public",
            github_repo: STANDIN_REPO,
            concept_doi: null,
            created_at: "2026-01-01",
          },
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
});

afterAll(() => {
  api.stop(true);
});

function apiUrl(): string {
  return api.url.toString().replace(/\/$/, "");
}

/** A configuration directory: signed in as a stand-in account, or pointing at the stand-in API only. */
function configDir(signedIn: boolean): string {
  const dir = fresh("config");
  mkdirSync(dir, { recursive: true });
  const account = signedIn
    ? { apiKey: "standin-key-0123456789abcdef", apiUrl: apiUrl() }
    : { apiUrl: apiUrl() };
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ activeAccount: "standin", accounts: { standin: account } }),
  );
  return dir;
}

/** What the CLI is run with: nothing inherited that could point it at a real service or account. */
function cleanEnv(config: string, term = "dumb"): Record<string, string> {
  return {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME ?? root,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    NEMAR_CONFIG_DIR: config,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    TERM: term,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.org",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.org",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GH_CONFIG_DIR: join(root, "gh-config"),
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    STANDIN_GH_RECORD: ghRecord,
  };
}

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The CLI, with no terminal on stdin, as a script or CI runs it. */
async function runNemar(args: string[], cwd: string, config = configDir(true)): Promise<Run> {
  rmSync(ghRecord, { force: true });
  apiPaths = [];
  const proc = spawn({
    cmd: [process.execPath, "run", CLI_ENTRY, ...args],
    cwd,
    env: cleanEnv(config),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** The arguments the stand-in `gh` was run with for `pr create`, or null if it never was. */
function ghArgs(): string[] | null {
  if (!existsSync(ghRecord)) return null;
  return readFileSync(ghRecord, "utf8").split("\0").slice(0, -1);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
}

/** A dataset clone on `main` at 1.0.0, with a local bare remote named like a dataset repository. */
function newClone(): { work: string; remote: string } {
  const base = fresh("clone");
  const remote = join(base, "remote", `${DATASET_ID}.git`);
  const work = join(base, "work");
  mkdirSync(remote, { recursive: true });
  mkdirSync(work, { recursive: true });
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(work, "init", "-q", "-b", "main");
  write(work, "dataset_description.json", desc("1.0.0"));
  write(work, "README.md", "# Resting EEG\n");
  write(work, "participants.tsv", "participant_id\nsub-01\nsub-02\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "initial");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-q", "-u", "origin", "main");
  return { work, remote };
}

const GOOD_TITLE = "Add subject 03 and rename the dataset";
const GOOD_DESCRIPTION =
  "Adds sub-03 with a resting-state recording and gives the dataset its final name.";

describe("nemar dataset update shows the new options", () => {
  test("--help names the title and the description as required", async () => {
    const { stdout, exitCode } = await runNemar(["dataset", "update", "--help"], REPO_ROOT);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("-m, --message <title>");
    expect(stdout).toContain("--description <text>");
    expect(stdout).toContain("(required)");
  });
});

describe("nemar dataset update refuses before it does anything", () => {
  const signedOut = () => configDir(false);

  /** Output as a person would see it: stdout and stderr together. */
  const said = (r: Run) => r.stdout + r.stderr;

  test("refuses to run under --yes without a description", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(["dataset", "update", "--yes", "-m", GOOD_TITLE], cwd, signedOut());
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain("needs a pull request title and description; missing --description.");
    expect(said(r)).toContain("--yes does not stand in for them");
    expect(said(r)).toContain('Example: nemar dataset update -m "');
    // Refused first: not "Not authenticated", not a repository error, and no request but the notice.
    expect(said(r)).not.toContain("Not authenticated");
    expect(said(r)).not.toContain("Not a git repository");
    expect(apiPaths.filter((p) => p !== "/notices")).toEqual([]);
    // A refusal of what was typed is not a bug, so no invitation to file one.
    expect(r.stderr).not.toContain("attach the log");
  });

  test("refuses under --yes without a title", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(
      ["dataset", "update", "--yes", "--description", GOOD_DESCRIPTION],
      cwd,
      signedOut(),
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain("missing --message.");
  });

  test("names both when both are missing", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(["dataset", "update", "--yes"], cwd, signedOut());
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain("missing --message and --description.");
  });

  test("refuses without a terminal even when --yes is not given", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(["dataset", "update"], cwd, signedOut());
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain("missing --message and --description.");
    expect(said(r)).toContain("without a terminal nothing can ask for them");
  });

  test("refuses the CLI's own placeholder, and says so", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(
      ["dataset", "update", "--yes", "-m", "Save changes", "--description", GOOD_DESCRIPTION],
      cwd,
      signedOut(),
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain(
      'The title (--message) is placeholder text ("Save changes"); say what actually changed.',
    );
    expect(said(r)).not.toContain("The description");
  });

  test("refuses the title of nm000456 pull request 1", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(
      ["dataset", "update", "--yes", "-m", NM000456_TITLE, "--description", GOOD_DESCRIPTION],
      cwd,
      signedOut(),
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain('still has an unfilled template field ("FirstAuthorSurname")');
  });

  test("an empty description is text that was given and got wrong, not text left out", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(
      ["dataset", "update", "--yes", "-m", GOOD_TITLE, "--description", ""],
      cwd,
      signedOut(),
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain("The description (--description) is empty");
    expect(said(r)).not.toContain("missing");
  });

  test("control: readable text gets past the check and meets the next one, sign-in", async () => {
    const cwd = fresh("empty");
    mkdirSync(cwd, { recursive: true });
    const r = await runNemar(
      ["dataset", "update", "--yes", "-m", GOOD_TITLE, "--description", GOOD_DESCRIPTION],
      cwd,
      signedOut(),
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain("Not authenticated");
    expect(said(r)).not.toContain("pull request title and description");
  });
});

describe("nemar dataset update opens a pull request a person can read", () => {
  test("title, CHANGES entry, commit and body all carry the author's words", async () => {
    const { work, remote } = newClone();
    // A change in the work tree only comes first in git's list: the case that lost a letter.
    write(work, "dataset_description.json", desc("1.0.0", { Name: "Resting EEG, final name" }));
    write(work, "sub-03/eeg/sub-03_task-rest_eeg.json", '{"TaskName": "rest"}\n');

    const before = localIsoDate(new Date());
    const r = await runNemar(
      [
        "dataset",
        "update",
        "--yes",
        "--branch",
        "update/pr-text-test",
        "-m",
        GOOD_TITLE,
        "--description",
        GOOD_DESCRIPTION,
      ],
      work,
    );
    const after = localIsoDate(new Date());
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);

    // The file list the person sees before confirming has every path whole.
    expect(r.stdout).toMatch(/^ {4}dataset_description\.json$/m);
    expect(r.stdout).not.toMatch(/^ {4}ataset_description\.json$/m);
    expect(r.stdout).toContain("Created CHANGES with an entry for 1.0.1");
    expect(r.stdout).toContain("https://github.invalid/standin/pull/1");

    // The pull request, as the GitHub CLI was asked to open it.
    const args = ghArgs();
    expect(args?.slice(0, 2)).toEqual(["pr", "create"]);
    expect(valueAfter(args ?? [], "--repo")).toBe(STANDIN_REPO);
    expect(valueAfter(args ?? [], "--head")).toBe("update/pr-text-test");
    expect(valueAfter(args ?? [], "--base")).toBe("main");
    expect(valueAfter(args ?? [], "--title")).toBe(`${GOOD_TITLE} (v1.0.1)`);
    expect(valueAfter(args ?? [], "--body")).toBe(
      [
        GOOD_DESCRIPTION,
        "",
        `Bumps ${DATASET_ID} from 1.0.0 to 1.0.1.`,
        "",
        "### Changed files",
        "",
        "- `CHANGES` (added)",
        "- `dataset_description.json` (modified)",
        "- `sub-03/eeg/sub-03_task-rest_eeg.json` (added)",
      ].join("\n"),
    );

    // The branch is on the remote, with the author's title as the commit and the entry in CHANGES.
    expect(git(remote, "rev-parse", "--verify", "refs/heads/update/pr-text-test")).toMatch(
      /^[0-9a-f]{40}$/,
    );
    expect(git(work, "log", "-1", "--format=%s", "update/pr-text-test")).toBe(GOOD_TITLE);
    const changes = git(work, "show", "update/pr-text-test:CHANGES");
    const dated = changes.match(/^1\.0\.1 (\d{4}-\d{2}-\d{2})\n\n {2}- (.*)$/);
    expect(dated?.[2]).toBe(GOOD_TITLE);
    // The author's calendar day, which may roll over between `before` and `after` at midnight.
    expect([before, after].includes(dated?.[1] ?? "")).toBe(true);
    const written = JSON.parse(git(work, "show", "update/pr-text-test:dataset_description.json"));
    expect(written.Version).toBe("1.0.1");
    expect(written.Name).toBe("Resting EEG, final name");

    // And the review's own reader finds the entry.
    const facts = gatherGitFacts(
      work,
      git(work, "rev-parse", "main"),
      git(work, "rev-parse", "update/pr-text-test"),
    );
    expect(facts.changelogEntry).toBe("added");
  });

  test("a bulk change is summarized by folder, not dumped as paths", async () => {
    const { work } = newClone();
    for (let i = 0; i < 25; i++) {
      write(work, `sub-04/eeg/sub-04_run-${i}_eeg.json`, "{}\n");
    }
    const r = await runNemar(
      [
        "dataset",
        "update",
        "--yes",
        "--branch",
        "update/pr-text-bulk",
        "-m",
        "Add subject 04",
        "--description",
        "Adds the 25 runs of sub-04.",
      ],
      work,
    );
    expect(r.exitCode).toBe(0);
    const body = valueAfter(ghArgs() ?? [], "--body") ?? "";
    expect(body).toContain("27 files changed: 26 added, 1 modified.");
    expect(body).toContain("- `CHANGES` (added)");
    expect(body).toContain("- `dataset_description.json` (modified)");
    expect(body).toContain("- `sub-04/`: 25 files (25 added)");
    expect(body).not.toContain("run-");
  });
});

/** A git-annex clone on a feature branch with one commit nobody has pushed, and an empty remote. */
function newAnnexFeatureClone(): { work: string; remote: string } {
  const base = fresh("annex");
  const remote = join(base, "remote");
  const work = join(base, "work");
  mkdirSync(remote, { recursive: true });
  mkdirSync(work, { recursive: true });
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(work, "init", "-q", "-b", "main");
  git(work, "annex", "init", "test-repo");
  write(work, "README.md", "# Resting EEG\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "initial");
  git(work, "remote", "add", "origin", remote);
  git(work, "checkout", "-q", "-b", "feature/new-recordings");
  write(work, "participants.tsv", "participant_id\nsub-01\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "add participants");
  return { work, remote };
}

describe("nemar dataset push shows the new options", () => {
  test("--help names the title and the body as required with --pr", async () => {
    const { stdout, exitCode } = await runNemar(["dataset", "push", "--help"], REPO_ROOT);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("-t, --title <title>");
    expect(stdout).toContain("-b, --body <body>");
    expect(stdout).toContain("required");
  });
});

describe("nemar dataset push --pr settles the text before it pushes", () => {
  const said = (r: Run) => r.stdout + r.stderr;
  const pushed = (remote: string) => git(remote, "for-each-ref", "refs/heads");

  test("refuses without a title and a body, and pushes nothing", async () => {
    const { work, remote } = newAnnexFeatureClone();
    const r = await runNemar(["dataset", "push", "--pr", "--no-s3"], work);
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain(
      "nemar dataset push --pr needs a pull request title and description; missing --title and --body.",
    );
    expect(said(r)).toContain("Without a terminal nothing can ask for them.");
    expect(pushed(remote)).toBe("");
    expect(ghArgs()).toBeNull();
  });

  test("refuses the placeholder title this command used to write", async () => {
    const { work, remote } = newAnnexFeatureClone();
    const r = await runNemar(
      [
        "dataset",
        "push",
        "--pr",
        "--no-s3",
        "-t",
        "Update from branch feature/new-recordings",
        "-b",
        GOOD_DESCRIPTION,
      ],
      work,
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain("The title (--title) is placeholder text");
    expect(pushed(remote)).toBe("");
    expect(ghArgs()).toBeNull();
  });

  test("an empty body is refused, not sent", async () => {
    const { work, remote } = newAnnexFeatureClone();
    const r = await runNemar(
      ["dataset", "push", "--pr", "--no-s3", "-t", GOOD_TITLE, "-b", ""],
      work,
    );
    expect(r.exitCode).toBe(1);
    expect(said(r)).toContain("The description (--body) is empty");
    expect(pushed(remote)).toBe("");
  });

  test("opens the pull request with exactly the text it was given", async () => {
    const { work, remote } = newAnnexFeatureClone();
    const r = await runNemar(
      ["dataset", "push", "--pr", "--no-s3", "-t", GOOD_TITLE, "-b", GOOD_DESCRIPTION],
      work,
    );
    expect(r.exitCode).toBe(0);
    expect(pushed(remote)).toContain("refs/heads/feature/new-recordings");
    expect(ghArgs()).toEqual(["pr", "create", "--title", GOOD_TITLE, "--body", GOOD_DESCRIPTION]);
    expect(ghArgs()?.join(" ")).not.toContain("Update from branch");
  });

  test("on main there is no pull request to describe, so no text is asked for", async () => {
    const { work, remote } = newAnnexFeatureClone();
    git(work, "checkout", "-q", "main");
    const r = await runNemar(["dataset", "push", "--pr", "--no-s3"], work);
    expect(r.exitCode).toBe(0);
    expect(said(r)).toContain("Skipping PR: already on main branch");
    expect(pushed(remote)).toContain("refs/heads/main");
    expect(ghArgs()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// At a terminal, the command asks
// ---------------------------------------------------------------------------------------------

interface Terminal {
  /** What the person would see so far, with control sequences removed. */
  seen(): string;
  type(text: string): void;
  /** Wait until `needle` appears after everything already waited for. */
  until(needle: string): Promise<void>;
  exited: Promise<number>;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal control sequences
const CONTROL_SEQUENCES = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[=>]|\r/g;

/** The CLI on a pseudo-terminal, so `process.stdin.isTTY` is true and its prompts are real. */
function onTerminal(args: string[], cwd: string, config = configDir(true)): Terminal {
  rmSync(ghRecord, { force: true });
  apiPaths = [];
  let raw = "";
  const proc = Bun.spawn([process.execPath, "run", CLI_ENTRY, ...args], {
    cwd,
    env: cleanEnv(config, "xterm-256color"),
    terminal: {
      cols: 120,
      rows: 40,
      data(_terminal: unknown, chunk: Uint8Array) {
        raw += new TextDecoder().decode(chunk);
      },
    },
  } as never) as unknown as {
    terminal: { write(text: string): void };
    exited: Promise<number>;
    kill(): void;
  };
  const seen = () => raw.replace(CONTROL_SEQUENCES, "");
  let from = 0;
  const giveUp = setTimeout(() => proc.kill(), 50_000);
  return {
    seen,
    type: (text) => proc.terminal.write(text),
    async until(needle) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const at = seen().indexOf(needle, from);
        if (at >= 0) {
          from = at + needle.length;
          return;
        }
        await Bun.sleep(25);
      }
      throw new Error(`Timed out waiting for ${JSON.stringify(needle)}. Seen so far:\n${seen()}`);
    },
    exited: proc.exited.finally(() => clearTimeout(giveUp)),
  };
}

describe("nemar dataset update at a terminal asks for what the command line left out", () => {
  test("asks for a title and a description, and asks again after a refusal", async () => {
    const { work } = newClone();
    write(work, "sub-03/eeg/sub-03_task-rest_eeg.json", '{"TaskName": "rest"}\n');

    const term = onTerminal(["dataset", "update", "--branch", "update/pr-text-pty"], work);
    await term.until("Title (one line saying what changed):");
    term.type("Save changes\r");
    await term.until('That is placeholder text ("Save changes"); say what actually changed.');
    // Asked again on a fresh line, so the person is never left to delete what was refused.
    await term.until("Title (one line saying what changed):");
    term.type(`${GOOD_TITLE}\r`);
    await term.until("Description (what changed and why):");
    term.type("\r");
    await term.until("That is empty; say in plain words what changed.");
    await term.until("Description (what changed and why):");
    term.type(`${GOOD_DESCRIPTION}\r`);
    await term.until("Create update PR for xx000000?");
    term.type("y\r");
    const exitCode = await term.exited;
    expect(exitCode, term.seen()).toBe(0);

    const args = ghArgs() ?? [];
    expect(valueAfter(args, "--title")).toBe(`${GOOD_TITLE} (v1.0.1)`);
    expect(valueAfter(args, "--body")?.startsWith(`${GOOD_DESCRIPTION}\n\nBumps`)).toBe(true);
    expect(git(work, "show", "update/pr-text-pty:CHANGES")).toContain(`  - ${GOOD_TITLE}`);
  });

  test("does not ask what the command line already said", async () => {
    const { work } = newClone();
    write(work, "sub-03/eeg/sub-03_task-rest_eeg.json", '{"TaskName": "rest"}\n');
    const term = onTerminal(
      ["dataset", "update", "--branch", "update/pr-text-pty2", "-m", GOOD_TITLE],
      work,
    );
    await term.until("Description (what changed and why):");
    term.type(`${GOOD_DESCRIPTION}\r`);
    await term.until("Create update PR for xx000000?");
    term.type("y\r");
    expect(await term.exited, term.seen()).toBe(0);
    expect(term.seen()).not.toContain("Title (one line saying what changed):");
  });

  test("--yes at a terminal still refuses: it stands in for a confirmation, not for words", async () => {
    const { work } = newClone();
    write(work, "sub-03/eeg/sub-03_task-rest_eeg.json", '{"TaskName": "rest"}\n');
    const term = onTerminal(["dataset", "update", "--yes"], work);
    expect(await term.exited).toBe(1);
    expect(term.seen()).toContain("missing --message and --description.");
    expect(term.seen()).not.toContain("Title (one line saying what changed):");
  });
});

describe("nemar dataset push --pr at a terminal asks before anything is pushed", () => {
  test("the prompts come first and nothing has left the machine until they are answered", async () => {
    const { work, remote } = newAnnexFeatureClone();
    const term = onTerminal(["dataset", "push", "--pr", "--no-s3"], work);
    await term.until("Title (one line saying what changed):");
    // The prompt is on screen and nothing has left the machine.
    expect(git(remote, "for-each-ref", "refs/heads")).toBe("");
    term.type(`${GOOD_TITLE}\r`);
    await term.until("Description (what changed and why):");
    expect(git(remote, "for-each-ref", "refs/heads")).toBe("");
    term.type(`${GOOD_DESCRIPTION}\r`);
    expect(await term.exited, term.seen()).toBe(0);
    expect(git(remote, "for-each-ref", "refs/heads")).toContain(
      "refs/heads/feature/new-recordings",
    );
    expect(ghArgs()).toEqual(["pr", "create", "--title", GOOD_TITLE, "--body", GOOD_DESCRIPTION]);
  });
});
