# Import Source Research: BIDS EEG/iEEG/MEG/EMG/Motion Archives Beyond OpenNeuro

> **Related decision:** [ADR 0013 - The importer stays in nemar-cli](decisions/0013-the-importer-stays-in-nemar-cli-with-registry-plus-family-adapters.md).

**Date:** 2026-07-23
**Scope:** Grant-funded expansion of NEMAR imports beyond OpenNeuro. 12 parallel research passes (EEG/iEEG, MEG, EMG/motion-capture, general-purpose repos, Germany/NL/Nordics, UK/Ireland, France/Benelux/CH/IT/ES, EU meta-infrastructure, Japan, China, Korea/Taiwan/Singapore/HK, BCI-competition/pan-Asian) covering roughly 90 named archives/datasets.

## Executive summary

1. **Discovery isn't the bottleneck — redistribution rights are.** BIDS-shaped or BIDS-native EEG/iEEG/MEG/EMG/motion datasets exist well beyond OpenNeuro, in real volume. The recurring blocker is that the highest-value cohorts explicitly prohibit rehosting in their Data Use Agreements (Cam-CAN, OMEGA, HCP-MEG, NatMEG-PD, RAM, NSRR, most PhysioNet-credentialed sets). These need a negotiated data-sharing agreement with the source institution before any mirroring — not an automated pipeline.
2. **No non-OpenNeuro archive actually *enforces* BIDS validation on ingest.** "BIDS-native" everywhere in this research means a depositor voluntarily organized their data that way, not that the host validated it. Even neuro-savvy hosts (EBRAINS KG, GIN, Radboud/DCCN, ScienceDB) don't gate deposits on `bids-validator` passing. This confirms the framing in the request: NEMAR's in-house validator (`src/lib/bids-validator.ts`) is the load-bearing path for essentially every new source, not the exception, PhysioNet included.
3. **Clearest "just mirror it" wins** (BIDS-native/shaped + permissive open license + no account/DUA gate): **TDBRAIN**, **WAND** (CUBRIC Cardiff, CC-BY 4.0), **CeTI-Locomotion / CeTI-Age-Kinematics** (TU Dresden, Motion-BIDS), **EEGManyLabs** (GIN-hosted replication consortium, §7), and several **ScienceDB/ChineseNeuro Symphony (CHNNeuro)** EEG-BIDS sets (ChineseEEG, ChineseEEG-2, EmoEEG-MC — some already dual-hosted on OpenNeuro). *(Correction 2026-07-24: ERP CORE and HBN-EEG are already imported into NEMAR — confirmed by NEMAR team, not new targets. See §7 for the EEGDash finding that surfaced EEGManyLabs.)*
4. **General-purpose repos are worth a standing automated crawl for BIDS-tagged deposits**, in this priority order: **Zenodo** (`keywords:"BIDS"` REST API — highest yield, ~144 hits), **G-Node GIN** (`doi.gin.g-node.org/keywords/bids/` — small but zero-noise), **Figshare** (`:tag:BIDS` API) and **OSF** (API search) as secondary, **EBRAINS KG** and **Mendeley Data** as periodic manual spot-checks, **Dryad** as an occasional full-text sweep (CC0-guaranteed when found).
5. **Regional pattern (Europe/Asia, per your specific interest):** no country outside the US/Canada has an OpenNeuro-equivalent national BIDS archive. Europe's strongest institutional plays are **Radboud/DCCN** (Netherlands, MEG-heavy, BIDS-native), **BeMoBIL** (Berlin, EEG+motion-capture, BIDS motion-extension co-authors), **CUBRIC/WAND** (Wales), and **EBRAINS HIP** (France/Switzerland iEEG consortium, BIDS-native but governed access). Asia's strongest plays are **RIKEN CBS** (Japan, BIDS-native institutional repo) and **ScienceDB/CHNNeuro** (China, several BIDS-native EEG datasets, English UI, open). Korea/Taiwan/Singapore/HK yielded individually-open GigaDB datasets (Korea University, GIST) but no BIDS-native national archive.

## How to read the tables

- **BIDS status**: `native` = depositor built it as BIDS; `shaped` = organized by subject/session but not full BIDS; `raw` = needs conversion.
- **Access**: `open` = no account needed; `DUA/gated` = registration + data-use agreement, per-dataset approval, or credentialing.
- **Verdict** encodes both scientific value and practical import friction — a good dataset with a hard redistribution clause is still marked accordingly.

---

## 1. Specialty EEG / iEEG archives

