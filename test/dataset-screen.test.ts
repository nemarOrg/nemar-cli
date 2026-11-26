/**
 * `nemar dataset screen` (card A9, issue #2184): the publication screen's report, made on the
 * depositor's own copy.
 *
 * Every case builds a REAL git repository (or plain directory) in a temp directory and screens it
 * with the real scanner; the publication screen's own `screenDataset` is run on the same
 * repository to prove the two reports are the same report. Nothing is replaced: a header is read
 * from real bytes, an annexed file is a real symlink into a real object store, and the only
 * thing left out is the network, which the screen never uses.
 *
 * Each rule has a twin that differs in one thing (a clean header beside a named one, content
 * present beside content absent, the committed tree beside the working tree), because a screen
 * that flags, or passes, everything also passes a one-sided test.
 *
 * The CLI itself (help text, exit status through the real entry point, and the proof that
 * nothing is written and nothing is sent) is in `dataset-screen-spawn.test.ts`.
 *
 * CI TIER: unit-pure. Offline: git and the scanner run on this machine only.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAnnexPointer,
  parseScreenConfig,
  screenDataset,
} from "../scripts/identifier-screen-ci-lib";
import { EDF_READER, READERS, ReadFailure, bufferSource } from "../shared/identifier-readers";
import { DATASET_STATUSES, parseScreenReport } from "../shared/identifier-screen-report";
import {
  LOCAL_COPY,
  LOCAL_DATASET_ID,
  LOCAL_ERRORS,
  LocalScreenError,
  absenceAware,
  exitCodeFor,
  renderLocalScreen,
  screenLocalDataset,
} from "../src/lib/dataset-screen";
import {
  CLEAN,
  NAME,
  Repo,
  cleanScratch,
  digestTree,
  git,
  named,
  recording,
  tempDir,
} from "./helpers/dataset-screen-fixture";
import { gitAnnexGate } from "./helpers/git-annex-gate";

afterAll(cleanScratch);

const DESCRIPTION = JSON.stringify({ Name: "Fixture", BIDSVersion: "1.9.0" });
const EDF = "sub-01/eeg/sub-01_task-rest_eeg.edf";

/** A small dataset: one EDF header, a description, and (optionally) one format nobody reads. */
function dataset(patient = CLEAN, options: { unscreened?: boolean } = {}): Repo {
  const repo = new Repo();
  repo.file("dataset_description.json", DESCRIPTION).file(EDF, recording(patient));
  if (options.unscreened) repo.file("sub-01/eeg/sub-01_task-rest_eeg.cnt", "Version 3.0\n");
  repo.commit("data");
  return repo;
}

const committed = (repo: Repo) => screenLocalDataset(repo.dir, { committed: true });
const working = (repo: Repo) => screenLocalDataset(repo.dir, { committed: false });
const statusOf = (screen: Awaited<ReturnType<typeof working>>) => screen.report.scan?.status;

/** The report's scan without the fields that belong to the run, not to the dataset. */
function comparable(scan: unknown): unknown {
  const { scanned_at: _at, id: _id, ...rest } = scan as Record<string, unknown>;
  return rest;
}

describe("the same report as the publication screen", () => {
  // The publication screen reads a metadata-only clone of the repository; the local run reads
  // the repository itself. Same files, same commit: the report must be the same report.
  const cases: [string, () => Repo][] = [
    ["EDF and one format nobody reads", () => dataset(CLEAN, { unscreened: true })],
    ["a direct identifier in a header", () => dataset(named(1), { unscreened: true })],
    [
      "tables, a sidecar and a date",
      () => {
        const repo = dataset(CLEAN);
        repo
          .file("participants.tsv", "participant_id\tage\nsub-01\t30\n")
          .file(
            "sub-01/sub-01_scans.tsv",
            "filename\tacq_time\nsub-01_eeg.edf\t2020-03-04T10:00:00\n",
          )
          .file("sourcedata/export.json", JSON.stringify({ note: "fine" }));
        repo.commit("tables");
        return repo;
      },
    ],
  ];
  for (const [label, build] of cases) {
    test(`${label}: both modes equal the server's report`, async () => {
      const repo = build();
      const server = await screenDataset(
        parseScreenConfig(["--clone-origin", repo.origin, "--no-callback"], {
          DATASET_ID: "nm000186",
        }),
      );
      expect(server.scan).toBeDefined();
      for (const mode of [committed, working]) {
        const local = await mode(repo);
        expect(local.report.version).toBe(server.version);
        expect(local.report.head).toBe(server.head);
        expect(local.report.scanner).toBe(server.scanner);
        expect(comparable(local.report.scan)).toEqual(comparable(server.scan));
        expect(local.report.scan?.id).toBe(LOCAL_DATASET_ID);
      }
    });
  }

  test("the report validates with the contract's own parser, after a JSON round trip", async () => {
    const repo = dataset(named(1), { unscreened: true });
    const local = await committed(repo);
    const again = parseScreenReport(JSON.parse(JSON.stringify(local.report)));
    expect(again.scan?.status).toBe("direct-identifiers");
    expect(again.scan?.read_by_format?.edf).toEqual({ files: 1, read: 1, partial: 0, failed: 0 });
    // The reader versions travel with the verdict, so a run names the code that made it.
    expect(again.scan?.readers?.edf).toBe(EDF_READER.version);
  });
});

