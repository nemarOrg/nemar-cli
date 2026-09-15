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
import { evaluateSubmissionMinimums } from "../src/services/submission-minimums";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

function seed(db: Database, id: string, anonymous: number): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility,
                           is_sandbox, github_repo, anonymous)
     VALUES (?, ?, 1, 'active', 'public', 0, ?, ?)`,
  ).run(id, id, `nemarDatasets/${id}`, anonymous);
}

function env(db: Database): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
}

async function githubUrlOf(db: Database, id: string): Promise<string | null> {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/", dataRoutes);
  const res = await app.request(`/${id}/metadata.json`, {}, env(db));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { external_links: { github_url: string | null } };
  return body.external_links.github_url;
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
    expect(await githubUrlOf(db, "nm000860")).toBeNull();
    db.close();
  });

  test("an ordinary dataset still serves it, which is what makes the test above mean something", async () => {
    // The control. `github_repo` is identical on both rows, so the only
    // difference is the flag; without this, a builder that returned null for
    // everything would satisfy the assertion above.
    const db = freshDb();
    seed(db, "nm000861", 0);
    expect(await githubUrlOf(db, "nm000861")).toBe("https://github.com/nemarDatasets/nm000861");
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

  test("the two rules are exact complements over the same input", () => {
    // Stated as a property rather than three more cases: for any Authors
    // field, exactly one of the two submissions accepts it. That is what makes
    // "blind to release, restore to publish" an ordering rather than advice.
    for (const authors of [["Anonymous"], ["Ada Lovelace"], ["N/A"], ["[Unspecified1]"]]) {
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
