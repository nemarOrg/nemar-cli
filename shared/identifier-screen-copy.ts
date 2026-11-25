/**
 * Every sentence the identifier screen puts in front of a person, declared once (ADR 0045).
 *
 * Each finding kind, each screen state and each reason a scan fell short has one entry: what it
 * says (`statement`), what the scanner read to say it (`read`), what to do about it (`remedy`) and
 * where the docs explain it (`anchor`, a fragment of {@link SCREEN_DOCS_URL}). The tables are
 * `Record`s over their unions, so a kind, a state or a reason without an entry fails the
 * typecheck: nothing new reaches a person without words.
 *
 * Statements name kinds and counts, never values. No call site writes a sentence of its own; the
 * report contract (`identifier-screen-report.ts`) and the terminal print from here. Two texts stay
 * with the contract by ruling: the acquisition-date warning (ADR 0090) and the notice of an
 * accepted publication request.
 */

import type { ReaderId } from "./identifier-readers";
import type { FindingKind } from "./identifier-scan";
import type {
  IncompleteReason,
  ReadFailureClass,
  ScreenDescription,
  ScreenError,
  ScreenState,
} from "./identifier-screen-report";

/** The docs page on the identifier screen. A10 adds the anchored sections. */
export const SCREEN_DOCS_URL = "https://docs.nemar.org/platform/identifier-screening/";

export interface Copy {
  /** What this is, in a sentence that names no value. */
  statement: string;
  /** What the scanner read to say it. */
  read: string;
  /** What the person can do about it. */
  remedy: string;
  /** The section of {@link SCREEN_DOCS_URL} that explains it. */
  anchor: string;
}

/** The docs link of a copy entry. */
export const docsLink = (copy: Copy): string => `${SCREEN_DOCS_URL}#${copy.anchor}`;

const HEADER = "the identification fields of the EDF/BDF header (its first 256 bytes)";
const EDF_REMEDY =
  "Blank the field or replace it with a code (for EDF/BDF, the patient and recording fields of the header) and upload again.";

const SNIRF_TAGS = "the metaDataTags group of every nirs group in a SNIRF file";
const HDF5_TEXT =
  "every string attribute and string dataset of the file that the HDF5 reader returns (signal data is never read)";
const HDF5_REMEDY =
  "Blank the value or replace it with a code in the file (h5py or MATLAB can edit it in place) and upload again.";

const kind = (statement: string, read: string, remedy: string, name: FindingKind): Copy => ({
  statement,
  read,
  remedy,
  anchor: `kind-${name}`,
});

