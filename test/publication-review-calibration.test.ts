/**
 * The publication review's calibration tooling (ADR 0101, call 6), against REAL git repositories.
 *
 * The corpus builder clones local repositories made with the real `git` (a `file://` remote with
 * the filter capability stands in for the public hosting service, through the same git calls), and
 * reads them through the job's own readers. The calibration runs the job's real pre-send module,
 * prompt builder, model call and report assembly, with the REAL Anthropic SDK pointed at an HTTP
 * server in this file that answers the way the Messages API does. Nothing here reaches any other
 * host: a recorder around `fetch` says so, and a stand-in for the Worker is handed to `main` to
 * prove that nothing is posted to it.
 *
 * The properties the tooling depends on:
 *
 *  - the corpus holds the root documents and the structural summary and no recording data;
 *  - each defect is applied once, changes only the documents it targets, and is visible to the
 *    model (the production pre-send module sends the changed text);
 *  - the calibration sends exactly what production sends (a drift test compares the two requests),
 *    so a README that production withholds is withheld here too;
 *  - the records hold ids, labels, closed words, counts and timings, never a document's text or the
 *    model's words; the review sheet is the one place the model's words go, outside the repository.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CorpusEntry,
  CorpusError,
  DEFECTS,
  type Defect,
  ETHICS_BOILERPLATE,
  GENERIC_NAME,
  INJECTED_INSTRUCTION,
  LICENSE_FIELD_CC0,
  LICENSE_FIELD_CC_BY,
  LICENSE_TEXT_CC0,
  LICENSE_TEXT_CC_BY,
  PLACEHOLDER_AUTHORS,
  STUB_README,
  buildCorpus,
  cloneBlobless,
  listEntries,
  mismatchedLicense,
  mutate,
  mutateCorpus,
  readEntry,
} from "../scripts/ci/publication-review-corpus";
import {
  readRootDocuments,
  readTree,
  structuralSummary,
} from "../scripts/ci/publication-review-evidence";
import { presend } from "../scripts/ci/publication-review-presend";
import {
  DOCUMENT_CHAR_CAPS,
  REVIEW_DOCUMENTS,
  type ReviewDocument,
} from "../shared/publication-review";
import {
  MIN_NAME_LENGTH,
  isPlaceholderAuthor,
  submissionMinimumFailures,
} from "../shared/submission-minimums";

let root: string;
const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "/",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.org",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.org",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
}

function write(dir: string, rel: string, content: string | Buffer) {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "publication-review-calibration-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Datasets: local repositories that stand in for the public dataset repositories
// ---------------------------------------------------------------------------------------------

const SUBJECT = "sub-SENTINELSUBJ";
const EEG = `${SUBJECT}/eeg/${SUBJECT}_task-SENTINELTASK_eeg`;

/** Strings planted in the documents. None may reach a record. */
const README_SENTINEL = "SENTINEL_README_TEXT";
const NAME_SENTINEL = "SENTINEL_DESCRIPTION_NAME";
const ETHICS_SENTINEL = "SENTINEL_ETHICS_TEXT";
const CHANGES_SENTINEL = "SENTINEL_CHANGES_TEXT";
const LICENSE_SENTINEL = "SENTINEL_LICENSE_TEXT";
const PATH_SENTINEL = "sentinelperson";
const DOCUMENT_SENTINELS = [
  README_SENTINEL,
  NAME_SENTINEL,
  ETHICS_SENTINEL,
  CHANGES_SENTINEL,
  LICENSE_SENTINEL,
  PATH_SENTINEL,
];

const DESCRIPTION = {
  Name: `Resting state EEG of healthy volunteers ${NAME_SENTINEL}`,
  BIDSVersion: "1.9.0",
  Version: "1.0.0",
  License: "CC0",
  Authors: ["Ada Lovelace", "Alan Turing"],
  EthicsApprovals: [`IRB 2024-0001, University X ${ETHICS_SENTINEL}`],
};

const README = [
  "# Resting EEG",
  "",
  `Two volunteers recorded at rest with a 32 channel cap at 256 Hz. ${README_SENTINEL}.`,
  "",
  "Ethics: approved by the institutional review board of University X.",
  "",
].join("\n");

