/**
 * shared/upstream-staleness.ts: the pure classifier behind `GET /admin/upstream-status` (epic
 * #1046 phase 4a, #1910; ADR 0111).
 *
 * This is a SUPPLEMENT to `backend/test/upstream-status-route.test.ts`, which drives the route
 * on real SQLite. It exists to pin the rules that are cheap to state as a table: every state and
 * every anomaly kind is reachable, the precedence order holds, and the verdict uses upstream's
 * creation order.
 *
 * The snapshot lists are the REAL recorded OpenNeuro response in
 * `backend/test/fixtures/openneuro-graphql/` (2026-10-24). Four anomaly kinds cannot be produced
 * from a real response (`upstream_older`, `upstream_no_snapshot`, `upstream_tag_unparsable`,
 * `upstream_dates_unreadable`): OpenNeuro does not send them today. They are built here from the
 * recorded shape, because a synthetic value is the only thing that stands between a transposed
 * comparison and a silent wrong verdict (testing.md, "when real data cannot falsify the rule").
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareSourceTags, isSourceTag } from "../shared/source-snapshot";
import {
  ANOMALY_KINDS,
  type MirrorFacts,
  type MirrorProbe,
  STALE_STATES,
  UPSTREAM_STATES,
  type UpstreamRead,
  type UpstreamSnapshot,
  classifyMirror,
  countUpstreamStates,
  diffStaleMirrors,
  needsUpstream,
  toWireRow,
} from "../shared/upstream-staleness";

// ----------------------------------------------------------------------------
// The recording
// ----------------------------------------------------------------------------

const FIXTURES = join(import.meta.dir, "../backend/test/fixtures/openneuro-graphql");
const recordedRequest = JSON.parse(
  readFileSync(join(FIXTURES, "graphql-upstream-snapshots.request.json"), "utf-8"),
) as { variables: Record<string, string> };
const recordedResponse = JSON.parse(
  readFileSync(join(FIXTURES, "graphql-upstream-snapshots.response.json"), "utf-8"),
) as {
  data: Record<
    string,
    null | { id: string; latestSnapshot: UpstreamSnapshot | null; snapshots: UpstreamSnapshot[] }
  >;
};

/** The recorded snapshot read of one `ds`. */
function recorded(ds: string): UpstreamRead {
  const alias = Object.keys(recordedRequest.variables).find(
    (a) => recordedRequest.variables[a] === ds,
  );
  const node = alias ? recordedResponse.data[alias] : undefined;
  if (!node) throw new Error(`${ds} is not a snapshot node in the recording`);
  return { kind: "snapshot", latest: node.latestSnapshot, snapshots: node.snapshots };
}

// ----------------------------------------------------------------------------
// Facts
// ----------------------------------------------------------------------------

function facts(over: Partial<MirrorFacts> & { tag?: string | null; basis?: string | null } = {}) {
  const { tag, basis, ...rest } = over;
  const m: MirrorFacts = {
    datasetId: "on003645",
    sourceId: "ds003645",
    visibility: "public",
    importStatus: "complete",
    blocklisted: false,
    blocklistReason: null,
    versions: [
      {
        version: "1.0.0",
        source_version: tag === undefined ? "2.0.2" : tag,
        source_version_basis: basis === undefined ? "doi" : basis,
        created_at: "2025-01-01 00:00:00",
      },
    ],
    ...rest,
  };
  return m;
}

const READY: MirrorProbe = { kind: "ready" };
const LAG: MirrorProbe = { kind: "lag" };

/** A snapshot read built for the cases a real response cannot produce. */
function snapshotRead(tags: Array<[string, string | null]>, latest?: string): UpstreamRead {
  const snapshots = tags.map(([tag, created]) => ({ tag, created }));
  const last =
    latest === undefined
      ? snapshots[snapshots.length - 1]
      : snapshots.find((s) => s.tag === latest);
  return { kind: "snapshot", latest: last ?? null, snapshots };
}

// ----------------------------------------------------------------------------

