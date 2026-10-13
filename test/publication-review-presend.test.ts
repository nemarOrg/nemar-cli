/**
 * The pre-send boundary of the publication review (ADR 0101, section 2), exercised with the REAL
 * shared rules (`scanTextForLocalPaths`, `scanJsonKeys`) over documents shaped the way git hands
 * them over.
 *
 * What is pinned here is the one property the model's input rests on: text becomes `ClearedText`
 * only when the shared rules found nothing in exactly the string that will be sent; every other
 * document is withheld whole, with a closed state, and no byte of it is anywhere in the result.
 * `test/publication-review-evidence.test.ts` drives the same module through real git repositories
 * and the whole job; this file is the module's own specification.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { presend } from "../scripts/ci/publication-review-presend";
import { scanJsonKeys, scanTextForLocalPaths } from "../shared/identifier-scan";
import {
  DESCRIPTION_KEYS_SHOWN,
  DOCUMENT_CHAR_CAPS,
  DOCUMENT_STATES,
  REVIEW_DOCUMENTS,
  type RawDocument,
  type ReviewDocument,
} from "../shared/publication-review";

const present = (text: string, name = "README.md"): RawDocument => ({
  name,
  state: "present",
  text,
});
const absent = (): RawDocument => ({ name: "", state: "absent", text: null });

const DESCRIPTION = JSON.stringify({
  Name: "Resting EEG of healthy volunteers, eyes open and closed",
  BIDSVersion: "1.9.0",
  License: "CC0",
  Authors: ["Ada Lovelace", "Alan Turing"],
  EthicsApprovals: ["IRB 2024-0001, University X"],
  Version: "1.0.0",
});

/** Five clean documents; each test overrides what it is about. */
function docs(over: Partial<Record<ReviewDocument, RawDocument>> = {}) {
  return {
    readme: present("# Resting EEG\n\nTwo conditions, thirty volunteers.\n"),
    dataset_description: present(DESCRIPTION, "dataset_description.json"),
    changes: present("1.0.0 2026-01-01\n - Initial release\n", "CHANGES"),
    license: present("Creative Commons Zero\n", "LICENSE"),
    participants_json: present(
      JSON.stringify({ participant_id: { Description: "Unique label" }, age: { Units: "years" } }),
      "participants.json",
    ),
    ...over,
  } as Record<ReviewDocument, RawDocument>;
}

const REAL_PATH = "/Users/jsmith/projects/eeg";

describe("a clean set of documents is sent, exactly as it will be fenced", () => {
  test("every document is sent and its cleared text is the string the model will read", () => {
    const input = docs();
    const r = presend(input);
    expect(Object.values(r.states)).toEqual(REVIEW_DOCUMENTS.map(() => "sent"));
    expect(r.withheld_findings).toEqual({});
    // Prose is sent as written; the two JSON documents as their re-serialized shown content.
    expect(r.cleared.readme as string).toBe(input.readme.text as string);
    expect(r.cleared.changes as string).toBe(input.changes.text as string);
    expect(r.cleared.license as string).toBe(input.license.text as string);
    expect(r.cleared.participants_json as string).toBe(
      JSON.stringify(JSON.parse(input.participants_json.text as string), null, 2),
    );
    expect(r.cleared.dataset_description as string).toBe(
      JSON.stringify(
        {
          Name: "Resting EEG of healthy volunteers, eyes open and closed",
          BIDSVersion: "1.9.0",
          License: "CC0",
          Authors: ["Ada Lovelace", "Alan Turing"],
          EthicsApprovals: ["IRB 2024-0001, University X"],
        },
        null,
        2,
      ),
    );
  });

  test("the result is the same on a second call and the input is untouched", () => {
    const input = docs();
    const frozen = JSON.stringify(input);
    expect(presend(input)).toEqual(presend(input));
    expect(JSON.stringify(input)).toBe(frozen);
  });

  test("a withheld document does not withhold the others", () => {
    const r = presend(docs({ changes: present(`history: ${REAL_PATH}`, "CHANGES") }));
    expect(r.states.changes).toBe("withheld_finding");
    expect(r.states.readme).toBe("sent");
    expect(r.states.license).toBe("sent");
    expect(r.states.dataset_description).toBe("sent");
    expect(Object.keys(r.cleared).sort()).toEqual(
      ["readme", "license", "dataset_description", "participants_json"].sort(),
    );
  });
});

