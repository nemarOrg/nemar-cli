/**
 * Role hierarchy and validation tests
 *
 * Unit tests for hasRole, isDemotion, isValidRole, and parseRole
 * from backend/src/types/bindings.ts.
 */

import { describe, expect, test } from "bun:test";
import { hasRole, isDemotion, isValidRole, parseRole } from "../backend/src/types/bindings";

describe("hasRole", () => {
  test("owner >= owner", () => expect(hasRole("owner", "owner")).toBe(true));
  test("owner >= admin", () => expect(hasRole("owner", "admin")).toBe(true));
  test("owner >= member", () => expect(hasRole("owner", "member")).toBe(true));
  test("admin >= admin", () => expect(hasRole("admin", "admin")).toBe(true));
  test("admin >= member", () => expect(hasRole("admin", "member")).toBe(true));
  test("admin < owner", () => expect(hasRole("admin", "owner")).toBe(false));
  test("member >= member", () => expect(hasRole("member", "member")).toBe(true));
  test("member < admin", () => expect(hasRole("member", "admin")).toBe(false));
  test("member < owner", () => expect(hasRole("member", "owner")).toBe(false));
});

describe("isDemotion", () => {
  test("owner -> admin is demotion", () => expect(isDemotion("owner", "admin")).toBe(true));
  test("owner -> member is demotion", () => expect(isDemotion("owner", "member")).toBe(true));
  test("admin -> member is demotion", () => expect(isDemotion("admin", "member")).toBe(true));
  test("member -> admin is not demotion", () => expect(isDemotion("member", "admin")).toBe(false));
  test("admin -> admin is not demotion", () => expect(isDemotion("admin", "admin")).toBe(false));
});

describe("isValidRole", () => {
  test("owner is valid", () => expect(isValidRole("owner")).toBe(true));
  test("admin is valid", () => expect(isValidRole("admin")).toBe(true));
  test("member is valid", () => expect(isValidRole("member")).toBe(true));
  test("superadmin is invalid", () => expect(isValidRole("superadmin")).toBe(false));
  test("ADMIN is invalid (case sensitive)", () => expect(isValidRole("ADMIN")).toBe(false));
  test("empty string is invalid", () => expect(isValidRole("")).toBe(false));
});

describe("parseRole", () => {
  test("valid roles pass through", () => {
    expect(parseRole("owner")).toBe("owner");
    expect(parseRole("admin")).toBe("admin");
    expect(parseRole("member")).toBe("member");
  });

  test("null defaults to member", () => expect(parseRole(null)).toBe("member"));
  test("undefined defaults to member", () => expect(parseRole(undefined)).toBe("member"));
  test("invalid string returns null", () => expect(parseRole("superadmin")).toBeNull());
  test("empty string returns null", () => expect(parseRole("")).toBeNull());
});
