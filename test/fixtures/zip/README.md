# ZIP fixtures

Archives for the ZIP reader (`shared/readers/zip.ts`; epic #2182, card A6).
Each is built from the repository's own EDF fixtures in `test/fixtures/identifier-scan/`
(`flagged.edf`, a header with identifying fields filled in, and `clean.edf`; both are synthetic headers written for this repository's tests),
so they carry the license of this repository and no outside data.
None holds a real person's data.

They were built on 2026-11-25 with Info-ZIP Zip 3.0 (the macOS build), with `TZ=UTC`, every file's time set to 2026-01-01 00:00 with `touch -t 202601010000`, and `-X -D` (no extra attributes, no directory entries).
The tree the commands run in:

| Path in the archive | Content |
|---|---|
| `README.txt` | The line `Archive built for the nemar-cli ZIP reader tests.` |
| `sub-Marlow/eeg/sub-Marlow_task-rest_eeg.edf` | `flagged.edf` (the label `Marlow` is a name-like word, so the path is a finding) |
| `sub-02/eeg/sub-02_task-rest_eeg.edf` | `clean.edf` |
| `sourcedata/session.xdf` | One line of text: an `.xdf` placeholder, never read (no reader is registered for `.xdf`) |

| File | Command | What it is used for |
|---|---|---|
| `edf-and-xdf.zip` | `zip -X -D edf-and-xdf.zip README.txt sub-Marlow/eeg/sub-Marlow_task-rest_eeg.edf sourcedata/session.xdf`, then `zip -X -D -0 edf-and-xdf.zip sub-02/eeg/sub-02_task-rest_eeg.edf` | A deflated inner EDF with findings, a stored clean one, and `zip:.xdf` |
| `nested.zip` | `cp edf-and-xdf.zip inner.zip; zip -X -D nested.zip inner.zip sub-02/eeg/sub-02_task-rest_eeg.edf` | A ZIP inside a ZIP: counted `zip:.zip`, never opened |
| `zip64.zip` | `zip -X -D -fz zip64.zip sub-Marlow/eeg/sub-Marlow_task-rest_eeg.edf` | ZIP64 end record and locator (the end record's directory offset is `0xFFFFFFFF`) |
| `encrypted.zip` | `zip -X -D -P throwaway-a6 encrypted.zip sub-Marlow/eeg/sub-Marlow_task-rest_eeg.edf` | Traditional PKWARE encryption; the throwaway password is `throwaway-a6` |
| `bomb.zip` | `uv run --no-project python -I make_bomb.py bomb.zip` | One deflated entry of 100 MiB of zeros whose headers declare 1 KiB |

`encrypted.zip` uses `-P` in place of `zip -e`: the same encryption, with the password on the command line rather than typed at a prompt.
`make_bomb.py` (beside this file) writes the archive with Python's `zipfile` and then overwrites the uncompressed size in the local header and the central directory entry with 1024.

SHA-256:

```
61f3170c9261d97c72e195920faf4e7f11442aa280130714c382c5ffb234c6f6  bomb.zip
fe164918aaeeddf2999831495e3d67e93ef8e795087fe1be521a44f07c5ea015  edf-and-xdf.zip
755513d64b63d4744c01a3f551aa6b7fbc1f5a2b7c5bd6a0c95235a1fef5f258  encrypted.zip
1b2d3d3157e9d1e381803719b25fb23430a07380aa838d318c5b94e31788b6aa  nested.zip
8ce61fc83298918b804179d07881f92b46d4b18011b41ac067c3e9a956625bcd  zip64.zip
```

Archives a stock tool does not write (an unsupported method, a declared size past the entry cap, a split archive, tens of thousands of entries) are built byte for byte inside `test/readers-zip.test.ts`.
