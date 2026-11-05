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
import {
  OIDC_END_REASONS,
  OIDC_LOGOUT_ERROR_CLASSES,
  OIDC_LOGOUT_RETRY_DELAYS_SECONDS,
} from "../shared/oidc";

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
    // Losing the secret leaves no way back through the CLI, and the ADR says what recovery is.
    expect(consequences).toMatch(/no CLI way back/);
    expect(consequences).toContain("key_unreadable");
    expect(consequences).toMatch(/removing the unreadable key rows by hand/);
  });
});

describe("ADR 0119 records what the token phase settled (#2018)", () => {
  test("rule 13: replay, rotation, the retry, the expiries and client authentication", () => {
    const thirteen = rule(13);
    expect(thirteen).toContain("`code_replay`");
    expect(thirteen).toContain("`refresh_reuse`");
    expect(thirteen).toMatch(/one more child, never two/);
    expect(thirteen).toMatch(/30 days after it was minted/);
    expect(thirteen).toMatch(/90 days after the code was redeemed/);
    expect(thirteen).toMatch(/code's scopes, never the grant's/);
    expect(thirteen).toMatch(/HTTP Basic only/);
    expect(thirteen).toMatch(/machine-only scopes/);
    // Round 1: the retry's children are mutually exclusive, and a used code revokes only after its
    // verifier and redirect address match.
    expect(thirteen).toContain("`refresh_superseded`");
    expect(thirteen).toMatch(/mutually exclusive/);
    expect(thirteen).toMatch(/with the right verifier and redirect address/);
    expect(thirteen).not.toMatch(/both children stay live/);
    expect(thirteen).not.toMatch(/whatever verifier or redirect address/);
    expect(readmeLine).toContain("refresh_superseded");
    // Round 2: the retry needs the first child untouched, and a late retry is reuse.
    expect(thirteen).toMatch(/itself untouched, neither rotated nor revoked/);
    expect(thirteen).toMatch(/whatever the order the two holders acted in/);
    expect(thirteen).toMatch(/access tokens stay valid for up to their 15 minutes/);
  });

  test("rule 14 and the consequences: read-only maintenance, faults, the table's growth", () => {
    const fourteen = rule(14);
    expect(fourteen).toMatch(/`POST \/oauth\/userinfo` and `POST \/oauth\/introspect` are served/);
    expect(fourteen).toMatch(/never `invalid_token`, `invalid_grant` or `\{active: false\}`/);
    const consequences = adr.slice(adr.indexOf("## Consequences"), adr.indexOf("## Alternatives"));
    expect(consequences).toMatch(/In read-only maintenance no partner can refresh/);
    expect(consequences).toMatch(/What to watch once a partner is live/);
    expect(consequences).toMatch(/minimum interval between two rotations/);
    expect(consequences).toMatch(/A fault is never a verdict/);
    expect(consequences).toMatch(/The prune shares the batch that mints/);
    expect(fourteen).toMatch(/POST only/);
  });

  test("rule 14: the claim names, the refusal elsewhere and introspection's blindness", () => {
    const fourteen = rule(14);
    for (const claim of ["nemar_kind", "nemar_status", "nemar_tier"]) {
      expect(fourteen).toContain(claim);
      expect(readmeLine).toContain(claim);
    }
    expect(fourteen).toContain("oidc_token_not_accepted");
    expect(fourteen).toMatch(/`oidcBearer` is the one middleware/);
    expect(fourteen).toMatch(/shown to its own client only/);
    expect(readmeLine).toContain("oidc_token_not_accepted");
    expect(adr).toMatch(/Fifteen rules inside that/);
  });
});