| Archive | Modalities / Scale | BIDS Status | Access | License / Redistribution | Verdict |
|---|---|---|---|---|---|
| **PhysioNet** (CHB-MIT, Sleep-EDF(x), EEG Motor Movement/Imagery, Siena, NCH Sleep DataBank, etc.) | EEG, dozens of datasets | Raw/shaped, not BIDS-native | Mixed: open (ODC-BY) vs. **PhysioNet Credentialed Health Data License** (per-dataset DUA) | Per-dataset — open ones redistribution-friendly w/ attribution, credentialed ones restrict rehosting | Good for the open-licensed subset; the exact case the request called out — in-house validation required |
| **Temple University Hospital EEG Corpus** (TUEG/TUAB/TUEP/TUSZ, via NEDC) | EEG, clinical, TUEG >30,000 records | Raw EDF, not BIDS | DUA-gated (TUSZ reportedly "unencumbered," no DUA) | Unconfirmed for non-TUSZ subsets — verify with NEDC | Largest scale gain if converted; license needs per-corpus confirmation |
| **National Sleep Research Resource (NSRR)** | EEG/PSG, many cohorts, thousands of subjects | Raw EDF, not BIDS | Free but request-approval gated | Redistribution likely blocked by per-cohort informed-consent language | Attractive scale, but needs per-cohort clearance, not a blanket import |
| **ieeg.org / IEEG Portal** (Litt Lab, UPenn) | iEEG, >1,200 datasets | Not BIDS-native (proprietary portal format) | DUA + per-dataset owner-controlled visibility | No blanket redistribution right — owner consent required per dataset | High value for epilepsy/iEEG, fragmented and owner-gated |
| **TDBRAIN** (Brainclinics Foundation) | EEG, clinical/psychiatric, 1,274 patients | **BIDS-native** | Registration but broadly available | **CC BY 4.0** | Strong candidate — already BIDS + permissive license |
| **ERP CORE** (Luck Lab, UC Davis) | EEG (ERP), 40 participants | BIDS-compatible export available | Fully open | **CC BY-SA 4.0** | **Already imported into NEMAR** (confirmed 2026-07-24) — not a new target |
| **HBN-EEG** (Child Mind Institute) | EEG, >3,000 participants (5–21y) | Already BIDS | Open S3, some subsets restricted | CC BY 4.0 (one release variant NC) | **Already imported into NEMAR** (confirmed 2026-07-24) — check only for un-mirrored newer releases |
| **EEGManyLabs** (collaborative EEG replication consortium, hosted on GIN) | EEG, one dataset per published replication study (raw + processed variants) | **BIDS-native by construction** — repos named `EEGManyLabs_Replication_AuthorYear_[Raw\|Processed]`, include `dataset_description.json`, `participants.tsv`, README with paper/OSF links | Fully open, no auth (public GIN org) | Per-repo license/authors/funding recorded in BIDS metadata — verify per repo | **New candidate (surfaced via EEGDash, §7)** — good fit, BIDS-native and open by construction |
| **RAM (Restoring Active Memory)**, UPenn | iEEG, 251 patients, >1,100 sessions | Raw/proprietary, not BIDS | Free, request-based | No explicit open redistribution license found — confirm with UPenn | High value, high conversion + licensing effort |
| **EBRAINS Human Intracerebral EEG Platform (HIP)** | iEEG/SEEG, EU multi-center | Mixed, BIDS Manager built in | EBRAINS registration, per-dataset permissions | Per-dataset, no blanket license | Good iEEG target, verify per dataset |
| **DANDI Archive** | Some iEEG/ECoG dandisets, EEG/MEG rare | NWB, not BIDS | Fully open | Per-dandiset (often CC0/CC-BY) | Low density for these modalities |
| **G-Node GIN** | Individually-deposited EEG/iEEG datasets | Ad hoc, not BIDS-curated | Fully open | Per-dataset, mostly CC-BY/CC0 | Long-tail source of small open datasets |
| **Human Connectome Project** (MEG, listed here as cross-reference) | MEG, twin-pair subset | Not BIDS-native | HCP Data Use Terms | Redistribution explicitly gated | Heaviest legal lift on this list |
| **Zenodo** (as EEG discovery channel) | Scattered individual EEG/ECoG datasets | Case-by-case | Fully open | Per-record (CC0/CC-BY common) | Discovery channel, not a bulk partner — see §4 |
| **EEGBase / EEG-ERP Portal** (Czech) | EEG/ERP, small Czech-origin studies | Not BIDS | Free but registration + "cart" workflow | Not uniformly documented | Low priority, illustrates access-friction pattern |

## 2. MEG archives

