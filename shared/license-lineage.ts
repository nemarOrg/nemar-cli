/**
 * Upstream license lineage (epic #2182, card D1; ADR 0139 decision 7).
 *
 * One resolver, shared by `nemar dataset license-check <path>` (the depositor's reproduction) and
 * `GET /admin/datasets/:id/license-lineage` (the administrator's view), so both compute the same
 * outcome from the same inputs:
 *
 * 1. SOURCES. The dataset's upstream sources, in this order and de-duplicated:
 *    `SourceDatasets[]` from `dataset_description.json`; enrichment `related_identifiers` of type
 *    `IsDerivedFrom` or `IsIdenticalTo`; DOIs and known repository URLs in the deposit attestation;
 *    and, in the README, only DOIs under a data-repository prefix and known repository URLs
 *    (a README cites papers, and an article is not an upstream source; lead ruling 2026-11-25).
 *    At most {@link MAX_SOURCES} are read; any beyond are listed as `not_checked`.
 * 2. RECORDS. For each DOI: DataCite, then Crossref, then OpenAlex, stopping at the first answer.
 *    Only "the registry has no such DOI" moves on to the next registry; a registry that did not
 *    answer (timeout, 5xx, 429, an unparseable body) leaves the source `unresolved`, because a
 *    verdict is never stamped from an infrastructure error. A DataCite Dataset record with no
 *    usable rights whose DOI or landing page is OpenNeuro or PhysioNet is completed from that
 *    repository's own API: the registries hold no license for either (measured 2026-11-25).
 * 3. RULE. Each source's license is normalized into a closed set, judged against the target
 *    license, and the sources are combined on a restriction lattice where the most restrictive
 *    outcome wins ({@link OUTCOME_RANK}). No outcome denies anything automatically (ADR 0139).
 *
 * Every user-visible sentence comes from {@link LINEAGE_COPY} and {@link SOURCE_STATUS_COPY}; a
 * missing entry fails the typecheck. This file has no Node or Worker imports: the CLI and the
 * Worker both run it, and each passes its own cache.
 */

import { normalizeDoiKey } from "./never-data-paper.js";

/**
 * Stamped on every result, so two results can be compared. Bump it when a rule changes, or when a
 * record gains a field (version 2: each source's title, creators and publisher, epic #2182 card B4);
 * the cache key carries it, so a record of an older version is never served.
 */
export const RESOLVER_VERSION = "license-lineage/2";

/** The User-Agent of every registry request. It carries no contact details on purpose. */
export const LICENSE_CHECK_USER_AGENT = "nemar-license-check/1";

/** Each fetch's own limit. */
export const FETCH_TIMEOUT_MS = 8_000;

/** At most this many sources of one dataset are read. */
export const MAX_SOURCES = 10;

/** How long a registry answer is cached, per DOI. */
export const CACHE_TTL_SECONDS = 24 * 60 * 60;

/** The docs page whose sections explain each outcome (anchors follow the outcome names). */
export const LINEAGE_DOCS_URL = "https://docs.nemar.org/policies/contributor-terms/";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const NORMALIZED_LICENSES = [
  "cc0",
  "pddl",
  "cc-by",
  "permissive-attribution",
  "odc-by",
  "cc-by-sa",
  "odbl",
  "cc-by-nc",
  "cc-by-nc-sa",
  "cc-by-nd",
  "cc-by-nc-nd",
  "physionet-credentialed",
  "physionet-restricted",
  "restricted",
  "other",
  "none",
] as const;
export type NormalizedLicense = (typeof NORMALIZED_LICENSES)[number];

export const LINEAGE_OUTCOMES = [
  "compatible",
  "compatible_attribution",
  "compatible_nc",
  "share_alike_mismatch",
  "needs_permission",
  "redistribution_prohibited",
  "source_is_publication",
  "no_upstream_declared",
  "unresolved",
] as const;
export type LineageOutcome = (typeof LINEAGE_OUTCOMES)[number];

/** The outcomes `nemar dataset license-check` exits 0 for. */
export const COMPATIBLE_OUTCOMES: ReadonlySet<LineageOutcome> = new Set([
  "compatible",
  "compatible_attribution",
  "compatible_nc",
]);

/**
 * The restriction lattice: a higher rank is more restrictive and wins when sources combine.
 * Known blockers outrank an unknown, and an unknown outranks every outcome that could be cleared
 * by changing only the target license (lead ruling 2026-11-25). `no_upstream_declared` only ever
 * stands alone (there are no sources to combine).
 */
export const OUTCOME_RANK: Record<LineageOutcome, number> = {
  compatible: 0,
  compatible_attribution: 1,
  compatible_nc: 2,
  share_alike_mismatch: 3,
  unresolved: 4,
  source_is_publication: 5,
  needs_permission: 6,
  redistribution_prohibited: 7,
  no_upstream_declared: 8,
};

export const SOURCE_STATUSES = [
  "resolved",
  "publication",
  "not_found",
  "fetch_failed",
  "unparseable",
  "no_doi",
  "not_checked",
  "description_unreadable",
  "metadata_unreadable",
] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export const RESOLVERS = ["datacite", "crossref", "openalex", "openneuro", "physionet"] as const;
export type Resolver = (typeof RESOLVERS)[number];

/** Where a source was declared. */
export const SOURCE_ORIGINS = [
  "source_datasets",
  "related_identifiers",
  "attestation",
  "readme",
] as const;
export type SourceOrigin = (typeof SOURCE_ORIGINS)[number];

/** One entry of a copy table: what is true, what was read, what to do, and where it is explained. */
export interface Copy {
  statement: string;
  read: string;
  remedy: string;
  anchor: string;
}

/**
 * The docs anchors this file links to, all on {@link LINEAGE_DOCS_URL}: the section `#license-lineage`
 * and one `#license-lineage-<outcome>` per outcome. A10 creates exactly these; no other anchor is used.
 */
export const LINEAGE_ANCHORS: readonly string[] = [
  "license-lineage",
  ...LINEAGE_OUTCOMES.map((o) => `license-lineage-${o.replace(/_/g, "-")}`),
];

const anchor = (id: LineageOutcome | null) =>
  `${LINEAGE_DOCS_URL}#license-lineage${id === null ? "" : `-${id.replace(/_/g, "-")}`}`;

/** What each resolver reads from its record. */
export const RESOLVER_READ: Record<Resolver, string> = {
  datacite:
    "DataCite: rightsList (access-rights statements dropped), types.resourceTypeGeneral, and titles, creators and publisher.",
  crossref:
    "Crossref: license[] (only the vor or unspecified content version, never TDM or STM-ASF terms), type, and title, author and publisher.",
  openalex:
    "OpenAlex: primary_location.license, type, title, the authorships' names and the primary location's host.",
  openneuro:
    "OpenNeuro: the snapshot's dataset_description.json License, read through its GraphQL API; the title, creators and publisher are DataCite's.",
  physionet:
    "PhysioNet: the published project's license name, access policy and title, read through its API.",
};

const READ_SOURCES = `The upstream sources declared in dataset_description.json (SourceDatasets), .nemar/metadata.json (IsDerivedFrom and IsIdenticalTo), the deposit attestation and the README (data-repository DOIs and OpenNeuro, Zenodo or PhysioNet URLs only). Then, per source: ${Object.values(
  RESOLVER_READ,
).join(" ")}`;

