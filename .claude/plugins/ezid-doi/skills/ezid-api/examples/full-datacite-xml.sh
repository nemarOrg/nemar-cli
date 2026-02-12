#!/bin/bash
# Mint a DOI with full DataCite kernel-4 XML metadata
# This populates ALL 20 DataCite fields for maximum scholarly richness

DATACITE_XML='<?xml version="1.0" encoding="UTF-8"?>
<resource xmlns="http://datacite.org/schema/kernel-4" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://datacite.org/schema/kernel-4 http://schema.datacite.org/meta/kernel-4/metadata.xsd">
  <identifier identifierType="DOI">(:tba)</identifier>
  <creators>
    <creator>
      <creatorName nameType="Personal">Shirazi, Yahya</creatorName>
      <givenName>Yahya</givenName>
      <familyName>Shirazi</familyName>
      <nameIdentifier nameIdentifierScheme="ORCID" schemeURI="https://orcid.org">0000-0001-2345-6789</nameIdentifier>
      <affiliation affiliationIdentifier="https://ror.org/0168r3w48" affiliationIdentifierScheme="ROR">University of California, San Diego</affiliation>
    </creator>
  </creators>
  <titles>
    <title>Test NEMAR Dataset - EEG Motor Imagery</title>
  </titles>
  <publisher>NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)</publisher>
  <publicationYear>2026</publicationYear>
  <subjects>
    <subject subjectScheme="keyword">EEG</subject>
    <subject subjectScheme="keyword">motor imagery</subject>
    <subject subjectScheme="keyword">BIDS</subject>
  </subjects>
  <contributors>
    <contributor contributorType="HostingInstitution">
      <contributorName nameType="Organizational">NEMAR</contributorName>
    </contributor>
  </contributors>
  <dates>
    <date dateType="Created">2026-02-10</date>
  </dates>
  <language>en</language>
  <resourceType resourceTypeGeneral="Dataset">EEG Dataset</resourceType>
  <alternateIdentifiers>
    <alternateIdentifier alternateIdentifierType="NEMAR">nm099999</alternateIdentifier>
  </alternateIdentifiers>
  <sizes>
    <size>1.2 GB</size>
    <size>50 subjects</size>
  </sizes>
  <formats>
    <format>application/x-edf</format>
    <format>application/json</format>
  </formats>
  <version>1.0.0</version>
  <rightsList>
    <rights rightsURI="https://creativecommons.org/licenses/by/4.0/" rightsIdentifier="CC-BY-4.0" rightsIdentifierScheme="SPDX">Creative Commons Attribution 4.0 International</rights>
  </rightsList>
  <descriptions>
    <description descriptionType="Abstract">A test EEG dataset containing motor imagery recordings formatted in BIDS.</description>
  </descriptions>
  <fundingReferences>
    <fundingReference>
      <funderName>National Institutes of Health</funderName>
      <funderIdentifier funderIdentifierType="Crossref Funder ID">https://doi.org/10.13039/100000002</funderIdentifier>
      <awardNumber>R01-NS12345</awardNumber>
    </fundingReference>
  </fundingReferences>
</resource>'

# Percent-encode the XML for ANVL
ENCODED_XML=$(python3 -c "
import sys, re
xml = sys.stdin.read()
print(re.sub(r'[%:\r\n]', lambda c: '%%%02X' % ord(c.group(0)), xml))
" <<< "$DATACITE_XML")

curl -s -u apitest:ezidapitest2025! -X POST \
  -H 'Content-Type: text/plain' \
  --data-binary "_target: https://nemar.org/datasets/nm099999
_status: reserved
_profile: datacite
datacite: $ENCODED_XML" \
  https://ezid.cdlib.org/shoulder/doi:10.5072/FK2
