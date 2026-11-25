# D2: what holds each queued request

Measured 2026-11-25 by `scripts/dev/measure-queue-blockers.ts` over 363 requests.
The path set is the screen's own: every path in HEAD plus every path in history (`git log --all`, git-annex branches excluded), with `scanPaths` and `formatCoverage` applied unchanged.
Only paths were read (blob-less clones, deleted after use); no file content, and no file name appears below.
Findings that need file content (EDF headers, participants tables, JSON keys, text files) are outside this measurement, so a blocker set here is the path-derived part of what the screen reports, plus the unscreened formats.

## Coverage and cross-check

| measure | value |
| --- | --- |
| requests in the queue file | 363 |
| read (HEAD and history) | 361 |
| unreadable (listed below, never counted as free) | 2 |
| requests with an image or document finding | 275 |
| expected from the screen (a7 list) | 229 |
| image finding, status requested | 245 |
| image finding, status blocked | 30 |
| with only the image kind among path findings | 271 |
| same, restricted to the a7 list (screen measured 196) | 225 |
| same, blocked requests | 30 |
| with only the image kind, and no unscreened format | 1 |
| peak single clone on disk (KiB) | 34280 |

Image-finding count versus the screen's 229: 275 measured (difference 46).
Present here and not in the a7 list: 46 (30 blocked, 16 requested).
In the a7 list and not measured here: none.

Reading the difference:

- The a7 list is a subset of what is measured here, so no screen finding is missed by the path rebuild.
- Blocked requests are not screened, and 30 of them have an image path, which accounts for 30 of the surplus.
- 16 requested requests have an image path and are not in the a7 list: nm000649, nm000683, nm000788, nm000815, nm000871, nm000878, nm000883, nm000889, nm000893, nm000901, nm000917, nm000923, nm000931, nm000937, nm000957, nm000969.
  This script reads paths only, so it cannot say whether a screen record exists for them; the likely cause is no screen record when the a7 list was made.
- The screen's "only image findings" figure (196) counts image findings among ALL kinds, content kinds included (EDF headers, participants tables, JSON keys, text files); this measurement sees path kinds only, so its count restricted to the a7 list (225) is an upper bound on it, and the gap is requests whose other findings are content kinds.

Unreadable requests:

| id | error |
| --- | --- |
| nm000589 | empty repository: HEAD has no commit |
| nm000978 | empty repository: HEAD has no commit |

## Blocker kinds across the queue

| finding kind | requests | in HEAD only | in HEAD and history | history only |
| --- | --- | --- | --- | --- |
| image-or-document-file | 275 | 0 | 272 | 4 |
| tooling-debris | 5 | 0 | 5 | 0 |
| path-subject-label | 1 | 0 | 1 | 0 |

Name-like subject labels: 2901 paths carry one (counted, never shown).

| unscreened format (HEAD) | requests |
| --- | --- |
| .snirf | 248 |
| .zip | 150 |
| .mat | 119 |
| .eeg | 97 |
| .vhdr | 97 |
| .vmrk | 97 |
| (no extension) | 73 |
| (unusual extension) | 44 |
| .nirs | 26 |
| .hdr | 23 |
| .wl1 | 21 |
| .wl2 | 21 |
| .tri | 15 |
| .set | 13 |
| .dat | 12 |
| .nii | 10 |
| .nii.gz | 10 |
| .tsv.gz | 8 |
| .fig | 8 |
| .tpl | 8 |
| .fif | 8 |
| .rar | 8 |
| .inf | 7 |
| .evt | 7 |
| .tif | 7 |
| .npy | 6 |
| .eps | 5 |
| .avg | 5 |
| .sav | 5 |
| .h | 4 |

166 further formats, each held by one or two requests, are in the JSON; an extension that is not a plausible format word is counted as `(unusual extension)`.

### Blocker-set shapes

| path findings | unscreened formats | requested | blocked |
| --- | --- | --- | --- |
| image-or-document-file | yes | 240 | 30 |
| none | yes | 72 | 7 |
| none | no | 4 | 1 |
| image-or-document-file + tooling-debris | yes | 4 | 0 |
| image-or-document-file | no | 1 | 0 |
| path-subject-label | yes | 1 | 0 |
| tooling-debris | yes | 1 | 0 |

Requests with an empty blocker set now: 5; with unscreened formats only: 79.

## Image and document groups

Files are counted over HEAD plus history paths; requests are the distinct requests holding at least one.

### By location

| location | files | requests |
| --- | --- | --- |
| code | 735 | 245 |
| sourcedata | 6147 | 182 |
| derivatives | 28 | 1 |
| stimuli | 1 | 1 |
| root | 1 | 1 |

### By extension class

| extension class | files | requests |
| --- | --- | --- |
| raster-image | 5386 | 263 |
| pdf | 765 | 139 |
| office-document | 761 | 72 |

### By extension

| extension | files | requests |
| --- | --- | --- |
| png | 2498 | 258 |
| pdf | 765 | 139 |
| xlsx | 695 | 60 |
| docx | 26 | 19 |
| jpg | 1258 | 16 |
| rtf | 10 | 8 |
| tif | 1537 | 7 |
| xls | 15 | 6 |
| tiff | 76 | 2 |
| pptx | 6 | 2 |
| ppt | 6 | 2 |
| jpeg | 4 | 2 |
| bmp | 9 | 1 |
| gif | 4 | 1 |
| doc | 3 | 1 |

