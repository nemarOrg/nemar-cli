---
slug: nemar-rfc-0001-biosig-zarr
title: "NEMAR RFC 0001: comment on the biosig-zarr format"
summary: "NEMAR asks the biosignal community to comment on version 3 of biosig-zarr and its single-file form .bzx before they are frozen. Comments close {{CLOSE_UTC}} UTC."
category: update
banner_url: null
banner_alt: ""
status: draft
---

<!--
A news post for nemar.org, drafted for POST /admin/news (the fields above are its fields, `published_at` omitted so it defaults to the moment of posting).
The post body is everything between this comment and the last horizontal rule; "Owner notes" after that rule is not part of the post.
Fill {{CLOSE_UTC}} and {{THREAD_URL}} first, then set `status: published`.
-->

The Neuroelectromagnetic Data Archive and Tools Resource (NEMAR) opens its first Request for Comments (RFC) today.
NEMAR RFC 0001 asks the biosignal community to comment on biosig-zarr, the Zarr format NEMAR uses to serve recordings, and on a single-file form of it called `.bzx`, before version 3 is frozen.

NEMAR serves 231,259 biosig-zarr stores today, one for 98.4% of the 235,038 recordings in its 910 public datasets (about 116,285 hours, measured 2026-11-20).
The data viewer reads them, and so does the Model Context Protocol server that research agents use.

Version 3 would do two things version 2 cannot.
It keeps the timing of recordings with gaps, jittered streams and sparse signals, in a form that no reader can silently misread.
And it records the resolution of the source recording and every lossy step, beside the stored samples.

The RFC has 40 questions.
Answer any subset; a short answer with a real file behind it is worth more than a long one without.

## Who should comment

Anyone who records, shares or analyzes biosignals of any kind: electroencephalography, magnetoencephalography, intracranial electroencephalography, electromyography, electrocardiography, other physiology, motion and wearable sensors.
Anyone who builds Zarr tools.
Anyone who maintains a neighboring standard, such as the Brain Imaging Data Structure, Neurodata Without Borders or OME-Zarr.

## What it means for your datasets

Nothing changes for them now.
The RFC changes no dataset's content, version 2 stores stay readable, and no store is re-converted before the decision.

## The window

Comments close **{{CLOSE_UTC}} Coordinated Universal Time (UTC)**, 21 days after the thread opened.
The window is short on purpose.
NEMAR welcomes review assisted by artificial intelligence when knowledgeable people use it and check what it produces, and with that help a careful review fits in three weeks.
One extension of at most 14 days is possible, and at most one NEMAR RFC is open for comment at a time.

## How to comment

Reply under the RFC's Discussion: {{THREAD_URL}}.
You need a GitHub account.
Without one, write to support@nemar.org before the close; a maintainer posts your comment in the thread with your consent, and with your name only if you agree.

The RFC text is [text/0001-biosig-zarr.md](https://github.com/nemarOrg/rfcs/blob/main/text/0001-biosig-zarr.md) in nemarOrg/rfcs.
The proposed specification is the comparison [2.0.0...3.0.0-draft.1](https://github.com/nemarOrg/biosig-zarr/compare/2.0.0...3.0.0-draft.1) in nemarOrg/biosig-zarr.

---

## Owner notes (not part of the post)

Order at O5, after the thread exists and the RFC pull request is merged:
the Discussion itself, then this post, the command-line notice, the docs banner, the mail, the community notes in `notes.md`, then LinkedIn and the BIDS Google group.

Fill the tokens into a scratch copy, never into the committed drafts.
`CLOSE` is `opened_at` plus 21 days (plus any extension), in UTC, to the minute, as the opening post prints it.

```bash
cd /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/rfc-program/.context/rfc-program/owner/announce-0001
CLOSE="2026-12-11 15:42"
CLOSE_ISO="2026-12-11T15:42:00Z"
THREAD="https://github.com/nemarOrg/rfcs/discussions/NN"
OUT=$(mktemp -d)
for f in *.md *.json; do
  sed -e "s|{{CLOSE_UTC_ISO}}|$CLOSE_ISO|g" -e "s|{{CLOSE_UTC}}|$CLOSE|g" -e "s|{{THREAD_URL}}|$THREAD|g" "$f" > "$OUT/$f"
done
grep -lE '[{][{](CLOSE_UTC|THREAD_URL)' "$OUT"/* ; echo "$OUT"   # the grep must print nothing
```

`{{CLOSE_UTC_ISO}}` appears only in `cli-notice.json`, because the notice's `expires_at` must be an ISO 8601 date-time; every other file uses `{{CLOSE_UTC}}` in the form `YYYY-MM-DD HH:MM`.

Command-line notice (an admin key; the notice shows to every account and disappears at the close):

```bash
nemar admin notice set \
  -m "$(jq -r .message "$OUT/cli-notice.json")" \
  -l "$(jq -r .level "$OUT/cli-notice.json")" \
  -s "$(jq -r .scope "$OUT/cli-notice.json")" \
  -e "$(jq -r .expires_at "$OUT/cli-notice.json")"
```

News post: create it from the front matter and the body above, with the news form or `POST /admin/news`.
