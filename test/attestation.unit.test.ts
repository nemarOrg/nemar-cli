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
import { attestationFromFlags, resolveAttestation } from "../src/lib/attestation";

describe("attestationFromFlags", () => {
  test("returns null when no attestation flags are given", () => {
    expect(attestationFromFlags({})).toBeNull();
  });

  test("builds an owner attestation from complete flags", () => {
    expect(attestationFromFlags({ depositType: "owner", keyStatus: "destroyed" })).toEqual({
      deposit_type: "owner",
      key_status: "destroyed",
    });
  });

  test("builds a redistribution attestation with affirmation and upstream source", () => {
    expect(
      attestationFromFlags({
        depositType: "redistribution",
        keyStatus: "retained",
        affirmNoDuplicate: true,
        upstreamSource: "https://openneuro.org/datasets/ds000000",
      }),
    ).toEqual({
      deposit_type: "redistribution",
      key_status: "retained",
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

  test("redistribution without --affirm-no-duplicate is an error", () => {
    expect(() =>
      attestationFromFlags({ depositType: "redistribution", keyStatus: "retained" }),
    ).toThrow(/affirm-no-duplicate/);
  });

  test("owner deposits reject redistribution-only flags", () => {
    expect(() =>
      attestationFromFlags({
        depositType: "owner",
        keyStatus: "destroyed",
        affirmNoDuplicate: true,
      }),
    ).toThrow(/redistribution/);
    expect(() =>
      attestationFromFlags({
        depositType: "owner",
        keyStatus: "destroyed",
        upstreamSource: "https://example.org",
      }),
    ).toThrow(/redistribution/);
  });
});

describe("resolveAttestation", () => {
  test("flags win regardless of TTY", async () => {
    const a = await resolveAttestation({ depositType: "owner", keyStatus: "retained" }, false);
    expect(a).toEqual({ deposit_type: "owner", key_status: "retained" });
  });

  test("sandbox uploads auto-attest as owner fixtures", async () => {
    const a = await resolveAttestation({ sandbox: true }, false);
    expect(a).toEqual({ deposit_type: "owner", key_status: "destroyed" });
  });

  test("non-interactive real upload without flags fails closed", async () => {
    await expect(resolveAttestation({}, false)).rejects.toThrow(/--deposit-type/);
  });
});
