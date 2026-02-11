# DataCite Metadata Schema (Kernel 4) - Complete Field Reference

All 20 properties with their obligation level, description, and XML examples.

## Mandatory Properties

### 1. Identifier
The DOI itself. Set automatically by EZID.
```xml
<identifier identifierType="DOI">10.82901/NEMAR.ABC123</identifier>
```

### 2. Creator
Main researchers involved. Supports ORCID and ROR affiliations.
```xml
<creators>
  <creator>
    <creatorName nameType="Personal">Shirazi, Yahya</creatorName>
    <givenName>Yahya</givenName>
    <familyName>Shirazi</familyName>
    <nameIdentifier nameIdentifierScheme="ORCID" schemeURI="https://orcid.org">0000-0001-2345-6789</nameIdentifier>
    <affiliation affiliationIdentifier="https://ror.org/0168r3w48" affiliationIdentifierScheme="ROR">University of California, San Diego</affiliation>
  </creator>
</creators>
```

### 3. Title
Name of the dataset. Supports subtitle and translated title.
```xml
<titles>
  <title>Healthy Brain Network EEG - Release 1</title>
  <title titleType="Subtitle">A large-scale pediatric EEG dataset</title>
</titles>
```

### 4. Publisher
Always "NEMAR" for our datasets.
```xml
<publisher>NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)</publisher>
```

### 5. PublicationYear
Year when dataset was made publicly available.
```xml
<publicationYear>2026</publicationYear>
```

### 10. ResourceType
General type is "Dataset". Specific type describes the modality.
```xml
<resourceType resourceTypeGeneral="Dataset">EEG Dataset</resourceType>
```

Specific type values for NEMAR: `EEG Dataset`, `MEG Dataset`, `fMRI Dataset`, `EMG Dataset`, `Neuroimaging Dataset`

## Recommended Properties

### 6. Subject
Keywords and classification terms.
```xml
<subjects>
  <subject subjectScheme="keyword">EEG</subject>
  <subject subjectScheme="keyword">electroencephalography</subject>
  <subject subjectScheme="keyword">brain-computer interface</subject>
  <subject subjectScheme="BIDS">task-motorImagery</subject>
</subjects>
```

### 7. Contributor
People/orgs that contributed but are not primary creators.
```xml
<contributors>
  <contributor contributorType="HostingInstitution">
    <contributorName nameType="Organizational">NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)</contributorName>
  </contributor>
  <contributor contributorType="DataCurator">
    <contributorName nameType="Personal">Doe, Jane</contributorName>
    <affiliation>University of California, San Diego</affiliation>
  </contributor>
</contributors>
```

Contributor types: `ContactPerson`, `DataCollector`, `DataCurator`, `DataManager`, `Distributor`, `Editor`, `HostingInstitution`, `Producer`, `ProjectLeader`, `ProjectMember`, `RegistrationAgency`, `RegistrationAuthority`, `RelatedPerson`, `Researcher`, `ResearchGroup`, `RightsHolder`, `Sponsor`, `Supervisor`, `WorkPackageLeader`, `Other`

### 8. Date
Relevant dates for the dataset.
```xml
<dates>
  <date dateType="Created">2026-01-15</date>
  <date dateType="Issued">2026-02-10</date>
  <date dateType="Collected">2024-03-01/2025-06-30</date>
</dates>
```

Date types: `Accepted`, `Available`, `Collected`, `Copyrighted`, `Created`, `Issued`, `Other`, `Submitted`, `Updated`, `Valid`, `Withdrawn`

### 12. RelatedIdentifier
Links to papers, previous versions, related datasets.
```xml
<relatedIdentifiers>
  <relatedIdentifier relatedIdentifierType="DOI" relationType="IsSupplementTo">10.1234/paper.2024.001</relatedIdentifier>
  <relatedIdentifier relatedIdentifierType="DOI" relationType="IsNewVersionOf">10.82901/NEMAR.PREV123</relatedIdentifier>
  <relatedIdentifier relatedIdentifierType="URL" relationType="IsDescribedBy">https://nemar.org/docs/dataset-name</relatedIdentifier>
</relatedIdentifiers>
```

