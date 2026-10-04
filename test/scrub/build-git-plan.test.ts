/**
 * The git plan builder over a real repository: what it finds in every ref, and what it leaves.
 * All names, dates and keys are invented.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PlanRefused, buildGitPlan } from "../../scripts/scrub/plan/build-git-plan";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
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

  test("a repository with no version tags is refused, and so is a bad dataset id in the plan guard", () => {
    const dir = repo();
    commit(dir, { "a.txt": "a" }, "v1");
    expect(() => buildGitPlan(dir, "nm000001", "2026-10-04")).toThrow(PlanRefused);
  });
});