| Archive | Scale | BIDS Status | Access | License / Redistribution | Verdict |
|---|---|---|---|---|---|
| **OMEGA** (McGill/MNI) | 644 participants, ~1,800 sessions | **BIDS-native** | DUA + institutional email + ethics approval | DUA explicitly **bars redistribution** | Good data, hard blocker without new agreement |
| **Cam-CAN** (Cambridge) | 647 subjects, lifespan MEG+MRI | Raw FIF, not BIDS out of the box | Proposal-gated, per-request | DUA: "will not further disclose" — no redistribution | High value, needs institutional agreement |
| **HCP MEG** | ~95-100 subjects | Raw 4D-BTi, converters exist | ConnectomeDB account, Open/Restricted tiers | Open Access terms don't permit public redistribution | Hardest legally of the group |
| **MOUS** (Radboud/DCCN) | 204 subjects, MEG+fMRI+behavior | **Already BIDS** | DUA for potentially identifying data | Unconfirmed redistribution clause — flag for direct confirmation | Best format fit; prioritize licensing conversation |
| **Radboud Data Repository (general)** | Many DCCN collections | Mixed, many BIDS-shaped | Tiered (open / institutional credentials) | Per-collection DUA | Source of sources — worth periodic crawl |
| **MEG UK Database** (8-center consortium) | ~500+ subjects | Unconfirmed | Undocumented, contact curator directly | Unknown | Promising but immature publicly — needs direct outreach |
| **WAND** (CUBRIC Cardiff, on GIN) | 170 subjects, MEG+MRI+TMS | **BIDS-native** | Open download, no gating found | **CC-BY 4.0** | Best mirroring candidate found in this pass |
| **LibriBrain** (Oxford PNPL, Hugging Face) | 1 subject, 50+ hrs | Raw/HF-native | Fully open | **CC-BY-NC 4.0** | NC clause needs legal review |
| **EBRAINS/HBP KG** (MEG slice) | Aggregator, low MEG density so far | Mixed | Tiered | Per-dataset | Worth a targeted MEG-filtered follow-up |
| **BrainSignals.de** (legacy competition index) | Small legacy sets (ICANN 2011, BIOMAG 2010) | Pre-BIDS era | Mostly open | Unspecified | Historical/benchmark interest only |

## 3. EMG & motion-capture archives

| Archive | Modality / Scale | BIDS Status | Access | License / Redistribution | Verdict |
|---|---|---|---|---|---|
| **Ninapro** (HES-SO) | EMG+kinematic+IMU, >180 acquisitions | Raw, subject/session-structured | Open, no registration seen | Citation requested, no formal license text found — confirm | Largest EMG+kinematic corpus, license needs direct confirmation |
| **PhysioNet — sEMG long-lasting gait** | EMG+footswitch, 31 subjects | Raw WFDB | Fully open | **ODC-By** | Good small pilot, clear license |
| **GaitRec / Gutenberg Gait Database** | Ground reaction force (not EMG/kinematics) | Non-BIDS | Open (Figshare) | Likely CC-BY, unconfirmed on data items | Marginal fit — GRF only, lower priority |
| **CMU Graphics Lab Motion Capture DB** | Marker mocap, ~144 subjects | Non-BIDS proprietary, convertible | Open (site had intermittent outage) | Reported public-domain-like, unverified live | Good conversion-pipeline test data, verify license live |
| **UCI ML Repository EMG sets** | Small EMG sets | Non-BIDS flat CSV | Open | Per-dataset, unclear | Low priority — toy scale |
| **IEEE DataPort EMG** (GRABMyo, Dual-HGR, etc.) | EMG (+IMU) gesture sets | Non-BIDS | Subscription-gated for full downloads | CC-BY floor, per-dataset disclaimer | Moderate — subscription + license ambiguity |
| **putEMG** (Poznan) | sEMG+video, 44 subjects | Non-BIDS, shaped | Open direct download | **CC BY-NC 4.0** | NC clause blocks redistribution — legal review needed |
| **CeTI-Locomotion / CeTI-Age-Kinematics** (TU Dresden, Figshare) | Full-body IMU mocap, 50+ subjects | **BIDS-native (Motion-BIDS)** | Open | Figshare license file included (verify CC-BY vs other) | **Top candidate** — genuinely Motion-BIDS-native |
| **"Dual System Validation" motion dataset** (OSF, Motion-BIDS reference) | IMU+optical mocap, 167 subjects (incl. clinical) | **Motion-BIDS-native** (reference dataset) | OSF-hosted, likely open | Unconfirmed — check OSF license tab | Strong candidate, large clinical cohort |
| **fNIRS-Gait dataset** (Radboud, Motion-BIDS reference) | IMU mocap + fNIRS, 44 subjects (PD+controls) | **Motion-BIDS-native** | Radboud Data Repository | Unconfirmed | Good candidate, clinical population |

