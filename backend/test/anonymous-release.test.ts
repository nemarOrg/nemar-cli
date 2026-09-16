/**
 * The anonymous release, at its real entry points (#1408, epic #1406).
 *
 * Phase 2's review found two blinds whose deletion left the entire suite
 * green, because the tests asserted on hand-built fixtures rather than on what
 * the code actually emits. So the two rules this phase adds that a reader can
 * observe from outside -- the withheld `github_url` and the conditional
 * author gate -- are driven through the real route and the real exported
 * function, each with a control that proves the assertion can fail.
 *
 * The orchestration (which steps run, what order the blinding happens in) is
 * asserted separately in `anonymity-publication-paths.test.ts`: it cannot be
 * driven end to end here, because approving a publication makes real GitHub,
 * S3 and EZID calls.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { dataRoutes } from "../src/routes/data";
import { datasetRoutes } from "../src/routes/datasets";
import { ANONYMOUS_AUTHORS_LABEL } from "../src/services/anonymity";
import { evaluateSubmissionMinimums } from "../src/services/submission-minimums";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

function seed(db: Database, id: string, anonymous: number): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility,
                           is_sandbox, github_repo, anonymous, concept_doi)
     VALUES (?, ?, 1, 'active', 'public', 0, ?, ?, ?)`,
  ).run(id, id, `nemarDatasets/${id}`, anonymous, "10.82901/reserved-test");
}

function env(db: Database): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
}

async function externalLinksOf(
  db: Database,
  id: string,
): Promise<{ github_url: string | null; dataset_doi: string | null }> {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/", dataRoutes);
  const res = await app.request(`/${id}/metadata.json`, {}, env(db));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    external_links: { github_url: string | null; dataset_doi: string | null };
  };
  return body.external_links;
}

describe("the data plane withholds the repository URL while anonymous", () => {
  test("an anonymous deposit serves github_url: null", async () => {
    // The repository is PRIVATE, so naming it would hand every reader a URL
    // that 404s while still disclosing that a repository exists under a
    // predictable name. Withheld at the source because the website fabricates
    // this URL in two places when it is absent -- a null is what those sites
    // need in order to have something to react to.
    const db = freshDb();
    seed(db, "nm000860", 1);
    expect((await externalLinksOf(db, "nm000860")).github_url).toBeNull();
    db.close();
  });

  test("an ordinary dataset still serves it, which is what makes the test above mean something", async () => {
    // The control. `github_repo` is identical on both rows, so the only
    // difference is the flag; without this, a builder that returned null for
    // everything would satisfy the assertion above.
    const db = freshDb();
    seed(db, "nm000861", 0);
    expect((await externalLinksOf(db, "nm000861")).github_url).toBe(
      "https://github.com/nemarDatasets/nm000861",
    );
    db.close();
  });
});

describe("the data plane states that a deposit is concealed", () => {
  async function anonymousFlag(db: Database, id: string): Promise<boolean> {
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.route("/", dataRoutes);
    const res = await app.request(`/${id}/metadata.json`, {}, env(db));
    expect(res.status).toBe(200);
    return ((await res.json()) as { anonymous: boolean }).anonymous;
  }

  test("an anonymous release says so, rather than just looking empty", async () => {
    // "Withheld" and "missing" look identical from empty authors and null
    // links, and a reader who cannot tell them apart concludes the record is
    // incomplete. This is the field that lets a consumer render the
    // difference -- and it is the one signal the website cannot get wrong by
    // a fetch failing, because the page 404s rather than degrading.
    const db = freshDb();
    seed(db, "nm000864", 1);
    expect(await anonymousFlag(db, "nm000864")).toBe(true);
    db.close();
  });

  test("an ordinary dataset reports false", async () => {
    const db = freshDb();
    seed(db, "nm000865", 0);
    expect(await anonymousFlag(db, "nm000865")).toBe(false);
    db.close();
  });
});

describe("the data plane does not advertise a reserved DOI", () => {
  test("an anonymous release serves dataset_doi: null", async () => {
    // The identifier exists at EZID but is `reserved`: registered, not
    // advertised, and it does not resolve. Serving it here would put a dead
    // DOI into signposting, JSON-LD and every citation widget reading this
    // document -- and a depositor mid-submission would cite it.
    const db = freshDb();
    seed(db, "nm000862", 1);
    expect((await externalLinksOf(db, "nm000862")).dataset_doi).toBeNull();
    db.close();
  });

  test("an ordinary dataset still advertises its DOI", async () => {
    const db = freshDb();
    seed(db, "nm000863", 0);
    expect((await externalLinksOf(db, "nm000863")).dataset_doi).toBe("10.82901/reserved-test");
    db.close();
  });
});

describe("the Authors rule inverts for an anonymous release", () => {
  const ETHICS = ["Approved by an institutional review board"];
  const NAME = "A sufficiently descriptive dataset title";
  const desc = (authors: string[]) =>
    JSON.stringify({ Name: NAME, Authors: authors, EthicsApprovals: ETHICS });

  const BLINDED = desc(["Anonymous"]);
  const ATTRIBUTED = desc(["Ada Lovelace"]);

  test("a blinded deposit passes an anonymous release", () => {
    expect(evaluateSubmissionMinimums(BLINDED, null, { anonymousRelease: true })).toEqual([]);
  });

  test("the same deposit is refused a real publication", () => {
    // The interlock: one gate, two complementary rules. A depositor cannot
    // publish for real while still concealed, and the refusal names the fix.
    const reasons = evaluateSubmissionMinimums(BLINDED, null);
    expect(reasons.length).toBe(1);
    expect(reasons[0]).toMatch(/must name the people responsible/);
  });

  test("REAL names are refused an anonymous release, and the names are quoted back", () => {
    // The case an earlier draft allowed, and the reason this rule inverts
    // rather than relaxes. `dataset_description.json` is part of the dataset
    // and is served publicly from the data plane, so a depositor who asked to
    // be concealed and left their name in it would have been published under
    // it by their own file -- having passed every gate.
    const reasons = evaluateSubmissionMinimums(ATTRIBUTED, null, { anonymousRelease: true });
    expect(reasons.length).toBe(1);
    expect(reasons[0]).toMatch(/still names Ada Lovelace/);
    expect(reasons[0]).toMatch(/Restore the real names when you publish/);
  });

  test("restoring the real authors is what unblocks the publication", () => {
    expect(evaluateSubmissionMinimums(ATTRIBUTED, null)).toEqual([]);
  });

  test("an empty Authors field is refused either way", () => {
    // Empty is an incomplete file, not a blinded one, and accepting it for a
    // release would let the rule swallow a real defect.
    const anon = evaluateSubmissionMinimums(desc([]), null, { anonymousRelease: true });
    expect(anon.length).toBe(1);
    expect(anon[0]).toMatch(/must not be empty/);
    expect(evaluateSubmissionMinimums(desc([]), null).length).toBe(1);
  });

  test("NEMAR's own blinded label passes the release it was written for", () => {
    // `ANONYMOUS_AUTHORS_LABEL` is what the catalog shows in place of an
    // author list, so a depositor reading their own dataset page and copying
    // the string into dataset_description.json is the obvious thing to do.
    // The placeholder regex was anchored (`^anonymous$`), so they were told
    // their blinded file "still names Anonymous (withheld until publication)".
    expect(
      evaluateSubmissionMinimums(desc([ANONYMOUS_AUTHORS_LABEL]), null, { anonymousRelease: true }),
    ).toEqual([]);
    // And the complement still holds: it is not a publishable author list.
    expect(evaluateSubmissionMinimums(desc([ANONYMOUS_AUTHORS_LABEL]), null).length).toBe(1);
  });

  test("the two rules are exact complements over any NON-EMPTY Authors field", () => {
    // Stated as a property rather than more cases: for any non-empty Authors
    // field, exactly one of the two submissions accepts it. That is what makes
    // "blind to release, restore to publish" an ordering rather than advice.
    // EMPTY is the one input both refuse, which the test above pins: an empty
    // field is an incomplete file, not a blinded one, and if the property were
    // stated over every input it would be false.
    for (const authors of [
      ["Anonymous"],
      ["Ada Lovelace"],
      ["N/A"],
      ["[Unspecified1]"],
      [ANONYMOUS_AUTHORS_LABEL],
      ["Anonymous (blinded for review)"],
    ]) {
      const asRelease = evaluateSubmissionMinimums(desc(authors), null, {
        anonymousRelease: true,
      }).length;
      const asPublication = evaluateSubmissionMinimums(desc(authors), null).length;
      expect(
        (asRelease === 0) !== (asPublication === 0),
        `Authors ${JSON.stringify(authors)} is accepted by both or neither`,
      ).toBe(true);
    }
  });

  test("any placeholder blinds a release, not only the word Anonymous", () => {
    // Settled deliberately rather than left as an accident of the regex: the
    // rule for a release is "this file names nobody", and "N/A" names nobody.
    // The refusal message for an empty field tells the depositor to use "a
    // placeholder such as Anonymous" -- `such as`, so accepting the others is
    // the consistent reading. The one case still refused is an EMPTY field,
    // which is indistinguishable from a file that was never filled in.
    for (const placeholder of ["N/A", "none", "TBD", "[Unspecified1]", "Anonymous"]) {
      expect(
        evaluateSubmissionMinimums(desc([placeholder]), null, { anonymousRelease: true }),
        `${placeholder} should blind a release`,
      ).toEqual([]);
    }
    expect(evaluateSubmissionMinimums(desc([]), null, { anonymousRelease: true }).length).toBe(1);
  });

  test("the inversion is narrow: every other minimum still applies", () => {
    // If the rule widened to "skip the checks for anonymous", this passes.
    const shortNameNoEthics = JSON.stringify({ Name: "EEG", Authors: ["Anonymous"] });
    const reasons = evaluateSubmissionMinimums(shortNameNoEthics, null, {
      anonymousRelease: true,
    });
    expect(reasons.length).toBe(2);
    expect(reasons.join(" ")).toMatch(/descriptive title/);
    expect(reasons.join(" ")).toMatch(/ethics approval statement/i);
  });
});

/**
 * The request route and the catalog, driven through the real Hono app with a
 * real bun:sqlite database and the real auth middleware.
 *
 * These are the paths a review of this PR found broken in ways no source-level
 * assertion would catch: a guard that read a column its own SELECT did not
 * ask for, a flag that reached the database but no response, and identifiers
 * withheld by one half of a response and served by the other.
 */