describe("the verdict uses upstream's creation order, not the number", () => {
  test("ds000001: recorded 00006, latest 1.0.0 is stale", () => {
    // Numerically 1.0.0 < 00006 (1 < 6); comparing numbers would call this an anomaly. This is
    // why the verdict uses creation order and never `compareSourceTags`.
    expect(compareSourceTags("1.0.0", "00006")).toBeLessThan(0);
    const row = classifyMirror(
      facts({ datasetId: "on000001", sourceId: "ds000001", tag: "00006" }),
      recorded("ds000001"),
      READY,
    );
    expect(row.state).toBe("stale_ready");
    expect(row.anomaly).toBeNull();
    expect(row.reason).toContain("1.0.0");
    expect(row.reason).toContain("00006");
  });

  test("ds003645: 2.0.2 is stale, 2.1.0 is current, 1.5.0 is not upstream's", () => {
    const up = recorded("ds003645");
    expect(classifyMirror(facts({ tag: "2.0.2" }), up, READY).state).toBe("stale_ready");
    const current = classifyMirror(facts({ tag: "2.1.0" }), up);
    expect(current.state).toBe("current");
    expect(current.needs_probe).toBe(false);
    const orphan = classifyMirror(facts({ tag: "1.5.0" }), up);
    expect(orphan.state).toBe("anomaly");
    expect(orphan.anomaly).toBe("recorded_tag_not_upstream");
  });

  test("a deleted and an absent upstream are anomalies, not unknown", () => {
    const deleted = classifyMirror(facts(), {
      kind: "deleted",
      reason: "Dataset ds003645 has been deleted. Reason: duplicate dataset.",
    });
    expect([deleted.state, deleted.anomaly]).toEqual(["anomaly", "upstream_deleted"]);
    const absent = classifyMirror(facts(), {
      kind: "absent",
      reason: "Dataset ds003645 does not exist.",
    });
    expect([absent.state, absent.anomaly]).toEqual(["anomaly", "upstream_absent"]);
  });
});

