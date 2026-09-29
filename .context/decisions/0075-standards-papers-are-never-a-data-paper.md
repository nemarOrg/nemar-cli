# ADR 0075: Standards papers are never a dataset's data paper, and relation types are chosen from resolved DOIs

**Status:** accepted
**Date:** 2026-09-29
**Owner:** Seyed Yahya Shirazi

## Context

`nemarOrg/nemar-citations` credits a dataset with the citations of every DOI that
`.nemar/metadata.json` marks as describing the data, so the relation type the enrichment
writes decides what the citations dashboard counts. The enrichment LLM saw only README
prose and bare DOI strings, and both failure directions reached production:
`nm000275`'s own Scientific Data descriptor was labeled `References`, while MNE-BIDS,
EEG-BIDS, and MEG-BIDS were labeled `IsDescribedBy` on dozens of datasets, and a typo'd
DOI resolving to an electricity-market paper was labeled a data descriptor (#1549).

## Decision

A fixed list of standards, software, platform, and umbrella-initiative papers
(`shared/never-data-paper.ts`, plus a narrow BIDS-specification title rule) is never
stored under a data-describing relation (`IsDescribedBy`, `IsSupplementTo`,
`IsDerivedFrom`, `IsIdenticalTo`, `IsVersionOf`); `enforceNeverDataPaper` demotes such an
entry to `References` after every enrichment stage and once more on the final document,
so no LLM output, seed, or carried-forward metadata can override it. The same guard drops
the dataset's own NEMAR DOI (concept or version) from `related_identifiers`. The DOI key
and the title rule match nemar-citations' `normalize_doi` and `is_spec_title`.
Before the LLM stages run, every candidate DOI is resolved (DataCite content
negotiation, Crossref fallback) and its title, first author, year, venue, and type are put
in the enrichment, validation, and correction prompts; the data paper is `IsDescribedBy`,
a deposit of the same data elsewhere is `IsDerivedFrom`, and everything else is
`References`. Because `IsDerivedFrom` is locked once written, the LLM may write it only
for a DOI whose DataCite `resourceTypeGeneral` is `Dataset`. `IsSupplementTo` is never
rewritten deterministically except for a listed DOI; nemar-citations' judge decides it.

## Consequences

- The list is a deliberate, reviewed override of the model. A new standards paper that
  starts leaking is fixed by adding its DOI here AND to nemar-citations' never-anchor
  list; the two repositories must stay in step.
- A dataset whose genuine data paper is on the list cannot be expressed. That is why the
  MIPDB resource paper (`10.1038/sdata.2017.40`, Langer et al. 2017) is deliberately NOT
  blocked: it is `nm000153`'s own descriptor. Only papers that describe no single dataset
  belong here.
- Enrichment resolves up to 15 DOIs per run through one per-run registry cache shared with
  ORCID discovery, so a DOI costs at most one request per registry. A registry outage does
  not fail the run: the lookup is reported as `failed` in `doi_resolution` on the reindex
  response, the labels fall back to the unresolved behavior, and the sweep retries the
  dataset.
- Existing metadata picks up the corrected labels only when re-enriched, so a sweep is
  part of rolling this out.
- `URL` entries (the GitHub repo and NEMAR landing page `IsDescribedBy` links) are
  untouched; the rules apply to DOI entries only.

## Alternatives considered

- **Prompt-only tightening:** the #826 prompt already said standards papers are
  `References`, and they still leaked. A deterministic guard is the only thing that makes
  "never" true.
- **Let the citation pipeline alone decide:** nemar-citations does gate anchors with its
  own judge and list, but `metadata.json` is also the DataCite record and is read by other
  consumers; a mislabeled relation there is wrong regardless of who filters it later.

## Receipts

- nemarOrg/nemar-cli#1549
- ADR-less precursor: #826 (the reclassifiable citation triad in `mergeWithExisting`)