describe("ADR 0119 records what the revocation phase settled (#2019)", () => {
  test("rule 12: the cascade is one function, its order, its callers, its filters and the client's disabling", () => {
    const twelve = rule(12);
    expect(twelve).toContain("`oidcEndStatements`");
    expect(twelve).toContain("`OIDC_END_CALLERS`");
    expect(twelve).toMatch(/BEFORE they are revoked/);
    expect(twelve).toMatch(/A used code stays/);
    expect(twelve).toMatch(/a later sign-in is a NEW grant/);
    expect(twelve).toMatch(/`oidc_clients.id` row, never the public `oc_` string/);
    expect(twelve).toMatch(/what it selects is GRANTS/);
    expect(twelve).toContain("`{scopePrefix}`");
    expect(twelve).toMatch(/no caller yet, because its state does not exist/);
    expect(twelve).toContain("`oidcClientEndStatements`");
    expect(twelve).toMatch(/does not revoke the account/);
    expect(readmeLine).toContain("oidcEndStatements");
    expect(readmeLine).toContain("OIDC_END_CALLERS");
    expect(readmeLine).toContain("nemar admin oidc end-account");
  });

  test("every end reason and every delivery error class the code has is named in the ADR", () => {
    for (const word of [...OIDC_END_REASONS, ...OIDC_LOGOUT_ERROR_CLASSES]) {
      expect(adr, word).toContain(`\`${word}\``);
    }
  });

  test("rule 15: the intent is a row, the call is afterwards, the token and the request are exact", () => {
    const fifteen = rule(15);
    expect(fifteen).toMatch(/never touches the network/);
    expect(fifteen).toMatch(/`waitUntil` right after the commit/);
    expect(fifteen).toMatch(/every 30 minutes, in production only/);
    expect(fifteen).toMatch(/at most 20 deliveries a tick/);
    expect(fifteen).toContain("`typ: logout+jwt`");
    expect(fifteen).toMatch(/two minutes later/);
    expect(fifteen).toMatch(/no `nonce`/);
    expect(fifteen).toMatch(/no `sid`/);
    expect(fifteen).toMatch(/new for every attempt/);
    expect(fifteen).toMatch(/no `Authorization`, no cookie, no client secret, no API key/);
    expect(fifteen).toMatch(
      /waits 5 seconds, never follows a redirect, and never reads the answer's body/,
    );
    expect(fifteen).toMatch(/`200` or `204` is `sent`/);
    expect(fifteen).toMatch(/the first attempt and five retries/);
    expect(fifteen).toMatch(/The wait is the EARLIEST time/);
    expect(fifteen).toMatch(/claimed before it is made/);
  });

  test("rule 15: the retry schedule in the ADR is the one in the code", () => {
    const words = (s: number): string =>
      s < 3600
        ? `${s / 60} minute${s === 60 ? "" : "s"}`
        : `${s / 3600} hour${s === 3600 ? "" : "s"}`;
    const delays = OIDC_LOGOUT_RETRY_DELAYS_SECONDS.map(words);
    const spelled = `${delays.slice(0, -1).join(", ")} and ${delays.at(-1)}`;
    expect(rule(15)).toContain(spelled);
  });

  test("rule 15: the fence is exact, fails closed, and the var is the owner's", () => {
    const fifteen = rule(15);
    expect(fifteen).toMatch(/checked again at send time and not only at registration/);
    expect(fifteen).toMatch(/`ENVIRONMENT` exactly `production`/);
    expect(fifteen).toMatch(/an unset or mistyped value included/);
    expect(fifteen).toContain("`OIDC_LOGOUT_DEV_HOSTS`");
    expect(fifteen).toMatch(/does not admit its subdomains/);
    expect(fifteen).toMatch(/fails closed the other way from `isNonProductionEnv`/);
    expect(fifteen).toMatch(/absent from `wrangler-sccn.toml`, is ignored in production/);
    expect(fifteen).toMatch(/does not resolve a name itself/);
    expect(readmeLine).toContain("OIDC_LOGOUT_DEV_HOSTS");
  });

  test("the consequences and the not-decided list say what a logout cannot promise", () => {
    const consequences = adr.slice(adr.indexOf("## Consequences"), adr.indexOf("## Alternatives"));
    expect(consequences).toMatch(/A logout is a best effort, and the revocation is not/);
    expect(consequences).toMatch(/Outside production nothing retries/);
    const notDecided = adr.slice(
      adr.indexOf("### Not decided here"),
      adr.indexOf("## Consequences"),
    );
    expect(notDecided).toMatch(/`408` or a `429`/);
    expect(notDecided).toMatch(/How long a delivery row is kept/);
    expect(notDecided).toMatch(/`sid` claim/);
  });
});
