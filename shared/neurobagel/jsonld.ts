/**
 * Graph-mode JSON-LD: a Dataset with its Subjects, Sessions and Acquisitions.
 *
 * The shape is the one Neurobagel's `bagel` writes and a node's graph store
 * loads (`bagel.models.Dataset` plus the `@context` of
 * `bagel.utilities.model_utils.generate_context`), minus the optional fields
 * NEMAR has nothing honest to put in (`hasFilePath`, `hasCompletedPipeline`,
 * `hasAccessEmail`, `hasAssessment`).
 *
 * Every subject carries exactly one phenotypic session, labelled the way
 * `bagel pheno` labels a table with no session column (`ses-unnamed`), even
 * when nothing is known about the participant, because the node API only
 * matches a subject through a session.
 * Imaging sessions come from the bids index and carry one acquisition per
 * mapped datatype; see {@link imagingSessionsFor} for what is and is not known
 * about which datatype belongs to which session.
 *
 * Pure: no I/O.
 */

import { type BidsIndexSubjectWire, NO_SESSION_KEY } from "../contract/dataset.js";
import { type CanonicalJsonValue, JsonFloat, byCodeUnit } from "./canonical-json";
import { datasetName, nbIdentifier } from "./identifiers";
import { VOCAB, type VocabTerm, modalityTermForDatatype } from "./vocab";

/** `bagel`'s label for a session the source data does not name (`bagel/cli.py` CUSTOM_SESSION_LABEL). */
export const UNNAMED_SESSION_LABEL = "ses-unnamed";

export interface ImagingSessionModel {
  /** `ses-01` form, or `ses-unnamed`. */
  sessionLabel: string;
  /** BIDS datatype directories with a Neurobagel term, sorted. */
  datatypes: string[];
}

export interface SubjectModel {
  /** `sub-001` form. */
  label: string;
  phenotype: {
    age: number | null;
    sex: VocabTerm | null;
    diagnoses: VocabTerm[];
  };
  /** Sorted by label; empty when the subject has no mapped datatype. */
  imaging: ImagingSessionModel[];
}

export interface DatasetModel {
  datasetId: string;
  name: string;
  authors: string[];
  keywords: string[];
  referencesAndLinks: string[];
  repositoryUrl: string;
  accessInstructions: string;
  accessLink: string;
  /** Sorted by label. */
  subjects: SubjectModel[];
}

export interface GraphCounts {
  subjects: number;
  phenotypicSessions: number;
  imagingSessions: number;
  acquisitions: number;
}

const controlledTerm = (t: VocabTerm, schemaKey: string): CanonicalJsonValue => ({
  identifier: t.identifier,
  schemaKey,
});

/** What an imaging session list rests on, for the report. */
export type PairingBasis =
  /** `session_modalities` says which datatype is in which session. */
  | "recorded"
  /** No `session_modalities`, and at most one session label: the pairing is not in doubt. */
  | "single_session"
  /** No `session_modalities` and two or more labels: the datatypes cannot be placed. */
  | "unknown"
  /** `session_modalities` is present but not a map of labels to datatype lists. */
  | "unreadable"
  /** `session_modalities` disagrees with the subject's `modalities`; neither is trusted over the other. */
  | "inconsistent"
  /** The subject has no mapped datatype, so there is nothing to place. */
  | "none";

export interface ImagingSource {
  /** Session labels without `ses-`. */
  sessions: BidsIndexSubjectWire["sessions"];
  /** Datatype directories the subject has (keys of `modalities`). */
  datatypes: string[];
  /** `session_modalities` as served; `undefined` when the document does not carry it. */
  sessionModalities: unknown;
}

/** A readable `session_modalities`: label (or the no-session key) to a list of datatype names. */
function readSessionModalities(value: unknown): Map<string, string[]> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const map = new Map<string, string[]>();
  for (const [key, datatypes] of Object.entries(value)) {
    if (!Array.isArray(datatypes) || !datatypes.every((d) => typeof d === "string")) return null;
    map.set(key, datatypes as string[]);
  }
  return map;
}