describe("exit status", () => {
  test("a direct identifier is 3, a clear verdict is 0, every other state is 2", () => {
    for (const status of DATASET_STATUSES) {
      const expected =
        status === "direct-identifiers"
          ? 3
          : status === "clean" || status === "dates-only" || status === "no-recordings"
            ? 0
            : 2;
      expect(exitCodeFor(status)).toBe(expected);
    }
  });

  test("each verdict is reached from a real tree and maps to its code", async () => {
    const clean = await committed(dataset(CLEAN));
    expect(statusOf(clean)).toBe("clean");
    expect(exitCodeFor(clean.report.scan?.status ?? "unchecked")).toBe(0);

    const direct = await committed(dataset(named(1)));
    expect(statusOf(direct)).toBe("direct-identifiers");
    expect(exitCodeFor("direct-identifiers")).toBe(3);

    const partly = await committed(dataset(CLEAN, { unscreened: true }));
    expect(statusOf(partly)).toBe("partially-screened");
    expect(exitCodeFor("partially-screened")).toBe(2);

    const none = new Repo();
    none.file("dataset_description.json", DESCRIPTION).commit();
    expect(statusOf(await committed(none))).toBe("no-recordings");

    // A subject label that looks like a name is a finding to review, not a direct identifier.
    const review = new Repo();
    review.file("sub-Quillfeather/eeg/sub-Quillfeather_eeg.edf", recording(CLEAN)).commit();
    const reviewed = await committed(review);
    expect(statusOf(reviewed)).toBe("review");
    expect(exitCodeFor("review")).toBe(2);
  });

  test("an acquisition date alone is dates-only and clears (exit 0)", async () => {
    const repo = new Repo();
    repo.file(EDF, recording(CLEAN, "15.03.85")).commit();
    const screen = await committed(repo);
    expect(statusOf(screen)).toBe("dates-only");
    expect(exitCodeFor("dates-only")).toBe(0);
  });
});

describe("what is read: the working tree, or the committed tree", () => {
  test("a header changed after the commit is read as it is now, and not by --committed", async () => {
    const repo = dataset(CLEAN);
    repo.file(EDF, recording(named(1)));
    expect(statusOf(await working(repo))).toBe("direct-identifiers");
    expect(statusOf(await committed(repo))).toBe("clean");
  });

  test("a header fixed after the commit reads clean here and is still flagged by --committed", async () => {
    const repo = dataset(named(1));
    repo.file(EDF, recording(CLEAN));
    expect(statusOf(await working(repo))).toBe("clean");
    expect(statusOf(await committed(repo))).toBe("direct-identifiers");
  });

  test("the banner says which was read, and the commit", async () => {
    const repo = dataset(CLEAN);
    const head = git(repo.dir, "rev-parse", "HEAD");
    const a = await working(repo);
    const b = await committed(repo);
    expect(a.commit).toBe(head);
    expect(renderLocalScreen(a).head[0]).toContain("the working tree");
    expect(renderLocalScreen(a).head[0]).toContain(head.slice(0, 12));
    expect(renderLocalScreen(b).head[0]).toContain("the committed tree (HEAD)");
    // And the body says what the other mode would have read.
    expect(renderLocalScreen(a).body.join("\n")).toContain(LOCAL_COPY.workingTree.statement);
    expect(renderLocalScreen(b).body.join("\n")).toContain(LOCAL_COPY.committed.statement);
  });
});

