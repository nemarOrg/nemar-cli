# License lineage fixtures

Real registry and repository responses for the license lineage resolver
(`shared/license-lineage.ts`, epic #2182 card D1).
They were fetched on 2026-11-25 with `User-Agent: nemar-license-check/1` and stored byte for byte,
with two edits, both recorded in `index.json` (`edited`):
- the email addresses in `19-openalex-article.json` are replaced by `redacted@example.org`;
- in `03-datacite-openneuro-latest.json` and `04-datacite-openneuro-latest.json`, the personal name of one NEMAR curator listed as a contributor is replaced by `REDACTED, contributor`, and that curator's ORCID iD is removed.
  The names and ORCID iDs of third-party authors are kept as recorded.
  The other curator names in fixtures 03 and 04 are public DataCite contributor metadata of that OpenNeuro record, kept on purpose so the fixtures stay the registry's real answer.
Resolver version 2 (epic #2182, card B4) also reads each record's title, creators and publisher from these same recordings; nothing was recorded again for it.
Files 21 to 32 were fetched on 2026-11-27 for resolver version 3 (epic #2449, phase 3; ADR 0142 decision 3), the same way, with no edits:
they hold no email address, and the OSF node records were requested without their contributors.
Files 33 to 35 were fetched on 2026-11-27 for resolver version 4 (ADR 0142 decision 3, amendment of 2026-11-27), the same way, with no edits; they hold no email address.
Files 36 to 42 were fetched on 2026-11-27 for resolver version 5 (ADR 0139 decision 7, amendment of 2026-11-27), the same way, with no edits; they hold no email address.
Files 43 to 61 were fetched on 2026-11-27 for the review of resolver version 5 from the figshare and OSF APIs and DataCite, the same way, with no edits; they hold no email address.
`index.json` lists every recording with its method, URL, HTTP status, file and fetch time;
`stand-in.ts` serves them to the tests from a local server.

## Cases

- **OpenNeuro CC0:** `10.18112/openneuro.ds003645.v2.0.2`.
  DataCite holds the record with an empty `rightsList`;
  OpenNeuro's GraphQL `snapshot(...).description.License` says `CC0`.
  The unversioned form resolves through DataCite's latest record, `v2.1.0`.
- **PhysioNet open, ODC-By:** `eegmmidb` 1.0.0, DOI `10.13026/C28G6P`.
  DataCite holds no rights and an unversioned landing page;
  the PhysioNet API gives the license name and `access_policy` `Open`.
- **PhysioNet credentialed:** `mimic-iv-ed` 2.2, DOI `10.13026/5ntk-km72`, `access_policy` `Credentialed`.
- **Zenodo CC-BY-NC:** `10.5281/zenodo.22967622`.
- **ND:** `10.5281/zenodo.21156617`, CC-BY-NC-ND-4.0.
- **Share-alike:** `10.5281/zenodo.24015383`, CC-BY-SA-4.0.
- **Attribution:** `10.5281/zenodo.24539621`, CC-BY-4.0.
- **Article, and a DOI DataCite lacks:** `10.1038/s41597-019-0027-4`.
  DataCite answers 404; Crossref says `journal-article` and lists the CC BY URL twice, once as `tdm` and once as `vor`;
  OpenAlex says `data-paper`.
- **OpenAlex dataset record with no license:** the OpenNeuro DOI above.
- **OSF URL, no DataCite DOI, share-alike:** `https://osf.io/rmafj` (a production source, nm000712).
  DataCite answers 404 for `10.17605/osf.io/rmafj`;
  OSF's API declares CC BY-SA 4.0 for the node.
- **OSF URL, no DataCite DOI, attribution:** `https://osf.io/j3s7g` (a production source, nm001031); OSF declares CC BY 4.0.
- **OSF DOI with DataCite rights:** `10.17605/osf.io/wpkrz`, a Dataset with CC BY 4.0 in its `rightsList`; OSF is not asked.
- **OSF DOI, DataCite with no rights, node with no license:** `10.17605/osf.io/j7as8`;
  DataCite's `rightsList` is empty and the node's license relationship is null.
- **PsychArchives, CC BY beside an access-rights word:** `10.23668/psycharchives.22830`;
  its `rightsList` holds `CC-BY 4.0`, `openAccess` and the SPDX CC BY 4.0 entry.
- **PsychArchives, a license NEMAR does not recognize:** `10.23668/psycharchives.22842`;
  `Scientific Use License v1`, `restrictedAccess` and a `rightsUri` to the license's own DOI.
- **README DOI shapes a cut-candidate rule must accept** (review of #2472):
  a Harvard Dataverse DOI with a five-character suffix, `10.7910/DVN/29379` (CC0 Dataset);
  a figshare collection, `10.6084/m9.figshare.c.3307977` (resourceTypeGeneral `Collection`, CC BY 3.0 US);
  a Dryad file-level DOI, `10.5061/dryad.8pm4nv0/1` (resourceTypeGeneral `Other`, CC0).
- **A README that cuts a declared Zenodo DOI short:** `10.5281/zenodo.22314785` and `10.5281/zenodo.23610719`, the SourceDatasets of two production datasets (nm000746, nm000843) whose READMEs carry `10.5281/zenodo.2231` and `10.5281/zenodo.236`;
  both are CC BY 4.0 Datasets (the second also lists MIT).
  The cut copies are never fetched.
- **DANDI's license spelling:** `10.48324/dandi.001535/0.250714.1218` (a production source, nm001003);
  its `rightsList` holds only `rightsIdentifier` `cc_by_40` (scheme SPDX), the name of dandischema's `LicenseType.CC_BY_40`.
- **Data containers that are not `Dataset` records** (production sources of nm000812, nm000832, nm000808):
  an OSF project, `10.17605/osf.io/f8sq3`, which DataCite holds as `Text` with resourceType `Project` and `cc-by-4.0`;
  a figshare collection version, `10.6084/m9.figshare.c.6979581.v1` (`Collection`, `cc-by-4.0`);
  a PLOS supplementary file, `10.1371/journal.pone.0303144.s001`, which DataCite answers 404 and Crossref holds as `component` with no license and `is-component-of` its article, `10.1371/journal.pone.0303144` (`journal-article`, CC BY 4.0 `vor`).
- **A figshare collection is judged by its members:** `10.6084/m9.figshare.c.6979581.v1` declares CC BY 4.0 on DataCite, but figshare's API gives the collection no license and its one member, article 24803499, CC0;
  `10.6084/m9.figshare.c.3307977` (CC BY 3.0 US on DataCite) has three members, each CC0.
- **OSF projects read through OSF with their children:** `10.17605/osf.io/c5zbq` is `Text` / `Project` with an empty `rightsList`, no node license and seven child components, one CC BY-NC 4.0 and six with none;
  `10.17605/osf.io/yb3pq` is `Text` / `Project`, CC BY-NC-SA 4.0, with nine children, one of them CC BY 4.0;
  `f8sq3`, `wpkrz`, `rmafj`, `j3s7g` and `j7as8` have no children.
- **Genuine publications in data repositories:** `10.5281/zenodo.6529724` (`JournalArticle`, nm000661's source) and `10.6084/m9.figshare.28309157` (`JournalArticle`, resourceType `Journal contribution`).

## Recordings

| File | Case | Registry | Request | Status | Fetched |
| --- | --- | --- | --- | --- | --- |
| `01-datacite-openneuro-cc0.json` | openneuro-cc0 | datacite | GET https://api.datacite.org/dois/10.18112%2Fopenneuro.ds003645.v2.0.2 | 200 | 2026-11-25 |
| `02-openneuro-openneuro-cc0.json` | openneuro-cc0 | openneuro | POST https://openneuro.org/crn/graphql | 200 | 2026-11-25 |
| `03-datacite-openneuro-latest.json` | openneuro-latest | datacite | GET https://api.datacite.org/dois?query=id%3A10.18112%2Fopenneuro.ds003645.v*&sort=-created&page%5Bsize%5D=1 | 200 | 2026-11-25 |
| `04-datacite-openneuro-latest.json` | openneuro-latest | datacite | GET https://api.datacite.org/dois/10.18112%2Fopenneuro.ds003645.v2.1.0 | 200 | 2026-11-25 |
| `05-openneuro-openneuro-latest.json` | openneuro-latest | openneuro | POST https://openneuro.org/crn/graphql | 200 | 2026-11-25 |
| `06-physionet-physionet-odc-by.json` | physionet-odc-by | physionet | GET https://physionet.org/api/v1/project/published/eegmmidb/1.0.0/ | 200 | 2026-11-25 |
| `07-physionet-physionet-odc-by.json` | physionet-odc-by | physionet | GET https://physionet.org/api/v1/project/published/eegmmidb/ | 200 | 2026-11-25 |
| `08-datacite-physionet-odc-by.json` | physionet-odc-by | datacite | GET https://api.datacite.org/dois/10.13026%2Fc28g6p | 200 | 2026-11-25 |
| `10-physionet-physionet-credentialed.json` | physionet-credentialed | physionet | GET https://physionet.org/api/v1/project/published/mimic-iv-ed/2.2/ | 200 | 2026-11-25 |
| `11-datacite-physionet-credentialed.json` | physionet-credentialed | datacite | GET https://api.datacite.org/dois/10.13026%2F5ntk-km72 | 200 | 2026-11-25 |
| `13-datacite-zenodo-cc-by-nc.json` | zenodo-cc-by-nc | datacite | GET https://api.datacite.org/dois/10.5281%2Fzenodo.22967622 | 200 | 2026-11-25 |
| `14-datacite-zenodo-cc-by-nc-nd.json` | zenodo-cc-by-nc-nd | datacite | GET https://api.datacite.org/dois/10.5281%2Fzenodo.21156617 | 200 | 2026-11-25 |
| `15-datacite-zenodo-cc-by-sa.json` | zenodo-cc-by-sa | datacite | GET https://api.datacite.org/dois/10.5281%2Fzenodo.24015383 | 200 | 2026-11-25 |
| `16-datacite-zenodo-cc-by.json` | zenodo-cc-by | datacite | GET https://api.datacite.org/dois/10.5281%2Fzenodo.24539621 | 200 | 2026-11-25 |
| `17-datacite-article.json` | article | datacite | GET https://api.datacite.org/dois/10.1038%2Fs41597-019-0027-4 | 404 | 2026-11-25 |
| `18-crossref-article.json` | article | crossref | GET https://api.crossref.org/works/10.1038%2Fs41597-019-0027-4 | 200 | 2026-11-25 |
| `19-openalex-article.json` | article | openalex | GET https://api.openalex.org/works/doi:10.1038%2Fs41597-019-0027-4 | 200 | 2026-11-25 |
| `20-openalex-openalex-dataset.json` | openalex-dataset | openalex | GET https://api.openalex.org/works/doi:10.18112%2Fopenneuro.ds003645.v2.0.2 | 200 | 2026-11-25 |
| `21-datacite-osf-rmafj.json` | osf-url-sa | datacite | GET https://api.datacite.org/dois/10.17605%2Fosf.io%2Frmafj | 404 | 2026-11-27 |
| `22-osf-osf-rmafj.json` | osf-url-sa | osf | GET https://api.osf.io/v2/nodes/rmafj/?embed=license | 200 | 2026-11-27 |
| `23-datacite-osf-j3s7g.json` | osf-url-by | datacite | GET https://api.datacite.org/dois/10.17605%2Fosf.io%2Fj3s7g | 404 | 2026-11-27 |
| `24-osf-osf-j3s7g.json` | osf-url-by | osf | GET https://api.osf.io/v2/nodes/j3s7g/?embed=license | 200 | 2026-11-27 |
| `25-datacite-osf-cc-by.json` | osf-datacite-cc-by | datacite | GET https://api.datacite.org/dois/10.17605%2Fosf.io%2Fwpkrz | 200 | 2026-11-27 |
| `26-datacite-osf-no-rights.json` | osf-no-rights | datacite | GET https://api.datacite.org/dois/10.17605%2Fosf.io%2Fj7as8 | 200 | 2026-11-27 |
| `27-osf-osf-no-rights.json` | osf-no-rights | osf | GET https://api.osf.io/v2/nodes/j7as8/?embed=license | 200 | 2026-11-27 |
| `28-datacite-psycharchives-cc-by.json` | psycharchives-cc-by | datacite | GET https://api.datacite.org/dois/10.23668%2Fpsycharchives.22830 | 200 | 2026-11-27 |
| `29-datacite-psycharchives-other.json` | psycharchives-other | datacite | GET https://api.datacite.org/dois/10.23668%2Fpsycharchives.22842 | 200 | 2026-11-27 |
| `30-datacite-dataverse-cc0.json` | dataverse-cc0 | datacite | GET https://api.datacite.org/dois/10.7910%2Fdvn%2F29379 | 200 | 2026-11-27 |
| `31-datacite-figshare-collection.json` | figshare-collection | datacite | GET https://api.datacite.org/dois/10.6084%2Fm9.figshare.c.3307977 | 200 | 2026-11-27 |
| `32-datacite-dryad-file.json` | dryad-file | datacite | GET https://api.datacite.org/dois/10.5061%2Fdryad.8pm4nv0%2F1 | 200 | 2026-11-27 |
| `33-datacite-zenodo-22314785.json` | zenodo-readme-prefix-a | datacite | GET https://api.datacite.org/dois/10.5281%2Fzenodo.22314785 | 200 | 2026-11-27 |
| `34-datacite-zenodo-23610719.json` | zenodo-readme-prefix-b | datacite | GET https://api.datacite.org/dois/10.5281%2Fzenodo.23610719 | 200 | 2026-11-27 |
| `35-datacite-dandi-cc-by.json` | dandi-cc-by | datacite | GET https://api.datacite.org/dois/10.48324%2Fdandi.001535%2F0.250714.1218 | 200 | 2026-11-27 |
| `36-datacite-osf-project.json` | osf-project | datacite | GET https://api.datacite.org/dois/10.17605%2Fosf.io%2Ff8sq3 | 200 | 2026-11-27 |
| `37-datacite-figshare-collection-v1.json` | figshare-collection-v1 | datacite | GET https://api.datacite.org/dois/10.6084%2Fm9.figshare.c.6979581.v1 | 200 | 2026-11-27 |
| `38-datacite-plos-component.json` | plos-component | datacite | GET https://api.datacite.org/dois/10.1371%2Fjournal.pone.0303144.s001 | 404 | 2026-11-27 |
| `39-crossref-plos-component.json` | plos-component | crossref | GET https://api.crossref.org/works/10.1371%2Fjournal.pone.0303144.s001 | 200 | 2026-11-27 |
| `40-crossref-plos-parent.json` | plos-component | crossref | GET https://api.crossref.org/works/10.1371%2Fjournal.pone.0303144 | 200 | 2026-11-27 |
| `41-datacite-zenodo-article.json` | zenodo-article | datacite | GET https://api.datacite.org/dois/10.5281%2Fzenodo.6529724 | 200 | 2026-11-27 |
| `42-datacite-figshare-article.json` | figshare-article | datacite | GET https://api.datacite.org/dois/10.6084%2Fm9.figshare.28309157 | 200 | 2026-11-27 |
| `43-figshare-collection-articles.json` | figshare-collection-v1 | figshare | GET https://api.figshare.com/v2/collections/6979581/articles?page_size=11 | 200 | 2026-11-27 |
| `44-figshare-article-24803499.json` | figshare-collection-v1 | figshare | GET https://api.figshare.com/v2/articles/24803499 | 200 | 2026-11-27 |
| `45-osf-children-f8sq3.json` | osf-project | osf | GET https://api.osf.io/v2/nodes/f8sq3/children/?embed=license&page[size]=50 | 200 | 2026-11-27 |
| `46-osf-osf-f8sq3.json` | osf-project | osf | GET https://api.osf.io/v2/nodes/f8sq3/?embed=license | 200 | 2026-11-27 |
| `47-osf-children-rmafj.json` | osf-url-sa | osf | GET https://api.osf.io/v2/nodes/rmafj/children/?embed=license&page[size]=50 | 200 | 2026-11-27 |
| `48-osf-children-j3s7g.json` | osf-url-by | osf | GET https://api.osf.io/v2/nodes/j3s7g/children/?embed=license&page[size]=50 | 200 | 2026-11-27 |
| `49-osf-children-j7as8.json` | osf-no-rights | osf | GET https://api.osf.io/v2/nodes/j7as8/children/?embed=license&page[size]=50 | 200 | 2026-11-27 |
| `50-datacite-osf-project-no-rights.json` | osf-project-no-rights | datacite | GET https://api.datacite.org/dois/10.17605%2Fosf.io%2Fc5zbq | 200 | 2026-11-27 |
| `51-osf-osf-c5zbq.json` | osf-project-no-rights | osf | GET https://api.osf.io/v2/nodes/c5zbq/?embed=license | 200 | 2026-11-27 |
| `52-osf-children-c5zbq.json` | osf-project-no-rights | osf | GET https://api.osf.io/v2/nodes/c5zbq/children/?embed=license&page[size]=50 | 200 | 2026-11-27 |
| `53-datacite-osf-project-children.json` | osf-project-children | datacite | GET https://api.datacite.org/dois/10.17605%2Fosf.io%2Fyb3pq | 200 | 2026-11-27 |
| `54-osf-osf-yb3pq.json` | osf-project-children | osf | GET https://api.osf.io/v2/nodes/yb3pq/?embed=license | 200 | 2026-11-27 |
| `55-osf-children-yb3pq.json` | osf-project-children | osf | GET https://api.osf.io/v2/nodes/yb3pq/children/?embed=license&page[size]=50 | 200 | 2026-11-27 |
| `56-osf-osf-wpkrz.json` | osf-datacite-cc-by | osf | GET https://api.osf.io/v2/nodes/wpkrz/?embed=license | 200 | 2026-11-27 |
| `57-osf-children-wpkrz.json` | osf-datacite-cc-by | osf | GET https://api.osf.io/v2/nodes/wpkrz/children/?embed=license&page[size]=50 | 200 | 2026-11-27 |
| `58-figshare-collection-3307977-articles.json` | figshare-collection | figshare | GET https://api.figshare.com/v2/collections/3307977/articles?page_size=11 | 200 | 2026-11-27 |
| `59-figshare-article-3563034.json` | figshare-collection | figshare | GET https://api.figshare.com/v2/articles/3563034 | 200 | 2026-11-27 |
| `60-figshare-article-3563031.json` | figshare-collection | figshare | GET https://api.figshare.com/v2/articles/3563031 | 200 | 2026-11-27 |
| `61-figshare-article-3563028.json` | figshare-collection | figshare | GET https://api.figshare.com/v2/articles/3563028 | 200 | 2026-11-27 |

The two OpenNeuro POSTs carry the GraphQL query recorded in `index.json` (`body`).

## Licenses of the recorded metadata

- DataCite metadata is released under CC0.
- Crossref metadata is facts, which Crossref states carry no restriction on reuse.
- OpenAlex data is released under CC0.
- OpenNeuro dataset metadata comes from datasets released under CC0 (the recorded `License` value).
- The PhysioNet API records are public project metadata, kept here as test evidence of the license names and access policies.
- The OSF API node records are public project metadata, kept here as test evidence of the license each node declares.
