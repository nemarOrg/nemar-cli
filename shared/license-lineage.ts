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
 *    answer (timeout, 5xx, 429, an unparseable body) is asked again ({@link LINEAGE_RETRY}, within
 *    {@link LINEAGE_FETCH_BUDGET} and {@link LINEAGE_RETRY_WINDOW_MS}), and one that still does not
 *    answer leaves the source `unresolved`, because a verdict is never stamped from an
 *    infrastructure error (ADR 0142 decision 3: 9 of 13 review-time `unresolved` outcomes were
 *    transient). A DataCite Dataset record with no usable rights whose DOI or landing page is
 *    OpenNeuro or PhysioNet is completed from that repository's own API: the registries hold no
 *    license for either (measured 2026-11-25). An Open Science Framework (OSF) DOI
 *    (`10.17605/osf.io/<guid>`, which an `https://osf.io/<guid>` URL maps to) that DataCite does
 *    not hold, or holds with no rights, is completed from the license OSF's API declares for the
 *    node (measured 2026-11-27: OSF projects often have no DataCite DOI at all).
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
 * record gains a field (version 2: each source's title, creators and publisher, epic #2182 card B4;
 * version 3: the declared license, osf.io sources, cut README DOIs dropped, retried fetches, and
 * `resolved_at`, ADR 0142 decision 3; version 4: README DOIs that prefix another declared DOI
 * dropped, and DANDI's license spellings read, ADR 0142 decision 3, amendment of 2026-11-27;
 * version 5: README DOIs cut by an ellipsis dropped, and data containers (collections, OSF
 * projects, Crossref components) read as data, ADR 0139 decision 7, amendment of 2026-11-27;
 * version 6: figshare article URLs read through figshare's API, and stale enrichment relations
 * that are publications skipped, the same ADR, amendment of 2026-11-27 (third));
 * the cache key carries it, so a record of an older version is never served.
 */
export const RESOLVER_VERSION = "license-lineage/6";

/** The User-Agent of every registry request. It carries no contact details on purpose. */
export const LICENSE_CHECK_USER_AGENT = "nemar-license-check/1";

/** Each fetch's own limit. */
export const FETCH_TIMEOUT_MS = 8_000;

/** At most this many sources of one dataset are read. */
export const MAX_SOURCES = 10;

/**
 * How long a registry answer is cached, per DOI. Only an answer is cached ({@link isValidCachedRecord}):
 * a failure, and `not_found` (which makes the source `unresolved`), are never stored, so an
 * `unresolved` source is never served from the cache (ADR 0142 decision 3).
 */
export const CACHE_TTL_SECONDS = 24 * 60 * 60;

/** How a failed fetch (network, timeout, 429, 5xx, an unparseable body) is asked again. */
export interface RetryPolicy {
  /** Attempts in all, the first included; 1 asks once. */
  attempts: number;
  /** The wait before each retry, in order; the last repeats when there are more retries. */
  backoffMs: readonly number[];
}

/** One attempt, no retry (tests of a single failure). */
export const NO_RETRY: RetryPolicy = { attempts: 1, backoffMs: [] };

/** The resolver's default: two retries, after 250 ms and 1 s (a `Retry-After` of up to 2 s wins). */
export const LINEAGE_RETRY: RetryPolicy = { attempts: 3, backoffMs: [250, 1_000] };

/** The longest `Retry-After` honored; a longer one waits this long. */
export const MAX_RETRY_AFTER_MS = 2_000;

/**
 * The most requests one lineage makes, retries included. The first attempts of {@link MAX_SOURCES}
 * sources need at most 30 (three registries or repository calls each); the rest is for retries, and
 * a request past it is a failed fetch, never a verdict. Far below the Worker's subrequest limit, so
 * the review inputs route's GitHub reads still fit beside it.
 */
export const LINEAGE_FETCH_BUDGET = 60;

/**
 * No retry starts once it could end later than this after the lineage began: the review job waits
 * 60 s for its inputs (scripts/ci/publication-review.ts), and the first attempts must still fit.
 */
export const LINEAGE_RETRY_WINDOW_MS = 30_000;

/** The shortest DOI suffix taken from free text; a shorter one is a fragment (`10.17605/o`). */
export const MIN_DOI_SUFFIX_LENGTH = 5;

/** The most declared-license entries a source keeps, and the longest text or URL of one. */
export const MAX_DECLARED_LICENSES = 5;
export const MAX_DECLARED_LICENSE_LENGTH = 300;

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

export const RESOLVERS = [
  "datacite",
  "crossref",
  "openalex",
  "openneuro",
  "physionet",
  "osf",
  "figshare",
] as const;
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
  osf: "OSF: the node's license (name and URL) and title, and each child component's license, read through its API when DataCite holds no DOI or no rights for it, or registers it as a project.",
  figshare:
    "figshare: for a figshare collection, each member article's license, read through its API (the collection's own license is not the data's); for a figshare article URL, the article's type and license.",
};

const READ_SOURCES = `The upstream sources declared in dataset_description.json (SourceDatasets), .nemar/metadata.json (IsDerivedFrom and IsIdenticalTo), the deposit attestation and the README (data-repository DOIs and OpenNeuro, Zenodo, PhysioNet or OSF URLs only; a DOI cut short in the text is dropped). Then, per source: ${Object.values(
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
    remedy: "Give the source as a DOI, or as an OpenNeuro, Zenodo, PhysioNet or OSF URL.",
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
 * dataset's License as it declares it, `CC-BY-4.0`, when that is a license identifier that reads
 * as the license the outcome was judged against; otherwise the normalized word) and `{dataset}`
 * (the dataset id). `licensePermissionRequest` in `shared/license-permission.ts` fills them from
 * the lineage result's closed words and checked identifiers only, never from free text, and drops
 * ` ({sources})` when no source can be named. `source_is_publication` has its own sentence (ADR
 * 0139 decision 7, amendment of 2026-11-27): a paper named as the source is not a license
 * conflict, and the first remedy is to name the dataset instead.
 */
export const LINEAGE_PERMISSION_REQUEST: Record<ActionRequiredOutcome, string> = {
  needs_permission: `The license of the upstream data ({sources}) does not permit this copy under {target}. Please send evidence from the original authors that they accept this copy being published under {target}, for example an email from them, to ${LICENSE_EVIDENCE_ADDRESS}, quoting {dataset}. An administrator will record it and the review will continue.`,
  share_alike_mismatch: `The license of the upstream data ({sources}) does not permit this copy under {target}. Please send evidence from the original authors that they accept this copy being published under {target}, for example an email from them, to ${LICENSE_EVIDENCE_ADDRESS}, quoting {dataset}. An administrator will record it and the review will continue.`,
  source_is_publication: `The upstream source you named ({sources}) is a publication, not a dataset, so its license is not the data's license. Name the dataset the data came from in dataset_description.json SourceDatasets (its DOI or repository URL), or send evidence that the original authors accept this copy under {target}, to ${LICENSE_EVIDENCE_ADDRESS}, quoting {dataset}.`,
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

/**
 * An access-rights statement, which is not a license: the URI (`info:eu-repo/semantics/openAccess`)
 * or its bare word (`openAccess`, `restrictedAccess`, as PsychArchives records give it; measured
 * 2026-11-27, where `openAccess` beside CC BY made the source `other`).
 */
