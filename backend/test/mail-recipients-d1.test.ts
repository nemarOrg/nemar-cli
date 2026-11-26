/**
 * `communityRecipients`: who each community mail category reaches (epic #2260 phase 1, ADR 0132).
 *
 * Real migrated schema (`freshDb`) and the real query; nothing is replaced. The expected lists
 * below are written out by hand, account by account, NOT derived from `MAIL_CATEGORY_TABLE`: a
 * typo in the table (a status in the wrong audience) must fail here rather than agree with itself.
 *
 * The matrix is status x account kind x role x stored preference x deletion, with the extra rows
 * the audience rules single out: a pending account (inbox unproved), an account whose email is not
 * verified, a test account, and a deleted account. A recall is the one category that ignores a
 * person's stored choice, so every opt-out is also seeded as a recall recipient.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import {
  COMMUNITY_MAIL_CATEGORIES,
  MAIL_CATEGORIES,
  type MailCategory,
  type MailRecipientGroup,
} from "../../shared/contract/mail-categories.js";
import { communityRecipients } from "../src/services/mail-recipients";
import { freshDb, realD1 } from "./helpers/d1";

interface Seed {
  name: string;
  status: "pending" | "verified" | "approved" | "revoked";
  kind?: "person" | "service" | "test";
  role?: "member" | "admin" | "owner";
  verified?: boolean;
  prefs?: string | null;
  deleted?: boolean;
}

const SEEDS: Seed[] = [
  { name: "p_approved", status: "approved" },
  { name: "p_verified", status: "verified" },
  // A pending account has not proved its inbox (ADR 0040), and the schema refuses one that has.
  { name: "p_pending", status: "pending", verified: false },
  { name: "p_revoked", status: "revoked" },
  // Approved on paper, inbox not proved: still nobody's audience.
  { name: "p_unverified_inbox", status: "approved", verified: false },
  { name: "s_approved", status: "approved", kind: "service" },
  { name: "s_verified", status: "verified", kind: "service" },
  { name: "s_revoked", status: "revoked", kind: "service" },
  { name: "t_approved", status: "approved", kind: "test" },
  { name: "adm", status: "approved", role: "admin" },
  { name: "own", status: "approved", role: "owner" },
  { name: "gone", status: "approved", deleted: true },
  { name: "off_news", status: "approved", prefs: '{"news":false,"rfcs":true,"maintenance":true}' },
  { name: "off_rfcs", status: "approved", prefs: '{"news":true,"rfcs":false,"maintenance":true}' },
  {
    name: "off_maint",
    status: "approved",
    prefs: '{"news":true,"rfcs":true,"maintenance":false}',
  },
  {
    name: "off_all",
    status: "approved",
    prefs: '{"news":false,"rfcs":false,"maintenance":false}',
  },
  // An admin alert switched off says nothing about community mail.
  { name: "off_alerts", status: "approved", prefs: '{"user_approval":false}' },
];

let db: Database;

beforeAll(() => {
  db = freshDb();
  const insert = db.prepare(
    `INSERT INTO users (username, email, status, account_kind, role, email_verified, email_preferences, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const s of SEEDS) {
    insert.run(
      s.name,
      `${s.name}@mail.test`,
      s.status,
      s.kind ?? "person",
      s.role ?? "member",
      s.verified === false ? 0 : 1,
      s.prefs ?? null,
      s.deleted ? "2026-01-01 00:00:00" : null,
    );
  }
});

async function names(category: MailCategory, group: MailRecipientGroup): Promise<string[]> {
  const rows = await communityRecipients(realD1(db), category, group);
  return rows.map((r) => r.email.replace("@mail.test", "")).sort();
}

const sorted = (xs: string[]) => [...xs].sort();

describe("the audience of each category, group all", () => {
  test("news: persons at verified or approved, minus those who turned it off", async () => {
    expect(await names("news", "all")).toEqual(
      sorted(["p_approved", "p_verified", "adm", "own", "off_rfcs", "off_maint", "off_alerts"]),
    );
  });

  test("rfcs: the same audience, minus those who turned rfcs off", async () => {
    expect(await names("rfcs", "all")).toEqual(
      sorted(["p_approved", "p_verified", "adm", "own", "off_news", "off_maint", "off_alerts"]),
    );
  });

  test("maintenance: persons and service accounts, minus those who turned it off", async () => {
    expect(await names("maintenance", "all")).toEqual(
      sorted([
        "p_approved",
        "p_verified",
        "s_approved",
        "s_verified",
        "adm",
        "own",
        "off_news",
        "off_rfcs",
        "off_alerts",
      ]),
    );
  });

  test("recall: persons and services at verified, approved or revoked, whatever they chose", async () => {
    expect(await names("recall", "all")).toEqual(
      sorted([
        "p_approved",
        "p_verified",
        "p_revoked",
        "s_approved",
        "s_verified",
        "s_revoked",
        "adm",
        "own",
        "off_news",
        "off_rfcs",
        "off_maint",
        "off_all",
        "off_alerts",
      ]),
    );
  });
});

describe("accounts that are in no audience", () => {
  test("pending, unverified-inbox, test and deleted accounts receive nothing, not even a recall", async () => {
    for (const category of MAIL_CATEGORIES) {
      const got = await names(category, "all");
      for (const absent of ["p_pending", "p_unverified_inbox", "t_approved", "gone"]) {
        expect({ category, absent, present: got.includes(absent) }).toEqual({
          category,
          absent,
          present: false,
        });
      }
    }
  });

  test("the system account never receives anything, a recall included", async () => {
    // Migration 0026 seeds nemar-system as a REVOKED person with a verified system@nemar.org, which
    // a recall's audience (revoked included) would pick up, and that address is a catch-all that
    // files a support ticket (ADR 0112). It is in the fresh schema, so no seed is needed.
    for (const category of MAIL_CATEGORIES) {
      expect(await names(category, "all")).not.toContain("system@nemar.org");
    }
  });

  test("a revoked account receives a recall and nothing else", async () => {
    for (const category of COMMUNITY_MAIL_CATEGORIES) {
      const got = await names(category, "all");
      expect(got).not.toContain("p_revoked");
      expect(got).not.toContain("s_revoked");
    }
    const recall = await names("recall", "all");
    expect(recall).toContain("p_revoked");
    expect(recall).toContain("s_revoked");
  });

  test("a service account receives maintenance and recalls only", async () => {
    expect(await names("news", "all")).not.toContain("s_approved");
    expect(await names("rfcs", "all")).not.toContain("s_verified");
    expect(await names("maintenance", "all")).toContain("s_approved");
    expect(await names("recall", "all")).toContain("s_verified");
  });
});

describe("a group narrows the audience by role and never widens it", () => {
  test("admins: owners and admins who are in the category's audience", async () => {
    expect(await names("news", "admins")).toEqual(sorted(["adm", "own"]));
    expect(await names("recall", "admins")).toEqual(sorted(["adm", "own"]));
  });

  test("members: role member only, with the same status and preference rules", async () => {
    expect(await names("rfcs", "members")).toEqual(
      sorted(["p_approved", "p_verified", "off_news", "off_maint", "off_alerts"]),
    );
    // A service account with role member is in the members group for maintenance, as in all.
    expect(await names("maintenance", "members")).toContain("s_approved");
  });

  test("a narrower group is a subset of group all, for every category", async () => {
    for (const category of MAIL_CATEGORIES) {
      const all = await names(category, "all");
      for (const group of ["admins", "members"] as const) {
        const narrow = await names(category, group);
        expect({ category, group, extra: narrow.filter((n) => !all.includes(n)) }).toEqual({
          category,
          group,
          extra: [],
        });
      }
    }
  });
});

describe("what a recipient carries", () => {
  test("the account id travels with the address, so a later send can re-read the account", async () => {
    const rows = await communityRecipients(realD1(db), "news", "all");
    const row = rows.find((r) => r.email === "p_approved@mail.test");
    const expected = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'p_approved'")
      .get();
    expect(row?.userId).toBe(expected?.id);
  });
});
