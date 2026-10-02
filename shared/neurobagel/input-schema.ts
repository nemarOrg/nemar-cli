/**
 * Input contract of the Neurobagel transform: the three documents the NEMAR
 * data plane already serves for a dataset.
 *
 *   metadata.json       GET <data-host>/<id>/metadata.json (neuroschema 0.4.1 landing payload)
 *   participants.tsv    GET <data-host>/<id>/<latest>/participants.tsv   (may be absent)
 *   participants.json   GET <data-host>/<id>/<latest>/participants.json  (may be absent)
 *
 * Only the fields the transform reads are declared, and every object is
 * `.passthrough()`: this schema is a lower bound, so an additive backend field
 * never breaks the transform (the same stance as shared/contract/dataset.ts).
 *
 * IDENTITY COMES ONLY FROM metadata.json.
 * The backend writes that file and blinds it for an anonymous deposit
 * (ADR 0065); a depositor's own files cannot be blinded (ADR 0067), so the
 * dataset name, authors, keywords and DOI are never read from a participants
 * file or from a BIDS dataset_description.json.
 *
 * `anonymous` is deliberately NOT part of the parsed shape.
 * It is checked on the raw value before parsing (see transform.ts) because the
 * rule is "exactly false", and a missing or null value means unknown, which is
 * not false.
 */

import { z } from "zod";
import type { BidsIndexSubjectWire } from "../contract/dataset.js";

const authorSchema = z.object({ name: z.string() }).passthrough();
const keywordSchema = z.object({ term: z.string() }).passthrough();

/**
 * One subject of `extensions.nemar.bids_index`.
 * `sessions` are labels WITHOUT the `ses-` prefix; `modalities` are keyed by the
 * BIDS datatype directory (`eeg`, `meg`, `ieeg`, `emg`, `beh`, `anat`, ...).
 *
 * `sessions` and `modalities` are independent sets: they do not say which
 * datatype was recorded in which session.
 * `session_modalities` does (session label, or `NO_SESSION_KEY` from
 * `shared/contract/dataset.ts`, where the data plane declares it, to the
 * datatypes found in it).
 * "Datatype" there means ANY directory name found under a subject or a session
 * (`ses-pre-op`, `sourcedata`), so every datatype is filtered through an
 * allowlist before it reaches the graph.
 * It is OPTIONAL on purpose: a document written before the data plane learned
 * it omits it, and absent means unknown while present (even `{}`) is the whole
 * truth.
 * It is declared `unknown` here and read defensively in jsonld.ts, so a
 * malformed value degrades to "unknown" and is reported rather than refusing
 * the whole dataset.
 */
const bidsIndexSubjectSchema = z
  .object({
    sessions: z.array(z.string()).default([]),
    modalities: z.record(z.string(), z.object({}).passthrough()).default({}),
    session_modalities: z.unknown().optional(),
  })
  .passthrough();

/**
 * The contract's wire type must stay readable by this lenient schema: if the data
 * plane's `BidsIndexSubjectWire` ever stops being assignable to what the transform
 * parses, this stops compiling.
 */
export type WireIndexSubjectIsReadable = BidsIndexSubjectWire extends z.input<
  typeof bidsIndexSubjectSchema
>
  ? true
  : never;

export const metadataSchema = z
  .object({
    schema_version: z.string(),
    doc_type: z.literal("dataset"),
    dataset_id: z.string().regex(/^[a-z]{2}\d+$/, "neuroschema dataset_id pattern"),
    name: z.string(),
    source: z.enum(["openneuro", "nemar", "gin", "other"]).optional(),
    license: z.string().nullable().optional(),
    authors: z.array(authorSchema).default([]),
    keywords: z.array(keywordSchema).default([]),
    demographics: z
      .object({ subjects_count: z.number().int().nonnegative().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    external_links: z
      .object({ dataset_doi: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    provenance: z
      .object({ latest_snapshot: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    extensions: z
      .object({
        nemar: z
          .object({
            bids_index: z
              .object({
                version: z.string().nullable().optional(),
                subjects: z.record(z.string(), bidsIndexSubjectSchema).default({}),
              })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type NemarMetadata = z.infer<typeof metadataSchema>;

/**
 * participants.json: BIDS column descriptions keyed by column name.
 * Only `Units` of the age column is read; everything else is ignored.
 * A column value that is not an object is tolerated (and ignored) because
 * depositor files are not always well formed.
 */
export const participantsJsonSchema = z.record(z.string(), z.unknown());
export type ParticipantsJson = z.infer<typeof participantsJsonSchema>;

/**
 * The transform's input.
 * `metadata` and `participantsJson` are parsed JSON values, `participantsTsv`
 * is the file's text.
 * `null` means the data plane answered 404: the dataset has no such file.
 * A caller must not pass `null` for a file it failed to fetch; a fetch failure
 * is an error, not an absent file.
 */
export interface NeurobagelInput {
  metadata: unknown;
  participantsTsv: string | null;
  participantsJson: unknown | null;
}