describe("the request route, end to end", () => {
  const OWNER_KEY = "anon-owner-key-0123456789abcdef0123456789abcdef";
  const STRANGER_KEY = "anon-stranger-key-0123456789abcdef0123456789ab";

  async function seedPeople(db: Database): Promise<{ ownerId: number; strangerId: number }> {
    const ids: number[] = [];
    for (const [username, key] of [
      ["anon-owner", OWNER_KEY],
      ["anon-stranger", STRANGER_KEY],
    ] as const) {
      db.run(
        `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                            service_access, sandbox_completed, given_name, family_name)
         VALUES (?, ?, 'x', 'approved', 'member', 1, 1, 1, 'Ada', 'Lovelace')`,
        [username, `${username}@example.org`],
      );
      const row = db
        .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
        .get(username);
      if (!row) throw new Error(`seed: ${username} insert failed`);
      ids.push(row.id);
      db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
        row.id,
        await hashApiKey(key),
        key.slice(0, 8),
      );
    }
    return { ownerId: ids[0], strangerId: ids[1] };
  }

  function seedDataset(
    db: Database,
    ownerId: number,
    id: string,
    fields: {
      visibility: string;
      anonymous: number;
      firstPublishedAt?: string | null;
      githubRepo?: string | null;
      conceptDoi?: string | null;
      isExemplar?: number;
    },
  ): void {
    db.query(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                             github_repo, anonymous, concept_doi, first_published_at, is_exemplar)
       VALUES (?, ?, ?, 'active', ?, 0, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      `A sufficiently descriptive title for ${id}`,
      ownerId,
      fields.visibility,
      fields.githubRepo ?? null,
      fields.anonymous,
      fields.conceptDoi ?? null,
      fields.firstPublishedAt ?? null,
      fields.isExemplar ?? 0,
    );
  }

  function app(): Hono<{ Bindings: Bindings; Variables: Variables }> {
    const a = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    a.route("/datasets", datasetRoutes);
    return a;
  }

  function publishRequest(db: Database, id: string, key: string, body?: string): Promise<Response> {
    return app().request(
      `/datasets/${id}/publish/request`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          ...(body ? {} : {}),
        },
        ...(body === undefined ? {} : { body }),
      },
      env(db),
    );
  }

  test("an `anonymous` key that is not a boolean is refused", async () => {
    // `{"anonymous": "true"}` is what a form serializer sends, and it is not
    // `=== true`. Coercing it to a normal publication would name a depositor
    // who asked to be concealed, with a success message identical to the one
    // a correct request gets. There is no un-publishing a name.
    const db = freshDb();
    const { ownerId } = await seedPeople(db);
    seedDataset(db, ownerId, "nm000870", { visibility: "private", anonymous: 0 });
    const res = await publishRequest(db, "nm000870", OWNER_KEY, '{"anonymous":"true"}');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_anonymous");
    db.close();
  });

  test("a normal request is accepted and says it is not anonymous", async () => {
    // The control for the two tests below, and the compatibility pin: a
    // bodyless POST is what every caller before #1408 sent.
    const db = freshDb();
    const { ownerId } = await seedPeople(db);
    seedDataset(db, ownerId, "nm000871", { visibility: "private", anonymous: 0 });
    const res = await publishRequest(db, "nm000871", OWNER_KEY);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "requested", anonymous: false });
    db.close();
  });

  test("an anonymous request with no readable repository is BLOCKED, not granted", async () => {
    // The blind check reads `dataset_description.json` and refuses the release
    // when Authors still names anybody. With no repository there is nothing to
    // read, so there is nothing to certify -- and a blind nobody verified must
    // not be granted. The 422 still echoes what was asked for, so a depositor
    // can see their flag was understood.
    const db = freshDb();
    const { ownerId } = await seedPeople(db);
    seedDataset(db, ownerId, "nm000872", { visibility: "private", anonymous: 0 });
    const res = await publishRequest(db, "nm000872", OWNER_KEY, '{"anonymous":true}');
    expect(res.status).toBe(422);
    const body = (await res.json()) as { anonymous: boolean; block_reason: string };
    expect(body.anonymous).toBe(true);
    expect(body.block_reason).toBe("min_requirements_failed");
    // And the intent is recorded, so the row is not silently a normal request.
    const row = db
      .query<{ anonymous: number }, [string]>(
        "SELECT anonymous FROM publication_requests WHERE dataset_id = ?",
      )
      .get("nm000872");
    expect(row?.anonymous).toBe(1);
    db.close();
  });

  test("the status route reports which of the two runs is queued", async () => {
    // The only place a depositor can confirm, before an admin acts, that
    // `--anonymous` was recorded. Without it the flag is write-only.
    const db = freshDb();
    const { ownerId } = await seedPeople(db);
    seedDataset(db, ownerId, "nm000873", { visibility: "private", anonymous: 0 });
    await publishRequest(db, "nm000873", OWNER_KEY, '{"anonymous":true}');
    const res = await app().request(
      "/datasets/nm000873/publish/status",
      { headers: { Authorization: `Bearer ${OWNER_KEY}` } },
      env(db),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { anonymous: boolean }).anonymous).toBe(true);
    db.close();
  });

  test("a dataset that has been published cannot be concealed, even while private", async () => {
    // The regression: `hasEverBeenPublished` reads `first_published_at`, and
    // the route's SELECT did not ask for it, so the guard always answered
    // "never published" and this request was accepted. A dataset that was
    // public and has since been reverted is exactly the row that reaches here
    // -- `visibility` has no history, the stamp does.
    const db = freshDb();
    const { ownerId } = await seedPeople(db);
    seedDataset(db, ownerId, "nm000874", {
      visibility: "private",
      anonymous: 0,
      firstPublishedAt: "2026-01-01 00:00:00",
    });
    const res = await publishRequest(db, "nm000874", OWNER_KEY, '{"anonymous":true}');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("already_published");
    db.close();
  });

  test("an anonymous deposit can still be published for real", async () => {
    // The whole point of the state, and it was unreachable: an anonymous
    // release sets `visibility = 'public'`, and the route refused every
    // request from a public dataset with "already published" -- including the
    // one the CLI tells the depositor to run to end their anonymity.
    const db = freshDb();
    const { ownerId } = await seedPeople(db);
    seedDataset(db, ownerId, "nm000875", { visibility: "public", anonymous: 1 });
    const res = await publishRequest(db, "nm000875", OWNER_KEY);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "requested", anonymous: false });
    db.close();
  });

  test("asking for anonymity twice is refused with a sentence, not queued", async () => {
    const db = freshDb();
    const { ownerId } = await seedPeople(db);
    seedDataset(db, ownerId, "nm000876", { visibility: "public", anonymous: 1 });
    const res = await publishRequest(db, "nm000876", OWNER_KEY, '{"anonymous":true}');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("already_released_anonymously");
    db.close();
  });

  test("re-requesting rewrites the recorded intent in both directions", async () => {
    // A blocked row is re-used rather than replaced, and an admin CAN approve
    // a blocked request (`runPublicationApproval` selects `status IN
    // ('requested','approving','blocked')`). So a stale flag on that row is
    // not inert: it decides which of the two runs an approval performs.
    //
    // Both directions matter and they fail differently. A stale 1 conceals a
    // depositor who asked for an ordinary publication -- recoverable. A stale
    // 0 publishes, under their own name, a depositor who asked to be
    // concealed -- not recoverable, and the reason the flow must never get
    // this wrong quietly.
    //
    // Driven through the UPDATE path, not the INSERT path the tests above
    // cover: the dataset's owner has no researcher name, so every request
    // blocks and the second one finds an existing row to rewrite.
    const db = freshDb();
    const { ownerId } = await seedPeople(db);
    db.query("UPDATE users SET given_name = NULL, family_name = NULL WHERE id = ?").run(ownerId);
    seedDataset(db, ownerId, "nm000878", { visibility: "private", anonymous: 0 });

    const recorded = () =>
      db
        .query<{ anonymous: number }, [string]>(
          "SELECT anonymous FROM publication_requests WHERE dataset_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get("nm000878")?.anonymous;

    expect((await publishRequest(db, "nm000878", OWNER_KEY)).status).toBe(422);
    expect(recorded()).toBe(0);

    expect((await publishRequest(db, "nm000878", OWNER_KEY, '{"anonymous":true}')).status).toBe(
      422,
    );
    expect(recorded()).toBe(1);

    // And back: a depositor who re-requests WITHOUT the flag is asking for an
    // ordinary publication, and the row must say so.
    expect((await publishRequest(db, "nm000878", OWNER_KEY)).status).toBe(422);
    expect(recorded()).toBe(0);

    // Exactly one row throughout: this is the re-use path, not three requests.
    expect(
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM publication_requests WHERE dataset_id = ?",
        )
        .get("nm000878")?.n,
    ).toBe(1);
    db.close();
  });

  test("an ordinary public dataset is still refused a second publication", async () => {
    // The control that keeps the fix above from being a hole: relaxing the
    // already-published guard for anonymous rows must not relax it for
    // everyone.
    const db = freshDb();
    const { ownerId } = await seedPeople(db);
    seedDataset(db, ownerId, "nm000877", { visibility: "public", anonymous: 0 });
    const res = await publishRequest(db, "nm000877", OWNER_KEY);
    expect(res.status).toBe(409);
    db.close();
  });

  // ==========================================================================
  // The fleet's standing anonymous deposit (#1423)
  //
  // `xx099907` is created anonymous and PRIVATE by
  // `POST /admin/datasets/exemplar`, and the anonymous release is the only
  // path that gives it the shape it is documented to have: `repo_public`
  // makes the catalog row public while the GitHub repository stays private,
  // and `create_tag` produces the version row and manifest the data plane
  // serves from. Two separate guards refused that request, each for a reason
  // that is true of a depositor's deposit and false of this one.
  // ==========================================================================

  test("the anonymous exemplar may request its anonymous release", async () => {
    const db = freshDb();
    const { ownerId } = await seedPeople(db);
    seedDataset(db, ownerId, "xx099907", {
      visibility: "private",
      anonymous: 1,
      isExemplar: 1,
    });

    const res = await publishRequest(db, "xx099907", OWNER_KEY, '{"anonymous":true}');

    // Queued for an admin, not refused. The two refusals this pins are
    // "Cannot publish sandbox datasets" (the xx block, whose exemplar
    // exemption used to drop out for an anonymous row) and
    // "already_released_anonymously" (which read `anonymous = 1` as proof a
    // release had happened, while this row sat private and unserved).
    // What "accepted" looks like here. The row has no GitHub repo, so the
    // request lands in `blocked` on the content check that reads
    // dataset_description.json -- and that is the proof: both guards under
    // test return BEFORE the request is created, with 400 and 409
    // respectively, so reaching a `blocked` publication request at all means
    // neither fired. The body carries the flag, so it was accepted AS an
    // anonymous release rather than coerced into a publication.
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      status?: string;
      anonymous?: boolean;
      error?: string;
      block_reason?: string;
    };
    expect(body.error).toBeUndefined();
    expect(body.status).toBe("blocked");
    expect(body.block_reason).toBe("min_requirements_failed");
    expect(body.anonymous).toBe(true);
    db.close();
  });

  test("but a PLAIN publish of it is still refused, which is what the guard is for", async () => {
    // The destructive direction: approving this would stamp
    // `first_published_at`, after which migration 0085's triggers refuse
    // `anonymous = 1` on the row forever. The fixture is destroyed rather
    // than dirtied, so the exemption must not extend to it.
    const db = freshDb();
    const { ownerId } = await seedPeople(db);
    seedDataset(db, ownerId, "xx099907", {
      visibility: "private",
      anonymous: 1,
      isExemplar: 1,
    });

    const res = await publishRequest(db, "xx099907", OWNER_KEY);

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "Cannot publish sandbox datasets",
    });
    db.close();
  });

  test("a non-exemplar xx dataset gets no such exemption", async () => {
    // The control. Without it, an exemption that ignored `is_exemplar`
    // entirely would pass the first test.
    const db = freshDb();
    const { ownerId } = await seedPeople(db);
    seedDataset(db, ownerId, "xx090001", {
      visibility: "private",
      anonymous: 1,
      isExemplar: 0,
    });

    const res = await publishRequest(db, "xx090001", OWNER_KEY, '{"anonymous":true}');

    expect(res.status).toBe(400);
    db.close();
  });

  test("an anonymous deposit that IS public is still told it was released", async () => {
    // The other control, and the behavior the narrowing must not break: for a
    // depositor, `anonymous` and `public` arrive together at the release, so
    // asking again really is a no-op and saying so beats queueing an admin.
    const db = freshDb();
    const { ownerId } = await seedPeople(db);
    seedDataset(db, ownerId, "nm000878", { visibility: "public", anonymous: 1 });

    const res = await publishRequest(db, "nm000878", OWNER_KEY, '{"anonymous":true}');

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "already_released_anonymously",
    });
    db.close();
  });
});

