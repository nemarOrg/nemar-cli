/**
 * A streaming reader for version manifests (`<id>/version/v<X>.json`), #1502.
 *
 * WHY THIS EXISTS. The data plane used to read a manifest whole into a string
 * and `JSON.parse` it on every request. nm000281's v1.0.3 manifest is
 * 42,849,468 bytes and about 102,000 entries; the string alone is a third of
 * a 128 MB isolate and the parsed object graph is several times the string,
 * so every file request for that dataset died with `exceededMemory`, taking
 * every other request in the isolate with it.
 *
 * This module reads the body as a stream, tokenizes it incrementally, and
 * builds a JavaScript value ONLY for what a caller asks for. The caller is a
 * {@link FilesVisitor}: it sees every entry's path under `files` and decides,
 * per entry, whether that entry's value is worth building. Everything else is
 * tokenized and discarded, so the memory a scan holds is the answer plus one
 * decoded chunk, not the document.
 *
 * THE CONTRACT IS `JSON.parse`, not "JSON". A scan must reach exactly the
 * verdict `JSON.parse(await response.text())` would have, because the routes
 * it replaced were written against that and their tests pin it:
 *
 *  - The bytes are decoded the way `Response.text()` decodes them: UTF-8, a
 *    leading byte-order mark stripped, invalid sequences replaced by U+FFFD
 *    (a `TextDecoder` with its defaults, fed with `stream: true`).
 *  - The grammar is ECMA-404 as `JSON.parse` applies it: only space, tab, LF
 *    and CR are whitespace, a raw control character inside a string is an
 *    error, `\u` escapes are code units (a lone surrogate is legal), numbers
 *    have no leading zeros, and nothing but whitespace may follow the value.
 *  - A value that IS built is built the way `JSON.parse` builds it: a later
 *    duplicate key replaces an earlier one's value in place, and `__proto__`
 *    becomes an own property rather than a prototype.
 *  - A document that is not valid JSON anywhere, including after the entry a
 *    caller was looking for, is reported as malformed. A scan never stops at
 *    the answer: a manifest truncated in its last kilobyte is a broken
 *    manifest, and answering from its first 40 MB would be a partial answer
 *    presented as complete.
 *
 * The shape checks `loadManifest` applied after parsing are applied here too:
 * the document must be an object whose LAST `files` member is an object or an
 * array (an array was never written, but `typeof [] === "object"` let one
 * through, so it still does, with its indices as paths).
 *
 * What it costs: the whole body is still tokenized on every scan, because the
 * verdict above needs the last byte. That is CPU proportional to the manifest
 * (measured in `manifest-scan.test.ts`), which is the stopgap the issue named;
 * a per-directory index written at publication is the follow-up that removes it.
 *
 * Pure JavaScript, no WebAssembly (ADR 0050), no dependencies.
 */

/** A manifest that is not valid JSON. Carries `JSON.parse`-like wording. */
export class ManifestSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestSyntaxError";
  }
}

/**
 * The receiver of a scan. `key` is called for every entry of the manifest's
 * `files` object, in document order; returning `true` asks for that entry's
 * value to be built and handed to `value` once it is complete. `reset` is
 * called when a `files` member starts, so a document with two of them (which
 * `JSON.parse` resolves by keeping the last) leaves the visitor holding only
 * the last one's entries.
 */
export interface FilesVisitor {
  reset(): void;
  key(path: string): boolean;
  value(path: string, value: unknown): void;
}

/** Top-level manifest fields that are kept on every scan. They are small. */
export const MANIFEST_HEADER_FIELDS = [
  "dataset_id",
  "version",
  "doi",
  "concept_doi",
  "created",
] as const;

export type ManifestHeaderField = (typeof MANIFEST_HEADER_FIELDS)[number];

/**
 * The top-level fields of a scanned manifest, typed as the document CLAIMS
 * them. Nothing validates them, exactly as nothing validated them when
 * `loadManifest` cast `JSON.parse`'s result to `VersionManifest`: a field
 * the document omits is `undefined` at runtime whatever this type says, and
 * the callers already handled that (e.g. `toHttpDate`).
 */
export interface ManifestHeader {
  dataset_id: string;
  version: string;
  doi: string | null;
  concept_doi: string | null;
  created: string;
}

export type ScanResult =
  | { kind: "ok"; header: ManifestHeader }
  | { kind: "malformed"; message: string }
  | { kind: "no_files" };

