# LinkedIn post for NEMAR RFC 0001

Posted by the owner from the personal account, after the thread exists and the tokens are filled as `news.md` ("Owner notes") describes.
The text to post is the fenced block; LinkedIn shows plain text, so there is no Markdown in it.
It is about 1,400 characters, under LinkedIn's limit of 3,000, and carries the thread link and the close.

```text
The Neuroelectromagnetic Data Archive and Tools Resource (NEMAR) has opened its first Request for Comments (RFC), and I would like people who work with biosignals to read it.

NEMAR serves 231,259 biosig-zarr stores today, one for 98.4% of the 235,038 recordings in its 910 public datasets, about 116,285 hours. biosig-zarr is the Zarr format our data viewer and our Model Context Protocol server read. RFC 0001 proposes version 3 of it, and a single-file form called .bzx.

Version 3 keeps the timing of recordings with gaps, jittered streams and sparse signals, in a form no reader can silently misread. It also records the source recording's resolution and every lossy step beside the stored samples.

We want comments from anyone who records, shares or analyzes biosignals of any kind, and from people who build Zarr tools. The RFC has 40 questions; answer any subset, and a short answer with a real file behind it is worth more than a long one without.

Comments close {{CLOSE_UTC}} Coordinated Universal Time (UTC). The window is 21 days on purpose: we welcome review assisted by artificial intelligence when knowledgeable people use it and check what it produces, and with that help a careful review fits in three weeks.

Read it and comment under the RFC's Discussion on GitHub: {{THREAD_URL}}
No GitHub account? Write to support@nemar.org before the close, and a maintainer will post your comment with your consent.
```
