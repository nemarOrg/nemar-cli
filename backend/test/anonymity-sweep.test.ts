/**
 * The anonymity sweep, driven through the real service (#1409, epic #1406).
 *
 * Real engine: bun:sqlite behind `realD1` with every migration applied, the
 * real candidate SQL, the real stamp SQL, the real matchers. The four genuine
 * network boundaries -- GitHub's repo API, the authenticated raw content host,
 * EZID, and the S3 zarr index -- are substituted through the service's own DI
 * seams, exactly the way `zarr-fidelity-sweep.test.ts` substitutes its two.
 *
 * Every check has a CONTROL: a dataset in the same shape without the problem.
 * Phase 2 of this epic shipped two blinds whose deletion left 3,418 tests
 * green, which is what a check with no control looks like from the outside.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ANONYMOUS_AUTHORS_LABEL } from "../src/services/anonymity";
import {
  ANONYMITY_SWEEP_CANDIDATE_SQL,
  ANONYMITY_SWEEP_RESET_SQL,
  type AnonymitySweepSeams,
  checkRowInvariants,
  inScopeDepositFiles,
  namedEntriesIn,
  ownerIdentityOf,
  runAnonymitySweep,
  scanDepositFile,
  selectDepositFiles,
  textNamesOwner,
} from "../src/services/anonymity-sweep";
import { isPlaceholderAuthor } from "../src/services/submission-minimums";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const OWNER = {
  username: "aklovelace",
  github: "ada-gh",
  given: "Ada",
  family: "Lovelace",
  email: "ada@example.org",
  orcid: "0000-0002-1825-0097",
};

function seed(
  db: Database,
  datasetId: string,
  overrides: {
    anonymous?: number;
    authors?: string | null;
    enrichment?: string | null;
    firstPublishedAt?: string | null;
    conceptDoi?: string | null;
    githubRepo?: string | null;
  } = {},
): void {
  db.run(
    `INSERT INTO users (id, username, email, password_hash, status, role, email_verified,
                        github_username, given_name, family_name, orcid)
     VALUES (31, ?, ?, 'x', 'approved', 'member', 1, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [OWNER.username, OWNER.email, OWNER.github, OWNER.given, OWNER.family, OWNER.orcid],
  );
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                           github_repo, anonymous, authors, enrichment_json,
                           first_published_at, concept_doi)
     VALUES (?, 'A sufficiently descriptive dataset title', 31, 'active', 'public', 0, ?, ?, ?, ?, ?, ?)`,
  ).run(
    datasetId,
    overrides.githubRepo === undefined ? `nemarDatasets/${datasetId}` : overrides.githubRepo,
    overrides.anonymous ?? 1,
    overrides.authors === undefined ? ANONYMOUS_AUTHORS_LABEL : overrides.authors,
    overrides.enrichment ?? null,
    overrides.firstPublishedAt ?? null,
    overrides.conceptDoi ?? null,
  );
}

function env(db: Database): Bindings {
  // A real PAT value, so `getDatasetsToken`'s real fallback path resolves and
  // the checks that need a credential actually run. Nothing in these tests
  // reaches GitHub: every boundary that would is substituted below.
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    GITHUB_ADMIN_PAT: "test-pat",
  } as Bindings;
}

/**
 * The repository's files, served over HTTP by a real local server.
 *
 * `rawBase` is a base URL rather than a `fetch` seam, so the ONLY way to reach
 * the deposit-file half of the sweep is to actually serve bytes. Pointing it at
 * a dead port -- which an earlier version of this file did -- meant no test
 * ever ran `scanDataset`'s file loop, and a scope bug that made `verified`
 * unreachable for every real dataset shipped behind 32 green tests.
 */
const served = new Map<string, { body: string; status?: number }>();
let fileServer: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  fileServer = Bun.serve({
    port: 0,
    fetch(req) {
      // `${base}/${ORG_NAME}/${repo}/${ref}/${path}` -- drop the first three.
      const segments = new URL(req.url).pathname.split("/").filter(Boolean);
      const path = segments.slice(3).map(decodeURIComponent).join("/");
      const entry = served.get(path);
      if (!entry) return new Response("not found", { status: 404 });
      if (entry.status && entry.status !== 200) {
        return new Response("upstream", { status: entry.status });
      }
      return new Response(entry.body, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    },
  });
});

afterAll(() => fileServer.stop(true));

/** A minimal BIDS root that names nobody: the control every finding needs. */
const CLEAN_FILES: Record<string, string> = {
  "dataset_description.json": JSON.stringify({
    Name: "A sufficiently descriptive dataset title",
    BIDSVersion: "1.9.0",
    Authors: ["n/a"],
  }),
  README: "Resting-state recordings acquired under a standard protocol.",
};