describe("anomalies a real response cannot produce (built from the recorded shape)", () => {
  test("a stated latest created before the recorded tag contradicts the list", () => {
    // The recorded tag is in the list, so a later one than the stated latest is a disagreement
    // within the list before it is a question of order.
    const up = snapshotRead([
      ["2.0.2", "2023-04-14T14:27:58.000Z"],
      ["2.1.0", "2021-01-01T00:00:00.000Z"],
    ]);
    const row = classifyMirror(facts({ tag: "2.0.2" }), up);
    expect([row.state, row.anomaly]).toEqual(["anomaly", "upstream_latest_inconsistent"]);
  });

  test("upstream_older: equal creation times are not newer", () => {
    const up = snapshotRead([
      ["2.0.2", "2023-04-14T14:27:58.000Z"],
      ["2.1.0", "2023-04-14T14:27:58.000Z"],
    ]);
    expect(classifyMirror(facts({ tag: "2.0.2" }), up).anomaly).toBe("upstream_older");
  });

  test("upstream_no_snapshot: the dataset exists and has no snapshot", () => {
    const row = classifyMirror(facts(), { kind: "snapshot", latest: null, snapshots: [] });
    expect([row.state, row.anomaly]).toEqual(["anomaly", "upstream_no_snapshot"]);
  });

  test("upstream_tag_unparsable: a latest tag the parser could never record", () => {
    const up = snapshotRead([
      ["2.0.2", "2023-04-14T14:27:58.000Z"],
      ["57fecb0ccce88d000ac17538", "2026-01-01T00:00:00.000Z"],
    ]);
    const row = classifyMirror(facts({ tag: "2.0.2" }), up);
    expect([row.state, row.anomaly]).toEqual(["anomaly", "upstream_tag_unparsable"]);
  });

  test("upstream_dates_unreadable: either date does not parse", () => {
    const badLatest = snapshotRead([
      ["2.0.2", "2023-04-14T14:27:58.000Z"],
      ["2.1.0", "not a date"],
    ]);
    expect(classifyMirror(facts({ tag: "2.0.2" }), badLatest).anomaly).toBe(
      "upstream_dates_unreadable",
    );
    const nullRecorded = snapshotRead([
      ["2.0.2", null],
      ["2.1.0", "2026-01-01T00:00:00.000Z"],
    ]);
    expect(classifyMirror(facts({ tag: "2.0.2" }), nullRecorded).anomaly).toBe(
      "upstream_dates_unreadable",
    );
  });

  test("upstream_latest_inconsistent: a snapshot in the list was created after the stated latest", () => {
    // A stale-looking or current-looking verdict from `latestSnapshot` alone would be wrong here.
    const up = snapshotRead(
      [
        ["2.0.2", "2023-04-14T14:27:58.000Z"],
        ["2.1.0", "2024-01-01T00:00:00.000Z"],
        ["2.2.0", "2026-01-01T00:00:00.000Z"],
      ],
      "2.1.0",
    );
    const stale = classifyMirror(facts({ tag: "2.0.2" }), up, READY);
    expect([stale.state, stale.anomaly]).toEqual(["anomaly", "upstream_latest_inconsistent"]);
    expect(stale.reason).toContain("2.2.0");
    // Even a mirror recorded at the stated latest is not "current".
    const current = classifyMirror(facts({ tag: "2.1.0" }), up);
    expect([current.state, current.anomaly]).toEqual(["anomaly", "upstream_latest_inconsistent"]);
    // A list entry with an unreadable date cannot show a disagreement.
    const unreadable = snapshotRead(
      [
        ["2.0.2", "2023-04-14T14:27:58.000Z"],
        ["2.1.0", "2024-01-01T00:00:00.000Z"],
        ["2.2.0", "not a date"],
      ],
      "2.1.0",
    );
    expect(classifyMirror(facts({ tag: "2.1.0" }), unreadable).state).toBe("current");
    // The stated latest carries no date: its entry in the list supplies it for the comparison.
    const undated: UpstreamRead = {
      kind: "snapshot",
      latest: { tag: "2.1.0", created: null },
      snapshots: [
        { tag: "2.1.0", created: "2024-01-01T00:00:00.000Z" },
        { tag: "2.2.0", created: "2026-01-01T00:00:00.000Z" },
      ],
    };
    expect(classifyMirror(facts({ tag: "2.1.0" }), undated).anomaly).toBe(
      "upstream_latest_inconsistent",
    );
  });

  test("an unreadable latest date never lets a row read current beside a later snapshot", () => {
    // Reproduced defect: `??` falls back only on null, so a garbage string skipped the check.
    const garbage: UpstreamRead = {
      kind: "snapshot",
      latest: { tag: "2.1.0", created: "garbage" },
      snapshots: [
        { tag: "2.1.0", created: "also garbage" },
        { tag: "2.2.0", created: "2026-01-01T00:00:00.000Z" },
      ],
    };
    const unreadable = classifyMirror(facts({ tag: "2.1.0" }), garbage);
    expect([unreadable.state, unreadable.anomaly]).toEqual([
      "anomaly",
      "upstream_dates_unreadable",
    ]);
    // Neither date present at all is the same anomaly, not a fall-through to current.
    const none: UpstreamRead = {
      kind: "snapshot",
      latest: { tag: "2.1.0", created: null },
      snapshots: [{ tag: "2.1.0", created: null }],
    };
    expect(classifyMirror(facts({ tag: "2.1.0" }), none).anomaly).toBe("upstream_dates_unreadable");
    // The entry's readable date stands in for a garbage one, and then the list is checked.
    const viaEntry: UpstreamRead = {
      kind: "snapshot",
      latest: { tag: "2.1.0", created: "garbage" },
      snapshots: [
        { tag: "2.1.0", created: "2024-01-01T00:00:00.000Z" },
        { tag: "2.2.0", created: "2026-01-01T00:00:00.000Z" },
      ],
    };
    expect(classifyMirror(facts({ tag: "2.1.0" }), viaEntry).anomaly).toBe(
      "upstream_latest_inconsistent",
    );
    const viaEntryClean: UpstreamRead = {
      kind: "snapshot",
      latest: { tag: "2.1.0", created: "garbage" },
      snapshots: [{ tag: "2.1.0", created: "2024-01-01T00:00:00.000Z" }],
    };
    expect(classifyMirror(facts({ tag: "2.1.0" }), viaEntryClean).state).toBe("current");
  });

  test("the latest's date falls back to its entry in the list", () => {
    const up: UpstreamRead = {
      kind: "snapshot",
      latest: { tag: "2.1.0", created: null },
      snapshots: [
        { tag: "2.0.2", created: "2023-04-14T14:27:58.000Z" },
        { tag: "2.1.0", created: "2026-01-01T00:00:00.000Z" },
      ],
    };
    expect(classifyMirror(facts({ tag: "2.0.2" }), up, READY).state).toBe("stale_ready");
  });
});

