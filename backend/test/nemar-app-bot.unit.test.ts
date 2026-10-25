/**
 * The GitHub App's bot user (epic #1046 phase 7, #1913; ADR 0111). The review admits exactly the
 * App's automatic re-pull pull request, and the machine-clean rule requires the App as its author,
 * each only when the login, the numeric id and the type all match, so a change to any of these
 * values is a change to whose pull request may be reviewed as the App's and merged without a
 * person. They were measured on 2026-10-24 with `GET /users/nemar-publish-bot%5Bbot%5D` and
 * `GET /apps/nemar-publish-bot`.
 *
 * They are defined once, in `shared/nemar-app.ts`, because the pure rule reads them and nothing in
 * `shared/` imports the Worker; the Worker reads them through `branch-protection.ts`, which
 * re-exports them, so the two cannot be two copies.
 */

import { describe, expect, test } from "bun:test";
import * as shared from "../../shared/nemar-app";
import {
  NEMAR_APP_BOT_LOGIN,
  NEMAR_APP_BOT_TYPE,
  NEMAR_APP_BOT_USER_ID,
  NEMAR_APP_ID,
} from "../src/services/github/branch-protection";
import { ORG_NAME } from "../src/services/github/shared";

describe("the NEMAR GitHub App identity", () => {
  test("the bot login, user id and type are the measured values", () => {
    expect(NEMAR_APP_BOT_LOGIN).toBe("nemar-publish-bot[bot]");
    expect(NEMAR_APP_BOT_USER_ID).toBe(283755542);
    expect(NEMAR_APP_BOT_TYPE).toBe("Bot");
  });

  test("the app id is the one the bot belongs to, and the user id is not the app id", () => {
    expect(NEMAR_APP_ID).toBe(3679074);
    expect(NEMAR_APP_BOT_USER_ID).not.toBe(NEMAR_APP_ID);
  });

  test("the Worker reads the one shared definition, and the organization is the Worker's", () => {
    expect(NEMAR_APP_ID).toBe(shared.NEMAR_APP_ID);
    expect(NEMAR_APP_BOT_LOGIN).toBe(shared.NEMAR_APP_BOT_LOGIN);
    expect(NEMAR_APP_BOT_USER_ID).toBe(shared.NEMAR_APP_BOT_USER_ID);
    expect(NEMAR_APP_BOT_TYPE).toBe(shared.NEMAR_APP_BOT_TYPE);
    expect(shared.NEMAR_DATASETS_ORG).toBe(ORG_NAME);
  });
});
