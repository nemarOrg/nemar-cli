/**
 * `nemar completion` -- shell completion scripts and the explicit cache
 * refresh (epic #1144 phase 5b, issue #1149).
 *
 * `__complete` itself is NOT registered here or anywhere on `program`: per
 * D1, it is handled by a guard at the very top of src/index.ts's `main()`,
 * before `initUpdateCheck()`, and returns without ever calling
 * `program.parseAsync()`. Registering it as a normal Commander command would
 * let it fall through to the `preAction` hook (the `GET /notices` call) and
 * blow the completion latency budget -- see src/lib/completion/run.ts.
 */

import chalk from "chalk";
import { Command } from "commander";
import { ApiError } from "../lib/api/errors.js";
import { refreshCompletionCache } from "../lib/completion/refresh.js";
import {
  bashCompletionScript,
  fishCompletionScript,
  zshCompletionScript,
} from "../lib/completion/scripts.js";

export const completionCommand = new Command("completion").description(
  "Print a shell completion script, or refresh cached dynamic candidates",
);

completionCommand
  .command("bash")
  .description("Print the bash completion script")
  .action(() => {
    process.stdout.write(bashCompletionScript());
  });

completionCommand
  .command("zsh")
  .description("Print the zsh completion script")
  .action(() => {
    process.stdout.write(zshCompletionScript());
  });

completionCommand
  .command("fish")
  .description("Print the fish completion script")
  .action(() => {
    process.stdout.write(fishCompletionScript());
  });

completionCommand
  .command("refresh")
  .description("Refresh the cached dynamic completion candidates (task, license, ...)")
  .action(async () => {
    try {
      await refreshCompletionCache();
      console.log(chalk.green("Completion cache refreshed."));
    } catch (error) {
      const message = error instanceof ApiError ? error.message : (error as Error).message;
      console.log(chalk.red(`Failed to refresh completion cache: ${message}`));
      process.exit(1);
    }
  });

completionCommand.addHelpText(
  "after",
  `
Description:
  Tab completion for subcommands, flags, and facet vocabularies. Subcommand
  names, flags, and the enum flags with a fixed declared vocabulary
  (--source, --zarr, --powerline) always complete -- they need no network
  and no cache.

  --electrode-system also always completes from its declared six values,
  but it is the one flag with BOTH: once a cache exists it completes from
  the catalog instead, which can be a superset.

  --task, --modality, --license, and --bids-version complete from the real
  catalog instead, which needs a cache this command (or a successful
  'nemar dataset list'/'nemar dataset search') has to fill first. Until
  then, those flags simply offer nothing -- not an error.

Setup:
  Bash:  echo 'source <(nemar completion bash)' >> ~/.bashrc
  Zsh:   nemar completion zsh > "\${fpath[1]}/_nemar"   (then restart your shell)
  Fish:  nemar completion fish > ~/.config/fish/completions/nemar.fish

Examples:
  $ nemar completion bash
  $ nemar completion refresh`,
);