const BASE_FILES: Record<string, string | null> = {
  "dataset_description.json": JSON.stringify(DESCRIPTION),
  "README.md": README,
  CHANGES: `1.0.0 2026-01-01\n - Initial release ${CHANGES_SENTINEL}\n`,
  LICENSE: `Creative Commons Zero ${LICENSE_SENTINEL}\n`,
  "participants.json": JSON.stringify({ participant_id: { Description: "Unique label" } }),
  "participants.tsv": "participant_id\tSENTINEL_PARTICIPANT_ROW\nsub-SENTINELSUBJ\t30\n",
  [`${EEG}.edf`]: "recording bytes SENTINEL_RECORDING",
  [`${EEG}.json`]: JSON.stringify({
    TaskName: "SENTINEL_TASKNAME",
    SamplingFrequency: 256,
    EEGChannelCount: 32,
  }),
  "code/SENTINELDIR/run.py": "print(1)\n",
};

let originsDir: string;
let REMOTE_BASE: string;

interface Origin {
  dir: string;
  head: string;
}

/** A dataset repository at `<origins>/<id>.git` with `files` laid over the defaults. */
function newOrigin(id: string, files: Record<string, string | null> = {}): Origin {
  const dir = join(originsDir, `${id}.git`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "uploadpack.allowFilter", "true");
  git(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  const all: Record<string, string | null> = { ...BASE_FILES, ...files };
  for (const [rel, content] of Object.entries(all)) {
    if (content !== null) write(dir, rel, content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return { dir, head: git(dir, "rev-parse", "HEAD") };
}

const origins: Record<string, Origin> = {};

beforeAll(() => {
  originsDir = join(root, "origins");
  REMOTE_BASE = `file://${originsDir}`;
  // A typical dataset: ethics in the description and the README, a version, a LICENSE.
  origins.nm000001 = newOrigin("nm000001");
  // A README that names a path on somebody's machine: production withholds it.
  origins.nm000002 = newOrigin("nm000002", {
    "README.md": `# Notes\n\nProcessed under /Users/${PATH_SENTINEL}/lab/eeg with a 32 channel cap.\n`,
  });
  // A README.rst, no ethics statement anywhere and no Version.
  origins.nm000003 = newOrigin("nm000003", {
    "README.md": null,
    "README.rst": `Resting EEG\n===========\n\nRecordings at rest. ${README_SENTINEL}.\n`,
    "dataset_description.json": JSON.stringify({
      Name: `Resting EEG without any ethics statement ${NAME_SENTINEL}`,
      BIDSVersion: "1.9.0",
      License: "CC0",
      Authors: ["Ada Lovelace"],
    }),
  });
  // No dataset_description.json: not a dataset the review can read.
  origins.nm000004 = newOrigin("nm000004", { "dataset_description.json": null });
  // Two commits, so a depth-one clone is visibly shallow.
  origins.nm000005 = newOrigin("nm000005");
  write(origins.nm000005.dir, "CHANGES", "1.0.1 2026-02-01\n - Later\n");
  git(origins.nm000005.dir, "commit", "-q", "-am", "second");
  origins.nm000005.head = git(origins.nm000005.dir, "rev-parse", "HEAD");
  // No README at all.
  origins.nm000006 = newOrigin("nm000006", { "README.md": null });
});

// ---------------------------------------------------------------------------------------------
// The corpus builder
// ---------------------------------------------------------------------------------------------

const CLOSED_FILES = [
  "CHANGES",
  "LICENSE",
  "README.md",
  "dataset_description.json",
  "entry.json",
  "participants.json",
  "summary.json",
];

let goodCorpus: string;

describe("the corpus builder reads public repositories through the job's own readers", () => {
  beforeAll(async () => {
    goodCorpus = join(root, "corpus-good");
    const result = await buildCorpus({
      ids: ["nm000001", "nm000002", "nm000003", "nm000004", "nm000006", "nm000099"],
      outDir: goodCorpus,
      remoteBase: REMOTE_BASE,
    });
    expect(result.built).toBe(4);
  });

  test("it reports what it built and what it skipped, with a closed word each", async () => {
    const again = await buildCorpus({
      ids: ["nm000001", "nm000004", "nm000099"],
      outDir: join(root, "corpus-report"),
      remoteBase: REMOTE_BASE,
    });
    expect(again.built).toBe(1);
    expect(again.skipped).toBe(2);
    expect(again.skips).toEqual([
      { id: "nm000004", reason: "description_unreadable" },
      { id: "nm000099", reason: "clone_failed" },
    ]);
  });

  test("an entry is the root documents and the summary: no recording, table or code is stored", () => {
    expect(readdirSync(goodCorpus).sort()).toEqual([
      "nm000001",
      "nm000002",
      "nm000003",
      "nm000006",
    ]);
    expect(readdirSync(join(goodCorpus, "nm000001")).sort()).toEqual(CLOSED_FILES);
    const everything = readdirSync(goodCorpus, { recursive: true, encoding: "utf8" });
    for (const path of everything) {
      expect(path).not.toMatch(/\.(edf|tsv)$/);
      expect(path).not.toContain("sub-");
      expect(path).not.toContain("SENTINELDIR");
    }
    for (const id of ["nm000001", "nm000002", "nm000003", "nm000006"]) {
      const text = readdirSync(join(goodCorpus, id))
        .map((f) => readFileSync(join(goodCorpus, id, f), "utf8"))
        .join("\n");
      expect(text, id).not.toContain("SENTINEL_RECORDING");
      expect(text, id).not.toContain("SENTINEL_PARTICIPANT_ROW");
      expect(text, id).not.toContain("SENTINEL_TASKNAME");
      expect(text, id).not.toContain("SENTINELSUBJ");
      expect(text, id).not.toContain("SENTINELTASK");
    }
  });

  test("the documents and the summary are exactly what the job's readers return for the commit", async () => {
    const origin = origins.nm000001 as Origin;
    const tree = await readTree(origin.dir, origin.head);
    const docs = readRootDocuments(origin.dir, tree);
    const entry = readEntry(join(goodCorpus, "nm000001"));
    expect(entry).toMatchObject({ id: "nm000001", label: "good", base: "nm000001" });
    expect(entry.head).toBe(origin.head);
    expect(entry.docs).toEqual(docs);
    expect(entry.summary).toEqual(structuralSummary(origin.dir, tree));
    expect(entry.summary.subjects).toBe(1);
    expect(entry.summary.sampling_rates_hz).toEqual([256]);
  });

  test("each README form is kept under its own name, and a missing document is absent", () => {
    const rst = readEntry(join(goodCorpus, "nm000003"));
    expect(rst.docs.readme).toMatchObject({ name: "README.rst", state: "present" });
    expect(rst.docs.readme.text).toContain(README_SENTINEL);
    const none = readEntry(join(goodCorpus, "nm000006"));
    expect(none.docs.readme).toEqual({ name: "", state: "absent", text: null });
    expect(readdirSync(join(goodCorpus, "nm000006"))).not.toContain("README.md");
  });

  test("the clone is shallow and blob-less, so no recording data is ever fetched", () => {
    const dest = join(root, "clone-check");
    const home = join(root, "clone-home");
    mkdirSync(home, { recursive: true });
    cloneBlobless(`${REMOTE_BASE}/nm000005.git`, dest, home);
    expect(git(dest, "rev-list", "--count", "HEAD")).toBe("1");
    const readmeBlob = git((origins.nm000005 as Origin).dir, "rev-parse", "HEAD:README.md");
    expect(() =>
      execFileSync("git", ["-C", dest, "cat-file", "-e", readmeBlob], {
        env: { ...GIT_ENV, GIT_NO_LAZY_FETCH: "1" },
        stdio: "ignore",
      }),
    ).toThrow();
    // Nothing was checked out either.
    expect(readdirSync(dest)).toEqual([".git"]);
  });

  test("an entry already in the corpus is left alone", async () => {
    const out = join(root, "corpus-exists");
    await buildCorpus({ ids: ["nm000001"], outDir: out, remoteBase: REMOTE_BASE });
    const before = readFileSync(join(out, "nm000001", "README.md"), "utf8");
    writeFileSync(join(out, "nm000001", "README.md"), "edited by hand\n");
    const again = await buildCorpus({ ids: ["nm000001"], outDir: out, remoteBase: REMOTE_BASE });
    expect(again).toMatchObject({ built: 0, skipped: 1 });
    expect(again.skips).toEqual([{ id: "nm000001", reason: "entry_exists" }]);
    expect(readFileSync(join(out, "nm000001", "README.md"), "utf8")).toBe("edited by hand\n");
    expect(before).toContain(README_SENTINEL);
  });

  test("an id or a remote that is not a public https or file location is refused before any clone", async () => {
    const out = join(root, "corpus-refused");
    for (const id of ["nm00001", "../nm000001", "nm000001/x", "NM000001", "nm000001 ", ""]) {
      await expect(
        buildCorpus({ ids: [id], outDir: out, remoteBase: REMOTE_BASE }),
        JSON.stringify(id),
      ).rejects.toMatchObject({ code: "bad_id" });
    }
    for (const remoteBase of ["git://corpus.invalid/x", "ssh://corpus.invalid/x", "ext::sh", "x"]) {
      await expect(
        buildCorpus({ ids: ["nm000001"], outDir: out, remoteBase }),
      ).rejects.toMatchObject({ code: "bad_remote" });
    }
    expect(existsSync(out)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The defect mutator
// ---------------------------------------------------------------------------------------------

/** The documents each defect is meant to change, and no others. */
const TOUCHES: Record<Defect, ReviewDocument[]> = {
  stub_readme: ["readme"],
  ethics_removed: ["readme", "dataset_description"],
  ethics_boilerplate: ["readme", "dataset_description"],
  placeholder_authors: ["dataset_description"],
  license_mismatch: ["dataset_description", "license"],
  name_not_descriptive: ["dataset_description"],
  readme_contradicts_counts: ["readme"],
  embedded_instruction: ["readme"],
};

function changedDocuments(before: CorpusEntry, after: CorpusEntry): ReviewDocument[] {
  return REVIEW_DOCUMENTS.filter(
    (d) => JSON.stringify(before.docs[d]) !== JSON.stringify(after.docs[d]),
  );
}

/** What the model would be shown of a document, by the production pre-send module. */
function shown(entry: CorpusEntry): Partial<Record<ReviewDocument, string>> {
  return presend(entry.docs).cleared;
}

function descriptionOf(entry: CorpusEntry): Record<string, unknown> {
  return JSON.parse(entry.docs.dataset_description.text as string) as Record<string, unknown>;
}

function minimumFailuresOf(entry: CorpusEntry): string[] {
  return submissionMinimumFailures(entry.docs.dataset_description.text, entry.docs.readme.text);
}

/** True when `text` holds a statement the submission gate's own rule reads as an ethics statement. */
function mentionsEthics(text: string): boolean {
  const description = JSON.stringify({ Name: "x".repeat(MIN_NAME_LENGTH), Authors: ["A. Person"] });
  return !submissionMinimumFailures(description, text).includes("ethics_statement_missing");
}

/** Each defect, asserted from the mutated FILES with the shared rules, never with the mutator's own check. */
const VISIBLE: Record<Defect, (before: CorpusEntry, after: CorpusEntry) => void> = {
  stub_readme: (before, after) => {
    expect(after.docs.readme.text).toBe(STUB_README);
    expect((after.docs.readme.text as string).length).toBeLessThan(80);
    expect(before.docs.readme.text).not.toBe(STUB_README);
  },
  ethics_removed: (before, after) => {
    expect(minimumFailuresOf(before)).not.toContain("ethics_statement_missing");
    expect(minimumFailuresOf(after)).toContain("ethics_statement_missing");
    expect(descriptionOf(after)).not.toHaveProperty("EthicsApprovals");
  },
  ethics_boilerplate: (before, after) => {
    expect(descriptionOf(before).EthicsApprovals).not.toEqual([ETHICS_BOILERPLATE]);
    expect(descriptionOf(after).EthicsApprovals).toEqual([ETHICS_BOILERPLATE]);
    // The mechanical gate still passes: that is why a reviewer is needed.
    expect(minimumFailuresOf(after)).not.toContain("ethics_statement_missing");
    expect(mentionsEthics(after.docs.readme.text as string)).toBe(false);
  },
  placeholder_authors: (before, after) => {
    const authors = descriptionOf(after).Authors as string[];
    expect(authors).toEqual([...PLACEHOLDER_AUTHORS]);
    for (const a of authors) expect(isPlaceholderAuthor(a), a).toBe(true);
    expect((descriptionOf(before).Authors as string[]).some(isPlaceholderAuthor)).toBe(false);
  },
  license_mismatch: (before, after) => {
    // The field changes, and the LICENSE text names the other license: a CC0 dataset becomes
    // CC-BY-4.0 over a CC0 text.
    expect(descriptionOf(before).License).toBe("CC0");
    expect(descriptionOf(after).License).toBe("CC-BY-4.0");
    const text = after.docs.license.text as string;
    expect(text).toContain("Zero");
    expect(text).not.toContain("Attribution");
    expect(before.docs.license.text).not.toBe(text);
  },
  name_not_descriptive: (before, after) => {
    const name = descriptionOf(after).Name as string;
    expect(name).toBe(GENERIC_NAME);
    // Above the mechanical floor, so only a reader can tell it does not describe the data.
    expect(name.length).toBeGreaterThanOrEqual(MIN_NAME_LENGTH);
    expect(descriptionOf(before).Name).not.toBe(name);
  },
  readme_contradicts_counts: (before, after) => {
    const claim = /(\d+) participants/.exec(after.docs.readme.text as string);
    expect(claim).not.toBeNull();
    expect(Number((claim as RegExpExecArray)[1])).not.toBe(after.summary.subjects);
    expect(after.summary).toEqual(before.summary);
  },
  embedded_instruction: (before, after) => {
    expect(after.docs.readme.text).toContain(INJECTED_INSTRUCTION);
    expect(before.docs.readme.text).not.toContain(INJECTED_INSTRUCTION);
    expect(INJECTED_INSTRUCTION).toMatch(/REVIEWER/);
  },
};

describe("each defect is applied once, to a copy, and is visible in the mutated files", () => {
  test("the list is the eight the design note names", () => {
    expect([...DEFECTS]).toEqual([
      "stub_readme",
      "ethics_removed",
      "ethics_boilerplate",
      "placeholder_authors",
      "license_mismatch",
      "name_not_descriptive",
      "readme_contradicts_counts",
      "embedded_instruction",
    ]);
    expect(Object.keys(TOUCHES).sort()).toEqual([...DEFECTS].sort());
    expect(Object.keys(VISIBLE).sort()).toEqual([...DEFECTS].sort());
  });

  test.each([...DEFECTS])("%s", (defect) => {
    const base = join(goodCorpus, "nm000001");
    const out = join(root, `mutant-${defect}`);
    const before = readEntry(base);
    mutate(base, defect, out);
    const after = readEntry(out);

    // A copy: the entry it came from is untouched, and the copy says what it is.
    expect(readEntry(base)).toEqual(before);
    expect(after).toMatchObject({
      id: `nm000001.${defect}`,
      label: defect,
      base: "nm000001",
      head: before.head,
    });
    expect(
      readdirSync(out)
        .sort()
        .every((f) => CLOSED_FILES.includes(f)),
    ).toBe(true);

    // Applied once: only the targeted documents differ, byte for byte.
    expect(changedDocuments(before, after)).toEqual(TOUCHES[defect]);
    VISIBLE[defect](before, after);

    // Visible to the model: the production pre-send module sends the changed text.
    const was = shown(before);
    const now = shown(after);
    for (const d of TOUCHES[defect]) {
      expect(now[d], d).toBeDefined();
      expect(now[d], d).not.toBe(was[d]);
    }
    for (const d of REVIEW_DOCUMENTS.filter((x) => !TOUCHES[defect].includes(x))) {
      expect(now[d], d).toBe(was[d]);
    }
  });

  test("license_mismatch writes the other license whichever one the dataset has", () => {
    expect(mismatchedLicense("CC0")).toEqual({
      field: LICENSE_FIELD_CC_BY,
      text: LICENSE_TEXT_CC0,
    });
    for (const other of ["CC-BY-4.0", "ODC-By-1.0", "", undefined, 7]) {
      expect(mismatchedLicense(other)).toEqual({
        field: LICENSE_FIELD_CC0,
        text: LICENSE_TEXT_CC_BY,
      });
    }
    const dir = join(root, "corpus-license", "nm000001");
    cpSync(join(goodCorpus, "nm000001"), dir, { recursive: true });
    const description = descriptionOf(readEntry(dir));
    writeFileSync(
      join(dir, "dataset_description.json"),
      JSON.stringify({ ...description, License: "ODC-By-1.0" }),
    );
    const out = join(root, "corpus-license", "mutant");
    mutate(dir, "license_mismatch", out);
    const after = readEntry(out);
    expect(descriptionOf(after).License).toBe("CC0");
    expect(after.docs.license.text).toBe(LICENSE_TEXT_CC_BY);
  });

  test("a defect that would change nothing the model reads is refused and leaves nothing behind", () => {
    // nm000003 has no ethics statement anywhere, so there is none to remove.
    const out = join(root, "mutant-noop");
    expect(() => mutate(join(goodCorpus, "nm000003"), "ethics_removed", out)).toThrow(CorpusError);
    try {
      mutate(join(goodCorpus, "nm000003"), "ethics_removed", out);
    } catch (e) {
      expect((e as CorpusError).code).toBe("mutation_not_visible");
    }
    expect(existsSync(out)).toBe(false);
  });

  test("a README the model would never be shown cannot carry a README defect", () => {
    // nm000002's README names a local path, so production withholds it.
    const out = join(root, "mutant-withheld");
    expect(() => mutate(join(goodCorpus, "nm000002"), "embedded_instruction", out)).toThrow(
      "mutation_not_visible",
    );
    expect(existsSync(out)).toBe(false);
    // A defect in a document the model does see is fine on the same entry.
    mutate(join(goodCorpus, "nm000002"), "placeholder_authors", join(root, "mutant-withheld-ok"));
    expect(existsSync(join(root, "mutant-withheld-ok", "entry.json"))).toBe(true);
  });

  test("a defect that needs a document the entry lacks is not applicable", () => {
    const out = join(root, "mutant-no-readme");
    expect(() => mutate(join(goodCorpus, "nm000006"), "stub_readme", out)).toThrow(
      "mutation_not_applicable",
    );
    expect(existsSync(out)).toBe(false);
  });

  test("an existing directory is never overwritten", () => {
    const out = join(root, "mutant-exists");
    mkdirSync(out);
    writeFileSync(join(out, "keep.txt"), "kept");
    expect(() => mutate(join(goodCorpus, "nm000001"), "stub_readme", out)).toThrow("out_exists");
    expect(readFileSync(join(out, "keep.txt"), "utf8")).toBe("kept");
  });

  test("the README insertions land inside what the model is shown, even in a very long README", () => {
    const longBase = join(root, "corpus-long", "nm000001");
    cpSync(join(goodCorpus, "nm000001"), longBase, { recursive: true });
    const readme = readFileSync(join(longBase, "README.md"), "utf8");
    writeFileSync(
      join(longBase, "README.md"),
      `${readme}\n${"A line of text that keeps going.\n".repeat(2000)}`,
    );
    expect((readEntry(longBase).docs.readme.text as string).length).toBeGreaterThan(
      DOCUMENT_CHAR_CAPS.readme,
    );
    for (const defect of ["embedded_instruction", "readme_contradicts_counts"] as const) {
      const out = join(root, "corpus-long", `out-${defect}`);
      mutate(longBase, defect, out);
      expect(shown(readEntry(out)).readme).toContain(
        defect === "embedded_instruction" ? INJECTED_INSTRUCTION : " participants.",
      );
    }
  });
});

describe("a corpus of mutated copies is chosen deterministically", () => {
  test("one copy of each defect, each from an entry it works on, with distinct ids", () => {
    const dir = join(root, "corpus-mutated");
    cpSync(goodCorpus, dir, { recursive: true });
    const result = mutateCorpus(dir, { perDefect: 1 });
    expect(result.made).toBe(DEFECTS.length);
    const mutated = listEntries(dir).filter((e) => e.label !== "good");
    expect(mutated.map((e) => e.label).sort()).toEqual([...DEFECTS].sort());
    expect(new Set(mutated.map((e) => e.id)).size).toBe(DEFECTS.length);
    for (const e of mutated) {
      expect(e.id).toBe(`${e.base}.${e.label}`);
      expect(listEntries(dir).some((g) => g.id === e.base && g.label === "good")).toBe(true);
    }
  });

  test("the same corpus gives the same copies, file for file", () => {
    const a = join(root, "corpus-mutated-a");
    const b = join(root, "corpus-mutated-b");
    cpSync(goodCorpus, a, { recursive: true });
    cpSync(goodCorpus, b, { recursive: true });
    mutateCorpus(a, { perDefect: 2 });
    mutateCorpus(b, { perDefect: 2 });
    const files = (dir: string) =>
      readdirSync(dir, { recursive: true, encoding: "utf8" })
        .sort()
        .map((f) => [f, existsSync(join(dir, f)) ? safeRead(join(dir, f)) : null]);
    expect(files(a)).toEqual(files(b));
    expect(files(a).length).toBeGreaterThan(listEntries(goodCorpus).length * 5);
  });

  test("asking for more copies than there are entries stops at what works", () => {
    const dir = join(root, "corpus-mutated-many");
    cpSync(goodCorpus, dir, { recursive: true });
    const result = mutateCorpus(dir, { perDefect: 50 });
    expect(result.made).toBeLessThanOrEqual(DEFECTS.length * 4);
    expect(result.made).toBeGreaterThan(DEFECTS.length);
    expect(result.skipped).toBeGreaterThan(0);
  });
});

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
