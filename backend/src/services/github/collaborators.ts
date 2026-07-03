/**
 * Collaborator management: direct grants/removals, org-wide propagation, and
 * the pure ledger-vs-GitHub reconciliation used by repo-to-spec enforcement.
 *
 * Moved verbatim from services/github.ts (#906, epic #902); the only
 * intentional changes are import paths.
 */

import { HttpError } from "../retry";
import { listOrgRepos } from "./repos";
import { GITHUB_API, ORG_NAME, errText, ghHeaders } from "./shared";
import { githubFetchWithRetry } from "./transport";

/**
 * Add a user as collaborator to a repository
 */
export async function addCollaborator(
  repo: string,
  username: string,
  permission: "pull" | "push" | "maintain" | "admin",
  pat: string,
): Promise<boolean> {
  const response = await fetch(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/collaborators/${username}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ permission }),
    },
  );

  if (response.ok || response.status === 204) return true;
  // GitHub 422s when the target already holds a HIGHER permission via org
  // membership (an org owner/admin cannot be assigned the lower `maintain`/
  // `push`): "Cannot assign <user> permission of <role>". The post-condition
  // ("user has at least `permission`") is already satisfied, so treat it as a
  // benign no-op rather than a failure. The reconcile normally excludes org
  // admins up front (see listOrgAdmins); this guards the path where that
  // lookup failed.
  if (response.status === 422) {
    const body = await response.text().catch(() => "");
    if (/Cannot assign .+ permission of/i.test(body)) return true;
  }
  return false;
}

/**
 * Remove a user as collaborator from a repository
 */
export async function removeCollaborator(
  repo: string,
  username: string,
  pat: string,
): Promise<boolean> {
  const response = await fetch(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/collaborators/${username}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    },
  );

  return response.ok || response.status === 204;
}

/**
 * Add user as collaborator to ALL org repositories
 */
export async function addCollaboratorToAllRepos(
  username: string,
  pat: string,
): Promise<{ count: number; errors: string[] }> {
  const repos = await listOrgRepos(pat);
  const errors: string[] = [];
  let count = 0;

  for (const repo of repos) {
    // Skip special repos
    if (repo.name === ".github") continue;

    const success = await addCollaborator(repo.name, username, "push", pat);
    if (success) {
      count++;
    } else {
      errors.push(repo.name);
    }
  }

  return { count, errors };
}

/**
 * Remove user as collaborator from ALL org repositories
 */
export async function removeCollaboratorFromAllRepos(
  username: string,
  pat: string,
): Promise<{ count: number; errors: string[] }> {
  const repos = await listOrgRepos(pat);
  const errors: string[] = [];
  let count = 0;

  for (const repo of repos) {
    const success = await removeCollaborator(repo.name, username, pat);
    if (success) {
      count++;
    } else {
      errors.push(repo.name);
    }
  }

  return { count, errors };
}

/** GitHub collaborator role ranks, low to high. */
const ROLE_RANK: Record<string, number> = {
  pull: 1,
  read: 1,
  triage: 2,
  push: 3,
  write: 3,
  maintain: 4,
  admin: 5,
};
function roleRank(role: string): number {
  return ROLE_RANK[role] ?? 1;
}

export interface DirectCollaborator {
  login: string;
  role_name: string;
}

export interface CollaboratorActions {
  toAdd: Array<{ login: string; role: "push" | "maintain" }>;
  toPromote: Array<{ login: string; role: "push" | "maintain" }>;
  toRemove: string[];
}

/**
 * Pure diff of a repo's CURRENT direct collaborators against the desired set
 * derived from the D1 ledger: owner -> maintain, approved writers -> push.
 *
 * - Owner always retained (never removed/demoted).
 * - Writers promoted to push only if currently below push; never demoted (a
 *   collaborator who already has maintain keeps it).
 * - Any other direct grant (a stray read, a manual non-ledger add) is removed,
 *   unless its login is in `skipLogins`. On a public repo this includes the
 *   meaningless direct `read` grants.
 *
 * Comparison is case-insensitive on login; the original-case login is used for
 * the removal list so the GitHub API call matches.
 */
