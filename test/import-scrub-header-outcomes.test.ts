/**
 * The two header outcomes the importer does not patch, driven through `prepareImportedTreeForCopy`,
 * the call `prepareImport` makes for its step 5b (ADR 0089). `importHeaderPatch`
 * (`shared/identifier-scrub.ts`) reports them; the importer's wrapper `patchHeader` decides what
 * they mean, and that decision is what these tests hold.
 *
 * - `not-edf`: a file named like a recording whose bytes are not an EDF or BDF header must be
 *   counted and left, never refused: a text file named `.edf` is the identifier screen's to
 *   judge, and refusing it would stop an import over a file the scrub cannot rewrite anyway.
 * - `scrub-unverified`: a header the scrub rewrites but cannot prove clean must refuse the import
 *   with `scrub-unverified` before anything is written, committed or pushed.
 *
 * `test/import-scrub.test.ts` has a case for neither (its empty recording is never read).
 *
 * The path exercised is the GIT-HELD header: the recordings are committed to git, so the scrub
 * reads their first bytes from the clone (`readLocalHeader`), not by an upstream ranged read, and
 * no upstream object is annexed, so nothing is read over the network. The upstream path reaches
 * the same `patchHeader` and is driven by `test/import-scrub.test.ts`.
 *
 * Real git and git-annex, a real `type=directory` special remote named `nemar-s3`, and the real
 * `findUnannexedData` deciding what git holds that policy calls data. Without git-annex the suite
 * skips on a developer machine and FAILS when `NEMAR_REQUIRE_SCRUB_TOOLS=1` (`toolOrFail`), so it
 * can never pass vacuously in CI. Every value is invented.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EDF_HEADER_BYTES } from "../shared/identifier-scan";
import { runCommand } from "../src/lib/git-annex/run-command";
import { listAnnexedKeys } from "../src/lib/git-annex/transfer";
import { annexCopyUpload } from "../src/lib/import-normalize";
import { findUnannexedData } from "../src/lib/import-openneuro";
import {
  ImportScrubRefused,
  httpUpstreamReader,
  prepareImportedTreeForCopy,
} from "../src/lib/import-scrub";
import { toolOrFail } from "./scrub/helpers/require-tools";

function probe(cmd: string[]): boolean {
  try {
    return Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
}

const HAVE_ANNEX = toolOrFail("git-annex", probe(["git", "annex", "version"]));
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

/** A clone as prepare holds it before step 5b: these files committed to git, `nemar-s3` configured. */
async function cloneWith(files: Record<string, string | Uint8Array>): Promise<string> {
  const parent = mkdtempSync(join(tmpdir(), "nemar-scrub-outcomes-"));
  scratch.push(parent);
  const clone = join(parent, "on999999");
  const store = join(parent, "store");
  mkdirSync(clone);
  mkdirSync(store);
  await run(["git", "init", "-q", "--initial-branch", "main", "."], clone);
  await run(["git", "config", "user.email", "test@nemar.test"], clone);
  await run(["git", "config", "user.name", "NEMAR Test"], clone);
  await run(["git", "annex", "init", "--quiet", "import clone"], clone);
  const all: Record<string, string | Uint8Array> = {
    ".gitattributes": "* annex.backend=SHA256E\n* annex.largefiles=nothing\n",
    "dataset_description.json": '{"Name": "fixture", "BIDSVersion": "1.8.0"}\n',
    ...files,
  };
  for (const [path, body] of Object.entries(all)) {
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
  return clone;
}

async function prepare(clone: string) {
  return prepareImportedTreeForCopy({
    datasetPath: clone,
    nemarId: "on999999",
    bucket: "nemar",
    remoteName: "nemar-s3",
    keyUrlMap: new Map(),
    upstreamItems: [],
    unannexedData: await findUnannexedData(clone),
    reimport: false,
    skipData: false,
    // Nothing is annexed upstream, so no header is read over the network.
    reader: httpUpstreamReader({ baseUrl: "http://127.0.0.1:9", attempts: 1 }),
    upload: annexCopyUpload({ credentials: "inherit" }),
    now: new Date("2026-10-23T12:00:00.000Z"),
    actor: "fixture-actor",
  });
}

/** Long enough to be read as a whole header, and not one. */
const TEXT_RECORDING = "sub-01/eeg/sub-01_task-rest_eeg.edf";
/** Shorter than a header: refused by the scrub as too short, which is also not an EDF. */
const SHORT_RECORDING = "sub-02/eeg/sub-02_task-rest_eeg.bdf";

/**
 * A header the scrub rewrites and cannot prove clean, found by a seeded fuzz in review of #1925:
 * the recording field's leading `Startdate 99-ZZZ-9999` has the `dd-MMM-yyyy` shape the scrub's
 * placeholder keeps, and the scanner reads that kept token as free text, so `verifyScrub` reports
 * `identifying-content-remains`.
 */
function unverifiableRecording(): Uint8Array {
  const out = new Uint8Array(EDF_HEADER_BYTES + 512).fill(0x20);
  const put = (text: string, start: number) => {
    for (let i = 0; i < text.length; i++) out[start + i] = text.charCodeAt(i);
  };
  put("0", 0);
  put("Startdate 99-ZZZ-9999 00-JAN-0000 14-MAR-2023 M P_01", 88);
  put("14.03.23", 168);
  put("10.11.12", 176);
  for (let i = EDF_HEADER_BYTES; i < out.length; i++) out[i] = (i * 37) & 0xff;
  return out;
}

SUITE("a recording that is not an EDF or BDF header", () => {
  test("is read, counted as not EDF, annexed by the policy step, and nothing refuses", async () => {
    const clone = await cloneWith({
      [TEXT_RECORDING]: "This is a text file that only has a recording's name.\n".repeat(8),
      [SHORT_RECORDING]: "short\n",
    });
    expect((await findUnannexedData(clone)).map((f) => f.path).sort()).toEqual([
      TEXT_RECORDING,
      SHORT_RECORDING,
    ]);

    const result = await prepare(clone);

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

SUITE("a recording whose scrub cannot be proven", () => {
  test("refuses with scrub-unverified while deciding, before any byte is written", async () => {
    const bytes = unverifiableRecording();
    const clone = await cloneWith({ [TEXT_RECORDING]: bytes });
    const head = (await run(["git", "rev-parse", "HEAD"], clone)).trim();

    const err = await prepare(clone).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ImportScrubRefused);
    expect((err as ImportScrubRefused).code).toBe("scrub-unverified");
    // The decision-phase refusal (`patchHeader`), not the in-place patch's link or read-back ones.
    expect((err as Error).message).toContain("a patched header failed its proof");
    expect((err as Error).message).not.toContain("not a regular file");
    // Failed closed: the recording is as committed, and nothing was committed on top.
    expect(new Uint8Array(readFileSync(join(clone, TEXT_RECORDING)))).toEqual(bytes);
    expect((await run(["git", "rev-parse", "HEAD"], clone)).trim()).toBe(head);
  }, 120_000);
});