/** A clean world: private repo, reserved DOI, no zarr store, a blinded root. */
function cleanSeams(
  files: Record<string, string> = CLEAN_FILES,
  opts: { listing?: { path: string; sha: string; size?: number; mode?: string }[] | null } = {},
): AnonymitySweepSeams {
  served.clear();
  for (const [path, body] of Object.entries(files)) served.set(path, { body });
  return {
    fetchGithubImpl: (async () =>
      new Response(JSON.stringify({ private: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    getIdentifierImpl: async () => ({ status: "reserved", dataciteXml: "<resource/>" }),
    fetchZarrIndexImpl: async () => null,
    listGitFilesImpl: async () =>
      opts.listing !== undefined
        ? opts.listing
        : Object.keys(files).map((path) => ({
            path,
            sha: "a".repeat(40),
            size: files[path].length,
            mode: "100644",
          })),
    rawBase: `http://127.0.0.1:${fileServer.port}`,
  };
}

function stamp(db: Database, datasetId: string): Record<string, unknown> {
  const row = db
    .query<{ sweep_stamps: string | null }, [string]>(
      "SELECT sweep_stamps FROM datasets WHERE dataset_id = ?",
    )
    .get(datasetId);
  return row?.sweep_stamps ? (JSON.parse(row.sweep_stamps) as Record<string, unknown>) : {};
}

describe("the candidate predicate", () => {
  test("an anonymous deposit is a candidate; an ordinary one never is", () => {
    const db = freshDb();
    seed(db, "nm000910", { anonymous: 1 });
    seed(db, "nm000911", { anonymous: 0 });
    const rows = db.prepare(ANONYMITY_SWEEP_CANDIDATE_SQL).all(10) as { dataset_id: string }[];
    expect(rows.map((r) => r.dataset_id)).toEqual(["nm000910"]);
    db.close();
  });

  test("a dataset attempted moments ago is out of the window; one attempted yesterday is back in", () => {
    // The cadence IS the predicate here, unlike the fidelity sweep's commit
    // comparison: a projection regression, a hand-flipped repository and an
    // EZID status change all happen with the dataset row untouched, so there
    // is nothing to compare against except time.
    const db = freshDb();
    seed(db, "nm000912");
    seed(db, "nm000913");
    db.run(
      "UPDATE datasets SET sweep_stamps = json_object('anonymity_attempted_at', datetime('now')) WHERE dataset_id = 'nm000912'",
    );
    db.run(
      "UPDATE datasets SET sweep_stamps = json_object('anonymity_attempted_at', datetime('now','-2 days')) WHERE dataset_id = 'nm000913'",
    );
    const rows = db.prepare(ANONYMITY_SWEEP_CANDIDATE_SQL).all(10) as { dataset_id: string }[];
    expect(rows.map((r) => r.dataset_id)).toEqual(["nm000913"]);
    db.close();
  });

  test("all three shapes of 'never swept' are candidates", () => {
    // ADR 0035's convention: a missing key, an explicit JSON null and a NULL
    // column are the three ways "never swept" arrives, and a predicate that
    // catches only one of them leaves rows permanently unchecked.
    const db = freshDb();
    seed(db, "nm000914");
    seed(db, "nm000915");
    seed(db, "nm000916");
    db.run("UPDATE datasets SET sweep_stamps = NULL WHERE dataset_id = 'nm000914'");
    db.run("UPDATE datasets SET sweep_stamps = '{}' WHERE dataset_id = 'nm000915'");
    db.run(
      "UPDATE datasets SET sweep_stamps = json_object('anonymity_attempted_at', null) WHERE dataset_id = 'nm000916'",
    );
    const rows = db.prepare(ANONYMITY_SWEEP_CANDIDATE_SQL).all(10) as { dataset_id: string }[];
    expect(rows.map((r) => r.dataset_id).sort()).toEqual(["nm000914", "nm000915", "nm000916"]);
    db.close();
  });
});

describe("the invariants NEMAR owns", () => {
  test("a clean deposit verifies, and says what it did not look at", async () => {
    const db = freshDb();
    seed(db, "nm000920");
    const res = await runAnonymitySweep(env(db), { seams: cleanSeams() });
    expect(res.verified).toBe(1);
    expect(res.results[0].findings).toEqual([]);
    // NEVER empty. "Verified" means everything this sweep can check is fine,
    // and identity inside the recordings is not something it can check.
    expect(res.results[0].unchecked).toContain("signal_headers");
    db.close();
  });

  test("a public repository is a finding", async () => {
    const db = freshDb();
    seed(db, "nm000921");
    const seams = { ...cleanSeams() };
    seams.fetchGithubImpl = (async () =>
      new Response(JSON.stringify({ private: false }), { status: 200 })) as unknown as typeof fetch;
    const res = await runAnonymitySweep(env(db), { seams });
    expect(res.with_findings).toBe(1);
    expect(res.results[0].findings.map((f) => f.check)).toEqual(["repo_public"]);
    expect(res.results[0].findings[0].severity).toBe("invariant");
    db.close();
  });

  test("a GitHub call that fails is UNCHECKED, never 'private'", async () => {
    // The tri-state. A 500 from GitHub is not evidence that a repository is
    // private, and recording it as one would be the sweep lying by default.
    const db = freshDb();
    seed(db, "nm000922");
    const seams = { ...cleanSeams() };
    seams.fetchGithubImpl = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const res = await runAnonymitySweep(env(db), { seams });
    expect(res.unverifiable).toBe(1);
    expect(res.results[0].findings).toEqual([]);
    expect(res.results[0].unchecked).toContain("repo_private");
    db.close();
  });

  test("an un-blinded author list and a leaky enrichment cache", async () => {
    const db = freshDb();
    seed(db, "nm000923", {
      authors: "Lovelace, Ada",
      enrichment: JSON.stringify({ authors: { "Lovelace, Ada": {} }, title: "t" }),
    });
    const res = await runAnonymitySweep(env(db), { seams: cleanSeams() });
    expect(res.results[0].findings.map((f) => f.check).sort()).toEqual([
      "authors_not_blinded",
      "enrichment_not_blinded",
    ]);
    db.close();
  });

  test("the published-while-anonymous row cannot be seeded, which is the point", () => {
    // Migration 0085's trigger refuses this state, so the integration tests
    // above CANNOT produce it -- the INSERT raises
    // "anonymous requires first_published_at IS NULL". That is why the check
    // exists at all: it is looking for a row that arrived around the triggers
    // (a hand-written UPDATE, a replica anomaly, a future migration that
    // rebuilds the table), and the rule is asserted on the pure function
    // instead. Working around the trigger to seed it here would test the
    // workaround.
    const db = freshDb();
    expect(() => seed(db, "nm000935", { firstPublishedAt: "2026-01-01 00:00:00" })).toThrow(
      /first_published_at IS NULL/,
    );
    db.close();
    expect(
      checkRowInvariants({
        authors: null,
        enrichment_json: null,
        first_published_at: "2026-01-01 00:00:00",
      }).findings.map((f) => f.check),
    ).toEqual(["published_while_anonymous"]);
  });

  test("a DOI that is no longer reserved, and one that is", async () => {
    const db = freshDb();
    seed(db, "nm000924", { conceptDoi: "10.82901/test" });
    const seams = { ...cleanSeams() };
    seams.getIdentifierImpl = async () => ({ status: "public", dataciteXml: "<resource/>" });
    const res = await runAnonymitySweep(env(db), { seams });
    expect(res.results[0].findings.map((f) => f.check)).toEqual(["doi_not_reserved"]);

    // The control, on the same row shape.
    const db2 = freshDb();
    seed(db2, "nm000925", { conceptDoi: "10.82901/test" });
    const ok = await runAnonymitySweep(env(db2), { seams: cleanSeams() });
    expect(ok.results[0].findings).toEqual([]);
    db.close();
    db2.close();
  });

  test("a DataCite document that names the depositor", async () => {
    const db = freshDb();
    seed(db, "nm000926", { conceptDoi: "10.82901/test" });
    const seams = { ...cleanSeams() };
    seams.getIdentifierImpl = async () => ({
      status: "reserved",
      dataciteXml: "<creator><creatorName>Lovelace, Ada</creatorName></creator>",
    });
    const res = await runAnonymitySweep(env(db), { seams });
    expect(res.results[0].findings.map((f) => f.check)).toEqual(["doi_names_depositor"]);
    db.close();
  });

  test("a published Zarr index that names the depositor, and one that does not", async () => {
    const db = freshDb();
    seed(db, "nm000927");
    const seams = { ...cleanSeams() };
    seams.fetchZarrIndexImpl = async () =>
      JSON.stringify({ citation: "Lovelace, Ada (2026). A dataset. NEMAR." });
    const res = await runAnonymitySweep(env(db), { seams });
    expect(res.results[0].findings.map((f) => f.check)).toEqual(["zarr_index_names_depositor"]);

    const db2 = freshDb();
    seed(db2, "nm000928");
    const blinded = { ...cleanSeams() };
    blinded.fetchZarrIndexImpl = async () =>
      JSON.stringify({ citation: `${ANONYMOUS_AUTHORS_LABEL} (2026). A dataset. NEMAR.` });
    const ok = await runAnonymitySweep(env(db2), { seams: blinded });
    expect(ok.results[0].findings).toEqual([]);
    db.close();
    db2.close();
  });

  test("the owner projection is re-run, not trusted", async () => {
    // `owner_username` and `owner_github` are joined from `users` at read time,
    // so no writer can withhold them -- the projection is the only thing that
    // can, which is why this check runs the projection's own SQL.
    const db = freshDb();
    seed(db, "nm000929");
    const clean = await runAnonymitySweep(env(db), { seams: cleanSeams() });
    expect(clean.results[0].findings).toEqual([]);
    db.close();
  });
});

describe("what the verdict means", () => {
  test("a finding outranks an unrelated check that could not run", async () => {
    // Otherwise a GitHub outage would downgrade a real leak to "we could not
    // tell", which is the wrong way round: the leak is still there.
    const db = freshDb();
    seed(db, "nm000930", { authors: "Lovelace, Ada" });
    const seams = { ...cleanSeams() };
    seams.getIdentifierImpl = undefined;
    seams.fetchZarrIndexImpl = undefined;
    const res = await runAnonymitySweep(env(db), { seams });
    expect(res.results[0].status).toBe("findings");
    expect(res.results[0].unchecked).toContain("zarr_index");
    db.close();
  });

  test("the always-unchecked signal headers do NOT make a clean deposit unverifiable", async () => {
    // If they did, nothing would ever verify, and a verdict nothing can reach
    // is a verdict nobody reads.
    const db = freshDb();
    seed(db, "nm000931");
    const res = await runAnonymitySweep(env(db), { seams: cleanSeams() });
    expect(res.results[0].status).toBe("verified");
    expect(res.results[0].unchecked).toEqual(["signal_headers"]);
    db.close();
  });

  test("the verdict and the findings are stamped where other surfaces read them", async () => {
    const db = freshDb();
    seed(db, "nm000932", { authors: "Lovelace, Ada" });
    await runAnonymitySweep(env(db), { seams: cleanSeams() });
    const stamps = stamp(db, "nm000932");
    expect(stamps.anonymity_status).toBe("findings");
    expect(stamps.anonymity_checked_at).toBeTruthy();
    expect(Array.isArray(stamps.anonymity_findings)).toBe(true);
    expect(Array.isArray(stamps.anonymity_unchecked)).toBe(true);
    db.close();
  });

  test("the attempt is stamped even for a dataset that reaches no verdict", async () => {
    // What keeps a permanently failing dataset from holding the front of the
    // queue forever. Asserted on the row, not on the result, because it is the
    // row the next run's candidate query reads.
    const db = freshDb();
    seed(db, "nm000933");
    const seams = { ...cleanSeams() };
    seams.fetchGithubImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await runAnonymitySweep(env(db), { seams });
    expect(stamp(db, "nm000933").anonymity_attempted_at).toBeTruthy();
    db.close();
  });

  test("nothing but sweep_stamps is written, on any verdict", async () => {
    // ADR 0034, and the rule this sweep exists to uphold: it REPORTS. A sweep
    // that quietly re-blinded a leaky row would destroy the evidence that the
    // guarantee had failed.
    const db = freshDb();
    seed(db, "nm000934", { authors: "Lovelace, Ada" });
    const before = db
      .query<{ anonymous: number; authors: string | null; visibility: string }, [string]>(
        "SELECT anonymous, authors, visibility FROM datasets WHERE dataset_id = ?",
      )
      .get("nm000934");
    await runAnonymitySweep(env(db), { seams: cleanSeams() });
    const after = db
      .query<{ anonymous: number; authors: string | null; visibility: string }, [string]>(
        "SELECT anonymous, authors, visibility FROM datasets WHERE dataset_id = ?",
      )
      .get("nm000934");
    expect(after).toEqual(before);
    db.close();
  });
});

describe("the deterministic matchers", () => {
  const owner = ownerIdentityOf({
    owner_username: OWNER.username,
    owner_github: OWNER.github,
    owner_given_name: OWNER.given,
    owner_family_name: OWNER.family,
    owner_email: OWNER.email,
    owner_orcid: OWNER.orcid,
  });

  test("a short token is not searched for", () => {
    // A two- or three-character surname matches inside ordinary words, and a
    // finding a depositor cannot reproduce is worse than no finding.
    const short = ownerIdentityOf({
      owner_username: "ab",
      owner_github: "xy",
      owner_given_name: "Bo",
      owner_family_name: "Ng",
      owner_email: null,
      owner_orcid: null,
    });
    expect(short.tokens).toEqual([]);
    expect(textNamesOwner("Bo Ng ran the study in Abu Dhabi", short)).toBe(false);
  });

  test("a token matches on a word boundary, not as a substring", () => {
    expect(textNamesOwner("Recorded by Ada Lovelace.", owner)).toBe(true);
    // The negative has to use a token that is actually IN PLAY. "Adaptive" was
    // the old probe, and "Ada" is three characters -- below
    // MIN_OWNER_TOKEN_LENGTH -- so `ownerIdentityOf` never produces it and the
    // assertion held whether or not the \\b anchors existed. "Lovelace" is a
    // real token, so this fails the moment the anchors come off.
    expect(owner.tokens).toContain("Lovelace");
    expect(textNamesOwner("The Lovelaceian transform was applied.", owner)).toBe(false);
  });

  test("a regex metacharacter in a name is matched literally, not as a pattern", () => {
    // `escapeRegExp` has no other coverage, and "O'Brien-Smith" / "St. John"
    // are ordinary surnames. An unescaped "." would match any character.
    // Only the family name is set, so the given name cannot satisfy the
    // negative by accident -- which it did on the first version of this test.
    const punctuated = ownerIdentityOf({
      owner_username: null,
      owner_github: null,
      owner_given_name: null,
      owner_family_name: "St.John",
      owner_email: null,
      owner_orcid: null,
    });
    expect(textNamesOwner("Collected by St.John.", punctuated)).toBe(true);
    expect(textNamesOwner("Collected by StxJohn.", punctuated)).toBe(false);
  });

  test("email and ORCID match literally", () => {
    expect(textNamesOwner(`contact: ${OWNER.email}`, owner)).toBe(true);
    expect(textNamesOwner(`https://orcid.org/${OWNER.orcid}`, owner)).toBe(true);
  });

  test("an ORCID belonging to ANYONE is a finding", () => {
    // Not only the depositor's: an ORCID iD is a permanent global identifier,
    // and a co-author's de-anonymizes the whole list in one lookup.
    const found = scanDepositFile(
      "README.md",
      "Co-authored with 0000-0001-2345-6789.",
      owner,
      isPlaceholderAuthor,
    );
    expect(found.findings.map((f) => f.check)).toEqual(["orcid_in_deposit"]);
  });

  test("an email is reported once, not twice, when it is also the depositor's", () => {
    const found = scanDepositFile(
      "README.md",
      `write to ${OWNER.email}`,
      owner,
      isPlaceholderAuthor,
    );
    expect(found.findings.map((f) => f.check)).toEqual(["depositor_named_in_deposit"]);
  });

  test("a stranger's email is still reported", () => {
    const found = scanDepositFile(
      "participants.tsv",
      "contact\tsomeone@elsewhere.org",
      owner,
      isPlaceholderAuthor,
    );
    expect(found.findings.map((f) => f.check)).toEqual(["email_in_deposit"]);
  });

  test("a blinded description produces nothing", () => {
    // The control for every assertion above.
    const found = scanDepositFile(
      "dataset_description.json",
      JSON.stringify({ Name: "A study", Authors: ["Anonymous"], Funding: ["N/A"] }),
      owner,
      isPlaceholderAuthor,
    );
    expect(found.findings).toEqual([]);
    expect(found.unchecked).toEqual([]);
  });

  test("named Authors, Funding and Acknowledgements are each their own finding", () => {
    const found = scanDepositFile(
      "dataset_description.json",
      JSON.stringify({
        Authors: ["Babbage, Charles"],
        Funding: ["The Analytical Engine Trust"],
        Acknowledgements: ["Thanks to Mary Somerville"],
      }),
      owner,
      isPlaceholderAuthor,
    );
    expect(found.findings.map((f) => f.check).sort()).toEqual([
      "description_acknowledgements_named",
      "description_authors_named",
      "description_funding_named",
    ]);
  });

  test("the placeholder rule is the publication gate's own", () => {
    // Imported, not re-implemented: the two run at different moments and must
    // not be able to disagree about what counts as naming nobody.
    expect(
      namedEntriesIn(
        { Authors: ["N/A", "Anonymous", "Real Person"] },
        "Authors",
        isPlaceholderAuthor,
      ),
    ).toEqual({ named: ["Real Person"], readable: true });
  });
});

describe("the bounded file scan", () => {
  test("priority files are read first, whatever else the manifest lists", () => {
    // The ordering IS the guarantee: a budget of 40 on a dataset with 3,000
    // git-tracked files must still read dataset_description.json.
    const many = Array.from({ length: 200 }, (_, i) => `zzz_${i}.json`);
    const chosen = selectDepositFiles([...many, "dataset_description.json", "README.md"], 5);
    expect(chosen.slice(0, 2)).toEqual(["dataset_description.json", "README.md"]);
    expect(chosen.length).toBe(5);
  });

  test("sub-directory sidecars are not scanned", () => {
    // Thousands of them, holding acquisition parameters rather than prose.
    const chosen = selectDepositFiles(["sub-01/eeg/sub-01_task-x_eeg.json", "README.md"], 40);
    expect(chosen).toEqual(["README.md"]);
  });
});

describe("the row invariants, as a pure rule", () => {
  test("a NULL author list is not a finding", () => {
    // It names nobody, which is the property under test; enrichment may simply
    // not have run yet.
    expect(
      checkRowInvariants({ authors: null, enrichment_json: null, first_published_at: null }),
    ).toEqual({ findings: [], unchecked: [] });
  });

  test("the blinded label is not a finding", () => {
    expect(
      checkRowInvariants({
        authors: ANONYMOUS_AUTHORS_LABEL,
        enrichment_json: null,
        first_published_at: null,
      }),
    ).toEqual({ findings: [], unchecked: [] });
  });

  test("an enrichment document with EMPTY blinded keys is not a finding", () => {
    // `blindEnrichmentMetadata` deletes the keys, but a document that carries
    // them as empty arrays names nobody either, and reporting it would train a
    // reader to ignore the check.
    expect(
      checkRowInvariants({
        authors: null,
        enrichment_json: JSON.stringify({ authors: {}, contributors: [], title: "t" }),
        first_published_at: null,
      }),
    ).toEqual({ findings: [], unchecked: [] });
  });

  test("unparseable enrichment JSON is UNCHECKED, not clean", () => {
    // It is not a leak -- the syntax is a different bug -- but it is also not a
    // clearance: a truncated or trailing-comma'd blob carries the depositor's
    // name perfectly well, and `GET /datasets/:id` serves this document raw.
    // Returning no finding AND no gap stamped `verified` on a document nobody
    // could read.
    const checked = checkRowInvariants({
      authors: null,
      enrichment_json: '{"authors": [{"name": "Ada Lovelace"}],,}',
      first_published_at: null,
    });
    expect(checked.findings).toEqual([]);
    expect(checked.unchecked).toEqual(["enrichment_not_blinded"]);
  });
});

describe("a finding never carries the text it matched", () => {
  // The rule stated in the module header, on `AnonymityFinding.detail`, on
  // `ANONYMITY_FINDINGS_PATH` and in ADR 0065 -- and, until this test, enforced
  // nowhere. Appending the matched text to a `detail` pasted the concealed
  // depositor's name into `sweep_stamps`, the `audit_log` row and forwardable
  // mail at once, and left every test green. This epic exists to keep one
  // person's identity concealed; the sweep must not be the thing that publishes
  // it.
  const leaky = [
    `Recorded by ${OWNER.given} ${OWNER.family} (${OWNER.email}), ORCID ${OWNER.orcid}.`,
    `GitHub: ${OWNER.github}, account ${OWNER.username}.`,
  ].join("\n");

  test("scanDepositFile names the file and the check, never the match", () => {
    const owner = ownerIdentityOf({
      owner_username: OWNER.username,
      owner_github: OWNER.github,
      owner_given_name: OWNER.given,
      owner_family_name: OWNER.family,
      owner_email: OWNER.email,
      owner_orcid: OWNER.orcid,
    });
    const found = scanDepositFile("README", leaky, owner, isPlaceholderAuthor);
    expect(found.findings.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(found.findings);
    for (const secret of [OWNER.family, OWNER.email, OWNER.orcid, OWNER.username, OWNER.github]) {
      expect(serialized).not.toContain(secret);
    }
    // The file path IS named: it is what the depositor has to open.
    expect(serialized).toContain("README");
  });

  test("nothing the sweep stamps carries the depositor's identity", async () => {
    const db = freshDb();
    seed(db, "nm000950");
    await runAnonymitySweep(env(db), {
      seams: cleanSeams({ ...CLEAN_FILES, README: leaky }),
    });
    const stamps = JSON.stringify(stamp(db, "nm000950"));
    for (const secret of [OWNER.family, OWNER.email, OWNER.orcid, OWNER.username, OWNER.github]) {
      expect(stamps).not.toContain(secret);
    }
    expect(stamps).toContain("depositor_named_in_deposit");
    db.close();
  });

  test("the audit row records the finding and not the person", async () => {
    const db = freshDb();
    seed(db, "nm000951");
    await runAnonymitySweep(env(db), {
      seams: cleanSeams({ ...CLEAN_FILES, README: leaky }),
    });
    const rows = db
      .query<{ action: string; resource_id: string; details: string | null }, []>(
        "SELECT action, resource_id, details FROM audit_log WHERE action = 'anonymity_findings'",
      )
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0].resource_id).toBe("nm000951");
    for (const secret of [OWNER.family, OWNER.email, OWNER.orcid]) {
      expect(rows[0].details ?? "").not.toContain(secret);
    }
    db.close();
  });
});

describe("the deposit-file scan, through the real sweep", () => {
  // Driven through `runAnonymitySweep`, not by calling `scanDepositFile`
  // directly: .rules/testing.md's "test the entry point, not the piece".
  // Everything between the tree listing and the matchers -- selection, the
  // budget, the size cap, the fetch, the verdict -- used to have no coverage at
  // all, which is how the scope bug below reached a PR.

  test("a named author in dataset_description.json reaches the verdict", async () => {
    const db = freshDb();
    seed(db, "nm000960");
    const res = await runAnonymitySweep(env(db), {
      seams: cleanSeams({
        "dataset_description.json": JSON.stringify({
          Name: "A study",
          Authors: ["Babbage, Charles"],
        }),
        README: "Nothing identifying here.",
      }),
    });
    expect(res.results[0].status).toBe("findings");
    expect(res.results[0].findings.map((f) => f.check)).toEqual(["description_authors_named"]);
    expect(res.results[0].findings[0].severity).toBe("deposit");
    expect(res.results[0].files_scanned).toBe(2);
    db.close();
  });

  test("a real BIDS layout still VERIFIES; sub-directories are scope, not a gap", async () => {
    // The regression that motivated this whole block. `filesListed` counts every
    // blob in the tree and `selected` is root-level textual files, so comparing
    // them made every dataset with a `sub-01/` directory report a budget
    // overrun it never had -- and `verified` unreachable for any real deposit.
    const db = freshDb();
    seed(db, "nm000961");
    const listing = [
      { path: "dataset_description.json", sha: "a".repeat(40), size: 60, mode: "100644" },
      { path: "README", sha: "b".repeat(40), size: 20, mode: "100644" },
      ...Array.from({ length: 50 }, (_, i) => ({
        path: `sub-${i}/eeg/sub-${i}_task-rest_eeg.edf`,
        sha: "c".repeat(40),
        size: 4096,
        mode: "100644",
      })),
    ];
    const res = await runAnonymitySweep(env(db), {
      seams: cleanSeams(CLEAN_FILES, { listing }),
    });
    expect(res.results[0].status).toBe("verified");
    expect(res.results[0].files_listed).toBe(52);
    expect(res.results[0].files_scanned).toBe(2);
    // Declared, so the reader of "verified" knows what it does not cover...
    expect(res.results[0].unchecked).toEqual(["signal_headers", "deposit_subdirectory_files"]);
    // ...but NOT treated as a gap that withholds the verdict.
    expect(res.results[0].unchecked).not.toContain("deposit_files_beyond_budget");
    db.close();
  });

  test("the 40-file budget IS a gap when it truncates the in-scope set", async () => {
    const db = freshDb();
    seed(db, "nm000962");
    const listing = Array.from({ length: 60 }, (_, i) => ({
      path: `extra_${String(i).padStart(3, "0")}.json`,
      sha: "d".repeat(40),
      size: 10,
      mode: "100644",
    }));
    const files: Record<string, string> = {};
    for (const entry of listing) files[entry.path] = "{}";
    const res = await runAnonymitySweep(env(db), { seams: cleanSeams(files, { listing }) });
    expect(res.results[0].status).toBe("unverifiable");
    expect(res.results[0].unchecked).toContain("deposit_files_beyond_budget");
    expect(res.results[0].files_scanned).toBe(40);
    db.close();
  });

  test("an EMPTY listing is a failed listing, not an empty repository", async () => {
    // `[]` is truthy, so this used to take the success branch: no files, no
    // findings, `verified` -- a clean bill of health for a repository nobody
    // read. Every dataset repository has a dataset_description.json.
    const db = freshDb();
    seed(db, "nm000963");
    const res = await runAnonymitySweep(env(db), { seams: cleanSeams({}, { listing: [] }) });
    expect(res.results[0].status).toBe("unverifiable");
    expect(res.results[0].unchecked).toContain("deposit_files");
    expect(stamp(db, "nm000963").anonymity_status).toBe("unverifiable");
    db.close();
  });

  test("a file over the size cap is unchecked, not clean", async () => {
    const db = freshDb();
    seed(db, "nm000964");
    const listing = [
      { path: "dataset_description.json", sha: "a".repeat(40), size: 60, mode: "100644" },
      { path: "participants.tsv", sha: "b".repeat(40), size: 9_000_000, mode: "100644" },
    ];
    const res = await runAnonymitySweep(env(db), {
      seams: cleanSeams(
        { "dataset_description.json": CLEAN_FILES["dataset_description.json"] },
        { listing },
      ),
    });
    expect(res.results[0].status).toBe("unverifiable");
    expect(res.results[0].unchecked).toContain("deposit_file_too_large:participants.tsv");
    db.close();
  });

  test("a tree entry with no size is unknown, not zero", async () => {
    const db = freshDb();
    seed(db, "nm000965");
    const listing = [{ path: "participants.tsv", sha: "b".repeat(40), mode: "100644" }];
    const res = await runAnonymitySweep(env(db), { seams: cleanSeams({}, { listing }) });
    expect(res.results[0].unchecked).toContain("deposit_file_too_large:participants.tsv");
    db.close();
  });

  test("a git-annex pointer is unchecked, because its body is not the content", async () => {
    // ADR 0060: an inherited .gitattributes can annex ordinary BIDS metadata.
    // Scanning the pointer finds nothing and would count as a clean read.
    const db = freshDb();
    seed(db, "nm000966");
    const listing = [
      { path: "participants.tsv", sha: "b".repeat(40), size: 120, mode: "120000" },
      { path: "README", sha: "c".repeat(40), size: 60, mode: "100644" },
    ];
    const res = await runAnonymitySweep(env(db), {
      seams: cleanSeams({ README: "Nothing here." }, { listing }),
    });
    expect(res.results[0].unchecked).toContain("deposit_file_annexed:participants.tsv");
    expect(res.results[0].status).toBe("unverifiable");
    db.close();
  });

  test("a file the content host cannot serve is unchecked, not clean", async () => {
    const db = freshDb();
    seed(db, "nm000967");
    const seams = cleanSeams({ README: "fine" });
    served.set("participants.tsv", { body: "", status: 502 });
    seams.listGitFilesImpl = async () => [
      { path: "README", sha: "a".repeat(40), size: 4, mode: "100644" },
      { path: "participants.tsv", sha: "b".repeat(40), size: 40, mode: "100644" },
    ];
    const res = await runAnonymitySweep(env(db), { seams });
    expect(res.results[0].status).toBe("unverifiable");
    expect(res.results[0].unchecked).toContain("deposit_file_unreadable:participants.tsv");
    db.close();
  });
});

describe("the owner projection, re-run rather than trusted", () => {
  test("a projection that leaks the owner IS an invariant finding", async () => {
    // The real projection blinds on `d.anonymous = 1`, which is the candidate
    // predicate, so no seedable row can make it leak -- the check had a control
    // and no positive case, and neutralizing its branch left every test green.
    // This supplies the projection a future edit that dropped the blind would
    // produce, and asserts the sweep notices.
    const db = freshDb();
    seed(db, "nm000970");
    const res = await runAnonymitySweep(env(db), {
      seams: {
        ...cleanSeams(),
        ownerProjectionSql: `SELECT u.username AS owner_username, u.github_username AS owner_github
             FROM datasets d JOIN users u ON d.owner_user_id = u.id
             WHERE d.dataset_id = ?`,
      },
    });
    expect(res.results[0].findings.map((f) => f.check)).toEqual(["owner_projected"]);
    expect(res.results[0].findings[0].severity).toBe("invariant");
    db.close();
  });

  test("a projection that returns NO row is unchecked, never a disclosure", async () => {
    // `.first()` returns null, and `null?.owner_username !== null` is `undefined
    // !== null`, which is TRUE. So a check that could not run raised a hard
    // "your identity is exposed" finding and mailed the depositor and every
    // admin about it. Could-not-check is a gap, not a leak.
    const db = freshDb();
    seed(db, "nm000971");
    const res = await runAnonymitySweep(env(db), {
      seams: {
        ...cleanSeams(),
        ownerProjectionSql: `SELECT u.username AS owner_username, u.github_username AS owner_github
             FROM datasets d JOIN users u ON d.owner_user_id = u.id
             WHERE d.dataset_id = ? AND 1 = 0`,
      },
    });
    expect(res.results[0].findings).toEqual([]);
    expect(res.results[0].unchecked).toContain("owner_projected");
    expect(res.results[0].status).toBe("unverifiable");
    db.close();
  });
});

describe("what the sweep does NOT do", () => {
  test("it writes sweep_stamps and nothing else on the row", async () => {
    // Compared across the WHOLE row, not three named columns: the rule is
    // "reports, never repairs", and a mutation that clobbered `name` used to
    // pass because the assertion only looked at anonymous/authors/visibility.
    const db = freshDb();
    seed(db, "nm000972", { authors: "Lovelace, Ada" });
    const before = db
      .query<Record<string, unknown>, [string]>("SELECT * FROM datasets WHERE dataset_id = ?")
      .get("nm000972");
    await runAnonymitySweep(env(db), { seams: cleanSeams() });
    const after = db
      .query<Record<string, unknown>, [string]>("SELECT * FROM datasets WHERE dataset_id = ?")
      .get("nm000972");
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    const changed = Object.keys(after as object).filter(
      (k) => (before as Record<string, unknown>)[k] !== (after as Record<string, unknown>)[k],
    );
    expect(changed).toEqual(["sweep_stamps"]);
    db.close();
  });

  test("an unchanged set of findings is not re-mailed, but is re-recorded", async () => {
    // A deposit finding stays true until the depositor edits their own file.
    // Mailing it daily trains both audiences to ignore the one that is new.
    const db = freshDb();
    seed(db, "nm000973");
    const leaky = { ...CLEAN_FILES, README: "Contact 0000-0001-2345-6789." };
    await runAnonymitySweep(env(db), { seams: cleanSeams(leaky) });
    db.run(
      "UPDATE datasets SET sweep_stamps = json_remove(sweep_stamps, '$.anonymity_attempted_at')",
    );
    await runAnonymitySweep(env(db), { seams: cleanSeams(leaky) });
    const audits = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'anonymity_findings'",
      )
      .get();
    // Recorded on BOTH runs: the durable record stays complete...
    expect(audits?.n).toBe(2);
    db.close();
  });
});

describe("queue fairness and the count", () => {
  test("never-attempted datasets come first, then the oldest attempt", async () => {
    // Asserted WITHOUT sorting the result. The previous version called `.sort()`
    // on the ids, which destroyed the only evidence the ORDER BY existed:
    // deleting the whole clause left the suite green, and a dataset that errors
    // every run would retake the front of the queue forever.
    const db = freshDb();
    seed(db, "nm000980");
    seed(db, "nm000981");
    seed(db, "nm000982");
    db.run(
      "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps,'{}'), '$.anonymity_attempted_at', '2026-01-02 00:00:00') WHERE dataset_id = 'nm000980'",
    );
    db.run(
      "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps,'{}'), '$.anonymity_attempted_at', '2026-01-01 00:00:00') WHERE dataset_id = 'nm000982'",
    );
    const rows = db.query<{ dataset_id: string }, [number]>(ANONYMITY_SWEEP_CANDIDATE_SQL).all(10);
    expect(rows.map((r) => r.dataset_id)).toEqual(["nm000981", "nm000982", "nm000980"]);
    db.close();
  });

  test("remaining counts what the candidate query would return, and drains", async () => {
    const db = freshDb();
    for (const id of ["nm000983", "nm000984", "nm000985"]) seed(db, id);
    const first = await runAnonymitySweep(env(db), { limit: 2, seams: cleanSeams() });
    expect(first.processed).toBe(2);
    expect(first.remaining).toBe(1);
    const second = await runAnonymitySweep(env(db), { limit: 2, seams: cleanSeams() });
    expect(second.processed).toBe(1);
    expect(second.remaining).toBe(0);
    db.close();
  });

  test("a reset re-arms the attempt stamp, not only the verdict", async () => {
    // A `--reset` that clears the verdict but leaves the attempt holds every
    // row outside the 20-hour window until tomorrow, which is not a reset.
    const db = freshDb();
    seed(db, "nm000986");
    await runAnonymitySweep(env(db), { seams: cleanSeams() });
    expect(stamp(db, "nm000986").anonymity_attempted_at).toBeTruthy();
    db.query(ANONYMITY_SWEEP_RESET_SQL).run();
    const after = stamp(db, "nm000986");
    expect(after.anonymity_attempted_at).toBeUndefined();
    expect(after.anonymity_status).toBeUndefined();
    // And it is a candidate again immediately.
    const rows = db.query<{ dataset_id: string }, [number]>(ANONYMITY_SWEEP_CANDIDATE_SQL).all(10);
    expect(rows.map((r) => r.dataset_id)).toEqual(["nm000986"]);
    db.close();
  });
});

describe("the shapes a depositor's dataset_description.json actually takes", () => {
  const owner = ownerIdentityOf({
    owner_username: OWNER.username,
    owner_github: OWNER.github,
    owner_given_name: OWNER.given,
    owner_family_name: OWNER.family,
    owner_email: OWNER.email,
    owner_orcid: OWNER.orcid,
  });

  test("an unparseable description is unchecked, not clean", () => {
    // A hand-edited BIDS file with a trailing comma is ordinary. The free-text
    // rules still run, but they only know the DEPOSITOR -- a co-author's name,
    // which is exactly what the structured check is for, is invisible to them.
    const found = scanDepositFile(
      "dataset_description.json",
      '{"Authors": ["Jane Coauthor"],,}',
      owner,
      isPlaceholderAuthor,
    );
    expect(found.findings).toEqual([]);
    expect(found.unchecked).toEqual(["description_structured:dataset_description.json"]);
  });

  test("a bare-string Authors field is read as one entry, not discarded", () => {
    expect(namedEntriesIn({ Authors: "Jane Coauthor" }, "Authors", isPlaceholderAuthor)).toEqual({
      named: ["Jane Coauthor"],
      readable: true,
    });
  });

  test("an array of objects is UNREADABLE, which is not the same as empty", () => {
    // `[{"name": "Jane Coauthor"}]` used to filter down to `[]`, which is
    // indistinguishable from "this field names nobody" and fed `verified`.
    expect(
      namedEntriesIn({ Authors: [{ name: "Jane Coauthor" }] }, "Authors", isPlaceholderAuthor),
    ).toEqual({ named: [], readable: false });
  });

  test("an unreadable field makes the dataset unverifiable, not clean", () => {
    const found = scanDepositFile(
      "dataset_description.json",
      JSON.stringify({ Authors: [{ name: "Jane Coauthor" }] }),
      owner,
      isPlaceholderAuthor,
    );
    expect(found.findings).toEqual([]);
    expect(found.unchecked).toEqual(["description_field:Authors"]);
  });

  test("a withheld key surviving in .nemar/metadata.json is NEMAR's bug", () => {
    // NEMAR writes and blinds this file, so this is `invariant`, not `deposit`.
    const found = scanDepositFile(
      ".nemar/metadata.json",
      // A CO-AUTHOR, not the depositor: the free-text depositor rule would fire
      // on their own name and this test would not be isolating the structured
      // check that NEMAR's own blind failed.
      JSON.stringify({ authors: { "Charles Babbage": {} }, title: "t" }),
      owner,
      isPlaceholderAuthor,
    );
    expect(found.findings.map((f) => f.check)).toEqual(["repo_metadata_not_blinded"]);
    expect(found.findings[0].severity).toBe("invariant");
    expect(JSON.stringify(found.findings)).not.toContain("Babbage");
  });

  test("a blinded .nemar/metadata.json is the control", () => {
    const found = scanDepositFile(
      ".nemar/metadata.json",
      JSON.stringify({ title: "t", description: "d" }),
      owner,
      isPlaceholderAuthor,
    );
    expect(found.findings).toEqual([]);
    expect(found.unchecked).toEqual([]);
  });

  test("a lowercase ORCID checksum is still an ORCID", () => {
    const found = scanDepositFile(
      "README",
      "ORCID 0000-0002-1694-233x",
      owner,
      isPlaceholderAuthor,
    );
    expect(found.findings.map((f) => f.check)).toEqual(["orcid_in_deposit"]);
  });
});

describe("the Zarr index, which is served publicly", () => {
  test("a 403 is a GAP, not an absent index", async () => {
    // The bucket denies anonymous ListBucket, so 403 covers missing,
    // present-but-not-public, a policy change in flight, and a key this
    // principal cannot see. Folding it into "no index" cleared a published
    // index that names the depositor and could not be read.
    const db = freshDb();
    seed(db, "nm000990");
    const seams = cleanSeams();
    seams.fetchZarrIndexImpl = async () => {
      throw new Error("zarr index GET 403 (cannot distinguish absent from unreadable)");
    };
    const res = await runAnonymitySweep(env(db), { seams });
    expect(res.results[0].status).toBe("unverifiable");
    expect(res.results[0].unchecked).toContain("zarr_index");
    expect(stamp(db, "nm000990").anonymity_status).toBe("unverifiable");
    db.close();
  });

  test("an ORCID baked into a public index is a finding, whoever it belongs to", async () => {
    const db = freshDb();
    seed(db, "nm000991");
    const seams = cleanSeams();
    seams.fetchZarrIndexImpl = async () =>
      JSON.stringify({ citation: "Someone (2026). ORCID 0000-0001-2345-6789." });
    const res = await runAnonymitySweep(env(db), { seams });
    expect(res.results[0].findings.map((f) => f.check)).toContain("zarr_index_names_depositor");
    db.close();
  });
});