export const KIND_COPY: Record<FindingKind, Copy> = {
  "edf-unreadable": kind(
    "An EDF/BDF header did not parse, so its identification fields were not checked.",
    HEADER,
    "Check that the file is a valid EDF, EDF+ or BDF file and upload it again.",
    "edf-unreadable",
  ),
  "edf-patient-nonascii": kind(
    "The patient field of an EDF/BDF header holds characters outside ASCII, which no rule can read.",
    HEADER,
    EDF_REMEDY,
    "edf-patient-nonascii",
  ),
  "edf-recording-nonascii": kind(
    "The recording field of an EDF/BDF header holds characters outside ASCII.",
    HEADER,
    EDF_REMEDY,
    "edf-recording-nonascii",
  ),
  "path-subject-label": kind(
    "A subject label in a file name looks like a name rather than a code.",
    "the dataset's file paths",
    "Rename the subject to a code (sub-01, sub-02, ...) and upload again.",
    "path-subject-label",
  ),
  "edf-patient-name": kind(
    "The patient field of an EDF/BDF header holds a name.",
    HEADER,
    EDF_REMEDY,
    "edf-patient-name",
  ),
  "edf-patient-code": kind(
    "The patient code of an EDF/BDF header looks like a name or a record number.",
    HEADER,
    EDF_REMEDY,
    "edf-patient-code",
  ),
  "edf-patient-recordnumber": kind(
    "The patient field of an EDF/BDF header holds a record number.",
    HEADER,
    EDF_REMEDY,
    "edf-patient-recordnumber",
  ),
  "edf-patient-age": kind(
    "The patient field of an EDF/BDF header gives an age over 89.",
    HEADER,
    EDF_REMEDY,
    "edf-patient-age",
  ),
  "edf-patient-freetext": kind(
    "The patient field of an EDF/BDF header holds free text that may name someone.",
    HEADER,
    EDF_REMEDY,
    "edf-patient-freetext",
  ),
  "edf-patient-birthdate": kind(
    "The patient field of an EDF/BDF header holds a birth date finer than the year.",
    HEADER,
    "Replace the birth date with its year only (1 January), or blank it, and upload again.",
    "edf-patient-birthdate",
  ),
  "edf-recording-startdate": kind(
    "The recording field of an EDF/BDF header holds an acquisition date finer than year and month.",
    HEADER,
    "Remove or coarsen the date if it could identify someone.",
    "edf-recording-startdate",
  ),
  "edf-recording-freetext": kind(
    "The recording field of an EDF/BDF header holds free text that may name someone.",
    HEADER,
    EDF_REMEDY,
    "edf-recording-freetext",
  ),
  "edf-recording-technician": kind(
    "The recording field of an EDF/BDF header names a technician.",
    HEADER,
    EDF_REMEDY,
    "edf-recording-technician",
  ),
  "edf-startdate": kind(
    "The start date of an EDF/BDF header is an acquisition date finer than year and month.",
    HEADER,
    "Remove or coarsen the date if it could identify someone.",
    "edf-startdate",
  ),
  "edf-startdate-unparsed": kind(
    "The start date of an EDF/BDF header holds text that is not a date.",
    HEADER,
    "Write the start date as the EDF specification gives it (dd.mm.yy) and upload again.",
    "edf-startdate-unparsed",
  ),
  "participants-identifier-column": kind(
    "participants.tsv has a column that holds identifiers, or a participant label that looks like a name.",
    "the header row and the participant labels of participants.tsv",
    "Remove the column, or replace the labels with codes, and upload again.",
    "participants-identifier-column",
  ),
  "json-identifier-key": kind(
    "A JSON file has a key that holds identifiers (a name, a birth date, a contact).",
    "the keys of JSON files that are not BIDS sidecars",
    "Remove the key or its value and upload again.",
    "json-identifier-key",
  ),
  "acq-time-dated": kind(
    "A scans table holds an acquisition date finer than year and month.",
    "the acq_time column of the scans tables",
    "Remove or coarsen the date if it could identify someone.",
    "acq-time-dated",
  ),
  "image-or-document-file": kind(
    "An image or a document is in the dataset outside the BIDS photo convention.",
    "the dataset's file paths",
    "Check that it shows no person and no name, or remove it.",
    "image-or-document-file",
  ),
  "tooling-debris": kind(
    "Editor or interpreter files are in the dataset; they can carry local user names.",
    "the dataset's file paths",
    "Remove them (.idea, .vscode, __pycache__, .DS_Store and the like) and upload again.",
    "tooling-debris",
  ),
  "local-user-path": kind(
    "A code or text file holds a path into someone's home directory.",
    "small code and text files under code/ and sourcedata/",
    "Replace the path with a relative one and upload again.",
    "local-user-path",
  ),
  "snirf-subject-name": kind(
    "The SubjectID tag of a SNIRF file holds a name.",
    SNIRF_TAGS,
    "Replace the SubjectID with the BIDS subject label or another code and upload again.",
    "snirf-subject-name",
  ),
  "snirf-subject-freetext": kind(
    "The SubjectID tag of a SNIRF file holds text that is neither the BIDS subject label nor a short code.",
    SNIRF_TAGS,
    "Check that it names nobody; replace it with the BIDS subject label if in doubt.",
    "snirf-subject-freetext",
  ),
  "snirf-measurement-date": kind(
    "The MeasurementDate tag of a SNIRF file is an acquisition date finer than year and month.",
    SNIRF_TAGS,
    "Remove or coarsen the date if it could identify someone.",
    "snirf-measurement-date",
  ),
  "hdf5-freetext": kind(
    "A text value in an HDF5 or SNIRF file holds a path into someone's home directory, or text that may name someone.",
    HDF5_TEXT,
    HDF5_REMEDY,
    "hdf5-freetext",
  ),
  "hdf5-freetext-name": kind(
    "A text value in an HDF5 or SNIRF file, in a field meant for a person (a name, a subject, a patient, an operator or an experimenter), holds a name.",
    HDF5_TEXT,
    HDF5_REMEDY,
    "hdf5-freetext-name",
  ),
  "hdf5-identifier-field": kind(
    "An HDF5 or SNIRF file has a field named for an identifier (a name, a birth date, a record number or a contact) that holds a value.",
    HDF5_TEXT,
    "Scrub the field (blank it, or for a birth date keep the year only) in every file that has it, and resubmit.",
    "hdf5-identifier-field",
  ),
};

