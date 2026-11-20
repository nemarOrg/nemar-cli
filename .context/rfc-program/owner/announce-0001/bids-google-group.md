# BIDS Google group post for NEMAR RFC 0001

Posted by the owner to the Brain Imaging Data Structure (BIDS) Google group, [bids-discussion](https://groups.google.com/g/bids-discussion), after the thread exists and the tokens are filled as `news.md` ("Owner notes") describes.
The group takes plain text, so the post below has no Markdown.
Post it as a new topic, not as a reply to an existing one.

Subject:

```text
NEMAR RFC 0001: comments wanted on biosig-zarr, gaps and sparse signals (closes {{CLOSE_UTC}} UTC)
```

Body:

```text
Dear BIDS community,

The Neuroelectromagnetic Data Archive and Tools Resource (NEMAR) has opened its first Request for Comments (RFC). NEMAR RFC 0001 asks for comments on biosig-zarr, the Zarr format NEMAR uses to serve biosignal recordings, and on .bzx, a single-file form of one store. NEMAR serves 231,259 such stores today, one for 98.4% of the 235,038 recordings in its 910 public datasets (about 116,285 hours, measured 2026-11-20).

Version 2 of the format has one uniform time axis per signal group, so a paused recording, a jittered stream or a sparse signal has no representation. The RFC proposes version 3 to keep that timing explicit. It also records the source recording's resolution and each lossy step. BIDS contributors raised the same limit in BIDS Extension Proposal (BEP) 045 (peripheral physiology, https://github.com/bids-standard/bids-specification/pull/2267) and in bids-specification issues 2313, 1771, 1796 and 2463, which the RFC cites.

A store stands in for a BIDS data file and leaves the sidecar files as the record. Questions we would most like BIDS people to answer: for a recording with gaps or timestamps, what should RecordingDuration, SamplingFrequency and RecordingType say, and do events.tsv onsets count gap time (question 17)? The package questions (8 to 14) also bear on a compact binary form for motion and physio data, as issue 2463 asks. The RFC has 40 questions in all; answer any subset.

Comments close {{CLOSE_UTC}} Coordinated Universal Time (UTC), 21 days after the thread opened. The window is short on purpose: we welcome review assisted by artificial intelligence when knowledgeable people use it and check what it produces, and with that help a careful review fits in three weeks.

To comment, reply under the RFC's Discussion on GitHub: {{THREAD_URL}}
Without a GitHub account, write to support@nemar.org before the close; a maintainer posts your comment in the thread with your consent, and with your name only if you agree.

The RFC text: https://github.com/nemarOrg/rfcs/blob/main/text/0001-biosig-zarr.md

Seyed Yahya Shirazi
NEMAR
```
