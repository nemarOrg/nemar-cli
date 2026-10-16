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
