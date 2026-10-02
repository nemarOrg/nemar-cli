/**
 * `session_modalities` in `extensions.nemar.bids_index` of `metadata.json`
 * (epic #1586 Phase 2, #1588).
 *
 * `sessions` and `modalities` are separate sets per subject, so the pairing of
 * a session with its datatypes was lost; Neurobagel's graph mode needs it to
 * say which acquisitions belong to which imaging session. `session_modalities`
 * restores it ADDITIVELY: one key per session label (plus `NO_SESSION_KEY` for
 * datatypes outside every session directory), each a sorted list of datatype
 * directories.
 *
 * What this file proves, and against what:
 *
 *  - REAL manifests. `nm000132` has no session directories at all. `on004196`
 *    has three sessions per subject holding different datatypes (one with no
 *    eeg, one with nothing but). `on006033` has a subject whose first session
 *    lacks the eeg its second has. `on007347` is a mixed layout, `anat` at the
 *    subject with `eeg` in numbered sessions. Where each came from is in
 *    `fixtures/bids-index-sessions/provenance.json`, and the first test
 *    recomputes the hashes. The expected pairings below are literals read off
 *    those manifests, not the output of the code under test.
 *  - THE ROUTE. Every claim that matters to a consumer is checked on the body
 *    `GET /<id>/metadata.json` serves through the real `dataRoutes` app, a real
 *    D1 and a real local HTTP server standing in for S3, not only on the pure
 *    builder.
 *  - NOTHING EXISTING MOVED. `pre-change-bids-index.json` holds what the same
 *    manifests produced before the field existed, captured from the base commit
 *    (`digestManifest`'s subjects and the whole served body). Today's output
 *    with `session_modalities` removed must equal it byte for byte.
 *  - ONE MANIFEST READ (ADR 0072). The route reads the manifest once per
 *    request, exactly as before; the field is derived from the same streamed
 *    digest and adds no second pass.
 *
 * Synthetic manifests are used only where no real one reaches the rule, and
 * each says which rule it pins.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NO_SESSION_KEY, bidsIndexSchema } from "../../shared/contract/index.js";
import {
  BidsIndexBuilder,
  type BidsIndexSubjectNode,
  buildBidsIndex,
  digestManifest,
} from "../src/services/data-router";
import type { ManifestFile } from "../src/services/manifest";
import { DigestQuery } from "../src/services/manifest-queries";
import { scanManifestStream } from "../src/services/manifest-scan";
import { resetManifestAnswerMemo } from "../src/services/manifest-source";
import { __resetPublicReadCacheForTests } from "../src/services/public-read-cache";
import {
  BIDS_INDEX_FIXTURES,
  BIDS_INDEX_PROVENANCE_FILE,
  type MetadataJsonHarness,
  fixtureById,
  fixtureFilePath,
  fixtureManifest,
  fixtureText,
  startMetadataJsonHarness,
} from "./helpers/bids-index-fixtures";

type Subjects = Record<string, BidsIndexSubjectNode>;
type SessionMap = Record<string, string[]>;

const NS = NO_SESSION_KEY;

/**
 * What each real manifest holds, per subject: session label (or the no-session
 * key) -> datatype directories. Read off the manifest paths by hand, with a
 * throwaway script that does not share a line with the builder, and written
 * here as literals so the assertion never restates the code it checks.
 */
const SESSION_PAIRS: Record<string, Record<string, SessionMap>> = {
  nm000132: Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [
      `sub-${String(i + 1).padStart(3, "0")}`,
      { [NS]: ["eeg"] },
    ]),
  ),
  on004196: Object.fromEntries(
    ["sub-01", "sub-02", "sub-03", "sub-05"].map((s) => [
      s,
      { "01": ["anat", "fmap", "func"], "02": ["fmap", "func"], EEG: ["eeg"] },
    ]),
  ),
  on006033: {
    "sub-01": { "01": ["anat", "func"], "02": ["anat", "eeg", "func"] },
    "sub-02": { "01": ["anat", "eeg", "func"], "02": ["anat", "eeg", "func"] },
    "sub-03": { "01": ["anat", "eeg", "func"], "02": ["anat", "eeg", "func"] },
  },
  on007347: {
    "sub-001": { "1": ["eeg"], "2": ["eeg"], [NS]: ["anat"] },
    "sub-002": { "1": ["eeg"], "2": ["eeg"], [NS]: ["anat"] },
    "sub-003": { "1": ["eeg"], "2": ["eeg"], [NS]: ["anat"] },
    "sub-004": { "1": ["eeg"], "2": ["eeg"], "3": ["eeg"], [NS]: ["anat"] },
    "sub-005": { "1": ["eeg"], [NS]: ["anat"] },
  },
};

