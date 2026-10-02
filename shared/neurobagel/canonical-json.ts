/**
 * Canonical JSON writer for Neurobagel artifacts.
 *
 * Byte-stable output is a contract: the same input must produce the same bytes
 * on every run, so a writer can skip an unchanged object and a diff of two
 * builds shows only real changes.
 * Object keys are sorted (UTF-16 code unit order, which equals code point order
 * for every key this module writes), indentation is two spaces, arrays keep the
 * order the caller built, and the document ends with one newline.
 *
 * `JsonFloat` exists because `JSON.stringify(20.0)` prints `20`.
 * Neurobagel's own CLI is Python, which prints `20.0` for a float, and
 * JSON-LD reads `20` as an integer and `20.0` as a double, so a graph loaded
 * from this writer would otherwise hold different literal types than one
 * loaded from `bagel pheno`.
 * `hasAge` is the one field that wraps its value.
 *
 * Pure: no I/O, no Node-only APIs.
 */

/** A finite number that must print with a decimal point (`20.0`, never `20`). */
export class JsonFloat {
  constructor(readonly value: number) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`JsonFloat needs a finite number, got ${value}`);
    }
  }
}

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | JsonFloat
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue | undefined };

function formatFloat(value: number): string {
  const text = String(value);
  // String(1e21) is "1e+21" and String(1e-7) is "1e-7": exponent forms are valid
  // JSON and already read as doubles, so only the plain integral form needs ".0".
  return /^-?\d+$/.test(text) ? `${text}.0` : text;
}

function write(value: CanonicalJsonValue, indent: string): string {
  if (value === null) return "null";
  if (value instanceof JsonFloat) return formatFloat(value.value);
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new RangeError(`cannot write a non-finite number: ${value}`);
      }
      return String(value);
    case "string":
      return JSON.stringify(value);
  }
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => `${inner}${write(item, inner)}`);
    return `[\n${items.join(",\n")}\n${indent}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  if (keys.length === 0) return "{}";
  const members = keys.map((key) => {
    const member = value[key] as CanonicalJsonValue;
    return `${inner}${JSON.stringify(key)}: ${write(member, inner)}`;
  });
  return `{\n${members.join(",\n")}\n${indent}}`;
}

/** Serialize with sorted keys and two-space indent, ending in a newline. */
export function canonicalJson(value: CanonicalJsonValue): string {
  return `${write(value, "")}\n`;
}