describe("a directory that is not a repository", () => {
  test("the working tree is screened, with no commit and a line saying there is no history", async () => {
    const plain = new Repo("plain", { git: false });
    plain.file(EDF, recording(named(1)));
    const screen = await working(plain);
    expect(statusOf(screen)).toBe("direct-identifiers");
    expect(screen.commit).toBeNull();
    expect(screen.history).toBe(false);
    const text = renderLocalScreen(screen);
    expect(text.head[0]).toContain("commit none");
    expect(text.body.join("\n")).toContain(LOCAL_COPY.noHistory.statement);
    // The null commit is not printed as if it were one.
    expect(text.body.join("\n")).not.toContain("commit 000000000000");
  });

  test("a deposit that is clean here is clean, with the same words as a repository", async () => {
    const plain = new Repo("plain", { git: false });
    plain.file(EDF, recording(CLEAN));
    expect(statusOf(await working(plain))).toBe("clean");
  });

  test("--committed needs a repository with a commit, and a path needs to be a directory", async () => {
    const plain = new Repo("plain", { git: false });
    const code = async (p: Promise<unknown>) =>
      p.then(
        () => "none",
        (e) => (e instanceof LocalScreenError ? e.code : "other"),
      );
    expect(await code(committed(plain))).toBe("not-a-repository");
    const empty = new Repo("empty");
    expect(await code(committed(empty))).toBe("no-commit");
    const file = join(tempDir("file"), "x");
    writeFileSync(file, "x");
    expect(await code(screenLocalDataset(file, { committed: false }))).toBe("not-a-directory");
    expect(await code(screenLocalDataset(join(file, "nope"), { committed: false }))).toBe(
      "not-a-directory",
    );
    for (const sentence of Object.values(LOCAL_ERRORS)) expect(sentence).not.toContain(file);
  });

  test("a subdirectory of a repository is not the repository (no history is claimed for it)", async () => {
    const repo = dataset(named(1));
    const inside = join(repo.dir, "sub-01");
    const screen = await screenLocalDataset(inside, { committed: false });
    expect(screen.history).toBe(false);
    expect(screen.commit).toBeNull();
  });
});

