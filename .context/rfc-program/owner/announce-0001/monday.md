# Opening NEMAR RFC 0001 on Monday 2026-11-23

The owner runs every command here, in order, on Monday morning Pacific time (planned for 09:00 PST, 17:00 UTC).
Nothing here is run by the manager, a worker or another session.
The plan's step O5 (`plan.md`, section 5) is the authority; this page fills in its commands for this RFC, as checked on 2026-11-22.

If the thread is created at 17:00 UTC, the RFC closes Monday 2026-12-14 at 17:00 UTC (09:00 PST);
the one allowed extension of at most 14 days would end Monday 2026-12-28 at the latest.
The close is computed from the thread's actual creation minute in step 2, so a later start only moves it.

Checked on 2026-11-22 so that Monday is only these steps:

- RFC PR nemarOrg/rfcs#2 is a draft at `b6bbb3cddca8f49fc59b98ca130e72eaf1cca4eb`, `rfc-check` passes, and it is one commit behind `main` (the handoff, PR #3); `main` requires `rfc-check` on an up-to-date branch, so step 3 merges `main` into it.
- A dry run of step 3 on a scratch copy (fields set, `bun run index`) gave `rfc-check: ok` and a clean `biome ci`; without `bun run index` the check fails on a stale index.
- The `RFCs` Discussion category exists (id below); the repository has no Discussion yet.
- Production API 0.10.38 has the `rfcs` mail category; the local CLI was 0.10.35, which has no `--category`, so step 1 upgrades it.

Every block below runs in one terminal; later blocks use variables set by earlier ones.

## 1. Before 09:00: check and prepare (about 5 minutes)

```bash
date -u
curl -s https://api.nemar.org/health        # must show "version":"0.10.38" or later
bun add -g nemar-cli@0.10.38 && nemar --version
nemar admin notify --help | grep -- '--category'   # must print the --category line
gh auth status

W=$HOME/rfc0001-open; mkdir -p "$W/out"
git -C ~/Documents/git/nemar/nemar-cli fetch -q origin feature/rfc-program
git -C ~/Documents/git/nemar/nemar-cli archive origin/feature/rfc-program .context/rfc-program/owner/announce-0001 \
  | tar -x --strip-components=4 -C "$W"
cd "$W" && ls                                # bids-google-group.md cli-notice.json docs-banner.md linkedin.md mail.md monday.md news.md notes.md

# The opening post is the PR body above its "---" line.
gh pr view 2 -R nemarOrg/rfcs --json body -q .body | sed '/^---$/,$d' > opening-post.tmpl.md
grep -c '{{CLOSE_UTC}}' opening-post.tmpl.md   # 1
```

## 2. 09:00 PST: create the thread

```bash
cd "$W"
REPO=R_kgDOV153DA                 # nemarOrg/rfcs
CAT=DIC_kwDOV153DM4DLmtF          # category RFCs
TEXT_URL=https://github.com/nemarOrg/rfcs/blob/main/text/0001-biosig-zarr.md
fill() {  # $1 = close "YYYY-MM-DD HH:MM"
  sed -e "s|{{CLOSE_UTC}}|$1|g" \
      -e "s|{link to text/0001-biosig-zarr.md at its merge commit}|$TEXT_URL|" \
      opening-post.tmpl.md > opening-post.md
}
CLOSE=$(date -u -j -v+21d "+%Y-%m-%d %H:%M"); fill "$CLOSE"

gh api graphql \
  -f query='mutation($r:ID!,$c:ID!,$t:String!,$b:String!){createDiscussion(input:{repositoryId:$r,categoryId:$c,title:$t,body:$b}){discussion{id url createdAt}}}' \
  -f r=$REPO -f c=$CAT -f t="RFC 0001: biosig-zarr and its single-file form .bzx" \
  -F b=@opening-post.md > created.json
cat created.json

DID=$(jq -r .data.createDiscussion.discussion.id created.json)
THREAD=$(jq -r .data.createDiscussion.discussion.url created.json)
OPENED="$(jq -r .data.createDiscussion.discussion.createdAt created.json | cut -c1-16):00Z"
CLOSE_ISO=$(date -u -j -v+21d -f "%Y-%m-%dT%H:%M:%SZ" "$OPENED" "+%Y-%m-%dT%H:%M:00Z")
CLOSE_REAL=$(date -u -j -v+21d -f "%Y-%m-%dT%H:%M:%SZ" "$OPENED" "+%Y-%m-%d %H:%M")
echo "thread $THREAD  opened $OPENED  closes $CLOSE_REAL UTC"

# Only if the minute rolled over between the two clocks: correct the post.
if [ "$CLOSE_REAL" != "$CLOSE" ]; then
  CLOSE=$CLOSE_REAL; fill "$CLOSE"
  gh api graphql -f query='mutation($d:ID!,$b:String!){updateDiscussion(input:{discussionId:$d,body:$b}){discussion{url}}}' \
    -f d=$DID -F b=@opening-post.md
fi
```

