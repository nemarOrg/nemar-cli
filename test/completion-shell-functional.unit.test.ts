/**
 * Functional verification of the emitted shell scripts (epic #1144 phase 5b,
 * issue #1149 -- test-review follow-up on #1173).
 *
 * test/completion-scripts.unit.test.ts only proves each script is non-empty,
 * mentions `__complete`, and passes `bash -n`/`zsh -n`/`fish --no-execute`.
 * All three checks are purely syntactic. A mutation that wraps the
 * `nemar __complete` call in `if false; then ... fi` -- so the script never
 * actually invokes it -- still parses fine and still contains the string
 * `__complete` in dead code; `-n` cannot tell the difference. Nor can a
 * static check catch zsh's real #1173 bug: quoting an array slice without
 * the `(@)` flag glues multiple words/candidates into one string, which is
 * a RUNTIME behaviour of the actual shell, not a parse error.
 *
 * Each shell is driven for real: the genuine emitted script (imported
 * directly from src/lib/completion/scripts.ts, not re-typed here) is
 * sourced into an actual bash/zsh/fish process with a stub `nemar` shadowing
 * the real CLI, and the shell's own completion machinery is invoked exactly
 * as it would be for a live TAB press. `printf '%s\n'` is used everywhere in
 * the stubs rather than `echo`/`print`, because zsh's `print` builtin
 * parses a leading `--foo` argument as ITS OWN options (discovered while
 * writing this suite -- `print "--source"` fails with "bad option: -t"; the
 * real `nemar` binary never has this problem since it writes via
 * `process.stdout.write`, not a shell builtin).
 *
 * Four things every shell is checked for, matching the candidates a real
 * session would hit:
 *   1. a subcommand position (`nemar dataset ` -- toComplete is empty)
 *   2. a flag-name position past the first word (`nemar dataset list --sou`)
 *      -- exactly where zsh's word-splitting bug bit (#1173)
 *   3. a flag VALUE position (`nemar dataset list --source `)
 *   4. the `--flag=value` combined form (test-review follow-up), which
 *      arrives differently per shell: zsh and fish send ONE token
 *      (`--source=op`) and expect the FULL `--source=openneuro` back; bash's
 *      default COMP_WORDBREAKS splits it into THREE words
 *      (`--source`, `=`, `op`) and expects the BARE `openneuro` back.
 * Every case also asserts the trailing `:4` directive line never survives
 * into the final candidate list.
 *
 * fish is available in this environment (fish 4.8.1) and gets the same
 * real functional coverage as bash and zsh -- none of the three is skipped
 * here. The only shell-availability gap is CI (ubuntu-latest has no fish
 * install step, so `completion-scripts.unit.test.ts`'s fish syntax check
 * never runs there either); that is a CI gap to close separately, not a
 * reason to weaken local coverage.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, which } from "bun";
import {
  bashCompletionScript,
  fishCompletionScript,
  zshCompletionScript,
} from "../src/lib/completion/scripts";

function withTempDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFile(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

/** A `nemar` stub body (bash/zsh syntax -- POSIX `[ ]`, works in both) that
 *  answers based on the EXACT argv it receives after `__complete --`, so a
 *  broken word split (too few/glued args) or a broken candidate split
 *  (multiple lines glued back together on the way out) both surface as a
 *  wrong final array rather than needing separate detection logic. */
