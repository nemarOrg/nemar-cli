/**
 * The git plan builder over a real repository: what it finds in every ref, and what it leaves.
 * All names, dates and keys are invented.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PlanRefused,
  buildGitPlan,
  provenanceNote,
  provenanceReadmeNote,
} from "../../scripts/scrub/plan/build-git-plan";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** No global or system git config, as on a CI runner: the developer's own config hides gaps. */
const GIT_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  return r.stdout.trim();
};

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.org");
  git(dir, "config", "user.name", "t");
  return dir;
}

function commit(
  dir: string,
  files: Record<string, string | null>,
  message: string,
  tag?: string,
): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    if (content === null) {
      rmSync(full, { force: true });
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", message);
  if (tag) git(dir, "tag", tag);
}

const pointer = `/annex/objects/SHA256E-s10--${"a".repeat(64)}.bdf\n`;
const POINTER_KEY = `SHA256E-s10--${"a".repeat(64)}.bdf`;

/** The S3 stage's plan for `dataset`, naming these keys, all scrubbed or all read clean. */
function s3PlanFile(dataset: string, keys: string[], needsScrub: boolean): string {
  const out = mkdtempSync(join(tmpdir(), "plan-s3-"));
  dirs.push(out);
  const path = join(out, "plan.json");
  const size = (k: string) => Number(/-s(\d+)--/.exec(k)?.[1]);
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      dataset,
      bucket: "nemar",
      tags: ["v1.0.0"],
      createdAt: "2026-10-06T00:00:00Z",
      keys: keys.map((k) => ({
        oldKey: k,
        size: size(k),
        needsScrub,
        versionIds: [],
        reasons: needsScrub ? ["patient-name"] : [],
        status: "read",
      })),
      totals: {
        keys: keys.length,
        needScrub: needsScrub ? keys.length : 0,
        bytesToHash: needsScrub ? keys.reduce((n, k) => n + size(k), 0) : 0,
        unreadable: 0,
      },
    }),
  );
  return path;
}
const provenance = (files: string[]) =>
  JSON.stringify({
    dataset: "d",
    files: files.map((f) => ({ file: f, bytes: 100, sha256: "ab" })),
    n_files: files.length,
    total_bytes: 100 * files.length,
  });

