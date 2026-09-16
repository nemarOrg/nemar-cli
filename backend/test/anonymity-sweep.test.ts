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
import { describe, expect, test } from "bun:test";
import { ANONYMOUS_AUTHORS_LABEL } from "../src/services/anonymity";
import {
  ANONYMITY_SWEEP_CANDIDATE_SQL,
  type AnonymitySweepSeams,
  checkRowInvariants,
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

/** A clean world: private repo, reserved DOI, no zarr store, no files. */
function cleanSeams(files: Record<string, string> = {}): AnonymitySweepSeams {
  return {
    fetchGithubImpl: (async () =>
      new Response(JSON.stringify({ private: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    getIdentifierImpl: async () => ({ status: "reserved", dataciteXml: "<resource/>" }),
    fetchZarrIndexImpl: async () => null,
    listGitFilesImpl: async () =>
      Object.keys(files).map((path) => ({
        path,
        sha: "a".repeat(40),
        size: files[path].length,
      })),
    rawBase: "http://127.0.0.1:1",
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
      }).map((f) => f.check),
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
    // "Ada" inside "Adaptive" is not the depositor.
    expect(textNamesOwner("Adaptive filtering was applied.", owner)).toBe(false);
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
    expect(found.map((f) => f.check)).toEqual(["orcid_in_deposit"]);
  });

  test("an email is reported once, not twice, when it is also the depositor's", () => {
    const found = scanDepositFile(
      "README.md",
      `write to ${OWNER.email}`,
      owner,
      isPlaceholderAuthor,
    );
    expect(found.map((f) => f.check)).toEqual(["depositor_named_in_deposit"]);
  });

  test("a stranger's email is still reported", () => {
    const found = scanDepositFile(
      "participants.tsv",
      "contact\tsomeone@elsewhere.org",
      owner,
      isPlaceholderAuthor,
    );
    expect(found.map((f) => f.check)).toEqual(["email_in_deposit"]);
  });

  test("a blinded description produces nothing", () => {
    // The control for every assertion above.
    const found = scanDepositFile(
      "dataset_description.json",
      JSON.stringify({ Name: "A study", Authors: ["Anonymous"], Funding: ["N/A"] }),
      owner,
      isPlaceholderAuthor,
    );
    expect(found).toEqual([]);
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
    expect(found.map((f) => f.check).sort()).toEqual([
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
    ).toEqual(["Real Person"]);
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
    ).toEqual([]);
  });

  test("the blinded label is not a finding", () => {
    expect(
      checkRowInvariants({
        authors: ANONYMOUS_AUTHORS_LABEL,
        enrichment_json: null,
        first_published_at: null,
      }),
    ).toEqual([]);
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
    ).toEqual([]);
  });

  test("unparseable enrichment JSON is not reported as a leak", () => {
    expect(
      checkRowInvariants({ authors: null, enrichment_json: "{not json", first_published_at: null }),
    ).toEqual([]);
  });
});
