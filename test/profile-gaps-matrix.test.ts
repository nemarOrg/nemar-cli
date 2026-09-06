/**
 * The shared profile-gap matrix, pinned field by field (#1268, ADR 0045).
 *
 * Two things are being held still here, and they fail for different reasons.
 *
 * 1. THE TABLE. `WEBSITE_TABLE` below is transcribed from
 *    `nemarOrg/website`'s `src/lib/profile-gaps.ts` + `account-copy.ts` as
 *    they shipped in website#310 — what each field blocks, the prose that
 *    fits "Set it in ___", and the exact command. If `PROFILE_GAP_MATRIX`
 *    stops agreeing with it, one of the two repos has moved and the other has
 *    not, which is the whole failure mode phase 8 exists to prevent. This is
 *    the local half of that guard; `account-copy-parity.test.ts` is the half
 *    that reads the other checkout when it is present.
 *
 * 2. THE DERIVATION, over every one of the 2^7 combinations of the seven
 *    derivable fields. The oracle is built by FILTERING the fixture table
 *    rather than by re-running the production rules, so the test can disagree
 *    with the implementation: it says "these fields are blank, therefore these
 *    entries in this order", and `computeProfileGaps` has to arrive at the same
 *    answer from the row.
 *
 * No mocks: `computeProfileGaps` is pure and is called directly.
 */

import { describe, expect, test } from "bun:test";
import { ACCOUNT_COPY } from "../shared/contract/account-copy.js";
import {
  DERIVABLE_GAP_FIELDS,
  GAP_FIELDS,
  type GapField,
  PROFILE_GAP_MATRIX,
  type ProfileGapAccount,
  computeProfileGaps,
  describeProfileGap,
  describeProfileGapBlocks,
  describeSandboxGap,
  profileGapFields,
  resolveProfileGap,
  resolveWireProfileGaps,
} from "../shared/contract/profile-gaps.js";

interface TableRow {
  blocks: string[];
  /** Prose that fits "Set it in ___". */
  web: string;
  /** The exact command, or null when none sets it. */
  cli: string | null;
  /** Where a verified ORCID iD moves the web half. */
  orcidWeb?: string;
  label: string;
  derivable: boolean;
}

/** Transcribed from nemarOrg/website `src/lib/profile-gaps.ts` (website#310). */
const WEBSITE_TABLE: Record<string, TableRow> = {
  email_verified: {
    blocks: ["verified", "upload_access"],
    web: "the verify step on your dashboard",
    cli: "nemar auth resend-verification",
    label: "A verified email address",
    derivable: true,
  },
  username: {
    blocks: ["upload_access"],
    web: "Settings",
    cli: "nemar auth profile set-username",
    label: "Username",
    derivable: true,
  },
  given_name: {
    blocks: ["upload_access", "publication"],
    web: "Settings",
    cli: "nemar auth profile set-name",
    orcidWeb: "your ORCID record at orcid.org, then sign in again",
    label: "Given name",
    derivable: true,
  },
  family_name: {
    blocks: ["upload_access", "publication"],
    web: "Settings",
    cli: "nemar auth profile set-name",
    orcidWeb: "your ORCID record at orcid.org, then sign in again",
    label: "Family name",
    derivable: true,
  },
  github_username: {
    blocks: ["upload_access", "publication"],
    web: "Settings",
    cli: "nemar auth profile set-github",
    label: "GitHub handle",
    derivable: true,
  },
  city: {
    blocks: ["upload_access"],
    web: "Settings",
    cli: "nemar auth profile set-location",
    label: "City",
    derivable: true,
  },
  country: {
    blocks: ["upload_access"],
    web: "Settings",
    cli: "nemar auth profile set-location",
    label: "Country",
    derivable: true,
  },
  why: {
    blocks: ["upload_access"],
    web: "the request form in Settings",
    cli: "nemar auth request-upload-access",
    label: "A description of what you intend to upload",
    derivable: false,
  },
};

const TABLE_FIELDS = Object.keys(WEBSITE_TABLE);
/** The seven the derivation can raise from a row; `why` needs a submitted form. */
const DERIVABLE = TABLE_FIELDS.filter((f) => WEBSITE_TABLE[f].derivable) as GapField[];