/** How loudly a state is said. */
export type Tone = ScreenDescription["tone"];

/** What a state is called, without a surface's prefix, and how loudly. */
export interface StateCopy extends Copy {
  verdict: string;
  tone: Tone;
}

const RECORDINGS = "every recording header a registered reader parses, and the dataset's paths";

const state = (
  name: ScreenState,
  verdict: string,
  tone: Tone,
  statement: string,
  read: string,
  remedy: string,
): StateCopy => ({ verdict, tone, statement, read, remedy, anchor: `status-${name}` });

export const STATUS_COPY: Record<ScreenState, StateCopy> = {
  pending: state(
    "pending",
    "running",
    "note",
    "The screen is running.",
    "nothing yet",
    "Wait for the verdict.",
  ),
  clean: state(
    "clean",
    "clean",
    "ok",
    "Every recording was read completely and nothing was found.",
    RECORDINGS,
    "Nothing to do.",
  ),
  "dates-only": state(
    "dates-only",
    "clean (acquisition dates only)",
    "ok",
    "Every recording was read completely; the only findings are acquisition dates.",
    RECORDINGS,
    "Nothing is required; see the date warning.",
  ),
  "no-recordings": state(
    "no-recordings",
    "clean (no recordings)",
    "ok",
    "The dataset holds no recording file, and nothing else was found.",
    "the dataset's paths, tables and sidecars",
    "Nothing to do.",
  ),
  review: state(
    "review",
    "needs review",
    "warn",
    "The scanner found something a person should look at.",
    RECORDINGS,
    "Look at the kinds listed and fix what identifies someone.",
  ),
  "direct-identifiers": state(
    "direct-identifiers",
    "FOUND IDENTIFIERS",
    "stop",
    "The scanner found a direct identifier.",
    RECORDINGS,
    "Remove it from the files and run the screen again; there is no override.",
  ),
  unchecked: state(
    "unchecked",
    "INCOMPLETE",
    "warn",
    "The scanner could not read everything it should have.",
    RECORDINGS,
    "See why below; fix what it names, or acknowledge the gap.",
  ),
  "not-screened": state(
    "not-screened",
    "recordings NOT screened",
    "warn",
    "Some recordings are in formats the scanner cannot read, so their headers were not checked.",
    "the dataset's paths",
    "Check those recordings by hand, then acknowledge.",
  ),
  "partially-screened": state(
    "partially-screened",
    "partially screened, other recordings NOT screened",
    "warn",
    "The recordings the scanner can read are clean, but other recordings are in formats it cannot read.",
    RECORDINGS,
    "Check the recordings it could not read by hand, then acknowledge.",
  ),
  "clean-edf-only-others-unscreened": state(
    "clean-edf-only-others-unscreened",
    "EDF/BDF clean, other recordings NOT screened",
    "warn",
    "The EDF/BDF headers are clean, but other recordings are in formats the scanner cannot read.",
    "every EDF/BDF header, and the dataset's paths",
    "Check the recordings it could not read by hand, then acknowledge.",
  ),
  error: state(
    "error",
    "DID NOT RUN",
    "stop",
    "The screen produced no verdict.",
    "nothing",
    "Run the screen again.",
  ),
  unreported: state(
    "unreported",
    "DID NOT REPORT",
    "stop",
    "No report arrived from the screen.",
    "nothing",
    "Run the screen again.",
  ),
};