export const LINEAGE_COPY: Record<LineageOutcome, Copy> = {
  compatible: {
    statement: "Every upstream source is in the public domain (CC0 or PDDL).",
    read: READ_SOURCES,
    remedy: "Nothing to do. Citing the sources with IsDerivedFrom is still good practice.",
    anchor: anchor("compatible"),
  },
  compatible_attribution: {
    statement:
      "An upstream source requires attribution (CC BY, ODC-By, a matching share-alike license, or MIT, BSD or Apache-2.0, which are software licenses applied to data and still require attribution).",
    read: READ_SOURCES,
    remedy:
      "Declare each source in dataset_description.json SourceDatasets (it becomes IsDerivedFrom on the DOI) and credit it in the README. A CC0 target is allowed, but the attribution duty persists.",
    anchor: anchor("compatible_attribution"),
  },
  compatible_nc: {
    statement:
      "An upstream source is NonCommercial, and the dataset's license keeps NonCommercial.",
    read: READ_SOURCES,
    remedy:
      "Keep a NonCommercial license on the dataset and credit the source in the README and in SourceDatasets.",
    anchor: anchor("compatible_nc"),
  },
  share_alike_mismatch: {
    statement:
      "An upstream source is share-alike, and the dataset's license is not the same share-alike license at the same or a later version.",
    read: READ_SOURCES,
    remedy:
      "Change the dataset's License in dataset_description.json to the source's share-alike license (the same or a later version), or record the licensor's permission.",
    anchor: anchor("share_alike_mismatch"),
  },
  needs_permission: {
    statement:
      "An upstream source does not allow this redistribution without permission: it is NoDerivatives, all rights reserved, unlicensed or under an unrecognized license, NonCommercial while the dataset drops NonCommercial, or two sources' licenses conflict.",
    read: READ_SOURCES,
    remedy:
      "Record the licensor's written permission for this redistribution, or change the dataset's license to one the sources allow.",
    anchor: anchor("needs_permission"),
  },
  redistribution_prohibited: {
    statement:
      "An upstream source is credentialed or restricted on PhysioNet; its data use agreement forbids redistribution.",
    read: READ_SOURCES,
    remedy:
      "Only the source's own data owner can permit redistribution (PhysioNet's credentialing does not); the depositor cannot grant it. Remove the affected data, or obtain that owner's permission.",
    anchor: anchor("redistribution_prohibited"),
  },
  source_is_publication: {
    statement:
      "An upstream source is a publication, not a dataset; an article's license is not the data's license.",
    read: READ_SOURCES,
    remedy:
      "Declare the dataset the data came from (its DOI or repository URL) in SourceDatasets, or record the data owner's permission.",
    anchor: anchor("source_is_publication"),
  },
  no_upstream_declared: {
    statement: "No upstream source was found.",
    read: READ_SOURCES,
    remedy:
      "If the data came from elsewhere, declare the source in dataset_description.json SourceDatasets and in the deposit attestation; nothing is inferred. If the data is original, nothing to do.",
    anchor: anchor("no_upstream_declared"),
  },
  unresolved: {
    statement: "An upstream source's license could not be read.",
    read: READ_SOURCES,
    remedy:
      "Run the check again later. If it persists, give the source as a DOI or a known repository URL in SourceDatasets, or record its license and the licensor's permission.",
    anchor: anchor("unresolved"),
  },
};

export const SOURCE_STATUS_COPY: Record<SourceStatus, Copy> = {
  resolved: {
    statement: "The record was read.",
    read: "The source's registry or repository record.",
    remedy: "Nothing to do for this source.",
    anchor: anchor(null),
  },
  publication: {
    statement: "The record is a publication, not a dataset.",
    read: "The record's resource type.",
    remedy: "Declare the dataset the data came from instead.",
    anchor: anchor("source_is_publication"),
  },
  not_found: {
    statement: "No registry or repository holds this identifier.",
    read: "DataCite, Crossref and OpenAlex, or the repository's own record.",
    remedy: "Check the identifier for a typo.",
    anchor: anchor("unresolved"),
  },
  fetch_failed: {
    statement: "A registry or repository did not answer.",
    read: "The request to the record, which timed out or failed.",
    remedy: "Run the check again later.",
    anchor: anchor("unresolved"),
  },
  unparseable: {
    statement: "The record could not be parsed.",
    read: "The record's body.",
    remedy: "Run the check again later; report it if it persists.",
    anchor: anchor("unresolved"),
  },
  no_doi: {
    statement: "The source is a URL that maps to no DOI.",
    read: "The declared URL.",
    remedy: "Give the source as a DOI, or as an OpenNeuro, Zenodo or PhysioNet URL.",
    anchor: anchor("unresolved"),
  },
  description_unreadable: {
    statement:
      "dataset_description.json is missing or is not a JSON object, so no source or target license could be read.",
    read: "dataset_description.json at the dataset's root.",
    remedy:
      "Add a valid dataset_description.json (a JSON object with License and, for derived data, SourceDatasets), then run the check again.",
    anchor: anchor("unresolved"),
  },
  metadata_unreadable: {
    statement:
      ".nemar/metadata.json is not a JSON object, so its related identifiers could not be read.",
    read: ".nemar/metadata.json at the dataset's root.",
    remedy:
      "Restore .nemar/metadata.json (NEMAR writes it at enrichment), then run the check again.",
    anchor: anchor("unresolved"),
  },
  not_checked: {
    statement: "The source was not read: the dataset declares more sources than one check reads.",
    read: "Nothing; the source is past the limit.",
    remedy: "Declare only the dataset's direct upstream sources.",
    anchor: anchor("unresolved"),
  },
};

/**
 * The lineage outcomes that need action before a release (ADR 0139, decision 7, and its amendment of
 * 2026-11-25): each is the review reason `license_lineage_unconfirmed`, never denies automatically,
 * and is cleared by a recorded license permission (`shared/license-permission.ts`) or an override.
 */
export const ACTION_REQUIRED_OUTCOMES = [
  "needs_permission",
  "share_alike_mismatch",
  "redistribution_prohibited",
  "source_is_publication",
  "unresolved",
] as const satisfies readonly LineageOutcome[];
export type ActionRequiredOutcome = (typeof ACTION_REQUIRED_OUTCOMES)[number];

/** Where a depositor sends license evidence; inbound mail there becomes a support ticket (ADR 0112). */
export const LICENSE_EVIDENCE_ADDRESS = "support@nemar.org";

/**
 * What the depositor is asked to send, one entry per outcome that needs action, worded from the
 * owner's decision of 2026-11-25 ("the license does not agree; please provide supporting evidence
 * or supporting documents from the original authors that they accept this specific license on the
 * copy that we are publishing"). Printed wherever the outcome is shown to the depositor: the
 * publication status, the notice mail and the CLI.
 *
 * The placeholders are `{sources}` (each source's identifier and license), `{target}` (the
 * dataset's license) and `{dataset}` (the dataset id). `licensePermissionRequest` in
 * `shared/license-permission.ts` fills them from the lineage result's closed words and checked
 * identifiers only, never from free text, and drops ` ({sources})` when no source can be named.
 */