/** A complete account: nothing missing, nothing to report. */
function fullAccount(): Required<Omit<ProfileGapAccount, "status">> & { status: string } {
  return {
    status: "verified",
    email_verified: true,
    username: "alovelace",
    given_name: "Ada",
    family_name: "Lovelace",
    github_username: "adalovelace",
    city: "London",
    country: "GB",
    orcid_verified: false,
  };
}

/** Blank out `fields` on an otherwise complete account. */
function accountMissing(fields: readonly string[]): ProfileGapAccount {
  const account: Record<string, unknown> = fullAccount();
  for (const field of fields) {
    account[field] = field === "email_verified" ? false : null;
  }
  return account as ProfileGapAccount;
}

describe("the matrix agrees with the website's table", () => {
  test("every field, and only those fields, in the same order", () => {
    expect([...GAP_FIELDS]).toEqual(TABLE_FIELDS);
    expect([...DERIVABLE_GAP_FIELDS]).toEqual(DERIVABLE);
  });

  for (const field of TABLE_FIELDS) {
    const row = WEBSITE_TABLE[field];
    test(`${field}: blocks, label and both set-on halves`, () => {
      expect([...PROFILE_GAP_MATRIX[field as GapField].blocks]).toEqual(row.blocks);
      const gap = resolveProfileGap(field);
      expect(gap.label).toBe(row.label);
      expect(gap.setOnWeb).toBe(row.web);
      expect(gap.setOnCli).toBe(row.cli);
      expect(gap.known).toBe(true);
    });

    test(`${field}: a verified ORCID iD moves the name halves and nothing else`, () => {
      const gap = resolveProfileGap(field, { orcidVerified: true });
      if (row.orcidWeb) {
        // The record owns the name, `PATCH /auth/profile` refuses the edit, and
        // so there is no command either.
        expect(gap.setOnWeb).toBe(row.orcidWeb);
        expect(gap.setOnCli).toBeNull();
      } else {
        expect(gap.setOnWeb).toBe(row.web);
        expect(gap.setOnCli).toBe(row.cli);
      }
    });
  }
});

describe("computeProfileGaps over every field combination", () => {
  // 2^7 = 128 subsets of the derivable fields.
  const subsets: string[][] = [];
  for (let mask = 0; mask < 1 << DERIVABLE.length; mask++) {
    subsets.push(DERIVABLE.filter((_, i) => (mask & (1 << i)) !== 0));
  }

  test("raises exactly the blank fields, in table order, for all 128", () => {
    expect(subsets).toHaveLength(128);
    for (const missing of subsets) {
      // The oracle: the fixture's own order, filtered to what was blanked.
      const expected = TABLE_FIELDS.filter((f) => missing.includes(f));
      const gaps = computeProfileGaps(accountMissing(missing));
      expect(gaps.map((g) => g.field)).toEqual(expected);
      for (const gap of gaps) {
        expect([...gap.blocks]).toEqual(WEBSITE_TABLE[gap.field].blocks);
        expect([...gap.set_on]).toEqual(WEBSITE_TABLE[gap.field].cli ? ["web", "cli"] : ["web"]);
      }
    }
  });

  test("`why` is never raised from a row, however empty the row is", () => {
    // Nothing is stored until the form is submitted, so no account can be
    // missing it -- it exists in the table only for a refusal to render.
    expect(profileGapFields(accountMissing(DERIVABLE))).not.toContain("why");
  });

  test("ORCID is never a gap, linked or not", () => {
    for (const orcid_verified of [true, false]) {
      const fields = profileGapFields({ ...accountMissing(DERIVABLE), orcid_verified });
      expect(fields).not.toContain("orcid");
    }
  });

  test("a verified iD moves set_on to web-only for the name halves", () => {
    const gaps = computeProfileGaps({
      ...accountMissing(["given_name", "family_name", "city"]),
      orcid_verified: true,
    });
    const setOn = Object.fromEntries(gaps.map((g) => [g.field, [...g.set_on]]));
    expect(setOn.given_name).toEqual(["web"]);
    expect(setOn.family_name).toEqual(["web"]);
    // The export-control fields are unaffected: ORCID owns a name, not a city.
    expect(setOn.city).toEqual(["web", "cli"]);
  });

  test("whitespace counts as absent", () => {
    // A row holding " " has no city, matching resolveUploaderIdentity's trim.
    expect(profileGapFields({ ...fullAccount(), city: "   " })).toEqual(["city"]);
  });

  test("`status: pending` raises the inbox even when the flag says otherwise", () => {
    expect(profileGapFields({ ...fullAccount(), status: "pending" })).toEqual(["email_verified"]);
  });

  test("an unknown email_verified on an active account is not an unproved inbox", () => {
    // A caller that does not report the flag must not make everyone re-verify.
    expect(profileGapFields({ ...fullAccount(), email_verified: undefined })).toEqual([]);
  });

  test("an unreadable username is not a missing one", () => {
    // `undefined` is "could not be read" (the website resolves it separately);
    // prompting for a handle someone may already have is the worse answer.
    expect(profileGapFields({ ...fullAccount(), username: undefined })).toEqual([]);
    expect(profileGapFields({ ...fullAccount(), username: null })).toEqual(["username"]);
  });
});

