/**
 * A file named like a recording whose bytes are not an EDF or BDF header, driven through
 * `prepareImportedTreeForCopy`, the call `prepareImport` makes for its step 5b (ADR 0089).
 *
 * `importHeaderPatch` (`shared/identifier-scrub.ts`) answers `not-edf` for it, and the importer's
 * wrapper `patchHeader` has to turn that into "count it and leave it", never into a refusal: a
 * text file named `.edf` is the identifier screen's to judge, and refusing it would stop an import
 * over a file the scrub cannot rewrite anyway. `test/import-scrub.test.ts` has no case that reads
 * such a header (its empty recording is never read), so this is the one that does.
 *
 * Real git and git-annex, a real `type=directory` special remote named `nemar-s3`, and the real
 * `findUnannexedData` deciding what git holds that policy calls data. No upstream object is
 * annexed, so nothing is read over the network. Every value is invented.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand } from "../src/lib/git-annex/run-command";
import { listAnnexedKeys } from "../src/lib/git-annex/transfer";
import { annexCopyUpload } from "../src/lib/import-normalize";
import { findUnannexedData } from "../src/lib/import-openneuro";
import { httpUpstreamReader, prepareImportedTreeForCopy } from "../src/lib/import-scrub";

const HAVE_ANNEX = Bun.spawnSync(["git", "annex", "version"], { stdout: "ignore" }).exitCode === 0;
const SUITE = HAVE_ANNEX ? describe : describe.skip;

const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch) {
    // git-annex leaves its object directories read-only.
    await runCommand(["chmod", "-R", "u+w", dir], { cwd: tmpdir() });
    rmSync(dir, { recursive: true, force: true });
  }
});

async function run(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr, exitCode } = await runCommand(args, { cwd });
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout;
}

/** Long enough to be read as a whole header, and not one. */
const TEXT_RECORDING = "sub-01/eeg/sub-01_task-rest_eeg.edf";
/** Shorter than a header: refused by the scrub as too short, which is also not an EDF. */
const SHORT_RECORDING = "sub-02/eeg/sub-02_task-rest_eeg.bdf";

SUITE("a recording that is not an EDF or BDF header", () => {
  test("is read, counted as not EDF, annexed by the policy step, and nothing refuses", async () => {
    const parent = mkdtempSync(join(tmpdir(), "nemar-scrub-not-edf-"));
    scratch.push(parent);
    const clone = join(parent, "on999999");
    const store = join(parent, "store");
    mkdirSync(clone);
    mkdirSync(store);
    await run(["git", "init", "-q", "--initial-branch", "main", "."], clone);
    await run(["git", "config", "user.email", "test@nemar.test"], clone);
    await run(["git", "config", "user.name", "NEMAR Test"], clone);
    await run(["git", "annex", "init", "--quiet", "import clone"], clone);
    const files: Record<string, string> = {
      ".gitattributes": "* annex.backend=SHA256E\n* annex.largefiles=nothing\n",
      "dataset_description.json": '{"Name": "fixture", "BIDSVersion": "1.8.0"}\n',
      [TEXT_RECORDING]: "This is a text file that only has a recording's name.\n".repeat(8),
      [SHORT_RECORDING]: "short\n",
    };
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(clone, path)), { recursive: true });
      writeFileSync(join(clone, path), body);
    }
    await run(["git", "add", "."], clone);
    await run(["git", "commit", "-qm", "upstream snapshot"], clone);
    await run(
      [
        "git",
        "annex",
        "initremote",
        "nemar-s3",
        "type=directory",
        `directory=${store}`,
        "encryption=none",
      ],
      clone,
    );

    const unannexedData = await findUnannexedData(clone);
    expect(unannexedData.map((f) => f.path).sort()).toEqual([TEXT_RECORDING, SHORT_RECORDING]);

    const result = await prepareImportedTreeForCopy({
      datasetPath: clone,
      nemarId: "on999999",
      bucket: "nemar",
      remoteName: "nemar-s3",
      keyUrlMap: new Map(),
      upstreamItems: [],
      unannexedData,
      reimport: false,
      skipData: false,
      // Nothing is annexed upstream, so no header is read over the network.
      reader: httpUpstreamReader({ baseUrl: "http://127.0.0.1:9", attempts: 1 }),
      upload: annexCopyUpload({ credentials: "inherit" }),
      now: new Date("2026-10-23T12:00:00.000Z"),
      actor: "fixture-actor",
    });

    expect(result.scrub.counts.recordings).toBe(2);
    expect(result.scrub.counts.headers_read).toBe(2);
    expect(result.scrub.counts.headers_not_edf).toBe(2);
    expect(result.scrub.counts.headers_scrubbed).toBe(0);
    expect(result.scrub.counts.headers_dates_normalized).toBe(0);
    expect(result.scrub.committed).toBe(false);
    // The policy step still annexes both, as data, under their own unchanged content.
    const annexed = await listAnnexedKeys(clone);
    expect([...annexed.keys()].sort()).toEqual([TEXT_RECORDING, SHORT_RECORDING]);
  }, 120_000);
});