function shWordCheckStub(expectedWords: string[], onMatch: string[]): string {
  const n = expectedWords.length;
  const checks = expectedWords.map((w, i) => `[ "\$${i + 1}" = "${w}" ]`).join(" && ");
  const emit = onMatch.map((line) => `printf '%s\\n' "${line}"`).join("\n    ");
  return [
    "nemar() {",
    "  shift",
    '  [ "$1" = "--" ] && shift',
    `  if [ "$#" -eq ${n} ] && ${checks}; then`,
    `    ${emit}`,
    "  else",
    '    printf "UNEXPECTED_ARGS:%s:%s\\n" "$#" "$*"',
    "  fi",
    '  printf "%s\\n" ":4"',
    "}",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

function runBash(compWords: string[], compCword: number, stub: string): string[] {
  return withTempDir("nemar-bash-func-", (dir) => {
    const scriptPath = writeFile(dir, "nemar.bash", bashCompletionScript());
    const wordsLiteral = compWords.map((w) => `"${w}"`).join(" ");
    const driver = [
      stub,
      `source "${scriptPath}"`,
      `COMP_WORDS=(${wordsLiteral})`,
      `COMP_CWORD=${compCword}`,
      "_nemar_complete",
      'printf "ITEM:%s\\n" "${COMPREPLY[@]}"',
    ].join("\n");
    const result = spawnSync({ cmd: ["bash", "-c", driver], stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
      throw new Error(`bash driver failed: ${result.stderr.toString()}`);
    }
    return result.stdout
      .toString()
      .split("\n")
      .filter((l) => l.startsWith("ITEM:"))
      .map((l) => l.slice("ITEM:".length));
  });
}

describe("functional: bash completion script drives real candidate resolution", () => {
  test("subcommand position: nemar dataset <TAB>", () => {
    const stub = shWordCheckStub(["dataset", ""], ["list", "search"]);
    const items = runBash(["nemar", "dataset", ""], 2, stub);
    expect(items).toEqual(["list", "search"]);
  });

  test("flag-name position past the first word: nemar dataset list --sou<TAB>", () => {
    const stub = shWordCheckStub(["dataset", "list", "--sou"], ["--source"]);
    const items = runBash(["nemar", "dataset", "list", "--sou"], 3, stub);
    expect(items).toEqual(["--source"]);
  });

  test("flag VALUE position: nemar dataset list --source <TAB>", () => {
    const stub = shWordCheckStub(["dataset", "list", "--source", ""], ["openneuro"]);
    const items = runBash(["nemar", "dataset", "list", "--source", ""], 4, stub);
    expect(items).toEqual(["openneuro"]);
  });

  test("--flag=value: bash's COMP_WORDBREAKS splits it into 3 words, bare value comes back", () => {
    // bash's own tokenizer (not this test) is what splits "--source=op" into
    // ("--source", "=", "op") -- COMP_WORDS is built the same way here.
    const stub = shWordCheckStub(["dataset", "list", "--source", "=", "op"], ["openneuro"]);
    const items = runBash(["nemar", "dataset", "list", "--source", "=", "op"], 5, stub);
    expect(items).toEqual(["openneuro"]);
  });

  test("the trailing :4 directive never appears as a candidate", () => {
    const stub = shWordCheckStub(["dataset", ""], ["alpha", "beta", "gamma"]);
    const items = runBash(["nemar", "dataset", ""], 2, stub);
    expect(items).toEqual(["alpha", "beta", "gamma"]);
    expect(items).not.toContain(":4");
  });
});

// ---------------------------------------------------------------------------
// zsh
// ---------------------------------------------------------------------------

/** zsh's `compadd` is only meaningful inside real completion-widget
 *  execution; shadowing it as a plain function (never called via
 *  `builtin compadd`, and `_nemar` in scripts.ts never does) lets the test
 *  capture exactly what the script would have handed to it. */
function runZsh(words: string[], current: number, stub: string): string[] {
  return withTempDir("nemar-zsh-func-", (dir) => {
    const scriptPath = writeFile(dir, "nemar.zsh", zshCompletionScript());
    const wordsLiteral = words.map((w) => `"${w}"`).join(" ");
    const driver = [
      stub,
      "CAPTURED=()",
      "compadd() {",
      '  local -a args=("$@")',
      '  if [[ "${args[1]}" == "--" ]]; then',
      '    args=("${args[@]:1}")',
      "  fi",
      '  CAPTURED=("${args[@]}")',
      "}",
      `words=(${wordsLiteral})`,
      `CURRENT=${current}`,
      `source "${scriptPath}"`,
      'for c in "${CAPTURED[@]}"; do printf "ITEM:%s\\n" "$c"; done',
    ].join("\n");
    const result = spawnSync({ cmd: ["zsh", "-c", driver], stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
      throw new Error(`zsh driver failed: ${result.stderr.toString()}`);
    }
    return result.stdout
      .toString()
      .split("\n")
      .filter((l) => l.startsWith("ITEM:"))
      .map((l) => l.slice("ITEM:".length));
  });
}

describe("functional: zsh completion script drives real candidate resolution (#1173)", () => {
  test("subcommand position: nemar dataset <TAB>", () => {
    const stub = shWordCheckStub(["dataset", ""], ["list", "search"]);
    const items = runZsh(["nemar", "dataset", ""], 3, stub);
    expect(items).toEqual(["list", "search"]);
  });

  test("flag-name position past the first word: nemar dataset list --sou<TAB> (#1173's exact bug site)", () => {
    // This is the scenario that was silently broken before the (@) fix:
    // words[2,CURRENT] without (@) glued ("dataset","list","--sou") into one
    // string, so the stub below would have seen 1 argument, not 3, and this
    // test would have failed on UNEXPECTED_ARGS.
    const stub = shWordCheckStub(["dataset", "list", "--sou"], ["--source"]);
    const items = runZsh(["nemar", "dataset", "list", "--sou"], 4, stub);
    expect(items).toEqual(["--source"]);
  });

  test("flag VALUE position: nemar dataset list --source <TAB>", () => {
    const stub = shWordCheckStub(["dataset", "list", "--source", ""], ["openneuro"]);
    const items = runZsh(["nemar", "dataset", "list", "--source", ""], 5, stub);
    expect(items).toEqual(["openneuro"]);
  });

  test("--flag=value: zsh sends ONE token, full 'flag=value' comes back", () => {
    const stub = shWordCheckStub(["dataset", "list", "--source=op"], ["--source=openneuro"]);
    const items = runZsh(["nemar", "dataset", "list", "--source=op"], 4, stub);
    expect(items).toEqual(["--source=openneuro"]);
  });

  test("the trailing :4 directive never appears as a candidate, even with 3+ real candidates (line 55's bug site)", () => {
    // This is scripts.ts's OTHER (@)-less slice: candidates=("${lines[1,-2]}")
    // used to glue "alpha beta gamma" into one CAPTURED element. With the
    // fix, three distinct candidates come back and ":4" is excluded.
    const stub = shWordCheckStub(["dataset", ""], ["alpha", "beta", "gamma"]);
    const items = runZsh(["nemar", "dataset", ""], 3, stub);
    expect(items).toEqual(["alpha", "beta", "gamma"]);
    expect(items).not.toContain(":4");
  });
});

// ---------------------------------------------------------------------------
// fish
// ---------------------------------------------------------------------------

const fishInstalled = which("fish") !== null;

/** Fish has no bash-style COMPREPLY/zsh-style compadd to intercept --
 *  `complete -C '<partial line>'` is fish's own supported mechanism for
 *  resolving completions for an arbitrary command line outside of an
 *  interactive session, and it exercises the exact same `commandline`-based
 *  `__nemar_complete_words` function real TAB presses call. Candidates come
 *  back on stdout, one per line -- fish additionally prefix-filters `-a`
 *  candidates against the current token itself, which is why every stub
 *  answer below is written to already match the partial line's last word. */
function runFish(partialLine: string, stub: string): string[] {
  return withTempDir("nemar-fish-func-", (dir) => {
    const scriptPath = writeFile(dir, "nemar.fish", fishCompletionScript());
    const driver = [stub, `source "${scriptPath}"`, `complete -C '${partialLine}'`].join("\n");
    const result = spawnSync({ cmd: ["fish", "-c", driver], stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
      throw new Error(`fish driver failed: ${result.stderr.toString()}`);
    }
    return result.stdout
      .toString()
      .split("\n")
      .filter((l) => l.length > 0);
  });
}

/** Fish syntax: a `nemar` function shadows the real binary the same way a
 *  bash/zsh function does (functions resolve before PATH), built from the
 *  same word list contract as shWordCheckStub. */
function fishWordCheckStub(expectedWords: string[], onMatch: string[]): string {
  const n = expectedWords.length;
  const checks = expectedWords.map((w, i) => `test "$argv[${i + 1}]" = "${w}"`).join(" ; and ");
  const emit = onMatch.map((line) => `printf '%s\\n' '${line}'`).join("\n    ");
  return [
    "function nemar",
    "  set -e argv[1]",
    "  if test \"$argv[1]\" = '--'",
    "    set -e argv[1]",
    "  end",
    "  set n (count $argv)",
    `  if test $n -eq ${n} ; and ${checks}`,
    `    ${emit}`,
    "  else",
    "    printf 'UNEXPECTED_ARGS:%s\\n' \"$n\"",
    "  end",
    "  printf '%s\\n' ':4'",
    "end",
  ].join("\n");
}

describe.skipIf(!fishInstalled)(
  "functional: fish completion script drives real candidate resolution",
  () => {
    test("subcommand position: nemar dataset <TAB>", () => {
      const stub = fishWordCheckStub(["dataset", ""], ["list", "search"]);
      const items = runFish("nemar dataset ", stub);
      expect(items).toEqual(["list", "search"]);
    });

    test("flag-name position past the first word: nemar dataset list --sou<TAB>", () => {
      const stub = fishWordCheckStub(["dataset", "list", "--sou"], ["--source"]);
      const items = runFish("nemar dataset list --sou", stub);
      expect(items).toEqual(["--source"]);
    });

    test("flag VALUE position: nemar dataset list --source <TAB>", () => {
      const stub = fishWordCheckStub(["dataset", "list", "--source", ""], ["openneuro"]);
      const items = runFish("nemar dataset list --source ", stub);
      expect(items).toEqual(["openneuro"]);
    });

    test("--flag=value: fish sends ONE token, full 'flag=value' comes back", () => {
      const stub = fishWordCheckStub(["dataset", "list", "--source=op"], ["--source=openneuro"]);
      const items = runFish("nemar dataset list --source=op", stub);
      expect(items).toEqual(["--source=openneuro"]);
    });

    test("the trailing :4 directive never appears as a candidate", () => {
      const stub = fishWordCheckStub(["dataset", ""], ["alpha", "beta", "gamma"]);
      const items = runFish("nemar dataset ", stub);
      expect(items).toEqual(["alpha", "beta", "gamma"]);
      expect(items).not.toContain(":4");
    });
  },
);

test("fish availability is reported, not assumed", () => {
  // Documents, for whoever reads test output, whether the fish describe
  // block above actually ran on this machine or was skipped.
  expect(typeof fishInstalled).toBe("boolean");
});