Relation types: `IsCitedBy`, `Cites`, `IsSupplementTo`, `IsSupplementedBy`, `IsContinuedBy`, `Continues`, `IsDescribedBy`, `Describes`, `HasMetadata`, `IsMetadataFor`, `HasVersion`, `IsVersionOf`, `IsNewVersionOf`, `IsPreviousVersionOf`, `IsPartOf`, `HasPart`, `IsReferencedBy`, `References`, `IsDocumentedBy`, `Documents`, `IsCompiledBy`, `Compiles`, `IsVariantFormOf`, `IsOriginalFormOf`, `IsIdenticalTo`, `IsReviewedBy`, `Reviews`, `IsDerivedFrom`, `IsSourceOf`, `IsRequiredBy`, `Requires`, `IsObsoletedBy`, `Obsoletes`

### 17. Description
Abstract, methods, or other descriptive text.
```xml
<descriptions>
  <description descriptionType="Abstract">This dataset contains 64-channel EEG recordings from 50 participants performing motor imagery tasks. Data is formatted in Brain Imaging Data Structure (BIDS) format.</description>
  <description descriptionType="Methods">EEG recorded using BioSemi ActiveTwo at 512 Hz. Tasks included left/right hand motor imagery with visual cues.</description>
</descriptions>
```

Description types: `Abstract`, `Methods`, `SeriesInformation`, `TableOfContents`, `TechnicalInfo`, `Other`

### 18. GeoLocation
Where the data was collected.
```xml
<geoLocations>
  <geoLocation>
    <geoLocationPlace>University of California, San Diego</geoLocationPlace>
  </geoLocation>
</geoLocations>
```

## Optional Properties

### 9. Language
```xml
<language>en</language>
```

### 11. AlternateIdentifier
Other identifiers for this dataset (NEMAR ID, OpenNeuro ID, etc.).
```xml
<alternateIdentifiers>
  <alternateIdentifier alternateIdentifierType="NEMAR">nm000103</alternateIdentifier>
  <alternateIdentifier alternateIdentifierType="OpenNeuro">ds005505</alternateIdentifier>
</alternateIdentifiers>
```

### 13. Size
```xml
<sizes>
  <size>1.2 GB</size>
  <size>50 subjects</size>
  <size>64 EEG channels</size>
</sizes>
```

### 14. Format
```xml
<formats>
  <format>application/x-edf</format>
  <format>application/json</format>
  <format>text/tab-separated-values</format>
</formats>
```

Common NEMAR formats: `application/x-edf` (EDF), `application/x-bdf` (BDF), `application/x-fif` (FIF/MNE), `application/x-set` (EEGLAB), `text/tab-separated-values` (TSV), `application/json` (JSON sidecars)

### 15. Version
```xml
<version>1.0.0</version>
```

### 16. Rights
```xml
<rightsList>
  <rights rightsURI="https://creativecommons.org/licenses/by/4.0/" rightsIdentifier="CC-BY-4.0" rightsIdentifierScheme="SPDX">Creative Commons Attribution 4.0 International</rights>
</rightsList>
```

Common licenses:
| SPDX ID | URI | Name |
|---------|-----|------|
| CC-BY-4.0 | https://creativecommons.org/licenses/by/4.0/ | CC Attribution 4.0 |
| CC-BY-NC-4.0 | https://creativecommons.org/licenses/by-nc/4.0/ | CC Attribution-NonCommercial 4.0 |
| CC-BY-SA-4.0 | https://creativecommons.org/licenses/by-sa/4.0/ | CC Attribution-ShareAlike 4.0 |
| CC0-1.0 | https://creativecommons.org/publicdomain/zero/1.0/ | CC Zero 1.0 |

### 19. FundingReference
```xml
<fundingReferences>
  <fundingReference>
    <funderName>National Institutes of Health</funderName>
    <funderIdentifier funderIdentifierType="Crossref Funder ID">https://doi.org/10.13039/100000002</funderIdentifier>
    <awardNumber>R01-NS12345</awardNumber>
    <awardTitle>Brain-Computer Interface Research</awardTitle>
  </fundingReference>
</fundingReferences>
```

### 20. RelatedItem
Full bibliographic metadata for related publications (when DOI is not available).
```xml
<relatedItems>
  <relatedItem relationType="IsDescribedBy" relatedItemType="JournalArticle">
    <relatedItemIdentifier relatedItemIdentifierType="DOI">10.1234/journal.2024</relatedItemIdentifier>
    <titles><title>Description of the dataset</title></titles>
    <creators><creator><creatorName>Smith, John</creatorName></creator></creators>
    <publicationYear>2024</publicationYear>
  </relatedItem>
</relatedItems>
```
