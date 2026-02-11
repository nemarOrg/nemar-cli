#!/bin/bash
# Mint a reserved DOI on the test shoulder
# Reserved DOIs are not advertised and can be deleted

curl -s -u apitest:ezidapitest2025! -X POST \
  -H 'Content-Type: text/plain' \
  --data-binary $'_target: https://nemar.org/datasets/nm099999\n_status: reserved\n_profile: datacite\ndatacite.creator: Shirazi, Yahya\ndatacite.title: Test NEMAR Dataset\ndatacite.publisher: NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)\ndatacite.publicationyear: 2026\ndatacite.resourcetype: Dataset' \
  https://ezid.cdlib.org/shoulder/doi:10.5072/FK2

# Response: success: doi:10.5072/FK2XXXXXX | ark:/b5072/fk2xxxxxx
