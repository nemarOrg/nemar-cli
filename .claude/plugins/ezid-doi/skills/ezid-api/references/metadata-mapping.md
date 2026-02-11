# BIDS + neuroschema to DataCite Mapping

How NEMAR dataset metadata maps to DataCite fields.

## Automatic Mapping (from BIDS dataset_description.json)

| BIDS Field | DataCite Property | Transformation |
|-----------|-------------------|----------------|
| `Name` | Title (#3) | Direct |
| `Authors[]` | Creator (#2) | Parse "Last, First" into givenName/familyName |
| `License` | Rights (#16) | Map to SPDX identifier + URI |
| `DatasetType` | ResourceType (#10) qualifier | "raw" -> "EEG Dataset", etc. |
| `Version` or tag | Version (#15) | From BIDS or git tag |
| `Funding[]` | FundingReference (#19) | Parse funder name (structured if available) |
| `HowToAcknowledge` | Description (#17) type=Other | Direct |
| `ReferencesAndLinks[]` | RelatedIdentifier (#12) | Parse DOIs vs URLs |

## Always Set by NEMAR (constants)

| DataCite Property | Value |
|-------------------|-------|
| Publisher (#4) | "NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)" |
| ResourceType (#10) general | "Dataset" |
| Contributor (#7) | NEMAR as HostingInstitution |
| Language (#9) | "en" |
| AlternateIdentifier (#11) | NEMAR dataset ID (e.g., "nm000103") |

## From neuroschema (when available)

| neuroschema Field | DataCite Property |
|-------------------|-------------------|
| `recording_modality` | ResourceType (#10) specific (EEG/MEG/EMG/fMRI) |
| `data_summary.size_bytes` | Size (#13) |
| `data_summary.total_files` | Size (#13) |
| `data_summary.channel_count_range` | Size (#13) |
| `provenance.publish_date` | Date (#8) type=Issued |
| `provenance.created_at` | Date (#8) type=Created |
| `external_links.associated_paper_doi` | RelatedIdentifier (#12) type=IsSupplementTo |
| `external_links.dataset_doi` | Identifier (#1) |
| `subjects_count` | Size (#13) |

## Requires User Enrichment (nemar_metadata.json)

These fields cannot be automatically derived from BIDS:

| Field | DataCite Property | Source |
|-------|-------------------|--------|
| ORCID per author | Creator (#2) nameIdentifier | User input or ORCID API |
| Affiliation per author | Creator (#2) affiliation | User input |
| ROR per affiliation | Creator (#2) affiliationIdentifier | ROR API lookup |
| Keywords | Subject (#6) | User input |
| Paper DOIs | RelatedIdentifier (#12) | User input |
| Abstract | Description (#17) | User input or README |
| Methods description | Description (#17) type=Methods | User input |
| Data collection dates | Date (#8) type=Collected | User input |
| Structured funding | FundingReference (#19) | User input |
| Collection location | GeoLocation (#18) | User input |

## License Mapping Table

| BIDS License String | SPDX ID | DataCite rightsURI |
|---------------------|---------|--------------------|
| "CC BY 4.0" / "CC-BY-4.0" | CC-BY-4.0 | https://creativecommons.org/licenses/by/4.0/ |
| "CC BY-NC 4.0" / "CC-BY-NC-4.0" | CC-BY-NC-4.0 | https://creativecommons.org/licenses/by-nc/4.0/ |
| "CC BY-SA 4.0" / "CC-BY-SA-4.0" | CC-BY-SA-4.0 | https://creativecommons.org/licenses/by-sa/4.0/ |
| "CC0" / "CC0-1.0" | CC0-1.0 | https://creativecommons.org/publicdomain/zero/1.0/ |
| "PDDL" | PDDL-1.0 | https://opendatacommons.org/licenses/pddl/1-0/ |

## Modality to ResourceType Mapping

| Recording Modality | ResourceType Specific |
|-------------------|-----------------------|
| eeg | EEG Dataset |
| meg | MEG Dataset |
| ieeg | iEEG Dataset |
| emg | EMG Dataset |
| fmri / bold | fMRI Dataset |
| mixed / multiple | Neuroimaging Dataset |