describe("a document with no text to examine is a closed state and is never sent", () => {
  test.each([
    ["absent", "absent"],
    ["annexed", "withheld_annexed"],
    ["unreadable", "withheld_unreadable"],
    ["not_utf8", "withheld_not_utf8"],
  ] as const)("%s is %s", (state, word) => {
    const raw: RawDocument = { name: "README.md", state, text: null };
    const r = presend(docs({ readme: raw }));
    expect(r.states.readme).toBe(word);
    expect(r.cleared.readme).toBeUndefined();
  });

  test("a document marked present with no text is unreadable, not empty", () => {
    const r = presend(docs({ readme: { name: "README.md", state: "present", text: null } }));
    expect(r.states.readme).toBe("withheld_unreadable");
    expect(r.cleared.readme).toBeUndefined();
  });

  test("text on a document that says it was not read is ignored, never sent", () => {
    // The state is the reader's word for what it could not do; a stray text must not override it.
    const r = presend(
      docs({ readme: { name: "README.md", state: "annexed", text: `leaked ${REAL_PATH}` } }),
    );
    expect(r.states.readme).toBe("withheld_annexed");
    expect(JSON.stringify(r)).not.toContain("leaked");
  });
});

describe("prose: the local-user-path rule, over exactly the string that is sent", () => {
  test("a local user path withholds the whole document and only the kind is counted", () => {
    const r = presend(docs({ readme: present(`# Study\nScripts in ${REAL_PATH}\n`) }));
    expect(r.states.readme).toBe("withheld_finding");
    expect(r.cleared.readme).toBeUndefined();
    expect(r.withheld_findings).toEqual({ "local-user-path": 1 });
    // No byte of the document is in the result: not the path, not the name, not the heading.
    const serialized = JSON.stringify(r);
    for (const leak of ["jsmith", "Scripts in", "# Study"]) expect(serialized).not.toContain(leak);
  });

  test("a generic account does not hide a real one after it (#1737)", () => {
    const text = "Run from /home/user/code, then /Users/alice/data.\n";
    const r = presend(docs({ readme: present(text) }));
    expect(r.states.readme).toBe("withheld_finding");
    expect(r.cleared.readme).toBeUndefined();
  });

  test("a generic account alone is not a finding", () => {
    const text = "Run from /home/user/code or /Users/username/code.\n";
    const r = presend(docs({ readme: present(text) }));
    expect(r.states.readme).toBe("sent");
    expect(r.cleared.readme as string).toBe(text);
  });

  test("a Windows profile path is a finding", () => {
    const r = presend(docs({ license: present("see C:\\Users\\bob\\Desktop\\x", "LICENSE") }));
    expect(r.states.license).toBe("withheld_finding");
  });

  test("findings are counted by kind across documents, never by value", () => {
    const r = presend(
      docs({
        readme: present(`a ${REAL_PATH}`),
        changes: present(`b ${REAL_PATH}`, "CHANGES"),
        license: present("c /home/carol/x", "LICENSE"),
      }),
    );
    expect(r.withheld_findings).toEqual({ "local-user-path": 3 });
  });

  test("the string examined is the string sent: a finding in the part a cut removes does not count", () => {
    const cap = DOCUMENT_CHAR_CAPS.readme;
    const tail = ` ${REAL_PATH}`;
    const r = presend(docs({ readme: present("a".repeat(cap) + tail) }));
    expect(r.states.readme).toBe("sent_cut");
    expect(r.cleared.readme as string).not.toContain("jsmith");
    expect(r.withheld_findings).toEqual({});
  });

  test("a finding inside the part that is sent withholds a cut document too", () => {
    const cap = DOCUMENT_CHAR_CAPS.readme;
    const r = presend(docs({ readme: present(`${REAL_PATH} ${"a".repeat(cap)}`) }));
    expect(r.states.readme).toBe("withheld_finding");
    expect(r.cleared.readme).toBeUndefined();
  });

  test("a path that a cut would split in half is still seen when its start is sent", () => {
    // "/Users/al" survives the cut; the rule matches "al" as the account, a non-generic name.
    const cap = DOCUMENT_CHAR_CAPS.changes;
    const text = `${"b".repeat(cap - 10)} /Users/alice/x`;
    const r = presend(docs({ changes: present(text, "CHANGES") }));
    expect(r.states.changes).toBe("withheld_finding");
  });
});

