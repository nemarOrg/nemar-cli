/**
 * What `nemar admin publish deny --help-all` says about the denials the API refuses (ADR 0103,
 * decision 11, #1730).
 *
 * `deny` is refused for a request whose approval is running, and for one whose approval has already
 * run a step that publishes something (the dataset may be public, and the depositor must not be
 * told it was denied). Both answers come from the Worker, in its own words; the help says so before
 * a person meets them. The real command runs against the real backend app
 * (`helpers/admin-publish-cli.ts`); only the help text is read.
 *
 * Mutation check (turns the test red): drop any of these sentences from the help of `deny`.
 *
 * CI TIER: unit-pure. Hermetic: an in-process backend over a local database, the CLI spawned
 * against it, stand-ins only at GitHub and Resend, no live network; it sets its own default
 * timeout.
 */

import { afterAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { startPublishCli } from "./helpers/admin-publish-cli";

setDefaultTimeout(60_000);

const h = startPublishCli();
afterAll(() => h.stop());

beforeEach(async () => {
  h.reset();
  await h.admin("denyhelpadmin", "deny-help-key-0123456789abcdef0123456789abcdef");
});

test("--help-all says that a running approval, and one that has published a step, block a denial", async () => {
  const r = await h.cli(["admin", "publish", "deny", "--help-all"]);

  expect(r.exitCode).toBe(0);
  const text = r.stdout.replace(/\s+/g, " ");
  expect(text).toContain("cannot be denied while an approval of it is running");
  expect(text).toContain("once an approval has run a step that publishes");
  // What is left to do mirrors the Worker's sentence (`DENY_AFTER_PUBLISHING_MESSAGE`): a blocked
  // request waits for its depositor, and any other is finished by approving it again or repaired.
  expect(text).toContain("a blocked request waits for its depositor");
  expect(text).toContain("any other can be finished by approving it again, or repaired by hand");
  // Nothing was asked of the API for a help screen.
  expect(h.posted).toEqual([]);
});
