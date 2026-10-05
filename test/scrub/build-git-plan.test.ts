/**
 * The git plan builder over a real repository: what it finds in every ref, and what it leaves.
 * All names, dates and keys are invented.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PlanRefused, buildGitPlan } from "../../scripts/scrub/plan/build-git-plan";

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
    const { plan, report } = buildGitPlan(dir, "nm000001", "2026-10-04");
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
    expect(report).toEqual({
      refs: 3,
      commits: 3,
      dropPaths: 1,
      jsonFilesBlanked: 1,
      jsonKeysBlanked: 1,
      provenanceEntriesDropped: 1,
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
    expect(buildGitPlan(dir, "nm000001", "2026-10-04").plan.jsonOps).toBeUndefined();
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