describe("precedence, first match wins", () => {
  const stale = recorded("ds003645");

  test("an import in progress beats a known stale tag", () => {
    const row = classifyMirror(facts({ importStatus: "copying" }), stale, READY);
    expect(row.state).toBe("in_progress");
    expect(needsUpstream(facts({ importStatus: "copying" }))).toBe(false);
  });

  test("an open re-pull beats a known stale tag and is never sent to OpenNeuro", () => {
    const open = facts({ repullStatus: "pr_open", repullToTag: "2.1.0" });
    const row = classifyMirror(open, stale, READY);
    expect([row.state, row.reason]).toEqual([
      "in_progress",
      "a re-pull to 2.1.0 is pr_open; not compared",
    ]);
    expect(needsUpstream(open)).toBe(false);
    // Without the tag the sentence still names the status.
    expect(classifyMirror(facts({ repullStatus: "copied" }), stale, READY).reason).toBe(
      "a re-pull is copied; not compared",
    );
  });

  test("no open re-pull, in either spelling of absent, leaves the verdict alone", () => {
    for (const over of [{}, { repullStatus: null }, { repullStatus: undefined }]) {
      expect(classifyMirror(facts(over), stale, READY).state).toBe("stale_ready");
      expect(needsUpstream(facts(over))).toBe(true);
    }
  });

  test("a re-pull outranks the parked and the anomaly verdicts, which describe the import", () => {
    for (const over of [
      { blocklisted: true },
      { importStatus: "quarantined" },
      { sourceId: "ds000007" },
      { versions: [] },
    ]) {
      expect(classifyMirror(facts({ ...over, repullStatus: "planned" }), stale, READY).state).toBe(
        "in_progress",
      );
    }
  });

  test("a blocklisted row is parked even while its status is in progress", () => {
    const row = classifyMirror(
      facts({
        importStatus: "preparing",
        blocklisted: true,
        blocklistReason: "upstream_inaccessible",
      }),
      stale,
      READY,
    );
    expect(row.state).toBe("parked");
    expect(row.reason).toContain("upstream_inaccessible");
  });

  test("parked beats a known stale tag, for the blocklist and for the two terminal statuses", () => {
    for (const over of [
      { blocklisted: true },
      { importStatus: "quarantined" },
      { importStatus: "rolled_back" },
    ]) {
      expect(classifyMirror(facts(over), stale, READY).state).toBe("parked");
    }
  });

  test("a mismatched source_id beats everything after it, even a current tag", () => {
    const row = classifyMirror(facts({ sourceId: "ds000007", tag: "2.1.0" }), stale);
    expect([row.state, row.anomaly]).toEqual(["anomaly", "source_id_mismatch"]);
    expect(needsUpstream(facts({ sourceId: "ds000007" }))).toBe(false);
    // Before step 4: a mismatched row with no version is still a mismatch, not "unpublished".
    const unversioned = classifyMirror(facts({ sourceId: "ds000007", versions: [] }));
    expect(unversioned.anomaly).toBe("source_id_mismatch");
  });

  test("an id that is not on###### names no upstream and is a mismatch", () => {
    const row = classifyMirror(facts({ datasetId: "nm000200", sourceId: null }), stale);
    expect([row.state, row.anomaly]).toEqual(["anomaly", "source_id_mismatch"]);
  });

  test("no version is unpublished; a version with no basis is not_examined", () => {
    expect(classifyMirror(facts({ versions: [] }), stale).state).toBe("unpublished");
    const unexamined = classifyMirror(facts({ tag: null, basis: null }), stale);
    expect(unexamined.state).toBe("not_examined");
    expect(unexamined.reason).toContain("nemar admin upstream-backfill");
    expect(needsUpstream(facts({ versions: [] }))).toBe(false);
    expect(needsUpstream(facts({ tag: null, basis: null }))).toBe(false);
  });

  test("a row that has a tag, or an unknown one, needs OpenNeuro", () => {
    expect(needsUpstream(facts())).toBe(true);
    expect(needsUpstream(facts({ tag: null, basis: "unknown" }))).toBe(true);
  });

  test("a known tag with no OpenNeuro answer is unchecked, never current", () => {
    const missing = classifyMirror(facts(), undefined);
    expect(missing.state).toBe("unchecked");
    const failed = classifyMirror(facts(), { kind: "error", reason: "HTTP 503" });
    expect(failed.state).toBe("unchecked");
    expect(failed.reason).toContain("HTTP 503");
  });

  test("only the highest version speaks", () => {
    const row = classifyMirror(
      facts({
        versions: [
          {
            version: "1.0.0",
            source_version: "2.1.0",
            source_version_basis: "doi",
            created_at: null,
          },
          { version: "1.0.1", source_version: null, source_version_basis: null, created_at: null },
        ],
      }),
      recorded("ds003645"),
    );
    expect(row.state).toBe("not_examined");
  });
});