const reason = (statement: string, read: string, remedy: string, name: IncompleteReason): Copy => ({
  statement,
  read,
  remedy,
  anchor: `incomplete-${name}`,
});

const READ_AGAIN = "Run the screen again; if it repeats, report it.";

export const INCOMPLETE_COPY: Record<IncompleteReason, Copy> = {
  "edf-headers-oversize": reason(
    "Some EDF/BDF headers were too large to read.",
    "EDF/BDF headers",
    READ_AGAIN,
    "edf-headers-oversize",
  ),
  "edf-headers-sampled": reason(
    "Only a sample of the EDF/BDF headers was read.",
    "a sample of EDF/BDF headers",
    READ_AGAIN,
    "edf-headers-sampled",
  ),
  "edf-headers-unread": reason(
    "Some EDF/BDF headers could not be read.",
    "EDF/BDF headers",
    READ_AGAIN,
    "edf-headers-unread",
  ),
  "json-oversize": reason(
    "Some JSON files were too large to read.",
    "JSON files",
    "Make them smaller, or check them by hand.",
    "json-oversize",
  ),
  "json-sampled": reason(
    "Only a sample of the JSON files was read.",
    "a sample of JSON files",
    READ_AGAIN,
    "json-sampled",
  ),
  "json-unread": reason(
    "Some JSON files could not be read.",
    "JSON files",
    "Check that they are valid JSON.",
    "json-unread",
  ),
  "text-oversize": reason(
    "Some code or text files were too large to read.",
    "code and text files",
    "Check them by hand.",
    "text-oversize",
  ),
  "text-sampled": reason(
    "Only a sample of the code and text files was read.",
    "a sample of code and text files",
    READ_AGAIN,
    "text-sampled",
  ),
  "text-unread": reason(
    "Some code or text files could not be read.",
    "code and text files",
    READ_AGAIN,
    "text-unread",
  ),
  "scans-unread": reason(
    "Some scans tables could not be read.",
    "scans tables",
    READ_AGAIN,
    "scans-unread",
  ),
  "participants-unread": reason(
    "participants.tsv could not be read.",
    "participants.tsv",
    READ_AGAIN,
    "participants-unread",
  ),
  "participants-truncated": reason(
    "participants.tsv was read only in part.",
    "the first bytes of participants.tsv",
    "Check the rest of the table by hand.",
    "participants-truncated",
  ),
  "history-unread": reason(
    "The repository's history could not be read in full, so earlier versions of files were not checked.",
    "the repository's history",
    READ_AGAIN,
    "history-unread",
  ),
  "submodule-unread": reason(
    "The dataset holds a git submodule, whose content was not read.",
    "the repository tree",
    "Move the submodule's files into the dataset, or check them by hand.",
    "submodule-unread",
  ),
  "no-latest-version": reason(
    "The dataset has no published version to screen.",
    "the dataset's versions",
    "Publish a version first.",
    "no-latest-version",
  ),
  "manifest-shape": reason(
    "The dataset's file list could not be read.",
    "the dataset's manifest",
    READ_AGAIN,
    "manifest-shape",
  ),
  "tree-truncated": reason(
    "Some directories could not be listed, so their files were not seen.",
    "the dataset's directory tree",
    "Check the directory permissions and run it again.",
    "tree-truncated",
  ),
  "credentials-missing": reason(
    "The screen had no storage credentials, so it could not read headers.",
    "nothing in storage",
    READ_AGAIN,
    "credentials-missing",
  ),
  deadline: reason(
    "The screen ran out of time before it finished reading.",
    "what it reached before the deadline",
    READ_AGAIN,
    "deadline",
  ),
  "recordings-unread": reason(
    "Some recordings in a format the scanner reads could not be read.",
    RECORDINGS,
    READ_AGAIN,
    "recordings-unread",
  ),
  limit: reason(
    "A recording needed more reading than the scanner allows for one file, so it was read only in part.",
    "a recording, up to its reader's byte and read limits",
    "Check that recording by hand, or report it so the limit can be reviewed.",
    "limit",
  ),
  time: reason(
    "A recording, or the rest of the dataset, ran out of reading time, so it was read only in part.",
    "a recording, up to the time limit",
    READ_AGAIN,
    "time",
  ),
  "companion-missing": reason(
    "A recording's header names a companion file that is not in the dataset.",
    "the dataset's paths",
    "Add the missing companion file, or remove the header that names it.",
    "companion-missing",
  ),
  encrypted: reason(
    "A recording or archive is encrypted, so its content could not be read.",
    "the file's header",
    "Upload it unencrypted, or check it by hand.",
    "encrypted",
  ),
  corrupt: reason(
    "A recording's structure is damaged, so it was read only in part.",
    "the file's structure",
    "Check that the file is intact and upload it again.",
    "corrupt",
  ),
  "unsupported-version": reason(
    "A recording is in a version of its format the scanner does not read.",
    "the file's header",
    "Check it by hand, or report it so the reader is extended.",
    "unsupported-version",
  ),
  "unsupported-filter": reason(
    "A recording uses a compression filter the scanner does not read.",
    "the file's structure",
    "Check it by hand, or report it so the reader is extended.",
    "unsupported-filter",
  ),
  "unsupported-datatype": reason(
    "A recording holds a data type the scanner does not read.",
    "the file's structure",
    "Check it by hand, or report it so the reader is extended.",
    "unsupported-datatype",
  ),
  "external-link": reason(
    "A recording points to content in another file, which was not followed.",
    "the file's structure",
    "Include the linked content in the file, or check it by hand.",
    "external-link",
  ),
  "content-absent": reason(
    "A recording's content is not in storage, so it could not be read.",
    "the file's storage object",
    "Upload the file's content again.",
    "content-absent",
  ),
};

