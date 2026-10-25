/**
 * The NEMAR GitHub App (`nemar-publish-bot`) and its bot user, named once, here, and re-exported by
 * the Worker's `backend/src/services/github/branch-protection.ts`, where every Worker import of
 * them reads them from. They live in `shared/` because the machine-clean rule of the automatic
 * re-pull (`shared/repull-machine-clean.ts`, ADR 0111, decision 7) is pure and reads the bot's
 * identity, and nothing in `shared/` imports the Worker.
 *
 * A pull request is the App's only when its author's login, numeric id and type all match: a user
 * who registers a similar name does not pass, and neither does another App's bot. A change to any
 * of these values is a change to whose pull request may be reviewed as the App's and merged
 * without a person, so a test pins each one.
 *
 * Measured on 2026-10-24 with `GET /users/nemar-publish-bot%5Bbot%5D` (id 283755542, type `Bot`)
 * and `GET /apps/nemar-publish-bot` (id 3679074).
 */

/**
 * The App's id. Required status checks are pinned to it, so only a check run the App posted
 * satisfies them, and the App is a ruleset bypass actor (epic #713).
 */
export const NEMAR_APP_ID = 3679074;

/** The login GitHub gives the author of a pull request the App opens. */
export const NEMAR_APP_BOT_LOGIN = "nemar-publish-bot[bot]";

/** That author's numeric user id, which is not the App's id. */
export const NEMAR_APP_BOT_USER_ID = 283755542;

/** That author's `type`. */
export const NEMAR_APP_BOT_TYPE = "Bot";

/**
 * The organization that holds the dataset repositories, where the App opens its pull requests. The
 * Worker's own name for it is `ORG_NAME` (`backend/src/services/github/shared.ts`); this is the
 * same organization, spelled here for the pure rule, which compares a pull request's head and base
 * repositories with the dataset's.
 */
export const NEMAR_DATASETS_ORG = "nemarDatasets";