describe("the cut: a longer document is cut and the cut is a fact", () => {
  for (const document of ["readme", "changes", "license"] as const) {
    test(`${document}: exactly its cap is sent whole, one more character is cut`, () => {
      const cap = DOCUMENT_CHAR_CAPS[document];
      const whole = presend(docs({ [document]: present("x".repeat(cap)) }));
      expect(whole.states[document]).toBe("sent");
      expect((whole.cleared[document] as string).length).toBe(cap);

      const cut = presend(docs({ [document]: present("x".repeat(cap + 1)) }));
      expect(cut.states[document]).toBe("sent_cut");
      const sent = cut.cleared[document] as string;
      expect(sent.startsWith("x".repeat(cap))).toBe(true);
      expect(sent.endsWith("[cut]")).toBe(true);
      expect(sent.length).toBe(cap + "\n[cut]".length);
    });
  }

  test("a JSON document is cut after it is re-serialized, and says so", () => {
    const big = {
      participant_id: { Description: "d".repeat(DOCUMENT_CHAR_CAPS.participants_json) },
    };
    const r = presend(
      docs({ participants_json: present(JSON.stringify(big), "participants.json") }),
    );
    expect(r.states.participants_json).toBe("sent_cut");
    expect((r.cleared.participants_json as string).endsWith("[cut]")).toBe(true);
  });
});

describe("control characters are removed from what is sent, before the rules look", () => {
  test("bells, escapes and bidirectional overrides become spaces; newlines and tabs stay", () => {
    const text = "ok\u0007 bell\u001b[31m red \u202eevil\u200b zero\n\tindented\n";
    const r = presend(docs({ readme: present(text) }));
    expect(r.states.readme).toBe("sent");
    const sent = r.cleared.readme as string;
    const stray = [...sent].filter((c) => /[\p{Cc}\p{Cf}]/u.test(c) && c !== "\n" && c !== "\t");
    expect(stray).toEqual([]);
    expect(sent).toContain("\n\tindented\n");
  });

  test("an invisible character cannot hide a path from the rule or join one for it", () => {
    // Removal would turn this into /Users/alice; replacement by a space keeps what was written, so
    // the rule examines the text the model will read.
    const split = presend(docs({ readme: present("/Us\u200bers/alice/x") }));
    expect(split.states.readme).toBe("sent");
    expect(split.cleared.readme as string).toBe("/Us ers/alice/x");
    const inside = presend(docs({ readme: present("/Users/ali\u200bce/x") }));
    expect(inside.states.readme).toBe("withheld_finding");
  });
});

