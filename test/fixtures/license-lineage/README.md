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
Files 21 to 29 were fetched on 2026-11-27 for resolver version 3 (epic #2449, phase 3; ADR 0142 decision 3), the same way, with no edits:
they hold no email address, and the OSF node records were requested without their contributors.
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

The two OpenNeuro POSTs carry the GraphQL query recorded in `index.json` (`body`).

## Licenses of the recorded metadata

- DataCite metadata is released under CC0.
- Crossref metadata is facts, which Crossref states carry no restriction on reuse.
- OpenAlex data is released under CC0.
- OpenNeuro dataset metadata comes from datasets released under CC0 (the recorded `License` value).
- The PhysioNet API records are public project metadata, kept here as test evidence of the license names and access policies.
- The OSF API node records are public project metadata, kept here as test evidence of the license each node declares.
