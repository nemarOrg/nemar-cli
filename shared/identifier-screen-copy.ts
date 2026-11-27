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

import type { ReaderId, ReaderNote } from "./identifier-readers";
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
const BRAINVISION =
  "the text of BrainVision header (.vhdr) files, up to 1 MiB, and marker (.vmrk) files, up to 16 MiB";
const NIRX = "the text of NIRx header (.hdr) and information (.inf) files, up to 1 MiB each";
const EEGLAB =
  "the text fields of EEGLAB .set files (classic MAT-files and v7.3), never the signal data and never the .fdt file";
const MATLAB_TEXT =
  "every character array of a MATLAB file (EEGLAB .set, Homer .nirs or .mat), walking its structs and cells; numeric arrays only under an identifier-key name, and signal data never";
const MATLAB_REMEDY =
  "Blank the value or replace it with a code in the file (in MATLAB, load it, edit the field and save it again) and upload again.";

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
    "A code, text or recording header file holds a path into someone's home directory, or a header names its companion by an absolute path.",
    "small code and text files under code/ and sourcedata/, the companion file names in BrainVision headers, BrainVision marker descriptions, and NIRx contact and notes fields",
    "Replace the path with a relative one (for a BrainVision header, the companion's file name alone) and upload again.",
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
  "brainvision-comment-name": kind(
    "The [Comment] section of a BrainVision header holds a word that may be a name.",
    BRAINVISION,
    "Check the [Comment] section of the .vhdr file; remove any name and upload again.",
    "brainvision-comment-name",
  ),
  "brainvision-segment-date": kind(
    "A New Segment marker of a BrainVision marker file holds an acquisition date finer than year and month.",
    BRAINVISION,
    "Remove or coarsen the date if it could identify someone.",
    "brainvision-segment-date",
  ),
  "nirx-subject-name": kind(
    "A person field of a NIRx file (the subject's Name, or an operator or experimenter) holds a name rather than a code.",
    NIRX,
    "Blank the field or replace it with the subject's code (for the subject, the BIDS subject label), and upload again.",
    "nirx-subject-name",
  ),
  "nirx-subject-freetext": kind(
    "The subject's Name in a NIRx .inf holds text that is neither the BIDS subject label nor a short code, and may name someone.",
    NIRX,
    "Check that it names nobody; replace it with the BIDS subject label if in doubt.",
    "nirx-subject-freetext",
  ),
  "nirx-demographics": kind(
    "The demographics of a NIRx file hold a birth date: to the day it is an identifier; as a year or a year and month it is for review.",
    NIRX,
    "Blank the birth date in the .inf file (or the NIRSport2 header's experiment notes) and upload again; a year is enough if one is needed.",
    "nirx-demographics",
  ),
  "nirx-freetext": kind(
    "A contact or notes field of a NIRx file, or text in a NIRx file the reader could not place, holds an email address or a phone number.",
    NIRX,
    "Remove the contact details from the .inf file (or the header's notes) and upload again.",
    "nirx-freetext",
  ),
  "eeglab-subject-name": kind(
    "The subject field of an EEGLAB .set file holds a name.",
    EEGLAB,
    "Replace EEG.subject with the BIDS subject label or another code, save the dataset and upload again.",
    "eeglab-subject-name",
  ),
  "eeglab-subject-freetext": kind(
    "The subject field of an EEGLAB .set file holds text that is neither the BIDS subject label nor a short code.",
    EEGLAB,
    "Check that it names nobody; replace EEG.subject with the BIDS subject label if in doubt.",
    "eeglab-subject-freetext",
  ),
  "eeglab-event-name": kind(
    "An event type of an EEGLAB .set file looks like a person's name.",
    EEGLAB,
    "Check the event types (EEG.event and EEG.urevent); rename any that names a person and upload again.",
    "eeglab-event-name",
  ),
  "eeglab-history-name": kind(
    "The processing history of an EEGLAB .set file holds what looks like a person's name.",
    EEGLAB,
    "Check EEG.history; remove any name from it, save the dataset and upload again.",
    "eeglab-history-name",
  ),
  "eeglab-setname-name": kind(
    "The set name of an EEGLAB .set file holds what looks like a person's name.",
    EEGLAB,
    "Check EEG.setname; replace any name with the BIDS subject label, save the dataset and upload again.",
    "eeglab-setname-name",
  ),
  "mat-freetext": kind(
    "A text value in a MATLAB file holds a path into someone's home directory, contact details, or text in a person's field that may name someone.",
    MATLAB_TEXT,
    MATLAB_REMEDY,
    "mat-freetext",
  ),
  "mat-freetext-name": kind(
    "A text value in a MATLAB file, in a field meant for a person (a name, a subject, a patient, an operator or an experimenter), holds a name.",
    MATLAB_TEXT,
    MATLAB_REMEDY,
    "mat-freetext-name",
  ),
  "mat-identifier-field": kind(
    "A MATLAB file has a field named for an identifier (a name, a birth date, a record number or a contact) that holds a value.",
    MATLAB_TEXT,
    "Scrub the field (blank it, or for a birth date keep the year only) in every file that has it, and resubmit.",
    "mat-identifier-field",
  ),
  "brainvision-marker-text": kind(
    "A marker description in a BrainVision marker file, or text in a BrainVision file the reader could not place, holds an email address or a phone number.",
    BRAINVISION,
    "Remove the contact details from the marker descriptions of the .vmrk file and upload again.",
    "brainvision-marker-text",
  ),
  "nirx-header-date": kind(
    "The header of a NIRx recording holds an acquisition date finer than year and month.",
    NIRX,
    "Remove or coarsen the date if it could identify someone.",
    "nirx-header-date",
  ),
};

