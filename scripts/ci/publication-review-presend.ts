/**
 * The pre-send boundary of the publication review (ADR 0101, section 2).
 *
 * **This is the only file that mints `ClearedText`.** The prompt builder accepts nothing else, and
 * `test/publication-review-contract.test.ts` fails if any other source file casts to the type. So
 * the one place that decides what a model may read is this file, and it is short enough to read
 * whole.
 *
 * The rule: every document is examined by the shared mechanical rules (`shared/identifier-scan.ts`)
 * immediately before it is sent, over exactly the string that will be sent, and text is cleared
 * only when the rules found nothing in it. A document the rules found something in, that could not
 * be read in full, that is not UTF-8, that is an annexed link or pointer rather than text in git,
 * or that is JSON that does not parse is withheld WHOLE and gets a closed state; it is never
 * sent, and never sent in part.
 *
 * Three rules fix what "exactly the string that will be sent" means:
 *
 *  1. The string is built first, in full: the text cut to its cap and cleaned of control
 *     characters (`tidy`), or, for the two JSON documents, the re-serialized object (the shown keys
 *     of `dataset_description.json`, or all of `participants.json`) cut and cleaned the same way.
 *     The text rule runs over THAT string, so a finding in the part a cut removes does not withhold
 *     a document whose sent bytes are clean, and no byte the rules did not see is ever sent.
 *  2. For the two JSON documents the key rule also runs, over the parsed object that string was
 *     made from. That object holds at least what was sent (a cut string is a prefix of it), so the
 *     key rule can only be stricter than the string, never weaker.
 *  3. The text rule also runs over the serialized JSON, because a local user path can sit in a
 *     string value (`GeneratedBy[0].CodeURL`) that no key rule would look at.
 *
 * What the rules can and cannot see is stated in ADR 0101: for prose the only rule is a local
 * user path, so this is a consistency control, not a privacy control. It never decides anything
 * about names, email addresses or dates in prose.
 *
 * A document that makes the examination itself fail (a JSON value nested so deeply that walking it
 * overflows the stack) is withheld as unreadable: nothing here fails open.
 *
 * Nothing in this file prints anything. The findings it sees are counted by kind and returned;
 * neither a finding's value nor a byte of a document leaves the function.
 */

import {
  type Finding,
  type FindingKind,
  countByKind,
  scanJsonKeys,
  scanTextForLocalPaths,
  shapeOf,
} from "../../shared/identifier-scan";
import {
  type ClearedDocuments,
  type ClearedText,
  DESCRIPTION_KEYS_SHOWN,
  DOCUMENT_CHAR_CAPS,
  type DocumentState,
  type PreSend,
  type PreSendResult,
  REVIEW_DOCUMENTS,
  type RawDocument,
  type ReviewDocument,
} from "../../shared/publication-review";
import { tidy } from "../../shared/untrusted-text";

