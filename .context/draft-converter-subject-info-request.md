# Draft: asking converter projects to clear subject info before export

Status: DRAFT for the maintainer (epic #1610, Phase 3, issue #1613).
Nothing here has been filed anywhere.
It is written to be posted as an issue (or a discussion) on MNE-BIDS and on MOABB, with the same body and one tailored paragraph each.

## Before sending: what the maintainer must check

1. **Fill the counts from the re-run.**
   The body leaves them as placeholders on purpose.
   The first fleet pass of 2026-10-04 is superseded (correction comment on #1610), and the epic says no count is to be quoted again until the fleet scan is re-run.
   Use the re-run's numbers, or send the request without numbers.
2. **Confirm the mechanism for at least one dataset per project.**
   We have not established which tool wrote which file.
   The paragraphs on each project say what we believe the path is; confirm it, or soften it to a question, before sending.
3. **Name no dataset and no upstream source.**
   The identifiers came from upstream releases that are still public.
   Naming a dataset, a lab or a source archive points readers at copies that still carry names.
   The body below names none and must stay that way.
4. **Quote no value and no field detail beyond the format's field names.**
   "The EDF patient identification field" is the format; anything more specific is about a person.
5. **Send it after the release that ships the upload preflight and the publication screen.**
   The body says both are in place.

## Body (shared)

> **Title:** Clear subject identification in EDF/BDF headers by default on export
>
> NEMAR (nemar.org) archives EEG, MEG, EMG and iEEG datasets in BIDS.
> Much of what it holds re-shares data that other groups released publicly, and much of that went through MNE-BIDS, MOABB, or both, on its way to BIDS.
>
> We recently read the fixed 256-byte header of every EDF and BDF file in every public NEMAR dataset.
> Counts only (the placeholders are filled from the fleet re-run before this is posted):
>
> - public datasets read: [RE-RUN COUNT]
> - datasets with a finding that names or dates a person (a name, a birth date finer than the year, a record number, or an identifying column or key): [RE-RUN COUNT]
> - datasets whose EDF/BDF patient identification field holds name-like text that differs from participant to participant: [RE-RUN COUNT]
> - of those, datasets that are re-shares of data first released elsewhere: [RE-RUN COUNT]
>
> For the dataset we traced back, a header read from inside the original release was byte-identical to ours.
> So, there at least, the export or copy step did not add the names.
> It carried them forward, and nothing in it flagged them.
>
> We are fixing our side.
> Uploads to NEMAR now screen these headers before anything is sent, and publication screens them again.
> Our own Zarr converter no longer writes subject fields at all.
> But the cheapest place to stop this is the export step, before a file leaves the machine of the person converting it.
>
> **The request:**
>
> 1. When writing or copying an EDF or BDF file into a BIDS dataset, clear the subject identification by default.
>    That means the EDF+ patient fields (code, sex, birth date, name) and any name in the recording field, written as the specification's `X` placeholders.
>    Keep them only when the caller asks explicitly.
> 2. Failing that, warn when the header being written carries a name or a full birth date.
>    The warning should name the field and never print its value.
> 3. Document the behavior where users choose the output format, since a user converting to EDF/BDF for compatibility rarely expects personal data to travel in the header.
>
> We are glad to share the scanner we use (deterministic, no values in its output) and to test a change against our corpus.

## Paragraph for MNE-BIDS

> As we understand it, `write_raw_bids` copies an EDF or BDF input as it is.
> Its header is rewritten only when `anonymize` is passed.
> And when it converts to EDF or BDF, the export writes `info["subject_info"]` into the header.
> Either way, names in the source arrive in the BIDS copy unless the user knew to ask otherwise.
> Making the anonymized header the default for these two formats would cover the case we keep finding.
> Please correct us if we have the code path wrong.

## Paragraph for MOABB

> As we understand it, MOABB's BIDS conversion writes EDF through MNE-BIDS, from a `Raw` whose `subject_info` comes from the original files.
> Clearing `subject_info` (`raw.anonymize()`, or setting it to None) before the write would keep source names out of every dataset MOABB caches or exports.
> Please correct us if the conversion path is different.

## Where this came from

- Epic #1610 (fleet scan result, the note on severity, and the correction), issue #1613.
- ADR 0085 (the scrub), ADR 0086 (the publication screen), ADR 0087 (the upload preflight).
- NEMAR's own converter change: #1626 and #1627 (subject info is excluded from every Zarr store).