describe("annexed content that is not on this machine", () => {
  const recordingPath = "sub-01/eeg/sub-01_task-rest_eeg.edf";

  test("a locked recording with its content is read; without it, it is partial, never clean", async () => {
    for (const mode of [committed, working]) {
      const present = new Repo();
      present.annexLink(recordingPath, recording(named(1)));
      present.commit();
      const flagged = await mode(present);
      expect(statusOf(flagged)).toBe("direct-identifiers");
      expect(flagged.report.scan?.read_by_format?.edf?.read).toBe(1);

      const absent = new Repo();
      absent.annexLink(recordingPath, recording(named(1)), { content: false });
      absent.commit();
      const screen = await mode(absent);
      const scan = screen.report.scan;
      expect(scan?.status).toBe("unchecked");
      expect(scan?.read_by_format?.edf).toEqual({ files: 1, read: 0, partial: 1, failed: 0 });
      expect(scan?.incomplete_reasons).toContain("content-absent");
      // Not a failed read: the scanner knew why it did not read it.
      expect(scan?.read_failures).toEqual({});
      expect(exitCodeFor(scan?.status ?? "unchecked")).toBe(2);
      const text = renderLocalScreen(screen).body.join("\n");
      expect(text).toContain("Incomplete (content-absent)");
      expect(text).toContain("nemar dataset get");
    }
  });

  test("an unlocked pointer file is read from the object store, or is content-absent", async () => {
    const present = new Repo();
    present.annexPointer(recordingPath, recording(named(1)));
    present.commit();
    for (const mode of [committed, working]) {
      expect(statusOf(await mode(present))).toBe("direct-identifiers");
    }
    const absent = new Repo();
    absent.annexPointer(recordingPath, recording(named(1)), { content: false });
    absent.commit();
    for (const mode of [committed, working]) {
      const scan = (await mode(absent)).report.scan;
      expect(scan?.status).toBe("unchecked");
      expect(scan?.incomplete_reasons).toContain("content-absent");
    }
  });

  test("a renamed recording is read by the extension of its key", async () => {
    const repo = new Repo();
    repo.annexLink("sub-01/eeg/recording.dat", recording(named(1)), { keyExt: ".edf" });
    repo.commit();
    for (const mode of [committed, working]) {
      const scan = (await mode(repo)).report.scan;
      expect(scan?.status).toBe("direct-identifiers");
      expect(scan?.read_by_format?.edf?.files).toBe(1);
    }
  });

  test("a side file whose content is absent is an unreadable file, not an absent recording", async () => {
    const repo = new Repo();
    repo.file("dataset_description.json", DESCRIPTION);
    repo.annexLink("sourcedata/export.json", new TextEncoder().encode('{"a":1}'), {
      content: false,
    });
    repo.commit();
    const scan = (await committed(repo)).report.scan;
    expect(scan?.read_failures).toEqual({ "json/unreadable-entry": 1 });
    expect(scan?.incomplete_reasons).not.toContain("content-absent");
  });

  test("a link that points nowhere into the annex is a failed read of that file", async () => {
    const repo = new Repo();
    repo.file("dataset_description.json", DESCRIPTION);
    const { symlinkSync } = await import("node:fs");
    symlinkSync("/nonexistent/elsewhere.edf", join(repo.dir, "sub-01_eeg.edf"));
    repo.commit();
    const scan = (await working(repo)).report.scan;
    expect(scan?.read_by_format?.edf).toEqual({ files: 1, read: 0, partial: 0, failed: 1 });
    expect(scan?.status).toBe("unchecked");
  });

  test("the wrapper turns only the absence of content into a partial read", async () => {
    const wrapped = absenceAware(EDF_READER);
    expect(wrapped.id).toBe(EDF_READER.id);
    expect(wrapped.version).toBe(EDF_READER.version);
    const absent = {
      size: 2000,
      read: async () => {
        throw new ReadFailure("content-absent");
      },
    };
    expect(await wrapped.scan(absent, "a.edf", wrapped.limits)).toEqual({
      findings: [],
      coverage: "partial",
      incomplete: "content-absent",
    });
    // Any other failure stays a failure.
    const broken = {
      size: 2000,
      read: async () => {
        throw new ReadFailure("network");
      },
    };
    await expect(wrapped.scan(broken, "a.edf", wrapped.limits)).rejects.toBeInstanceOf(ReadFailure);
    // And a readable file is read exactly as the unwrapped reader reads it.
    const bytes = recording(named(1));
    const a = await wrapped.scan(bufferSource(bytes), "a.edf", wrapped.limits);
    const b = await EDF_READER.scan(bufferSource(bytes), "a.edf", EDF_READER.limits);
    expect(a).toEqual(b);
  });
});

describe("earlier commits", () => {
  const path = "sub-01/eeg/sub-01_task-rest_eeg.edf";

  test("a recording the tree no longer holds is read from history when its content is here", async () => {
    // A named header was committed to git, then replaced by a clean one: it is still one
    // `git log` away, so the screen flags it in both modes, as the server does.
    const repo = new Repo();
    repo.file(path, recording(named(1))).commit("before");
    repo.file(path, recording(CLEAN)).commit("fixed");
    for (const mode of [committed, working]) {
      const screen = await mode(repo);
      expect(statusOf(screen)).toBe("direct-identifiers");
      expect(screen.report.scan?.read_by_format?.edf?.files).toBe(2);
    }
    // Its clean twin: the history holds only clean headers.
    const clean = new Repo();
    clean.file(path, recording(CLEAN)).commit("before");
    clean.file(path, recording("P02 M X X")).commit("again");
    expect(statusOf(await committed(clean))).toBe("clean");
  });

  test("an annexed recording of an earlier commit is read when its content is here, named when not", async () => {
    const make = (content: boolean) => {
      const repo = new Repo();
      repo.annexLink(path, recording(named(1)), { content });
      repo.commit("before");
      repo.remove(path);
      repo.annexLink(path, recording(CLEAN));
      repo.commit("fixed");
      return repo;
    };
    const here = await committed(make(true));
    expect(statusOf(here)).toBe("direct-identifiers");
    expect(here.supersededNotRead).toBe(0);

    const gone = await committed(make(false));
    // Not read, so not claimed: the verdict is the tree's, and the line says what was not read.
    expect(statusOf(gone)).toBe("clean");
    expect(gone.supersededNotRead).toBe(1);
    const text = renderLocalScreen(gone).body.join("\n");
    expect(text).toContain(LOCAL_COPY.supersededAbsent(1).statement);
    expect(text).toContain("git annex get --all");
    // The clean twin says nothing of the kind.
    const none = await committed(make(true));
    expect(renderLocalScreen(none).body.join("\n")).not.toContain(
      "earlier commits have no content",
    );
  });

  test("a path that ever existed goes through the path rules", async () => {
    const repo = new Repo();
    repo.file("sub-Quillfeather/notes.txt", "x").commit("before");
    repo.remove("sub-Quillfeather/notes.txt");
    repo.file("dataset_description.json", DESCRIPTION).commit("after");
    const screen = await committed(repo);
    expect(screen.report.scan?.findings_by_kind?.["path-subject-label"]).toBeGreaterThan(0);
    // The twin has no such path in its history.
    const twin = new Repo();
    twin.file("sub-01/notes.txt", "x").commit("before");
    twin.remove("sub-01/notes.txt");
    twin.file("dataset_description.json", DESCRIPTION).commit("after");
    expect(
      (await committed(twin)).report.scan?.findings_by_kind?.["path-subject-label"],
    ).toBeUndefined();
  });
});

