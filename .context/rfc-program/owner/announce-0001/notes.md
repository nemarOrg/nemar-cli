# Community notes for NEMAR RFC 0001

One short note for each community venue the owner approved (Q15 of 2026-11-20, revised by Q31 and Q32).
RFC 0001 is NEMAR's question for the biosignal community, so nothing is posted in another project's repository.
The owner posts each from a personal account, after the thread exists and the tokens are filled as `news.md` ("Owner notes") describes.
Nothing here is sent by a worker.

Each note is at most 120 words, says what is asked of that audience, and says how to comment.
Each note defines Coordinated Universal Time (UTC) itself, because a note is read alone.
The text to post is the fenced block under each heading; paragraphs are on one line because the venues render or quote every newline.
Each posting route below was read on 2026-11-20.

| # | Venue | Posting route |
| --- | --- | --- |
| 1 | EEGLAB mailing list (eeglablist, Swartz Center for Computational Neuroscience, University of California San Diego) | Email eeglablist@sccn.ucsd.edu |
| 2 | MNE Forum | New topic in the category Announcements at [mne.discourse.group](https://mne.discourse.group/categories) |
| 3 | Neurostars | New topic in the category Announcements at [neurostars.org](https://neurostars.org/categories) |

## 1. EEGLAB mailing list

Route: email to eeglablist@sccn.ucsd.edu.
The list page ([sccn.ucsd.edu/mailman/listinfo/eeglablist](https://sccn.ucsd.edu/mailman/listinfo/eeglablist)) says the list is for "discussions and announcements related to EEGLAB" and that it is moderated; anyone may subscribe by the form on that page after confirming by email.
The page does not say whether a non-subscriber may post, so the owner posts from a subscribed address; the post waits for moderation.

Subject: `NEMAR RFC 0001: comments wanted on gaps and events in EEG recordings (closes {{CLOSE_UTC}} UTC)`

```text
The Neuroelectromagnetic Data Archive and Tools Resource (NEMAR) has opened a request for comments, NEMAR RFC 0001, on version 3 of biosig-zarr, the Zarr format it uses to serve 231,259 recordings, and on `.bzx`, a single-file form.

We ask EEGLAB users: do your electroencephalography recordings in European Data Format, BioSemi Data Format or BrainVision files contain pauses, boundary events or concatenated runs, and does the proposed way of keeping gaps and event onsets fit how you analyze them? Comments close {{CLOSE_UTC}} Coordinated Universal Time (UTC). Reply under the RFC's Discussion, {{THREAD_URL}}, or write to support@nemar.org if you have no GitHub account.
```

## 2. MNE Forum

Route: a new topic at mne.discourse.group, in the category Announcements ("Announcements of new software releases, workshops, etc.").
The forum's other open category, Support & Discussions, is for questions; use it instead if a moderator moves the topic.
Posting needs a forum account.
Title: `NEMAR RFC 0001: reading biosignal stores and gapped recordings into MNE-Python`

```text
The Neuroelectromagnetic Data Archive and Tools Resource (NEMAR) has opened a request for comments, NEMAR RFC 0001, on version 3 of biosig-zarr, a Zarr format that records gaps in a recording as a list of valid intervals, with a rule for mapping event onsets to samples. NEMAR serves 231,259 such stores.

We ask MNE-Python users: what should reading a store into MNE-Python return for a recording with gaps, and do your event onsets count gap time? Do you have gapped recordings to test with? Comments close {{CLOSE_UTC}} Coordinated Universal Time (UTC). Reply under the RFC's Discussion, {{THREAD_URL}}, or write to support@nemar.org if you have no GitHub account.
```

## 3. Neurostars

Route: a new topic at neurostars.org, in the category Announcements ("Project launches, software releases, job postings, and other updates that aren't questions").
The category Community Chat is the alternative if a moderator moves it.
Posting needs a forum account.
Title: `NEMAR RFC 0001: comments wanted on biosig-zarr and its single-file form .bzx`

```text
The Neuroelectromagnetic Data Archive and Tools Resource (NEMAR) has opened a request for comments, NEMAR RFC 0001, on version 3 of biosig-zarr, the Zarr format it uses to serve recordings from 910 public datasets, and on `.bzx`, a single file that can stand in for one data file beside its Brain Imaging Data Structure (BIDS) sidecar files.

We ask BIDS and OpenNeuro users: would you use a `.bzx` file in place of a data file, does the name collide with anything you use, and do any of your recordings have gaps or sparse signals? Comments close {{CLOSE_UTC}} Coordinated Universal Time (UTC). Reply under the RFC's Discussion, {{THREAD_URL}}, or write to support@nemar.org if you have no GitHub account.
```
