/**
 * Pure tests for the deposit-attestation decision logic (#1077).
 *
 * attestationFromFlags and resolveAttestation are exercised directly (no
 * subprocess, no prompts, no network). The interactive prompt path is
 * untestable by construction (inquirer) and is exercised manually; the rule
 * under test here is the fail-closed contract: flags must be complete and
 * consistent, sandbox auto-attests, and a non-interactive real upload without
 * flags is an error rather than a silent affirmation.
 */

import { describe, expect, test } from "bun:test";
import {
  SANDBOX_ATTESTATION,
  attestationFromFlags,
  resolveAttestation,
} from "../src/lib/attestation";

describe("attestationFromFlags", () => {
  test("returns null when no attestation flags are given", () => {
    expect(attestationFromFlags({})).toBeNull();
  });

  test("builds an owner attestation from complete flags", () => {
    expect(
      attestationFromFlags({
        depositType: "owner",
        keyStatus: "destroyed",
        confirmDeidentified: true,
      }),
    ).toEqual({
      deposit_type: "owner",
      key_status: "destroyed",
      deidentified: true,
    });
  });

  test("builds a redistribution attestation with affirmation and upstream source", () => {
    expect(
      attestationFromFlags({
        depositType: "redistribution",
        keyStatus: "retained",
        confirmDeidentified: true,
        affirmNoDuplicate: true,
        upstreamSource: "https://openneuro.org/datasets/ds000000",
      }),
    ).toEqual({
      deposit_type: "redistribution",
      key_status: "retained",
      deidentified: true,
      no_duplicate: true,
      upstream_source: "https://openneuro.org/datasets/ds000000",
    });
  });

  test("rejects partial flag combinations loudly", () => {
    expect(() => attestationFromFlags({ depositType: "owner" })).toThrow(/--key-status/);
    expect(() => attestationFromFlags({ keyStatus: "destroyed" })).toThrow(/--deposit-type/);
    expect(() => attestationFromFlags({ depositType: "borrowed", keyStatus: "destroyed" })).toThrow(
      /--deposit-type/,
    );
  });

  test("flags without --confirm-deidentified are an error", () => {
    expect(() => attestationFromFlags({ depositType: "owner", keyStatus: "destroyed" })).toThrow(
      /--confirm-deidentified/,
    );
  });

  test("redistribution without --affirm-no-duplicate is an error", () => {
    expect(() =>
      attestationFromFlags({
        depositType: "redistribution",
        keyStatus: "retained",
        confirmDeidentified: true,
      }),
    ).toThrow(/affirm-no-duplicate/);
  });

  test("owner deposits reject redistribution-only flags", () => {
    expect(() =>
      attestationFromFlags({
        depositType: "owner",
        keyStatus: "destroyed",
        confirmDeidentified: true,
        affirmNoDuplicate: true,
      }),
    ).toThrow(/redistribution/);
    expect(() =>
      attestationFromFlags({
        depositType: "owner",
        keyStatus: "destroyed",
        confirmDeidentified: true,
        upstreamSource: "https://example.org",
      }),
    ).toThrow(/redistribution/);
  });
});

describe("resolveAttestation", () => {
  test("flags win regardless of TTY", async () => {
    const a = await resolveAttestation(
      { depositType: "owner", keyStatus: "retained", confirmDeidentified: true },
      false,
    );
    expect(a).toEqual({ deposit_type: "owner", key_status: "retained", deidentified: true });
  });

  test("the sandbox fixture attestation is complete and owner-typed", () => {
    // `nemar sandbox` sends this at its create call (src/commands/sandbox.ts);
    // resolveAttestation itself has no sandbox branch.
    expect(SANDBOX_ATTESTATION).toEqual({
      deposit_type: "owner",
      key_status: "destroyed",
      deidentified: true,
    });
  });

  test("non-interactive real upload without flags fails closed", async () => {
    await expect(resolveAttestation({}, false)).rejects.toThrow(/--deposit-type/);
  });
});
