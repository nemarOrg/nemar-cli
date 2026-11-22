/**
 * The compute terms a person accepts when they ask for compute access (epic #2021 phase D1, #2022).
 *
 * `COMPUTE_TERMS_VERSION` is the version a request must name (`accept_terms_version`), and is stored
 * on the account (`users.compute_terms_version`) with the time it was accepted. The terms text is
 * written in phase D5 (#2026); that phase edits this file and nothing else here. The version is a
 * short word of letters, digits and `. _ -` (at most 32 characters), which is exactly what the
 * migration's CHECK allows.
 *
 * `COMPUTE_TERMS_PUBLISHED` is false until the University of California San Diego counsel has approved
 * the text and the owner publishes it. While it is false, a request in the exact production
 * environment is refused 503 `terms_unpublished`: nobody can accept terms that do not exist yet. Other
 * environments take requests, so the flow is built and tested before publication. Changing the
 * constant is the owner's act, in a reviewed change.
 *
 * Re-acceptance when the terms version changes is not designed: an account keeps the version it
 * accepted, and nothing here asks again.
 */

export const COMPUTE_TERMS_VERSION = "2026-11-draft";

export const COMPUTE_TERMS_PUBLISHED = false;

/** The shape a version takes: the migration's CHECK, written as a pattern. */
export const COMPUTE_TERMS_VERSION_RE = /^[0-9A-Za-z._-]{1,32}$/;
