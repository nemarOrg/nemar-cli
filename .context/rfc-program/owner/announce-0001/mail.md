# Community mail for NEMAR RFC 0001

Which channel this goes through depends on whether the per-category mail feature (nemar-cli epic #2260) is in production at O5.
Check with `nemar admin notify --help`: the feature has shipped if the command lists `--category`.

- **Shipped:** send in the `rfcs` category (variant A).
  Per the epic's plan, the mail path adds the category footer, with the one-click unsubscribe link for `rfcs`, to every message, so the body below carries no footer of its own.
  Send first to `--to admins` as a canary and look at the footer in the delivered message before sending to `--to all`.
- **Not shipped:** the mail goes out through the existing `announcements` preference (variant B).
  That path adds no footer, so the paragraph marked variant B stays at the end of the body.

Broadcast mail is production-only.
The mail body is read as Markdown with one paragraph per line, because a single newline inside a paragraph becomes a line break in the email; that is why paragraphs below are not split at sentence ends.

Fill the tokens as `news.md` ("Owner notes") describes, then extract the body from the filled copy and send a dry run first:

```bash
SUBJECT="NEMAR RFC 0001: comments on the biosig-zarr format are open until $CLOSE UTC"
BODY=$(mktemp)
sed -n '/^<!-- BODY START -->$/,/^<!-- BODY END -->$/p' "$OUT/mail.md" | sed '1d;$d' > "$BODY"

# Variant A (the rfcs category has shipped): drop the variant B paragraph.
sed -i '' '/^VARIANT B ONLY/d' "$BODY"
nemar admin notify --to all --category rfcs --subject "$SUBJECT" --body-file "$BODY" --dry-run
nemar admin notify --to all --category rfcs --subject "$SUBJECT" --body-file "$BODY"

# Variant B (not shipped): keep the variant B paragraph, without its marker, and send without --category.
# sed -i '' 's/^VARIANT B ONLY, delete this paragraph for variant A: //' "$BODY"
# nemar admin notify --to all --subject "$SUBJECT" --body-file "$BODY" --dry-run
# nemar admin notify --to all --subject "$SUBJECT" --body-file "$BODY"
```

Subject: `NEMAR RFC 0001: comments on the biosig-zarr format are open until {{CLOSE_UTC}} UTC`

<!-- BODY START -->
## NEMAR RFC 0001: comment on the biosig-zarr format

The Neuroelectromagnetic Data Archive and Tools Resource (NEMAR) has opened its first Request for Comments (RFC). It asks the biosignal community to comment on biosig-zarr, the Zarr format NEMAR uses to serve recordings, and on a single-file form of it called `.bzx`, before version 3 is frozen.

NEMAR serves 231,259 biosig-zarr stores today, one for 98.4% of the 235,038 recordings in its 910 public datasets (about 116,285 hours, measured 2026-11-20). The data viewer and the Model Context Protocol server for research agents read them. Version 3 would keep the timing of recordings with gaps, jittered streams and sparse signals in a form no reader can silently misread, and would record the resolution of the source recording and every lossy step.

**What it means for your datasets:** nothing changes now. The RFC changes no dataset's content, version 2 stores stay readable, and no store is re-converted before the decision.

**The RFC has 40 questions.** Answer any subset; a short answer with a real file behind it is worth more than a long one without. You do not need to be a NEMAR user to comment, and colleagues who record, share or analyze biosignals, or who build Zarr tools, are welcome.

**Comments close {{CLOSE_UTC}} Coordinated Universal Time (UTC).** The window is 21 days, short on purpose: NEMAR welcomes review assisted by artificial intelligence when knowledgeable people use it and check what it produces, and with that help a careful review fits in three weeks.

**How to comment:** reply under the RFC's Discussion with a GitHub account: [{{THREAD_URL}}]({{THREAD_URL}}). Without an account, write to support@nemar.org before the close; a maintainer posts your comment in the thread with your consent, and with your name only if you agree.

The RFC text is [text/0001-biosig-zarr.md](https://github.com/nemarOrg/rfcs/blob/main/text/0001-biosig-zarr.md) in nemarOrg/rfcs.

VARIANT B ONLY, delete this paragraph for variant A: You receive this because your NEMAR account accepts announcements. To stop receiving them, write to support@nemar.org and an administrator will turn them off.
<!-- BODY END -->
