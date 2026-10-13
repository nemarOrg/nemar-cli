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
      /** The parsed object `sent` was made from, for the two JSON documents; null for prose. */
      object: unknown;
      /** Shown and not-shown top-level keys; both 0 for anything but the description. */
      keysShown: number;
      keysNotShown: number;
    };

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * The string a document is sent as: control characters replaced, then cut to `cap` characters with
 * a visible mark. Whether it was cut is judged on the cleaned text, because a control character
 * outside the Basic Multilingual Plane is replaced by one space and so shortens the text.
 */
function toSent(text: string, cap: number): { sent: string; cut: boolean } {
  const cleaned = tidy(text, Number.MAX_SAFE_INTEGER);
  return cleaned.length > cap
    ? { sent: tidy(cleaned, cap), cut: true }
    : { sent: cleaned, cut: false };
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
  const cap = DOCUMENT_CHAR_CAPS[document];

  if (document !== "dataset_description" && document !== "participants_json") {
    return { kind: "text", ...toSent(raw.text, cap), object: null, keysShown: 0, keysNotShown: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    return { kind: "no-text", state: "withheld_not_json" };
  }
  if (!isPlainObject(parsed)) return { kind: "no-text", state: "withheld_not_json" };

  let object: Record<string, unknown> = parsed;
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
    object = kept;
    keysNotShown = Object.keys(parsed).length - keysShown;
  }
  return {
    kind: "text",
    ...toSent(JSON.stringify(object, null, 2), cap),
    object,
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
      const findings: Finding[] = [
        ...scanTextForLocalPaths(prepared.sent),
        ...(prepared.object === null ? [] : scanJsonKeys(prepared.object)),
      ];
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
