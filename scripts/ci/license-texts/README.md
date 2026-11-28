# Official Creative Commons legal code texts (ADR 0142)

`scripts/ci/license-file-fact.ts` compares a LICENSE that ScanCode matched to less than 100% of its license with the official text of that license here,
to tell which words of the official text the file lacks.

Each file is the `legalcode.txt` that creativecommons.org served on 2026-11-27, byte for byte.
`manifest.json` records, for each SPDX identifier, the file, the URL it was retrieved from and its SHA-256;
the parser refuses a file whose SHA-256 differs, and then sends the LICENSE whole, as before.

These texts are not under nemar-cli's license.
Creative Commons dedicates the text of its legal tools to the public domain under CC0 1.0:
each 4.0 text says so in its closing notice ("The text of the Creative Commons public licenses is dedicated to the public domain under the CC0 Public Domain Dedication"),
and https://creativecommons.org/policies/ says the same of the text of all Creative Commons legal tools, CC0 included.

To refresh a text, download it again from its URL, replace the file, update its SHA-256 in `manifest.json`, and run `bun test test/license-file-fact.unit.test.ts`.