export const LINEAGE_PERMISSION_REQUEST: Record<ActionRequiredOutcome, string> = {
  needs_permission: `The license of the upstream data ({sources}) does not permit this copy under {target}. Please send evidence from the original authors that they accept this copy being published under {target}, for example an email from them, to ${LICENSE_EVIDENCE_ADDRESS}, quoting {dataset}. An administrator will record it and the review will continue.`,
  share_alike_mismatch: `The license of the upstream data ({sources}) does not permit this copy under {target}. Please send evidence from the original authors that they accept this copy being published under {target}, for example an email from them, to ${LICENSE_EVIDENCE_ADDRESS}, quoting {dataset}. An administrator will record it and the review will continue.`,
  source_is_publication: `The license of the upstream data ({sources}) does not permit this copy under {target}. Please send evidence from the original authors that they accept this copy being published under {target}, for example an email from them, to ${LICENSE_EVIDENCE_ADDRESS}, quoting {dataset}. An administrator will record it and the review will continue.`,
  redistribution_prohibited: `The license of the upstream data ({sources}) does not permit this copy under {target}. Please send evidence from the repository that holds the upstream data, for example PhysioNet, that it permits this copy being published under {target}, to ${LICENSE_EVIDENCE_ADDRESS}, quoting {dataset}; its data use agreement may bind the original authors too, so their permission alone may not be enough. An administrator will record it and the review will continue.`,
  unresolved: `NEMAR could not read the upstream license ({sources}); reply to ${LICENSE_EVIDENCE_ADDRESS} with a link to it, quoting {dataset}, or wait for the next check.`,
};

/** Sentences the upload prompt prints from the same vocabulary. */
export const LICENSE_NOTE_COPY = {
  unrecognized:
    "NEMAR does not recognize this source license, so redistributing data derived from it needs the licensor's permission.",
} as const;

// ---------------------------------------------------------------------------
// License normalization
// ---------------------------------------------------------------------------

export interface NormalizedLicenseValue {
  license: NormalizedLicense;
  /** The license version ("4.0"), when the text names one. */
  version: string | null;
}

/** An access-rights statement (`info:eu-repo/semantics/openAccess`), which is not a license. */
export function isAccessRightsUri(text: string): boolean {
  return /^info:eu-repo\/semantics\//i.test(text.trim());
}

function versionOf(text: string): string | null {
  return /(\d+\.\d+)/.exec(text)?.[1] ?? null;
}

function ccFamily(nc: boolean, nd: boolean, sa: boolean): NormalizedLicense {
  if (nd) return nc ? "cc-by-nc-nd" : "cc-by-nd";
  if (sa) return nc ? "cc-by-nc-sa" : "cc-by-sa";
  return nc ? "cc-by-nc" : "cc-by";
}

/**
 * The one table from license text (an SPDX id, a Creative Commons or Open Data Commons URI of any
 * version, a repository's license name, or free text) to the closed set. Unrecognized text is
 * `other`, never a permissive guess: misreading toward more permissive is the dangerous direction.
 */
export function normalizeLicense(text: string | null | undefined): NormalizedLicenseValue {
  if (!text || !text.trim()) return { license: "none", version: null };
  const raw = text.trim();
  const lower = raw.toLowerCase();

  if (/physionet credentialed health data/.test(lower)) {
    return { license: "physionet-credentialed", version: versionOf(raw) };
  }
  if (/physionet (restricted|contributor review) health data/.test(lower)) {
    return { license: "physionet-restricted", version: versionOf(raw) };
  }

  const software = permissiveSoftwareLicense(lower);
  if (software) return software;

  const ccUri = /creativecommons\.org\/(licenses|publicdomain)\/([a-z-]+)(?:\/(\d(?:\.\d)?))?/.exec(
    lower,
  );
  if (ccUri) {
    const [, kind, code, ver] = ccUri;
    const version = ver ? (ver.includes(".") ? ver : `${ver}.0`) : null;
    if (kind === "publicdomain") {
      // CC0 and the Public Domain Mark both place the work in the public domain (lead ruling
      // 2026-11-25); any other public-domain tool is not recognized.
      return code === "zero" || code === "mark"
        ? { license: "cc0", version }
        : { license: "other", version: null };
    }
    const parts = code.split("-");
    if (parts[0] !== "by") return { license: "other", version: null };
    return {
      license: ccFamily(parts.includes("nc"), parts.includes("nd"), parts.includes("sa")),
      version,
    };
  }

  const odcUri = /opendatacommons\.org\/licenses\/(by|odbl|pddl)/.exec(lower);
  if (odcUri) {
    const map = { by: "odc-by", odbl: "odbl", pddl: "pddl" } as const;
    return { license: map[odcUri[1] as keyof typeof map], version: versionOf(raw) };
  }

  // Token forms: SPDX ids ("CC-BY-NC-SA-4.0", "ODC-By-1.0"), OpenAlex ids ("cc-by-nc"), BIDS
  // values ("CC0", "PD").
  const token = raw.toUpperCase().replace(/[\s_]+/g, "-");
  if (/^(CC0|CC-ZERO|CC-0)(-?\d(\.\d)?(-UNIVERSAL)?)?$/.test(token)) {
    return { license: "cc0", version: "1.0" };
  }
  if (/^PUBLIC-DOMAIN$|^PD$/.test(token)) return { license: "cc0", version: null };
  if (/^PDDL(-?\d\.\d)?$/.test(token)) return { license: "pddl", version: versionOf(raw) };
  if (/^ODC-BY(-?\d\.\d)?$/.test(token)) return { license: "odc-by", version: versionOf(raw) };
  if (/^ODBL(-?\d\.\d)?$/.test(token)) return { license: "odbl", version: versionOf(raw) };
  const ccToken = /^CC-?BY((?:-(?:NC|ND|SA))*)(?:-(\d(?:\.\d)?))?(?:-[A-Z]+)?$/.exec(token);
  if (ccToken) {
    const mods = ccToken[1];
    const v = ccToken[2];
    return {
      license: ccFamily(mods.includes("NC"), mods.includes("ND"), mods.includes("SA")),
      version: v ? (v.includes(".") ? v : `${v}.0`) : null,
    };
  }

  // Free text.
  if (/creative commons zero|\bcc0\b|public domain dedication|public domain mark/.test(lower)) {
    return { license: "cc0", version: versionOf(raw) };
  }
  if (/open data commons public domain/.test(lower)) {
    return { license: "pddl", version: versionOf(raw) };
  }
  if (/open data commons attribution/.test(lower)) {
    return { license: "odc-by", version: versionOf(raw) };
  }
  if (/open data(base| commons open database)/.test(lower)) {
    return { license: "odbl", version: versionOf(raw) };
  }
  if (/creative commons|\bcc[- ]by\b/.test(lower)) {
    const nc = /non-?\s?commercial|\bnc\b/.test(lower);
    const nd = /no-?\s?deriv|\bnd\b/.test(lower);
    const sa = /share-?\s?alike|\bsa\b/.test(lower);
    if (/attribution|\bby\b/.test(lower)) {
      return { license: ccFamily(nc, nd, sa), version: versionOf(raw) };
    }
  }
  if (
    /all rights reserved|restricted|closed access|proprietary|not for redistribution|unlicensed/.test(
      lower,
    )
  ) {
    return { license: "restricted", version: null };
  }
  if (/^(none|no license|n\/a|unknown|not specified)$/.test(lower)) {
    return { license: "none", version: null };
  }
  return { license: "other", version: null };
}

/**
 * MIT, BSD (2- and 3-clause) and Apache-2.0: software licenses applied to data, read as requiring
 * attribution (lead ruling 2026-11-25). Other versions and clauses (BSD-4-Clause, Apache-1.1) are
 * not recognized here and stay `other`.
 */
function permissiveSoftwareLicense(lower: string): NormalizedLicenseValue | null {
  const t = lower.trim();
  if (/^mit$|^mit license$|opensource\.org\/licenses\/mit\b|^expat$/.test(t)) {
    return { license: "permissive-attribution", version: null };
  }
  if (
    /^bsd[- ]?[23][- ]?clause\b|opensource\.org\/licenses\/bsd-[23]-clause|^bsd [23]-clause\b/.test(
      t,
    )
  ) {
    return { license: "permissive-attribution", version: null };
  }
  if (
    /^apache[- ]2(\.0)?$|^apache license,? (version )?2\.0$|apache\.org\/licenses\/license-2\.0|opensource\.org\/licenses\/apache-2\.0/.test(
      t,
    )
  ) {
    return { license: "permissive-attribution", version: "2.0" };
  }
  return null;
}

