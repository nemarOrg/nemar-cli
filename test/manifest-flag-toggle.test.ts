/**
 * Unit tests for `isCentralManifestWorkflowEnabled` (#557 Stream B).
 *
 * The flag gates the worker between legacy `generateManifest()` and the
 * new central-workflow dispatch path. Coercion is intentionally strict
 * -- only the literal string "true" enables. A mis-deployed env var
 * value ("True", "1", "yes") MUST stay on the legacy path, because
 * silently flipping to central without the matching workflow secrets +
 * Stream A generator is worse than not flipping at all.
 *
 * This file pins the coercion table so a future "make it more
 * permissive" refactor can't slip past review.
 */

import { describe, expect, test } from "bun:test";
import { isCentralManifestWorkflowEnabled } from "../backend/src/services/central-manifest";
import type { Bindings } from "../backend/src/types/bindings";

const asEnv = (val: unknown): Bindings =>
  ({ MANIFEST_VIA_CENTRAL_WORKFLOW: val }) as unknown as Bindings;

describe("isCentralManifestWorkflowEnabled", () => {
  test('enables only for literal "true"', () => {
    expect(isCentralManifestWorkflowEnabled(asEnv("true"))).toBe(true);
  });

  test.each(["True", "TRUE", "tRuE"])('case-variant "%s" does NOT enable', (val) => {
    expect(isCentralManifestWorkflowEnabled(asEnv(val))).toBe(false);
  });

  test.each(["1", "yes", "y", "on", "enable", "enabled"])(
    'truthy-looking value "%s" does NOT enable',
    (val) => {
      expect(isCentralManifestWorkflowEnabled(asEnv(val))).toBe(false);
    },
  );

  test.each(["false", "False", "0", "no", "off", "disabled", ""])(
    'falsy/explicit-off "%s" does NOT enable',
    (val) => {
      expect(isCentralManifestWorkflowEnabled(asEnv(val))).toBe(false);
    },
  );

  test("undefined value does NOT enable (default deploy state)", () => {
    expect(isCentralManifestWorkflowEnabled(asEnv(undefined))).toBe(false);
  });

  test("null value does NOT enable", () => {
    expect(isCentralManifestWorkflowEnabled(asEnv(null))).toBe(false);
  });

  test("number 1 does NOT enable (only the literal string)", () => {
    expect(isCentralManifestWorkflowEnabled(asEnv(1))).toBe(false);
  });

  test("boolean true does NOT enable (Workers env vars are strings)", () => {
    expect(isCentralManifestWorkflowEnabled(asEnv(true))).toBe(false);
  });

  test('whitespace-padded "true " does NOT enable (defensive: no trim)', () => {
    expect(isCentralManifestWorkflowEnabled(asEnv("true "))).toBe(false);
    expect(isCentralManifestWorkflowEnabled(asEnv(" true"))).toBe(false);
  });
});
