/**
 * Every `docs.nemar.org` page URL this repo points at must be a page that
 * exists (epic #1336 phase 1, issue #1339, ADR 0057).
 *
 * ADR 0057 makes the docs site the canonical retrieval surface and takes
 * repository access out of the retrieval contract. From here on, `AGENTS.md`
 * and `.rules/*` stop describing things and start POINTING at them, so a
 * pointer that resolves to nothing is not a cosmetic problem: it is the
 * reference material being unreachable for the agent that was told to read it.
 *
 * `starlight-links-validator` already fails the docs build on a broken
 * internal link. This is the other direction, and nothing covered it. Note
 * that the docs plugin also would not catch this even inside its own repo: it
 * defaults to `sameSitePolicy: 'ignore'`, so an absolute
 * `https://docs.nemar.org/...` link is invisible to it.
 *
 * TWO THINGS HERE ARE NOT OBVIOUS AND BOTH WERE LEARNED THE HARD WAY.
 *
 * **Resolution is a slug map, not path arithmetic.** `slug:` frontmatter
 * decouples the source path from the published URL in both directions. Today
 * `src/content/docs/platform/zarr.md` declares `slug: platform/zarr/mental-model`
 * while `/platform/zarr/` is served by `platform/zarr/index.md`, so guessing
 * candidate paths both falsely passes `/platform/zarr/` and falsely fails
 * `/platform/zarr/mental-model/`. The docs repo's own
 * `scripts/check-admin-gating.ts` carries the same warning.
 *
 * **The comparison reads a git ref, never the working tree.** Two exploration
 * passes over the sibling checkout disagreed about whether any page uses
 * `slug:` at all, because one read a working tree parked on a feature branch
 * that was missing twenty-odd pages. A checker whose answer depends on which
 * branch someone left checked out reports drift that is not there, and the
 * blame lands on the checker.
 *
 * Real filesystem and real git, no mocks. `.rules/testing.md`: prove the test
 * fails.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

/** Set by CI to the checkout it made. A relative value resolves against the
 *  repo root, which is the workflow's working directory. */
const DOCS_ENV_VAR = "NEMAR_DOCS_CHECKOUT";
const declaredRaw = process.env[DOCS_ENV_VAR];
const DECLARED_PATH =
  declaredRaw && declaredRaw.trim() !== ""
    ? isAbsolute(declaredRaw)
      ? declaredRaw
      : join(REPO_ROOT, declaredRaw)
    : null;

/**
 * Where a docs checkout is expected to sit relative to this one.
 *
 * Both repos live under one parent directory, and this repo is often a
 * WORKTREE (`phase1-inventory/`, `epic-agent-docs/`, ...) rather than
 * `nemar-cli/` itself, so the sibling can be one or two levels up.
 * Only consulted when {@link DOCS_ENV_VAR} is unset.
 */
const DOCS_CANDIDATES = [join(REPO_ROOT, "..", "docs"), join(REPO_ROOT, "..", "..", "docs")];

/** Files whose docs pointers are checked. Workflows are included because
 *  `.github/workflows/test.yml` currently holds the only path-bearing docs URL
 *  in the repo. */
function scannedFiles(): string[] {
  const files = [join(REPO_ROOT, "AGENTS.md"), join(REPO_ROOT, "README.md")];
  for (const dir of [".rules", ".github/workflows"]) {
    const abs = join(REPO_ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs).sort()) {
      if (name.endsWith(".md") || name.endsWith(".yml") || name.endsWith(".yaml")) {
        files.push(join(abs, name));
      }
    }
  }
  return files.filter((f) => existsSync(f));
}

/** Page extensions Starlight's loader accepts. `.mdoc` needs `@astrojs/markdoc`,
 *  which the docs repo does not install. */
const PAGE_EXTENSIONS = [".md", ".mdx", ".markdown", ".mdown", ".mkdn", ".mkd", ".mdwn"];

/**
 * Paths served by something other than a content-collection page. Referencing
 * one is fine and must not be reported as a broken pointer.
 */
const NON_PAGE_PREFIXES = ["/pagefind/", "/_astro/", "/figures/", "/__docs-auth/"];
const NON_PAGE_EXACT = new Set([
  "/llms.txt",
  "/404",
  "/robots.txt",
  "/favicon.svg",
  "/_routes.json",
  "/sitemap-index.xml",
  "/sitemap-0.xml",
]);