## 4. General-purpose repositories (BIDS-crawl targets)

| Repository | Evidence of BIDS deposits | Search mechanism | License | Verdict |
|---|---|---|---|---|
| **Zenodo** | 144 hits for `keywords:"BIDS"` (30 tagged datasets); concrete EEG/multimodal examples found | `zenodo.org/api/records/?q=keywords:"BIDS"` — clean, paginated, machine-crawlable | Per-deposit (CC-BY-4.0 common, CC0 too) | **Build a crawler — highest yield** |
| **G-Node GIN** | Keyword page lists BIDS-tagged datasets (small curated set; true count likely higher) | `doi.gin.g-node.org/keywords/bids/` | Per-repo (CC-BY/CC0 common) | **Build a crawler — small, zero-noise** |
| **Figshare** | MEG_BIDS dataset, BIDS Manager-Pipeline dataset, others | API `:tag:BIDS` + `item_type:dataset` | Per-article, CC-BY default | Worth periodic API search |
| **OSF** | Historic EEG-BIDS spec examples live here (Matching Pennies, Rishikesh); BIDS-EEG/iEEG spec dev material | UI is JS SPA — need `api.osf.io/v2/search`, not scraping | Per-project (CC0/CC-BY/none) | Worth crawling via API, expect noise |
| **EBRAINS Knowledge Graph** | Confirmed BIDS-compliant multimodal EEG-fMRI hits | Free-text search only confirmed; facet unverified | Per-dataset terms of use | Periodic free-text search |
| **Mendeley Data** | One explicit BIDS EEG-fMRI case; most EEG deposits are non-BIDS | Basic full-text search only | CC-BY 4.0 default | Low-moderate priority |
| **Dryad** | One explicit BIDS N400 ERP dataset | Full-text search only | **All content CC0** | Occasional sweep — trivially safe when found |
| **DANDI** | BIDS required for MRI/microscopy modalities, not EEG/iEEG/MEG/EMG | Faceted dandiset search, no BIDS facet | CC0 default | Not a priority for NEMAR's target modalities |
| **NIMH Data Archive (NDA)** | Supports BIDS submission via converter tooling but reshapes into own schema on ingest | Own query/data-dictionary model, not BIDS tags | Heavily DUC/DAC-gated | Not a crawl target — gated, reshaped |
| **UK Data Service / ReShare** | No confirmed BIDS deposits found | Generic keyword search | Registration-gated even for open items | Not worth crawling |
| **Harvard Dataverse / installs** | Weak evidence; HEEDB (280k+ clinical EEGs, BIDS v1.7.0) lives on BDSP/PhysioNet/AWS instead | Dataverse facets exist, low hit rate observed | Varies, HEEDB gated/DUA | Low priority for Dataverse itself; HEEDB worth one-off outreach |

## 5. Europe — regional deep dive

### 5a. Germany, Netherlands, Nordics

| Source | Notes | BIDS | Access/License | Verdict |
|---|---|---|---|---|
| **Radboud Data Repository / Donders-DCCN** | ~873 published collections; flagship MOUS (204 subj, MEG+fMRI) | Native (founding BIDS adopter, FieldTrip origin) | Mixed open/DUA-tiered | **Strong candidate** |
| **BeMoBIL** (Charité/TU Berlin) | 160-ch EEG + full-body mocap + VR | **BIDS-native**, co-authors of Motion-BIDS extension | Per-dataset, typically CC-BY | **Strong candidate** — exact EEG+motion-capture profile NEMAR wants |
| **NatMEG** (Karolinska/Stockholm, via SND) | Flagship NatMEG-PD, 66 PD + 68 controls, MEG+EMG+MRI | Explicitly BIDS-arranged | Gated via **EBRAINS Human Data Gateway** DUA | Good quality, access-gated |
| **MPI-CBS Leipzig (LEMON)** | 228 subj EEG+MRI | BIDS-shaped | Already on OpenNeuro (ds000221) | No incremental value — already in pipeline |
| **G-Node/GIN (German node)** | 107 "electrophysiology"-tagged datasets, mostly animal/invasive | Not BIDS-native | Fully open | Moderate — good in-house-validator target, vet per dataset |
| **NFDI-Neuro** | German national RDM consortium | N/A — not yet a data host | N/A | Not a source today, re-check as it matures |
| **DANS, 4TU, SND, Sikt, DeiC Dataverse, Fairdata/IDA** | Generic national Dataverse/archive infra | No confirmed E/M/EG collections surfaced | Per-dataset | Low/unsure — would need targeted in-portal search |

