/**
 * The statements of ADR 0119 that review of phase #2016 corrected or added, held where they are
 * said (the ADR, and its one-paragraph copy in the decisions index), so a later edit cannot put the
 * old claim back:
 *
 *   - a client that is not first-party NEVER SKIPS the consent screen and follows its consent mode;
 *     it is not one that "always shows" it;
 *   - first-party is its own rule (https on nemar.org, default port, no partner host, loopback and
 *     website previews only outside production), not the cross-origin one;
 *   - client secrets have a prefix, and signing keys have a revoked state;
 *   - the staging issuer is decided (each Worker's issuer is its own API_BASE_URL), so it is no
 *     longer in the not-decided list;
 *   - changing OIDC_SECRET after the first rotation is named as a consequence.
 *
 * Real files, no mocks.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DECISIONS = join(import.meta.dir, "../.context/decisions");
const ADR_FILE = readdirSync(DECISIONS).find((f) => f.startsWith("0119-")) as string;
const adr = readFileSync(join(DECISIONS, ADR_FILE), "utf-8");
const readme = readFileSync(join(DECISIONS, "README.md"), "utf-8");
const readmeLine = readme.split("\n").find((l) => l.includes("[ADR 0119]")) as string;

/** The text of one numbered rule of the Decision section, up to the next rule. */
function rule(n: number): string {
  const start = adr.indexOf(`\n${n}. **`);
  const next = adr.indexOf(`\n${n + 1}. **`, start + 1);
  const end = next === -1 ? adr.indexOf("\n### ", start) : next;
  return adr.slice(start, end);
}

describe("ADR 0119 says what a third-party client is", () => {
  test("the files exist and the helpers see the rules", () => {
    expect(ADR_FILE).toBeDefined();
    expect(readmeLine.length).toBeGreaterThan(100);
    expect(rule(8)).toContain("Clients are registered by the owner");
    expect(rule(2)).toContain("The issuer is");
  });

  test("it never skips consent and follows its consent mode; it does not 'always show' it", () => {
    const eight = rule(8);
    expect(eight).toMatch(/never skips the consent screen/);
    expect(eight).toMatch(/consent mode/);
    for (const text of [adr, readmeLine]) {
      expect(text).not.toMatch(/always shows? (the )?consent/i);
    }
    expect(readmeLine).toMatch(/never skips consent/);
  });

  test("first-party is its own rule, and the ADR names its parts", () => {
    const eight = rule(8);
    expect(eight).toMatch(/first-party origin/);
    expect(eight).toMatch(/default port/);
    expect(eight).toMatch(/loopback/);
    expect(eight).toMatch(/website preview/);
    expect(eight).toMatch(/not the cross-origin rule/);
    expect(readmeLine).toMatch(/default port/);
    // The index does not read as if "any other host" included NEMAR's own.
    expect(readmeLine).not.toMatch(/any other host makes it third-party/);
  });
});

describe("ADR 0119 records the key and secret decisions", () => {
  test("a client secret has the prefix nmo_cs_, in the ADR and in its index line", () => {
    expect(rule(4)).toContain("nmo_cs_");
    expect(readmeLine).toContain("nmo_cs_");
  });

  test("signing keys have a revoked state, and a rotation proves the key it promotes can be read", () => {
    const two = rule(2);
    expect(two).toMatch(/`revoked`/);
    expect(two).toMatch(/decrypt/);
    expect(two).toContain("OIDC_SECRET");
  });

  test("each Worker's issuer is its own API_BASE_URL, and the staging one is named", () => {
    const two = rule(2);
    expect(two).toContain("API_BASE_URL");
    expect(two).toContain("https://api-test.nemar.org");
    expect(two).toMatch(/answers 404/);
  });

  test("the staging issuer is no longer undecided, in the ADR or its index line", () => {
    const notDecided = adr.slice(
      adr.indexOf("### Not decided here"),
      adr.indexOf("## Consequences"),
    );
    expect(notDecided.length).toBeGreaterThan(100);
    expect(notDecided).not.toMatch(/staging/i);
    expect(readmeLine).not.toMatch(/the staging issuer/);
  });

  test("changing OIDC_SECRET after the first rotation is a named consequence", () => {
    const consequences = adr.slice(adr.indexOf("## Consequences"), adr.indexOf("## Alternatives"));
    expect(consequences).toContain("OIDC_SECRET");
    expect(consequences).toMatch(/every stored key unreadable/);
    expect(consequences).toMatch(/#2020/);
  });
});
