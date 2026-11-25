# License lineage fixtures

Real registry and repository responses for the license lineage resolver
(`shared/license-lineage.ts`, epic #2182 card D1).
They were fetched on 2026-11-25 with `User-Agent: nemar-license-check/1` and stored byte for byte,
with two edits, both recorded in `index.json` (`edited`):
- the email addresses in `19-openalex-article.json` are replaced by `redacted@example.org`;
- in `03-datacite-openneuro-latest.json` and `04-datacite-openneuro-latest.json`, the personal name of one NEMAR curator listed as a contributor is replaced by `REDACTED, contributor`, and that curator's ORCID iD is removed.
  The names and ORCID iDs of third-party authors are kept as recorded.
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

The two OpenNeuro POSTs carry the GraphQL query recorded in `index.json` (`body`).

## Licenses of the recorded metadata

- DataCite metadata is released under CC0.
- Crossref metadata is facts, which Crossref states carry no restriction on reuse.
- OpenAlex data is released under CC0.
- OpenNeuro dataset metadata comes from datasets released under CC0 (the recorded `License` value).
- The PhysioNet API records are public project metadata, kept here as test evidence of the license names and access policies.