describe("dataset_description.json: the shown keys, re-serialized", () => {
  test("only the BIDS keys the questions turn on are sent, and the others are counted", () => {
    const r = presend(docs());
    expect(r.description_keys_shown).toBe(5);
    expect(r.description_keys_not_shown).toBe(1);
    const sent = JSON.parse(r.cleared.dataset_description as string);
    expect(Object.keys(sent).sort()).toEqual(
      ["Name", "BIDSVersion", "License", "Authors", "EthicsApprovals"].sort(),
    );
  });

  test("every shown key is sent when present, and in the declared order", () => {
    const all = Object.fromEntries(DESCRIPTION_KEYS_SHOWN.map((k) => [k, `value of ${k}`]));
    const reversed = Object.fromEntries(Object.entries(all).reverse());
    const r = presend(
      docs({ dataset_description: present(JSON.stringify(reversed), "dataset_description.json") }),
    );
    expect(r.description_keys_shown).toBe(DESCRIPTION_KEYS_SHOWN.length);
    expect(r.description_keys_not_shown).toBe(0);
    expect(Object.keys(JSON.parse(r.cleared.dataset_description as string))).toEqual([
      ...DESCRIPTION_KEYS_SHOWN,
    ]);
  });

  test("an identifier key INSIDE a shown key withholds the document", () => {
    const description = JSON.stringify({
      Name: "A descriptive dataset name that is long enough",
      GeneratedBy: [{ Name: "pipeline", email: "a.person@example.org" }],
    });
    const r = presend(
      docs({ dataset_description: present(description, "dataset_description.json") }),
    );
    expect(r.states.dataset_description).toBe("withheld_finding");
    expect(r.cleared.dataset_description).toBeUndefined();
    expect(r.withheld_findings).toEqual({ "json-identifier-key": 1 });
    expect(r.description_keys_shown).toBe(0);
    expect(JSON.stringify(r)).not.toContain("a.person");
  });

  test("an identifier-named key OUTSIDE the shown set is not sent, so it withholds nothing", () => {
    const description = JSON.stringify({
      Name: "A descriptive dataset name that is long enough",
      Version: "1.0.0",
      PatientName: "Someone",
      Extra: { email: "x@example.org" },
    });
    const r = presend(
      docs({ dataset_description: present(description, "dataset_description.json") }),
    );
    expect(r.states.dataset_description).toBe("sent");
    expect(r.description_keys_shown).toBe(1);
    expect(r.description_keys_not_shown).toBe(3);
    const sent = r.cleared.dataset_description as string;
    for (const leak of ["PatientName", "Someone", "x@example.org", "Version"]) {
      expect(sent).not.toContain(leak);
    }
  });

  test("a local user path inside a shown string value withholds it (the key rule alone would not)", () => {
    const description = JSON.stringify({
      Name: "A descriptive dataset name that is long enough",
      Funding: [`Grant letter at ${REAL_PATH}/letter.pdf`],
    });
    const input = docs({ dataset_description: present(description, "dataset_description.json") });
    expect(scanJsonKeys(JSON.parse(description))).toEqual([]);
    const r = presend(input);
    expect(r.states.dataset_description).toBe("withheld_finding");
    expect(r.withheld_findings).toEqual({ "local-user-path": 1 });
  });

  test("a local user path in a key that is not shown does not matter", () => {
    const description = JSON.stringify({
      Name: "A descriptive dataset name that is long enough",
      Notes: REAL_PATH,
    });
    const r = presend(
      docs({ dataset_description: present(description, "dataset_description.json") }),
    );
    expect(r.states.dataset_description).toBe("sent");
    expect(r.cleared.dataset_description as string).not.toContain("jsmith");
  });

  test("JSON that does not parse, or is not an object, is withheld as not JSON", () => {
    for (const text of ["{ not json", "[1, 2]", "42", "null", '"a string"', ""]) {
      const r = presend(docs({ dataset_description: present(text, "dataset_description.json") }));
      expect(r.states.dataset_description, text).toBe("withheld_not_json");
      expect(r.cleared.dataset_description).toBeUndefined();
      expect(r.description_keys_shown).toBe(0);
      expect(r.description_keys_not_shown).toBe(0);
    }
  });

  test("the counts are of what was sent: a withheld description counts nothing", () => {
    const description = JSON.stringify({ Name: "n", Version: "1.0.0", Funding: [REAL_PATH] });
    const r = presend(
      docs({ dataset_description: present(description, "dataset_description.json") }),
    );
    expect(r.states.dataset_description).toBe("withheld_finding");
    expect(r.description_keys_shown).toBe(0);
    expect(r.description_keys_not_shown).toBe(0);
  });
});