const PRE_CHANGE = JSON.parse(
  readFileSync(
    new URL("./fixtures/bids-index-sessions/pre-change-bids-index.json", import.meta.url),
    "utf8",
  ),
) as {
  digest: Record<string, { sessions: string[]; subjects: unknown }>;
  metadata_json: Record<string, string>;
};

const sorted = (xs: string[]) => [...xs].sort();

/** The rules every index must satisfy whatever manifest it came from. */
function expectConsistent(subjects: Subjects): void {
  for (const [subject, node] of Object.entries(subjects)) {
    const map = node.session_modalities;
    const keys = Object.keys(map);
    // The keys are the session labels, plus the no-session bucket when there is one.
    expect(sorted(keys.filter((k) => k !== NS)), `${subject} keys vs sessions`).toEqual(
      sorted(node.sessions),
    );
    // Each list is sorted and has no repeats.
    for (const [key, list] of Object.entries(map)) {
      expect(list, `${subject}/${key} sorted`).toEqual(sorted(list));
      expect(new Set(list).size, `${subject}/${key} unique`).toBe(list.length);
    }
    // The datatypes across all sessions are exactly the subject's `modalities`.
    const union = new Set(Object.values(map).flat());
    expect(sorted([...union]), `${subject} datatype union`).toEqual(
      sorted(Object.keys(node.modalities)),
    );
    // The no-session bucket exists only when a datatype sits outside every session.
    if (NS in map) expect(map[NS].length, `${subject} no-session non-empty`).toBeGreaterThan(0);
    // A new key goes LAST, so a reader that ignores it sees the node it always did.
    expect(Object.keys(node)).toEqual(["sessions", "modalities", "session_modalities"]);
  }
}

/** Today's subjects with the new key deleted, ready to compare with the pre-change golden. */
function withoutSessionModalities(subjects: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(subjects).map(([subject, node]) => {
      const { session_modalities, ...rest } = node as Record<string, unknown>;
      void session_modalities;
      return [subject, rest];
    }),
  );
}

function files(...paths: string[]): Record<string, ManifestFile> {
  return Object.fromEntries(paths.map((p) => [p, { key: `git:${p}`, size: 1, checksum: p }]));
}

describe("the fixtures are the real manifests their provenance says", () => {
  const provenance = JSON.parse(readFileSync(BIDS_INDEX_PROVENANCE_FILE, "utf8")) as {
    fixtures: Record<string, { fixture_sha256: string; entries?: number }>;
  };

  for (const fixture of BIDS_INDEX_FIXTURES) {
    test(`${fixture.id}: sha256 and ascending paths`, () => {
      const recorded = provenance.fixtures[fixture.file];
      expect(recorded, `no provenance entry for ${fixture.file}`).toBeDefined();
      const sha = createHash("sha256")
        .update(readFileSync(fixtureFilePath(fixture)))
        .digest("hex");
      expect(sha).toBe(recorded.fixture_sha256);
      const paths = Object.keys(fixtureManifest(fixture).files);
      if (recorded.entries !== undefined) expect(paths).toHaveLength(recorded.entries);
      // Ascending keys are what let a streamed digest PROVE its totals; a fixture
      // that broke the order would quietly test the unproven path instead.
      expect(paths).toEqual([...paths].sort());
    });
  }
});