const HEADER_FIELD_SET: ReadonlySet<string> = new Set(MANIFEST_HEADER_FIELDS);

// Character codes.
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const QUOTE = 0x22;
const COMMA = 0x2c;
const MINUS = 0x2d;
const PLUS = 0x2b;
const DOT = 0x2e;
const SLASH = 0x2f;
const DIGIT_0 = 0x30;
const DIGIT_1 = 0x31;
const DIGIT_9 = 0x39;
const COLON = 0x3a;
const UPPER_E = 0x45;
const LBRACKET = 0x5b;
const BACKSLASH = 0x5c;
const RBRACKET = 0x5d;
const LOWER_B = 0x62;
const LOWER_E = 0x65;
const LOWER_F = 0x66;
const LOWER_N = 0x6e;
const LOWER_R = 0x72;
const LOWER_T = 0x74;
const LOWER_U = 0x75;
const LBRACE = 0x7b;
const RBRACE = 0x7d;

// What a value at a given position becomes.
/** Tokenized and discarded. */
const SKIP = 0;
/** Built into a JavaScript value and delivered to the parent. */
const BUILD = 1;
/** The value of a top-level `files` key. */
const FILES_SLOT = 2;
/** The document's top-level value. */
const TOP = 3;

// Frame roles (what a container's members are).
const ROLE_SKIP = 0;
const ROLE_BUILD = 1;
/** The top-level object: header fields, `files`, and everything else. */
const ROLE_ROOT = 2;
/** The `files` container: every member is an entry for the visitor. */
const ROLE_FILES = 3;

const KIND_OBJECT = 0;
const KIND_ARRAY = 1;

// Container states.
const OBJ_KEY_OR_END = 0;
const OBJ_KEY = 1;
const OBJ_COLON = 2;
const OBJ_VALUE = 3;
const OBJ_COMMA_OR_END = 4;
const ARR_VALUE_OR_END = 5;
const ARR_VALUE = 6;
const ARR_COMMA_OR_END = 7;

// Document states outside any container.
const DOC_BEFORE = 0;
const DOC_IN = 1;
const DOC_DONE = 2;

// Token in progress, when a chunk ended inside one.
const LEX_NONE = 0;
const LEX_STRING = 1;
const LEX_NUMBER = 2;
const LEX_LITERAL = 3;

// Number sub-states (ECMA-404 number grammar).
const NUM_MINUS = 0;
const NUM_ZERO = 1;
const NUM_INT = 2;
const NUM_DOT = 3;
const NUM_FRAC = 4;
const NUM_EXP = 5;
const NUM_EXP_SIGN = 6;
const NUM_EXP_DIGITS = 7;

// The `files` member's verdict, for the shape check.
const FILES_ABSENT = 0;
const FILES_CONTAINER = 1;
const FILES_NOT_CONTAINER = 2;

interface Frame {
  kind: number;
  state: number;
  role: number;
  /** The value under construction, for ROLE_BUILD frames. */
  built: Record<string, unknown> | unknown[] | null;
  /** The current member's key (objects) or index as a string (files arrays). */
  key: string;
  /** What the current member's value becomes. */
  child: number;
  /** The next element's index, which is its path in a `files` array. */
  index: number;
}

/**
 * Add a member the way `JSON.parse` does (CreateDataProperty): an own data
 * property, replacing an earlier value for the same key in place. Plain
 * assignment would do that for every key except `__proto__`, where it would
 * set the prototype instead.
 */
