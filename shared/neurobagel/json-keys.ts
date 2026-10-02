/**
 * Key problems that `JSON.parse` hides.
 *
 * `JSON.parse` keeps the LAST of two equal keys without a word.
 * In a reviewed file that is a hazard: two entries for one dataset, two column blocks for one
 * column, or one raw value listed twice in a level map would silently become one, and which one
 * depends on the order of lines nobody reads.
 * `__proto__` is the other quiet one: as an object key it can be dropped or can reach a
 * prototype, depending on who reads it.
 * This scanner reads the text of a document that `JSON.parse` already accepted and reports both,
 * with the path of the key.
 *
 * Pure: no I/O.
 */

export interface KeyProblems {
  /** Paths of keys that appear twice in one object, like `/datasets/nm000103`. */
  duplicates: string[];
  /** Paths of keys named `__proto__`. */
  protoKeys: string[];
}

/** Scan JSON text that is known to be valid JSON. */
export function scanKeys(text: string): KeyProblems {
  const problems: KeyProblems = { duplicates: [], protoKeys: [] };
  let at = 0;

  const skipSpace = (): void => {
    while (at < text.length && " \t\n\r".includes(text[at])) at++;
  };

  /** Read the string literal at `at` (which is its opening quote) and return its value. */
  const readString = (): string => {
    const start = at;
    at++;
    while (text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
    at++;
    return JSON.parse(text.slice(start, at)) as string;
  };

  const readValue = (path: string): void => {
    skipSpace();
    const first = text[at];
    if (first === "{") {
      at++;
      const seen = new Set<string>();
      skipSpace();
      if (text[at] === "}") {
        at++;
        return;
      }
      for (;;) {
        skipSpace();
        const key = readString();
        const here = `${path}/${key}`;
        if (seen.has(key)) problems.duplicates.push(here);
        seen.add(key);
        if (key === "__proto__") problems.protoKeys.push(here);
        skipSpace();
        at++; // the colon
        readValue(here);
        skipSpace();
        if (text[at] === ",") {
          at++;
          continue;
        }
        at++; // the closing brace
        return;
      }
    }
    if (first === "[") {
      at++;
      skipSpace();
      if (text[at] === "]") {
        at++;
        return;
      }
      for (let index = 0; ; index++) {
        readValue(`${path}/${index}`);
        skipSpace();
        if (text[at] === ",") {
          at++;
          continue;
        }
        at++; // the closing bracket
        return;
      }
    }
    if (first === '"') {
      readString();
      return;
    }
    // A number, `true`, `false` or `null`: read to the next structural character.
    while (at < text.length && !",]} \t\n\r".includes(text[at])) at++;
  };

  readValue("");
  return problems;
}