describe("the catalog withholds what it cannot make resolve", () => {
  const OWNER_KEY = "anon-cat-owner-0123456789abcdef0123456789abcd";

  async function seed(db: Database, anonymous: number): Promise<void> {
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                          service_access, sandbox_completed)
       VALUES ('cat-owner', 'cat-owner@example.org', 'x', 'approved', 'member', 1, 1, 1)`,
    );
    const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='cat-owner'").get();
    if (!u) throw new Error("seed: user insert failed");
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      u.id,
      await hashApiKey(OWNER_KEY),
      OWNER_KEY.slice(0, 8),
    );
    db.query(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                             github_repo, anonymous, concept_doi)
       VALUES ('nm000880', 'A sufficiently descriptive dataset title', ?, 'active', 'public', 0,
               'nemarDatasets/nm000880', ?, '10.82901/reserved-test')`,
    ).run(u.id, anonymous);
  }

  function detail(db: Database, key?: string): Promise<Response> {
    const a = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    a.route("/datasets", datasetRoutes);
    return a.request(
      "/datasets/nm000880",
      key ? { headers: { Authorization: `Bearer ${key}` } } : {},
      env(db),
    );
  }

  test("a stranger gets neither the private repository nor the reserved DOI", async () => {
    // Both were served raw by `SELECT d.*` while the data plane, in the SAME
    // response on the page bundle, withheld them. The repository is private,
    // so the URL 404s while disclosing that a repo exists under a predictable
    // name; the DOI is registered `reserved` at EZID, so it does not resolve
    // and must not be cited.
    const db = freshDb();
    await seed(db, 1);
    const body = (await (await detail(db)).json()) as {
      dataset: { github_repo: string | null; concept_doi: string | null; anonymous: number };
    };
    expect(body.dataset.github_repo).toBeNull();
    expect(body.dataset.concept_doi).toBeNull();
    // The state itself is NOT withheld: a reader who cannot tell "concealed"
    // from "incomplete" concludes the record is broken.
    expect(body.dataset.anonymous).toBe(1);
    db.close();
  });

  test("the owner keeps both, because they need them to end the anonymity", async () => {
    // Anonymity is toward the public, never toward the depositor (R5).
    // `nemar dataset clone`, `commit` and `push` all read `github_repo` from
    // this route, and those are the commands that restore attribution.
    const db = freshDb();
    await seed(db, 1);
    const body = (await (await detail(db, OWNER_KEY)).json()) as {
      dataset: { github_repo: string | null; concept_doi: string | null };
    };
    expect(body.dataset.github_repo).toBe("nemarDatasets/nm000880");
    expect(body.dataset.concept_doi).toBe("10.82901/reserved-test");
    db.close();
  });

  test("an ordinary public dataset serves both to everyone", async () => {
    // The control: without it, a projection that nulled these for every row
    // would satisfy the first test.
    const db = freshDb();
    await seed(db, 0);
    const body = (await (await detail(db)).json()) as {
      dataset: { github_repo: string | null; concept_doi: string | null };
    };
    expect(body.dataset.github_repo).toBe("nemarDatasets/nm000880");
    expect(body.dataset.concept_doi).toBe("10.82901/reserved-test");
    db.close();
  });
});