const sameSet = (a: Iterable<string>, b: Iterable<string>): boolean => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((x) => right.has(x));
};

/**
 * The imaging sessions a subject gets, from what the bids index says.
 *
 * When the index records which datatype is in which session
 * (`session_modalities`), each session that holds a mapped datatype becomes an
 * imaging session with exactly those acquisitions.
 * A datatype directory directly under the subject (the `no-session` key) goes in
 * `ses-unnamed`, as `bagel bids` labels a subject with no session directories.
 * A session that holds nothing NEMAR maps gets no imaging session, as `bagel`
 * skips a session with no supported acquisition.
 *
 * When it does not (a document written before the field existed), the index
 * lists session labels and datatypes as two independent sets.
 * With at most one session label the pairing is not in doubt, so that session
 * (or `ses-unnamed` when the subject has none) carries the datatypes.
 * With two or more labels any pairing would be a guess, and a session claimed
 * to hold an EEG recording that it does not hold is a false statement in a
 * public index, so the datatypes go on ONE unnamed session instead: true of
 * the subject, silent about the sessions.
 *
 * A `session_modalities` that is malformed, or whose MAPPED datatypes are not the
 * subject's mapped `modalities`, is not trusted: the subject falls back to the
 * absent-field rules above and the report says why.
 * Only mapped datatypes are compared: the datatype names are directory names, not a
 * checked list, and a name no JSON object can hold (`__proto__`) is lost from
 * `modalities` on the wire but kept in a list, which says nothing about the
 * datatypes this transform emits.
 */
export function imagingSessionsFor(source: ImagingSource): {
  sessions: ImagingSessionModel[];
  basis: PairingBasis;
} {
  const mappedOf = (datatypes: Iterable<string>): string[] =>
    [...new Set(datatypes)].filter((d) => modalityTermForDatatype(d) !== null).sort(byCodeUnit);

  let degraded: "unreadable" | "inconsistent" | null = null;
  if (source.sessionModalities !== undefined) {
    const recorded = readSessionModalities(source.sessionModalities);
    if (recorded === null) {
      degraded = "unreadable";
    } else if (!sameSet(mappedOf([...recorded.values()].flat()), mappedOf(source.datatypes))) {
      degraded = "inconsistent";
    } else {
      const byLabel = new Map<string, Set<string>>();
      for (const [key, datatypes] of recorded) {
        const mapped = mappedOf(datatypes);
        if (mapped.length === 0) continue;
        const label = key === NO_SESSION_KEY ? UNNAMED_SESSION_LABEL : `ses-${key}`;
        const into = byLabel.get(label) ?? new Set<string>();
        for (const d of mapped) into.add(d);
        byLabel.set(label, into);
      }
      const sessions = [...byLabel.entries()]
        .sort(([a], [b]) => byCodeUnit(a, b))
        .map(([sessionLabel, datatypes]) => ({
          sessionLabel,
          datatypes: [...datatypes].sort(byCodeUnit),
        }));
      return { sessions, basis: "recorded" };
    }
  }

  const mapped = mappedOf(source.datatypes);
  if (mapped.length === 0) return { sessions: [], basis: degraded ?? "none" };
  const labels = [...new Set(source.sessions)];
  if (labels.length <= 1) {
    const sessionLabel = labels.length === 0 ? UNNAMED_SESSION_LABEL : `ses-${labels[0]}`;
    return { sessions: [{ sessionLabel, datatypes: mapped }], basis: degraded ?? "single_session" };
  }
  return {
    sessions: [{ sessionLabel: UNNAMED_SESSION_LABEL, datatypes: mapped }],
    basis: degraded ?? "unknown",
  };
}

async function identifiers(names: string[]): Promise<string[]> {
  return Promise.all(names.map((n) => nbIdentifier(n)));
}

