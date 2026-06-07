/**
 * `nemar doctor` — environment check.
 *
 * Reports which external tools NEMAR needs (git, git-annex, gh, aws, deno) are
 * installed, their versions, and platform-specific install commands for the
 * missing ones. Diagnostic only: always exits 0.
 */
import chalk from "chalk";
import { Command } from "commander";
import { checkAllTools } from "../lib/prerequisites.js";

export async function doctorAction(): Promise<void> {
  const tools = await checkAllTools();

  console.log(chalk.bold("\nNEMAR environment check\n"));
  const runtime = process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`;
  console.log(chalk.dim(`  Runtime: ${runtime} on ${process.platform}/${process.arch}\n`));

  let ready = 0;
  for (const t of tools) {
    const mark = t.available ? chalk.green("✓") : chalk.red("✗");
    const status = t.available ? (t.version ?? "ok") : chalk.red("missing");
    console.log(
      `  ${mark} ${t.name.padEnd(16)} ${String(status).padEnd(12)} ${chalk.dim(t.purpose)}`,
    );
    if (t.available) {
      ready++;
    } else {
      console.log(`      ${chalk.yellow("Install")}: ${t.installInstruction}`);
    }
  }

  const missingRequired = tools.filter((t) => !t.available && t.required);
  console.log("");
  if (missingRequired.length === 0) {
    console.log(chalk.green(`All ${tools.length} required tools are installed.`));
  } else {
    console.log(
      `${ready}/${tools.length} tools installed. Install the ${missingRequired.length} missing one(s) above, then re-run ${chalk.cyan("nemar doctor")}.`,
    );
    console.log(
      chalk.dim(
        "Bun is the CLI runtime; the tools above are needed for upload, validation, and download.",
      ),
    );
  }
  console.log("");
}

export const doctorCommand = new Command("doctor")
  .description("Check that required tools (git, git-annex, gh, aws, deno) are installed")
  .action(doctorAction);