### By name class

| name class | files | requests |
| --- | --- | --- |
| other | 6835 | 274 |
| figure | 34 | 5 |
| montage-layout-cap | 8 | 4 |
| questionnaire | 4 | 4 |
| photo-face | 23 | 2 |
| manual | 6 | 2 |
| logo | 2 | 2 |

### By presence

| presence | files | requests |
| --- | --- | --- |
| both | 6908 | 272 |
| history-only | 4 | 4 |

### Files by location and name class

| location | consent | questionnaire | form | photo-face | figure | logo | manual | montage-layout-cap | screenshot | other |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| root | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| sourcedata | 0 | 4 | 0 | 23 | 34 | 2 | 6 | 8 | 0 | 6070 |
| stimuli | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| derivatives | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 28 |
| code | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 735 |

## Unread formats with no extension or `.other`

Parent directory patterns (digit runs as `#`, `sub-` and `ses-` labels folded) of the HEAD files that `formatCoverage` counts under `(no extension)` or `.other`, most files first.
A pattern held by a single request is not printed (231 such patterns), and 0 files under a name-like subject label are counted and withheld.

| pattern | files | requests |
| --- | --- | --- |
| `(no extension) sourcedata/openneuro_ds#/.datalad` | 26 | 26 |
| `(no extension) sourcedata/psycharchives_#.#_psycharchives.#` | 7 | 7 |
| `(no extension) sourcedata/figshare_#` | 5 | 5 |
| `(no extension) sourcedata/zenodo_#` | 4 | 4 |
| `(no extension) sourcedata/#tu_#` | 2 | 2 |
| `(no extension) sourcedata/nitrc_nitrc_#_resting_state_#` | 2 | 2 |
| `(no extension) sourcedata/unipd_#.#_researchdata.cab.unipd.it.#` | 2 | 2 |
| `(no extension) sourcedata/sciencedb_#.#_sciencedb.#` | 2 | 2 |

## The blocked requests

40 requests are blocked.

| block_reason | requests |
| --- | --- |
| min_requirements_failed | 37 |
| bids_validation_pending | 2 |
| bids_validation_in_progress | 1 |

| min_requirements_failed reason code | requests |
| --- | --- |
| ethics_statement_missing | 37 |
| name_too_short | 1 |

37 of the blocked requests would also hold at least one measured blocker once unblocked (30 a path finding, the rest unscreened formats only).

## What if: acknowledge a group

For each candidate group, the requests whose blocker set shrinks, would be empty, or would hold unread formats only.
An image blocker is lifted only when EVERY flagged image or document in that request belongs to the group.

| group | blocker lifted | empty after | unread formats only after |
| --- | --- | --- | --- |
| ext:raster-image: images and documents, raster-image | 104 | 6 | 179 |
| ext:pdf: images and documents, pdf | 3 | 5 | 82 |
| ext:office-document: images and documents, office-document | 7 | 5 | 86 |
| loc:root: images and documents under root | 0 | 5 | 79 |
| loc:sourcedata: images and documents under sourcedata | 28 | 6 | 105 |
| loc:stimuli: images and documents under stimuli | 0 | 5 | 79 |
| loc:derivatives: images and documents under derivatives | 1 | 5 | 80 |
| loc:code: images and documents under code | 91 | 5 | 167 |
| loc:docs: images and documents under docs | 0 | 5 | 79 |
| loc:sub-*: images and documents under sub-* | 0 | 5 | 79 |
| loc:other: images and documents under other | 0 | 5 | 79 |
| name:consent: images and documents named consent | 0 | 5 | 79 |
| name:questionnaire: images and documents named questionnaire | 0 | 5 | 79 |
| name:form: images and documents named form | 0 | 5 | 79 |
| name:photo-face: images and documents named photo-face | 0 | 5 | 79 |
| name:figure: images and documents named figure | 1 | 5 | 80 |
| name:logo: images and documents named logo | 0 | 5 | 79 |
| name:manual: images and documents named manual | 0 | 5 | 79 |
| name:montage-layout-cap: images and documents named montage-layout-cap | 0 | 5 | 79 |
| name:screenshot: images and documents named screenshot | 0 | 5 | 79 |
| name:other: images and documents named other | 259 | 6 | 334 |
| presence:history-only: images and documents only in history | 3 | 5 | 82 |
| combo:no-person-names: all except consent, questionnaire, form, photo or face names | 269 | 6 | 344 |
| combo:no-person-names-no-sub: all except person-like names and everything under sub-* | 269 | 6 | 344 |
| combo:figures-and-tooling: figure, logo, manual, montage, screenshot names outside sub-* | 1 | 5 | 80 |
| all-images: every image and document | 275 | 6 | 349 |
| kind:tooling-debris: tooling debris paths | 5 | 5 | 80 |
| kind:path-subject-label: name-like subject labels | 1 | 5 | 80 |
| all-path-findings: every path finding (images, debris, labels) | 277 | 6 | 355 |

Baseline: 5 empty, 79 unread formats only (of 361 read).
Percent of the read queue with an image finding: 76%.

Datasets measured: 363.