/** Build the dataset graph and count its nodes. */
export async function buildJsonLd(
  dataset: DatasetModel,
): Promise<{ document: CanonicalJsonValue; counts: GraphCounts }> {
  const root = datasetName(dataset.datasetId);
  const counts: GraphCounts = {
    subjects: dataset.subjects.length,
    phenotypicSessions: dataset.subjects.length,
    imagingSessions: 0,
    acquisitions: 0,
  };

  const subjects: CanonicalJsonValue[] = [];
  // Identifiers are derived concurrently per subject; order of the output list is the
  // order of `dataset.subjects`, so concurrency cannot change the bytes.
  const built = await Promise.all(
    dataset.subjects.map(async (subject) => {
      const subjectName = `${root}/${subject.label}`;
      const phenotypicName = `${subjectName}/phenotypic/${UNNAMED_SESSION_LABEL}`;
      const imagingNames = subject.imaging.map((s) => `${subjectName}/imaging/${s.sessionLabel}`);
      const acquisitionNames = subject.imaging.flatMap((s, i) =>
        s.datatypes.map((datatype) => `${imagingNames[i]}/${datatype}`),
      );
      const [subjectId, phenotypicId, ...rest] = await identifiers([
        subjectName,
        phenotypicName,
        ...imagingNames,
        ...acquisitionNames,
      ]);
      const imagingIds = rest.slice(0, imagingNames.length);
      const acquisitionIds = rest.slice(imagingNames.length);

      const phenotypic: { [key: string]: CanonicalJsonValue | undefined } = {
        hasLabel: UNNAMED_SESSION_LABEL,
        identifier: phenotypicId,
        schemaKey: "PhenotypicSession",
      };
      if (subject.phenotype.age !== null) phenotypic.hasAge = new JsonFloat(subject.phenotype.age);
      if (subject.phenotype.sex) phenotypic.hasSex = controlledTerm(subject.phenotype.sex, "Sex");
      if (subject.phenotype.diagnoses.length > 0) {
        phenotypic.hasDiagnosis = subject.phenotype.diagnoses.map((t) =>
          controlledTerm(t, "Diagnosis"),
        );
      }

      const sessions: CanonicalJsonValue[] = [phenotypic as CanonicalJsonValue];
      let next = 0;
      subject.imaging.forEach((imagingSession, i) => {
        const acquisitions = imagingSession.datatypes.map((datatype) => {
          const modality = modalityTermForDatatype(datatype);
          if (modality === null) {
            throw new Error(
              `datatype ${datatype} has no modality term and must not reach the graph`,
            );
          }
          return {
            hasContrastType: controlledTerm(modality, "Image"),
            identifier: acquisitionIds[next++],
            schemaKey: "Acquisition",
          };
        });
        sessions.push({
          hasAcquisition: acquisitions,
          hasLabel: imagingSession.sessionLabel,
          identifier: imagingIds[i],
          schemaKey: "ImagingSession",
        });
      });
      return {
        node: {
          hasLabel: subject.label,
          hasSession: sessions,
          identifier: subjectId,
          schemaKey: "Subject",
        } as CanonicalJsonValue,
        acquisitions: acquisitionNames.length,
        imagingSessions: subject.imaging.length,
      };
    }),
  );
  for (const b of built) {
    subjects.push(b.node);
    counts.acquisitions += b.acquisitions;
    counts.imagingSessions += b.imagingSessions;
  }

  const document: { [key: string]: CanonicalJsonValue | undefined } = {
    "@context": VOCAB.context as CanonicalJsonValue,
    hasAccessInstructions: dataset.accessInstructions,
    hasAccessLink: dataset.accessLink,
    hasAccessType: "public",
    hasLabel: dataset.name,
    hasReferencesAndLinks: dataset.referencesAndLinks,
    hasRepositoryURL: dataset.repositoryUrl,
    hasSamples: subjects,
    identifier: await nbIdentifier(root),
    schemaKey: "Dataset",
  };
  // Optional lists are left out when empty, as `bagel` does (an empty list would read as "known: none").
  if (dataset.authors.length > 0) document.hasAuthors = dataset.authors;
  if (dataset.keywords.length > 0) document.hasKeywords = dataset.keywords;
  return { document: document as CanonicalJsonValue, counts };
}
