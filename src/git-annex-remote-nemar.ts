#!/usr/bin/env bun
/**
 * git-annex-remote-nemar: the git-annex special remote for an authenticated NEMAR data host.
 *
 * git-annex runs this program for a remote declared with `externaltype=nemar` and talks to it
 * on stdin and stdout (ADR 0114). Everything is in `src/lib/data-host-remote.ts`; this file
 * only connects the process's streams to it. stdout carries the protocol and nothing else.
 */

import { getConfig } from "./lib/config.js";
import { runRemote } from "./lib/data-host-remote.js";

async function* stdinLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      yield buffer.slice(0, at).replace(/\r$/, "");
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer !== "") yield buffer;
}

const out = Bun.stdout.writer();

const code = await runRemote(
  {
    lines: stdinLines(),
    send: async (line) => {
      out.write(`${line}\n`);
      await out.flush();
    },
  },
  { loadApiKey: () => getConfig().apiKey || undefined },
);

await out.end();
process.exit(code);
