/**
 * The admin mails that ask for an approval name the command to run, and since the admin tree
 * restructure (ADR 0135) that command is `nemar admin users approve`. The template puts the
 * command and the account in separate spans, so a substring check of the raw HTML cannot see
 * whether the rendered line reads as one command; this strips the markup and asserts the line an
 * administrator copies, for an account with a username and for one addressed by id.
 */

import { describe, expect, test } from "bun:test";
import { sendAdminNotificationEmail, sendUploadAccessRequestEmail } from "../src/services/email";
import { type CapturedEmail, asSend, withFakeResend } from "./helpers/resend";

const ADMIN = "admin@example.org";
const PRODUCTION = { ENVIRONMENT: "production" };

/** The mail's visible text: tags removed, entities for `<` and `>` restored, spaces collapsed. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
}

function onlyBody(calls: CapturedEmail[]): string {
  const sends = calls.filter((c) => c.path === "/emails").map(asSend);
  expect(sends).toHaveLength(1);
  return visibleText(sends[0].html);
}

describe("the approval command in admin mail", () => {
  test("a new verified account with a username: nemar admin users approve <username>", async () => {
    const body = await withFakeResend(async (calls) => {
      await sendAdminNotificationEmail(
        [ADMIN],
        {
          id: 41,
          username: "ada_l",
          email: "ada@example.org",
          github_username: null,
          description: "",
        },
        "re_test",
        "NEMAR <noreply@nemar.org>",
        undefined,
        false,
        PRODUCTION,
      );
      return onlyBody(calls);
    });
    expect(body).toContain("nemar admin users approve ada_l");
    expect(body).not.toContain("nemar admin approve");
  });

  test("an account with no username is addressed by id: nemar admin users approve --id <id>", async () => {
    const body = await withFakeResend(async (calls) => {
      await sendAdminNotificationEmail(
        [ADMIN],
        {
          id: 42,
          username: null,
          email: "web@example.org",
          github_username: null,
          description: "",
        },
        "re_test",
        "NEMAR <noreply@nemar.org>",
        undefined,
        false,
        PRODUCTION,
      );
      return onlyBody(calls);
    });
    expect(body).toContain("nemar admin users approve --id 42");
    expect(body).not.toContain("nemar admin approve");
  });

  test("an upload-access request: nemar admin users approve <username>", async () => {
    const body = await withFakeResend(async (calls) => {
      await sendUploadAccessRequestEmail(
        [ADMIN],
        {
          id: 43,
          username: "grace_h",
          given_name: "Grace",
          family_name: "Hopper",
          email: "grace@example.org",
          orcid: null,
          github_username: "",
          city: "Arlington",
          country: "USA",
          affiliation: null,
          why: "EEG recordings",
        },
        "re_test",
        "NEMAR <noreply@nemar.org>",
        undefined,
        false,
        PRODUCTION,
      );
      return onlyBody(calls);
    });
    expect(body).toContain("nemar admin users approve grace_h");
    expect(body).not.toContain("nemar admin approve");
  });
});
