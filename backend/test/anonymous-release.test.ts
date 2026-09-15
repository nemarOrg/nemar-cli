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
    },
  ): void {
    db.query(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                             github_repo, anonymous, concept_doi, first_published_at)
       VALUES (?, ?, ?, 'active', ?, 0, ?, ?, ?, ?)`,
    ).run(
      id,
      `A sufficiently descriptive title for ${id}`,
      ownerId,
      fields.visibility,
      fields.githubRepo ?? null,
      fields.anonymous,
      fields.conceptDoi ?? null,
      fields.firstPublishedAt ?? null,
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