describe("the GitHub mirror probe", () => {
  const up = recorded("ds003645");

  test("no probe yet: stale_unverified and needs_probe", () => {
    const row = classifyMirror(facts(), up);
    expect(row.state).toBe("stale_unverified");
    expect(row.needs_probe).toBe(true);
  });

  test("ready, lag and unverified", () => {
    expect(classifyMirror(facts(), up, READY).state).toBe("stale_ready");
    expect(classifyMirror(facts(), up, LAG).state).toBe("mirror_lag");
    const unverified = classifyMirror(facts(), up, { kind: "unverified", reason: "HTTP 500" });
    expect(unverified.state).toBe("stale_unverified");
    expect(unverified.needs_probe).toBe(false);
    expect(unverified.reason).toContain("HTTP 500");
  });

  test("needs_probe is true only for an upstream-newer row that has not been probed", () => {
    const mirrors = [
      facts({ tag: "2.0.2" }),
      facts({ datasetId: "on004362", sourceId: "ds004362", tag: "1.0.0" }),
      facts({ datasetId: "on002893", sourceId: "ds002893", tag: "2.0.0" }),
      facts({ datasetId: "on000003", sourceId: "ds000003", versions: [] }),
    ];
    const upstream = new Map<string, UpstreamRead>([
      ["ds003645", recorded("ds003645")],
      ["ds004362", recorded("ds004362")],
      ["ds002893", recorded("ds002893")],
    ]);
    const first = diffStaleMirrors(mirrors, upstream);
    expect(first.map((r) => [r.dataset_id, r.state, r.needs_probe])).toEqual([
      ["on003645", "stale_unverified", true],
      ["on004362", "stale_unverified", true],
      ["on002893", "current", false],
      ["on000003", "unpublished", false],
    ]);
    const second = diffStaleMirrors(
      mirrors,
      upstream,
      new Map<string, MirrorProbe>([
        ["ds003645", READY],
        ["ds004362", LAG],
      ]),
    );
    expect(second.map((r) => r.state)).toEqual([
      "stale_ready",
      "mirror_lag",
      "current",
      "unpublished",
    ]);
    expect(second.some((r) => r.needs_probe)).toBe(false);
  });

  test("the wire row has no needs_probe", () => {
    const wire = toWireRow(classifyMirror(facts(), up));
    expect("needs_probe" in wire).toBe(false);
  });
});

