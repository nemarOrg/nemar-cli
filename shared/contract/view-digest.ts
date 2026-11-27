/**
 * `nemar.view-digest.v1` (neuroschema 0.6.0 `docs/views/view-digest.md`, ADR 0137 decision 9): the
 * SHA-256 of a view declaration's canonical JSON, the JSON Canonicalization Scheme (JCS) of RFC 8785,
 * and the Internet JSON (I-JSON, RFC 7493) reader every JSON text neuroschema reads goes through.
 *
 * WHY A READER OF ITS OWN. `JSON.parse` keeps the last of two members with one name, so a document with
 * a hidden duplicate reads one way here and another way in a reader that keeps the first; it accepts a
 * lone surrogate or a noncharacter, and it recurses as deep as the text nests. `readIJson` refuses each
 * of those, as the neuroschema 0.6.0 amendment of ADR 0137 requires ("Envelope rules"), and otherwise
 * reads every number as `JSON.parse` does (the binary64 nearest its text). The backend reads the
 * dataset `dataQuality` document and a recording's record with it, so it reads what a Python reader
 * reads.
 *
 * `shared/contract/neuroschema/views/vectors/view-digest.v1.json` holds the nine cases and fourteen
 * refusals every implementation reproduces; `test/view-digest-contract.unit.test.ts` replays them.
 *
 * Pure: no clock, database or network; `viewDigest` uses Web Crypto, which the Worker and Bun share.
 */

/** The deepest arrays and objects nest: the declaration object itself is 1 deep. */
export const I_JSON_MAX_DEPTH = 64;

/** Why a text is not I-JSON, a fixed word. */
export const I_JSON_REFUSALS = [
  "not_json",
  "duplicate_member",
  "lone_surrogate",
  "noncharacter",
  "too_deep",
  "not_finite",
] as const;
export type IJsonRefusal = (typeof I_JSON_REFUSALS)[number];

export type IJsonRead =
  | {
      ok: true;
      value: unknown;
      /**
       * An integer literal (no fraction, no exponent) beyond 2^53 - 1 in magnitude, which every reader
       * holds only approximately: the text is I-JSON, and a writer rule that caps integers refuses it.
       */
      unsafeInteger: boolean;
    }
  | { ok: false; reason: IJsonRefusal };

class Refusal extends Error {
  constructor(readonly reason: IJsonRefusal) {
    super(reason);
  }
}

/** Whether a code point is one of Unicode's 66 noncharacters. */
const isNoncharacter = (cp: number): boolean =>
  (cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe;

/** The refusal a string earns, or null: a lone surrogate, or a noncharacter, written or escaped. */
function stringProblem(s: string): IJsonRefusal | null {
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    let cp = unit;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (low < 0xdc00 || low > 0xdfff) return "lone_surrogate";
      cp = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return "lone_surrogate";
    }
    if (isNoncharacter(cp)) return "noncharacter";
  }
  return null;
}

const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/**
 * Read one JSON text as I-JSON: the JSON grammar (RFC 8259) with no byte order mark, no two members of
 * one object with one name however they are escaped, no lone surrogate or noncharacter in a string or a
 * member name, nothing nested more than {@link I_JSON_MAX_DEPTH} deep, and every number finite as a
 * binary64. A member named `__proto__` is an own member, as `JSON.parse` makes it.
 */