export function computeCollaboratorActions(opts: {
  current: DirectCollaborator[];
  visibility: "public" | "private";
  ownerLogin: string | null;
  approvedWriters: string[];
  skipLogins?: string[];
  /**
   * Lowercased logins of nemarDatasets org owners/admins. They already hold
   * admin on every repo via org membership, so we never grant, promote, or
   * strip a direct collaborator entry for them: GitHub 422s any attempt to
   * assign them a permission LOWER than admin ("Cannot assign X permission of
   * maintain"), and the grant would be redundant anyway.
   */
  orgAdmins?: string[];
}): CollaboratorActions {
  const ownerLogin = opts.ownerLogin ? opts.ownerLogin.toLowerCase() : null;
  const skip = new Set((opts.skipLogins ?? []).map((s) => s.toLowerCase()));
  const orgAdmins = new Set((opts.orgAdmins ?? []).map((s) => s.toLowerCase()));

  // Keyed by lowercased login for case-insensitive matching, but carrying the
  // ORIGINAL-case login so grants/output use the canonical GitHub username.
  // Org owners/admins are excluded outright: they already have admin via org
  // membership, so a collaborator grant is both redundant and rejected by
  // GitHub with a 422.
  const desired = new Map<string, { login: string; role: "push" | "maintain" }>();
  if (opts.ownerLogin && ownerLogin && !orgAdmins.has(ownerLogin))
    desired.set(ownerLogin, { login: opts.ownerLogin, role: "maintain" });
  for (const w of opts.approvedWriters) {
    const l = w.toLowerCase();
    if (l && l !== ownerLogin && !orgAdmins.has(l)) desired.set(l, { login: w, role: "push" });
  }

  const currentByLogin = new Map(opts.current.map((c) => [c.login.toLowerCase(), c]));
  const toAdd: CollaboratorActions["toAdd"] = [];
  const toPromote: CollaboratorActions["toPromote"] = [];
  for (const [key, { login, role }] of desired) {
    const cur = currentByLogin.get(key);
    if (!cur) {
      toAdd.push({ login, role });
    } else if (roleRank(cur.role_name) < roleRank(role)) {
      toPromote.push({ login, role });
    }
  }

  const toRemove: string[] = [];
  for (const c of opts.current) {
    const login = c.login.toLowerCase();
    if (desired.has(login) || skip.has(login) || login === ownerLogin || orgAdmins.has(login))
      continue;
    toRemove.push(c.login);
  }

  return { toAdd, toPromote, toRemove };
}

/**
 * List a repo's DIRECT collaborators (affiliation=direct). Never uses the
 * `/collaborators/{user}/permission` endpoint, which returns a baseline `read`
 * for ANY user on a public repo and would make every reconcile a false diff.
 */
