/**
 * The community mail category table (epic #2260 phase 1, ADR 0132).
 *
 * The expected values are written out by hand, so a change to the table is a change to this file
 * and a reviewer sees both. What is derived instead is what must AGREE between the table and its
 * consumers: the stored keys the preference parser reads, and the sentences every surface prints.
 */

import { describe, expect, test } from "bun:test";
import {
  ADMIN_ALERT_CATEGORIES,
  DEFAULT_EMAIL_PREFERENCES,
  parseEmailPreferences,
} from "../backend/src/services/email";
import { ACCOUNT_COPY } from "../shared/contract/account-copy";
import {
  COMMUNITY_MAIL_CATEGORIES,
  MAIL_CATEGORIES,
  MAIL_CATEGORY_TABLE,
  RECALL_CATEGORY,
  RECALL_PREFERENCE,
  isCommunityMailCategory,
  isMailCategory,
  mailCategoryDescription,
  mailCategoryLabel,
  mailRecallWhy,
} from "../shared/contract/mail-categories";

describe("the table", () => {
  test("a recall is the one category nobody can turn off, and only the owner may send it", () => {
    expect(MAIL_CATEGORY_TABLE.recall.canBeTurnedOff).toBe(false);
    expect(MAIL_CATEGORY_TABLE.recall.sender).toBe("owner");
    for (const category of COMMUNITY_MAIL_CATEGORIES) {
      expect(MAIL_CATEGORY_TABLE[category].canBeTurnedOff).toBe(true);
      expect(MAIL_CATEGORY_TABLE[category].sender).toBe("admin");
    }
  });

  test("every switchable category is on by default (news is opt-out, owner decision D1)", () => {
    for (const category of COMMUNITY_MAIL_CATEGORIES) {
      expect(MAIL_CATEGORY_TABLE[category].defaultOn).toBe(true);
    }
  });

  test("the audiences are exactly the ones the owner accepted (D3)", () => {
    expect(MAIL_CATEGORY_TABLE.news).toMatchObject({
      statuses: ["verified", "approved"],
      accountKinds: ["person"],
    });
    expect(MAIL_CATEGORY_TABLE.rfcs).toMatchObject({
      statuses: ["verified", "approved"],
      accountKinds: ["person"],
    });
    expect(MAIL_CATEGORY_TABLE.maintenance).toMatchObject({
      statuses: ["verified", "approved"],
      accountKinds: ["person", "service"],
    });
    expect(MAIL_CATEGORY_TABLE.recall).toMatchObject({
      statuses: ["verified", "approved", "revoked"],
      accountKinds: ["person", "service"],
    });
  });

  test("no audience includes a pending account or a test account", () => {
    for (const category of MAIL_CATEGORIES) {
      const rule = MAIL_CATEGORY_TABLE[category];
      expect(rule.statuses as readonly string[]).not.toContain("pending");
      expect(rule.accountKinds as readonly string[]).not.toContain("test");
    }
  });

  test("the keys are the declared ones, in order, each entry naming itself", () => {
    expect([...MAIL_CATEGORIES]).toEqual(["news", "rfcs", "maintenance", "recall"]);
    expect(Object.keys(MAIL_CATEGORY_TABLE)).toEqual([...MAIL_CATEGORIES]);
    for (const category of MAIL_CATEGORIES) expect(MAIL_CATEGORY_TABLE[category].id).toBe(category);
    expect(RECALL_CATEGORY).toBe("recall");
  });

  test("the switchable list IS the table's switchable entries", () => {
    expect([...COMMUNITY_MAIL_CATEGORIES]).toEqual(
      MAIL_CATEGORIES.filter((category) => MAIL_CATEGORY_TABLE[category].canBeTurnedOff),
    );
  });

  test("the type guards accept the declared words and refuse everything else", () => {
    expect(isMailCategory("recall")).toBe(true);
    expect(isCommunityMailCategory("recall")).toBe(false);
    expect(isCommunityMailCategory("news")).toBe(true);
    for (const bad of ["announcements", "", "NEWS", undefined, null, 7]) {
      expect(isMailCategory(bad)).toBe(false);
    }
  });
});

describe("what is stored", () => {
  test("the parser reads exactly the admin alerts plus the switchable categories", () => {
    expect(Object.keys(DEFAULT_EMAIL_PREFERENCES).sort()).toEqual(
      [...ADMIN_ALERT_CATEGORIES, ...COMMUNITY_MAIL_CATEGORIES].sort(),
    );
    expect(Object.keys(parseEmailPreferences(null)).sort()).toEqual(
      Object.keys(DEFAULT_EMAIL_PREFERENCES).sort(),
    );
  });

  test("a community category and an admin alert never share a name", () => {
    const alerts = new Set<string>(ADMIN_ALERT_CATEGORIES);
    for (const category of MAIL_CATEGORIES) expect(alerts.has(category)).toBe(false);
  });

  test("neither the retired key nor a recall is ever stored", () => {
    const keys = Object.keys(DEFAULT_EMAIL_PREFERENCES);
    expect(keys).not.toContain("announcements");
    expect(keys).not.toContain("recall");
  });

  test("a recall is reported as on and locked, as a constant", () => {
    expect(RECALL_PREFERENCE).toEqual({ on: true, locked: true });
  });
});

describe("the words", () => {
  test("every category has its label and description in the account-copy table", () => {
    for (const category of MAIL_CATEGORIES) {
      expect(ACCOUNT_COPY).toHaveProperty([`mail.category.${category}.label`]);
      expect(ACCOUNT_COPY).toHaveProperty([`mail.category.${category}.description`]);
      expect(mailCategoryLabel(category).length).toBeGreaterThan(0);
      expect(mailCategoryDescription(category).length).toBeGreaterThan(0);
    }
  });

  test("the recall sentence says it cannot be turned off, and the mail keys are mirrored (no cli. prefix)", () => {
    expect(mailRecallWhy()).toContain("cannot be turned off");
    const mailKeys = Object.keys(ACCOUNT_COPY).filter((key) => key.startsWith("mail."));
    expect(mailKeys.length).toBe(MAIL_CATEGORIES.length * 2 + 1);
    for (const key of mailKeys) expect(key.startsWith("cli.")).toBe(false);
  });
});