describe("the page bundle does not contradict itself", () => {
  test("catalog_row withholds exactly what external_links withholds", async () => {
    // One response carried `external_links.github_url: null` beside
    // `catalog_row.github_repo: "nemarDatasets/<id>"`, and served the reserved
    // DOI the other half withholds. A website reading either field got what
    // the other was protecting it from.
    const db = freshDb();
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('bundle-owner', 'bundle@example.org', 'x', 'approved', 'member', 1)`,
    );
    const u = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='bundle-owner'")
      .get();
    if (!u) throw new Error("seed failed");
    db.query(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                             github_repo, anonymous, concept_doi)
       VALUES ('nm000881', 'A sufficiently descriptive dataset title', ?, 'active', 'public', 0,
               'nemarDatasets/nm000881', 1, '10.82901/reserved-test')`,
    ).run(u.id);

    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.route("/", dataRoutes);
    const res = await app.request("/nm000881/page-bundle.json", {}, env(db));
    const bundle = (await res.json()) as {
      catalog_row: {
        ok: boolean;
        data?: { github_repo: string | null; concept_doi: string | null };
      };
      metadata: { ok: boolean; data?: { external_links: { github_url: string | null } } };
    };
    expect(bundle.catalog_row.ok).toBe(true);
    expect(bundle.catalog_row.data?.github_repo).toBeNull();
    expect(bundle.catalog_row.data?.concept_doi).toBeNull();
    // Asserted in the SAME response as the half that was already right, which
    // is the point: the two documents ship together.
    expect(bundle.metadata.data?.external_links.github_url).toBeNull();
    // `authors` needs no treatment here: its writer blinds it.
    db.close();
  });
});

