/**
 * Lines typed at the terminal, one question at a time, for a command that asks many.
 *
 * `inquirer` (see `confirm.ts`) is built for one question and refuses a stdin that is not a
 * terminal. A loop that asks "approve, close, comment?" about each of a dozen pull requests wants
 * the opposite: one reader for the whole run, so a line that arrives early is kept for the next
 * question and not lost, and an input that ends (Ctrl+D, Ctrl+C or a closed pipe) is an answer
 * the caller can see (`null`), never a hang.
 */

import { type Interface, createInterface } from "node:readline";

export class LineReader {
  private readonly rl: Interface;
  private readonly lines: string[] = [];
  private readonly waiting: Array<(line: string | null) => void> = [];
  private ended = false;
  private readonly output: NodeJS.WritableStream;

  constructor(
    input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
  ) {
    this.output = output;
    this.rl = createInterface({ input, output, terminal: input.isTTY === true });
    this.rl.on("line", (line) => {
      const next = this.waiting.shift();
      if (next) next(line);
      else this.lines.push(line);
    });
    // Ctrl+C at the prompt ends the input like Ctrl+D does: the caller stops and says what it did.
    this.rl.on("SIGINT", () => this.rl.close());
    this.rl.on("close", () => {
      this.ended = true;
      for (const next of this.waiting.splice(0)) next(null);
    });
  }

  /** Print `prompt` and return the next line typed, or null once the input has ended. */
  ask(prompt: string): Promise<string | null> {
    const queued = this.lines.shift();
    if (queued !== undefined) {
      this.output.write(`${prompt}${queued}\n`);
      return Promise.resolve(queued);
    }
    if (this.ended) return Promise.resolve(null);
    this.rl.setPrompt(prompt);
    this.rl.prompt();
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  close(): void {
    this.rl.close();
  }
}
