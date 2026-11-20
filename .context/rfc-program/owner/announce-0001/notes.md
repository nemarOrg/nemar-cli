# Community notes for NEMAR RFC 0001

One short note for each community the owner approved (Q15, 2026-11-20, with Q18's correction).
The owner posts each from a personal GitHub account, after the thread exists and the tokens are filled as `news.md` ("Owner notes") describes.
Nothing here is sent by a worker.

Each note is at most 120 words, says what is asked of that community, and says how to comment.
The text to post is the fenced block under each heading; paragraphs are on one line because GitHub renders every newline.
Every public contact point below was read on 2026-11-20: the repository is public, the thread is open and not locked, and Issues or Discussions are enabled as stated.

Where to post, in one table:

| # | Community | Contact point |
| --- | --- | --- |
| 1a | OME-Zarr RFC-9 authors | A new issue in [ome/ngff](https://github.com/ome/ngff) (Issues on, Discussions off) |
| 1b | Zarr community | A new Discussion in [zarr-developers/zarr-specs](https://github.com/zarr-developers/zarr-specs/discussions) |
| 2 | hdmf-zarr and Neurodata Without Borders maintainers | A new issue in [hdmf-dev/hdmf-zarr](https://github.com/hdmf-dev/hdmf-zarr); Neurodata Without Borders helpdesk Discussions at [NeurodataWithoutBorders/helpdesk](https://github.com/NeurodataWithoutBorders/helpdesk/discussions) if they redirect |
| 3 | The cited Brain Imaging Data Structure (BIDS) threads | A comment on each of five open threads, listed under note 3 |
| 4 | MNE-Python issue 13429 | A comment on [mne-tools/mne-python#13429](https://github.com/mne-tools/mne-python/issues/13429) |

## 1a. OME-Zarr RFC-9 authors

Post as a new issue in ome/ngff, titled "Prior-art note: a zipped Zarr form for biosignals (NEMAR RFC 0001)".
The authors and editor named in RFC-9's front matter are `jwindhager`, `normanrz`, `mkitti` and `joshmoore`; mention them if the owner wants them notified.

```text
RFC-9 (zipped OME-Zarr) is cited as prior art in NEMAR RFC 0001, a request for comments from the Neuroelectromagnetic Data Archive and Tools Resource (NEMAR) on biosig-zarr, a Zarr v3 format for biosignal recordings, and its single-file form `.bzx`. The packing rules are our own: ZIP64 always, root entry first, stored entries, every entry byte-identical to the directory form, written once. We do not track later changes to RFC-9.

We ask the RFC-9 authors: does any of those rules lock out a tool you know of, and is our comparison with RFC-9 (checked 2026-11-20 at stage R4) accurate? Comments close {{CLOSE_UTC}} UTC. Reply in the Discussion, {{THREAD_URL}}, or write to support@nemar.org if you have no GitHub account.
```

## 1b. Zarr community

Post as a new Discussion in zarr-developers/zarr-specs, titled "NEMAR RFC 0001: biosig-zarr and `.bzx`, a Zarr v3 convention and a zipped store for biosignals".

```text
The Neuroelectromagnetic Data Archive and Tools Resource (NEMAR) serves 231,259 biosignal recordings as Zarr v3 stores (biosig-zarr) and has opened a request for comments, NEMAR RFC 0001, on version 3 of the format and on `.bzx`, a ZIP64 package of one store.

We ask people who build Zarr readers and writers: what would stop you from reading these stores or a `.bzx` file in your language, should the format be declared as a registered Zarr convention in root attributes, and do you need to read a remote `.bzx` by range requests? Comments close {{CLOSE_UTC}} UTC. Reply in the Discussion, {{THREAD_URL}}, or write to support@nemar.org if you have no GitHub account.
```

## 2. hdmf-zarr and Neurodata Without Borders maintainers

Post as a new issue in hdmf-dev/hdmf-zarr, titled "Is our description of NWB on Zarr accurate? (NEMAR RFC 0001)".
The maintainers listed by GitHub for the repository include `oruebel`, `rly` and `mavaylon1`; mention them if the owner wants them notified.

```text
NEMAR RFC 0001 (from the Neuroelectromagnetic Data Archive and Tools Resource, NEMAR) proposes version 3 of biosig-zarr, a Zarr format for biosignal recordings. Its section "Why not NWB on Zarr" describes hdmf-zarr and Neurodata Without Borders (NWB) on Zarr as of 2026-11-18, including that the backend is under development and that a recent release switched to a layout older readers cannot open.

We ask the maintainers two things: what in that section is wrong or out of date, and would a stateless NWB export built from a store be useful, and which tool would read it? Comments close {{CLOSE_UTC}} UTC. Reply in the Discussion, {{THREAD_URL}}, or write to support@nemar.org if you have no GitHub account.
```

## 3. The cited BIDS threads

Five threads, each an open and unlocked thread cited in RFC 0001's "Problem" section.
Post the same text in each, replacing the sentence `{{LEAD}}` with the one listed for that thread.
Each filled text stays at 120 words or fewer.

| Thread | `{{LEAD}}` |
| --- | --- |
| [bids-specification#2267](https://github.com/bids-standard/bids-specification/pull/2267) (BIDS Extension Proposal (BEP) 045, [proposal page](https://bids.neuroimaging.io/extensions/beps/bep_045.html)) | This thread is where the peripheral physiology extension is written, and RFC 0001 cites it for irregular and sparse signals. |
| [bids-specification#2313](https://github.com/bids-standard/bids-specification/issues/2313) | RFC 0001 cites this issue on sparse and non-continuous peripheral physiological data. |
| [bids-specification#1771](https://github.com/bids-standard/bids-specification/issues/1771) | RFC 0001 cites the 2024 answer here that a recording which stopped and resumed is separate runs. |
| [bids-specification#1796](https://github.com/bids-standard/bids-specification/issues/1796) | RFC 0001 cites this issue on timestamps for irregularly sampled physio tables. |
| [bids-specification#2463](https://github.com/bids-standard/bids-specification/issues/2463) | RFC 0001 cites this issue, where Zarr is a candidate for a compact binary format. |

```text
{{LEAD}} The Neuroelectromagnetic Data Archive and Tools Resource (NEMAR) has opened a request for comments, NEMAR RFC 0001, on version 3 of biosig-zarr, a Zarr format for biosignal recordings that keeps gaps, jittered and sparse timing explicit.

We ask Brain Imaging Data Structure contributors, for a recording with gaps or timestamps: what should RecordingDuration, SamplingFrequency and RecordingType say, and do events.tsv onsets count gap time (question 17)? Comments close {{CLOSE_UTC}} UTC. Reply in the Discussion, {{THREAD_URL}}, or write to support@nemar.org if you have no GitHub account.
```

The token `{{LEAD}}` is a placeholder for this note only; replace it by hand, never with the fill commands in `news.md`.

## 4. MNE-Python issue 13429

Post as a comment on mne-tools/mne-python#13429 ("read_raw_edf silently loads EDF+D files without accounting for time gaps"), which RFC 0001 cites.

```text
RFC 0001 of the Neuroelectromagnetic Data Archive and Tools Resource (NEMAR) cites this issue. It proposes version 3 of biosig-zarr, a Zarr format for biosignal recordings that records gaps on the sample grid as a list of valid intervals, with a rule for mapping event onsets to samples.

We ask the MNE-Python maintainers and users: how would you want a reader to hand gaps and event onsets to MNE-Python (questions 17, 18 and 38), and do you have gapped recordings to test against? Comments close {{CLOSE_UTC}} UTC. Reply in the Discussion, {{THREAD_URL}}, or write to support@nemar.org if you have no GitHub account.
```
