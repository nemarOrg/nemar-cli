/**
 * git-annex's side of the special remote protocol, over the real child process
 * (`src/git-annex-remote-nemar.ts`, or a built bundle): a test sends the lines git-annex would
 * and reads the lines it would get back. `useSessions` stops every session a test left running.
 */

import { afterEach, expect } from "bun:test";
import { join } from "node:path";
import { cliBaseEnv } from "./nemar-account";

export const REMOTE = join(import.meta.dir, "..", "..", "src", "git-annex-remote-nemar.ts");
export const DATASET = "np099999";

export interface SessionOptions {
  /** `NEMAR_DATA_HOSTS` for the process; `ready()` uses it as the configured host. */
  hosts: string;
  /** `NEMAR_CONFIG_DIR`. */
  config: string;
  /** The program to run with `bun run`: the TypeScript entry by default, or a built bundle. */
  entry?: string;
  /** More environment, such as `NEMAR_DATA_HOST_TIMEOUT_MS`. */
  env?: Record<string, string>;
}

/** git-annex's side of the conversation, over the real child process. */
export class Session {
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private readonly queue: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;
  private ended = false;
  /** Everything the process wrote on stdout, in order. */
  readonly transcript: string[] = [];
  private stderrText: Promise<string>;
  private pump: Promise<void>;

  private readonly hosts: string;

  constructor(options: SessionOptions) {
    this.hosts = options.hosts;
    this.proc = Bun.spawn(["bun", "run", options.entry ?? REMOTE], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...cliBaseEnv(),
        NEMAR_CONFIG_DIR: options.config,
        NEMAR_DATA_HOSTS: options.hosts,
        NEMAR_NO_UPDATE_CHECK: "1",
        ...options.env,
      },
    });
    this.stderrText = new Response(this.proc.stderr as ReadableStream).text();
    this.pump = this.read();
  }

  private async read(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        this.push(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf("\n");
      }
    }
    if (buffer !== "") this.push(buffer);
    this.ended = true;
    this.waiter?.(null);
  }

  private push(line: string): void {
    this.transcript.push(line);
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(line);
    } else {
      this.queue.push(line);
    }
  }

  send(line: string): void {
    const stdin = this.proc.stdin as { write: (s: string) => number; flush: () => unknown };
    stdin.write(`${line}\n`);
    stdin.flush();
  }

  /** The next line git-annex would read; fails the test when none comes in time. */
  async next(timeoutMs = 20_000): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    if (this.ended) throw new Error("the remote closed its output");
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`no line from the remote within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiter = (line) => {
        clearTimeout(timer);
        if (line === null) reject(new Error("the remote closed its output"));
        else resolve(line);
      };
    });
  }

  /** Read lines until one starts with `prefix`; the lines before it are returned too. */
  async until(prefix: string): Promise<{ line: string; before: string[] }> {
    const before: string[] = [];
    while (true) {
      const line = await this.next();
      if (line.startsWith(prefix)) return { line, before };
      before.push(line);
    }
  }

  /** Answer the GETCONFIG requests of INITREMOTE or PREPARE and return the final reply. */
  async configure(command: "INITREMOTE" | "PREPARE", hostValue: string, dataset: string) {
    this.send(command);
    const answers: Record<string, string> = { host: hostValue, dataset };
    for (let i = 0; i < 2; i++) {
      const request = await this.next();
      const name = request.replace(/^GETCONFIG /, "");
      expect(request.startsWith("GETCONFIG ")).toBe(true);
      this.send(`VALUE ${answers[name] ?? ""}`);
    }
    return await this.next();
  }

  /** The first line, then PREPARE with the configured host. */
  async ready(hostValue = this.hosts, dataset = DATASET): Promise<void> {
    expect(await this.next()).toBe("VERSION 1");
    expect(await this.configure("PREPARE", hostValue, dataset)).toBe("PREPARE-SUCCESS");
  }

  /** Close git-annex's side and wait for the process; returns its exit code and stderr. */
  async close(): Promise<{ code: number; stderr: string }> {
    (this.proc.stdin as { end: () => unknown }).end();
    const code = await this.proc.exited;
    await this.pump;
    return { code, stderr: await this.stderrText };
  }

  /** Stop the process whatever state it is in (for cleanup; harmless after `close`). */
  async dispose(): Promise<void> {
    try {
      (this.proc.stdin as { end: () => unknown }).end();
    } catch {}
    this.proc.kill();
    await this.proc.exited;
    await this.pump;
  }

  async everything(): Promise<string> {
    const { stderr } = await this.close();
    return `${this.transcript.join("\n")}\n${stderr}`;
  }
}

/**
 * Register cleanup for the sessions a test file opens. Call once at the top level of the file
 * (or of a describe) and open sessions through the function it returns.
 */
export function useSessions(): (options: SessionOptions) => Session {
  const open: Session[] = [];
  afterEach(async () => {
    for (const session of open.splice(0)) await session.dispose();
  });
  return (options) => {
    const session = new Session(options);
    open.push(session);
    return session;
  };
}
