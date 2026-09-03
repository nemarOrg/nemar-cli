# ADR 0037: Make versus take is decided explicitly, in both directions

**Status:** accepted
**Date:** 2026-09-03
**Owner:** Seyed Yahya Shirazi

## Context

NEMAR has repeatedly faced the same question in different clothes:
build a piece ourselves, or lean on an established system.
Two past answers went opposite ways and both proved right.
DataLad was dropped early because keeping it would have required Python support in the CLI
and it added little over git-annex driven directly; that decision has paid off since.
The signal readers and the Zarr exporter were offloaded to biosigio,
which made the converter modular and let readers improve without touching this repo.
One answer went wrong: license handling was written three times as bespoke prose parsers
(CLI `detectLicense`, backend `licenseTier`, website `ccLicenseUrl`),
each drifting from the others and each wrong in its own way,
when SPDX already owns license identity and `spdx-correct` plus `spdx-license-list`
already normalise it in plain JavaScript (epic #1222).
The lesson is not "always take" or "always make";
it is that the choice was never written down, so it was never revisited.

## Decision

Every subsystem that could be served by an established library, standard, platform feature,
or NEMAR-family package (biosigio, neuroschema, nemar-tools) gets an explicit
replace, wrap, or keep verdict, recorded where the code lives or in an ADR when it closes off a path.
The test has two edges.
Take the established system when it owns the semantics
(a registry, a standard, a wire format, a platform primitive) and lives in the runtime we already ship.
Keep or drop when the alternative drags in a runtime, a service, or an operational surface
that costs more than the behaviour is worth, or when the behaviour is NEMAR policy
(the annex policy of ADR 0031, the Zarr coverage accounting, the live-data fences)
that no outside package can be expected to encode.

## Consequences

Reviews and design notes must name the established alternative, what it owns,
what would be lost, and the runtime it brings, before a bespoke implementation is accepted.
A periodic audit of both repositories for hand-rolled code that a maintained dependency already covers
is legitimate maintenance work, not gold-plating,
and its "keep" verdicts are as valuable as its "replace" verdicts.
The cost is a little more writing up front;
the gain is that the next agent or maintainer inherits the reasoning instead of rediscovering it.

## Alternatives considered

- **Prefer dependencies by default:** loses the DataLad lesson; a dependency that brings a runtime is not free.
- **Prefer bespoke by default:** produced the three license parsers; ownership of semantics we do not control is a liability.
- **Leave it to case-by-case judgment without a record:** is what we had; the license drift is the evidence against it.

## Receipts

- Epic #1222 (SPDX-based license handling across CLI, backend, and website) and the bugs it retires: #300, #1161, website#282.
- biosigio as the home of readers and the Zarr exporter (ADR 0029, ADR 0030).
- ADR 0031 for a policy that stays bespoke on purpose.