describe("session_modalities over the real manifests", () => {
  for (const fixture of BIDS_INDEX_FIXTURES) {
    test(`${fixture.id}: every subject pairs its sessions with the datatypes they hold`, () => {
      const subjects = digestManifest(fixtureManifest(fixture)).subjects;
      const expected = SESSION_PAIRS[fixture.id];
      expect(Object.keys(subjects)).toEqual(Object.keys(expected));
      for (const [subject, pairs] of Object.entries(expected)) {
        expect(subjects[subject].session_modalities, subject).toEqual(pairs);
      }
      expectConsistent(subjects);
    });
  }

  test("nm000132 has no session directories, so every datatype is in the no-session bucket", () => {
    const subjects = digestManifest(fixtureManifest(fixtureById("nm000132"))).subjects;
    for (const node of Object.values(subjects)) {
      expect(node.sessions).toEqual([]);
      expect(Object.keys(node.session_modalities)).toEqual([NS]);
    }
  });

  test("on004196: one session has no eeg and another has nothing but", () => {
    const sub = digestManifest(fixtureManifest(fixtureById("on004196"))).subjects["sub-01"];
    expect(sub.session_modalities["02"]).not.toContain("eeg");
    expect(sub.session_modalities.EEG).toEqual(["eeg"]);
    // The subject-level set still says the subject has eeg and anat, which is
    // all it ever said; the pairing is what the new key adds.
    expect(Object.keys(sub.modalities)).toEqual(["anat", "eeg", "fmap", "func"]);
    expect(sub.session_modalities["02"]).not.toContain("anat");
  });

  test("on006033: the same subject has eeg in one session and none in the other", () => {
    const sub = digestManifest(fixtureManifest(fixtureById("on006033"))).subjects["sub-01"];
    expect(sub.sessions).toEqual(["01", "02"]);
    expect(sub.session_modalities["01"]).not.toContain("eeg");
    expect(sub.session_modalities["02"]).toContain("eeg");
  });

  test("on007347: anat outside every session sits in the no-session bucket beside real sessions", () => {
    const sub = digestManifest(fixtureManifest(fixtureById("on007347"))).subjects["sub-004"];
    expect(sub.sessions).toEqual(["1", "2", "3"]);
    expect(sub.session_modalities).toEqual({
      "1": ["eeg"],
      "2": ["eeg"],
      "3": ["eeg"],
      [NS]: ["anat"],
    });
  });
});

describe("a streamed digest equals the whole-parse reference (ADR 0072: one pass, no second read)", () => {
  for (const fixture of BIDS_INDEX_FIXTURES) {
    for (const chunk of [7, 4096]) {
      test(`${fixture.id}, ${chunk}-byte chunks`, async () => {
        const bytes = new TextEncoder().encode(fixtureText(fixture));
        let at = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (at >= bytes.length) return controller.close();
            controller.enqueue(bytes.slice(at, at + chunk));
            at += chunk;
          },
        });
        const query = new DigestQuery();
        const result = await scanManifestStream(body, query);
        if (result.kind !== "ok") throw new Error(`scan verdict ${result.kind}`);
        const streamed = query.finish(result.header);
        const reference = digestManifest(fixtureManifest(fixture));
        expect(streamed.digest.subjects).toEqual(reference.subjects);
        expect(JSON.stringify(streamed.digest.subjects)).toBe(JSON.stringify(reference.subjects));
        expect(streamed.unproven).toBeNull();
      });
    }
  }
});

