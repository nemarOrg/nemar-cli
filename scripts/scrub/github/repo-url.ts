/**
 * Which GitHub repository a remote URL names. The switch asks it of the clone it is about to push
 * from, and the TypeScript side of the history rewrite asks it of `--expect-remote`; the rewrite
 * script keeps a port of the same pattern (`github_repo`) for the clone's own origin, and the tests
 * drive both with the same spellings.
 */

/** `owner/name`, lowercased, of a GitHub remote URL in https, ssh:// or scp form; else null. */
export function githubRepoOf(url: string): string | null {
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/:]+@)github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}