describe("probably_stale, for unknown rows only", () => {
  const unknown = (created: string | null) =>
    facts({
      tag: null,
      basis: "unknown",
      versions: [
        {
          version: "1.0.0",
          source_version: null,
          source_version_basis: "unknown",
          created_at: created,
        },
      ],
    });
  const up = recorded("ds003645"); // latest 2.1.0, created 2026-10-24T04:10:36Z

  test("true when upstream's latest is later than the mirror's version row", () => {
    const row = classifyMirror(unknown("2025-01-01 00:00:00"), up);
    expect([row.state, row.probably_stale]).toEqual(["unknown", true]);
  });

  test("false when the mirror's version row is later", () => {
    const row = classifyMirror(unknown("2026-10-25 00:00:00"), up);
    expect([row.state, row.probably_stale]).toEqual(["unknown", false]);
  });

  test("a zone-less D1 timestamp is read as UTC, not local time", () => {
    // 04:10:36Z upstream; the row was created 04:10:35 UTC, one second earlier. Read as local
    // time in any zone but UTC the answer would flip, so the test runs in a zone that is not UTC.
    const zone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(classifyMirror(unknown("2026-10-24 04:10:35"), up).probably_stale).toBe(true);
      expect(classifyMirror(unknown("2026-10-24 04:10:37"), up).probably_stale).toBe(false);
    } finally {
      if (zone === undefined) Reflect.deleteProperty(process.env, "TZ");
      else process.env.TZ = zone;
    }
  });

  test("null when it cannot be compared", () => {
    expect(classifyMirror(unknown(null), up).probably_stale).toBeNull();
    expect(classifyMirror(unknown("2025-01-01 00:00:00"), undefined).probably_stale).toBeNull();
    expect(
      classifyMirror(unknown("2025-01-01 00:00:00"), { kind: "error", reason: "x" }).probably_stale,
    ).toBeNull();
    expect(
      classifyMirror(unknown("2025-01-01 00:00:00"), {
        kind: "snapshot",
        latest: null,
        snapshots: [],
      }).probably_stale,
    ).toBeNull();
  });

  test("an unknown row names why it could not be compared", () => {
    const row = unknown("2025-01-01 00:00:00");
    const failed = classifyMirror(row, { kind: "error", reason: "HTTP 503" });
    expect(failed.state).toBe("unknown");
    expect(failed.reason).toContain("OpenNeuro could not be read");
    expect(failed.reason).toContain("HTTP 503");
    expect(classifyMirror(row, undefined).reason).toContain("OpenNeuro was not asked");
    expect(classifyMirror(row, { kind: "deleted", reason: "x" }).reason).toContain(
      "cannot be compared",
    );
  });

  test("null for every other state", () => {
    const rows = [
      classifyMirror(facts({ tag: "2.1.0" }), up),
      classifyMirror(facts(), up, READY),
      classifyMirror(facts({ versions: [] }), up),
      classifyMirror(facts(), undefined),
    ];
    for (const row of rows) expect(row.probably_stale).toBeNull();
  });
});