export async function listDirectCollaborators(
  repo: string,
  pat: string,
): Promise<DirectCollaborator[]> {
  const out: DirectCollaborator[] = [];
  const headers = ghHeaders(pat);
  let page = 1;
  while (true) {
    const r = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/collaborators?affiliation=direct&per_page=100&page=${page}`,
      { headers },
      { retryOn404: true },
    );
    if (!r.ok) {
      const b = await r.text().catch(() => "<failed to read body>");
      throw new HttpError(
        `List collaborators failed for ${repo}: HTTP ${r.status}: ${b.slice(0, 200)}`,
        r.status,
        b.slice(0, 200),
      );
    }
    const items = (await r.json()) as Array<{ login: string; role_name?: string }>;
    if (items.length === 0) break;
    out.push(...items.map((c) => ({ login: c.login, role_name: c.role_name ?? "read" })));
    if (items.length < 100) break;
    page++;
  }
  return out;
}

/**
 * List the lowercased logins of nemarDatasets org Owners. GitHub's members API
 * spells the Owner role `role=admin` (the historical name), and Owners are
 * exactly the accounts that inherit `admin` on every repo in the org. The
 * collaborator reconcile uses this to avoid pointlessly (and unsuccessfully)
 * trying to grant them a direct collaborator role — GitHub 422s any attempt to
 * assign a permission lower than the admin they already hold. Best-effort: a
 * single page covers the handful of NEMAR org Owners; callers treat a throw as
 * "unknown" and lean on `addCollaborator`'s benign-422 handling instead.
 */
export async function listOrgAdmins(pat: string): Promise<Set<string>> {
  const out = new Set<string>();
  const headers = ghHeaders(pat);
  let page = 1;
  while (true) {
    const r = await githubFetchWithRetry(
      `${GITHUB_API()}/orgs/${ORG_NAME}/members?role=admin&per_page=100&page=${page}`,
      { headers },
    );
    if (!r.ok) {
      const b = await r.text().catch(() => "<failed to read body>");
      throw new HttpError(
        `List org admins failed for ${ORG_NAME}: HTTP ${r.status}: ${b.slice(0, 200)}`,
        r.status,
        b.slice(0, 200),
      );
    }
    const items = (await r.json()) as Array<{ login: string }>;
    if (items.length === 0) break;
    for (const m of items) out.add(m.login.toLowerCase());
    if (items.length < 100) break;
    page++;
  }
  return out;
}

export interface CollaboratorReconcileResult {
  added: string[];
  promoted: string[];
  removed: string[];
  errors: string[];
}

/**
 * Reconcile a repo's direct collaborators to the ledger-derived desired set.
 * Never throws; collects per-action errors. See `computeCollaboratorActions`.
 */
export async function reconcileCollaborators(
  opts: {
    repo: string;
    visibility: "public" | "private";
    ownerLogin: string | null;
    approvedWriters: string[];
    skipLogins?: string[];
  },
  pat: string,
): Promise<CollaboratorReconcileResult> {
  const result: CollaboratorReconcileResult = { added: [], promoted: [], removed: [], errors: [] };
  let current: DirectCollaborator[];
  try {
    current = await listDirectCollaborators(opts.repo, pat);
  } catch (e) {
    result.errors.push(`list: ${errText(e)}`);
    return result;
  }
  // Org owners/admins already hold admin via org membership; never try to add
  // them as collaborators. Best-effort — on failure we fall back to
  // addCollaborator's benign-422 handling.
  let orgAdmins: string[] = [];
  try {
    orgAdmins = [...(await listOrgAdmins(pat))];
  } catch (e) {
    console.error(`[reconcile] listOrgAdmins failed for ${opts.repo}: ${errText(e)}`);
  }
  const actions = computeCollaboratorActions({
    current,
    visibility: opts.visibility,
    ownerLogin: opts.ownerLogin,
    approvedWriters: opts.approvedWriters,
    skipLogins: opts.skipLogins,
    orgAdmins,
  });

  for (const a of actions.toAdd) {
    try {
      (await addCollaborator(opts.repo, a.login, a.role, pat))
        ? result.added.push(a.login)
        : result.errors.push(`add ${a.login}`);
    } catch (e) {
      result.errors.push(`add ${a.login}: ${errText(e)}`);
    }
  }
  for (const a of actions.toPromote) {
    try {
      (await addCollaborator(opts.repo, a.login, a.role, pat))
        ? result.promoted.push(a.login)
        : result.errors.push(`promote ${a.login}`);
    } catch (e) {
      result.errors.push(`promote ${a.login}: ${errText(e)}`);
    }
  }
  for (const login of actions.toRemove) {
    try {
      (await removeCollaborator(opts.repo, login, pat))
        ? result.removed.push(login)
        : result.errors.push(`remove ${login}`);
    } catch (e) {
      result.errors.push(`remove ${login}: ${errText(e)}`);
    }
  }
  if (result.errors.length > 0) {
    console.error(`[reconcile-collaborators] ${opts.repo}: ${result.errors.join("; ")}`);
  }
  return result;
}
