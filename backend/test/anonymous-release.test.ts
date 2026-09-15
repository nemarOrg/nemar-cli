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

describe("the author gate is exempted for a release and enforced for a publication", () => {
  const BLINDED = JSON.stringify({
    Name: "A sufficiently descriptive dataset title",
    Authors: ["Anonymous"],
    EthicsApprovals: ["Approved by an institutional review board"],
  });
  const ATTRIBUTED = JSON.stringify({
    Name: "A sufficiently descriptive dataset title",
    Authors: ["Ada Lovelace"],
    EthicsApprovals: ["Approved by an institutional review board"],
  });
  const EMPTY_AUTHORS = JSON.stringify({
    Name: "A sufficiently descriptive dataset title",
    Authors: [],
    EthicsApprovals: ["Approved by an institutional review board"],
  });

  test("a blinded deposit passes an anonymous release", () => {
    // Placeholder Authors are the intended state here: being blinded is what
    // that field is reporting.
    expect(evaluateSubmissionMinimums(BLINDED, null, { allowPlaceholderAuthors: true })).toEqual(
      [],
    );
  });

  test("the same deposit is refused a real publication", () => {
    // This is the interlock. One gate, two jobs: a depositor cannot publish
    // for real while still concealed, and the refusal names the fix.
    const reasons = evaluateSubmissionMinimums(BLINDED, null);
    expect(reasons.length).toBe(1);
    expect(reasons[0]).toMatch(/must name the people responsible/);
  });

  test("restoring the real authors is what unblocks the publication", () => {
    expect(evaluateSubmissionMinimums(ATTRIBUTED, null)).toEqual([]);
  });

  test("the exemption accepts a placeholder, never an empty field", () => {
    // An empty Authors array is an incomplete file, not a blinded one, and
    // accepting it would let the exemption swallow a real defect.
    const reasons = evaluateSubmissionMinimums(EMPTY_AUTHORS, null, {
      allowPlaceholderAuthors: true,
    });
    expect(reasons.length).toBe(1);
    expect(reasons[0]).toMatch(/must not be empty/);
  });

  test("the exemption is narrow: every other minimum still applies", () => {
    // A blinded deposit must still have a descriptive Name and an ethics
    // statement. If the exemption widened to "skip the checks", this passes.
    const shortNameNoEthics = JSON.stringify({ Name: "EEG", Authors: ["Anonymous"] });
    const reasons = evaluateSubmissionMinimums(shortNameNoEthics, null, {
      allowPlaceholderAuthors: true,
    });
    expect(reasons.length).toBe(2);
    expect(reasons.join(" ")).toMatch(/descriptive title/);
    expect(reasons.join(" ")).toMatch(/ethics approval statement/i);
  });
});