describe("rules the real manifests cannot reach, on synthetic manifests", () => {
  // The real manifests never have a session that holds only session-level
  // files, so the "present with []" rule is pinned here.
  test("a session with only session-level files is present with an empty list", () => {
    const subjects = buildBidsIndex(
      files(
        "sub-01/ses-01/sub-01_ses-01_scans.tsv",
        "sub-01/ses-02/eeg/sub-01_ses-02_task-a_eeg.edf",
      ),
    );
    expect(subjects["sub-01"].sessions).toEqual(["01", "02"]);
    expect(subjects["sub-01"].session_modalities).toEqual({ "01": [], "02": ["eeg"] });
  });

  // Pins that the bucket does not exist merely because a subject has no
  // sessions: it exists once a datatype is seen outside every session.
  test("a subject with no session and no datatype directory has an empty map", () => {
    const subjects = buildBidsIndex(files("sub-01/sub-01_scans.tsv"));
    expect(subjects["sub-01"]).toEqual({ sessions: [], modalities: {}, session_modalities: {} });
  });

  // `sub-01/ses-01/` holding nothing but a file is a session; `sub-01/anat/`
  // is not one. The two must not bleed into each other.
  test("a session-level file does not put a datatype in the no-session bucket", () => {
    const subjects = buildBidsIndex(
      files("sub-01/ses-01/sub-01_ses-01_scans.tsv", "sub-01/sub-01_sessions.tsv"),
    );
    expect(subjects["sub-01"].session_modalities).toEqual({ "01": [] });
  });

  test("subjects do not share session lists, even under the same session label", () => {
    const subjects = buildBidsIndex(
      files(
        "sub-01/ses-01/eeg/sub-01_ses-01_task-a_eeg.edf",
        "sub-02/ses-01/anat/sub-02_ses-01_T1w.nii.gz",
      ),
    );
    expect(subjects["sub-01"].session_modalities).toEqual({ "01": ["eeg"] });
    expect(subjects["sub-02"].session_modalities).toEqual({ "01": ["anat"] });
  });

  test("derivatives, sourcedata and code do not contribute", () => {
    const subjects = buildBidsIndex(
      files(
        "derivatives/pipe/sub-01/ses-01/eeg/sub-01_ses-01_task-a_eeg.set",
        "sourcedata/sub-01/ses-09/eeg/raw.bdf",
        "code/ses-01/eeg/run.py",
        "sub-01/ses-01/eeg/sub-01_ses-01_task-a_eeg.edf",
      ),
    );
    expect(Object.keys(subjects)).toEqual(["sub-01"]);
    expect(subjects["sub-01"].session_modalities).toEqual({ "01": ["eeg"] });
  });

  // The sentinel works because a session label is alphanumeric. If that ever
  // changed, a session called "no-session" would silently merge with the
  // bucket, so the property is pinned from both ends.
  test("the no-session key cannot be a session label", () => {
    expect(NS).not.toMatch(/^[A-Za-z0-9]+$/);
    const subjects = buildBidsIndex(
      files(
        "sub-01/ses-no-session/eeg/sub-01_ses-no-session_task-a_eeg.edf",
        "sub-01/eeg/sub-01_task-a_eeg.edf",
      ),
    );
    // `ses-no-session` is not a session directory, so it registers no session.
    expect(subjects["sub-01"].sessions).toEqual([]);
  });

  test("integer-like labels are looked up by name, not by position", () => {
    // JavaScript serializes "1", "2", "10" first and numerically, whatever
    // order they were added in, so the contract says key order is not meaning.
    const subjects = buildBidsIndex(
      files(
        "sub-01/ses-10/eeg/sub-01_ses-10_task-a_eeg.edf",
        "sub-01/ses-2/anat/sub-01_ses-2_T1w.nii.gz",
        "sub-01/ses-1/eeg/sub-01_ses-1_task-a_eeg.edf",
        "sub-01/ses-baseline/eeg/sub-01_ses-baseline_task-a_eeg.edf",
      ),
    );
    const map = subjects["sub-01"].session_modalities;
    expect(sorted(Object.keys(map))).toEqual(sorted(subjects["sub-01"].sessions));
    expect(map["10"]).toEqual(["eeg"]);
    expect(map["2"]).toEqual(["anat"]);
    expect(map.baseline).toEqual(["eeg"]);
  });

  // `add` is a set insertion, so neither order nor a repeated path may change
  // the bytes. A streamed manifest can present paths in any order (an unsorted
  // one is the case ADR 0072 handles), so the bytes must not depend on it.
  test("order and repetition of paths do not change a byte", () => {
    const paths = [
      "sub-01/anat/sub-01_T1w.nii.gz",
      "sub-01/ses-1/eeg/sub-01_ses-1_task-a_eeg.edf",
      "sub-01/ses-1/anat/sub-01_ses-1_T1w.nii.gz",
      "sub-01/ses-2/sub-01_ses-2_scans.tsv",
      "sub-02/ses-1/eeg/sub-02_ses-1_task-a_run-01_eeg.edf",
      "sub-02/ses-1/eeg/sub-02_ses-1_task-a_run-02_eeg.edf",
    ];
    const build = (order: string[]) => {
      const builder = new BidsIndexBuilder();
      for (const p of order) builder.add(p);
      return JSON.stringify(builder.build());
    };
    const reference = build(paths);
    expect(build([...paths].reverse())).toBe(reference);
    expect(build([paths[3], paths[0], paths[5], paths[1], paths[4], paths[2]])).toBe(reference);
    expect(build([...paths, ...paths])).toBe(reference);
  });
});