Open `$THREAD` in the browser and read the post once: the close line, the record link, the 40 questions.

## 3. Record the opening on the RFC PR and merge it

```bash
cd ~/Documents/git/nemar/rfcs
git fetch -q origin && git switch rfc/0001-biosig-zarr && git pull --ff-only
git merge --no-edit origin/main
sed -i '' -e "s|^discussion: null|discussion: $THREAD|" -e "s|^opened_at: null|opened_at: $OPENED|" text/0001-biosig-zarr.md
grep -nE '^(discussion|opened_at|window_days):' text/0001-biosig-zarr.md
bun install --frozen-lockfile && bun run index && bun run check && bun run lint
git add text/0001-biosig-zarr.md README.md && git commit -m "Open RFC 0001" && git push

gh pr view 2 -R nemarOrg/rfcs --json body -q .body \
  | sed -e "s|{{CLOSE_UTC}}|$CLOSE|g" -e "s|{link to text/0001-biosig-zarr.md at its merge commit}|$TEXT_URL|" > "$W/pr-body.md"
gh pr edit 2 -R nemarOrg/rfcs --body-file "$W/pr-body.md"
gh pr ready 2 -R nemarOrg/rfcs
gh pr checks 2 -R nemarOrg/rfcs --watch          # rfc-check must pass
gh pr merge 2 -R nemarOrg/rfcs --squash --match-head-commit "$(git rev-parse HEAD)"
git switch main && git pull --ff-only
curl -sI "$TEXT_URL" | head -1                    # must be a 200
```

The RFC is open from here.

## 4. Fill the announcement tokens

```bash
cd "$W"
for f in *.md *.json; do
  sed -e "s|{{CLOSE_UTC_ISO}}|$CLOSE_ISO|g" -e "s|{{CLOSE_UTC}}|$CLOSE|g" -e "s|{{THREAD_URL}}|$THREAD|g" "$f" > "out/$f"
done
grep -lE '[{][{](CLOSE_UTC|THREAD_URL)' out/* | grep -v monday.md   # must print nothing
block() { awk -v n="$2" '/^```text$/{c++; f=(c==n); next} /^```$/{f=0} f' "$1"; }
```

## 5. The announcements, in the order `news.md` gives

**News post on nemar.org.** Create it in the website's news form from `out/news.md`: the front matter fields, the body between the opening comment and the last `---`, `status: published`.

**Command-line notice** (shows to every account until the close):

```bash
nemar admin notice set \
  -m "$(jq -r .message out/cli-notice.json)" -l "$(jq -r .level out/cli-notice.json)" \
  -s "$(jq -r .scope out/cli-notice.json)" -e "$(jq -r .expires_at out/cli-notice.json)"
```

**Docs banner.** A pull request in nemarOrg/docs that adds the quote line of `out/docs-banner.md` under the front matter of `src/content/docs/formats/biosig-zarr.md`.

**Mail, rfcs category** (docs.nemar.org/admin/operations/community-mail-sends: dry run, canary, everyone; one subject for all three):

```bash
curl -s https://api.nemar.org/health             # 0.10.38 or later, again
SUBJECT="NEMAR RFC 0001: comments on the biosig-zarr format are open until $CLOSE UTC"
sed -n '/^<!-- BODY START -->$/,/^<!-- BODY END -->$/p' out/mail.md | sed '1d;$d' | sed '/^VARIANT B ONLY/d' > out/mail-body.md
grep -c 'VARIANT\|{{' out/mail-body.md            # 0

nemar admin notify --to all --category rfcs --subject "$SUBJECT" --body-file out/mail-body.md --dry-run
#   read: recipient count, "Audience by group", and no "A real send would be refused" line
nemar admin notify --to admins --category rfcs --subject "$SUBJECT" --body-file out/mail-body.md
#   open the delivered message: rendering, thread link, footer and unsubscribe link (do not press its button)
nemar admin notify --to all --category rfcs --subject "$SUBJECT" --body-file out/mail-body.md
nemar admin notify --status <ID printed above>
```

**Community notes** (`out/notes.md`): the EEGLAB list, the MNE Forum and Neurostars, each with its subject or title and its text block:

```bash
block out/notes.md 1 | pbcopy    # EEGLAB list body; subject is in out/notes.md section 1
block out/notes.md 2 | pbcopy    # MNE Forum
block out/notes.md 3 | pbcopy    # Neurostars
```

**LinkedIn**, from the personal account:

```bash
block out/linkedin.md 1 | pbcopy
```

**BIDS Google group** (groups.google.com/g/bids-discussion, a new topic):

```bash
block out/bids-google-group.md 1 | pbcopy        # subject
block out/bids-google-group.md 2 | pbcopy        # body
```

## 6. After posting

Tell the session that resumes the program (from the rfcs clone) the thread URL and the time of the mail send; it records O5 as done and starts the window's follow-up (A3, then C3 at the close).