const failure = (statement: string, read: string, remedy: string, name: string): Copy => ({
  statement,
  read,
  remedy,
  anchor: `failure-${name}`,
});
const THROWN = (name: ReadFailureClass) =>
  failure(
    "The scanner's own code failed while reading a file, so that file was not read.",
    "the file, until the error",
    "Report it, so the scanner is fixed; then run the screen again.",
    name,
  );

/**
 * Why a read failed, per failure class (`read_failures` keys are `<what>/<class>`; every
 * `http-<status>` is `http`). A failed read makes its file unread; these say why and what helps.
 */
export const READ_FAILURE_COPY: Record<ReadFailureClass, Copy> = {
  timeout: failure("A read timed out.", "nothing from that file", READ_AGAIN, "timeout"),
  network: failure("A read lost its connection.", "nothing from that file", READ_AGAIN, "network"),
  deadline: failure(
    "The screen's deadline passed before this file was read.",
    "nothing from that file",
    READ_AGAIN,
    "deadline",
  ),
  "credentials-missing": failure(
    "The screen had no storage credentials for this file.",
    "nothing from that file",
    READ_AGAIN,
    "credentials-missing",
  ),
  "header-truncated": failure(
    "A table's header row was longer than the bytes the scanner reads.",
    "the first bytes of the table",
    "Shorten the header row, or check the table by hand.",
    "header-truncated",
  ),
  "json-parse": failure(
    "A JSON file is not valid JSON.",
    "the file's text",
    "Fix the file so it parses and upload it again.",
    "json-parse",
  ),
  "no-body": failure(
    "The storage server answered with no content.",
    "nothing from that file",
    READ_AGAIN,
    "no-body",
  ),
  "short-body": failure(
    "A file was shorter than its format's header, or than the storage server said.",
    "what the file held",
    "Check that the file is complete and upload it again.",
    "short-body",
  ),
  "unreadable-entry": failure(
    "A file could not be opened (a broken link, a special file, or no permission).",
    "nothing from that file",
    "Fix the file or its permissions and run it again.",
    "unreadable-entry",
  ),
  "superseded-absent": failure(
    "A recording from an earlier commit is gone from storage; it leaks nothing and is not counted.",
    "nothing; the store has no such object",
    "Nothing to do.",
    "superseded-absent",
  ),
  limit: failure(
    "A read went past the reader's limits.",
    "the file, up to its reader's limits",
    "Check that recording by hand, or report it so the limit can be reviewed.",
    "limit",
  ),
  "range-ignored": failure(
    "The storage server ignored a request for part of a file and sent the whole file, so that part was not read.",
    "nothing from that file past its first bytes",
    READ_AGAIN,
    "range-ignored",
  ),
  "blob-missing": failure(
    "A file's content is missing from the repository clone.",
    "nothing from that file",
    READ_AGAIN,
    "blob-missing",
  ),
  "blob-closed": failure(
    "The repository reader stopped before this file was read.",
    "nothing from that file",
    READ_AGAIN,
    "blob-closed",
  ),
  internal: failure(
    "A read failed in a way the scanner has no word for.",
    "nothing from that file",
    "Report it, so the scanner is fixed; then run the screen again.",
    "internal",
  ),
  "error-error": THROWN("error-error"),
  "error-rangeerror": THROWN("error-rangeerror"),
  "error-typeerror": THROWN("error-typeerror"),
  "error-syntaxerror": THROWN("error-syntaxerror"),
  "error-referenceerror": THROWN("error-referenceerror"),
  "error-evalerror": THROWN("error-evalerror"),
  "error-urierror": THROWN("error-urierror"),
  "error-aborterror": THROWN("error-aborterror"),
  "error-timeouterror": THROWN("error-timeouterror"),
  http: failure(
    "The storage server refused a read or failed (an HTTP error status).",
    "nothing from that file",
    READ_AGAIN,
    "http",
  ),
};