export function defineJsonMember(target: Record<string, unknown>, key: string, value: unknown) {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

function hexValue(c: number): number {
  if (c >= DIGIT_0 && c <= DIGIT_9) return c - DIGIT_0;
  const lower = c | 0x20;
  if (lower >= 0x61 && lower <= 0x66) return lower - 0x61 + 10;
  return -1;
}

function describeChar(c: number): string {
  return c < SPACE ? `\\u${c.toString(16).padStart(4, "0")}` : String.fromCharCode(c);
}

/**
 * The incremental tokenizer. Feed it decoded text with {@link write}, then
 * call {@link end}; either throws {@link ManifestSyntaxError} on the first
 * byte `JSON.parse` would reject. {@link result} then reports the shape
 * verdict and the header.
 */
export class ManifestScanner {
  private readonly visitor: FilesVisitor;
  private readonly stack: Frame[] = [];
  private top: Frame | null = null;
  private doc = DOC_BEFORE;
  private topIsObject = false;
  private files = FILES_ABSENT;
  private readonly header: Record<string, unknown> = {};
  /** Characters consumed so far, for error positions. */
  private offset = 0;

  private lex = LEX_NONE;
  // String token state.
  private strIsKey = false;
  private strCapture = false;
  private strBuf = "";
  /** 0 = not in an escape, 1 = after a backslash, 2..5 = reading \u digits. */
  private strEsc = 0;
  private strHex = 0;
  // Number token state.
  private numState = NUM_MINUS;
  private numCapture = false;
  private numText = "";
  // Literal token state.
  private litWord = "";
  private litPos = 0;
  private litValue: boolean | null = null;
  private litCapture = false;

  constructor(visitor: FilesVisitor) {
    this.visitor = visitor;
  }

  /** Consume the next piece of decoded text. */
  write(text: string): void {
    const n = text.length;
    let i = 0;
    while (i < n) {
      if (this.lex !== LEX_NONE) {
        i = this.continueToken(text, i);
        continue;
      }
      const c = text.charCodeAt(i);
      if (c === SPACE || c === LF || c === CR || c === TAB) {
        i++;
        continue;
      }
      if (c === QUOTE) {
        i = this.startString(text, i + 1);
        continue;
      }
      if (c === COMMA) {
        this.comma(text, i);
        i++;
        continue;
      }
      if (c === COLON) {
        this.colon(text, i);
        i++;
        continue;
      }
      if (c === LBRACE || c === LBRACKET) {
        this.open(c === LBRACE ? KIND_OBJECT : KIND_ARRAY, text, i);
        i++;
        continue;
      }
      if (c === RBRACE || c === RBRACKET) {
        this.close(c === RBRACE ? KIND_OBJECT : KIND_ARRAY, text, i);
        i++;
        continue;
      }
      if (c === MINUS || (c >= DIGIT_0 && c <= DIGIT_9)) {
        i = this.startNumber(text, i);
        continue;
      }
      if (c === LOWER_T || c === LOWER_F || c === LOWER_N) {
        i = this.startLiteral(text, i);
        continue;
      }
      throw this.unexpected(text, i);
    }
    this.offset += n;
  }

  /** Finish the document. Throws if it is incomplete. */
  end(): void {
    if (this.lex === LEX_NUMBER) {
      const s = this.numState;
      if (s === NUM_ZERO || s === NUM_INT || s === NUM_FRAC || s === NUM_EXP_DIGITS) {
        this.finishNumber();
      }
    }
    if (this.lex !== LEX_NONE || this.doc !== DOC_DONE) {
      throw new ManifestSyntaxError(`Unexpected end of JSON input at position ${this.offset}`);
    }
  }

  /** The verdict after {@link end}: the header, or why this is not a manifest. */
  result(): { kind: "ok"; header: ManifestHeader } | { kind: "no_files" } {
    if (!this.topIsObject || this.files !== FILES_CONTAINER) return { kind: "no_files" };
    return { kind: "ok", header: this.header as unknown as ManifestHeader };
  }

  private unexpected(text: string, i: number): ManifestSyntaxError {
    return new ManifestSyntaxError(
      `Unexpected token '${describeChar(text.charCodeAt(i))}' at position ${this.offset + i}`,
    );
  }

  /**
   * A value is starting at the current position: check the grammar allows
   * one here and say what it becomes.
   */
  private beginValue(text: string, i: number): number {
    const f = this.top;
    if (f === null) {
      if (this.doc !== DOC_BEFORE) throw this.unexpected(text, i);
      this.doc = DOC_IN;
      return TOP;
    }
    if (f.kind === KIND_OBJECT) {
      if (f.state !== OBJ_VALUE) throw this.unexpected(text, i);
      return f.child;
    }
    if (f.state !== ARR_VALUE_OR_END && f.state !== ARR_VALUE) throw this.unexpected(text, i);
    if (f.role === ROLE_BUILD) return BUILD;
    if (f.role === ROLE_FILES) {
      const key = String(f.index++);
      f.key = key;
      f.child = this.visitor.key(key) ? BUILD : SKIP;
      return f.child;
    }
    return SKIP;
  }

  /** A scalar value is starting: record what it means for the shape check. */
  private scalarRole(role: number): number {
    if (role === TOP) {
      this.topIsObject = false;
      return SKIP;
    }
    if (role === FILES_SLOT) {
      this.visitor.reset();
      this.files = FILES_NOT_CONTAINER;
      return SKIP;
    }
    return role;
  }

  /** A value has ended: hand it to whatever contains it. */
  private completeValue(value: unknown): void {
    const f = this.top;
    if (f === null) {
      this.doc = DOC_DONE;
      return;
    }
    if (f.kind === KIND_OBJECT) {
      if (f.role === ROLE_BUILD) {
        defineJsonMember(f.built as Record<string, unknown>, f.key, value);
      } else if (f.role === ROLE_ROOT) {
        if (f.child === BUILD) this.header[f.key] = value;
      } else if (f.role === ROLE_FILES && f.child === BUILD) {
        this.visitor.value(f.key, value);
      }
      f.state = OBJ_COMMA_OR_END;
      return;
    }
    if (f.role === ROLE_BUILD) {
      (f.built as unknown[]).push(value);
    } else if (f.role === ROLE_FILES && f.child === BUILD) {
      this.visitor.value(f.key, value);
    }
    f.state = ARR_COMMA_OR_END;
  }

  private open(kind: number, text: string, i: number): void {
    const role = this.beginValue(text, i);
    let frameRole = ROLE_SKIP;
    let built: Frame["built"] = null;
    if (role === TOP) {
      this.topIsObject = kind === KIND_OBJECT;
      frameRole = kind === KIND_OBJECT ? ROLE_ROOT : ROLE_SKIP;
    } else if (role === FILES_SLOT) {
      this.visitor.reset();
      this.files = FILES_CONTAINER;
      frameRole = ROLE_FILES;
    } else if (role === BUILD) {
      frameRole = ROLE_BUILD;
      built = kind === KIND_OBJECT ? {} : [];
    }
    const frame: Frame = {
      kind,
      state: kind === KIND_OBJECT ? OBJ_KEY_OR_END : ARR_VALUE_OR_END,
      role: frameRole,
      built,
      key: "",
      child: SKIP,
      index: 0,
    };
    this.stack.push(frame);
    this.top = frame;
  }

  private close(kind: number, text: string, i: number): void {
    const f = this.top;
    if (f === null || f.kind !== kind) throw this.unexpected(text, i);
    if (kind === KIND_OBJECT) {
      if (f.state !== OBJ_KEY_OR_END && f.state !== OBJ_COMMA_OR_END) {
        throw this.unexpected(text, i);
      }
    } else if (f.state !== ARR_VALUE_OR_END && f.state !== ARR_COMMA_OR_END) {
      throw this.unexpected(text, i);
    }
    this.stack.pop();
    this.top = this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
    this.completeValue(f.role === ROLE_BUILD ? f.built : undefined);
  }

  private comma(text: string, i: number): void {
    const f = this.top;
    if (f !== null && f.kind === KIND_OBJECT && f.state === OBJ_COMMA_OR_END) {
      f.state = OBJ_KEY;
      return;
    }
    if (f !== null && f.kind === KIND_ARRAY && f.state === ARR_COMMA_OR_END) {
      f.state = ARR_VALUE;
      return;
    }
    throw this.unexpected(text, i);
  }

  private colon(text: string, i: number): void {
    const f = this.top;
    if (f === null || f.kind !== KIND_OBJECT || f.state !== OBJ_COLON) {
      throw this.unexpected(text, i);
    }
    f.state = OBJ_VALUE;
  }

  private continueToken(text: string, i: number): number {
    if (this.lex === LEX_STRING) return this.scanString(text, i);
    if (this.lex === LEX_NUMBER) return this.scanNumber(text, i);
    return this.scanLiteral(text, i);
  }

  // ---- strings ----------------------------------------------------------

  private startString(text: string, i: number): number {
    const f = this.top;
    if (
      f !== null &&
      f.kind === KIND_OBJECT &&
      (f.state === OBJ_KEY_OR_END || f.state === OBJ_KEY)
    ) {
      this.strIsKey = true;
      this.strCapture = f.role !== ROLE_SKIP;
    } else {
      this.strIsKey = false;
      this.strCapture = this.scalarRole(this.beginValue(text, i - 1)) === BUILD;
    }
    this.lex = LEX_STRING;
    this.strBuf = "";
    this.strEsc = 0;
    return this.scanString(text, i);
  }

  private scanString(text: string, start: number): number {
    const n = text.length;
    const capture = this.strCapture;
    let i = start;
    while (i < n) {
      if (this.strEsc === 0) {
        let j = i;
        let c = 0;
        while (j < n) {
          c = text.charCodeAt(j);
          if (c === QUOTE || c === BACKSLASH || c < SPACE) break;
          j++;
        }
        if (capture && j > i) this.strBuf += text.slice(i, j);
        if (j === n) return n;
        if (c === QUOTE) {
          this.lex = LEX_NONE;
          this.finishString();
          return j + 1;
        }
        if (c < SPACE) {
          throw new ManifestSyntaxError(
            `Bad control character in string literal at position ${this.offset + j}`,
          );
        }
        this.strEsc = 1;
        i = j + 1;
        continue;
      }
      const c = text.charCodeAt(i);
      if (this.strEsc === 1) {
        let out: string;
        switch (c) {
          case QUOTE:
            out = '"';
            break;
          case BACKSLASH:
            out = "\\";
            break;
          case SLASH:
            out = "/";
            break;
          case LOWER_B:
            out = "\b";
            break;
          case LOWER_F:
            out = "\f";
            break;
          case LOWER_N:
            out = "\n";
            break;
          case LOWER_R:
            out = "\r";
            break;
          case LOWER_T:
            out = "\t";
            break;
          case LOWER_U:
            this.strEsc = 2;
            this.strHex = 0;
            i++;
            continue;
          default:
            throw new ManifestSyntaxError(
              `Bad escaped character in JSON at position ${this.offset + i}`,
            );
        }
        if (capture) this.strBuf += out;
        this.strEsc = 0;
        i++;
        continue;
      }
      const h = hexValue(c);
      if (h < 0) {
        throw new ManifestSyntaxError(`Bad Unicode escape in JSON at position ${this.offset + i}`);
      }
      this.strHex = this.strHex * 16 + h;
      this.strEsc++;
      i++;
      if (this.strEsc === 6) {
        if (capture) this.strBuf += String.fromCharCode(this.strHex);
        this.strEsc = 0;
      }
    }
    return i;
  }

  private finishString(): void {
    const s = this.strBuf;
    this.strBuf = "";
    if (!this.strIsKey) {
      this.completeValue(this.strCapture ? s : undefined);
      return;
    }
    const f = this.top as Frame;
    f.state = OBJ_COLON;
    if (f.role === ROLE_ROOT) {
      f.key = s;
      f.child = s === "files" ? FILES_SLOT : HEADER_FIELD_SET.has(s) ? BUILD : SKIP;
    } else if (f.role === ROLE_FILES) {
      f.key = s;
      f.child = this.visitor.key(s) ? BUILD : SKIP;
    } else if (f.role === ROLE_BUILD) {
      f.key = s;
      f.child = BUILD;
    }
  }

  // ---- numbers ----------------------------------------------------------

  private startNumber(text: string, i: number): number {
    this.numCapture = this.scalarRole(this.beginValue(text, i)) === BUILD;
    this.numText = "";
    const c = text.charCodeAt(i);
    this.numState = c === MINUS ? NUM_MINUS : c === DIGIT_0 ? NUM_ZERO : NUM_INT;
    this.lex = LEX_NUMBER;
    const next = i + 1;
    if (this.numCapture) this.numText = text.slice(i, next);
    return this.scanNumber(text, next);
  }

  private scanNumber(text: string, start: number): number {
    const n = text.length;
    let i = start;
    let state = this.numState;
    let ended = false;
    while (i < n) {
      const c = text.charCodeAt(i);
      const digit = c >= DIGIT_0 && c <= DIGIT_9;
      if (state === NUM_INT || state === NUM_FRAC || state === NUM_EXP_DIGITS) {
        if (digit) {
          i++;
          continue;
        }
        if (state === NUM_EXP_DIGITS) {
          ended = true;
          break;
        }
        if (c === DOT && state === NUM_INT) {
          state = NUM_DOT;
          i++;
          continue;
        }
        if (c === LOWER_E || c === UPPER_E) {
          state = NUM_EXP;
          i++;
          continue;
        }
        ended = true;
        break;
      }
      if (state === NUM_ZERO) {
        if (c === DOT) {
          state = NUM_DOT;
          i++;
          continue;
        }
        if (c === LOWER_E || c === UPPER_E) {
          state = NUM_EXP;
          i++;
          continue;
        }
        ended = true;
        break;
      }
      if (state === NUM_MINUS) {
        if (c === DIGIT_0) state = NUM_ZERO;
        else if (c >= DIGIT_1 && c <= DIGIT_9) state = NUM_INT;
        else
          throw new ManifestSyntaxError(
            `No number after minus sign at position ${this.offset + i}`,
          );
        i++;
        continue;
      }
      if (state === NUM_DOT) {
        if (!digit) {
          throw new ManifestSyntaxError(
            `Unterminated fractional number at position ${this.offset + i}`,
          );
        }
        state = NUM_FRAC;
        i++;
        continue;
      }
      if (state === NUM_EXP) {
        if (c === PLUS || c === MINUS) state = NUM_EXP_SIGN;
        else if (digit) state = NUM_EXP_DIGITS;
        else
          throw new ManifestSyntaxError(
            `Exponent part is missing a number at position ${this.offset + i}`,
          );
        i++;
        continue;
      }
      // NUM_EXP_SIGN
      if (!digit) {
        throw new ManifestSyntaxError(
          `Exponent part is missing a number at position ${this.offset + i}`,
        );
      }
      state = NUM_EXP_DIGITS;
      i++;
    }
    this.numState = state;
    if (this.numCapture && i > start) this.numText += text.slice(start, i);
    if (ended) this.finishNumber();
    return i;
  }

  private finishNumber(): void {
    this.lex = LEX_NONE;
    const text = this.numText;
    this.numText = "";
    this.completeValue(this.numCapture ? Number(text) : undefined);
  }

  // ---- true / false / null ----------------------------------------------

  private startLiteral(text: string, i: number): number {
    this.litCapture = this.scalarRole(this.beginValue(text, i)) === BUILD;
    const c = text.charCodeAt(i);
    this.litWord = c === LOWER_T ? "true" : c === LOWER_F ? "false" : "null";
    this.litValue = c === LOWER_T ? true : c === LOWER_F ? false : null;
    this.litPos = 1;
    this.lex = LEX_LITERAL;
    return this.scanLiteral(text, i + 1);
  }

  private scanLiteral(text: string, start: number): number {
    const n = text.length;
    let i = start;
    const word = this.litWord;
    while (i < n && this.litPos < word.length) {
      if (text.charCodeAt(i) !== word.charCodeAt(this.litPos)) throw this.unexpected(text, i);
      this.litPos++;
      i++;
    }
    if (this.litPos === word.length) {
      this.lex = LEX_NONE;
      this.completeValue(this.litCapture ? this.litValue : undefined);
    }
    return i;
  }
}

/**
 * Scan a whole manifest held as text. For tests and for callers that already
 * have the string; the routes use {@link scanManifestStream}.
 */
export function scanManifestText(text: string, visitor: FilesVisitor): ScanResult {
  const scanner = new ManifestScanner(visitor);
  try {
    scanner.write(text);
    scanner.end();
  } catch (err) {
    if (err instanceof ManifestSyntaxError) return { kind: "malformed", message: err.message };
    throw err;
  }
  return scanner.result();
}

/**
 * Scan a manifest body as it arrives. `tap`, when given, sees every raw chunk
 * BEFORE it is tokenized and may await (the edge-cache writer uses it for
 * backpressure). A read error from the body is a transport failure and is
 * thrown, exactly as `response.text()` would have thrown it; a body that is
 * not a manifest is a result, not an exception. The body is cancelled on any
 * early exit so the upstream connection is released.
 */
export async function scanManifestStream(
  body: ReadableStream<Uint8Array>,
  visitor: FilesVisitor,
  tap?: (chunk: Uint8Array) => void | Promise<void>,
): Promise<ScanResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const scanner = new ManifestScanner(visitor);
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      if (tap) await tap(value);
      scanner.write(decoder.decode(value, { stream: true }));
    }
    finished = true;
    scanner.write(decoder.decode());
    scanner.end();
  } catch (err) {
    if (!finished) await reader.cancel("manifest scan stopped early").catch(() => {});
    if (err instanceof ManifestSyntaxError) return { kind: "malformed", message: err.message };
    throw err;
  } finally {
    reader.releaseLock();
  }
  return scanner.result();
}