describe("the list route withholds the same two identifiers", () => {
  // `GET /datasets` is the highest-traffic endpoint in the API and the one an
  // unauthenticated reader hits. `toListRow` takes the decision through a
  // `viewerMayKnowIdentifiers` argument with three different values at three
  // call sites; none of them had a test, so flipping the default served every
  // concealed deposit's private repository and reserved DOI to the world.
  const OWNER_KEY = "anon-list-owner-0123456789abcdef0123456789ab";
  const ADMIN_KEY = "anon-list-admin-0123456789abcdef0123456789ab";

  async function seedTwo(db: Database): Promise<void> {
    for (const [username, role, key] of [
      ["list-owner", "member", OWNER_KEY],
      ["list-admin", "admin", ADMIN_KEY],
    ] as const) {
      db.run(
        `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                            service_access, sandbox_completed)
         VALUES (?, ?, 'x', 'approved', ?, 1, 1, 1)`,
        [username, `${username}@example.org`, role],
      );
      const u = db
        .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
        .get(username);
      if (!u) throw new Error(`seed: ${username}`);
      db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
        u.id,
        await hashApiKey(key),
        key.slice(0, 8),
      );
    }
    const owner = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='list-owner'")
      .get();
    if (!owner) throw new Error("seed: owner");
    for (const [id, anonymous] of [
      ["nm000885", 1],
      ["nm000886", 0],
    ] as const) {
      db.query(
        `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                               github_repo, anonymous, concept_doi)
         VALUES (?, 'A sufficiently descriptive dataset title', ?, 'active', 'public', 0, ?, ?, ?)`,
      ).run(id, owner.id, `nemarDatasets/${id}`, anonymous, "10.82901/reserved-test");
    }
  }

  async function list(
    db: Database,
    query: string,
    key?: string,
  ): Promise<Record<string, Record<string, unknown>>> {
    const a = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    a.route("/datasets", datasetRoutes);
    const res = await a.request(
      `/datasets${query}`,
      key ? { headers: { Authorization: `Bearer ${key}` } } : {},
      env(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { datasets: Record<string, unknown>[] };
    return Object.fromEntries(body.datasets.map((d) => [String(d.dataset_id), d]));
  }

  test("an unauthenticated reader gets neither, and the control row keeps both", async () => {
    const db = freshDb();
    await seedTwo(db);
    const rows = await list(db, "");
    expect(rows.nm000885.github_repo).toBeNull();
    expect(rows.nm000885.concept_doi).toBeNull();
    expect(rows.nm000885.doi).toBeNull();
    // The state itself is still reported, so a consumer can render "withheld"
    // rather than "missing".
    expect(rows.nm000885.anonymous).toBe(1);
    // The control. Without it a projection that nulled these columns for every
    // row would satisfy the assertions above.
    expect(rows.nm000886.github_repo).toBe("nemarDatasets/nm000886");
    expect(rows.nm000886.concept_doi).toBe("10.82901/reserved-test");
    db.close();
  });

  test("the owner's own listing keeps them", async () => {
    // `?mine` is scoped to the caller's rows, and the depositor needs
    // `github_repo` for the commit that ends the anonymity.
    const db = freshDb();
    await seedTwo(db);
    const rows = await list(db, "?mine=true", OWNER_KEY);
    expect(rows.nm000885.github_repo).toBe("nemarDatasets/nm000885");
    db.close();
  });

  test("an admin keeps them on the public list", async () => {
    const db = freshDb();
    await seedTwo(db);
    const rows = await list(db, "", ADMIN_KEY);
    expect(rows.nm000885.github_repo).toBe("nemarDatasets/nm000885");
    expect(rows.nm000885.concept_doi).toBe("10.82901/reserved-test");
    db.close();
  });

  test("the PUBLIC list withholds even from the owner, and that is deliberate", async () => {
    // Being signed in is not being entitled. The public list is one query for
    // everybody, so it takes the conservative answer for every caller who is
    // not an admin; an owner who wants their own identifiers asks for them
    // where the query is scoped to them (`?mine=true`, above) or where the row
    // is theirs by construction (`GET /datasets/:id`). Pinned because the
    // alternative -- widening this branch to "owner sees their own" -- would
    // mean joining owner identity into the public catalog query, which is the
    // shape of the `?owner=` oracle this feature already had to close.
    const db = freshDb();
    await seedTwo(db);
    const rows = await list(db, "", OWNER_KEY);
    expect(rows.nm000885.github_repo).toBeNull();
    expect(rows.nm000886.github_repo).toBe("nemarDatasets/nm000886");
    db.close();
  });
});

describe("the owner filter is not a confirmation oracle", () => {
  // `?owner=<username>` matches on the real username in a WHERE clause that no
  // projection can reach, so withholding the column is not enough: a hit
  // confirms that this person deposited this dataset. Usernames are public on
  // every non-anonymous dataset, so guessing one is free.
  const ALICE_KEY = "anon-alice-key-0123456789abcdef0123456789abcd";
  const BOB_KEY = "anon-bob-key-0123456789abcdef0123456789abcdef";
  const ADMIN_KEY = "anon-oracle-admin-0123456789abcdef0123456789";

  async function seedOracle(db: Database): Promise<void> {
    for (const [username, role, key] of [
      ["alice", "member", ALICE_KEY],
      ["bob", "member", BOB_KEY],
      ["oracle-admin", "admin", ADMIN_KEY],
    ] as const) {
      db.run(
        `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                            service_access, sandbox_completed)
         VALUES (?, ?, 'x', 'approved', ?, 1, 1, 1)`,
        [username, `${username}@example.org`, role],
      );
      const u = db
        .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
        .get(username);
      if (!u) throw new Error(`seed: ${username}`);
      db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
        u.id,
        await hashApiKey(key),
        key.slice(0, 8),
      );
    }
    const alice = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='alice'").get();
    if (!alice) throw new Error("seed: alice");
    for (const [id, anonymous] of [
      ["nm000887", 1],
      ["nm000888", 0],
    ] as const) {
      db.query(
        `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                               github_repo, anonymous)
         VALUES (?, 'A sufficiently descriptive dataset title', ?, 'active', 'public', 0, ?, ?)`,
      ).run(id, alice.id, `nemarDatasets/${id}`, anonymous);
    }
  }

  async function byOwner(db: Database, key?: string): Promise<string[]> {
    const a = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    a.route("/datasets", datasetRoutes);
    const res = await a.request(
      "/datasets?owner=alice",
      key ? { headers: { Authorization: `Bearer ${key}` } } : {},
      env(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { datasets: { dataset_id: string }[] };
    return body.datasets.map((d) => d.dataset_id);
  }

  test("a stranger asking for alice's datasets is not told about the concealed one", async () => {
    const db = freshDb();
    await seedOracle(db);
    const ids = await byOwner(db);
    expect(ids).not.toContain("nm000887");
    // The control, and it is the whole point: the filter still WORKS. A
    // predicate that returned nothing at all would satisfy the line above.
    expect(ids).toContain("nm000888");
    db.close();
  });

  test("another signed-in user gets the same answer", async () => {
    const db = freshDb();
    await seedOracle(db);
    expect(await byOwner(db, BOB_KEY)).not.toContain("nm000887");
    db.close();
  });

  test("alice sees her own, and so does an admin", async () => {
    const db = freshDb();
    await seedOracle(db);
    expect(await byOwner(db, ALICE_KEY)).toContain("nm000887");
    expect(await byOwner(db, ADMIN_KEY)).toContain("nm000887");
    db.close();
  });
});