describe("the git plan", () => {
  test("finds identifier JSON keys, images under sourcedata and the provenance entries, in every ref", () => {
    const dir = repo();
    commit(dir, { "sub-01/eeg/a.bdf": pointer, "README.md": "r\n" }, "v1", "v1.0.1");
    commit(
      dir,
      {
        "sourcedata/rec/info.json": JSON.stringify({ PatientName: "alice", Device: "x" }),
        "sourcedata/rec/someone.jpg": "jpegbytes",
        "sourcedata/sourcedata_provenance.json": provenance(["rec/someone.jpg", "rec/data.bdf"]),
        "sourcedata/README_sourcedata_provenance.md": "text\n",
      },
      "v2",
      "v1.0.2",
    );
    // Only the OLD version has this key: the builder must still find it.
    commit(
      dir,
      { "sourcedata/rec/info.json": JSON.stringify({ PatientName: "", Device: "x" }) },
      "tip",
    );
    const { plan, report } = buildGitPlan(dir, "nm000001", "2026-10-04", {
      s3PlanPath: s3PlanFile("nm000001", [POINTER_KEY], false),
    });
    expect(plan.dropPaths).toEqual(["sourcedata/rec/someone.jpg"]);
    expect(plan.blankJsonKeys).toEqual({ "sourcedata/rec/info.json": ["patientname"] });
    expect(plan.jsonOps?.["sourcedata/sourcedata_provenance.json"]).toEqual([
      {
        op: "drop-array-entries",
        array: "files",
        matchField: "file",
        matchValues: ["rec/someone.jpg"],
      },
      {
        op: "recount",
        array: "files",
        countKey: "n_files",
        sumKey: "total_bytes",
        sumField: "bytes",
      },
      expect.objectContaining({ op: "set", key: "privacy_correction" }),
    ]);
    expect(plan.appendText.CHANGES).toContain("v1.0.1 to v1.0.2");
    expect(plan.appendText["sourcedata/README_sourcedata_provenance.md"]).toContain(
      "Privacy correction 2026-10-04",
    );
    // The S3 plan scrubs no header here, so neither sentence claims one.
    const note = plan.jsonOps?.["sourcedata/sourcedata_provenance.json"]?.[2];
    expect(note).toEqual({
      op: "set",
      key: "privacy_correction",
      value: provenanceNote("2026-10-04", "files-removed"),
    });
    expect(JSON.stringify(note)).not.toContain("in place");
    expect(plan.appendText["sourcedata/README_sourcedata_provenance.md"]).not.toContain("in place");
    expect(report).toEqual({
      refs: 3,
      commits: 3,
      dropPaths: 1,
      jsonFilesBlanked: 1,
      jsonKeysBlanked: 1,
      provenanceEntriesDropped: 1,
      provenanceAnnotated: 1,
      provenanceReadmeAnnotated: 1,
      s3KeysScrubbed: 0,
      skippedOversizeJson: 0,
      skippedUnparseableJson: 0,
      orphanKeys: 0,
      versions: ["v1.0.1", "v1.0.2"],
    });
  });

  test("leaves alone what it should: BIDS photos, images outside sourcedata, author JSON, review-only keys, annex pointers", () => {
    const dir = repo();
    commit(
      dir,
      {
        "sub-01/eeg/sub-01_photo.jpg": "p",
        "docs/figure.png": "p",
        "dataset_description.json": JSON.stringify({
          Authors: [{ name: "Dr A" }],
          GeneratedBy: [{ Name: "tool" }],
        }),
        "sourcedata/rec/contact.json": JSON.stringify({ Contact: "555-0100", Address: "x" }),
        "sub-01/eeg/a.bdf": pointer,
      },
      "v1",
      "v1.0.0",
    );
    const { plan, report } = buildGitPlan(dir, "nm000001", "2026-10-04");
    expect(plan.dropPaths).toEqual([]);
    expect(plan.blankJsonKeys).toEqual({});
    expect(plan.jsonOps).toBeUndefined();
    expect(report.dropPaths + report.jsonFilesBlanked).toBe(0);
  });

  test("no provenance entries are touched when nothing is dropped, and a provenance file is optional", () => {
    const dir = repo();
    commit(dir, { "sourcedata/sourcedata_provenance.json": provenance(["a.bdf"]) }, "v1", "v1.0.0");
    const nothing = s3PlanFile("nm000001", [], false);
    expect(
      buildGitPlan(dir, "nm000001", "2026-10-04", { s3PlanPath: nothing }).plan.jsonOps,
    ).toBeUndefined();
    const other = repo();
    commit(other, { "sourcedata/x.png": "p" }, "v1", "v1.0.0");
    const { plan } = buildGitPlan(other, "nm000001", "2026-10-04");
    expect(plan.dropPaths).toEqual(["sourcedata/x.png"]);
    expect(plan.jsonOps).toBeUndefined();
  });

  test("names with spaces and non-ASCII characters survive intact", () => {
    const dir = repo();
    commit(dir, { "sourcedata/2C dataset/sub-01/截图.jpg": "p" }, "v1", "v1.0.0");
    expect(buildGitPlan(dir, "nm000001", "2026-10-04").plan.dropPaths).toEqual([
      "sourcedata/2C dataset/sub-01/截图.jpg",
    ]);
  });

  test("a repository with no version tags is refused", () => {
    const dir = repo();
    commit(dir, { "a.txt": "a" }, "v1");
    expect(() => buildGitPlan(dir, "nm000001", "2026-10-04")).toThrow(PlanRefused);
  });
  test("finds a path and a JSON key that live only between two tags, and only on an unreleased branch", () => {
    const dir = repo();
    commit(dir, { "README.md": "r\n" }, "v1", "v1.0.0");
    // Added after v1.0.0 and gone before v1.0.1: no tag and no tip holds either.
    commit(
      dir,
      {
        "sourcedata/mid/face.jpg": "p",
        "sourcedata/mid/info.json": JSON.stringify({ PatientName: "alice" }),
      },
      "between",
    );
    commit(
      dir,
      { "sourcedata/mid/face.jpg": null, "sourcedata/mid/info.json": null },
      "v2",
      "v1.0.1",
    );
    // An unreleased head that is not main: neither main nor a tag reaches it.
    git(dir, "checkout", "-q", "-b", "wip");
    commit(
      dir,
      {
        "sourcedata/wip/shot.png": "p",
        "sourcedata/wip/sidecar.json": JSON.stringify({ PatientID: "bob" }),
      },
      "wip tip",
    );
    git(dir, "checkout", "-q", "main");
    // Main moves on after the last tag, adds, and removes again: only its history holds them.
    commit(
      dir,
      { "sourcedata/late/scan.pdf": "p", "late.json": '{"MRN":"x","Device":"y"}' },
      "late",
    );
    commit(dir, { "sourcedata/late/scan.pdf": null, "late.json": "{}" }, "tip");
    const { plan, report } = buildGitPlan(dir, "nm000001", "2026-10-04");
    expect(plan.dropPaths).toEqual([
      "sourcedata/late/scan.pdf",
      "sourcedata/mid/face.jpg",
      "sourcedata/wip/shot.png",
    ]);
    expect(plan.blankJsonKeys).toEqual({
      "late.json": ["mrn"],
      "sourcedata/mid/info.json": ["patientname"],
      "sourcedata/wip/sidecar.json": ["patientid"],
    });
    expect(report.refs).toBe(4); // main, wip, two tags
    expect(report.commits).toBe(6);
  });

  test("a JSON file that starts with a byte-order mark is read, as the rewrite reads it", () => {
    const dir = repo();
    commit(
      dir,
      { "sourcedata/bom.json": `\uFEFF${JSON.stringify({ PatientName: "x" })}` },
      "v1",
      "v1.0.0",
    );
    expect(buildGitPlan(dir, "nm000001", "2026-10-04").plan.blankJsonKeys).toEqual({
      "sourcedata/bom.json": ["patientname"],
    });
  });

  test("a blob that exists only in a merge's own result is read", () => {
    const dir = repo();
    commit(dir, { "README.md": "r\n" }, "v1", "v1.0.0");
    git(dir, "checkout", "-q", "-b", "side");
    commit(dir, { "side.txt": "s\n" }, "side");
    git(dir, "checkout", "-q", "main");
    commit(dir, { "main.txt": "m\n" }, "main");
    git(dir, "merge", "-q", "--no-commit", "--no-ff", "side");
    // The merge result carries a file neither parent has, as a hand-resolved merge can.
    mkdirSync(join(dir, "sourcedata"));
    writeFileSync(join(dir, "sourcedata/merged.json"), JSON.stringify({ PatientName: "q" }));
    writeFileSync(join(dir, "sourcedata/merged.pdf"), "p");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "merge");
    commit(dir, { "sourcedata/merged.json": "{}", "sourcedata/merged.pdf": null }, "tip");
    const { plan } = buildGitPlan(dir, "nm000001", "2026-10-04");
    expect(plan.dropPaths).toEqual(["sourcedata/merged.pdf"]);
    expect(plan.blankJsonKeys).toEqual({ "sourcedata/merged.json": ["patientname"] });
  });

  test("a 300-commit history over a 2,000-file tree is read to its middle", () => {
    // Built with fast-import. The identifying path and key live in commit 150 only; a walk that
    // read only tips would miss them.
    const dir = repo();
    const files = 2000;
    let stream = "";
    let mark = 1;
    const blob = (content: string): number => {
      const id = mark++;
      stream += `blob\nmark :${id}\ndata ${Buffer.byteLength(content)}\n${content}\n`;
      return id;
    };
    const commitAt = (n: number, changes: [string, number | null][], from?: number): number => {
      const id = mark++;
      stream += `commit refs/heads/main\nmark :${id}\ncommitter t <t@example.org> ${1700000000 + n} +0000\ndata ${`c${n}`.length}\nc${n}\n`;
      if (from) stream += `from :${from}\n`;
      for (const [path, m] of changes)
        stream += m === null ? `D ${path}\n` : `M 100644 :${m} ${path}\n`;
      return id;
    };
    const base: [string, number | null][] = [];
    for (let i = 0; i < files; i++)
      base.push([
        `sub-${i}/eeg/rec.edf`,
        blob(`/annex/objects/SHA256E-s${i + 1}--${"a".repeat(64)}.edf\n`),
      ]);
    let tip = commitAt(0, base);
    for (let n = 1; n <= 300; n++) {
      const changes: [string, number | null][] = [["meta/info.json", blob(JSON.stringify({ n }))]];
      if (n === 150) {
        changes.push(["sourcedata/deep/face.jpg", blob("p")]);
        changes.push(["sourcedata/deep/info.json", blob(JSON.stringify({ PatientName: "z" }))]);
      }
      if (n === 151) {
        changes.push(["sourcedata/deep/face.jpg", null]);
        changes.push(["sourcedata/deep/info.json", null]);
      }
      tip = commitAt(n, changes, tip);
      if (n % 100 === 0) stream += `reset refs/tags/v${n / 100}.0.0\nfrom :${tip}\n\n`;
    }
    const r = spawnSync("git", ["-C", dir, "fast-import", "--quiet"], {
      env: GIT_ENV,
      input: stream,
      maxBuffer: 1 << 30,
    });
    expect(r.status, String(r.stderr)).toBe(0);
    const { plan, report } = buildGitPlan(dir, "nm000001", "2026-10-04");
    expect(report.commits).toBe(301);
    expect(plan.dropPaths).toEqual(["sourcedata/deep/face.jpg"]);
    expect(plan.blankJsonKeys).toEqual({ "sourcedata/deep/info.json": ["patientname"] });
  }, 60_000);

  test("the CLI writes the plan owner-only, even over a looser existing file", () => {
    const dir = repo();
    commit(dir, { "dataset_description.json": "{}", CHANGES: "x\n" }, "one", "v1.0.0");
    const out = join(mkdtempSync(join(tmpdir(), "plan-out-")), "git-plan.json");
    dirs.push(dirname(out));
    writeFileSync(out, "old", { mode: 0o644 });
    chmodSync(out, 0o644);
    const r = spawnSync(
      "bun",
      [
        "run",
        join(import.meta.dir, "../../scripts/scrub/plan/build-git-plan.ts"),
        "--repo",
        dir,
        "--dataset",
        "nm099999",
        "--out",
        out,
      ],
      { encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });
});

const CLI = join(import.meta.dir, "../../scripts/scrub/plan/build-git-plan.ts");
const cliPlan = (dir: string, out: string, extra: string[] = []) =>
  spawnSync("bun", ["run", CLI, "--repo", dir, "--dataset", "nm099999", "--out", out, ...extra], {
    encoding: "utf8",
    // Bun colors console.error under FORCE_COLOR; the tests read the exact words.
    env: { ...GIT_ENV, FORCE_COLOR: "0", NO_COLOR: "1" },
  });

describe("the git plan refuses what it could not read (I4, S5, S6)", () => {
  test("inline JSON over the size limit, or not JSON, is counted, named privately, and refused", () => {
    const dir = repo();
    // 1.1 MiB of JSON holding an identifier key, and a malformed one: neither can be scanned.
    const big = JSON.stringify({ PatientName: "Marigold", pad: "x".repeat(1_150_000) });
    commit(
      dir,
      { "sub-01/big.json": big, "sub-01/bad.json": '{"PatientName": "Marigold"', CHANGES: "x\n" },
      "one",
      "v1.0.0",
    );
    expect(() => buildGitPlan(dir, "nm099999", "2026-10-04")).toThrow(
      "skipped-json (oversize=1 unparseable=1)",
    );
    const outDir = mkdtempSync(join(tmpdir(), "plan-skipped-"));
    dirs.push(outDir);
    const out = join(outDir, "git-plan.json");
    const r = cliPlan(dir, out);
    expect(r.status, r.stderr).toBe(3);
    expect(r.stderr).toContain("git plan refused: skipped-json (oversize=1 unparseable=1)");
    // Counts on the terminal; the names only in the private file; no plan to run on.
    expect(r.stderr).not.toContain("big.json");
    expect(existsSync(out)).toBe(false);
    const skipped = JSON.parse(readFileSync(`${out}.skipped.json`, "utf8"));
    expect(skipped).toEqual({
      version: 1,
      dataset: "nm099999",
      oversize: ["sub-01/big.json"],
      unparseable: ["sub-01/bad.json"],
    });
    expect(statSync(`${out}.skipped.json`).mode & 0o777).toBe(0o600);

    // A person looked: the plan is written, says what it did not read, and the counts say so.
    const ok = cliPlan(dir, out, ["--allow-skipped-json"]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({
      skippedOversizeJson: 1,
      skippedUnparseableJson: 1,
    });
    expect(JSON.parse(readFileSync(out, "utf8")).skippedJson).toEqual({
      oversize: ["sub-01/big.json"],
      unparseable: ["sub-01/bad.json"],
    });
    expect(existsSync(`${out}.skipped.json`)).toBe(false);
  });

  test("a v* tag that is not vX.Y.Z is refused with a count, never filtered", () => {
    const dir = repo();
    commit(dir, { CHANGES: "x\n" }, "one", "v1.0.0");
    commit(dir, { CHANGES: "y\n" }, "two", "v1.1");
    commit(dir, { CHANGES: "z\n" }, "three", "v2-beta");
    expect(() => buildGitPlan(dir, "nm099999", "2026-10-04")).toThrow("tag-not-semver (2)");
    const outDir = mkdtempSync(join(tmpdir(), "plan-semver-"));
    dirs.push(outDir);
    const r = cliPlan(dir, join(outDir, "git-plan.json"));
    expect(r.status).toBe(3);
    expect(r.stderr.trim()).toBe("git plan refused: tag-not-semver (2)");
  });

  test("with the S3 plan, a key it scrubs that no commit names is refused as an orphan", () => {
    const dir = repo();
    const named = `SHA256E-s10--${"a".repeat(64)}.bdf`;
    const orphan = `SHA256E-s10--${"b".repeat(64)}.edf`;
    commit(
      dir,
      { "sub-01/eeg/x.bdf": `/annex/objects/${named}\n`, CHANGES: "x\n" },
      "one",
      "v1.0.0",
    );
    const outDir = mkdtempSync(join(tmpdir(), "plan-orphan-"));
    dirs.push(outDir);
    const s3Plan = (keys: string[]) => {
      const path = join(outDir, "plan.json");
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          dataset: "nm099999",
          bucket: "nemar",
          tags: ["v1.0.0"],
          createdAt: "2026-10-04T00:00:00Z",
          keys: keys.map((k) => ({
            oldKey: k,
            size: 10,
            needsScrub: true,
            versionIds: [],
            reasons: ["x"],
            status: "read",
          })),
          totals: {
            keys: keys.length,
            needScrub: keys.length,
            bytesToHash: 10 * keys.length,
            unreadable: 0,
          },
        }),
      );
      return path;
    };
    const fine = buildGitPlan(dir, "nm099999", "2026-10-04", { s3PlanPath: s3Plan([named]) });
    expect(fine.report.orphanKeys).toBe(0);
    expect(() =>
      buildGitPlan(dir, "nm099999", "2026-10-04", { s3PlanPath: s3Plan([named, orphan]) }),
    ).toThrow("orphan-key (1)");
  });
});

