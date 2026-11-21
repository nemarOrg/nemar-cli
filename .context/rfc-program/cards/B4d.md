# Card B4d: RFC-0001 cites the measured back catalog

Status: ready
Tier: worker
Timebox: S, 1 hour; escalate at 2 hours or two failed approaches
Needs: none
Depends: S1 done (nemarOrg/nemar-cli#2289, merged as c48405fe), B4c done (head 0e4947c7 of the RFC-0001 draft)
Branch: rfc/0001-biosig-zarr (the open draft PR nemarOrg/rfcs#2; no new branch)
Worktree: /Users/yahya/Documents/git/nemar/rfcs
Plan: /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/rfc-program/.context/rfc-program/plan.md, sections 2, 3 (lead decision 10) and 4

## Goal

The RFC-0001 draft (nemarOrg/rfcs#2) replaces its promise to count the affected recordings with the counts S1 measured,
labels the one inferred finding as inferred, links the evidence through a public tag (`rfc-0001-evidence`, at commit c48405fe),
shows what the interim EDF+D refusal (neuromechanist/biosigio#180, step 1) concerns in the catalog,
and dates the `2.0.2` release correctly in "History of the format",
so the owner opens RFC-0001 with the measured impact on the back catalog stated, not promised.

## Context

S1 (`.context/rfc-program/evidence/s1-catalog.md`, merged in nemarOrg/nemar-cli as c48405fe) measured, read-only, the sources of the public catalog that can carry a gap.
RFC-0001 line 150 at 0e4947c7 still says "We have not yet counted how many recordings NEMAR holds are affected", and lead decision 10 (`plan.md` section 3) says the RFC cites the interim EDF+D fix and S1 counts the affected stores.
The lead (2026-11-21, owner's P4) decided which figures the RFC cites:

1. **The 36 BrainVision recordings with a negative total gap are not a measured gap.**
   A negative total means the segment dates span less time than the samples recorded, so the dates overlap or step backward; that is not a stretch without samples.
   21 of the 36 are under 1 second in size (from -0.82 s to -0.0002 s), and the other 15 are whole-second backward steps, up to -200 s, in one derivative pipeline of `on005127` (`brainvision-recordings.json`); S1 calls them "not a verified gap".
   So the RFC cites 978 stores (sources in 36 datasets), not 997 (37); the 36 recordings' 19 stores count as "can be discontinuous", tied to question 18, which already asks about overlapping segments and clocks that step backward.
2. **The 528 undated multi-segment BrainVision recordings count as "can be discontinuous", never as a measured gap.**
   Several "New Segment" markers mean the recorder restarted or files were joined, and without dates a gap can be neither measured nor excluded; version 3 maps them to intervals with `source_time: null` (question 21).
   The RFC cites S1's row without the known non-gaps (1,525 stores, sources in 56 datasets), not the "all" row (3,217 stores, 68 datasets):
   1,715 of the "all" row's 3,509 recordings are measured non-gaps (1,626 gapless EDF+D files, 86 epoched and 3 contiguous BrainVision recordings), so citing it would overstate.
   1,525 is 978 plus 528 plus 19 (arithmetic).
3. **`nm000411` does not matter for the RFC.**
   Its 14 EDF+D files are measured contiguous, so it is in no cited figure, and the catalog counts no stores for it.
   The owner is filing a nemar-cli issue for it (see "Owner answers"); this card does nothing about it.
4. **What the RFC cites, and where:** one sentence in "Summary", a paragraph replacing line 150 in "Problem", one sentence each on the re-conversion and the interim refusal bullets of "Rollout and cost", one reference line, and one change log line.
   Every figure is measured in S1, except the 0.42% (arithmetic on two measured numbers) and the two dropped gaps in `nm000456` (inferred from the index's `duration_s`, and labeled so).
   Not cited: the throughput and coexistence projections (computed from version 2 last-conversion dates, which S1 calls neither a floor nor a ceiling; version 3 throughput was not measured), gap-size statistics, licenses, and the 997, 1,265, 3,217 and 3,509 figures.
   The evidence link goes through the tag `rfc-0001-evidence` in nemarOrg/nemar-cli, which points at c48405fe (owner, 2026-11-21), so it stays alive whatever happens to `feature/rfc-program`; the References line also names the commit.
   On 2026-11-21 the blob and raw URLs through the tag answered HTTP 200 without authentication, and the raw file's SHA-256 matched the committed file (`78619e8e...44080ea`).
5. **B4c's review item is taken**: the "2, independent" row keeps 2026-11-20 in its date column, and its text takes the reviewer's wording verbatim after the cell's first sentence, "No change to stores or to the text.", which stays because `2.0.2` leaves `spec/index.md` unchanged (text line 106) and matches the "2, moved" row.
   Release `2.0.2` was published 2026-11-21T18:18:19Z (`gh release view 2.0.2 -R nemarOrg/biosig-zarr`).

Run `git -C /Users/yahya/Documents/git/nemar/rfcs fetch origin && git -C /Users/yahya/Documents/git/nemar/rfcs switch rfc/0001-biosig-zarr && git -C /Users/yahya/Documents/git/nemar/rfcs pull --ff-only` before editing.
The PR stays a draft, with `opened_at` null; nobody merges it until the owner opens the RFC.

## Scope

`text/0001-biosig-zarr.md`, the index lines in `README.md` if `rfc-check` regenerates them, and the PR body (the opening post).

## Decided design

Settled (text line numbers at head 0e4947c7; edit from the bottom up, or find each anchor by its text). Every quoted line below is exact.

- **Summary, a new line after line 52** (the "First, ..." line), before the "Second, ..." line:

  ```text
  At least 978 of the stores NEMAR serves were converted from a source with a measured gap (see "Problem").
  ```

- **Problem, line 150** ("We have not yet counted how many recordings NEMAR holds are affected; ..."), replaced by these eight lines; line 149 ("The reproduction used synthetic files.") stays:

  ```text
  We then scanned the source files of NEMAR's public datasets for gaps, read-only, on 2026-11-20 and 2026-11-21 ([the count, with its method and raw outputs](https://github.com/nemarOrg/nemar-cli/blob/rfc-0001-evidence/.context/rfc-program/evidence/s1-catalog.md)).
  36 datasets hold sources with a measured gap, and 978 of the 231,259 stores (0.42%) were converted from those sources:
  777 from BrainVision recordings whose dated "New Segment" markers lie further apart than the samples between them (a few, with gaps under 0.1 s, are weak evidence), 199 from FIF files with acquisition skips, and 2 from EDF+D files with gaps.
  547 more stores come from sources that can be discontinuous where the markers do not settle it:
  528 from BrainVision recordings with several undated segments (question 21), and 19 from BrainVision recordings whose segment dates overlap or run backward (question 18).
  We did not test which of these stores keep the gap.
  For the two EDF+D stores, the serving index gives each a duration shorter than the start time of the source's last record, which suggests that the gap was dropped; this is inferred from the index, and the stores' samples were not read.
  The counts are lower bounds: only 952 of the 12,164 FIF files were measured, 195 BrainVision marker files were missing from the listing or unreadable, and compressed FIF files and EEGLAB, XDF, Neuroscan and General Data Format files were not scanned.
  ```

  "General Data Format" is spelled out without its abbreviation on purpose: line 503 defines "GDF", and it must stay the first use.
- **Rollout and cost, a new line after line 962** (the first line of the re-conversion bullet, "NEMAR re-converts its stores through the normal queue, ..."), before line 963 ("The cost is the compute ..."), indented two spaces as part of that bullet:

  ```text
    By the count under "Problem", that first set is at least 1,525 stores, whose sources are in 56 datasets.
  ```

- **Rollout and cost, a new line after line 964** (the biosigio#180 bullet), indented two spaces as part of that bullet:

  ```text
    In the catalog counted under "Problem", that refusal concerns one dataset: 102 of the 1,728 EDF+D files have gaps, all in `nm000456` (51 recordings, each present twice in the dataset), the other 1,626 are labeled discontinuous but have none, and none of the 66,340 BDF files is BDF+D.
  ```

- **History of the format, line 981**, becomes exactly:

  ```text
  | 2, independent | 2026-11-20 | No change to stores or to the text. The specification became independent of NEMAR on this date, with the biosig-zarr contributors as the copyright holder; released as `2.0.2` on 2026-11-21. | biosig-zarr ADR 0005; release `2.0.2`. |
  ```

- **References, a new line after line 1015** (the gap defect):

  ```text
  - The count of the back catalog's discontinuous sources: <https://github.com/nemarOrg/nemar-cli/blob/rfc-0001-evidence/.context/rfc-program/evidence/s1-catalog.md> (tag `rfc-0001-evidence`, commit `c48405fe`)
  ```

- **Change log, a new line after line 1025**:

  ```text
  - 2026-11-21: counts the served stores whose source has a measured gap or can be discontinuous, from a read-only scan of the back catalog, and dates the `2.0.2` release in "History of the format".
  ```

- **The PR body**: in the opening paragraph, after the sentence that ends "for agentic research.", insert the sentence "At least 978 of those stores were converted from a source with a measured gap." on the same line (GitHub text keeps each paragraph on one line);
  and append one revision entry, headed `**B4d: the back catalog count**` with its commit hashes, that names the changes above and quotes the gates run on head.
  Every other line of the body stays.
- Not changed: every other line of the text, including line 264 ("Gaps (EDF+D, FIF skips, BrainVision segments) and source resolution affect data NEMAR already holds"), line 517 (the back catalog bullet), and lines 1003 to 1007 (the `format_version` of the stores is still not measured).

The implementer may choose: the wording of the PR body's revision entry, and nothing else.

## Acceptance

On the branch, in `/Users/yahya/Documents/git/nemar/rfcs`, with `F=text/0001-biosig-zarr.md`:
`bun run src/check.ts` exits 0.
`grep -c "We have not yet counted" $F` prints 0.
`grep -c "At least 978 of the stores NEMAR serves were converted from a source with a measured gap" $F` prints 1.
`grep -c "978 of the 231,259 stores (0.42%)" $F` prints 1, `grep -c "547 more stores" $F` prints 1, and `grep -c "at least 1,525 stores, whose sources are in 56 datasets" $F` prints 1.
`grep -c "inferred from the index" $F` prints 1, and `grep -c "only 952 of the 12,164 FIF files were measured" $F` prints 1.
`grep -c "102 of the 1,728 EDF+D files have gaps" $F` prints 1, `grep -c "each present twice in the dataset" $F` prints 1, and `grep -c "stored twice" $F` prints 0.
`grep -c "(a few, with gaps under 0.1 s, are weak evidence)" $F` prints 1.
`grep -c "blob/rfc-0001-evidence/.context/rfc-program/evidence/s1-catalog.md" $F` prints 2, and `grep -c "c48405fe" $F` prints 1 (the References line).
`grep -c -E "997|1,265|3,217|3,509|0\.43%" $F` prints 0.
`grep -c "(question 18)" $F` prints 2 (line 504 at 0e4947c7 already has one, and the Problem block adds one), and `grep -c "(question 21)" $F` prints 1.
`grep "GDF" $F | head -1 | grep -c "(GDF)"` prints 1 (no use before the definition).
`grep -c "| 2, independent | 2026-11-20 | No change to stores or to the text. The specification became independent of NEMAR on this date, with" $F` prints 1,
`grep -c "holder; released as .2.0.2. on 2026-11-21\. | biosig-zarr ADR 0005" $F` prints 1, and `grep -c "and was released as .2.0.2." $F` prints 0.
`grep -c "^- 2026-11-21: " $F` prints 2.
`gh pr view 2 -R nemarOrg/rfcs --json isDraft -q .isDraft` prints `true`;
`gh pr view 2 -R nemarOrg/rfcs --json body -q .body | grep -c "At least 978 of those stores were converted from a source with a measured gap."` prints 1, and the same with `"B4d: the back catalog count"` prints 1.
`git diff --name-only 0e4947c7...HEAD | grep -c -v -E "^(text/0001-biosig-zarr.md|README.md)$"` prints 0.

## Gates

`bun install && bun run lint && bun test && bun run src/check.ts`, all exiting 0, and `uvx typos text/` exits 0.

## Stop conditions

The branch head is not 0e4947c7 or a descendant of it with only reviewed commits;
`git ls-remote https://github.com/nemarOrg/nemar-cli.git refs/tags/rfc-0001-evidence` does not print `c48405fe0ad8e4a005dea123a0fa668b40af6ab1`, or `curl -s -o /dev/null -w "%{http_code}" https://raw.githubusercontent.com/nemarOrg/nemar-cli/rfc-0001-evidence/.context/rfc-program/evidence/s1-catalog.md` does not print 200;
the file at that URL does not hold both rows `| Real discontinuity, without the 36 negative-total recordings | 1,229 | 36 | 978 |` and `| Can be discontinuous, without the known non-gaps (note 2) | 1,794 | 56 | 1,525 |` (check with `curl -s` of that URL piped to `grep -c -F`, each printing 1);
an anchor line above does not hold the text this card quotes for it;
a change seems to weaken an owner decision in `plan.md` section 2, or to need a change beyond Scope.

## Report

Your final message is the report, at most 25 lines: PR number and the new head commit hash; gates run with their quoted last lines; each changed line, briefly; deviations from this card; questions for the owner.

## Owner answers

Recorded 2026-11-21 (owner, `board-log.md` Decisions): P4 accepted, a lead agent answers S1's questions, picks the figures RFC-0001 cites, and writes this card;
RFC-0001 is to be a solid, working draft, opened quickly, without overthinking.

Answered 2026-11-21 (owner, relayed by the coordinator) on the lead's two notes:
the owner tagged c48405fe as `rfc-0001-evidence` in nemarOrg/nemar-cli, and the RFC links the evidence through that tag;
the owner is filing a nemar-cli issue for `nm000411`, which serves no stores (`zarr_status` failed since 2026-10-18), so this card does nothing about it.
