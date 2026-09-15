/**
 * Every path to public stamps the publication (#1407, epic #1406).
 *
 * The triggers in migration 0085 refuse to make a PUBLISHED dataset
 * anonymous, and they decide that by reading `first_published_at`. So the
 * invariant is exactly as strong as the set of code paths that write that
 * column, and the first version of this phase had one writer against three
 * paths that make a dataset public. A dataset published with `nemar admin
 * make-public` kept the column NULL, and could then be made anonymous
 * afterwards -- DOI minted, landing page indexed, git history cloned, and D1
 * reporting a never-published anonymous deposit. That is the state ADR 0063
 * calls theater, reached through the door the ADR was written to close.
 *
 * Two kinds of test here, because neither is sufficient alone. The
 * source-level scan catches a FOURTH path added later, which no runtime test
 * over today's routes could ever reach. The real-database tests prove the SQL
 * those paths interpolate actually does what its name says, including the
 * case the whole design turns on: an anonymous deposit going public without
 * being stamped.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import {
  ANONYMOUS_RELEASE_SKIPPED_STEPS,
  ANONYMOUS_RELEASE_STEPS,
} from "../../shared/publication-steps";
import {
  END_ANONYMITY_AT_PUBLICATION_SQL,
  FIRST_PUBLICATION_STAMP_SQL,
  expectedRepoVisibility,
} from "../src/services/anonymity";
import { freshDb } from "./helpers/d1";

const SRC = join(import.meta.dir, "..", "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** `UPDATE datasets SET ... WHERE`, however it is wrapped across lines. */
const DATASET_UPDATE = /UPDATE\s+datasets\s+SET[\s\S]{0,500}?WHERE/gi;
const SETS_VISIBILITY = /\bvisibility\s*=/i;
const CARRIES_STAMP =
  /first_published_at|FIRST_PUBLICATION_STAMP_SQL|END_ANONYMITY_AT_PUBLICATION_SQL/;

/**
 * Statements that set visibility and deliberately do NOT stamp, with the
 * reason. Only one shape qualifies: a transition to PRIVATE, which is not a
 * publication and must not record one.
 */
const DELIBERATE_UNSTAMPED: Readonly<Record<string, string>> = {
  "routes/admin/datasets-lifecycle.ts":
    "the reset path sets visibility='private'; going private is not a publication",
};

