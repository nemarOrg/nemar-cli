/**
 * Run code with git speaking German, for a test that shows an outcome is read from a status and
 * never from git's message.
 *
 * Such a case asserts nothing unless git really speaks German: without the de_DE.UTF-8 locale, or
 * without git's German catalog, git falls back to English and the case passes on English. So the
 * locale is checked first, by asking git something whose answer differs from the C locale's. Where
 * git does not speak German, the case FAILS under `NEMAR_REQUIRE_SCRUB_TOOLS=1`, which the CI jobs
 * that install the language pack (it carries both) set, and elsewhere runs in English after a
 * warning, as a missing tool skips (test/scrub/helpers/require-tools.ts says why it is not `CI`).
 */

import { REQUIRE_TOOLS } from "../scrub/helpers/require-tools";

const GERMAN = { LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8", LANGUAGE: "de" } as const;
const KEYS = ["LC_ALL", "LANG", "LANGUAGE"] as const;

let speaks: boolean | undefined;

/** Whether git answers in German under GERMAN: its word for an unknown command is not C's. */
export function gitSpeaksGerman(): boolean {
  if (speaks === undefined) {
    const ask = (locale: Record<string, string>) =>
      Bun.spawnSync(["git", "-c", "help.autocorrect=0", "no-such-command-probe"], {
        env: { ...process.env, ...locale },
        stdout: "pipe",
        stderr: "pipe",
      }).stderr.toString();
    speaks = ask({ LC_ALL: "C", LANG: "C", LANGUAGE: "" }) !== ask(GERMAN);
  }
  return speaks;
}

/**
 * Run `fn` with git speaking German. The variables are set on this process, which the code under
 * test spawns git from, and restored with Reflect.deleteProperty: assigning undefined to
 * process.env stores the string "undefined".
 */
export async function inGerman<T>(fn: () => Promise<T>): Promise<T> {
  if (!gitSpeaksGerman()) {
    const why =
      "git does not speak German here (no de_DE.UTF-8 locale, or no German catalog for git), so a case run in German would assert nothing";
    if (REQUIRE_TOOLS) {
      throw new Error(`NEMAR_REQUIRE_SCRUB_TOOLS=1 and ${why}; install language-pack-de-base`);
    }
    console.warn(`NOT IN GERMAN: ${why}. It runs in English.`);
  }
  const saved = KEYS.map((k) => process.env[k]);
  Object.assign(process.env, GERMAN);
  try {
    return await fn();
  } finally {
    KEYS.forEach((k, i) => {
      const v = saved[i];
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    });
  }
}
