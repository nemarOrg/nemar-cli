/**
 * A tab-separated table reader that agrees with the one Neurobagel's CLI uses.
 *
 * `bagel pheno` reads `participants.tsv` with
 * `pandas.read_csv(sep="\t", keep_default_na=False, dtype=str)`, so a cell is
 * always the exact text between tabs (no "n/a" to NaN conversion, no number
 * parsing) and the same table must give the same cells here, or the transform
 * and the oracle would disagree about a value before any rule ran.
 * What that means concretely:
 *   - a field is quoted only when its FIRST character is `"`; a quote anywhere
 *     else is an ordinary character (the C tokenizer pandas uses does the same);
 *     inside a quoted field `""` is one quote and tabs and newlines are data;
 *   - blank lines are skipped;
 *   - a row with fewer fields than the header is padded with empty strings;
 *   - a row with MORE fields than the header is an error, as it is in pandas;
 *   - `\r\n` and `\n` both end a record.
 * One deliberate difference: a leading byte order mark is dropped.
 * pandas keeps it and the first column name would silently stop being
 * `participant_id`; stripping it only ever turns a broken read into a correct one.
 *
 * Pure: no I/O.
 */

export interface TsvTable {
  header: string[];
  rows: string[][];
}

export type TsvResult =
  | { ok: true; table: TsvTable; bomStripped: boolean }
  | { ok: false; error: "empty" | "ragged_row" | "unterminated_quote"; line: number };

/** Split text into records of fields, or say where it went wrong. */
function splitRecords(
  text: string,
): { ok: true; records: string[][] } | { ok: false; error: "unterminated_quote"; line: number } {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let atRecordStart = true;
  let atFieldStart = true;
  let line = 1;
  let i = 0;

  const endField = () => {
    record.push(field);
    field = "";
    atFieldStart = true;
  };
  const endRecord = () => {
    endField();
    // A record that is one empty field came from a blank line: skip it.
    if (!(record.length === 1 && record[0] === "")) records.push(record);
    record = [];
    atRecordStart = true;
  };

  while (i < text.length) {
    const ch = text[i];
    if (atFieldStart && ch === '"') {
      const startLine = line;
      i++;
      let closed = false;
      while (i < text.length) {
        const c = text[i];
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        if (c === "\n") line++;
        field += c;
        i++;
      }
      if (!closed) return { ok: false, error: "unterminated_quote", line: startLine };
      atFieldStart = false;
      atRecordStart = false;
      continue;
    }
    if (ch === "\t") {
      endField();
      atRecordStart = false;
      i++;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") {
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      endRecord();
      line++;
      i++;
      continue;
    }
    field += ch;
    atFieldStart = false;
    atRecordStart = false;
    i++;
  }
  if (!atRecordStart || field !== "" || record.length > 0) endRecord();
  return { ok: true, records };
}

export function parseTsv(input: string): TsvResult {
  const bomStripped = input.charCodeAt(0) === 0xfeff;
  const text = bomStripped ? input.slice(1) : input;
  const split = splitRecords(text);
  if (!split.ok) return split;
  const [header, ...body] = split.records;
  if (!header) return { ok: false, error: "empty", line: 1 };
  const rows: string[][] = [];
  for (let n = 0; n < body.length; n++) {
    const row = body[n];
    if (row.length > header.length) return { ok: false, error: "ragged_row", line: n + 2 };
    while (row.length < header.length) row.push("");
    rows.push(row);
  }
  return { ok: true, table: { header, rows }, bomStripped };
}