export function isAccessRightsUri(text: string): boolean {
  return (
    /^info:eu-repo\/semantics\//i.test(text.trim()) ||
    /^(open|restricted|embargoed|closed|metadataOnly)Access$/i.test(text.trim())
  );
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

  // DANDI (dandischema's LicenseType, ADR 0142 decision 3, amendment of 2026-11-27): its values
  // carry an `spdx:` prefix (`spdx:CC-BY-4.0`, `spdx:CC0-1.0`), and the DataCite records DANDI
  // registers give the enum's name as the rightsIdentifier, the version's dot dropped (`cc_by_40`,
  // `cc0_10`; measured on 10.48324/dandi.001535/0.250714.1218).
  const spdx = /^spdx:(\S+)$/i.exec(raw);
  if (spdx) return normalizeLicense(spdx[1]);
  const dandiCc = /^cc_by((?:_(?:nc|nd|sa))*)_(\d)(\d)$/.exec(lower);
  if (dandiCc) {
    const mods = dandiCc[1];
    return {
      license: ccFamily(mods.includes("nc"), mods.includes("nd"), mods.includes("sa")),
      version: `${dandiCc[2]}.${dandiCc[3]}`,
    };
  }
  const dandiCc0 = /^cc0_(\d)(\d)$/.exec(lower);
  if (dandiCc0) return { license: "cc0", version: `${dandiCc0[1]}.${dandiCc0[2]}` };

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
  | {
      kind: "doi";
      doi: string;
      origin: SourceOrigin;
      /**
       * The DOI is NEMAR's mapping of an `https://osf.io/<guid>` URL, not a DOI the dataset
       * declared: unless DataCite confirms it, the source is named by its URL (`sourceLabelOf`).
       */
      osf_url?: true;
    }
  | { kind: "openneuro_latest"; ds: string; origin: SourceOrigin }
  | { kind: "physionet"; slug: string; version: string | null; origin: SourceOrigin }
  | { kind: "figshare_article"; id: string; version: string | null; origin: SourceOrigin }
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
/**
 * An OSF node URL: `osf.io/` and a five-character GUID, then the end, a slash, a query or a
 * fragment (`https://osf.io/rmafj/`, `https://osf.io/j3s7g/files/osfstorage`). OSF's own pages of
 * five letters are not GUIDs ({@link OSF_RESERVED_PATHS}).
 */
const OSF_URL = /^https?:\/\/(?:www\.)?osf\.io\/([a-z0-9]{5})(?=[/?#]|$)/i;
const OSF_DOI = /^10\.17605\/osf\.io\/([a-z0-9]{5})$/;
/** OSF site paths of five characters, which an OSF URL can start with and which are not GUIDs. */
const OSF_RESERVED_PATHS: ReadonlySet<string> = new Set([
  "about",
  "files",
  "login",
  "users",
  "legal",
  "store",
  "terms",
  "nodes",
]);
const KNOWN_URLS_IN_TEXT =
  /https?:\/\/(?:www\.)?(?:openneuro\.org\/datasets\/ds\d{6}(?:\/versions\/[0-9][\w.-]*)?|zenodo\.org\/(?:records?|deposit)\/\d+|physionet\.org\/(?:content|files)\/[a-z0-9][a-z0-9-]*(?:\/\d[\w.]*)?|osf\.io\/[a-z0-9]{5}(?![a-z0-9]))/gi;

/**
 * A figshare article URL on any figshare host (`https://plos.figshare.com/articles/dataset/<slug>/
 * 7708514`, `https://figshare.com/articles/7708514/2`): its article id and version, or null. The
 * id is the last all-digit path segment after `articles/`, unless the last two are digits, which
 * are then the id and the version.
 */
export function figshareArticleOfUrl(url: string): { id: string; version: string | null } | null {
  const m = /^https?:\/\/(?:[a-z0-9-]+\.)*figshare\.com\/articles\/([^?#]+)/i.exec(url.trim());
  if (!m) return null;
  const segs = m[1].split("/").filter((x) => x !== "");
  const digits = (x: string | undefined) => x !== undefined && /^\d{1,12}$/.test(x);
  const n = segs.length;
  if (n >= 2 && digits(segs[n - 1]) && digits(segs[n - 2])) {
    return { id: segs[n - 2], version: segs[n - 1] };
  }
  return digits(segs[n - 1]) ? { id: segs[n - 1], version: null } : null;
}

/** The DataCite DOI of an OSF node URL (`https://osf.io/rmafj` -> `10.17605/osf.io/rmafj`), or null. */
export function osfDoiOfUrl(url: string): string | null {
  const m = OSF_URL.exec(url.trim());
  if (!m) return null;
  const guid = m[1].toLowerCase();
  return OSF_RESERVED_PATHS.has(guid) ? null : `10.17605/osf.io/${guid}`;
}

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
  const osf = osfDoiOfUrl(t);
  if (osf) return { kind: "doi", doi: osf, origin, osf_url: true };
  const zenDoi = /zenodo\.org\/doi\/(10\.\d{4,9}\/\S+)/i.exec(t);
  if (zenDoi) return doiRef(zenDoi[1], origin);
  const fs = figshareArticleOfUrl(t);
  if (fs) {
    // A version in the URL wins; else the SourceDatasets entry's Version when it is a figshare
    // version number; else the latest.
    const hint = versionHint?.trim().replace(/^v/i, "") ?? "";
    const version = fs.version ?? (/^\d{1,6}$/.test(hint) ? hint : null);
    return { kind: "figshare_article", id: fs.id, version, origin };
  }
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

/**
 * Markdown emphasis and code marks, and the punctuation after them, that a DOI match can carry at
 * its end (`` `10.5281/zenodo.1`, ``, `**10.5281/zenodo.1**.`).
 */
const TRAILING_MARKUP = /[`*_~.,;:]+$/;

/**
 * The suffix shape of each data-repository DOI prefix, the only DOIs a README is read for. A README
 * candidate of one of these prefixes whose suffix does not have the shape was cut out of the text
 * (`10.17605/o` from a wrapped `10.17605/OSF.IO/...`; `10.5281/zenodo.` before a line break).
 */
export const DATA_REPOSITORY_DOI_SHAPES: Record<
  (typeof DATA_REPOSITORY_DOI_PREFIXES)[number],
  RegExp
> = {
  "10.18112": /^openneuro\.ds\d{6}(?:\.v[0-9][\w.-]*)?$/,
  "10.5281": /^zenodo\.\d+$/,
  "10.13026": /^[a-z0-9][a-z0-9-]{4,}$/,
  // An item or a collection (`m9.figshare.c.3307977`), with or without a version.
  "10.6084": /^m9\.figshare\.(?:c\.)?\d+(?:\.v\d+)?$/,
  "10.17605": /^osf\.io\/[a-z0-9]{5}$/,
  // A dataset, or one of its files (`dryad.8pm4nv0/1`).
  "10.5061": /^dryad\.[a-z0-9]+(?:\/\d+)?$/,
  // Harvard Dataverse's older five-character identifiers (`DVN/29379`) as well as the newer six.
  "10.7910": /^dvn\/[a-z0-9]{5,}(?:\/[a-z0-9]+)?$/,
};

/**
 * Whether a DOI candidate in free text was cut short, so it is not a source (ADR 0142 decision 3):
 * its suffix (markup and trailing punctuation already removed) is shorter than
 * {@link MIN_DOI_SUFFIX_LENGTH}, as `10.17605/o` in a production README was, or, for a README
 * candidate (`shaped`), a data-repository DOI whose suffix lacks its repository's shape
 * ({@link DATA_REPOSITORY_DOI_SHAPES}).
 */
export function isCutDoiCandidate(doi: string, shaped: boolean): boolean {
  const slash = doi.indexOf("/");
  const suffix = doi.slice(slash + 1);
  if (suffix.length < MIN_DOI_SUFFIX_LENGTH) return true;
  if (!shaped) return false;
  const shape = (DATA_REPOSITORY_DOI_SHAPES as Record<string, RegExp>)[doi.slice(0, slash)];
  return shape !== undefined && !shape.test(suffix);
}

/** What one text declares: its sources, and how many DOI candidates were dropped as cut short. */
export interface TextSources {
  refs: SourceRef[];
  dropped: number;
}

/**
 * DOIs and known repository URLs in free text, and the count of DOI candidates dropped as cut short
 * ({@link isCutDoiCandidate}); a dropped candidate is never a source, so it never makes the lineage
 * `unresolved`. `anyDoi` false keeps only data-repository DOIs.
 */
export function sourcesFromText(text: string, origin: SourceOrigin, anyDoi: boolean): TextSources {
  const refs: SourceRef[] = [];
  let dropped = 0;
  for (const m of text.match(DOI_IN_TEXT) ?? []) {
    const doi = normalizeDoiKey(m.replace(TRAILING_MARKUP, ""));
    if (!anyDoi && !DATA_REPOSITORY_DOI_PREFIXES.some((p) => doi.startsWith(`${p}/`))) continue;
    if (isCutDoiCandidate(doi, origin === "readme")) {
      dropped++;
      continue;
    }
    refs.push(doiRef(doi, origin));
  }
  for (const m of text.match(KNOWN_URLS_IN_TEXT) ?? []) {
    const ref = refFromIdentifier(m, origin);
    // An OSF site page (`osf.io/about`) is not a node, and maps to no source.
    if (ref && ref.kind !== "url") refs.push(ref);
  }
  return { refs, dropped };
}

/** DOIs and known repository URLs in free text. `anyDoi` false keeps only data-repository DOIs. */
export function refsFromText(text: string, origin: SourceOrigin, anyDoi: boolean): SourceRef[] {
  return sourcesFromText(text, origin, anyDoi).refs;
}

export function refKey(ref: SourceRef): string {
  switch (ref.kind) {
    case "doi":
      return `doi:${ref.doi}`;
    case "openneuro_latest":
      return `openneuro:${ref.ds}`;
    case "physionet":
      return `physionet:${ref.slug}:${ref.version ?? ""}`;
    case "figshare_article":
      return `figshare:${ref.id}:${ref.version ?? ""}`;
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

/** Markup a wrapped line can carry between the two halves of a DOI: quotes, `>`, emphasis, code. */
const WRAP_GAP = String.raw`[>"'*_\`~]*\s[\s>"'*_\`~]*`;

const escapeRegExp = (t: string) => t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** An ellipsis that marks text cut by an editor or a tool: `[...]`, `[…]`, `...` or `…`. */
const ELLIPSIS = String.raw`\s*(?:\[(?:\.\.\.|…)\]|\.\.\.|…)`;

/** What follows a DOI inside a longer token: a letter, digit or `-_/`, or a dot before one. */
const DOI_CONTINUES = /^(?:[a-z0-9\-_/]|\.[a-z0-9])/i;

/**
 * Whether every place the README writes `short` as a DOI of its own is `longer` cut short: each
 * occurrence (case ignored) is either continued into the rest of `longer` across whitespace (a
 * line break, with any quote or emphasis markup around it: `10.5281/zenodo.2231\n4785`), or
 * followed by an ellipsis (`10.5281/zenodo.2231 [...]`). An occurrence inside a longer DOI is not
 * one of its own. One standalone occurrence (`see 10.5281/zenodo.2231.`), and `short` is a source.
 */
function readmeOnlyCuts(readme: string, short: string, longer: string): boolean {
  const rest = longer.slice(short.length);
  const wrapped = new RegExp(`^${WRAP_GAP}${escapeRegExp(rest)}`, "i");
  const ellipsis = new RegExp(`^${ELLIPSIS}`, "i");
  const lower = readme.toLowerCase();
  let cuts = 0;
  for (let at = lower.indexOf(short); at !== -1; at = lower.indexOf(short, at + 1)) {
    const after = readme.slice(at + short.length);
    if (DOI_CONTINUES.test(after)) continue;
    if (wrapped.test(after) || ellipsis.test(after)) {
      cuts++;
      continue;
    }
    return false;
  }
  return cuts > 0;
}

/**
 * README DOIs that are another declared DOI cut short (ADR 0142 decision 3, amendment of
 * 2026-11-27): a README DOI that is a strict prefix of a DOI declared in SourceDatasets, the
 * related identifiers or the attestation, or of another README DOI, AND that the README writes
 * only as that DOI cut short ({@link readmeOnlyCuts}: every occurrence continued across a line
 * break, `10.5281/zenodo.2231\n4785` beside a declared `10.5281/zenodo.22314785`, or followed by an
 * ellipsis, `10.5281/zenodo.2231 [...]`; amendments of 2026-11-27, resolver version 5), is that
 * DOI wrapped or cut in the text, so it is removed.
 * Such a cut copy still passes its repository's shape, so {@link isCutDoiCandidate} cannot see it.
 * A prefix the text does not continue is a distinct record (`zenodo.1234567` beside
 * `zenodo.12345678`) and stays. An equal DOI is not removed here: de-duplication keeps one.
 */
function dropReadmePrefixes(refs: SourceRef[], readme: string | null): SourceRef[] {
  if (!readme) return refs;
  const dois = refs.flatMap((r) => (r.kind === "doi" ? [r.doi] : []));
  return refs.filter(
    (r) =>
      !(
        r.kind === "doi" &&
        r.origin === "readme" &&
        dois.some(
          (d) => d.length > r.doi.length && d.startsWith(r.doi) && readmeOnlyCuts(readme, r.doi, d),
        )
      ),
  );
}

/** Every declared source, in the decided order, de-duplicated. */
export function extractSourceRefs(inputs: SourceInputs): SourceRef[] {
  return extractSources(inputs).refs;
}

/**
 * Every declared source, in the decided order, de-duplicated, and the count of DOI candidates in
 * the attestation and the README dropped as cut short.
 */
export function extractSources(inputs: SourceInputs): TextSources {
  const refs: SourceRef[] = [];
  let dropped = 0;
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
    const found = sourcesFromText(inputs.attestationUpstreamSource, "attestation", true);
    refs.push(...found.refs);
    dropped += found.dropped;
  }
  if (inputs.readme) {
    // A README names its own dataset: never NEMAR's own DOIs, which no upstream source carries.
    const found = sourcesFromText(inputs.readme, "readme", false);
    refs.push(
      ...found.refs.filter((r) => !(r.kind === "doi" && r.doi.startsWith(`${NEMAR_DOI_PREFIX}/`))),
    );
    dropped += found.dropped;
  }

  const prefixed = dropReadmePrefixes(refs, inputs.readme);
  dropped += refs.length - prefixed.length;

  // A dataset is not its own upstream source, whichever input names it.
  const own =
    isRecord(desc) && typeof desc.DatasetDOI === "string" && desc.DatasetDOI.trim()
      ? normalizeDoiKey(desc.DatasetDOI)
      : null;
  const seen = new Set<string>();
  const unique = prefixed.filter((r) => {
    if (own !== null && r.kind === "doi" && r.doi === own) return false;
    const k = refKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { refs: unique, dropped };
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
  /** The OSF API origin; a node is at `/v2/nodes/<guid>/`. */
  osf: string;
  /** The figshare API origin; a collection's members are at `/v2/collections/<id>/articles`. */
  figshare: string;
  /** The Zenodo API origin; a record is at `/records/<id>` (a concept id answers its latest). */
  zenodo: string;
}

export const DEFAULT_BASES: RegistryBases = {
  datacite: "https://api.datacite.org",
  crossref: "https://api.crossref.org",
  openalex: "https://api.openalex.org",
  openneuro: "https://openneuro.org",
  physionet: "https://physionet.org",
  osf: "https://api.osf.io",
  figshare: "https://api.figshare.com",
  zenodo: "https://zenodo.org/api",
};

/**
 * One license entry exactly as the source's record declares it, shown beside the normalized word
 * (ADR 0142 decision 3: `needs_permission` shows the license the source declares): DataCite's
 * `rights` and `rightsUri`, Crossref's license URL, OpenAlex's license id, OpenNeuro's `License`,
 * PhysioNet's license name, OSF's license name and URL. Registry text, never deposit content;
 * control characters are removed and each value is at most {@link MAX_DECLARED_LICENSE_LENGTH}.
 */
export interface DeclaredLicense {
  text: string | null;
  url: string | null;
}

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
  /**
   * Each license the record declares, as it declares it; empty when it declares none (or when
   * no record was read: see `status`).
   */
  declared_licenses: DeclaredLicense[];
  evidence_url: string | null;
  status: SourceStatus;
  /**
   * A data container's parts (a figshare collection's members, an OSF node and its child
   * components), each license as read. Each part is judged against the target on its own and the
   * parts combine as separate sources do ({@link sourceOutcome}), because one license cannot stand
   * for two whose duties differ (CC BY-SA beside CC BY-NC). `license` is then the most restrictive
   * part, for display only. Absent for every other record.
   */
  parts?: NormalizedLicenseValue[];
  /**
   * A Zenodo concept record (`isZenodoConcept`): the DOI that names every version, whose
   * metadata follows the latest one. Absent for every other record.
   */
  concept?: true;
  /**
   * The DOI is NEMAR's construction, not a registered one: an OSF node URL maps to
   * `10.17605/osf.io/<guid>`, and DataCite did not hold it, so the record was read from OSF's API
   * and the DOI must never be shown as the source's (`sourceLabelOf` shows the node's URL).
   * Absent for every other record.
   */
  doi_registered?: false;
  /**
   * What a Zenodo record that its registry types as a paper holds (`zenodoFilesOf`): Zenodo's type
   * for it and its files, so the decision card can say that a "journal article" holds data files.
   * It never changes the record's status or outcome (ADR 0139 decision 7, amendment of
   * 2026-11-27): an administrator decides. Absent for every other record, and when Zenodo's record
   * could not be read.
   */
  registry_files?: RegistryFiles;
}

/** A paper-typed record's files, as its repository lists them (registry text, never deposit content). */
export interface RegistryFiles {
  /** The repository's type for the record, as it gives it (`Journal article`). */
  type: string;
  /** How many files the record holds. */
  files: number;
  /** How many of them hold data ({@link DATA_FILE_EXTENSIONS}): recordings, tables, archives. */
  data_files: number;
  /** The first data files' names, at most {@link MAX_REGISTRY_FILE_NAMES}. */
  examples: string[];
}

/**
 * File extensions that hold data: recordings, tables, arrays and archives of them. A paper's record
 * that holds a file of one of these "holds data files"; its PDF, figures, documents and anything
 * not listed are not counted, so the card never calls a paper's own files data.
 */
export const DATA_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  // archives
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  // tables and arrays
  "csv",
  "tsv",
  "xls",
  "xlsx",
  "parquet",
  "feather",
  "npy",
  "npz",
  "pkl",
  "pickle",
  "h5",
  "hdf5",
  "hdf",
  "mat",
  "sav",
  "rds",
  "rdata",
  "json",
  "nwb",
  "zarr",
  "dat",
  "bin",
  "raw",
  // electrophysiology, imaging and other recordings
  "edf",
  "bdf",
  "gdf",
  "set",
  "fdt",
  "vhdr",
  "vmrk",
  "eeg",
  "fif",
  "cnt",
  "mff",
  "xdf",
  "snirf",
  "nirs",
  "nii",
  "dcm",
  "mef",
  "ns5",
  "nev",
  "plx",
  "smr",
  "abf",
  "acq",
]);

/** The most data-file names a record keeps. */
export const MAX_REGISTRY_FILE_NAMES = 3;

const ZENODO_DOI = /^10\.5281\/zenodo\.(\d+)$/;

/**
 * What a Zenodo record holds, from Zenodo's API (`/records/<id>`), or null when it could not be
 * read or is not a record. Read only for a Zenodo DOI whose registry record is a publication.
 */
async function zenodoFilesOf(doi: string, o: FetchContext): Promise<RegistryFiles | null> {
  const m = ZENODO_DOI.exec(doi);
  if (m === null) return null;
  // One attempt, never retried: this read only adds a note to the card, so it must not spend the
  // lineage's budget on retries the license reads need.
  const got = await o.getOnce(`${o.bases.zenodo}/records/${m[1]}`);
  if (got.kind !== "ok" || !isRecord(got.body)) return null;
  const body = got.body;
  const meta = isRecord(body.metadata) ? body.metadata : {};
  const rt = isRecord(meta.resource_type) ? meta.resource_type : {};
  const type = declaredValue(rt.title) ?? declaredValue(rt.type);
  if (type === null || !Array.isArray(body.files)) return null;
  const names = body.files
    .map((f) => (isRecord(f) ? declaredValue(f.key) : null))
    .filter((n): n is string => n !== null);
  const data = names.filter((n) => {
    const dot = n.lastIndexOf(".");
    return dot >= 0 && DATA_FILE_EXTENSIONS.has(n.slice(dot + 1).toLowerCase());
  });
  return {
    type,
    files: body.files.length,
    data_files: data.length,
    examples: data.slice(0, MAX_REGISTRY_FILE_NAMES),
  };
}

/**
 * A source declared as an `https://osf.io/<guid>` URL whose DOI DataCite did not confirm: DataCite
 * answered that it does not hold it, or the lookup failed or could not be read (a failed record has
 * no resolver), so the DOI is only NEMAR's construction and is never shown as the source's.
 */
export function osfRegistrationUnconfirmed(ref: SourceRef, rec: SourceRecord): boolean {
  return (
    ref.kind === "doi" &&
    ref.osf_url === true &&
    (rec.doi_registered === false || rec.resolver === null)
  );
}

/**
 * How a surface names a source: its id, except an OSF node whose DOI DataCite does not hold
 * ({@link SourceRecord.doi_registered}), which is named by its URL, `https://osf.io/<guid>`, so a
 * DOI that does not exist is never presented (nm001019: `10.17605/osf.io/fx4ud`).
 */
export function sourceLabelOf(s: Pick<SourceRecord, "id" | "doi_registered">): string {
  if (s.doi_registered !== false) return s.id;
  const m = OSF_DOI.exec(s.id);
  return m === null ? s.id : `https://osf.io/${m[1]}`;
}

/**
 * The card's line for a publication that holds data files ({@link SourceRecord.registry_files}),
 * or null for any other source. Its words are the repository's type and file names (registry text).
 */
export function paperWithDataFilesLine(
  s: Pick<SourceRecord, "id" | "doi_registered" | "status" | "registry_files">,
): string | null {
  const f = s.registry_files;
  if (s.status !== "publication" || f === undefined || f.data_files === 0) return null;
  const type = f.type.toLowerCase();
  const article = /^[aeiou]/.test(type) ? "an" : "a";
  const examples = f.examples.length > 0 ? `, such as ${f.examples.join(", ")}` : "";
  return `${sourceLabelOf(s)}: the registry types this record as ${article} ${type} but it holds data files (${f.data_files} of ${f.files} files${examples}); it is still read as a publication for the license lineage, and an administrator decides.`;
}

/** The most creators' names a record keeps. */
export const MAX_CREATORS = 10;

/** A record's descriptive fields: title, creators and publisher. */
type Described = Pick<SourceRecord, "title" | "creators" | "publisher">;

const NOT_DESCRIBED: Described = { title: null, creators: [], publisher: null };

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** A registry value made safe to print: control characters removed, length capped; null if empty. */
function declaredValue(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove them.
  const clean = v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  if (clean === "") return null;
  return clean.length > MAX_DECLARED_LICENSE_LENGTH
    ? `${clean.slice(0, MAX_DECLARED_LICENSE_LENGTH - 1)}\u2026`
    : clean;
}

/** A declared-license entry, or null when it carries neither a text nor a URL. */
function declared(textValue: unknown, urlValue: unknown): DeclaredLicense | null {
  const t = declaredValue(textValue);
  const u = declaredValue(urlValue);
  return t === null && u === null ? null : { text: t, url: u };
}

function declaredList(entries: Array<DeclaredLicense | null>): DeclaredLicense[] {
  return entries.filter((e): e is DeclaredLicense => e !== null).slice(0, MAX_DECLARED_LICENSES);
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
  /** How a failed fetch is asked again; {@link LINEAGE_RETRY} when omitted. */
  retry?: RetryPolicy;
  /** The most requests the lineage makes; {@link LINEAGE_FETCH_BUDGET} when omitted. */
  fetchBudget?: number;
  /** How a retry waits; a real timer when omitted. */
  sleep?: (ms: number) => Promise<void>;
}

type Fetched =
  | { kind: "ok"; body: unknown }
  | { kind: "absent" }
  | { kind: "failed"; status: SourceStatus };

/** One attempt's answer: a failure says whether asking again may help, and what the server asked. */
type Attempt =
  | { kind: "ok"; body: unknown }
  | { kind: "absent" }
  | { kind: "failed"; status: SourceStatus; retryable: boolean; retryAfterMs: number | null };

/** A `Retry-After` header in seconds, as milliseconds; null when absent or not a number. */
function retryAfterMs(header: string | null): number | null {
  if (header === null || !/^\d{1,6}$/.test(header.trim())) return null;
  return Number(header.trim()) * 1000;
}

async function fetchOnce(url: string, timeoutMs: number, init?: RequestInit): Promise<Attempt> {
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
    return { kind: "failed", status: "fetch_failed", retryable: true, retryAfterMs: null };
  }
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    return { kind: "absent" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    // A 429 or a 5xx may answer next time; any other refusal (a private OSF node's 401) will not.
    const retryable = response.status === 429 || response.status >= 500;
    return {
      kind: "failed",
      status: "fetch_failed",
      retryable,
      retryAfterMs: retryAfterMs(response.headers.get("Retry-After")),
    };
  }
  try {
    return { kind: "ok", body: await response.json() };
  } catch {
    // A body that stops mid-stream (the timeout) is a failed fetch; one that arrived and is not
    // JSON is unparseable. Both are unresolved, and both are asked again.
    return { kind: "failed", status: "unparseable", retryable: true, retryAfterMs: null };
  }
}

/** The resolver's fetch: one GET or POST of JSON, retried and counted against the lineage's budget. */
type GetJson = (url: string, init?: RequestInit) => Promise<Fetched>;

/** What every resolver step reads: the registry origins and the lineage's one fetch. */
interface FetchContext {
  bases: RegistryBases;
  get: GetJson;
  /** The same fetch with one attempt and no retry, counted against the same budget. */
  getOnce: GetJson;
}

/**
 * The lineage's fetch: each request is an attempt counted against `budget`; a retryable failure is
 * asked again by `retry`, after its backoff (or the server's `Retry-After`, at most
 * {@link MAX_RETRY_AFTER_MS}), while the budget lasts and only when the retry could end within
 * {@link LINEAGE_RETRY_WINDOW_MS} of `startedAt`. A request past the budget is a failed fetch.
 */
function lineageFetch(args: {
  timeoutMs: number;
  retry: RetryPolicy;
  budget: { left: number };
  sleep: (ms: number) => Promise<void>;
  clock: () => number;
  startedAt: number;
}): GetJson {
  const attempts = Math.max(1, Math.floor(args.retry.attempts));
  return async (url, init) => {
    let last: Fetched = { kind: "failed", status: "fetch_failed" };
    let lastRetryAfter: number | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (args.budget.left <= 0) return last;
      if (attempt > 0) {
        const backoff =
          args.retry.backoffMs[Math.min(attempt - 1, args.retry.backoffMs.length - 1)] ?? 0;
        const wait = Math.min(MAX_RETRY_AFTER_MS, Math.max(backoff, lastRetryAfter ?? 0));
        const elapsed = args.clock() - args.startedAt;
        if (elapsed + wait + args.timeoutMs > LINEAGE_RETRY_WINDOW_MS) return last;
        await args.sleep(wait);
        if (args.budget.left <= 0) return last;
      }
      args.budget.left--;
      const got = await fetchOnce(url, args.timeoutMs, init);
      if (got.kind !== "failed") return got;
      last = { kind: "failed", status: got.status };
      lastRetryAfter = got.retryAfterMs;
      if (!got.retryable) return last;
    }
    return last;
  };
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
    declared_licenses: [],
    evidence_url: evidence,
    status,
  };
}

function withLicense(
  base: Omit<SourceRecord, "license" | "license_version" | "raw" | "status" | "declared_licenses">,
  values: NormalizedLicenseValue[],
  raws: string[],
  isDataset: boolean,
  declaredLicenses: DeclaredLicense[],
): SourceRecord {
  const chosen = mostRestrictive(values);
  return {
    ...base,
    license: chosen.license,
    license_version: chosen.version,
    raw: raws.length > 0 ? raws.join(" | ") : null,
    declared_licenses: declaredLicenses,
    status: isDataset ? "resolved" : "publication",
  };
}

/** The licenses one record lists: normalized, the raw text, and each entry as declared. */
export interface RecordLicenses {
  values: NormalizedLicenseValue[];
  raws: string[];
  declared: DeclaredLicense[];
}

/** DataCite's `rightsList`, access-rights statements removed. */
export function dataciteLicenses(rightsList: unknown): RecordLicenses {
  const values: NormalizedLicenseValue[] = [];
  const raws: string[] = [];
  const entries: Array<DeclaredLicense | null> = [];
  if (!Array.isArray(rightsList)) return { values, raws, declared: [] };
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
    entries.push(declared(r.rights ?? r.rightsIdentifier, r.rightsUri));
  }
  return { values, raws, declared: declaredList(entries) };
}

/** Crossref's `license[]`: only `vor` or `unspecified` content versions, no TDM or STM-ASF terms. */
export function crossrefLicenses(license: unknown): RecordLicenses {
  const values: NormalizedLicenseValue[] = [];
  const raws: string[] = [];
  const entries: Array<DeclaredLicense | null> = [];
  if (!Array.isArray(license)) return { values, raws, declared: [] };
  for (const l of license) {
    if (!isRecord(l) || typeof l.URL !== "string") continue;
    const cv = typeof l["content-version"] === "string" ? l["content-version"] : "unspecified";
    if (cv !== "vor" && cv !== "unspecified") continue;
    if (/\/tdm\/|stm-asf|text-and-data-mining/i.test(l.URL)) continue;
    values.push(normalizeLicense(l.URL));
    raws.push(l.URL);
    entries.push(declared(null, l.URL));
  }
  return { values, raws, declared: declaredList(entries) };
}

const CROSSREF_DATA_TYPES = new Set(["dataset", "database"]);

/**
 * DataCite resourceTypeGeneral values that are positively papers: a source of one of these is a
 * publication, never data. `Text` is not listed (OSF registers projects as `Text`), nor
 * `Collection`, `Dataset` or a missing type.
 */
export const DATACITE_PAPER_TYPES: ReadonlySet<string> = new Set([
  "JournalArticle",
  "Preprint",
  "ConferencePaper",
  "ConferenceProceeding",
  "Book",
  "BookChapter",
  "Dissertation",
  "Report",
  "PeerReview",
  "DataPaper",
]);

/**
 * Crossref `type` values that are positively papers. A `component` (supplementary material), a
 * `dataset` or `database`, and any type not listed are not.
 */
export const CROSSREF_PAPER_TYPES: ReadonlySet<string> = new Set([
  "journal-article",
  "proceedings-article",
  "book-chapter",
  "book",
  "edited-book",
  "monograph",
  "reference-entry",
  "posted-content",
  "report",
  "dissertation",
  "peer-review",
]);

/**
 * Whether a registry record is positively a paper (ADR 0139 decision 7, amendment of 2026-11-27):
 * its DataCite resourceTypeGeneral is in {@link DATACITE_PAPER_TYPES}, or, with no DataCite type
 * (a Crossref record), its type is in {@link CROSSREF_PAPER_TYPES}. A missing or unrecognized type
 * is not shown to be a paper. Enrichment drops a stale IsDerivedFrom only on this answer.
 */
export function isPaperRecord(resourceTypeGeneral: string | null, type: string | null): boolean {
  if (resourceTypeGeneral !== null) return DATACITE_PAPER_TYPES.has(resourceTypeGeneral);
  return type !== null && CROSSREF_PAPER_TYPES.has(type);
}

/**
 * An OSF project (ADR 0139 decision 7, amendment of 2026-11-27): an OSF DOI whose DataCite
 * resourceType is `Project`, which OSF registers as `Text` (`10.17605/osf.io/f8sq3`) or `Dataset`.
 * It holds data, and its license is read from OSF's API for the node and each child component
 * ({@link resolveOsf}), never from DataCite's rights alone.
 */
export function isOsfProject(doi: string, resourceType: unknown): boolean {
  return resourceType === "Project" && OSF_DOI.test(doi);
}

/** A figshare collection DOI (`10.6084/m9.figshare.c.6979581.v1`) and its collection id. */
const FIGSHARE_COLLECTION_DOI = /^10\.6084\/m9\.figshare\.c\.(\d+)(?:\.v\d+)?$/;

/** The most members of a figshare collection read; a larger collection is not judged. */
export const MAX_COLLECTION_MEMBERS = 10;

/** A record that was read but whose license is not known: the source is `unresolved`, never cached. */
function unknownLicense(
  base: Omit<SourceRecord, "license" | "license_version" | "raw" | "status" | "declared_licenses">,
): SourceRecord {
  return {
    ...base,
    license: null,
    license_version: null,
    raw: null,
    declared_licenses: [],
    status: "resolved",
  };
}

/**
 * A DataCite `Collection` (ADR 0139 decision 7, amendment of 2026-11-27): a collection's own rights
 * are not its members' (`10.6084/m9.figshare.c.6979581.v1` declares CC BY 4.0 on DataCite while
 * its one member is CC0), so they are never used. A figshare collection is judged by its members'
 * licenses, read from figshare's API, the most restrictive winning; a collection with no member,
 * more than {@link MAX_COLLECTION_MEMBERS}, or a member whose license cannot be read is
 * `unresolved`. Any other collection is `unresolved`: an administrator decides.
 */
async function resolveCollection(
  doi: string,
  described: Described,
  dcUrl: string,
  o: FetchContext,
): Promise<SourceRecord> {
  const fs = FIGSHARE_COLLECTION_DOI.exec(doi);
  if (!fs) {
    return unknownLicense({
      id: doi,
      resolver: "datacite",
      resource_type: "Collection",
      ...described,
      evidence_url: dcUrl,
    });
  }
  const listUrl = `${o.bases.figshare}/v2/collections/${fs[1]}/articles?page_size=${MAX_COLLECTION_MEMBERS + 1}`;
  const base = {
    id: doi,
    resolver: "figshare" as const,
    resource_type: "Collection",
    ...described,
    evidence_url: listUrl,
  };
  const list = await o.get(listUrl);
  if (list.kind === "failed") return failedRecord(doi, list.status, listUrl);
  if (list.kind === "absent") return failedRecord(doi, "not_found", listUrl);
  if (!Array.isArray(list.body)) return failedRecord(doi, "unparseable", listUrl);
  const ids = list.body.map((m) => (isRecord(m) && Number.isInteger(m.id) ? Number(m.id) : null));
  if (ids.length === 0 || ids.length > MAX_COLLECTION_MEMBERS) return unknownLicense(base);
  if (ids.some((id) => id === null)) return failedRecord(doi, "unparseable", listUrl);
  const values: NormalizedLicenseValue[] = [];
  const raws: string[] = [];
  const entries: Array<DeclaredLicense | null> = [];
  for (const id of ids as number[]) {
    const url = `${o.bases.figshare}/v2/articles/${id}`;
    const got = await o.get(url);
    if (got.kind === "failed") return failedRecord(doi, got.status, url);
    if (got.kind === "absent") return failedRecord(doi, "not_found", url);
    const lic = isRecord(got.body) ? got.body.license : null;
    if (!isRecord(lic)) return unknownLicense(base);
    const texts = [lic.url, lic.name].filter(
      (t): t is string => typeof t === "string" && t.trim() !== "",
    );
    if (texts.length === 0) return unknownLicense(base);
    let value = normalizeLicense(texts[0]);
    for (const t of texts.slice(1)) {
      if (value.license !== "other") break;
      value = normalizeLicense(t);
    }
    values.push(value);
    raws.push(texts[0]);
    entries.push(declared(lic.name, lic.url));
  }
  return { ...withLicense(base, values, raws, true, declaredList(entries)), parts: values };
}

/** The DOI prefix of PLOS, whose policy puts supplementary files under the article's CC BY. */
export const PLOS_DOI_PREFIX = "10.1371/";

/** A PLOS supplementary file's DOI stem (`10.1371/journal.pone.0303144.s001` -> `...0303144`). */
const COMPONENT_SUFFIX = /^(.+)\.s\d{1,4}$/;

/**
 * The article a PLOS `component` belongs to: its `is-component-of` DOI, else its DOI stem; null for
 * any other publisher's component, which inherits nothing.
 */
export function componentParentDoi(doi: string, msg: Record<string, unknown>): string | null {
  if (!doi.startsWith(PLOS_DOI_PREFIX)) return null;
  const rel = isRecord(msg.relation) ? msg.relation["is-component-of"] : null;
  if (Array.isArray(rel)) {
    for (const r of rel) {
      if (isRecord(r) && r["id-type"] === "doi" && typeof r.id === "string" && r.id.trim()) {
        const id = normalizeDoiKey(r.id);
        return id.startsWith(PLOS_DOI_PREFIX) ? id : null;
      }
    }
  }
  return COMPONENT_SUFFIX.exec(doi)?.[1] ?? null;
}

/**
 * A Crossref `component` (supplementary material) holds data (ADR 0139 decision 7, amendment of
 * 2026-11-27). Only a PLOS component (`10.1371/journal.pone.0303144.s001`) is judged: it takes the
 * license Crossref gives it, else its article's version-of-record license, because PLOS's policy
 * puts supplementary files under the article's CC BY. With neither, and for every other
 * publisher's component, its license is unknown (null), so the source is `unresolved`, never
 * compatible by default; an article that cannot be read leaves it failed.
 */
async function resolveComponent(
  doi: string,
  msg: Record<string, unknown>,
  crUrl: string,
  o: FetchContext,
): Promise<SourceRecord> {
  const base = {
    id: doi,
    resolver: "crossref" as const,
    resource_type: "component",
    ...crossrefDescribed(msg),
  };
  const unknown = unknownLicense({ ...base, evidence_url: crUrl });
  if (!doi.startsWith(PLOS_DOI_PREFIX)) return unknown;
  const own = crossrefLicenses(msg.license);
  if (own.values.length > 0) {
    return withLicense({ ...base, evidence_url: crUrl }, own.values, own.raws, true, own.declared);
  }
  const parent = componentParentDoi(doi, msg);
  if (parent === null || parent === doi) return unknown;
  const pUrl = `${o.bases.crossref}/works/${encodeURIComponent(parent)}`;
  const p = await o.get(pUrl);
  if (p.kind === "failed") return failedRecord(doi, p.status, pUrl);
  if (p.kind === "absent") return unknown;
  const pm = isRecord(p.body) ? p.body.message : null;
  if (!isRecord(pm)) return failedRecord(doi, "unparseable", pUrl);
  const inherited = crossrefLicenses(pm.license);
  if (inherited.values.length === 0) return { ...unknown, evidence_url: pUrl };
  return withLicense(
    { ...base, evidence_url: pUrl },
    inherited.values,
    inherited.raws,
    true,
    inherited.declared,
  );
}

/**
 * figshare `defined_type_name`s that hold data (ADR 0139 decision 7, amendment of 2026-11-27):
 * `dataset` only. figshare calls its data items datasets; `figure` and `media` can be recordings
 * or illustrations, and `software`, `model` and `workflow` are code, so they are not known to be
 * data and are `unresolved` (an administrator decides).
 */
export const FIGSHARE_DATA_TYPES: ReadonlySet<string> = new Set(["dataset"]);

/**
 * figshare types that are publications: an article's license is not the data's. Any type in
 * neither set is `unresolved`.
 */
export const FIGSHARE_PAPER_TYPES: ReadonlySet<string> = new Set([
  "journal contribution",
  "preprint",
  "thesis",
  "book",
  "chapter",
  "conference contribution",
  "poster",
  "presentation",
  "report",
  "monograph",
  "peer review",
  "educational resource",
]);

/**
 * A figshare article URL, read from figshare's API (`/v2/articles/<id>`, or its version): the
 * figshare record decides what it is (ADR 0139 decision 7, amendment of 2026-11-27). A `dataset`
 * with a license is a dataset under that license; a paper-like type is a publication; any other
 * type, a dataset with no license, and a metadata-only record (`is_metadata_record`: the data is
 * held elsewhere or on request) are `unresolved`. The record's DOI names the source (a PLOS
 * figshare dataset shares its article's DOI, `10.1371/journal.pone.0211710`), and that DOI is
 * never then read from Crossref, which would call it the journal article.
 */
async function resolveFigshareArticle(
  id: string,
  version: string | null,
  o: FetchContext,
): Promise<SourceRecord> {
  const url = `${o.bases.figshare}/v2/articles/${id}${version ? `/versions/${version}` : ""}`;
  const fallbackId = `figshare:${id}${version ? `:${version}` : ""}`;
  const got = await o.get(url);
  if (got.kind === "failed") return failedRecord(fallbackId, got.status, url);
  if (got.kind === "absent") return failedRecord(fallbackId, "not_found", url);
  const a = got.body;
  if (!isRecord(a)) return failedRecord(fallbackId, "unparseable", url);
  const doi =
    typeof a.doi === "string" && /^10\.\d{4,9}\//.test(a.doi.trim())
      ? normalizeDoiKey(a.doi)
      : fallbackId;
  const type = typeof a.defined_type_name === "string" ? a.defined_type_name.toLowerCase() : null;
  // A metadata-only record describes data held elsewhere or available on request: its license
  // is not shown to be the data's, so an administrator decides.
  const metadataOnly = a.is_metadata_record === true;
  const authors = Array.isArray(a.authors)
    ? a.authors
        .map((x) => (isRecord(x) ? text(x.full_name) : null))
        .filter((x): x is string => x !== null)
        .slice(0, MAX_CREATORS)
    : [];
  const base = {
    id: doi,
    resolver: "figshare" as const,
    resource_type: type,
    title: text(a.title),
    creators: authors,
    publisher: "figshare",
    evidence_url: url,
  };
  if (
    metadataOnly ||
    type === null ||
    (!FIGSHARE_DATA_TYPES.has(type) && !FIGSHARE_PAPER_TYPES.has(type))
  ) {
    return unknownLicense(base);
  }
  const lic = isRecord(a.license) ? a.license : null;
  const texts = [lic?.url, lic?.name].filter(
    (t): t is string => typeof t === "string" && t.trim() !== "",
  );
  if (texts.length === 0) {
    return FIGSHARE_DATA_TYPES.has(type)
      ? unknownLicense(base)
      : withLicense(base, [], [], false, []);
  }
  let value = normalizeLicense(texts[0]);
  for (const t of texts.slice(1)) {
    if (value.license !== "other") break;
    value = normalizeLicense(t);
  }
  return withLicense(
    base,
    [value],
    [texts[0]],
    FIGSHARE_DATA_TYPES.has(type),
    declaredList([declared(lic?.name, lic?.url)]),
  );
}

async function resolveOpenNeuro(
  id: string,
  ds: string,
  version: string,
  resourceType: string | null,
  /** The DataCite record's title, creators and publisher: OpenNeuro's answer holds only the license. */
  described: Described,
  o: FetchContext,
): Promise<SourceRecord> {
  const evidence = `https://openneuro.org/datasets/${ds}/versions/${version}`;
  const query = `query { snapshot(datasetId: "${ds}", tag: "${version}") { tag description { License } } }`;
  const got = await o.get(`${o.bases.openneuro}/crn/graphql`, {
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
    declaredList([declared(raw, null)]),
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
  o: FetchContext,
  /** The DataCite record's creators and publisher, when it led here; PhysioNet's API names none. */
  described: Described = NOT_DESCRIBED,
): Promise<SourceRecord> {
  const api = `${o.bases.physionet}/api/v1/project/published/${encodeURIComponent(slug)}/`;
  let ver = version;
  if (!ver) {
    const list = await o.get(api);
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
  const got = await o.get(url);
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
    declaredList([declared(name, null)]),
  );
}

/** How many children an OSF child node has (`related_counts=children`), or null when not given. */
function childCountOf(child: unknown): number | null {
  if (!isRecord(child) || !isRecord(child.relationships)) return null;
  const rel = child.relationships.children;
  const related = isRecord(rel) && isRecord(rel.links) ? rel.links.related : null;
  const meta = isRecord(related) && isRecord(related.meta) ? related.meta : null;
  return meta !== null && Number.isInteger(meta.count) ? Number(meta.count) : null;
}

/** The most child components of an OSF node read; a node with more is not judged. */
export const MAX_OSF_CHILDREN = 50;

/**
 * One OSF node's license from an API node object with its license embedded: `{ value }` (null when
 * the node declares none, read as `none`), or null when the relationship is there but its embedded
 * license is not (unparseable).
 */
function osfNodeLicense(node: Record<string, unknown>): {
  value: NormalizedLicenseValue | null;
  texts: string[];
  declared: DeclaredLicense | null;
} | null {
  const relationships = isRecord(node.relationships) ? node.relationships : {};
  if (relationships.license === null || relationships.license === undefined) {
    return { value: null, texts: [], declared: null };
  }
  const embedded = isRecord(node.embeds) ? node.embeds.license : null;
  if (!isRecord(embedded) || !isRecord(embedded.data) || !isRecord(embedded.data.attributes)) {
    return null;
  }
  const license = embedded.data.attributes;
  const texts = [license.url, license.name].filter(
    (t): t is string => typeof t === "string" && t.trim() !== "",
  );
  let value: NormalizedLicenseValue | null = null;
  for (const t of texts) {
    value = normalizeLicense(t);
    if (value.license !== "other") break;
  }
  return { value, texts, declared: declared(license.name, license.url) };
}

/**
 * An OSF node's license, from OSF's API (`/v2/nodes/<guid>/?embed=license`), for an OSF DOI
 * DataCite does not hold, holds with no rights (ADR 0142 decision 3), or registers as a project
 * (ADR 0139 decision 7, amendment of 2026-11-27). The node's child components hold data too, so
 * they are read (`/v2/nodes/<guid>/children/`) and the most restrictive license of the node and
 * its children wins; a child that declares none counts as `none`. A children list that cannot be
 * read, or one whose license cannot be, is failed or unparseable; more than
 * {@link MAX_OSF_CHILDREN} children leave the license unknown (`unresolved`). A node with no
 * license relationship declares none (`none`). A private node answers 401, which is a failed fetch
 * and not retried. `dataLike` says the record holds data (a Dataset or a project).
 */
async function resolveOsf(
  doi: string,
  guid: string,
  resourceType: string | null,
  dataLike: boolean,
  /** The DataCite record's title, creators and publisher, when it holds the DOI. */
  described: Described,
  o: FetchContext,
  /** DataCite holds the DOI; when it does not, the DOI is NEMAR's construction from the URL. */
  registered = true,
): Promise<SourceRecord> {
  const fail = (status: SourceStatus, at: string | null): SourceRecord => ({
    ...failedRecord(doi, status, at),
    ...(registered ? {} : { doi_registered: false as const }),
  });
  const url = `${o.bases.osf}/v2/nodes/${encodeURIComponent(guid)}/?embed=license`;
  const got = await o.get(url);
  if (got.kind === "absent") return fail("not_found", url);
  if (got.kind === "failed") return fail(got.status, url);
  const body = got.body;
  if (!isRecord(body) || !isRecord(body.data) || !isRecord(body.data.attributes)) {
    return fail("unparseable", url);
  }
  const node = body.data;
  const attributes = node.attributes as Record<string, unknown>;
  const own = osfNodeLicense(node);
  if (own === null) return fail("unparseable", url);
  const type = resourceType ?? "Dataset";
  const base = {
    id: doi,
    resolver: "osf" as const,
    resource_type: type,
    title: described.title ?? text(attributes.title),
    creators: described.creators,
    publisher: described.publisher ?? "OSF",
    evidence_url: url,
    ...(registered ? {} : { doi_registered: false as const }),
  };
  const childUrl = `${o.bases.osf}/v2/nodes/${encodeURIComponent(guid)}/children/?embed=license&page[size]=${MAX_OSF_CHILDREN}&related_counts=children`;
  const ch = await o.get(childUrl);
  if (ch.kind === "absent") return fail("not_found", childUrl);
  if (ch.kind === "failed") return fail(ch.status, childUrl);
  const cb = ch.body;
  if (!isRecord(cb) || !Array.isArray(cb.data)) return fail("unparseable", childUrl);
  const next = isRecord(cb.links) ? cb.links.next : null;
  if ((next !== null && next !== undefined) || cb.data.length > MAX_OSF_CHILDREN) {
    return unknownLicense(base);
  }
  const values: NormalizedLicenseValue[] = [own.value ?? { license: "none", version: null }];
  const raws = [...own.texts];
  const entries: Array<DeclaredLicense | null> = [own.declared];
  for (const child of cb.data) {
    // Only direct children are read: a child with children of its own (or one whose count is not
    // given) leaves the license unknown, and an administrator decides; the tree is not walked.
    if (childCountOf(child) !== 0) return unknownLicense(base);
    const lic = isRecord(child) ? osfNodeLicense(child) : null;
    if (lic === null) return fail("unparseable", childUrl);
    values.push(lic.value ?? { license: "none", version: null });
    raws.push(...lic.texts);
    entries.push(lic.declared);
  }
  return { ...withLicense(base, values, raws, dataLike, declaredList(entries)), parts: values };
}

/**
 * One DOI's record: DataCite, then Crossref, then OpenAlex; a repository API completes it. An OSF
 * DOI that DataCite does not hold goes to OSF's API, never to Crossref or OpenAlex.
 */
async function resolveDoiUncached(doi: string, o: FetchContext): Promise<SourceRecord> {
  const enc = encodeURIComponent(doi);
  const dcUrl = `${o.bases.datacite}/dois/${enc}`;
  const dc = await o.get(dcUrl);
  if (dc.kind === "failed") return failedRecord(doi, dc.status, dcUrl);
  if (dc.kind === "ok") {
    const body = dc.body;
    if (!isRecord(body) || !isRecord(body.data) || !isRecord(body.data.attributes)) {
      return failedRecord(doi, "unparseable", dcUrl);
    }
    const a = body.data.attributes;
    const types = isRecord(a.types) ? a.types : {};
    const rtg = typeof types.resourceTypeGeneral === "string" ? types.resourceTypeGeneral : null;
    const { values, raws, declared: declaredLicenses } = dataciteLicenses(a.rightsList);
    const isDataset = rtg === "Dataset";
    if (rtg === "Collection") return resolveCollection(doi, dataciteDescribed(a), dcUrl, o);
    const osfProject = isOsfProject(doi, types.resourceType);
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
    const osf = OSF_DOI.exec(doi);
    if (osf && (osfProject || (values.length === 0 && (isDataset || rtg === null)))) {
      // A record with no type is read as a node, as before; a project or a Dataset holds data.
      const dataLike = isDataset || osfProject || rtg === null;
      return resolveOsf(doi, osf[1], rtg, dataLike, dataciteDescribed(a), o);
    }
    // A Zenodo record DataCite does not type as a dataset is a publication; what Zenodo says it
    // holds is recorded beside it, so the card can say when a "journal article" holds data files.
    const files = isDataset ? null : await zenodoFilesOf(doi, o);
    return withLicense(
      {
        id: doi,
        resolver: "datacite",
        resource_type: rtg,
        ...dataciteDescribed(a),
        evidence_url: dcUrl,
        ...(isZenodoConcept(doi, a.relatedIdentifiers) ? { concept: true as const } : {}),
        ...(files === null ? {} : { registry_files: files }),
      },
      values,
      raws,
      isDataset,
      declaredLicenses,
    );
  }

  const osf = OSF_DOI.exec(doi);
  if (osf) return resolveOsf(doi, osf[1], null, true, NOT_DESCRIBED, o, false);

  const crUrl = `${o.bases.crossref}/works/${enc}`;
  const cr = await o.get(crUrl);
  if (cr.kind === "failed") return failedRecord(doi, cr.status, crUrl);
  if (cr.kind === "ok") {
    const msg = isRecord(cr.body) ? cr.body.message : null;
    if (!isRecord(msg)) return failedRecord(doi, "unparseable", crUrl);
    const type = typeof msg.type === "string" ? msg.type : null;
    const { values, raws, declared: declaredLicenses } = crossrefLicenses(msg.license);
    if (type === "component") return resolveComponent(doi, msg, crUrl, o);
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
      declaredLicenses,
    );
  }

  const oaUrl = `${o.bases.openalex}/works/doi:${enc}`;
  const oa = await o.get(oaUrl);
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
    declaredList([declared(lic, null)]),
  );
}

/**
 * Statuses that are answers and may be cached. A failure is asked again next time, and so is
 * `not_found`: it makes the source `unresolved`, and an `unresolved` source is never served from
 * the cache (ADR 0142 decision 3), since a registry that does not yet index a new DOI answers it.
 */
const CACHEABLE: ReadonlySet<SourceStatus> = new Set(["resolved", "publication"]);

/** A cached answer is used only when it is a record this version could have written; else a miss. */
export function isValidCachedRecord(hit: unknown): hit is SourceRecord {
  return (
    isRecord(hit) &&
    typeof hit.id === "string" &&
    typeof hit.status === "string" &&
    Array.isArray(hit.creators) &&
    Array.isArray(hit.declared_licenses) &&
    (SOURCE_STATUSES as readonly string[]).includes(hit.status) &&
    CACHEABLE.has(hit.status as SourceStatus) &&
    // A record read but with no license is an `unresolved` source, never served from the cache.
    !(hit.status === "resolved" && hit.license === null) &&
    (hit.parts === undefined ||
      (Array.isArray(hit.parts) &&
        hit.parts.every(
          (p) =>
            isRecord(p) &&
            (NORMALIZED_LICENSES as readonly string[]).includes(String(p.license)) &&
            (p.version === null || typeof p.version === "string"),
        ))) &&
    (hit.license === null ||
      (NORMALIZED_LICENSES as readonly string[]).includes(String(hit.license)))
  );
}

/**
 * The cache key prefix of a DOI's record. `doi3:` since records carry whether an OSF DOI is
 * registered and what a Zenodo paper holds (`doi2:` added the Zenodo concept flag), so a record
 * cached before them is read again rather than served without them.
 */
const DOI_CACHE_KEY = "doi3:";

async function cached(
  key: string,
  cache: LineageCache | undefined,
  run: () => Promise<SourceRecord>,
): Promise<SourceRecord> {
  const k = `${RESOLVER_VERSION}:${key}`;
  const hit = await cache?.get(k).catch(() => undefined);
  if (isValidCachedRecord(hit)) return hit;
  const rec = await run();
  if (cache && isValidCachedRecord(rec)) await cache.put(k, rec).catch(() => undefined);
  return rec;
}

async function resolveRef(
  ref: SourceRef,
  o: FetchContext,
  cache: LineageCache | undefined,
): Promise<SourceRecord> {
  switch (ref.kind) {
    case "doi":
      return cached(`${DOI_CACHE_KEY}${ref.doi}`, cache, () => resolveDoiUncached(ref.doi, o));
    case "url":
      return failedRecord(ref.url, "no_doi", null);
    case "figshare_article":
      return cached(`figshare:${ref.id}:${ref.version ?? ""}`, cache, () =>
        resolveFigshareArticle(ref.id, ref.version, o),
      );
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
      const got = await o.get(url);
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
      return cached(`${DOI_CACHE_KEY}${doi}`, cache, () => resolveDoiUncached(doi, o));
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
  record: Pick<SourceRecord, "status" | "license" | "license_version" | "parts">,
  target: NormalizedLicenseValue,
): LineageOutcome {
  if (record.status === "publication") return "source_is_publication";
  if (record.status === "resolved" && record.parts !== undefined && record.parts.length > 0) {
    return combineOutcomes(
      record.parts.map((p) => ({
        license: p.license,
        outcome: sourceOutcome(
          { status: "resolved", license: p.license, license_version: p.version },
          target,
        ),
      })),
    );
  }
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
  /**
   * The record was resolved to its latest version, not to a version the dataset declared
   * ({@link isLatestRef}): the upstream may have changed, its title included, since the copy.
   * Absent otherwise. The name rule (`shared/name-follows-upstream.ts`) reads it.
   */
  resolved_latest?: true;
}

/**
 * A Zenodo concept DOI's DataCite record: a `10.5281/` DOI whose record lists versions
 * (`HasVersion`) and is not itself a version of another (`IsVersionOf`). Its title follows the
 * latest version, so it is not the version a dataset was copied from.
 */
export function isZenodoConcept(doi: string, relatedIdentifiers: unknown): boolean {
  if (!doi.startsWith("10.5281/") || !Array.isArray(relatedIdentifiers)) return false;
  const types = relatedIdentifiers.map((r) => (isRecord(r) ? r.relationType : null));
  return types.includes("HasVersion") && !types.includes("IsVersionOf");
}

/**
 * A source whose record is not fixed to the version the dataset declared: a reference resolved to
 * the latest version ({@link isLatestRef}), a Zenodo concept record, or an OSF node, whose title is
 * edited in place. The name rule reads it as `resolved_latest`.
 */
export function isLatestSource(ref: SourceRef, rec: SourceRecord): boolean {
  return isLatestRef(ref) || rec.concept === true || rec.resolver === "osf";
}

/**
 * A reference that names no version and is resolved to the latest one: a version-less OpenNeuro
 * DOI or URL, a figshare article URL or figshare DOI without a version, a PhysioNet project
 * without one.
 */
export function isLatestRef(ref: SourceRef): boolean {
  switch (ref.kind) {
    case "openneuro_latest":
      return true;
    case "figshare_article":
    case "physionet":
      return ref.version === null;
    case "doi":
      return /^10\.6084\/m9\.figshare\.(?:c\.)?\d+$/.test(ref.doi);
    case "url":
      return false;
  }
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
  /**
   * DOI candidates in the README and the attestation dropped as cut short
   * ({@link isCutDoiCandidate}): counted, never sources.
   */
  dropped_doi_candidates: number;
  /**
   * Enrichment relations skipped as stale: publications listed as IsDerivedFrom or IsIdenticalTo
   * in `.nemar/metadata.json` that SourceDatasets does not name ({@link dropStaleRelations}).
   * Absent from a result of resolver version 5 or older.
   */
  skipped_stale_relations?: number;
  resolver_version: string;
  /**
   * When this lineage was resolved (an instant, ISO 8601): the review's lineage and the decision
   * card's each carry their own, so the two can be shown side by side (ADR 0142 decision 3).
   */
  resolved_at: string;
  /** The same instant as `resolved_at`, kept for readers of resolver version 2. */
  fetched_at: string;
}

/** Resolve a dataset's license lineage from what it declares. Never rejects. */
export async function resolveLicenseLineage(
  inputs: LineageInputs,
  options: ResolveOptions = {},
): Promise<LineageResult> {
  const now = options.now ?? (() => new Date());
  const clock = () => Date.now();
  const fetchArgs = {
    timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
    retry: options.retry ?? LINEAGE_RETRY,
    budget: { left: options.fetchBudget ?? LINEAGE_FETCH_BUDGET },
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    clock,
    startedAt: clock(),
  };
  const o: FetchContext = {
    bases: options.bases ?? DEFAULT_BASES,
    get: lineageFetch(fetchArgs),
    getOnce: lineageFetch({ ...fetchArgs, retry: NO_RETRY }),
  };
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
    const at = now().toISOString();
    return {
      outcome: "unresolved",
      inputs: states,
      target_license: null,
      target_license_raw: null,
      sources: unreadable,
      dropped_doi_candidates: 0,
      skipped_stale_relations: 0,
      resolver_version: RESOLVER_VERSION,
      resolved_at: at,
      fetched_at: at,
    };
  }
  const targetRaw = declaredLicense(parsed.datasetDescription);
  const target = normalizeLicense(targetRaw);
  const { refs, dropped } = extractSources(parsed);
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
  const resolved: LineageSource[] = records.map((rec, i) => ({
    ...rec,
    origin: refs[i].origin,
    outcome: sourceOutcome(rec, target),
    ...(rec.status === "resolved" && isLatestSource(refs[i], rec)
      ? { resolved_latest: true as const }
      : {}),
    ...(osfRegistrationUnconfirmed(refs[i], rec) ? { doi_registered: false as const } : {}),
  }));
  const { kept, skipped } = dropStaleRelations(resolved, refs);
  const sources: LineageSource[] = [...kept, ...unreadable];
  const at = now().toISOString();
  return {
    // A README that names a source only as a DOI cut short has declared one: `unresolved` (the
    // check could not read it), never `no_upstream_declared`, which reads as nothing to do.
    // Likewise a stale publication relation that was the only thing named: an administrator
    // decides (`unresolved`), never `no_upstream_declared`.
    outcome:
      sources.length === 0 && (dropped > 0 || skipped > 0)
        ? "unresolved"
        : combineOutcomes(sources),
    inputs: states,
    target_license: target.license,
    target_license_raw: targetRaw,
    sources,
    dropped_doi_candidates: dropped,
    skipped_stale_relations: skipped,
    resolver_version: RESOLVER_VERSION,
    resolved_at: at,
    fetched_at: at,
  };
}

/**
 * The resolved sources less what stale or repeated metadata adds (ADR 0139 decision 7, amendment
 * of 2026-11-27, resolver version 6):
 *
 *  - a source from another input that resolves to the same record as a SourceDatasets entry is
 *    that entry (a figshare URL in SourceDatasets resolves to its DOI, which the enrichment may
 *    also list), so the SourceDatasets entry alone stands;
 *  - an enrichment relation (`.nemar/metadata.json` IsDerivedFrom or IsIdenticalTo) that is a
 *    publication and that SourceDatasets does not name is skipped and counted: NEMAR's own
 *    metadata may still carry a paper a depositor has since moved to ReferencesAndLinks, until the
 *    next enrichment drops it, and it must not block the request meanwhile.
 */
function dropStaleRelations(
  sources: LineageSource[],
  refs: SourceRef[],
): { kept: LineageSource[]; skipped: number } {
  const named = new Set<string>();
  sources.forEach((s, i) => {
    if (s.origin !== "source_datasets") return;
    named.add(s.id.toLowerCase());
    const ref = refs[i];
    if (ref.kind === "doi") named.add(ref.doi.toLowerCase());
  });
  let skipped = 0;
  const kept = sources.filter((s) => {
    if (s.origin === "source_datasets") return true;
    if (named.has(s.id.toLowerCase())) return false;
    if (s.origin === "related_identifiers" && s.status === "publication") {
      skipped++;
      return false;
    }
    return true;
  });
  return { kept, skipped };
}

/** A source's declared licenses as one line's words: each text and URL, or that it declares none. */
export function declaredLicenseWords(
  source: Pick<SourceRecord, "status"> & { declared_licenses?: DeclaredLicense[] },
): string {
  // A result from a Worker of resolver version 2 carries no declared licenses at all.
  if (source.declared_licenses === undefined) return "not recorded (an older resolver version)";
  const list = source.declared_licenses;
  if (list.length === 0) {
    return source.status === "resolved" || source.status === "publication"
      ? "none (the record lists no license)"
      : "not read (no record was read)";
  }
  return list
    .map((d) =>
      d.text !== null && d.url !== null
        ? `"${d.text}" <${d.url}>`
        : d.text !== null
          ? `"${d.text}"`
          : `<${d.url}>`,
    )
    .join("; ");
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
      `  - ${sourceLabelOf(s)} [${s.origin}]: ${s.outcome}; license ${lic}; type ${s.resource_type ?? "unknown"}; via ${s.resolver ?? "none"}`,
    );
    lines.push(`      ${SOURCE_STATUS_COPY[s.status].statement}`);
    lines.push(
      `      read: ${s.resolver ? RESOLVER_READ[s.resolver] : SOURCE_STATUS_COPY[s.status].read}`,
    );
    // What the source itself declares, beside the normalized word: for every source that needs
    // action, `needs_permission` and `unresolved` included (ADR 0142 decision 3).
    if (!COMPATIBLE_OUTCOMES.has(s.outcome)) {
      lines.push(`      declared license: ${declaredLicenseWords(s)}`);
    }
    if (s.evidence_url) lines.push(`      evidence: ${s.evidence_url}`);
    const paper = paperWithDataFilesLine(s);
    if (paper !== null) lines.push(`      note: ${paper}`);
    if (s.status !== "resolved") lines.push(`      remedy: ${SOURCE_STATUS_COPY[s.status].remedy}`);
  }
  // `?? 0` and `?? fetched_at`: a Worker of resolver version 2 sends neither field.
  if ((result.skipped_stale_relations ?? 0) > 0) {
    lines.push(
      `Skipped: ${result.skipped_stale_relations} publication(s) listed as IsDerivedFrom or IsIdenticalTo in .nemar/metadata.json that SourceDatasets does not name (stale enrichment, not sources).`,
    );
  }
  if ((result.dropped_doi_candidates ?? 0) > 0) {
    lines.push(
      `Dropped: ${result.dropped_doi_candidates} DOI candidate(s) cut short in the README or attestation (not sources).`,
    );
  }
  lines.push(`Read: ${copy.read}`);
  lines.push(`Remedy: ${copy.remedy}`);
  lines.push(`Docs: ${copy.anchor}`);
  lines.push(
    `Resolver: ${result.resolver_version}, resolved ${result.resolved_at ?? result.fetched_at}`,
  );
  return lines;
}