### 5b. UK & Ireland

| Source | Notes | BIDS | Access/License | Verdict |
|---|---|---|---|---|
| **CUBRIC (WAND)**, Cardiff | 170 subj MEG+MRI+TMS, on GIN | **BIDS-native** | Open, no gating | **Strong candidate**, highest-priority UK find |
| **Cam-CAN** | 647 subj lifespan MEG | BIDS (per-modality repos) | Proposal-gated DUA, no redistribution beyond team, must stay on institutional server | High value, blocked without new agreement |
| **MEG UKI Database** (10-site consortium incl. Ulster) | ~500 subjects | Unconfirmed | Contact curator directly | Worth direct outreach |
| **Oxford OHBA, Aston Brain Centre** | Active MEG capacity | Unclear at institutional level | No public data portal found | Individual-dataset outreach only |
| **UCL/Wellcome Centre (FIL)** | Flagship Wakeman & Henson dataset | Already BIDS via OpenNeuro (ds000117) | Open, CC0 | Not a new source — already in pipeline |
| **UK Biobank** | MRI-only, confirmed no EEG/MEG | N/A | N/A | Not applicable |
| **TCIN Dublin** | New OPM-MEG system (2025/26), no repository yet | N/A | Unknown | Watch-list for future outreach |
| **UK Data Service/ReShare** | Incidental EEG deposits among thousands of social-science collections | Not BIDS | Registration-gated, per-collection license | Low priority, one-off keyword sweep only |

### 5c. France, Belgium, Switzerland, Italy, Spain

No country here has a national BIDS-native archive; practical path is direct lab outreach more than portal-harvesting.

| Source | Notes | BIDS | Access/License | Verdict |
|---|---|---|---|---|
| **EBRAINS HIP** (Human Intracerebral EEG Platform; CHUV Lausanne + Grenoble/Lyon/Marseille) | iEEG, 70+ contributing clinical centers, e.g. published 38-patient multi-center BIDS iEEG set | **BIDS-native** (BIDSManager built in) | Registration, tiered governed workspaces | High value, medium friction — partnership target |
| **Recherche Data Gouv** (France, national Dataverse) | Mixed EEG deposits (Grenoble Alpes, Lille, neonatal EEG, BCI EEG+MEG) | Some explicit "EEG BIDS," others raw | Open, DOI per dataset | Medium — needs per-dataset triage |
| **CENIR/Paris Brain Institute, NeuroSpin, INT/CERIMED Marseille** | BIDS-fluent labs (MEG-BIDS/MNE-BIDS co-authors) | Datasets leak to OpenNeuro/Zenodo individually | No standalone archive | Direct-outreach candidates, not harvestable portals |
| **KU Leuven RDR** (Belgium) | General institutional repo; Leuven MEG center notable but no confirmed dedicated collection | Unclear | Open, DOI-issued | Low-medium as bulk source |
| **Campus Biotech Geneva** (Switzerland, new MEGIN system 2022) | Young facility, no public catalog yet | N/A | N/A | Revisit in 1-2 years |
| **IRCCS Besta (Italy)** | Ad hoc EEG via Zenodo community "besta" | Not BIDS-native | Open per Zenodo record | Low-medium, worth scanning the Zenodo community |
| **BCBL** (Basque Center on Cognition, Brain and Language, Spain) | Major MEG producer (35-subj cohorts, Meta/FAIR collabs); outputs surface on Hugging Face, not an in-house archive | Not confirmed BIDS-native for public releases | No dedicated open archive | Highest-value Spanish producer — direct-outreach/agreement target |

### 5d. EU-wide meta-infrastructure

| Source | Verdict |
|---|---|
| **EBRAINS Knowledge Graph** | The one clear pan-European crawl target — metadata openly queryable via KG Query API/`fairgraph` even when actual files are DUA-gated (e.g. NatMEG-PD). Concrete BIDS EEG/MEG/iEEG examples confirmed with DOIs. **Build it as an OpenNeuro-style external index.** |
| **ELIXIR** | No neuroscience/BIDS dataset registry found — skip. |
| **INCF** | Standards body, not a data host — worth outreach for partnerships, not crawling. |
| **OpenAIRE** | Fetch blocked by bot-check wall in this pass; even if reachable, noisy full-text search, not modality-filterable — low priority. |
| **E-PILEPSY/EpiCARE, ENIGMA-Epilepsy, EPILEPSIAE** | Clinical coordination networks or derived-stats-only / paid non-BIDS corpora — skip as raw-data sources. |

