/**
 * A git identity for the processes a test starts, through the environment.
 *
 * `git annex init` commits to the git-annex branch (merging a cloned one included), so a clone
 * that runs it fails with "Author identity unknown" where no identity is configured. CI runners
 * are such hosts; a developer machine usually has a global one, which is how a test that needs it
 * passes locally and fails in CI. The environment, never a global `git config`, so nothing
 * outside the test changes, and the import code under test keeps using whatever identity its
 * caller has (the onboard workflow configures one).
 */

const IDENTITY = {
  GIT_AUTHOR_NAME: "NEMAR Test",
  GIT_AUTHOR_EMAIL: "test@nemar.test",
  GIT_COMMITTER_NAME: "NEMAR Test",
  GIT_COMMITTER_EMAIL: "test@nemar.test",
} as const;

/**
 * Set the identity in `process.env`, which `runCommand` and `Bun.spawn` pass to their children,
 * and return the function that puts the four variables back as they were. A variable that was
 * unset is removed with `Reflect.deleteProperty`: assigning `undefined` to `process.env` stores
 * the string "undefined".
 */
export function useTestGitIdentity(): () => void {
  const saved = Object.keys(IDENTITY).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, IDENTITY);
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  };
}