export function readIJson(text: string): IJsonRead {
  let at = 0;
  let unsafeInteger = false;

  const fail = (reason: IJsonRefusal = "not_json"): never => {
    throw new Refusal(reason);
  };
  const space = () => {
    while (at < text.length) {
      const c = text.charCodeAt(at);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) at++;
      else break;
    }
  };
  const string = (): string => {
    // at is on the opening quote.
    at++;
    let out = "";
    let run = at;
    for (;;) {
      if (at >= text.length) fail();
      const c = text.charCodeAt(at);
      if (c === 0x22) {
        out += text.slice(run, at);
        at++;
        break;
      }
      if (c < 0x20) fail();
      if (c !== 0x5c) {
        at++;
        continue;
      }
      out += text.slice(run, at);
      const e = text.charCodeAt(at + 1);
      at += 2;
      if (e === 0x22) out += '"';
      else if (e === 0x5c) out += "\\";
      else if (e === 0x2f) out += "/";
      else if (e === 0x62) out += "\b";
      else if (e === 0x66) out += "\f";
      else if (e === 0x6e) out += "\n";
      else if (e === 0x72) out += "\r";
      else if (e === 0x74) out += "\t";
      else if (e === 0x75) {
        const hex = text.slice(at, at + 4);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail();
        out += String.fromCharCode(Number.parseInt(hex, 16));
        at += 4;
      } else fail();
      run = at;
    }
    const problem = stringProblem(out);
    if (problem !== null) fail(problem);
    return out;
  };
  const value = (depth: number): unknown => {
    space();
    if (at >= text.length) fail();
    const c = text.charCodeAt(at);
    if (c === 0x7b /* { */) {
      if (depth + 1 > I_JSON_MAX_DEPTH) fail("too_deep");
      at++;
      const obj: Record<string, unknown> = {};
      const seen = new Set<string>();
      space();
      if (text.charCodeAt(at) === 0x7d) {
        at++;
        return obj;
      }
      for (;;) {
        space();
        if (text.charCodeAt(at) !== 0x22) fail();
        const key = string();
        if (seen.has(key)) fail("duplicate_member");
        seen.add(key);
        space();
        if (text.charCodeAt(at) !== 0x3a) fail();
        at++;
        const v = value(depth + 1);
        // An own data member, never the prototype setter, for every name.
        Object.defineProperty(obj, key, {
          value: v,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        space();
        const next = text.charCodeAt(at);
        at++;
        if (next === 0x2c) continue;
        if (next === 0x7d) return obj;
        fail();
      }
    }
    if (c === 0x5b /* [ */) {
      if (depth + 1 > I_JSON_MAX_DEPTH) fail("too_deep");
      at++;
      const arr: unknown[] = [];
      space();
      if (text.charCodeAt(at) === 0x5d) {
        at++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        space();
        const next = text.charCodeAt(at);
        at++;
        if (next === 0x2c) continue;
        if (next === 0x5d) return arr;
        fail();
      }
    }
    if (c === 0x22) return string();
    if (text.startsWith("true", at)) {
      at += 4;
      return true;
    }
    if (text.startsWith("false", at)) {
      at += 5;
      return false;
    }
    if (text.startsWith("null", at)) {
      at += 4;
      return null;
    }
    NUMBER_RE.lastIndex = at;
    const m = NUMBER_RE.exec(text);
    if (m === null) return fail();
    at += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) fail("not_finite");
    if (!/[.eE]/.test(m[0]) && Math.abs(n) > Number.MAX_SAFE_INTEGER) unsafeInteger = true;
    return n;
  };

  try {
    const v = value(0);
    space();
    if (at !== text.length) fail();
    return { ok: true, value: v, unsafeInteger };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, reason: err.reason };
    // A RangeError from a stack that is not deep enough for 64 levels is not reachable; anything else
    // thrown here is a bug in this reader, and is not hidden.
    throw err;
  }
}

/**
 * The RFC 8785 canonical text of a JSON value: no whitespace, members sorted by their UTF-16 code units,
 * strings with only the escapes JSON requires, numbers as ECMAScript prints them. A value the
 * declaration rules refuse (a lone surrogate or noncharacter, a number that is not finite, nesting past
 * {@link I_JSON_MAX_DEPTH}, or anything that is not JSON) throws a `RangeError` naming the refusal
 * word: `JSON.stringify` would write each of them and give a digest where there must be none.
 */
export function canonicalJson(value: unknown): string {
  const write = (v: unknown, depth: number): string => {
    if (v === null) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new RangeError("not_finite");
      // `String(-0)` is "0"; every other number prints as Number.prototype.toString does.
      return String(v);
    }
    if (typeof v === "string") {
      const problem = stringProblem(v);
      if (problem !== null) throw new RangeError(problem);
      return JSON.stringify(v);
    }
    if (depth + 1 > I_JSON_MAX_DEPTH) throw new RangeError("too_deep");
    if (Array.isArray(v)) return `[${v.map((x) => write(x, depth + 1)).join(",")}]`;
    if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `{${keys
        .map((k) => {
          const problem = stringProblem(k);
          if (problem !== null) throw new RangeError(problem);
          return `${JSON.stringify(k)}:${write(obj[k], depth + 1)}`;
        })
        .join(",")}}`;
    }
    throw new RangeError("not_json");
  };
  return write(value, 0);
}

/**
 * Lowercase hexadecimal SHA-256 of bytes. `crypto.subtle.digest` takes only bytes over an `ArrayBuffer`
 * in both the Worker's and Bun's type definitions; bytes over any other buffer are copied first.
 */
export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  const owned = (
    bytes.buffer instanceof ArrayBuffer ? bytes : bytes.slice()
  ) as Uint8Array<ArrayBuffer>;
  const digest = await crypto.subtle.digest("SHA-256", owned);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `nemar.view-digest.v1` of a declaration as written in the record: the SHA-256 of the UTF-8 bytes of
 * its canonical JSON, or a `RangeError` naming the refusal when it has none (it is not an object, or a
 * value in it is refused by {@link canonicalJson}). The declaration is read before a route adds
 * anything to it.
 */
export async function viewDigest(declaration: unknown): Promise<string> {
  if (typeof declaration !== "object" || declaration === null || Array.isArray(declaration)) {
    throw new RangeError("not_an_object");
  }
  return sha256HexOfBytes(new TextEncoder().encode(canonicalJson(declaration)));
}
