/**
 * Unit tests for the service-access upload gate (website ADR 0010, #1013;
 * ADR 0040 phase 2 for the channel). Pure decision logic shared by every
 * real-upload entry point (POST /datasets, /:id/upload-urls,
 * /:id/upload-credentials).
 *
 * The create-time matrix is exhaustive on purpose: channel x service_access x
 * sandbox_completed is eight cases, and exactly one of them differs between
 * the two channels. A spot-check would not distinguish "the web channel skips
 * sandbox training" from "the gate stopped checking sandbox training".
 *
 * These are a supplement, not the coverage (`.rules/testing.md`): a pure
 * function cannot catch the caller deriving `channel` from the wrong thing.
 * The route-level half — that the channel comes from the credential and not
 * from anything the client sends — is in upload-channel-route.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  SANDBOX_TRAINING_ERROR,
  SERVICE_ACCESS_ERROR,
  type UploadChannel,
  type UploadGateBody,
  realDatasetCreateGate,
  realDatasetServiceGate,
  uploadChannelForAuthMethod,
} from "../src/services/upload-gate";

interface Case {
  channel: UploadChannel;
  service_access: 0 | 1;
  sandbox_completed: 0 | 1;
  expected: UploadGateBody | null;
  why: string;
}

const CASES: Case[] = [
  // The authorization gate comes first on both channels, and nothing about
  // the channel can substitute for it.
  {
    channel: "cli",
    service_access: 0,
    sandbox_completed: 0,
    expected: SERVICE_ACCESS_ERROR,
    why: "no grant, no training",
  },
  {
    channel: "cli",
    service_access: 0,
    sandbox_completed: 1,
    expected: SERVICE_ACCESS_ERROR,
    why: "training does not substitute for the grant",
  },
  {
    channel: "web",
    service_access: 0,
    sandbox_completed: 0,
    expected: SERVICE_ACCESS_ERROR,
    why: "the browser is not exempt from the grant",
  },
  {
    channel: "web",
    service_access: 0,
    sandbox_completed: 1,
    expected: SERVICE_ACCESS_ERROR,
    why: "the browser is not exempt from the grant",
  },
  // The training gate is the CLI's alone: `nemar sandbox` has no browser
  // equivalent, so requiring it of a web upload would gate the dashboard on a
  // command the dashboard cannot run.
  {
    channel: "cli",
    service_access: 1,
    sandbox_completed: 0,
    expected: SANDBOX_TRAINING_ERROR,
    why: "the CLI still owes the training run",
  },
  {
    channel: "web",
    service_access: 1,
    sandbox_completed: 0,
    expected: null,
    why: "THE case that separates the channels: web needs the grant alone",
  },
  {
    channel: "cli",
    service_access: 1,
    sandbox_completed: 1,
    expected: null,
    why: "both gates satisfied",
  },
  {
    channel: "web",
    service_access: 1,
    sandbox_completed: 1,
    expected: null,
    why: "a web user who happens to have trained is still allowed",
  },
];

describe("realDatasetCreateGate: channel x service_access x sandbox_completed", () => {
  for (const c of CASES) {
    const label = `${c.channel} / service_access=${c.service_access} / sandbox=${c.sandbox_completed} -> ${
      c.expected === null ? "allowed" : c.expected.error
    } (${c.why})`;
    test(label, () => {
      expect(
        realDatasetCreateGate(
          { service_access: c.service_access, sandbox_completed: c.sandbox_completed },
          c.channel,
        ),
      ).toBe(c.expected);
    });
  }
});

describe("uploadChannelForAuthMethod", () => {
  test("the session cookie is the web channel", () => {
    expect(uploadChannelForAuthMethod("cookie")).toBe("web");
  });

  test("a bearer token is the CLI channel", () => {
    expect(uploadChannelForAuthMethod("token")).toBe("cli");
  });

  test("an unrecorded credential falls to the STRICTER channel", () => {
    // If a route ever reaches the gate without authMiddleware having recorded
    // how the caller authenticated, the safe default is the channel that
    // still owes sandbox training -- not the one that skips it.
    expect(uploadChannelForAuthMethod(undefined)).toBe("cli");
  });
});

describe("realDatasetServiceGate", () => {
  test("no service access -> service-access error (a collaborator without service access)", () => {
    expect(realDatasetServiceGate({ service_access: 0 })).toBe(SERVICE_ACCESS_ERROR);
  });

  test("service access present -> allowed (null); sandbox training is not re-checked", () => {
    // Byte-flow has no channel of its own: sandbox training was enforced at
    // create time (on whichever channel created the dataset), so re-asking
    // here would block a collaborator who never created anything.
    expect(realDatasetServiceGate({ service_access: 1 })).toBeNull();
  });
});