/**
 * Every `docs.nemar.org` reference in a source file, as a URL pathname.
 *
 * A BARE HOSTNAME IS NOT A POINTER. All three of today's mentions are prose
 * (`AGENTS.md` names the host in a table, `.rules/documentation.md` links the
 * site root), and failing those would be reporting on the absence of a path
 * rather than on a broken link. Anything with no path segment is dropped here
 * rather than resolved to `/`.
 *
 * Trailing punctuation is stripped because prose puts a period after a URL,
 * and Markdown wraps one in `<>` or `()`.
 */
export function extractDocsPaths(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/https?:\/\/docs\.nemar\.org(\/[^\s)>\]"'`]*)?/g)) {
    const raw = m[1];
    if (!raw) continue;
    const cleaned = raw.replace(/[.,;:!?]+$/, "");
    if (cleaned === "" || cleaned === "/") continue;
    out.push(cleaned);
  }
  return out;
}

/** The slug a content file serves at, before any `slug:` override: strip the
 *  extension, then a trailing `/index`, and treat a bare root `index` as "". */
export function slugFromPath(relPath: string): string {
  let slug = relPath.replace(/^src\/content\/docs\//, "");
  for (const ext of PAGE_EXTENSIONS) {
    if (slug.endsWith(ext)) {
      slug = slug.slice(0, -ext.length);
      break;
    }
  }
  if (slug === "index") return "";
  return slug.replace(/\/index$/, "");
}

/** A URL pathname reduced to the slug Starlight would route it by. */
export function pathToSlug(pathname: string): string {
  return pathname
    .replace(/\/index\.html$/, "")
    .replace(/\.html$/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** First ref that resolves, so the answer never depends on the branch someone
 *  left checked out in the sibling. */
function resolveRef(repo: string): string | null {
  for (const ref of ["main", "origin/main"]) {
    if (git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) return ref;
  }
  return null;
}

/** Every slug the docs site publishes at `ref`, honouring `slug:` overrides. */
export function publishedSlugs(repo: string, ref: string): Set<string> {
  const listing = git(repo, ["ls-tree", "-r", "--name-only", ref, "--", "src/content/docs"]);
  if (listing === null) return new Set();

  const bySource = new Map<string, string>();
  for (const rel of listing.split("\n").filter(Boolean)) {
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    if (base.startsWith("_")) continue;
    if (!PAGE_EXTENSIONS.some((ext) => rel.endsWith(ext))) continue;
    bySource.set(rel, slugFromPath(rel));
  }

  // One call rather than one per file. `git grep` with a ref prefixes each hit
  // with `<ref>:`, so the path is the second field.
  const overrides = git(repo, ["grep", "-n", "^slug:", ref, "--", "src/content/docs"]);
  if (overrides !== null) {
    for (const line of overrides.split("\n").filter(Boolean)) {
      const m = line.match(/^[^:]*:(src\/content\/docs\/[^:]+):\d+:slug:\s*(.+?)\s*$/);
      if (!m) continue;
      const [, path, declared] = m;
      if (bySource.has(path)) bySource.set(path, declared.replace(/^\/+/, "").replace(/\/+$/, ""));
    }
  }
  return new Set(bySource.values());
}

const FOUND_ROOT = DECLARED_PATH ?? DOCS_CANDIDATES.find((p) => existsSync(p)) ?? null;
const REF = FOUND_ROOT && existsSync(FOUND_ROOT) ? resolveRef(FOUND_ROOT) : null;
const NO_CHECKOUT = FOUND_ROOT === null || REF === null;

if (NO_CHECKOUT && DECLARED_PATH === null) {
  console.info(
    `[docs links] skipping: no docs checkout with a resolvable main at ${DOCS_CANDIDATES.join(" or ")}, and ${DOCS_ENV_VAR} is unset.`,
  );
}

// --------------------------------------------------------------------------
// Local-side assertions. These run whether or not a docs checkout exists, so
// something always runs and the extractor is proved on inputs everyone has.
// --------------------------------------------------------------------------

describe("the extractor", () => {
  test("takes a path-bearing URL and leaves a bare hostname alone", () => {
    const source = [
      "See https://docs.nemar.org/platform/api/ for the surface.",
      "The docs live at https://docs.nemar.org.",
      "| Docs site | `docs.nemar.org`, in `nemarOrg/docs` | - |",
    ].join("\n");
    expect(extractDocsPaths(source)).toEqual(["/platform/api/"]);
  });

  test("strips trailing prose punctuation and Markdown wrappers", () => {
    expect(extractDocsPaths("see https://docs.nemar.org/cli/commands/.")).toEqual([
      "/cli/commands/",
    ]);
    expect(extractDocsPaths("[x](https://docs.nemar.org/web/uploading/)")).toEqual([
      "/web/uploading/",
    ]);
    expect(extractDocsPaths("<https://docs.nemar.org/policies/>")).toEqual(["/policies/"]);
  });

  test("finds nothing in a file that mentions no docs URL", () => {
    expect(extractDocsPaths("nothing to see, https://example.com/docs.nemar.org")).toEqual([]);
  });
});

describe("slug derivation", () => {
  test("maps a page, a nested index, and the root", () => {
    expect(slugFromPath("src/content/docs/platform/api.md")).toBe("platform/api");
    expect(slugFromPath("src/content/docs/platform/zarr/index.md")).toBe("platform/zarr");
    expect(slugFromPath("src/content/docs/cli/index.mdx")).toBe("cli");
    expect(slugFromPath("src/content/docs/index.mdx")).toBe("");
  });

  test("reduces a URL path to the same shape, trailing slash or not", () => {
    expect(pathToSlug("/platform/api/")).toBe("platform/api");
    expect(pathToSlug("/platform/api")).toBe("platform/api");
    expect(pathToSlug("/platform/api/index.html")).toBe("platform/api");
    expect(pathToSlug("/")).toBe("");
  });
});

describe("the declared docs checkout must exist when it is declared", () => {
  // A path named by CI that is not there means the checkout step broke. A skip
  // would hand the check back to nobody, which is exactly how the account-copy
  // parity test sat green and vacuous for months.
  test.skipIf(DECLARED_PATH === null)(`${DOCS_ENV_VAR} names a directory that is present`, () => {
    expect({ [DOCS_ENV_VAR]: DECLARED_PATH, exists: existsSync(DECLARED_PATH as string) }).toEqual({
      [DOCS_ENV_VAR]: DECLARED_PATH,
      exists: true,
    });
  });

  test.skipIf(DECLARED_PATH === null)(`${DOCS_ENV_VAR} has a resolvable main`, () => {
    expect({ path: DECLARED_PATH, ref: REF }).toEqual({ path: DECLARED_PATH, ref: REF ?? "main" });
    expect(REF).not.toBeNull();
  });
});

// --------------------------------------------------------------------------
// The comparison itself.
// --------------------------------------------------------------------------

describe.skipIf(NO_CHECKOUT)("docs pointers resolve", () => {
  const slugs = publishedSlugs(FOUND_ROOT as string, REF as string);

  test("the docs checkout publishes pages at all (guards a vacuous pass)", () => {
    // Without this, an empty slug set would make every pointer below "missing"
    // -- or, if the pointer list were also empty, would pass having compared
    // nothing at all.
    expect(slugs.size).toBeGreaterThan(0);
  });

  test("a path that is not a page does not resolve", () => {
    // The other half of the vacuity guard: a slug set that answered yes to
    // everything would also make the comparison below meaningless.
    expect(slugs.has(pathToSlug("/definitely/not/a/page/"))).toBe(false);
  });

  test("a `slug:` override is honoured, not the path it was written at", () => {
    // Stated generically rather than pinning today's one override, so it keeps
    // meaning something as the docs change. If the docs ever drop every
    // override this skips itself rather than going falsely green.
    const overrides = git(FOUND_ROOT as string, [
      "grep",
      "-n",
      "^slug:",
      REF as string,
      "--",
      "src/content/docs",
    ]);
    const declared = [...(overrides ?? "").matchAll(/:slug:\s*(.+?)\s*$/gm)].map((m) =>
      m[1].replace(/^\/+/, "").replace(/\/+$/, ""),
    );
    if (declared.length === 0) return;
    expect(declared.filter((slug) => !slugs.has(slug))).toEqual([]);
  });

  test("every referenced page exists", () => {
    const missing: string[] = [];
    for (const file of scannedFiles()) {
      for (const pathname of extractDocsPaths(readFileSync(file, "utf8"))) {
        if (NON_PAGE_EXACT.has(pathname)) continue;
        if (NON_PAGE_PREFIXES.some((p) => pathname.startsWith(p))) continue;
        // NOTE for phase 3: once the admin content moves to a private repo,
        // `/admin/*` will stop resolving in this public checkout and that will
        // be correct rather than broken. Handle it there, where there is
        // something to test against.
        if (!slugs.has(pathToSlug(pathname))) {
          missing.push(`${file.slice(REPO_ROOT.length + 1)} -> ${pathname}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