/** A document that has no text to examine, or text that is ready to be. */
type Prepared =
  | { kind: "no-text"; state: DocumentState }
  | {
      kind: "text";
      /** The exact string that would be sent. */
      sent: string;
      /** The document was longer than its cap and `sent` is its start. */
      cut: boolean;
      /**
       * What the rules that run on the normalized structure of a JSON document found in it (its
       * keys and every string in it); none for prose, which has no structure.
       */
      findings: Finding[];
      /** Shown and not-shown top-level keys; both 0 for anything but the description. */
      keysShown: number;
      keysNotShown: number;
    };

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Three ways to write a path on someone's machine that the shared rule does not read, because it
 * knows `/Users/<name>`, `/home/<name>` and `C:\Users\<name>` only: a `file:` URL (the
 * `GeneratedBy` entry's `CodeURL` is where one turns up), a Windows drive path in either slash
 * (`D:/lab`, `C:/Users/<name>`), and a UNC path (`\\server\share`). None of them is a thing a
 * published description needs to say.
 *
 * A form counts where it starts a string or follows anything but a letter or digit, so `profile:`
 * and `https://` are not drive paths or file URLs. These rules run over the JSON strings and keys
 * only; prose keeps the shared rule alone, which ADR 0101 describes as a consistency control.
 */
const LOCAL_PATH_FORMS: readonly RegExp[] = [
  /(?<![A-Za-z0-9+.-])file:(?:[\\/]|[A-Za-z]:)/i,
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/,
  /(?<![A-Za-z0-9\\])\\\\(?=[^\\\s])/,
];

/** One finding when the text holds one of {@link LOCAL_PATH_FORMS}, shaped from the match alone. */
export function scanLocalPathForms(text: string): Finding[] {
  for (const form of LOCAL_PATH_FORMS) {
    const m = form.exec(text);
    if (m !== null) {
      return [{ kind: "local-user-path", severity: "review", field: "text", shape: shapeOf(m[0]) }];
    }
  }
  return [];
}

/**
 * Every string and every key of a normalized JSON value, each examined ON ITS OWN by the shared
 * path rule and by {@link scanLocalPathForms}. Over the serialized text a newline or a tab inside a
 * string is the two characters backslash and `n` or `t`, so the shared rule's lookbehind sees a
 * letter before a path that, in the string the model reads, starts a line. At most one finding is
 * returned: a document with a path in it is withheld, and one finding says so.
 */
function scanStructureForPaths(value: unknown): Finding[] {
  if (typeof value === "string") {
    const found = scanTextForLocalPaths(value);
    return found.length > 0 ? found : scanLocalPathForms(value);
  }
  const children = Array.isArray(value)
    ? value
    : isPlainObject(value)
      ? Object.entries(value).flat()
      : [];
  for (const child of children) {
    const found = scanStructureForPaths(child);
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * A parsed JSON value with {@link normalizeText} applied to every string AND every key, to any
 * depth. The model is sent the cleaned text, so the rules must look at the cleaned structure: a key
 * `patient<zero-width space>name` is the key `patient name` to the model, and `scanJsonKeys` would
 * not have matched the first. Built with `Object.fromEntries`, which defines each key as data, so a
 * key named `__proto__` is kept and examined instead of becoming a prototype.
 */
function normalizeStructure(value: unknown): unknown {
  if (typeof value === "string") return normalizeText(value);
  if (Array.isArray(value)) return value.map(normalizeStructure);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [normalizeText(k), normalizeStructure(v)]),
    );
  }
  return value;
}

/**
 * Marks that render as nothing and survive the control-character cleaning: the variation selectors
 * (U+FE00 to U+FE0F, U+E0100 to U+E01EF) and the Mongolian free variation selectors (U+180B to
 * U+180D, U+180F), which together are the Unicode property `Variation_Selector`. Text spelled in
 * them is invisible to a person reading the file and still in the prompt, and one inside a path
 * hides it from the rule.
 */
const INVISIBLE_SELECTORS = /\p{Variation_Selector}/gu;
/** In unicode mode this matches only a surrogate that is not half of a pair. */
const LONE_SURROGATE = /\p{Cs}/gu;

/**
 * The one normalization every string goes through before any rule looks at it: the invisible
 * selectors and any half of a surrogate pair removed, then control characters replaced (`tidy`).
 * The rules run over the result and the result is what is sent, so nothing the model can read is
 * something the rules could not.
 */
function normalizeText(text: string): string {
  return tidy(
    text.replace(INVISIBLE_SELECTORS, "").replace(LONE_SURROGATE, ""),
    Number.MAX_SAFE_INTEGER,
  );
}

/**
 * `text` cut to `cap` characters with a visible mark, never in the middle of a character: a cut
 * that would leave the first half of a surrogate pair at the end stops one unit sooner.
 */