/** Why a screen produced no scan, as a person reads it. */
export const ERROR_TEXT: Record<ScreenError, string> = {
  "dispatch-unconfigured":
    "the screen could not be started: the Worker had no GitHub credential or callback secret, or the dataset has no repository",
  "dispatch-failed": "GitHub refused to start the screen workflow",
  "no-report-in-time":
    "no report arrived from the screen workflow in time (it may never have started)",
  "workflow-failed": "the screen workflow failed before it produced a result",
  "clone-failed": "the screen workflow could not read the dataset repository",
  "credentials-missing":
    "the screen workflow had no storage credentials, so it could not read headers",
  deadline: "the screen workflow ran out of time before it finished reading",
};

/** How each reader is named to a person. */
export const READER_LABEL: Record<ReaderId, string> = {
  edf: "EDF/BDF",
  brainvision: "BrainVision",
  nirx: "NIRx",
  snirf: "SNIRF",
  hdf5: "HDF5",
  eeglab: "EEGLAB",
  "homer-nirs": "Homer .nirs",
  mat: "MATLAB",
  zip: "ZIP",
};

// ---------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------

/** The prefix of the line that follows a statement with its remedy. */
export const REMEDY_PREFIX = "What to do: ";
/** The prefix of the line that follows a remedy with its docs link. */
export const DOCS_PREFIX = "More: ";

/** A statement's two follow-up lines: its remedy and its docs link. */
export const remedyLines = (copy: Copy): string[] => [
  `${REMEDY_PREFIX}${copy.remedy}`,
  `${DOCS_PREFIX}${docsLink(copy)}`,
];