describe("the provenance file of a sourcedata mirror keeps its upstream checksums (ADR 0085)", () => {
  const PROV = "sourcedata/sourcedata_provenance.json";
  const PROV_README = "sourcedata/README_sourcedata_provenance.md";
  const DATE = "2026-10-06";
  const sha = (label: string) => createHash("sha256").update(label).digest("hex");
  /** The key of the mirrored original: its sha256 is the checksum the provenance file lists. */
  const original = (n: number) => `SHA256E-s10--${sha(`orig-${n}`)}.edf`;
  const recording = (n: number) => `SHA256E-s20--${sha(`rec-${n}`)}.edf`;
  const mirrorProvenance = (ns: number[]) =>
    `${JSON.stringify(
      {
        source: "an upstream release",
        n_files: ns.length,
        total_bytes: 10 * ns.length,
        files: ns.map((n) => ({ file: `up/rec-${n}.edf`, bytes: 10, sha256: sha(`orig-${n}`) })),
      },
      null,
      2,
    )}\n`;

  /** A dataset that mirrors two upstream recordings, with the provenance file and its README. */
  function mirrorRepo(extra: Record<string, string> = {}, provenance = true): string {
    const dir = repo();
    const files: Record<string, string> = { CHANGES: "1.0.0\n", ...extra };
    for (const n of [1, 2]) {
      files[`sub-0${n}/eeg/sub-0${n}_eeg.edf`] = `/annex/objects/${recording(n)}\n`;
      files[`sourcedata/up/rec-${n}.edf`] = `/annex/objects/${original(n)}\n`;
    }
    if (provenance) {
      files[PROV] = mirrorProvenance([1, 2]);
      files[PROV_README] = "The files under sourcedata/ are the upstream files, unmodified.\n";
    }
    commit(dir, files, "v1", "v1.0.0");
    return dir;
  }

  const ALL = [recording(1), recording(2), original(1), original(2)];

  test("scrubbed purely in place (nothing dropped): the file gets the sentence, keeps every entry, and nothing says a file was removed", () => {
    const dir = mirrorRepo();
    const { plan, report } = buildGitPlan(dir, "nm099999", DATE, {
      s3PlanPath: s3PlanFile("nm099999", ALL, true),
    });
    expect(plan.dropPaths).toEqual([]);
    // Only the sentence: no entry is dropped and no count is recomputed.
    expect(plan.jsonOps?.[PROV]).toEqual([
      { op: "set", key: "privacy_correction", value: provenanceNote(DATE, "scrubbed-in-place") },
    ]);
    const note = provenanceNote(DATE, "scrubbed-in-place");
    expect(note).toContain("scrubbed in place");
    expect(note).toContain("describe the original upstream files, not the scrubbed copies");
    expect(note).not.toContain("removed");
    const readme = plan.appendText[PROV_README];
    expect(readme).toBe(provenanceReadmeNote(DATE, "scrubbed-in-place"));
    expect(readme).toContain("scrubbed in place");
    expect(readme).not.toContain("removed");
    expect(report).toMatchObject({
      dropPaths: 0,
      provenanceEntriesDropped: 0,
      provenanceAnnotated: 1,
      provenanceReadmeAnnotated: 1,
      s3KeysScrubbed: 4,
      orphanKeys: 0,
    });
  });

  test("scrubbed in place and a file dropped: the entries go, the counts follow, and the sentence says both", () => {
    const dir = mirrorRepo({ "sourcedata/up/screen.png": "png" });
    const { plan, report } = buildGitPlan(dir, "nm099999", DATE, {
      s3PlanPath: s3PlanFile("nm099999", ALL, true),
    });
    expect(plan.dropPaths).toEqual(["sourcedata/up/screen.png"]);
    expect(plan.jsonOps?.[PROV]).toEqual([
      {
        op: "drop-array-entries",
        array: "files",
        matchField: "file",
        matchValues: ["up/screen.png"],
      },
      {
        op: "recount",
        array: "files",
        countKey: "n_files",
        sumKey: "total_bytes",
        sumField: "bytes",
      },
      { op: "set", key: "privacy_correction", value: provenanceNote(DATE, "both") },
    ]);
    expect(provenanceNote(DATE, "both")).toContain("removed");
    expect(provenanceNote(DATE, "both")).toContain("scrubbed in place");
    expect(plan.appendText[PROV_README]).toBe(provenanceReadmeNote(DATE, "both"));
    expect(report).toMatchObject({
      provenanceEntriesDropped: 1,
      provenanceAnnotated: 1,
      provenanceReadmeAnnotated: 1,
    });
  });

  test("nothing scrubbed and nothing dropped: neither the file nor its README is touched", () => {
    const dir = mirrorRepo();
    const { plan, report } = buildGitPlan(dir, "nm099999", DATE, {
      s3PlanPath: s3PlanFile("nm099999", ALL, false),
    });
    expect(plan.jsonOps).toBeUndefined();
    expect(Object.keys(plan.appendText)).toEqual(["CHANGES"]);
    expect(report).toMatchObject({
      provenanceAnnotated: 0,
      provenanceReadmeAnnotated: 0,
      s3KeysScrubbed: 0,
    });
  });

  test("a dataset with no provenance file is unchanged: no sentence, no note, the same plan as before", () => {
    const dir = mirrorRepo({}, false);
    const { plan, report } = buildGitPlan(dir, "nm099999", DATE, {
      s3PlanPath: s3PlanFile("nm099999", ALL, true),
    });
    expect(plan).toEqual({
      version: 1,
      dataset: "nm099999",
      dropPaths: [],
      blankJsonKeys: {},
      appendText: { CHANGES: plan.appendText.CHANGES as string },
    });
    expect(report).toMatchObject({
      provenanceAnnotated: 0,
      provenanceReadmeAnnotated: 0,
      provenanceEntriesDropped: 0,
      s3KeysScrubbed: 4,
    });
  });

  test("without an S3 plan, a history with the provenance file or its README is refused, and no plan is written", () => {
    const withFile = mirrorRepo();
    expect(() => buildGitPlan(withFile, "nm099999", DATE)).toThrow("s3-plan-required");
    const readmeOnly = repo();
    commit(readmeOnly, { [PROV_README]: "upstream files\n", CHANGES: "1.0.0\n" }, "v1", "v1.0.0");
    expect(() => buildGitPlan(readmeOnly, "nm099999", DATE)).toThrow("s3-plan-required");
    const outDir = mkdtempSync(join(tmpdir(), "plan-required-"));
    dirs.push(outDir);
    const out = join(outDir, "git-plan.json");
    const r = cliPlan(withFile, out);
    expect(r.status, r.stderr).toBe(3);
    expect(r.stderr.trim()).toBe("git plan refused: s3-plan-required");
    expect(existsSync(out)).toBe(false);
    // With the S3 plan it plans; and a dataset with neither file still plans without one.
    expect(
      buildGitPlan(withFile, "nm099999", DATE, { s3PlanPath: s3PlanFile("nm099999", ALL, true) })
        .report.provenanceAnnotated,
    ).toBe(1);
    expect(buildGitPlan(mirrorRepo({}, false), "nm099999", DATE).report.s3KeysScrubbed).toBe(-1);
  });

  test("each sentence says exactly what changed, and none is empty", () => {
    for (const note of [provenanceNote, provenanceReadmeNote]) {
      const inPlace = note(DATE, "scrubbed-in-place");
      const removed = note(DATE, "files-removed");
      const both = note(DATE, "both");
      expect(inPlace).toContain("scrubbed in place");
      expect(inPlace).toContain("not the scrubbed copies");
      expect(inPlace).not.toContain("removed");
      expect(removed).toContain("were removed");
      expect(removed).not.toContain("in place");
      expect(removed).not.toContain("scrubbed copies");
      expect(both).toContain("scrubbed in place");
      expect(both).toContain("were removed");
      expect(both).toContain("not the scrubbed copies");
      for (const text of [inPlace, removed, both]) {
        expect(text.trim()).toMatch(/^(Privacy correction )?2026-10-06: [a-z]/);
        expect(text).not.toContain(": ;");
      }
    }
  });
});
