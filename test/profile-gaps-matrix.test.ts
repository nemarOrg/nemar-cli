/**
 * The shared profile-gap matrix, pinned field by field (#1268, ADR 0045).
 *
 * Two things are being held still here, and they fail for different reasons.
 *
 * 1. THE TABLE. `WEBSITE_TABLE` below is transcribed from
 *    `nemarOrg/website`'s `src/lib/profile-gaps.ts` + `account-copy.ts` as
 *    they shipped in website#310, plus the `orcid_verified` row of website#312
 *    (commit 19f93e3e) — what each field blocks, the prose that fits "Set it
 *    in ___", and the exact command. If `PROFILE_GAP_MATRIX` stops agreeing
 *    with it, one of the two repos has moved and the other has not, which is
 *    the whole failure mode phase 8 exists to prevent. This is the local half
 *    of that guard; `account-copy-parity.test.ts` is the half that reads the
 *    other checkout when it is present.
 *
 * 2. THE DERIVATION, over every one of the 2^8 combinations of the eight
 *    derivable fields. The oracle is built by FILTERING the fixture table
 *    rather than by re-running the production rules, so the test can disagree
 *    with the implementation: it says "these fields are blank, therefore these
 *    entries in this order", and `computeProfileGaps` has to arrive at the same
 *    answer from the row.
 *
 * `orcid_verified` adds a second dimension the other seven do not have: the
 * account's ROLE, because `admin` and `owner` are exempt from that row (#1271).
 * It is walked separately rather than multiplied into the 256, so a failure
 * says which of the two rules broke.
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

/** Transcribed from nemarOrg/website `src/lib/profile-gaps.ts` (website#310,
 *  and the `orcid_verified` row of website#312 at 19f93e3e). */
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
  orcid_verified: {
    blocks: ["upload_access"],
    web: "Settings",
    cli: "nemar auth profile orcid link",
    label: "Verified ORCID iD",
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
/** The eight the derivation can raise from a row; `why` needs a submitted form. */
const DERIVABLE = TABLE_FIELDS.filter((f) => WEBSITE_TABLE[f].derivable) as GapField[];
/** The two account columns that are flags rather than text, so "blank" is
 *  `false` and not `null`. */
const FLAG_FIELDS = new Set(["email_verified", "orcid_verified"]);

/** A complete account: nothing missing, nothing to report. A `member`, because
 *  that is the role the gap rules treat as ordinary — an `admin` would be
 *  exempt from a row and so could not prove it fires. */
function fullAccount(): Required<Omit<ProfileGapAccount, "status">> & { status: string } {
  return {
    status: "verified",
    role: "member",
    email_verified: true,
    username: "alovelace",
    given_name: "Ada",
    family_name: "Lovelace",
    github_username: "adalovelace",
    city: "London",
    country: "GB",
    orcid_verified: true,
  };
}

/** Blank out `fields` on an otherwise complete account. */
function accountMissing(fields: readonly string[]): ProfileGapAccount {
  const account: Record<string, unknown> = fullAccount();
  for (const field of fields) {
    account[field] = FLAG_FIELDS.has(field) ? false : null;
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
  // 2^8 = 256 subsets of the derivable fields.
  const subsets: string[][] = [];
  for (let mask = 0; mask < 1 << DERIVABLE.length; mask++) {
    subsets.push(DERIVABLE.filter((_, i) => (mask & (1 << i)) !== 0));
  }

  test("raises exactly the blank fields, in table order, for all 256", () => {
    expect(subsets).toHaveLength(256);
    for (const missing of subsets) {
      // The oracle: the fixture's own order, filtered to what was blanked.
      const expected = TABLE_FIELDS.filter((f) => missing.includes(f));
      const gaps = computeProfileGaps(accountMissing(missing));
      expect(gaps.map((g) => g.field)).toEqual(expected);
      // A subset that did NOT blank `orcid_verified` leaves it verified, which
      // moves the two name halves' set-on to the ORCID record. Derived from the
      // fixture rather than assumed, so the interaction is covered in both
      // directions across the 256 rather than in one hand-written case.
      const orcidVerified = !missing.includes("orcid_verified");
      for (const gap of gaps) {
        const row = WEBSITE_TABLE[gap.field];
        expect([...gap.blocks]).toEqual(row.blocks);
        const setOn = orcidVerified && row.orcidWeb ? ["web"] : row.cli ? ["web", "cli"] : ["web"];
        expect([...gap.set_on]).toEqual(setOn);
      }
    }
  });

  test("`why` is never raised from a row, however empty the row is", () => {
    // Nothing is stored until the form is submitted, so no account can be
    // missing it -- it exists in the table only for a refusal to render.
    expect(profileGapFields(accountMissing(DERIVABLE))).not.toContain("why");
  });

  test("the iD itself is never a gap; the VERIFICATION of it is", () => {
    // An unlinked iD is not what anything is waiting on -- a CLI signup cannot
    // exist without one and a web account never types one. What blocks the
    // request is an iD nobody proved (#1271).
    for (const orcid_verified of [true, false]) {
      const fields = profileGapFields({ ...accountMissing(DERIVABLE), orcid_verified });
      expect(fields).not.toContain("orcid");
      expect(fields.includes("orcid_verified")).toBe(!orcid_verified);
    }
  });

  test("an absent orcid_verified is unverified, not 'this caller does not say'", () => {
    // The opposite reading of `email_verified`'s, and deliberately: every row
    // carries this column (migration 0050, NOT NULL DEFAULT 0), so treating
    // `undefined` as verified would exempt exactly the CLI-created accounts the
    // gap exists for.
    expect(profileGapFields({ ...fullAccount(), orcid_verified: undefined })).toEqual([
      "orcid_verified",
    ]);
    expect(profileGapFields({ ...fullAccount(), orcid_verified: null })).toEqual([
      "orcid_verified",
    ]);
  });

  test("admin and owner are exempt from the ORCID row; nobody else is", () => {
    // Interim, until the service-account kind of epic #1272: these accounts
    // predate having a web-signup path of their own, and the alternative is
    // locking an operator out of the queue they run. A role this build cannot
    // read is NOT a licence to skip the check.
    const unverified = { ...fullAccount(), orcid_verified: false };
    for (const role of ["admin", "owner"] as const) {
      expect(profileGapFields({ ...unverified, role })).toEqual([]);
    }
    for (const role of ["member", "user", null, undefined] as const) {
      expect(profileGapFields({ ...unverified, role })).toEqual(["orcid_verified"]);
    }
  });

  test("the exemption is that one row and nothing else", () => {
    // An admin with a blank city is still missing a city: the role answers one
    // question, and answering the others with it would hide real gaps from the
    // people most likely to be asked about them.
    const gaps = profileGapFields({
      ...accountMissing(["orcid_verified", "city"]),
      role: "admin",
    });
    expect(gaps).toEqual(["city"]);
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

  test("the ORCID row reads like the rest, and names the link command", () => {
    // Not `nemar auth signup`: the account already exists and typed an iD; what
    // is missing is the browser handoff that proves it (ADR 0044).
    expect(describeProfileGap(resolveProfileGap("orcid_verified"))).toBe(
      "Verified ORCID iD is missing: needed to request upload access. Set it in Settings or run `nemar auth profile orcid link`.",
    );
  });

  test("a verified iD does not move where the ORCID row is set", () => {
    // The `.orcid` set-on variants belong to the two NAME halves, which a
    // verified record owns. An iD is not a name, so this row keeps both halves
    // whatever the flag says -- and it is only ever rendered when the flag is
    // false anyway.
    const gap = resolveProfileGap("orcid_verified", { orcidVerified: true });
    expect(gap.setOnWeb).toBe("Settings");
    expect(gap.setOnCli).toBe("nemar auth profile orcid link");
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