describe("the existing keys are byte-identical to before the field existed", () => {
  for (const fixture of BIDS_INDEX_FIXTURES) {
    test(`${fixture.id}: digestManifest, minus session_modalities, equals the base-commit capture`, () => {
      const digest = digestManifest(fixtureManifest(fixture));
      const golden = PRE_CHANGE.digest[fixture.id];
      expect(digest.sessions).toEqual(golden.sessions);
      expect(JSON.stringify(withoutSessionModalities(digest.subjects))).toBe(
        JSON.stringify(golden.subjects),
      );
    });
  }
});

describe("GET /<id>/metadata.json, through the real route", () => {
  let harness: MetadataJsonHarness;
  const bodies = new Map<string, string>();
  const reads = new Map<string, string[]>();

  beforeAll(async () => {
    harness = startMetadataJsonHarness();
    for (const fixture of BIDS_INDEX_FIXTURES) {
      // Per-isolate caches outlive a test file under one `bun test` process.
      resetManifestAnswerMemo();
      __resetPublicReadCacheForTests();
      harness.s3.log.length = 0;
      bodies.set(fixture.id, await harness.metadataText(fixture.id));
      reads.set(
        fixture.id,
        harness.s3.log
          .filter((r) => r.path.startsWith(`/${fixture.id}/`))
          .map((r) => `${r.method} ${r.status} ${r.path}`),
      );
    }
  });
  afterAll(() => harness.stop());
  beforeEach(() => {
    resetManifestAnswerMemo();
    __resetPublicReadCacheForTests();
  });

  const bodyOf = (id: string) => bodies.get(id) as string;

  for (const fixture of BIDS_INDEX_FIXTURES) {
    test(`${fixture.id}: the served body minus session_modalities is the pre-change body, byte for byte`, () => {
      const parsed = JSON.parse(bodyOf(fixture.id)) as {
        extensions: { nemar: { bids_index: { subjects: Record<string, unknown> } } };
      };
      const index = parsed.extensions.nemar.bids_index;
      index.subjects = withoutSessionModalities(index.subjects);
      expect(JSON.stringify(parsed)).toBe(PRE_CHANGE.metadata_json[fixture.id]);
    });

    test(`${fixture.id}: serves the pairing, parses against the contract, and round-trips`, () => {
      const body = bodyOf(fixture.id);
      const doc = JSON.parse(body) as {
        extensions: { nemar: { bids_index: unknown } };
      };
      const index = bidsIndexSchema.parse(doc.extensions.nemar.bids_index);
      for (const [subject, pairs] of Object.entries(SESSION_PAIRS[fixture.id])) {
        expect(index.subjects[subject].session_modalities, subject).toEqual(pairs);
      }
      expectConsistent(index.subjects as Subjects);
      // The route's bids_index is the builder's, so a consumer and a test
      // reading the same manifest cannot disagree.
      const digest = digestManifest(fixtureManifest(fixture));
      expect(index.subjects).toEqual(digest.subjects);
      // Parse and serialize again: same bytes.
      expect(JSON.stringify(JSON.parse(body))).toBe(body);
    });

    test(`${fixture.id}: one request reads the manifest once`, () => {
      expect(reads.get(fixture.id)).toEqual([
        `GET 200 /${fixture.id}/version/${fixture.version}.json`,
      ]);
    });
  }

  test("the same request twice serves the same bytes", async () => {
    const id = "on007347";
    expect(await harness.metadataText(id)).toBe(bodyOf(id));
  });
});
