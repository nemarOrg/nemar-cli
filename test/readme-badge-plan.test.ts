/**
 * Unit tests for planReadmeBadgeCommit — the pure decision function
 * extracted from the publication orchestrator's update_readme step.
 *
 * The helper decides whether a GitHub commit is needed to bring README.md
 * into the canonical "DOI badge at top, named README.md" state. Skipping
 * the commit is a real correctness call: it avoids stacking no-op
 * "Add DOI badge" commits across --resume runs that each re-trigger CI.
 */

import { describe, expect, test } from "bun:test";
import { planReadmeBadgeCommit } from "../backend/src/services/doi";

const CONCEPT_DOI = "10.82901/nemar.nm000122";
const BADGE = `[![DOI](https://img.shields.io/badge/DOI-${encodeURIComponent(CONCEPT_DOI)}-blue)](https://doi.org/${CONCEPT_DOI})`;

describe("planReadmeBadgeCommit", () => {
  test("skips commit when README.md already has current-DOI badge", () => {
    const plan = planReadmeBadgeCommit({
      readmeContent: `${BADGE}\n\n# My Dataset\n`,
      doiBadge: BADGE,
      conceptDoi: CONCEPT_DOI,
      contentSourcePath: "README.md",
    });
    expect(plan.commit).toBe(false);
  });

  test("commits when README has a stale badge pointing at a different DOI", () => {
    // Silent-failure guard: a previous publish (re-registered DOI or
    // provider migration) could have left a stale badge. The helper must
    // detect the mismatch and rewrite, not silently skip.
    const stale = `[![DOI](https://img.shields.io/badge/DOI-10.5072%2FFK2.OLD-blue)](https://doi.org/10.5072/FK2.OLD)\n\n# My Dataset\n`;
    const plan = planReadmeBadgeCommit({
      readmeContent: stale,
      doiBadge: BADGE,
      conceptDoi: CONCEPT_DOI,
      contentSourcePath: "README.md",
    });
    expect(plan.commit).toBe(true);
    if (!plan.commit) throw new Error("unreachable");
    expect(plan.content).toContain(BADGE);
    expect(plan.message).toMatch(/Replace stale DOI badge/i);
  });

  test("commits when no README exists at all", () => {
    const plan = planReadmeBadgeCommit({
      readmeContent: "",
      doiBadge: BADGE,
      conceptDoi: CONCEPT_DOI,
      contentSourcePath: undefined,
    });
    expect(plan.commit).toBe(true);
    if (!plan.commit) throw new Error("unreachable");
    expect(plan.content).toBe(`${BADGE}\n\n`);
    expect(plan.message).toBe(`Add DOI badge: ${CONCEPT_DOI}`);
  });

  test("commits a rename when source is README.rst even if badge content matches", () => {
    // README.rst with the correct badge text still needs to be migrated to
    // README.md so GitHub renders it. The "skip when content correct" path
    // must not absorb the rename case.
    const plan = planReadmeBadgeCommit({
      readmeContent: `${BADGE}\n\n# My Dataset\n`,
      doiBadge: BADGE,
      conceptDoi: CONCEPT_DOI,
      contentSourcePath: "README.rst",
    });
    expect(plan.commit).toBe(true);
    if (!plan.commit) throw new Error("unreachable");
    expect(plan.message).toMatch(/Rename README\.rst to README\.md/);
  });

  test("treats URL-encoded DOI in badge as a match (current encoding)", () => {
    // The badge URL encodes the DOI with encodeURIComponent. The match
    // check must succeed against that form as well as the raw form.
    const encoded = encodeURIComponent(CONCEPT_DOI);
    const readmeWithEncodedOnly = `[![DOI](https://img.shields.io/badge/DOI-${encoded}-blue)](https://example.test)\n# X\n`;
    const plan = planReadmeBadgeCommit({
      readmeContent: readmeWithEncodedOnly,
      doiBadge: BADGE,
      conceptDoi: CONCEPT_DOI,
      contentSourcePath: "README.md",
    });
    expect(plan.commit).toBe(false);
  });

  test("rewrites when an unrelated badge shape is present but no DOI match", () => {
    // Zenodo-shaped badge with a different concept DOI ID.
    const stale = `[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.1234567.svg)](https://doi.org/10.5281/zenodo.1234567)\n# X\n`;
    const plan = planReadmeBadgeCommit({
      readmeContent: stale,
      doiBadge: BADGE,
      conceptDoi: CONCEPT_DOI,
      contentSourcePath: "README.md",
    });
    expect(plan.commit).toBe(true);
  });
});
