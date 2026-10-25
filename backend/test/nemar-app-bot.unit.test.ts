/**
 * The GitHub App's bot user (epic #1046 phase 7, #1913; ADR 0111). Nothing reads these constants
 * yet: the machine-clean review slice and the Worker-merge slice of the automatic re-pull will
 * accept a pull request as the App's only when both match, so a change to either value is a change
 * to who may be merged without a person. They were measured on 2026-10-24 with
 * `GET /users/nemar-publish-bot%5Bbot%5D` and `GET /apps/nemar-publish-bot`.
 */

import { describe, expect, test } from "bun:test";
import {
  NEMAR_APP_BOT_LOGIN,
  NEMAR_APP_BOT_USER_ID,
  NEMAR_APP_ID,
} from "../src/services/github/branch-protection";

describe("the NEMAR GitHub App identity", () => {
  test("the bot login and user id are the measured values", () => {
    expect(NEMAR_APP_BOT_LOGIN).toBe("nemar-publish-bot[bot]");
    expect(NEMAR_APP_BOT_USER_ID).toBe(283755542);
  });

  test("the app id is the one the bot belongs to, and the user id is not the app id", () => {
    expect(NEMAR_APP_ID).toBe(3679074);
    expect(NEMAR_APP_BOT_USER_ID).not.toBe(NEMAR_APP_ID);
  });
});