describe("participants.json: the whole object, under the same two rules", () => {
  test("an identifier-named column key with content withholds it", () => {
    const text = JSON.stringify({
      participant_id: { Description: "label" },
      patientname: { Description: "name of the patient" },
    });
    const r = presend(docs({ participants_json: present(text, "participants.json") }));
    expect(r.states.participants_json).toBe("withheld_finding");
    expect(r.cleared.participants_json).toBeUndefined();
    expect(r.withheld_findings).toEqual({ "json-identifier-key": 1 });
  });

  test("the key rule reads the whole object, so a key in the cut part still withholds it", () => {
    // The key rule is stricter than the string, never weaker: the object holds at least what was sent.
    const filler = { Description: "f".repeat(DOCUMENT_CHAR_CAPS.participants_json) };
    const text = JSON.stringify({ participant_id: filler, birthdate: { Description: "d" } });
    const r = presend(docs({ participants_json: present(text, "participants.json") }));
    expect(r.states.participants_json).toBe("withheld_finding");
  });

  test("an array, or text that is not JSON, is withheld as not JSON", () => {
    for (const text of ["[]", "{ broken", "name\tage\n"]) {
      const r = presend(docs({ participants_json: present(text, "participants.json") }));
      expect(r.states.participants_json, text).toBe("withheld_not_json");
    }
  });
});

describe("nothing here fails open", () => {
  test("a state this module does not know withholds the document, whatever text came with it", () => {
    const odd = { name: "README.md", state: "weird", text: `fine text ${REAL_PATH}` } as never;
    const clean = { name: "README.md", state: "weird", text: "fine text" } as never;
    for (const readme of [odd, clean]) {
      const r = presend(docs({ readme }));
      expect(r.states.readme).toBe("withheld_unreadable");
      expect(r.cleared.readme).toBeUndefined();
    }
  });

  test("a document missing from the input is withheld, not thrown and not sent", () => {
    const input = docs();
    // biome-ignore lint/performance/noDelete: the property must be absent, not undefined
    delete (input as Partial<typeof input>).changes;
    const r = presend(input);
    expect(r.states.changes).toBe("withheld_unreadable");
    expect(r.cleared.changes).toBeUndefined();
    expect(r.states.readme).toBe("sent");
  });

  test("whether a document was cut is judged on what is sent: a control character outside the BMP shortens it", () => {
    const cap = DOCUMENT_CHAR_CAPS.readme;
    // One character longer than the cap as read, exactly the cap once the two-unit tag character
    // is replaced by one space: it is sent whole, with no cut mark, and says so.
    const text = `${"a".repeat(cap - 2)}\u{E0001}b`;
    expect(text.length).toBe(cap + 1);
    const r = presend(docs({ readme: present(text) }));
    expect(r.states.readme).toBe("sent");
    expect((r.cleared.readme as string).length).toBe(cap);
    expect(r.cleared.readme as string).not.toContain("[cut]");
  });

  test("JSON nested so deeply that walking it fails is withheld, not thrown and not sent", () => {
    const depth = 300_000;
    const text = `{"participant_id":${"[".repeat(depth)}${"]".repeat(depth)}}`;
    const r = presend(docs({ participants_json: present(text, "participants.json") }));
    expect(["withheld_not_json", "withheld_unreadable"]).toContain(r.states.participants_json);
    expect(r.cleared.participants_json).toBeUndefined();
    expect(r.states.readme).toBe("sent");
  });

  test("every state is a member of the closed list", () => {
    const r = presend(
      docs({
        readme: { name: "README.md", state: "annexed", text: null },
        changes: absent(),
        license: present(REAL_PATH, "LICENSE"),
        participants_json: present("{", "participants.json"),
      }),
    );
    for (const d of REVIEW_DOCUMENTS) {
      expect(DOCUMENT_STATES as readonly string[]).toContain(r.states[d]);
    }
  });
});