describe("the sentences", () => {
  test("the one every surface prints, composed from the shared templates", () => {
    expect(describeProfileGap(resolveProfileGap("github_username"))).toBe(
      "GitHub handle is missing: needed to request upload access. Set it in Settings or run `nemar auth profile set-github`.",
    );
  });

  test("it names the nearest wall, not every wall behind it", () => {
    // github_username blocks publication too; the request is what is in front
    // of the reader.
    const sentence = describeProfileGap(resolveProfileGap("github_username"));
    expect(sentence).not.toContain("publish");
  });

  test("a name under a verified iD points at orcid.org and offers no command", () => {
    expect(describeProfileGap(resolveProfileGap("given_name", { orcidVerified: true }))).toBe(
      "Given name is missing: needed to request upload access. Set it in your ORCID record at orcid.org, then sign in again.",
    );
  });

  test("an unrecognised field renders rather than disappearing", () => {
    const gap = resolveProfileGap("institutional_email");
    expect(gap.known).toBe(false);
    expect(gap.label).toBe("institutional_email");
    expect(describeProfileGap(gap)).toBe(
      "institutional_email is missing: needed to finish setting up your account. Set it in Settings.",
    );
  });

  test("the full block list is noun-phrased for a surface that reports", () => {
    expect(describeProfileGapBlocks(resolveProfileGap("given_name"))).toBe(
      "upload access and publication",
    );
    expect(describeProfileGapBlocks(resolveProfileGap("city"))).toBe("upload access");
  });

  test("sandbox is CLI-only, is not in the shared matrix, and reads like the rest", () => {
    expect(GAP_FIELDS).not.toContain("sandbox" as GapField);
    expect(describeSandboxGap()).toBe(
      "Sandbox training is missing: needed to upload a dataset from the CLI. Run `nemar sandbox`.",
    );
  });

  test("`gaps.none` is the answer to an account with nothing outstanding", () => {
    expect(computeProfileGaps(fullAccount())).toEqual([]);
    expect(ACCOUNT_COPY["gaps.none"]).toBe(
      "Nothing outstanding — every field NEMAR needs is filled in.",
    );
  });
});

describe("resolveWireProfileGaps", () => {
  test("re-sorts into table order, so a backend's order does not leak", () => {
    const resolved = resolveWireProfileGaps([
      { field: "country", blocks: ["upload_access"] },
      { field: "email_verified", blocks: ["verified", "upload_access"] },
      { field: "username", blocks: ["upload_access"] },
    ]);
    expect(resolved.map((g) => g.field)).toEqual(["email_verified", "username", "country"]);
  });

  test("takes blocks from the wire, and falls back to the table", () => {
    // The backend is the authority on what a field blocks TODAY.
    const [fromWire] = resolveWireProfileGaps([{ field: "city", blocks: ["publication"] }]);
    expect([...fromWire.blocks]).toEqual(["publication"]);
    const [fromTable] = resolveWireProfileGaps([{ field: "city" }]);
    expect([...fromTable.blocks]).toEqual(["upload_access"]);
  });

  test("drops block values it does not know rather than printing them raw", () => {
    const [gap] = resolveWireProfileGaps([{ field: "city", blocks: ["teleportation"] }]);
    // Every value filtered out means an empty list, which falls back to the
    // table -- a build that predates a new vocabulary still says something true.
    expect([...gap.blocks]).toEqual(["upload_access"]);
  });

  test("ignores an entry with no field name", () => {
    expect(resolveWireProfileGaps([{ blocks: ["upload_access"] }, { field: "city" }])).toHaveLength(
      1,
    );
  });
});