/**
 * Notes a reader makes that are neither findings nor gaps: counted and printed with a remedy, and
 * never gating. A `Record` over {@link ReaderNote}, so a note without words fails the typecheck.
 */
export const NOTE_COPY: Record<ReaderNote, Copy> = {
  "companion-name-mismatch": {
    statement:
      "A recording's header names its data or marker file by a name other than the header's own BIDS base name. The header was read in full; this does not change the verdict.",
    read: "the DataFile and MarkerFile entries of BrainVision headers and marker files, and the FileName of NIRStar headers",
    remedy:
      "Correct the DataFile or MarkerFile entry (or NIRx FileName) to the BIDS file name of its companion, and upload again.",
    anchor: "note-companion-name-mismatch",
  },
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
    "A recording's header needs a companion file that is not beside it under the header's own base name.",
    "the dataset's paths",
    "Add the missing companion file next to its header, named with the header's base name, and upload again.",
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
    "A recording's content was not there to read (missing from storage, or not on this machine when the screen runs here), so the recording was not read.",
    "where the content is kept: its storage object, or this machine's copy for a local run",
    "On this machine, fetch the file's content (nemar dataset get) and run the screen again; for a deposit, upload the file's content again.",
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
  note: (count: number, copy: Copy) => `Note (x${count}): ${copy.statement}`,
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

// ---------------------------------------------------------------------------------------
// The local run (`nemar dataset screen`)
// ---------------------------------------------------------------------------------------

/** The docs section that explains what a local run does and does not read. */
export const LOCAL_ANCHOR = "local-run";

const local = (statement: string, read: string, remedy: string): Copy => ({
  statement,
  read,
  remedy,
  anchor: LOCAL_ANCHOR,
});

/** Which kind of scanner id a local run carries (see `localScannerId`). */
export type LocalScannerKind = "checkout" | "release";

/**
 * Every sentence only the local run says, declared once (ADR 0045). The statements name counts and
 * fixed words, never a path or a value.
 */
export const LOCAL_COPY = {
  /** The first line: which tree was read, the commit it names, and who read it. */
  banner: (source: "working-tree" | "committed", commit: string | null, cliVersion: string) =>
    `Local identifier screen of ${source === "committed" ? "the committed tree (HEAD)" : "the working tree, as the files are now"}; commit ${commit ? commit.slice(0, 12) : "none (no git history here)"}. Nothing was sent and nothing was changed (nemar-cli ${cliVersion}).`,
  /**
   * Why no screen could be made, as a fixed word with its sentence. Never a path or a value.
   * `git-failed` names the class of the failure (a fixed word), because a screen made with a git
   * that failed would claim less than the server reads.
   */
  errors: {
    "not-a-directory": "The path is not a directory.",
    "not-a-repository": "--committed needs the top level of a git repository, and this is not one.",
    "no-commit": "--committed needs a commit, and this repository has none yet.",
    "git-failed": (cause: string) =>
      `git could not be read here (${cause}), so no screen was made: a screen without git's history would say less than the server's. If this is a repository, check that git runs in it ('git status') and that you own the directory.`,
    "report-refused":
      "The scan did not fit the report contract, so no verdict was made. Please report this: https://github.com/nemarOrg/nemar-cli/issues",
  },
  /** The sentence for a failure with no word of its own. */
  fallbackError:
    "The screen could not be made. Please report this: https://github.com/nemarOrg/nemar-cli/issues",
  /** What kind of id the scanner line carries. */
  scannerKind: (kind: LocalScannerKind, id: string) =>
    kind === "checkout"
      ? `Scanner id ${id} is the git revision of the nemar-cli checkout this ran from, the same kind of id the server's screen carries.`
      : `Scanner id ${id} is the release tag of this nemar-cli build, which names an exact commit; the server's screen carries a git revision instead.`,
  /** What the server's copy holds that this run cannot see. */
  server: local(
    "Not read here: the server's copy of the dataset (its stored files, its version manifest and the branches pushed there), so the screen run on the server can differ from this one.",
    "this machine's files and git history only",
    "Request publication, or run 'nemar dataset publish status <id>', to see the server's own screen.",
  ),
  /** The working-tree mode, in a repository. */
  workingTree: local(
    "This run read the working tree; the server reads the committed tree, so a change that is not committed is read here and not there.",
    "the files in this directory as they are now",
    "Run with --committed to read what the server reads.",
  ),
  /** The committed mode. */
  committed: local(
    "This run read the committed tree (HEAD); a change that is not committed was not read.",
    "the tree of the HEAD commit",
    "Commit the change, or run without --committed to read the files as they are now.",
  ),
  /** No repository, or not its top level: no history. */
  noHistory: local(
    "Earlier commits were not read: this directory is not the top level of a readable git repository, so there is no history here, and the server screens every earlier path and recording.",
    "nothing of earlier commits",
    "Run the command at the top level of the dataset's repository to read its history too.",
  ),
  /** Recordings of earlier commits whose content is not on this machine. */
  supersededAbsent: (count: number) =>
    local(
      `${count} recording${count === 1 ? "" : "s"} from earlier commits ${count === 1 ? "has" : "have"} no content on this machine, so ${count === 1 ? "it was" : "they were"} not read and the screen is incomplete (content-absent); the server reads ${count === 1 ? "it" : "them"} from storage.`,
      "the paths of earlier commits only",
      "Fetch the old content (git annex get --all) and run the screen again, or leave it to the server's screen.",
    ),
} as const;
