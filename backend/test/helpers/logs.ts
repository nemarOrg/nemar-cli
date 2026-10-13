// Capture what code logs through console.warn and console.error, so a test can prove a log line
// carries only ids and closed words. Observation only: the code under test runs unchanged, and both
// functions are restored whatever happens.

/** Run `fn` and return every line it logged through console.warn or console.error. */
export async function logged(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const { warn, error } = console;
  const take = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.warn = take;
  console.error = take;
  try {
    await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
  return lines;
}