describe("what a person is told", () => {
  test("a finding is printed with its count, remedy and docs link, and no value", async () => {
    const repo = new Repo();
    repo.file(`sub-${NAME}/eeg/sub-${NAME}_eeg.edf`, recording(named(1))).commit();
    const screen = await committed(repo);
    const text = [...renderLocalScreen(screen).head, ...renderLocalScreen(screen).body].join("\n");
    expect(text).toContain("Identifier screen: ");
    expect(text).toContain("edf-patient-name x1");
    expect(text).toContain("What to do: ");
    expect(text).toContain("More: https://docs.nemar.org/platform/identifier-screening/#kind-");
    expect(text).toContain("Recordings read: EDF/BDF 1 of 1.");
    expect(text).toContain(
      `Scanner ${screen.report.scanner}; commit ${screen.commit?.slice(0, 12)}.`,
    );
    // No name, no path: counts and fixed words only.
    expect(text).not.toContain(NAME);
    expect(text).not.toContain(`sub-${NAME}`);
    expect(text).not.toContain("_eeg.edf");
    expect(JSON.stringify(screen.report)).not.toContain(NAME);
  });

  test("what this run could not see is always said", async () => {
    const screen = await committed(dataset(CLEAN));
    const text = renderLocalScreen(screen).body.join("\n");
    expect(text).toContain(LOCAL_COPY.server.statement);
    // The server's own "Not read" line is kept, so the words are the server's.
    expect(text).toContain("Not read: the contents of sidecars and tables in earlier commits.");
  });
});

describe("nothing is written", () => {
  test("a run leaves the repository, its index and its objects exactly as they were", async () => {
    const repo = dataset(named(1), { unscreened: true });
    repo.annexLink("sub-02/eeg/sub-02_task-rest_eeg.edf", recording(CLEAN));
    repo.annexLink("sub-03/eeg/sub-03_task-rest_eeg.edf", recording(CLEAN), { content: false });
    repo.commit("more");
    repo.file(EDF, recording(CLEAN)); // an uncommitted change, so the index and tree disagree
    // `git status` refreshes the index, so it runs first and the digest is taken after it.
    const status = git(repo.dir, "status", "--porcelain");
    const tree = git(repo.dir, "rev-parse", "HEAD^{tree}");
    const settled = digestTree(repo.dir);
    for (const mode of [committed, working, committed, working]) await mode(repo);
    expect(digestTree(repo.dir)).toBe(settled);
    expect(git(repo.dir, "status", "--porcelain")).toBe(status);
    expect(git(repo.dir, "rev-parse", "HEAD^{tree}")).toBe(tree);
  });

  test("the digest sees a change (the check can fail)", () => {
    const repo = dataset(CLEAN);
    const before = digestTree(repo.dir);
    repo.file("later.txt", "x");
    expect(digestTree(repo.dir)).not.toBe(before);
    const again = digestTree(repo.dir);
    git(repo.dir, "add", "-A");
    expect(digestTree(repo.dir)).not.toBe(again);
  });
});