## 6. Asia — regional deep dive

### 6a. Japan

No single national OpenNeuro-equivalent. RIKEN CBS's own repository is the best lead.

| Source | Notes | BIDS | Access/License | Verdict |
|---|---|---|---|---|
| **RIKEN CBS Data Sharing Platform** (neurodata.riken.jp) | Open-ended data types; example: 67-ch EEG, 8 subjects | **Native**, BIDS v1.9.0 | Open/embargoed/restricted tiers per dataset; per-dataset CC license (CC-BY or CC-BY-NC observed) | **Best lead** — institutional, BIDS-native, worth a monitoring integration |
| **ATR / DecNef Project** | Predominantly fMRI (~1,400-1,800 subj); separate EEG-fMRI set (atr-EfP-2025, 39 subj) found outside the main portal | Not confirmed BIDS | Mixed registration/approval | Low-medium for EEG specifically — flag the EEG-fMRI set individually |
| **Brain/MINDS Data Portal** | Marmoset MRI + connectivity + ECoG; atlas/viewer-oriented | Not confirmed BIDS | No stated barrier, per-dataset license | Marginal — mostly non-human/anatomical, ECoG holdings worth a closer look |
| **NBDC/DDBJ** | Genomics-focused, no electrophysiology found | N/A | Controlled/unrestricted tiers per NBDC guidelines | Not a viable source as far as found |
| **CiNet (NICT/Osaka/ATR)** | Active MEG/EEG research institute | No public repository found | Unknown | Needs direct outreach, not self-serve |
| **INCF Japan Node / NIJC** | ~16 neuroinformatics platforms (XooNIps-based) | Unknown | Unknown | Needs Japanese-language follow-up |
| **BCCWJ-EEG/fMRI/MEG trio** | 41-subj EEG + fMRI + MEG, identical reading stimuli | **Native BIDS**, CC0 | Already on OpenNeuro (ds007753 etc.) | Already ingestible via existing OpenNeuro path |
| **1000-hour EEG-EMG-audio Japanese speech dataset** | 1,020 hrs, 3 subjects, multimodal | **Native BIDS**, CC0 | Already on OpenNeuro (ds007808) | Already ingestible via existing OpenNeuro path |

### 6b. China

Strongest new lead: **ScienceDB / ChineseNeuro Symphony (CHNNeuro)** community — several BIDS-native EEG datasets, English UI.

| Source | Notes | BIDS | Access/License | Verdict |
|---|---|---|---|---|
| **ChineseEEG** (ScienceDB + OpenNeuro ds004952) | High-density EEG, reading/listening, ~12h/subject | **BIDS-native** | Open, dual-hosted | Strong — likely already importable via OpenNeuro |
| **ChineseEEG-2** (ScienceDB) | 32.4h across 12 subjects, raw+preprocessed+embeddings | **BIDS-native** | Open ScienceDB + GitHub tools | Strong |
| **EmoEEG-MC** (ScienceDB + OpenNeuro ds005540) | 64-ch EEG+GSR/PPG, 60 subjects | **BIDS-native** | Open, dual-hosted | Strong — already OpenNeuro-mirrored |
| **SEED / SEED-IV/V/VII/VIG** (SJTU BCMI lab) | 62-ch EEG emotion, widely cited | **Not BIDS**, custom `.mat` | Signed license agreement required (institutional email) | High scientific value, low near-term candidacy — conversion + owner permission needed |
| **CCNP, SLIM, DIDA-MDD/REST-meta-MDD** | Large Chinese cohort projects | N/A — confirmed **MRI-only, no EEG arm** | — | Not EEG sources despite name similarity |
| **Chinese spoken-word-production EEG dataset** (OSF, IPCAS-affiliated) | 64-ch EEG, 87 subjects | Not BIDS | OSF, open | **CC BY-NC-ND 4.0** — ND clause blocks redistribution |
| **NOD (Natural Object Dataset)** | fMRI+MEG+EEG, Beijing-funded | BIDS | Already on OpenNeuro | Already in existing pipeline |
| **UK/China multi-center MEG-EEG dataset** (Sci Data, paywalled) | MEG+EEG+eye-tracking+MRI, ~100 subjects | Unconfirmed (likely, given venue) | Full text paywalled | Follow-up once accessible — could be a genuine new MEG source |

### 6c. Korea, Taiwan, Singapore, Hong Kong