function cutTo(text: string, cap: number): { text: string; cut: boolean } {
  if (text.length <= cap) return { text, cut: false };
  const last = text.charCodeAt(cap - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? cap - 1 : cap;
  return { text: `${text.slice(0, end)}\n[cut]`, cut: true };
}

/**
 * The string a document is sent as: normalized, then cut to `cap` characters. Whether it was cut is
 * judged on the normalized text, because a control character outside the Basic Multilingual Plane
 * is replaced by one space and so shortens the text.
 */
function toSent(text: string, cap: number): { sent: string; cut: boolean } {
  const { text: sent, cut } = cutTo(normalizeText(text), cap);
  return { sent, cut };
}

/** Build the string a document would be sent as, or say why there is none. */
function prepare(document: ReviewDocument, raw: RawDocument): Prepared {
  switch (raw.state) {
    case "present":
      break;
    case "absent":
      return { kind: "no-text", state: "absent" };
    case "annexed":
      return { kind: "no-text", state: "withheld_annexed" };
    case "not_utf8":
      return { kind: "no-text", state: "withheld_not_utf8" };
    default:
      // "unreadable", and any word this function does not know: nothing is sent on a guess.
      return { kind: "no-text", state: "withheld_unreadable" };
  }
  if (typeof raw.text !== "string") return { kind: "no-text", state: "withheld_unreadable" };
  // A NUL means these bytes were not text (UTF-16 with no byte-order mark decodes as UTF-8 with a
  // NUL between letters, and the cleaning below would turn each into a space). The reader says so
  // already; this is the boundary's own check, for a caller that is not the reader.
  if (raw.text.includes("\u0000")) return { kind: "no-text", state: "withheld_not_utf8" };
  const cap = DOCUMENT_CHAR_CAPS[document];

  if (document !== "dataset_description" && document !== "participants_json") {
    return { kind: "text", ...toSent(raw.text, cap), findings: [], keysShown: 0, keysNotShown: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    return { kind: "no-text", state: "withheld_not_json" };
  }
  if (!isPlainObject(parsed)) return { kind: "no-text", state: "withheld_not_json" };

  let shown: Record<string, unknown> = parsed;
  let keysShown = 0;
  let keysNotShown = 0;
  if (document === "dataset_description") {
    const kept: Record<string, unknown> = {};
    for (const key of DESCRIPTION_KEYS_SHOWN) {
      if (Object.hasOwn(parsed, key)) {
        kept[key] = parsed[key];
        keysShown++;
      }
    }
    shown = kept;
    keysNotShown = Object.keys(parsed).length - keysShown;
  }
  // Normalize first, then examine the normalized structure, then send that same structure.
  const object = normalizeStructure(shown);
  return {
    kind: "text",
    ...toSent(JSON.stringify(object, null, 2), cap),
    findings: [...scanJsonKeys(object), ...scanStructureForPaths(object)],
    keysShown,
    keysNotShown,
  };
}

/**
 * The pre-send check. Examines each document with the shared rules over the string that will be
 * sent, and returns that string, branded, for the documents the rules found nothing in. See the
 * file header for the three rules, and `PreSendResult` for what each state means.
 */
export const presend: PreSend = (docs): PreSendResult => {
  const cleared: ClearedDocuments = {};
  const states = {} as Record<ReviewDocument, DocumentState>;
  const withheldFindings: Partial<Record<FindingKind, number>> = {};
  let keysShown = 0;
  let keysNotShown = 0;

  for (const document of REVIEW_DOCUMENTS) {
    try {
      const prepared = prepare(document, docs[document]);
      if (prepared.kind === "no-text") {
        states[document] = prepared.state;
        continue;
      }
      const findings: Finding[] = [...prepared.findings];
      // The rule over the whole string that will be sent. For a JSON document the structure's own
      // finding already says a path is there, and one finding per document is what is counted.
      if (!findings.some((f) => f.kind === "local-user-path")) {
        findings.push(...scanTextForLocalPaths(prepared.sent));
      }
      if (findings.length > 0) {
        states[document] = "withheld_finding";
        for (const [kind, n] of Object.entries(countByKind(findings))) {
          withheldFindings[kind as FindingKind] = (withheldFindings[kind as FindingKind] ?? 0) + n;
        }
        continue;
      }
      // The one cast of the repository: this string was examined, byte for byte, and nothing was
      // found in it.
      cleared[document] = prepared.sent as ClearedText;
      states[document] = prepared.cut ? "sent_cut" : "sent";
      keysShown += prepared.keysShown;
      keysNotShown += prepared.keysNotShown;
    } catch {
      // The examination itself failed: whatever this document is, it is not cleared.
      delete cleared[document];
      states[document] = "withheld_unreadable";
    }
  }
  return {
    cleared,
    states,
    withheld_findings: withheldFindings,
    description_keys_shown: keysShown,
    description_keys_not_shown: keysNotShown,
  };
};