/** Is this line a remedy or a docs link? For a terminal that sets them apart. */
export const isRemedyLine = (line: string): boolean =>
  line.startsWith(REMEDY_PREFIX) || line.startsWith(DOCS_PREFIX);

/** The fixed lines and line templates of a screen description. Counts and fixed words only. */
export const LINES = {
  notRunHeadline: "Identifier screen: NOT RUN for this request",
  notRunCause: "This request predates the screen, or the screen was never started for it.",
  screenPrefix: "Identifier screen: ",
  preflightPrefix: "Identifier preflight: ",
  cause: (text: string) => `Cause: ${text}.`,
  notRead: "Not read: the contents of sidecars and tables in earlier commits.",
  scanner: (scanner: string | null, head: string | undefined) =>
    `Scanner ${scanner}; commit ${head}.`,
  filesV1: (total: number, read: number, of: number, unreadable: number) =>
    `Files: ${total}; EDF/BDF headers read: ${read} of ${of}${unreadable > 0 ? ` (${unreadable} unreadable)` : ""}.`,
  files: (total: number) => `Files: ${total}.`,
  recordingsRead: (parts: string[], partial: number, failed: number) =>
    `Recordings read: ${parts.length > 0 ? parts.join("; ") : "none"}.${partial > 0 ? ` Partially read: ${partial}.` : ""}${failed > 0 ? ` Failed to read: ${failed}.` : ""}`,
  readerCount: (label: string, read: number, files: number) => `${label} ${read} of ${files}`,
  kinds: (phrase: string) => `Findings by kind: ${phrase}.`,
  kind: (name: string, count: number, copy: Copy) =>
    `${name} x${count}: ${copy.statement} Read: ${copy.read}.`,
  flagged: (count: number) => `EDF/BDF files with an identifier finding: ${count}.`,
  notScreened: (phrase: string) => `Not screened (format x files): ${phrase}.`,
  companionMissing: (count: number) => `Companion files missing: ${count}.`,
  incomplete: (reasons: string) => `Incomplete: ${reasons}.`,
  reason: (name: string, copy: Copy) => `Incomplete (${name}): ${copy.statement}`,
  readFailure: (key: string, count: number, copy: Copy) =>
    `Read failed (${key} x${count}): ${copy.statement}`,
  state: (copy: StateCopy) => `${copy.statement} Read: ${copy.read}.`,
  ackPrompt: "Acknowledged by the uploader at the prompt.",
  ackFlag: "Acknowledged by the uploader with --acknowledge-identifier-preflight.",
} as const;

/**
 * Why a preflight condition needs a person, in a sentence that names nothing. The terminal prints
 * it after the condition's name.
 */
export const ACKNOWLEDGE_WHY: Partial<Record<ScreenState, string>> = {
  review: "the scanner found something a person should look at (the kinds are listed above)",
  unchecked: "the scanner could not read everything it should have (see Incomplete above)",
  "not-screened":
    "some recordings are in formats the scanner cannot read, so their headers were not checked",
  "partially-screened":
    "the recordings the scanner can read are clean, but other recordings are in formats it cannot read",
  "clean-edf-only-others-unscreened":
    "the EDF/BDF headers are clean, but other recordings are in formats the scanner cannot read",
};

/** What the uploader preflight says when it refuses an upload for a direct identifier. */
export const PREFLIGHT_REFUSAL = {
  found:
    "Upload refused: the preflight found direct identifiers (a name, a birth date finer than the year, a record number, an age over 89, or an identifying column or key). Nothing was sent.",
  remove:
    "Remove them from the files (for EDF/BDF, the patient and recording fields of the header) and run the upload again.",
  noOverride: (flag: string, termsUrl: string) =>
    `There is no override, and ${flag} does not apply. If this is a false positive, please report it, so the scanner is fixed for every dataset. Terms: ${termsUrl}`,
} as const;