No BIDS-native national archive anywhere in this group. Individual open GigaDB datasets from Korean BCI labs are the strongest near-term wins.

| Source | Notes | BIDS | Access/License | Verdict |
|---|---|---|---|---|
| **Korea University OpenBMI / "Lee2019"** (GigaDB 100542) | 62-ch EEG + 4-ch EMG, 54 subjects | Raw, not BIDS | Open direct download | GPL 3.0/CC-BY (GigaDB) | Good — real scale, open license, needs conversion |
| **GIST "Cho2017"** (GigaDB 100295) | 62-ch EEG + 2-ch EMG, 52 subjects, motor imagery | Raw | Open | **CC BY 4.0** | Good — clean license, ready to convert |
| **KBRI / K-Brain Net** | Portal launched 2024, 7-hospital network | Unknown — likely biospecimen/tissue-bank focused | Unknown | Needs direct outreach before assuming EEG content |
| **SNUH epilepsy EEG dataset** | 52 patients, 112 seizures | Raw, not BIDS | Restricted, IRB + institutional authorization | Real scale, needs multi-month DUA negotiation |
| **Taiwan NHIRD** | Nationwide claims data | N/A — no EEG component | Restricted | Not a candidate |
| **Taiwan EEG Normative Database** | 260 healthy subjects | Possibly summary stats only, not raw | Unpublished access procedure | Uncertain, confirm before pursuing |
| **CUHK/HKU/HKUST repositories** | General institutional Dataverse/Figshare repos | No confirmed EEG holdings | Depositor-controlled | Unconfirmed, needs targeted in-portal search |

### 6d. BCI-competition legacy & broader pan-Asian/India

| Source | Notes | BIDS | Access/License | Verdict |
|---|---|---|---|---|
| **BCI Competition II/III/IV** (bbci.de) | Legacy but still-cited motor-imagery/P300 sets (2003-2008) | No BIDS conversion found anywhere | Citation-only norm, no formal license | Low-moderate — licensing ambiguous, would need permission from original Graz/Berlin groups |
| **BNCI Horizon 2020** (EU/Graz re-host of some Comp IV data) | Real CC BY 4.0 / CC BY-NC-ND 4.0 licensing | Not BIDS yet | Individually downloadable | Best legal path into Comp IV data — European, not Asian, flagged per instructions |
| **NMT Scalp EEG Dataset** (Pakistan, NUST) | 2,417 recordings, healthy+pathological | Raw, not BIDS | Open, **CC BY** | Good — real open license, South Asian, sizeable N |
| **MyneuroDB** (Universiti Sains Malaysia) | Malaysia's first neuro data-sharing repo (MRI/EEG/MEG), FAIR-aligned | Unconfirmed | URL/access unverified, likely pre-launch/gated | Watch-list, needs direct author contact |
| **India (NBRC, IISc, IITs)** | Active EEG research groups, no public repository found | N/A | N/A | No confirmed open source — direct outreach only |
| **MOABB** (Python BCI benchmark aggregator) | Not a host, but indexes ~15+ MI/P300/SSVEP datasets with provenance/license notes baked in | N/A | N/A | Useful shortcut for enumerating "what's actually reusable" in future passes |

---

## 7. EEGDash — a sibling ingestion project (added 2026-07-24)