describe("every state and anomaly kind is reachable, and counts are zero-filled", () => {
  test("a table of rows reaches every state and every anomaly kind", () => {
    const up = recorded("ds003645");
    const rows = [
      classifyMirror(facts({ tag: "2.1.0" }), up),
      classifyMirror(facts(), up, READY),
      classifyMirror(facts(), up, LAG),
      classifyMirror(facts(), up),
      classifyMirror(facts({ tag: null, basis: "unknown" }), up),
      classifyMirror(facts({ tag: null, basis: null }), up),
      classifyMirror(facts({ versions: [] }), up),
      classifyMirror(facts({ importStatus: "copying" }), up),
      classifyMirror(facts({ blocklisted: true }), up),
      classifyMirror(facts(), undefined),
      // one per anomaly kind
      classifyMirror(facts({ sourceId: "ds000007" }), up),
      classifyMirror(facts(), { kind: "deleted", reason: "x" }),
      classifyMirror(facts(), { kind: "absent", reason: "x" }),
      classifyMirror(facts(), { kind: "snapshot", latest: null, snapshots: [] }),
      classifyMirror(
        facts({ tag: "2.0.2" }),
        snapshotRead([
          ["2.0.2", "2023-01-01T00:00:00Z"],
          ["abc", "2024-01-01T00:00:00Z"],
        ]),
      ),
      classifyMirror(facts({ tag: "9.9.9" }), up),
      classifyMirror(
        facts({ tag: "2.0.2" }),
        snapshotRead([
          ["2.0.2", "2023-01-01T00:00:00Z"],
          ["2.1.0", "2023-01-01T00:00:00Z"],
        ]),
      ),
      classifyMirror(
        facts({ tag: "2.0.2" }),
        snapshotRead([
          ["2.0.2", "nope"],
          ["2.1.0", "2022-01-01T00:00:00Z"],
        ]),
      ),
      classifyMirror(
        facts({ tag: "2.0.2" }),
        snapshotRead(
          [
            ["2.0.2", "2023-01-01T00:00:00Z"],
            ["2.1.0", "2024-01-01T00:00:00Z"],
            ["2.2.0", "2025-01-01T00:00:00Z"],
          ],
          "2.1.0",
        ),
      ),
    ];
    expect(new Set(rows.map((r) => r.state))).toEqual(new Set(UPSTREAM_STATES));
    expect(new Set(rows.map((r) => r.anomaly).filter(Boolean))).toEqual(new Set(ANOMALY_KINDS));
  });

  test("countUpstreamStates has every key, zero-filled, and stale is the sum of three", () => {
    const empty = countUpstreamStates([]);
    expect(Object.keys(empty.states)).toEqual([...UPSTREAM_STATES]);
    expect(Object.keys(empty.anomalies)).toEqual([...ANOMALY_KINDS]);
    expect(Object.values(empty.states).every((n) => n === 0)).toBe(true);
    expect(Object.values(empty.anomalies).every((n) => n === 0)).toBe(true);
    expect([empty.stale, empty.probably_stale]).toEqual([0, 0]);

    const up = recorded("ds003645");
    const counts = countUpstreamStates([
      classifyMirror(facts(), up, READY),
      classifyMirror(facts(), up, READY),
      classifyMirror(facts(), up, LAG),
      classifyMirror(facts(), up),
      classifyMirror(facts({ tag: "2.1.0" }), up),
      classifyMirror(facts({ tag: "9.9.9" }), up),
      classifyMirror(
        facts({
          tag: null,
          basis: "unknown",
          versions: [
            {
              version: "1.0.0",
              source_version: null,
              source_version_basis: "unknown",
              created_at: "2020-01-01 00:00:00",
            },
          ],
        }),
        up,
      ),
    ]);
    expect(counts.states.stale_ready).toBe(2);
    expect(counts.states.mirror_lag).toBe(1);
    expect(counts.states.stale_unverified).toBe(1);
    expect(counts.stale).toBe(STALE_STATES.reduce((sum, s) => sum + counts.states[s], 0));
    expect(counts.stale).toBe(4);
    expect(counts.anomalies.recorded_tag_not_upstream).toBe(1);
    expect(counts.probably_stale).toBe(1);
    // probably stale is never added to stale.
    expect(counts.states.unknown).toBe(1);
  });
});

describe("isSourceTag", () => {
  test("accepts numeric tags and legacy digits, refuses hex ids and malformed ones", () => {
    for (const tag of ["1.0.0", "00006", "2.0.10", "1"]) expect(isSourceTag(tag)).toBe(true);
    for (const tag of ["57fecb0ccce88d000ac17538", "v2.0.2.", "2.0.x", "", "1.2.3.4.5"]) {
      expect(isSourceTag(tag)).toBe(false);
    }
    expect(isSourceTag(undefined)).toBe(false);
    expect(isSourceTag(100)).toBe(false);
  });
});
