/**
 * Unit tests for the pure pieces of the Phase 3/4 dashboard self-service
 * endpoints (#575 owner draft delete, #578 invite by email).
 *
 * The route handlers themselves are D1/GitHub/S3-bound (integration territory),
 * so this file pins the two pure contracts: the draft-deletability guard matrix
 * and the invite payload's username/email mutual exclusion.
 */

import { describe, expect, test } from "bun:test";
import { evaluateDraftDeletability, inviteSchema } from "../backend/src/routes/datasets";

describe("evaluateDraftDeletability (#575)", () => {
  test("private, no DOI, no active pub request -> deletable", () => {
    expect(
      evaluateDraftDeletability({ visibility: "private", conceptDoi: null, activePubRequests: 0 }),
    ).toEqual({ deletable: true });
  });

  test("public dataset -> not deletable (admin operation)", () => {
    const r = evaluateDraftDeletability({
      visibility: "public",
      conceptDoi: null,
      activePubRequests: 0,
    });
    expect(r.deletable).toBe(false);
    expect(r).toMatchObject({ deletable: false });
    if (!r.deletable) expect(r.reason).toContain("public");
  });

  test("dataset with a concept DOI -> not deletable", () => {
    const r = evaluateDraftDeletability({
      visibility: "private",
      conceptDoi: "10.82901/NEMAR.abc",
      activePubRequests: 0,
    });
    expect(r.deletable).toBe(false);
    if (!r.deletable) expect(r.reason).toContain("DOI");
  });

  test("active publication request -> not deletable", () => {
    const r = evaluateDraftDeletability({
      visibility: "private",
      conceptDoi: null,
      activePubRequests: 1,
    });
    expect(r.deletable).toBe(false);
    if (!r.deletable) expect(r.reason).toContain("publication request");
  });

  test("visibility guard takes precedence over DOI/pub-request reasons", () => {
    const r = evaluateDraftDeletability({
      visibility: "public",
      conceptDoi: "10.82901/NEMAR.abc",
      activePubRequests: 3,
    });
    expect(r.deletable).toBe(false);
    if (!r.deletable) expect(r.reason).toContain("public");
  });

  test("null visibility is treated as not-private (not deletable)", () => {
    // A row with NULL visibility is not provably a private draft; refuse.
    const r = evaluateDraftDeletability({
      visibility: null,
      conceptDoi: null,
      activePubRequests: 0,
    });
    expect(r.deletable).toBe(false);
  });
});

describe("inviteSchema mutual exclusion (#578)", () => {
  test("username only -> valid", () => {
    expect(inviteSchema.safeParse({ username: "alice" }).success).toBe(true);
  });

  test("email only -> valid", () => {
    expect(inviteSchema.safeParse({ email: "alice@example.org" }).success).toBe(true);
  });

  test("both username and email -> invalid", () => {
    expect(inviteSchema.safeParse({ username: "alice", email: "alice@example.org" }).success).toBe(
      false,
    );
  });

  test("neither -> invalid", () => {
    expect(inviteSchema.safeParse({}).success).toBe(false);
  });

  test("malformed email -> invalid", () => {
    expect(inviteSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
  });

  test("empty username -> invalid (min length)", () => {
    expect(inviteSchema.safeParse({ username: "" }).success).toBe(false);
  });
});