describe("the annex object store is found without assuming its layout", () => {
  test("content under a hash directory git-annex would not choose is still found", async () => {
    // The fixture stores objects under `Xz/Qk`, which no hash function produces.
    const repo = new Repo();
    repo.annexLink(EDF, recording(named(1)));
    repo.commit();
    expect(statusOf(await committed(repo))).toBe("direct-identifiers");
  });

  test("an annex pointer parses the way the server parses it (one rule, one function)", () => {
    const key = `SHA256E-s2000--${"a".repeat(64)}.edf`;
    expect(parseAnnexPointer(`/annex/objects/${key}\n`, false)?.key).toBe(key);
    expect(parseAnnexPointer(`../../.git/annex/objects/Xz/Qk/${key}/${key}`, true)?.key).toBe(key);
    expect(parseAnnexPointer("not a pointer", false)).toBeNull();
  });
});

describe("the registry is the one the publication screen uses", () => {
  test("a registered reader is wrapped, not replaced", async () => {
    // Every reader the registry holds is read through; a later reader (A6) needs no change here.
    const repo = dataset(named(1));
    const screen = await screenLocalDataset(repo.dir, { committed: true, readers: READERS });
    const versions = screen.report.scan?.readers ?? {};
    for (const reader of READERS) expect(versions[reader.id]).toBe(reader.version);
  });

  test("a temp directory outside any repository is not mistaken for one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dataset-screen-bare-"));
    const screen = await screenLocalDataset(dir, { committed: false });
    expect(screen.report.scan?.status).toBe("no-recordings");
    expect(screen.history).toBe(false);
  });
});

describe("a repository laid out by git-annex itself", () => {
  const have = gitAnnexGate("dataset-screen against real git-annex");

  /** A real annex: init, add two recordings, unlock one, commit. Nothing is laid out by hand. */
  function realAnnex(): Repo {
    const repo = new Repo("annex");
    git(repo.dir, "annex", "init", "-q", "test");
    repo.file("sub-01/eeg/sub-01_task-rest_eeg.edf", recording(named(1)));
    repo.file("sub-02/eeg/sub-02_task-rest_eeg.edf", recording(named(2)));
    git(repo.dir, "annex", "add", "-q", "sub-01", "sub-02");
    repo.commit("add");
    git(repo.dir, "annex", "unlock", "-q", "sub-02/eeg/sub-02_task-rest_eeg.edf");
    repo.commit("unlock");
    return repo;
  }

  test.skipIf(!have)(
    "locked and unlocked recordings are read where git-annex keeps them",
    async () => {
      const repo = realAnnex();
      for (const mode of [committed, working]) {
        const scan = (await mode(repo)).report.scan;
        expect(scan?.status).toBe("direct-identifiers");
        expect(scan?.read_by_format?.edf).toEqual({ files: 2, read: 2, partial: 0, failed: 0 });
      }
    },
  );

  test.skipIf(!have)(
    "a dropped recording is content-absent, and its twin is still read",
    async () => {
      const repo = realAnnex();
      git(repo.dir, "annex", "drop", "--force", "-q", "sub-01/eeg/sub-01_task-rest_eeg.edf");
      for (const mode of [committed, working]) {
        const scan = (await mode(repo)).report.scan;
        expect(scan?.read_by_format?.edf?.files).toBe(2);
        expect(scan?.read_by_format?.edf?.partial).toBe(1);
        expect(scan?.read_by_format?.edf?.read).toBe(1);
        expect(scan?.incomplete_reasons).toContain("content-absent");
        // What was read is still reported: an unread file never hides a finding already made.
        expect(scan?.status).toBe("direct-identifiers");
      }
    },
  );

  test.skipIf(!have)("running the screen does not touch the repository", async () => {
    const repo = realAnnex();
    git(repo.dir, "annex", "drop", "--force", "-q", "sub-01/eeg/sub-01_task-rest_eeg.edf");
    git(repo.dir, "status", "--porcelain");
    const before = digestTree(repo.dir);
    await committed(repo);
    await working(repo);
    expect(digestTree(repo.dir)).toBe(before);
  });
});
