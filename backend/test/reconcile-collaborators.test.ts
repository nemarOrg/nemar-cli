/**
 * Unit tests for the collaborator reconcile diff (epic #713, phase #717).
 * Pure, no network, no mocks: assert `computeCollaboratorActions` against
 * representative current/desired states.
 */

import { describe, expect, test } from "bun:test";
import { type DirectCollaborator, computeCollaboratorActions } from "../src/services/github";

const cur = (login: string, role: string): DirectCollaborator => ({ login, role_name: role });

describe("computeCollaboratorActions", () => {
  test("owner is added as maintain when absent", () => {
    const a = computeCollaboratorActions({
      current: [],
      visibility: "private",
      ownerLogin: "alice",
      approvedWriters: [],
    });
    expect(a.toAdd).toEqual([{ login: "alice", role: "maintain" }]);
    expect(a.toPromote).toEqual([]);
    expect(a.toRemove).toEqual([]);
  });

  test("owner already maintain: no action; never removed", () => {
    const a = computeCollaboratorActions({
      current: [cur("alice", "maintain")],
      visibility: "public",
      ownerLogin: "alice",
      approvedWriters: [],
    });
    expect(a.toAdd).toEqual([]);
    expect(a.toPromote).toEqual([]);
    expect(a.toRemove).toEqual([]);
  });

  test("approved writer added as push; promoted from read", () => {
    const a = computeCollaboratorActions({
      current: [cur("bob", "read")],
      visibility: "private",
      ownerLogin: "alice",
      approvedWriters: ["bob", "carol"],
    });
    expect(a.toAdd).toContainEqual({ login: "carol", role: "push" });
    expect(a.toAdd).toContainEqual({ login: "alice", role: "maintain" });
    expect(a.toPromote).toEqual([{ login: "bob", role: "push" }]);
    expect(a.toRemove).toEqual([]);
  });

  test("writer is never demoted (already maintain stays)", () => {
    const a = computeCollaboratorActions({
      current: [cur("bob", "maintain")],
      visibility: "private",
      ownerLogin: "alice",
      approvedWriters: ["bob"],
    });
    expect(a.toPromote).toEqual([]);
    expect(a.toRemove).toEqual([]);
  });

  test("stray read grant is removed (public)", () => {
    const a = computeCollaboratorActions({
      current: [cur("alice", "maintain"), cur("stranger", "read")],
      visibility: "public",
      ownerLogin: "alice",
      approvedWriters: [],
    });
    expect(a.toRemove).toEqual(["stranger"]);
  });

  test("non-ledger push grant is removed (ledger is source of truth)", () => {
    const a = computeCollaboratorActions({
      current: [cur("alice", "maintain"), cur("ghost", "push")],
      visibility: "private",
      ownerLogin: "alice",
      approvedWriters: ["bob"],
    });
    expect(a.toRemove).toEqual(["ghost"]);
    expect(a.toAdd).toEqual([{ login: "bob", role: "push" }]);
  });

  test("skipLogins are never removed", () => {
    const a = computeCollaboratorActions({
      current: [cur("alice", "maintain"), cur("service-bot", "push")],
      visibility: "public",
      ownerLogin: "alice",
      approvedWriters: [],
      skipLogins: ["service-bot"],
    });
    expect(a.toRemove).toEqual([]);
  });

  test("login comparison is case-insensitive; removal uses original case", () => {
    const a = computeCollaboratorActions({
      current: [cur("Alice", "maintain"), cur("Bob", "push"), cur("Stray", "read")],
      visibility: "public",
      ownerLogin: "alice",
      approvedWriters: ["BOB"],
    });
    // Alice (owner) and Bob (writer) kept despite case differences.
    expect(a.toAdd).toEqual([]);
    expect(a.toPromote).toEqual([]);
    expect(a.toRemove).toEqual(["Stray"]);
  });

  test("owner listed in approvedWriters stays maintain (not demoted to push)", () => {
    const a = computeCollaboratorActions({
      current: [],
      visibility: "private",
      ownerLogin: "alice",
      approvedWriters: ["alice", "bob"],
    });
    expect(a.toAdd).toContainEqual({ login: "alice", role: "maintain" });
    expect(a.toAdd).toContainEqual({ login: "bob", role: "push" });
    expect(a.toAdd.filter((x) => x.login === "alice")).toHaveLength(1);
  });

  test("no owner (null): writers still reconciled, nothing forced to maintain", () => {
    const a = computeCollaboratorActions({
      current: [cur("ghost", "read")],
      visibility: "private",
      ownerLogin: null,
      approvedWriters: ["bob"],
    });
    expect(a.toAdd).toEqual([{ login: "bob", role: "push" }]);
    expect(a.toRemove).toEqual(["ghost"]);
  });

  test("owner who is an org admin is never added (already admin via org)", () => {
    const a = computeCollaboratorActions({
      current: [],
      visibility: "public",
      ownerLogin: "neuromechanist",
      approvedWriters: [],
      orgAdmins: ["neuromechanist"],
    });
    expect(a.toAdd).toEqual([]);
    expect(a.toPromote).toEqual([]);
    expect(a.toRemove).toEqual([]);
  });

  test("org-admin writer is excluded from add/promote (case-insensitive)", () => {
    const a = computeCollaboratorActions({
      current: [cur("bob", "read")],
      visibility: "private",
      ownerLogin: "alice",
      approvedWriters: ["Bob"],
      orgAdmins: ["BOB"],
    });
    // alice (non-admin owner) still added; bob excluded entirely.
    expect(a.toAdd).toEqual([{ login: "alice", role: "maintain" }]);
    expect(a.toPromote).toEqual([]);
    expect(a.toRemove).toEqual([]);
  });

  test("org admin with a stray direct grant is not removed", () => {
    const a = computeCollaboratorActions({
      current: [cur("alice", "maintain"), cur("orgowner", "admin")],
      visibility: "public",
      ownerLogin: "alice",
      approvedWriters: [],
      orgAdmins: ["orgowner"],
    });
    expect(a.toRemove).toEqual([]);
  });

  test("non-admin owner still added when orgAdmins is supplied but excludes them", () => {
    const a = computeCollaboratorActions({
      current: [],
      visibility: "public",
      ownerLogin: "pierregtch",
      approvedWriters: [],
      orgAdmins: ["neuromechanist", "nemaradmin"],
    });
    expect(a.toAdd).toEqual([{ login: "pierregtch", role: "maintain" }]);
  });
});