describe("the invariant: cleared text is text the shared rules found nothing in", () => {
  const PATHS = [
    "/Users/alice/x",
    "/home/bob/y",
    "C:\\Users\\carol\\z",
    "/home/user/ok",
    "/Users/me/ok",
  ];
  const PADS = ["", "x", "x ".repeat(40), "\n\n", "\u200b", "\u0007"];

  /** A spread of documents: a path at every position relative to the cap, among several paddings. */
  function corpus(): Record<ReviewDocument, RawDocument>[] {
    const out: Record<ReviewDocument, RawDocument>[] = [];
    for (const path of PATHS) {
      for (const pad of PADS) {
        for (const document of ["readme", "changes", "license"] as const) {
          const cap = DOCUMENT_CHAR_CAPS[document];
          for (const at of [0, 7, cap - 20, cap - 5, cap, cap + 40]) {
            const body = "w".repeat(Math.max(0, at));
            out.push(docs({ [document]: present(`${pad}${body} ${path} ${pad}tail`) }));
          }
        }
        out.push(
          docs({
            dataset_description: present(
              JSON.stringify({
                Name: "A descriptive dataset name that is long enough",
                Funding: [`${pad}${path}`],
              }),
              "dataset_description.json",
            ),
            participants_json: present(
              JSON.stringify({ participant_id: { Description: `${pad}${path}` } }),
              "participants.json",
            ),
          }),
        );
      }
    }
    return out;
  }

  test("for every document of every case, a cleared string has no finding and a withheld one has one", () => {
    const cases = corpus();
    expect(cases.length).toBeGreaterThan(500);
    let cleared = 0;
    let withheld = 0;
    for (const input of cases) {
      const r = presend(input);
      for (const d of REVIEW_DOCUMENTS) {
        const text = r.cleared[d];
        if (text !== undefined) {
          cleared++;
          expect(scanTextForLocalPaths(text), `${d} cleared with a finding`).toEqual([]);
          if (d === "dataset_description" || d === "participants_json") {
            if (r.states[d] === "sent") expect(scanJsonKeys(JSON.parse(text))).toEqual([]);
          }
        } else if (r.states[d] === "withheld_finding") {
          withheld++;
        }
      }
    }
    // Guards the guard: a corpus that cleared or withheld nothing would pass vacuously.
    expect(cleared).toBeGreaterThan(1000);
    expect(withheld).toBeGreaterThan(100);
  });
});

describe("this file is the only one that mints cleared text", () => {
  const source = readFileSync(
    join(import.meta.dir, "..", "scripts", "ci", "publication-review-presend.ts"),
    "utf8",
  );

  test("it holds exactly one cast to ClearedText", () => {
    expect(source.match(/\bas\s+ClearedText\b/g)).toHaveLength(1);
  });

  test("the cast sits after the rules ran and only on the findings-free path", () => {
    const cast = source.indexOf("as ClearedText");
    const scan = source.indexOf("scanTextForLocalPaths(prepared.sent)");
    const gate = source.indexOf("if (findings.length > 0)");
    expect(scan).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(scan);
    expect(cast).toBeGreaterThan(gate);
  });

  test("the rules it applies are the shared ones, not a copy", () => {
    expect(source).toContain('from "../../shared/identifier-scan"');
    expect(source).toContain("scanTextForLocalPaths");
    expect(source).toContain("scanJsonKeys");
  });
});