User pointer: [facebookresearch/neuroai `neuralset/extractors`](https://github.com/facebookresearch/neuroai/tree/main/neuralset-repo/neuralset/extractors) and [eegdash/EEGDash `scripts/ingestions/1_fetch_sources`](https://github.com/eegdash/EEGDash/tree/develop/scripts/ingestions/1_fetch_sources).

**neuroai/neuralset/extractors**: not a source list. It's a feature-extraction library for ML (audio/image/text/video/neuro modalities), and `neuro.py` specifically is preprocessing infrastructure for MEG/EEG/EMG/iEEG/fNIRS/fMRI referencing standard atlases (HCP-MMP, MNI152, FSAverage) — no dataset/archive references. Not relevant to source discovery; could matter later for a post-import feature-extraction pipeline.

**EEGDash**: highly relevant, and a materially different finding than anything else in this doc. It is built by **SCCN (UC San Diego) and Ben-Gurion University**, NSF-funded, **BSD-3-Clause** licensed — SCCN is NEMAR's own home institution, so this is a sibling project, not a third party. It already hosts 27,000+ participants' MEEG recordings and explicitly ingests **330 BIDS datasets converted from NEMAR** (via `data.nemar.org/?format=json` + `/{id}/metadata.json` — confirms NEMAR already exposes a public catalog API that a downstream consumer relies on).

Its `scripts/ingestions/1_fetch_sources/` directory is a set of **working, deployed ingestion adapters** for sources this research doc independently identified — useful as reference implementations, not just corroboration:

| Script | Source | Endpoint | Notes |
|---|---|---|---|
| `zenodo.py` | Zenodo | `zenodo.org/api/records` | Keyword search, `access_status=open` + `resource_type=dataset`, checks for `dataset_description.json`/subject folders. **Explicitly excludes iEEG, spiking, LFP** — narrower scope than NEMAR wants; would need re-querying with iEEG included. |
| `scidb.py` | ScienceDB (China) | `scidb.cn/api/sdb-query-service/query` + file-tree endpoint | Confirms §6b findings; 4-modality search incl. iEEG, `dataSetStatus: PUBLIC`, no auth. |
| `osf.py` | OSF | `api.osf.io/v2/nodes` | Tag + title search, license lookup via `/licenses/{id}`. Confirms §4's "needs API not UI scraping" finding. |
| `figshare.py` | Figshare | Figshare API v2 `/articles/search` | "EEG BIDS" keyword search, broader modality detection (EMG/fNIRS/LFP too). |
| `datarn.py` | Radboud (data.ru.nl) | `/api/search/collections/published` | **No auth required** — cleaner than assumed in §5a; searches EEG/MEG/EMG/fNIRS/LFP/iEEG + "BIDS" keyword, filters by access tier. |
| `eegmanylabs.py` | EEGManyLabs (GIN) | org page scrape + GIN API v1 | Surfaced the new archive added to §1 above. |
| `nemar.py` | NEMAR itself | `data.nemar.org/?format=json`, `/{id}/metadata.json` | Confirms NEMAR's own public catalog API, consumed by a downstream project. |
| `fetch_neurips2025.py` | Local + `s3://nmdatasets/NeurIPS25` | — | Tangential: catalogs a NeurIPS 2025 EEG ML benchmark release, sourced from NEMAR data, not a new external archive. |
| `local_bids.py` | Local filesystem | — | Generic local-BIDS-directory cataloger, not an external source. |

**Strategic implication for the importer architecture (see `.context/plan-multi-archive-importer.md`):** given the shared SCCN home and the permissive BSD-3-Clause license, the right move for Phase 1/2 adapters (Zenodo, ScienceDB, OSF, Figshare, Radboud) is very likely to **port/adapt EEGDash's existing discovery logic** (and coordinate directly with that team, since duplicate crawler engineering across two SCCN-affiliated projects is pure waste) rather than build NEMAR's adapters from scratch. The one real scope gap to close ourselves: EEGDash's Zenodo adapter skips iEEG, which NEMAR explicitly wants.

## Recommended next steps

1. **Ship the easy wins first** (already-BIDS, open license, no gating): TDBRAIN, WAND, CeTI-Locomotion/Age-Kinematics, EEGManyLabs, ChineseEEG/ChineseEEG-2/EmoEEG-MC, GigaDB Korea University/GIST sets (need conversion but clean license). ERP CORE and HBN-EEG are already done — don't re-import.
2. **Talk to the EEGDash team before building crawlers from scratch** (§7) — same SCCN home institution, BSD-3-Clause, already has working Zenodo/ScienceDB/OSF/Figshare/Radboud/EEGManyLabs discovery adapters. Porting/coordinating beats parallel re-engineering; the one gap to fill ourselves is iEEG (EEGDash's Zenodo adapter explicitly excludes it).
3. **Stand up the two highest-yield general-repo crawlers**: Zenodo `keywords:"BIDS"` API and G-Node GIN `keywords/bids/` — both are cheap, precise, and low-maintenance.
4. **Open partnership conversations** (data exists and is high-value, but DUAs currently forbid redistribution): Cam-CAN, OMEGA, NatMEG-PD, HCP-MEG, EBRAINS HIP, RAM. These need institutional-level agreements, not engineering.
5. **Build an EBRAINS Knowledge Graph metadata index** even before redistribution rights are resolved — the metadata/DOI layer is openly crawlable and gives NEMAR a discovery/citation layer now, gating actual file transfer per-dataset later.
6. **Flag unresolved leads for direct outreach** rather than further search: MEG UKI Database curator, BCBL (Spain), KBRI/K-Brain Net (Korea), RIKEN CBS ongoing monitoring, CiNet (Japan), MyneuroDB (Malaysia).
7. **Treat PhysioNet-style "shaped but unvalidated" archives as the default case**, not the exception — every source above except OpenNeuro-mirrors needs to go through NEMAR's in-house `bids-validator` pipeline before ingest.
