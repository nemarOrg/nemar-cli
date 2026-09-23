# ADR 0071: The browser recipe leads with the read in physical units

**Status:** accepted
**Date:** 2026-09-22
**Owner:** Seyed Yahya Shirazi

## Context

ADR 0070 made `nemar_read_window`'s `python_browser` lane name eegprep-lean
and read the recipe's `array_path` with `open_array` and `getitem`.
That read returns the stored digital counts.
A model follows the code rather than the comment beside it,
so it plotted counts that look like EEG and are wrong, and nothing raised:
OpenScience-Collective/osa's assistant was told to do exactly that
(osa#432, found in its phase 3 review).
`read_window` returns physical units with channel labels,
but it needs the dataset's index,
and `read_index` builds that URL from production's host,
so a recipe that called it plainly would send a dev or staging server's reader to production.

## Decision

At level 0, `python_browser` leads with the read in physical units:
`read_index(<id>, index_url=<contract_base>index.json)`, `index.store(<path>)`,
`store.group(<group>)`, then `read_window`.
The raw `open_array` read of `array_path` follows it as the alternative,
and at a view level, which `read_window` does not read, it is the only read.
Every value written into the snippet is a quoted literal from `JSON.stringify`.

ADR 0070's verdict is unchanged: the lane names eegprep-lean,
calls its asynchronous API, and carries no install line.

## Consequences

The first read a model meets is the correct one, and it reads the environment that served the recipe.

The lead now fetches the dataset's `index.json` once before reading the window.
Measured 2026-09-22 on zarr.nemar.org, which serves it compressed:
nm000103, with 3,522 stores, is 2.7 MB of JSON and 98 KB on the wire;
on005506 is 1.1 MB and 40 KB;
nm000219 is 14 KB and 1.4 KB.

The recipe now needs eegprep-lean 0.1.0.dev2 or later, for `index_url` (sccn/eegprep#416),
and says so in the snippet.
A runtime pinning 0.1.0.dev1 fails at that keyword with a `TypeError` naming it,
which is loud rather than silent;
OSA vendors 0.1.0.dev2 before its browser lane is live anywhere.

`store.path` and group names are free-form strings in the index schema,
and they are now written into code a client runs, which is why every value is escaped.

## Alternatives considered

- **Keep the raw read first, with a comment pointing at `read_window`.** That was the state this replaces, and the comment was not enough.
- **Build the index and store objects inline from the recipe's fields.** It saves the index fetch, but the snippet would spell out eegprep-lean's dataclasses by field, which is its internals rather than its API.
- **`read_index(<id>)` with the default URL.** Right in production and wrong everywhere else, silently.

## Receipts

- ADR 0070, whose lane this refines; ADR 0069, the package split.
- sccn/eegprep#415 and #416, the `index_url` argument.
- The emitted recipe for nm000103, run verbatim on CPython with eegprep-lean 0.1.0.dev2 against the live archive:
  (129, 500) in uV at 250 Hz from `read_window`, int16 counts from the raw read.