describe("no path makes a dataset public without recording it", () => {
  test("every UPDATE that sets visibility carries the stamp", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = file
        .slice(SRC.length + 1)
        .split(sep)
        .join("/");
      if (DELIBERATE_UNSTAMPED[rel]) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(DATASET_UPDATE)) {
        const statement = match[0];
        if (!SETS_VISIBILITY.test(statement)) continue;
        if (CARRIES_STAMP.test(statement)) continue;
        offenders.push(`${rel}:${text.slice(0, match.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the scan would notice: it finds the statements it is scanning for", () => {
    // Without this, a regex that matched nothing would pass the test above
    // forever. Four sites today -- the publication orchestrator's repo_public
    // step, its end-of-run consistency fix, its operator recovery string, and
    // the direct make-public route -- plus the visibility service.
    let stamped = 0;
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(DATASET_UPDATE)) {
        if (SETS_VISIBILITY.test(match[0]) && CARRIES_STAMP.test(match[0])) stamped++;
      }
    }
    expect(stamped).toBeGreaterThanOrEqual(5);
  });
});

/** Apply a SET fragment the way the production statements interpolate it. */
function setVisibilityPublic(db: Database, id: string, fragment: string): void {
  db.prepare(`UPDATE datasets SET visibility = 'public', ${fragment} WHERE dataset_id = ?`).run(id);
}

function seed(db: Database, id: string, anonymous = 0, visibility = "private"): void {
  db.prepare(
    `INSERT INTO users (id, username, email, github_username, status, role)
     VALUES (7, 'realname', 'real@example.org', 'real-gh', 'approved', 'user')
     ON CONFLICT(id) DO NOTHING`,
  ).run();
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, description, authors, owner_user_id,
                           status, visibility, is_sandbox, anonymous)
     VALUES (?, 'A study of something', 'd', 'Ada Lovelace', 7, 'active', ?, 0, ?)`,
  ).run(id, visibility, anonymous);
}

function row(db: Database, id: string): { anonymous: number; first_published_at: string | null } {
  return db
    .query("SELECT anonymous, first_published_at FROM datasets WHERE dataset_id = ?")
    .get(id) as { anonymous: number; first_published_at: string | null };
}

describe("FIRST_PUBLICATION_STAMP_SQL records a publication of the IDENTITY", () => {
  test("a normal dataset going public is stamped", () => {
    const db = freshDb();
    seed(db, "nm000930");
    setVisibilityPublic(db, "nm000930", FIRST_PUBLICATION_STAMP_SQL);
    expect(row(db, "nm000930").first_published_at).toBeTruthy();
  });

  test("an anonymous deposit going public is NOT stamped, and stays anonymous", () => {
    // The case the whole design turns on. An anonymous deposit is
    // deliberately listed, browsable and downloadable while its depositor is
    // concealed, so stamping here would both trip the triggers and record a
    // publication of an identity that has not been published.
    const db = freshDb();
    seed(db, "nm000931", 1);
    setVisibilityPublic(db, "nm000931", FIRST_PUBLICATION_STAMP_SQL);
    expect(row(db, "nm000931")).toEqual({ anonymous: 1, first_published_at: null });
  });

  test("a republished dataset keeps the FIRST date", () => {
    const db = freshDb();
    seed(db, "nm000932");
    db.prepare(
      "UPDATE datasets SET first_published_at = '2020-01-01 00:00:00' WHERE dataset_id = 'nm000932'",
    ).run();
    setVisibilityPublic(db, "nm000932", FIRST_PUBLICATION_STAMP_SQL);
    expect(row(db, "nm000932").first_published_at).toBe("2020-01-01 00:00:00");
  });

  test("the stamp closes the retroactive-anonymity hole", () => {
    // The regression this file exists for, end to end: publish through the
    // admin make-public path's exact SET clause, then try to conceal the
    // depositor afterwards. Before the stamp reached this path the UPDATE
    // below succeeded.
    const db = freshDb();
    seed(db, "nm000933");
    setVisibilityPublic(db, "nm000933", FIRST_PUBLICATION_STAMP_SQL);

    expect(() =>
      db.prepare("UPDATE datasets SET anonymous = 1 WHERE dataset_id = 'nm000933'").run(),
    ).toThrow(/anonymous requires first_published_at IS NULL/);
  });
});

describe("END_ANONYMITY_AT_PUBLICATION_SQL ends concealment in one statement", () => {
  test("an anonymous deposit is de-anonymized and stamped together", () => {
    const db = freshDb();
    seed(db, "nm000934", 1, "public");

    // Two statements would abort on whichever ran first: the triggers refuse
    // a row that is simultaneously anonymous and stamped.
    setVisibilityPublic(db, "nm000934", END_ANONYMITY_AT_PUBLICATION_SQL);

    const after = row(db, "nm000934");
    expect(after.anonymous).toBe(0);
    expect(after.first_published_at).toBeTruthy();
  });

  test("stamping the date alone is refused, which is why it is one statement", () => {
    const db = freshDb();
    seed(db, "nm000935", 1, "public");
    expect(() =>
      db
        .prepare(
          "UPDATE datasets SET first_published_at = datetime('now') WHERE dataset_id = 'nm000935'",
        )
        .run(),
    ).toThrow(/anonymous requires first_published_at IS NULL/);
  });

  test("a second run is idempotent and keeps the first date", () => {
    const db = freshDb();
    seed(db, "nm000936", 1, "public");
    setVisibilityPublic(db, "nm000936", END_ANONYMITY_AT_PUBLICATION_SQL);
    const first = row(db, "nm000936").first_published_at;
    setVisibilityPublic(db, "nm000936", END_ANONYMITY_AT_PUBLICATION_SQL);
    expect(row(db, "nm000936").first_published_at).toBe(first);
  });
});

describe("the repository does not follow the catalog row", () => {
  test("an anonymous deposit stays private on GitHub while its row is public", () => {
    expect(expectedRepoVisibility({ visibility: "public", anonymous: 1 })).toBe("private");
    expect(expectedRepoVisibility({ visibility: "public", anonymous: 0 })).toBe("public");
    expect(expectedRepoVisibility({ visibility: "private", anonymous: 0 })).toBe("private");
    expect(expectedRepoVisibility({ visibility: "private", anonymous: 1 })).toBe("private");
    expect(expectedRepoVisibility({ visibility: "public", anonymous: null })).toBe("public");
  });

  test("every mutator of repository visibility goes through the rule", () => {
    // `setRepoVisibility` is what actually publishes a git history. A call
    // site that computes its argument from `visibility` alone would publish
    // an anonymous deposit's repository while the catalog kept reporting the
    // depositor as concealed -- with a 200 and no log line.
    const mutators = [
      join(SRC, "services", "visibility.ts"),
      join(SRC, "routes", "datasets", "publication.ts"),
    ];
    for (const file of mutators) {
      expect(readFileSync(file, "utf8")).toContain("expectedRepoVisibility");
    }
  });
});

describe("anonymity is requested at publication, not refused there", () => {
  const PUBLICATION = readFileSync(join(SRC, "routes", "datasets", "publication.ts"), "utf8");
  const MINIMUMS = readFileSync(join(SRC, "services", "submission-minimums.ts"), "utf8");

  test("the request route reads an --anonymous intent off the body", () => {
    // Phase 2 blocked every publication request from an anonymous dataset.
    // That was too blunt in BOTH directions: a depositor could never reach the
    // anonymous state, and a blinded deposit could never be published for real,
    // because the normal request is exactly how de-anonymization happens.
    expect(PUBLICATION).toContain("let anonymousRequested = false;");
    expect(PUBLICATION).not.toContain("blockReason = ANONYMOUS_DEPOSIT_REASON;");
  });

  test("the intent is persisted, because approval runs a different publication", () => {
    // At request time the dataset is not anonymous yet -- asking is what makes
    // it so, later. So the approval step cannot re-derive this from the row.
    expect(PUBLICATION).toMatch(/INSERT INTO publication_requests[^`"]*anonymous\)/);
    expect(PUBLICATION).toContain("anonymousRequested ? 1 : 0");
  });

  test("a re-request without the flag cannot inherit a stale anonymous intent", () => {
    // The unblock path rewrites the row. If it left `anonymous` alone, a
    // depositor re-requesting a NORMAL publication would silently get an
    // anonymous release instead -- the one mistake this flow must not make
    // quietly.
    const unblock = PUBLICATION.indexOf("SET status = 'requested', block_reason = NULL");
    expect(unblock).toBeGreaterThan(-1);
    expect(PUBLICATION.slice(unblock, unblock + 400)).toContain("anonymous = ?");
  });

  test("the placeholder-author gate is exempted for a release and enforced for a publication", () => {
    // This is the interlock, and it is one gate doing two jobs. A blinded
    // deposit legitimately has placeholder Authors; a real publication must
    // not. ADR 0063's first draft claimed this came for free from ADR 0026,
    // which was false twice over -- the regex is anchored and the gate reads
    // the repository file, never `datasets.authors`.
    expect(PUBLICATION).toContain("anonymousRelease: anonymousRequested,");
    expect(MINIMUMS).toContain("anonymousRelease?: boolean;");
    // The rule INVERTS, it does not relax: a release refuses real names and a
    // publication requires them. Permitting was the first draft and it let a
    // depositor be named by their own file on a public dataset page.
    expect(MINIMUMS).toContain("} else if (realAuthors.length > 0) {");
    expect(MINIMUMS).toContain("} else if (realAuthors.length === 0) {");
  });

  test("asking for anonymity on a published dataset is refused, not blocked", () => {
    // A block invites a re-request; this can never succeed, because the
    // triggers refuse it and no amount of retrying changes that.
    expect(PUBLICATION).toContain("if (anonymousRequested && hasEverBeenPublished(dataset)) {");
    expect(PUBLICATION).toContain('error: "already_published",');
  });
});

describe("an anonymous release is a publication minus the steps that expose identity", () => {
  const ORCHESTRATOR = readFileSync(join(SRC, "services", "publication-orchestrator.ts"), "utf8");

  test("the skipped set is exactly the identity-exposing steps", () => {
    // Driven through the real exported constant rather than a copy: a step
    // added to the skip list without a reason, or removed from it, changes
    // what an anonymous release does in the world.
    expect([...ANONYMOUS_RELEASE_SKIPPED_STEPS].sort()).toEqual([
      "publish_doi",
      "upload_to_zenodo",
      "version_doi",
    ]);
  });

  test("repo_public still runs, because it is what releases the data", () => {
    // The step's name is now narrower than what it does: it flips the catalog
    // row public while `expectedRepoVisibility` keeps the repository private.
    expect(ANONYMOUS_RELEASE_STEPS).toContain("repo_public");
    expect(ANONYMOUS_RELEASE_STEPS).toContain("s3_public_read");
    // The gates are not skipped either: an anonymous release is validated and
    // reviewed exactly like a publication.
    expect(ANONYMOUS_RELEASE_STEPS).toContain("ci_check");
  });

  test("the run picks its step set from the request, not from the dataset row", () => {
    expect(ORCHESTRATOR).toContain("const anonymousRelease = request.anonymous === 1;");
    expect(ORCHESTRATOR).toContain("? ANONYMOUS_RELEASE_STEPS");
  });

  test("the release blinds before the data plane can serve the repository's file", () => {
    // `.nemar/metadata.json` is backend-written and publicly served from the
    // manifest, and enrichment has already run by this point, so the committed
    // copy still names the depositor until a fresh pass rewrites it.
    const markAt = ORCHESTRATOR.indexOf("const marked = await markAnonymous(c.env, datasetId);");
    const reenrichAt = ORCHESTRATOR.indexOf("if (marked.repoMetadataStale) {");
    expect(markAt).toBeGreaterThan(-1);
    expect(reenrichAt).toBeGreaterThan(markAt);
    // A failure to blind stops the release rather than publishing under the
    // depositor's name.
    expect(ORCHESTRATOR).toContain("the release was stopped rather than published under");
  });

  test("publishing a formerly blinded deposit restores attribution before the mint", () => {
    // doi_create prefers `.nemar/metadata.json` over the BIDS description, so
    // minting before the restoring pass would cite an enrichment with no
    // authors on a permanent, harvested identifier.
    const restoreAt = ORCHESTRATOR.indexOf("if (!c.anonymousRelease && isAnonymous(c.dataset)) {");
    const mintAt = ORCHESTRATOR.indexOf("anonymousDeposit: c.anonymousRelease,");
    expect(restoreAt).toBeGreaterThan(-1);
    expect(mintAt).toBeGreaterThan(restoreAt);
  });

  test("the mint reads THIS RUN's intent, never the dataset row", () => {
    // On a normal publication of a formerly blinded deposit the row was
    // anonymous moments earlier. Reading it would mint the real, permanent DOI
    // with no curator -- inverting ADR 0041 on the one identifier that is
    // actually harvested.
    expect(ORCHESTRATOR).toContain("anonymousDeposit: c.anonymousRelease,");
    expect(ORCHESTRATOR).not.toContain("anonymousDeposit: isAnonymous(dataset)");
  });
});

describe("the DOI routes refuse to name a concealed depositor", () => {
  const ADMIN_DOI = readFileSync(join(SRC, "routes", "admin", "doi.ts"), "utf8");

  test("the concept mint passes the flag rather than leaving it defaulted", () => {
    // The option existed for a whole review cycle with no caller, so the ADR
    // described a branch nothing reached.
    expect(ADMIN_DOI).toContain("anonymousDeposit: isAnonymous(dataset),");
  });

  test("making a record public or rebuilding it is refused while anonymous", () => {
    expect(ADMIN_DOI).toContain(
      'if (isAnonymous(dataset) && (body.status === "public" || body.refresh_metadata)) {',
    );
  });

  test("the second writer of .nemar/metadata.json blinds what it commits", () => {
    expect(ADMIN_DOI).toContain(
      "const enrichmentToWrite = isAnonymous(dataset) ? blindEnrichmentMetadata(body) : body;",
    );
    // The commit and the D1 cache must use the SAME blinded value, or the
    // publicly-served file and the API would disagree about who deposited it.
    expect(ADMIN_DOI).toContain("JSON.stringify(enrichmentToWrite, null, 2)");
  });
});

describe("enrichment does not un-blind what it just blinded", () => {
  const ENRICH = readFileSync(join(SRC, "services", "enrich-dataset.ts"), "utf8");

  test("the DOI sync is skipped before the EZID write, not after", () => {
    // This block rebuilds the DataCite document from `finalMetadata` (the
    // UNBLINDED object) and `resolveOwnerIdentity` (the real depositor), a
    // hundred lines after the commit document is blinded. Running it would
    // undo the blind inside the same function call.
    const skipAt = ENRICH.indexOf("if (dataset.concept_doi && isAnonymous(dataset)) {");
    const ezidWriteAt = ENRICH.indexOf("await updateIdentifier(ezidAuth");
    expect(skipAt).toBeGreaterThan(-1);
    expect(ezidWriteAt).toBeGreaterThan(skipAt);
  });

  test("the sync branches are mutually exclusive", () => {
    // `if (anonymous) {...} else if (wouldStrip) {...} else if (concept_doi) {...sync...}`.
    // A refactor into independent `if`s would skip AND push.
    const anonymityBranch = ENRICH.indexOf("if (dataset.concept_doi && isAnonymous(dataset)) {");
    const attributionBranch = ENRICH.indexOf(
      "} else if (dataset.concept_doi && refreshWouldStripAttribution(dataset, doiUploader)) {",
    );
    const syncBranch = ENRICH.indexOf("} else if (dataset.concept_doi) {");
    expect(attributionBranch).toBeGreaterThan(anonymityBranch);
    expect(syncBranch).toBeGreaterThan(attributionBranch);
  });

  test("the committed document is blinded before it is both committed and cached", () => {
    const blindAt = ENRICH.indexOf("const documentToCommit = isAnonymous(dataset)");
    const serializeAt = ENRICH.indexOf("const metadataContent = JSON.stringify(documentToCommit");
    const cacheAt = ENRICH.indexOf("UPDATE datasets SET enrichment_json = ?");
    expect(blindAt).toBeGreaterThan(-1);
    expect(serializeAt).toBeGreaterThan(blindAt);
    expect(cacheAt).toBeGreaterThan(serializeAt);
  });
});