/** Restrictiveness of a license on its own, used to pick one license when a record lists several. */
const LICENSE_RANK: Record<NormalizedLicense, number> = {
  cc0: 0,
  pddl: 1,
  "odc-by": 2,
  "cc-by": 3,
  "permissive-attribution": 3.5,
  "cc-by-sa": 4,
  odbl: 5,
  "cc-by-nc": 6,
  "cc-by-nc-sa": 7,
  "cc-by-nd": 8,
  "cc-by-nc-nd": 9,
  other: 10,
  none: 11,
  restricted: 12,
  "physionet-credentialed": 13,
  "physionet-restricted": 14,
};

/** The most restrictive of several licenses one record lists; `none` when it lists none. */
export function mostRestrictive(values: NormalizedLicenseValue[]): NormalizedLicenseValue {
  let best: NormalizedLicenseValue = { license: "none", version: null };
  let first = true;
  for (const v of values) {
    if (first || LICENSE_RANK[v.license] > LICENSE_RANK[best.license]) best = v;
    first = false;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type SourceRef =
  | { kind: "doi"; doi: string; origin: SourceOrigin }
  | { kind: "openneuro_latest"; ds: string; origin: SourceOrigin }
  | { kind: "physionet"; slug: string; version: string | null; origin: SourceOrigin }
  | { kind: "url"; url: string; origin: SourceOrigin };

/** NEMAR's own DOI prefix (EZID shoulder `doi:10.82901/NEMAR.`, backend/src/services/ezid.ts). */
export const NEMAR_DOI_PREFIX = "10.82901";

/** DOI prefixes of data repositories, the only DOIs taken from a README. */
export const DATA_REPOSITORY_DOI_PREFIXES = [
  "10.18112", // OpenNeuro
  "10.5281", // Zenodo
  "10.13026", // PhysioNet
  "10.6084", // figshare
  "10.17605", // OSF
  "10.5061", // Dryad
  "10.7910", // Harvard Dataverse
] as const;

const DOI_IN_TEXT = /\b10\.\d{4,9}\/[^\s"'<>\]\[(){}]+/g;
const OPENNEURO_URL = /openneuro\.org\/datasets\/(ds\d{6})(?:\/versions\/([0-9][\w.-]*))?/i;
const OPENNEURO_DOI = /^10\.18112\/openneuro\.(ds\d{6})(?:\.v([0-9][\w.-]*))?$/i;
const ZENODO_URL = /zenodo\.org\/(?:records?|deposit)\/(\d+)/i;
const PHYSIONET_URL = /physionet\.org\/(?:content|files)\/([a-z0-9][a-z0-9-]*)(?:\/(\d[\w.]*))?/i;
const KNOWN_URLS_IN_TEXT =
  /https?:\/\/(?:www\.)?(?:openneuro\.org\/datasets\/ds\d{6}(?:\/versions\/[0-9][\w.-]*)?|zenodo\.org\/(?:records?|deposit)\/\d+|physionet\.org\/(?:content|files)\/[a-z0-9][a-z0-9-]*(?:\/\d[\w.]*)?)/gi;

function trimVersion(v: string): string {
  return v.replace(/[.,;:]+$/, "");
}

function doiRef(doiText: string, origin: SourceOrigin): SourceRef {
  const doi = normalizeDoiKey(doiText);
  const on = OPENNEURO_DOI.exec(doi);
  if (on && !on[2]) return { kind: "openneuro_latest", ds: on[1].toLowerCase(), origin };
  return { kind: "doi", doi, origin };
}

/** One declared identifier (a DOI in any form, or a URL) as a source, or null when it is empty. */
export function refFromIdentifier(
  text: string,
  origin: SourceOrigin,
  versionHint?: string | null,
): SourceRef | null {
  const t = text.trim();
  if (!t) return null;
  if (/^(doi:|https?:\/\/(dx\.)?doi\.org\/|10\.\d{4,9}\/)/i.test(t)) return doiRef(t, origin);
  const on = OPENNEURO_URL.exec(t);
  if (on) {
    const version = on[2] ? trimVersion(on[2]) : versionHint?.trim() || null;
    const ds = on[1].toLowerCase();
    return version
      ? { kind: "doi", doi: `10.18112/openneuro.${ds}.v${version}`, origin }
      : { kind: "openneuro_latest", ds, origin };
  }
  const zen = ZENODO_URL.exec(t);
  if (zen) return { kind: "doi", doi: `10.5281/zenodo.${zen[1]}`, origin };
  const zenDoi = /zenodo\.org\/doi\/(10\.\d{4,9}\/\S+)/i.exec(t);
  if (zenDoi) return doiRef(zenDoi[1], origin);
  const pn = PHYSIONET_URL.exec(t);
  if (pn) {
    return {
      kind: "physionet",
      slug: pn[1].toLowerCase(),
      version: pn[2] ? trimVersion(pn[2]) : versionHint?.trim() || null,
      origin,
    };
  }
  return { kind: "url", url: t, origin };
}

/** DOIs and known repository URLs in free text. `anyDoi` false keeps only data-repository DOIs. */
export function refsFromText(text: string, origin: SourceOrigin, anyDoi: boolean): SourceRef[] {
  const refs: SourceRef[] = [];
  for (const m of text.match(DOI_IN_TEXT) ?? []) {
    const doi = normalizeDoiKey(m);
    if (!anyDoi && !DATA_REPOSITORY_DOI_PREFIXES.some((p) => doi.startsWith(`${p}/`))) continue;
    refs.push(doiRef(doi, origin));
  }
  for (const m of text.match(KNOWN_URLS_IN_TEXT) ?? []) {
    const ref = refFromIdentifier(m, origin);
    if (ref) refs.push(ref);
  }
  return refs;
}

export function refKey(ref: SourceRef): string {
  switch (ref.kind) {
    case "doi":
      return `doi:${ref.doi}`;
    case "openneuro_latest":
      return `openneuro:${ref.ds}`;
    case "physionet":
      return `physionet:${ref.slug}:${ref.version ?? ""}`;
    case "url":
      return `url:${ref.url}`;
  }
}

/** What a dataset declares about its upstream: the four inputs, as read from the deposit. */
/** What the sources are extracted from, already parsed. */
export interface SourceInputs {
  /** The parsed `dataset_description.json`, or null. */
  datasetDescription: unknown;
  /** The enrichment's `related_identifiers` (`.nemar/metadata.json`), or null. */
  relatedIdentifiers: unknown;
  /** `datasets.attestation.upstream_source`, or null (a local check has none). */
  attestationUpstreamSource: string | null;
  /** The README text, or null. */
  readme: string | null;
}

/** What a dataset declares, as the files' text: null is a file that is not there. */
export interface LineageInputs {
  /** `dataset_description.json` as text, or null when it is missing. */
  datasetDescription: string | null;
  /** `.nemar/metadata.json` as text, or null when it is missing. */
  nemarMetadata: string | null;
  /** `datasets.attestation.upstream_source`, or null (a local check has none). */
  attestationUpstreamSource: string | null;
  /** The README text, or null. */
  readme: string | null;
}

export type InputReadState = "read" | "missing" | "unparseable";

/** How each input file read: a missing file and one that cannot be parsed are different answers. */
export interface InputReadStates {
  dataset_description: InputReadState;
  nemar_metadata: InputReadState;
  readme: "read" | "missing";
}

function parseObject(text: string | null): {
  state: InputReadState;
  value: Record<string, unknown> | null;
} {
  if (text === null) return { state: "missing", value: null };
  try {
    const v: unknown = JSON.parse(text);
    return isRecord(v) ? { state: "read", value: v } : { state: "unparseable", value: null };
  } catch {
    return { state: "unparseable", value: null };
  }
}

/** Parse the input files and say how each one read. */
export function readLineageInputs(inputs: LineageInputs): {
  states: InputReadStates;
  sources: SourceInputs;
} {
  const desc = parseObject(inputs.datasetDescription);
  const meta = parseObject(inputs.nemarMetadata);
  return {
    states: {
      dataset_description: desc.state,
      nemar_metadata: meta.state,
      readme: inputs.readme === null ? "missing" : "read",
    },
    sources: {
      datasetDescription: desc.value,
      relatedIdentifiers: meta.value?.related_identifiers ?? null,
      attestationUpstreamSource: inputs.attestationUpstreamSource,
      readme: inputs.readme,
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The target license as the dataset declares it (`dataset_description.json` License). */
export function declaredLicense(datasetDescription: unknown): string | null {
  if (!isRecord(datasetDescription)) return null;
  const v = datasetDescription.License;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Every declared source, in the decided order, de-duplicated. */
export function extractSourceRefs(inputs: SourceInputs): SourceRef[] {
  const refs: SourceRef[] = [];
  const desc = inputs.datasetDescription;
  if (isRecord(desc) && Array.isArray(desc.SourceDatasets)) {
    for (const entry of desc.SourceDatasets) {
      if (!isRecord(entry)) continue;
      const version = typeof entry.Version === "string" ? entry.Version : null;
      const doi = typeof entry.DOI === "string" ? entry.DOI : "";
      const url = typeof entry.URL === "string" ? entry.URL : "";
      const ref =
        refFromIdentifier(doi, "source_datasets", version) ??
        refFromIdentifier(url, "source_datasets", version);
      if (ref) refs.push(ref);
    }
  }
  if (Array.isArray(inputs.relatedIdentifiers)) {
    for (const entry of inputs.relatedIdentifiers) {
      if (!isRecord(entry)) continue;
      const relation = entry.relation_type;
      if (relation !== "IsDerivedFrom" && relation !== "IsIdenticalTo") continue;
      if (typeof entry.identifier !== "string") continue;
      const type = entry.identifier_type;
      const ref =
        type === "DOI"
          ? doiRef(entry.identifier, "related_identifiers")
          : refFromIdentifier(entry.identifier, "related_identifiers");
      if (ref) refs.push(ref);
    }
  }
  if (inputs.attestationUpstreamSource) {
    refs.push(...refsFromText(inputs.attestationUpstreamSource, "attestation", true));
  }
  if (inputs.readme) {
    // A README names its own dataset: never NEMAR's own DOIs, which no upstream source carries.
    refs.push(
      ...refsFromText(inputs.readme, "readme", false).filter(
        (r) => !(r.kind === "doi" && r.doi.startsWith(`${NEMAR_DOI_PREFIX}/`)),
      ),
    );
  }

  // A dataset is not its own upstream source, whichever input names it.
  const own =
    isRecord(desc) && typeof desc.DatasetDOI === "string" && desc.DatasetDOI.trim()
      ? normalizeDoiKey(desc.DatasetDOI)
      : null;
  const seen = new Set<string>();
  return refs.filter((r) => {
    if (own !== null && r.kind === "doi" && r.doi === own) return false;
    const k = refKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export interface RegistryBases {
  datacite: string;
  crossref: string;
  openalex: string;
  /** The OpenNeuro origin; GraphQL is at `/crn/graphql`. */
  openneuro: string;
  physionet: string;
}

export const DEFAULT_BASES: RegistryBases = {
  datacite: "https://api.datacite.org",
  crossref: "https://api.crossref.org",
  openalex: "https://api.openalex.org",
  openneuro: "https://openneuro.org",
  physionet: "https://physionet.org",
};

/** What one source's record said. Cached per DOI; only answers are cached, never a failure. */
export interface SourceRecord {
  id: string;
  resolver: Resolver | null;
  resource_type: string | null;
  /** The record's title, as the registry gave it; null when it gave none. */
  title: string | null;
  /** The record's creators' names, in the registry's order, at most {@link MAX_CREATORS}. */
  creators: string[];
  /** The record's publisher (a repository, a journal's publisher); null when it gave none. */
  publisher: string | null;
  license: NormalizedLicense | null;
  license_version: string | null;
  /** The license text exactly as the record gave it (joined when several). */
  raw: string | null;
  evidence_url: string | null;
  status: SourceStatus;
}

/** The most creators' names a record keeps. */
export const MAX_CREATORS = 10;

/** A record's descriptive fields: title, creators and publisher. */
type Described = Pick<SourceRecord, "title" | "creators" | "publisher">;

const NOT_DESCRIBED: Described = { title: null, creators: [], publisher: null };

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function names(list: unknown, nameOf: (entry: Record<string, unknown>) => string | null): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    if (out.length >= MAX_CREATORS) break;
    const n = isRecord(entry) ? nameOf(entry) : null;
    if (n !== null) out.push(n);
  }
  return out;
}

/** DataCite's `titles`, `creators` and `publisher` (a string, or `{ name }` in the newer form). */
export function dataciteDescribed(a: Record<string, unknown>): Described {
  const titles = Array.isArray(a.titles) ? a.titles : [];
  const first = titles.find((t) => isRecord(t) && text(t.title) !== null);
  const pub = isRecord(a.publisher) ? text(a.publisher.name) : text(a.publisher);
  return {
    title: isRecord(first) ? text(first.title) : null,
    creators: names(a.creators, (c) => text(c.name)),
    publisher: pub,
  };
}

/** Crossref's `title[]`, `author[]` (given and family, or a name) and `publisher`. */
export function crossrefDescribed(m: Record<string, unknown>): Described {
  const titles = Array.isArray(m.title) ? m.title : [];
  return {
    title: text(titles.find((t) => text(t) !== null)),
    creators: names(m.author, (a) => {
      const full = [text(a.given), text(a.family)].filter((x) => x !== null).join(" ");
      return full !== "" ? full : text(a.name);
    }),
    publisher: text(m.publisher),
  };
}

/** OpenAlex's `title`, its authorships' names, and the host of its primary location. */
export function openalexDescribed(w: Record<string, unknown>): Described {
  const pl = isRecord(w.primary_location) ? w.primary_location : {};
  const src = isRecord(pl.source) ? pl.source : {};
  return {
    title: text(w.title) ?? text(w.display_name),
    creators: names(w.authorships, (a) =>
      isRecord(a.author) ? text(a.author.display_name) : null,
    ),
    publisher: text(src.host_organization_name) ?? text(src.display_name),
  };
}

/** A per-DOI answer cache: the Worker passes one over `caches.default`; the CLI a Map. */
export interface LineageCache {
  get(key: string): Promise<SourceRecord | undefined>;
  put(key: string, record: SourceRecord): Promise<void>;
}

export function mapCache(): LineageCache {
  const m = new Map<string, SourceRecord>();
  return {
    get: async (k) => m.get(k),
    put: async (k, r) => {
      m.set(k, r);
    },
  };
}

export interface ResolveOptions {
  bases?: RegistryBases;
  timeoutMs?: number;
  cache?: LineageCache;
  now?: () => Date;
}

type Fetched =
  | { kind: "ok"; body: unknown }
  | { kind: "absent" }
  | { kind: "failed"; status: SourceStatus };

async function getJson(url: string, timeoutMs: number, init?: RequestInit): Promise<Fetched> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        "User-Agent": LICENSE_CHECK_USER_AGENT,
        ...(init?.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: "failed", status: "fetch_failed" };
  }
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    return { kind: "absent" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { kind: "failed", status: "fetch_failed" };
  }
  try {
    return { kind: "ok", body: await response.json() };
  } catch {
    // A body that stops mid-stream (the timeout) is a failed fetch; one that arrived and is not
    // JSON is unparseable. Both are unresolved.
    return { kind: "failed", status: "unparseable" };
  }
}

function failedRecord(id: string, status: SourceStatus, evidence: string | null): SourceRecord {
  return {
    id,
    resolver: null,
    resource_type: null,
    ...NOT_DESCRIBED,
    license: null,
    license_version: null,
    raw: null,
    evidence_url: evidence,
    status,
  };
}

function withLicense(
  base: Omit<SourceRecord, "license" | "license_version" | "raw" | "status">,
  values: NormalizedLicenseValue[],
  raws: string[],
  isDataset: boolean,
): SourceRecord {
  const chosen = mostRestrictive(values);
  return {
    ...base,
    license: chosen.license,
    license_version: chosen.version,
    raw: raws.length > 0 ? raws.join(" | ") : null,
    status: isDataset ? "resolved" : "publication",
  };
}

/** DataCite's `rightsList`, access-rights statements removed. */
export function dataciteLicenses(rightsList: unknown): {
  values: NormalizedLicenseValue[];
  raws: string[];
} {
  const values: NormalizedLicenseValue[] = [];
  const raws: string[] = [];
  if (!Array.isArray(rightsList)) return { values, raws };
  for (const r of rightsList) {
    if (!isRecord(r)) continue;
    const texts = [r.rightsIdentifier, r.rightsUri, r.rights].filter(
      (t): t is string => typeof t === "string" && t.trim() !== "",
    );
    if (texts.length === 0 || texts.some(isAccessRightsUri)) continue;
    let value = normalizeLicense(texts[0]);
    for (const t of texts.slice(1)) {
      if (value.license !== "other") break;
      value = normalizeLicense(t);
    }
    values.push(value);
    raws.push(String(r.rightsUri ?? r.rightsIdentifier ?? r.rights));
  }
  return { values, raws };
}

/** Crossref's `license[]`: only `vor` or `unspecified` content versions, no TDM or STM-ASF terms. */
export function crossrefLicenses(license: unknown): {
  values: NormalizedLicenseValue[];
  raws: string[];
} {
  const values: NormalizedLicenseValue[] = [];
  const raws: string[] = [];
  if (!Array.isArray(license)) return { values, raws };
  for (const l of license) {
    if (!isRecord(l) || typeof l.URL !== "string") continue;
    const cv = typeof l["content-version"] === "string" ? l["content-version"] : "unspecified";
    if (cv !== "vor" && cv !== "unspecified") continue;
    if (/\/tdm\/|stm-asf|text-and-data-mining/i.test(l.URL)) continue;
    values.push(normalizeLicense(l.URL));
    raws.push(l.URL);
  }
  return { values, raws };
}

const CROSSREF_DATA_TYPES = new Set(["dataset", "database"]);

async function resolveOpenNeuro(
  id: string,
  ds: string,
  version: string,
  resourceType: string | null,
  /** The DataCite record's title, creators and publisher: OpenNeuro's answer holds only the license. */
  described: Described,
  o: Required<Omit<ResolveOptions, "cache" | "now">>,
): Promise<SourceRecord> {
  const evidence = `https://openneuro.org/datasets/${ds}/versions/${version}`;
  const query = `query { snapshot(datasetId: "${ds}", tag: "${version}") { tag description { License } } }`;
  const got = await getJson(`${o.bases.openneuro}/crn/graphql`, o.timeoutMs, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (got.kind === "absent") return failedRecord(id, "not_found", evidence);
  if (got.kind === "failed") return failedRecord(id, got.status, evidence);
  const body = got.body;
  if (!isRecord(body) || !isRecord(body.data)) return failedRecord(id, "unparseable", evidence);
  const snap = body.data.snapshot;
  if (snap === null) return failedRecord(id, "not_found", evidence);
  if (!isRecord(snap) || !isRecord(snap.description)) {
    return failedRecord(id, "unparseable", evidence);
  }
  const lic = snap.description.License;
  const raw = typeof lic === "string" && lic.trim() ? lic.trim() : null;
  return withLicense(
    {
      id,
      resolver: "openneuro",
      resource_type: resourceType ?? "Dataset",
      ...described,
      evidence_url: evidence,
    },
    raw ? [normalizeLicense(raw)] : [],
    raw ? [raw] : [],
    (resourceType ?? "Dataset") === "Dataset",
  );
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * A PhysioNet project's license. The access policy decides before the license name: anything but
 * open access is a data use agreement the depositor cannot clear (lead ruling 2026-11-25).
 */
export function physionetLicense(
  name: string | null,
  accessPolicy: string | null,
): NormalizedLicenseValue {
  const policy = accessPolicy?.trim().toLowerCase() ?? null;
  if (policy === "credentialed") return { license: "physionet-credentialed", version: null };
  if (policy !== null && policy !== "open")
    return { license: "physionet-restricted", version: null };
  return normalizeLicense(name);
}

async function resolvePhysioNet(
  fallbackId: string,
  slug: string,
  version: string | null,
  o: Required<Omit<ResolveOptions, "cache" | "now">>,
  /** The DataCite record's creators and publisher, when it led here; PhysioNet's API names none. */
  described: Described = NOT_DESCRIBED,
): Promise<SourceRecord> {
  const api = `${o.bases.physionet}/api/v1/project/published/${encodeURIComponent(slug)}/`;
  let ver = version;
  if (!ver) {
    const list = await getJson(api, o.timeoutMs);
    if (list.kind === "absent") return failedRecord(fallbackId, "not_found", api);
    if (list.kind === "failed") return failedRecord(fallbackId, list.status, api);
    if (!Array.isArray(list.body)) return failedRecord(fallbackId, "unparseable", api);
    const versions = list.body
      .map((p) => (isRecord(p) && typeof p.version === "string" ? p.version : null))
      .filter((v): v is string => v !== null)
      .sort(compareVersions);
    if (versions.length === 0) return failedRecord(fallbackId, "not_found", api);
    ver = versions[versions.length - 1];
  }
  const url = `${api}${encodeURIComponent(ver)}/`;
  const got = await getJson(url, o.timeoutMs);
  if (got.kind === "absent") return failedRecord(fallbackId, "not_found", url);
  if (got.kind === "failed") return failedRecord(fallbackId, got.status, url);
  const p = got.body;
  if (!isRecord(p)) return failedRecord(fallbackId, "unparseable", url);
  const id = typeof p.doi === "string" && p.doi ? normalizeDoiKey(p.doi) : fallbackId;
  const name = isRecord(p.license) && typeof p.license.name === "string" ? p.license.name : null;
  // The access policy decides the license, so a record without one is not a record we can read.
  if (typeof p.access_policy !== "string") return failedRecord(fallbackId, "unparseable", url);
  const value = physionetLicense(name, p.access_policy);
  // PhysioNet calls a data project a "Database"; software and models are not data.
  const resourceType =
    p.resource_type === "Database"
      ? "Dataset"
      : typeof p.resource_type === "string"
        ? p.resource_type
        : null;
  const raws = [name, p.access_policy].filter((x): x is string => typeof x === "string" && !!x);
  return withLicense(
    {
      id,
      resolver: "physionet",
      resource_type: resourceType,
      title: text(p.title) ?? described.title,
      creators: described.creators,
      publisher: described.publisher ?? "PhysioNet",
      evidence_url: url,
    },
    [value],
    raws,
    resourceType === "Dataset",
  );
}

/** One DOI's record: DataCite, then Crossref, then OpenAlex; a repository API completes it. */
async function resolveDoiUncached(
  doi: string,
  o: Required<Omit<ResolveOptions, "cache" | "now">>,
): Promise<SourceRecord> {
  const enc = encodeURIComponent(doi);
  const dcUrl = `${o.bases.datacite}/dois/${enc}`;
  const dc = await getJson(dcUrl, o.timeoutMs);
  if (dc.kind === "failed") return failedRecord(doi, dc.status, dcUrl);
  if (dc.kind === "ok") {
    const body = dc.body;
    if (!isRecord(body) || !isRecord(body.data) || !isRecord(body.data.attributes)) {
      return failedRecord(doi, "unparseable", dcUrl);
    }
    const a = body.data.attributes;
    const types = isRecord(a.types) ? a.types : {};
    const rtg = typeof types.resourceTypeGeneral === "string" ? types.resourceTypeGeneral : null;
    const { values, raws } = dataciteLicenses(a.rightsList);
    const isDataset = rtg === "Dataset";
    const landing = typeof a.url === "string" ? a.url : "";
    if (isDataset && values.length === 0) {
      const on = OPENNEURO_DOI.exec(doi);
      const onLanding = OPENNEURO_URL.exec(landing);
      const ds = on?.[1] ?? onLanding?.[1];
      const ver = on?.[2] ?? onLanding?.[2];
      if (ds && ver) {
        return resolveOpenNeuro(doi, ds.toLowerCase(), ver, rtg, dataciteDescribed(a), o);
      }
      const pn = PHYSIONET_URL.exec(landing);
      if (pn) {
        const rec = await resolvePhysioNet(
          doi,
          pn[1].toLowerCase(),
          pn[2] ?? null,
          o,
          dataciteDescribed(a),
        );
        return { ...rec, id: doi };
      }
    }
    return withLicense(
      {
        id: doi,
        resolver: "datacite",
        resource_type: rtg,
        ...dataciteDescribed(a),
        evidence_url: dcUrl,
      },
      values,
      raws,
      isDataset,
    );
  }

  const crUrl = `${o.bases.crossref}/works/${enc}`;
  const cr = await getJson(crUrl, o.timeoutMs);
  if (cr.kind === "failed") return failedRecord(doi, cr.status, crUrl);
  if (cr.kind === "ok") {
    const msg = isRecord(cr.body) ? cr.body.message : null;
    if (!isRecord(msg)) return failedRecord(doi, "unparseable", crUrl);
    const type = typeof msg.type === "string" ? msg.type : null;
    const { values, raws } = crossrefLicenses(msg.license);
    return withLicense(
      {
        id: doi,
        resolver: "crossref",
        resource_type: type,
        ...crossrefDescribed(msg),
        evidence_url: crUrl,
      },
      values,
      raws,
      type !== null && CROSSREF_DATA_TYPES.has(type),
    );
  }

  const oaUrl = `${o.bases.openalex}/works/doi:${enc}`;
  const oa = await getJson(oaUrl, o.timeoutMs);
  if (oa.kind === "failed") return failedRecord(doi, oa.status, oaUrl);
  if (oa.kind === "absent") return failedRecord(doi, "not_found", oaUrl);
  const w = oa.body;
  if (!isRecord(w)) return failedRecord(doi, "unparseable", oaUrl);
  const type = typeof w.type === "string" ? w.type : null;
  const pl = isRecord(w.primary_location) ? w.primary_location : {};
  const lic = typeof pl.license === "string" && pl.license ? pl.license : null;
  return withLicense(
    {
      id: doi,
      resolver: "openalex",
      resource_type: type,
      ...openalexDescribed(w),
      evidence_url: oaUrl,
    },
    lic ? [normalizeLicense(lic)] : [],
    lic ? [lic] : [],
    type === "dataset",
  );
}

/** Statuses that are answers and may be cached; a failure is asked again next time. */
const CACHEABLE: ReadonlySet<SourceStatus> = new Set(["resolved", "publication", "not_found"]);

/** A cached answer is used only when it is a record this version could have written; else a miss. */
export function isValidCachedRecord(hit: unknown): hit is SourceRecord {
  return (
    isRecord(hit) &&
    typeof hit.id === "string" &&
    typeof hit.status === "string" &&
    Array.isArray(hit.creators) &&
    (SOURCE_STATUSES as readonly string[]).includes(hit.status) &&
    CACHEABLE.has(hit.status as SourceStatus) &&
    (hit.license === null ||
      (NORMALIZED_LICENSES as readonly string[]).includes(String(hit.license)))
  );
}

async function cached(
  key: string,
  cache: LineageCache | undefined,
  run: () => Promise<SourceRecord>,
): Promise<SourceRecord> {
  const k = `${RESOLVER_VERSION}:${key}`;
  const hit = await cache?.get(k).catch(() => undefined);
  if (isValidCachedRecord(hit)) return hit;
  const rec = await run();
  if (cache && CACHEABLE.has(rec.status)) await cache.put(k, rec).catch(() => undefined);
  return rec;
}

async function resolveRef(
  ref: SourceRef,
  o: Required<Omit<ResolveOptions, "cache" | "now">>,
  cache: LineageCache | undefined,
): Promise<SourceRecord> {
  switch (ref.kind) {
    case "doi":
      return cached(`doi:${ref.doi}`, cache, () => resolveDoiUncached(ref.doi, o));
    case "url":
      return failedRecord(ref.url, "no_doi", null);
    case "physionet": {
      const id = `https://physionet.org/content/${ref.slug}/${ref.version ? `${ref.version}/` : ""}`;
      return cached(`physionet:${ref.slug}:${ref.version ?? ""}`, cache, () =>
        resolvePhysioNet(id, ref.slug, ref.version, o),
      );
    }
    case "openneuro_latest": {
      // The latest version record from DataCite, then that DOI as any other.
      const q = new URLSearchParams({
        query: `id:10.18112/openneuro.${ref.ds}.v*`,
        sort: "-created",
        "page[size]": "1",
      });
      const url = `${o.bases.datacite}/dois?${q.toString()}`;
      const got = await getJson(url, o.timeoutMs);
      const id = `10.18112/openneuro.${ref.ds}`;
      if (got.kind === "failed") return failedRecord(id, got.status, url);
      if (got.kind === "absent") return failedRecord(id, "not_found", url);
      const data = isRecord(got.body) ? got.body.data : null;
      if (!Array.isArray(data)) return failedRecord(id, "unparseable", url);
      const first = data[0];
      if (!isRecord(first) || typeof first.id !== "string") {
        return failedRecord(id, "not_found", url);
      }
      const doi = normalizeDoiKey(first.id);
      return cached(`doi:${doi}`, cache, () => resolveDoiUncached(doi, o));
    }
  }
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

const NC_LICENSES: ReadonlySet<NormalizedLicense> = new Set([
  "cc-by-nc",
  "cc-by-nc-sa",
  "cc-by-nc-nd",
]);
const NON_NC_SHARE_ALIKE: ReadonlySet<NormalizedLicense> = new Set(["cc-by-sa", "odbl"]);

function versionAtLeast(target: string | null, source: string | null): boolean {
  if (!source) return true; // a source that names no version binds no version
  if (!target) return false; // the source names one and the target does not: not shown to match
  return compareVersions(target, source) >= 0;
}

/** One source's outcome against the target license. */
export function sourceOutcome(
  record: Pick<SourceRecord, "status" | "license" | "license_version">,
  target: NormalizedLicenseValue,
): LineageOutcome {
  if (record.status === "publication") return "source_is_publication";
  if (record.status !== "resolved" || record.license === null) return "unresolved";
  const t = target.license;
  switch (record.license) {
    case "cc0":
    case "pddl":
      return "compatible";
    case "cc-by":
    case "permissive-attribution":
    case "odc-by":
      return "compatible_attribution";
    case "cc-by-nc":
      return NC_LICENSES.has(t) ? "compatible_nc" : "needs_permission";
    case "cc-by-nc-sa":
      if (!NC_LICENSES.has(t)) return "needs_permission";
      return t === "cc-by-nc-sa" && versionAtLeast(target.version, record.license_version)
        ? "compatible_nc"
        : "share_alike_mismatch";
    case "cc-by-sa":
      return t === "cc-by-sa" && versionAtLeast(target.version, record.license_version)
        ? "compatible_attribution"
        : "share_alike_mismatch";
    case "odbl":
      return t === "odbl" ? "compatible_attribution" : "share_alike_mismatch";
    case "cc-by-nd":
    case "cc-by-nc-nd":
    case "restricted":
    case "other":
    case "none":
      return "needs_permission";
    case "physionet-credentialed":
    case "physionet-restricted":
      return "redistribution_prohibited";
  }
}

/** The sources' combined outcome: the most restrictive, plus the pairs that conflict. */
export function combineOutcomes(
  sources: Array<{ outcome: LineageOutcome; license: NormalizedLicense | null }>,
): LineageOutcome {
  if (sources.length === 0) return "no_upstream_declared";
  let worst: LineageOutcome = "compatible";
  for (const s of sources) if (OUTCOME_RANK[s.outcome] > OUTCOME_RANK[worst]) worst = s.outcome;
  const licenses = new Set(sources.map((s) => s.license));
  const hasNc = [...licenses].some((l) => l !== null && NC_LICENSES.has(l));
  const hasNonNcSa = [...licenses].some((l) => l !== null && NON_NC_SHARE_ALIKE.has(l));
  const conflict = (hasNc && hasNonNcSa) || (licenses.has("odbl") && licenses.has("cc-by-sa"));
  if (conflict && OUTCOME_RANK.needs_permission > OUTCOME_RANK[worst]) return "needs_permission";
  return worst;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface LineageSource extends SourceRecord {
  origin: SourceOrigin;
  outcome: LineageOutcome;
}

export interface LineageResult {
  outcome: LineageOutcome;
  /** How each input file read. */
  inputs: InputReadStates;
  /** The declared target license, normalized; null when the description could not be read. */
  target_license: NormalizedLicense | null;
  /** The License value as the dataset declares it. */
  target_license_raw: string | null;
  sources: LineageSource[];
  resolver_version: string;
  fetched_at: string;
}

/** Resolve a dataset's license lineage from what it declares. Never rejects. */
export async function resolveLicenseLineage(
  inputs: LineageInputs,
  options: ResolveOptions = {},
): Promise<LineageResult> {
  const o = {
    bases: options.bases ?? DEFAULT_BASES,
    timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
  };
  const now = options.now ?? (() => new Date());
  const { states, sources: parsed } = readLineageInputs(inputs);
  const unreadable: LineageSource[] = [];
  if (states.dataset_description !== "read") {
    // Never `no_upstream_declared` from a broken or absent description: nothing was read.
    unreadable.push({
      ...failedRecord("dataset_description.json", "description_unreadable", null),
      origin: "source_datasets",
      outcome: "unresolved",
    });
  }
  if (states.nemar_metadata === "unparseable") {
    unreadable.push({
      ...failedRecord(".nemar/metadata.json", "metadata_unreadable", null),
      origin: "related_identifiers",
      outcome: "unresolved",
    });
  }
  if (states.dataset_description !== "read") {
    return {
      outcome: "unresolved",
      inputs: states,
      target_license: null,
      target_license_raw: null,
      sources: unreadable,
      resolver_version: RESOLVER_VERSION,
      fetched_at: now().toISOString(),
    };
  }
  const targetRaw = declaredLicense(parsed.datasetDescription);
  const target = normalizeLicense(targetRaw);
  const refs = extractSourceRefs(parsed);
  const records = await Promise.all(
    refs.map(async (ref, i): Promise<SourceRecord> => {
      if (i >= MAX_SOURCES) {
        return failedRecord(ref.kind === "doi" ? ref.doi : refKey(ref), "not_checked", null);
      }
      try {
        return await resolveRef(ref, o, options.cache);
      } catch {
        return failedRecord(ref.kind === "doi" ? ref.doi : refKey(ref), "fetch_failed", null);
      }
    }),
  );
  const sources: LineageSource[] = [
    ...records.map((rec, i) => ({
      ...rec,
      origin: refs[i].origin,
      outcome: sourceOutcome(rec, target),
    })),
    ...unreadable,
  ];
  return {
    outcome: combineOutcomes(sources),
    inputs: states,
    target_license: target.license,
    target_license_raw: targetRaw,
    sources,
    resolver_version: RESOLVER_VERSION,
    fetched_at: now().toISOString(),
  };
}

/** `nemar dataset license-check` exit code: 0 for a compatible outcome, 2 for every other. */
export function lineageExitCode(outcome: LineageOutcome): 0 | 2 {
  return COMPATIBLE_OUTCOMES.has(outcome) ? 0 : 2;
}

/**
 * The lines the CLI and the admin command print, the same way, from the copy tables. Values shown
 * are identifiers and license names from public registry records, never deposit content.
 */
export function lineageLines(result: LineageResult): string[] {
  const copy = LINEAGE_COPY[result.outcome];
  const lines = [
    `License lineage: ${result.outcome}`,
    `  ${copy.statement}`,
    `Target license: ${result.target_license ?? "unknown"}${result.target_license_raw ? ` (declared "${result.target_license_raw}")` : ""}`,
    `Sources (${result.sources.length}):`,
  ];
  for (const s of result.sources) {
    const lic = s.license
      ? `${s.license}${s.license_version ? ` ${s.license_version}` : ""}`
      : "unknown";
    lines.push(
      `  - ${s.id} [${s.origin}]: ${s.outcome}; license ${lic}; type ${s.resource_type ?? "unknown"}; via ${s.resolver ?? "none"}`,
    );
    lines.push(`      ${SOURCE_STATUS_COPY[s.status].statement}`);
    lines.push(
      `      read: ${s.resolver ? RESOLVER_READ[s.resolver] : SOURCE_STATUS_COPY[s.status].read}`,
    );
    if (s.evidence_url) lines.push(`      evidence: ${s.evidence_url}`);
    if (s.status !== "resolved") lines.push(`      remedy: ${SOURCE_STATUS_COPY[s.status].remedy}`);
  }
  lines.push(`Read: ${copy.read}`);
  lines.push(`Remedy: ${copy.remedy}`);
  lines.push(`Docs: ${copy.anchor}`);
  lines.push(`Resolver: ${result.resolver_version}, fetched ${result.fetched_at}`);
  return lines;
}
