#!/usr/bin/env -S uv run --quiet --python 3.12 --with mcp>=2.2,<3 python3
"""End-to-end verification of the NEMAR MCP server from a real Python MCP client
(epic #1065 phase 5, issue #1297).

WHY THIS EXISTS, three reasons, none of which the TypeScript tests cover:

 1. **It proves the transport works for the clients that will actually use it.**
    `backend/scripts/mcp-smoke.sh` drives the server with raw `curl` against a
    local workerd, which checks our own framing. It says nothing about whether a
    real MCP SDK, doing its own content negotiation and protocol handshake,
    can talk to us. OSA's assistant speaks the Python SDK, so this is the
    client that has to work.
 2. **It is the reference the docs page copies from.** Every example on
    `docs.nemar.org`'s MCP page comes from a real session captured here, not
    from the design doc. A doc that describes something the server does not do
    is worse than no doc.
 3. **It is the standing check for a deploy.** The MCP hostnames are
    `custom_domain = true` routes, so `mcp-test.nemar.org` and
    `mcp.nemar.org` come into existence when a deploy provisions them. Run
    this against staging after the epic reaches `dev`, and against production
    after the release.

THE DESIGN RULE FOR EVERY CHECK BELOW. This is a gate, so the two ways it can
mislead are reporting a pass it has not earned and reporting a failure that is
not real. Both are worse than being noisy, so:

 - No check may pass because a collection was empty or a field was absent.
 - No transport failure may be read as a server refusal. A 429 or a 502 means
   "we got no answer", never "the server correctly said no".
 - A documented, contract-correct refusal is not a failure. Some tools are
   v3-index-only and decline a legacy index in words the contract wrote for
   them; a gate that calls that broken during a cutover is worse than useless.
 - A caveat the server volunteers (`note`) is surfaced, never swallowed. The
   server saying it is degraded while this script prints an unbroken column of
   PASS is the exact shape of a check nobody should trust.

USAGE (from the repo root):
  scripts/mcp/verify_streamable_http.py
  scripts/mcp/verify_streamable_http.py --url https://mcp.nemar.org/mcp
  scripts/mcp/verify_streamable_http.py --dataset nm000329 --verbose

For a RELEASE gate pass `--dataset`, so consecutive runs compare like with like.
Without it the subject is discovered from a live search, which is convenient but
lets the subject rotate between runs and between hosts.

Exits non-zero on a failed check. Notes do not fail the run, but they are counted
and the closing line says how many there were.

NOT CI-GATED, on purpose and worth knowing. `scripts/mcp/` matches no path
filter in `.github/workflows/test.yml`, so nothing here is linted or executed by
CI -- the same footing as `backend/scripts/mcp-smoke.sh` and
`backend/scripts/read-window-memory.ts`. It is an operational script whose whole
job is to talk to a live host, which CI has none of.

SO IT WAS VALIDATED BY HAND, and here is the method, because a gate nobody has
seen fail is not a gate. A local `MCPServer` stand-in implemented all six tools
with payloads copied from `shared/contract/mcp.ts`, plus a `BREAK` environment
variable that made exactly one thing non-conformant per run. Twelve injections,
each confirmed to produce the intended verdict and no other: a dropped required
envelope field; a null in a non-nullable one; `lossy: false`; `datasets` instead
of `results`; a `describe_dataset` echoing a different id; a v1 index; a group
with no pyramid; an out-of-enum `get_events` source; a `render_overview` with no
image block; an over-cap taste ACCEPTED; an all-fill-value taste; and a taste
missing `filled_ranges`. Ten fail with a message naming the cause, and the two
that are the server being honest rather than broken (all-fill values, and a
legacy index reported as such) exit 0 with a note or fail at subject selection
naming each candidate's reason. The entry path was validated through a BARE
host, so the missing-`/mcp` case this script shipped with in review is covered
by the check that found it.

One thing that stand-in could NOT reproduce, and how it was covered instead: the
Python SDK masks a raised tool exception's text, so the real refusal message had
to come from the TypeScript side. `backend/test/mcp-route.test.ts` asserts the
wire shape this script depends on -- an over-cap taste answers `isError` with a
text block naming the cap and the recipe remedy -- and the stand-in was given
that captured string verbatim.

SDK NOTES, verified against `mcp` 2.2.0 by introspection rather than recall.
`Client("<url>")` speaks Streamable HTTP, and the URL must carry the transport
PATH: `/` on this server is a GET-only descriptor, so a POST there answers `Not
Found`, which during a cutover reads exactly like an unprovisioned hostname.
This is deliberately NOT `langchain-mcp-adapters`: that package pins
`mcp<2.0.0` and so cannot negotiate the 2026-07-28 revision this server
implements (design doc section 11). In 2.x the server-side class was renamed
from `FastMCP` to `MCPServer`, and result fields are snake_case on the Python
side (`structured_content`, `is_error`) while the wire keeps `structuredContent`.
Both a tool error and an input-schema rejection arrive as `is_error=True` rather
than raised, because `Client.raise_exceptions` defaults to False.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any, NoReturn
from urllib.parse import urlparse

from mcp import Client
from mcp.types import CallToolResult

#: The Streamable HTTP transport path. Not optional: see the SDK note above.
TRANSPORT_PATH = "/mcp"
DEFAULT_URL = f"https://mcp-test.nemar.org{TRANSPORT_PATH}"

#: Every tool the server is expected to register. A missing one is a deploy that
#: did not carry the phase that added it; an EXTRA one is equally interesting,
#: so this is compared as a set both ways rather than with a subset check.
EXPECTED_TOOLS = {
    "search_datasets",
    "describe_dataset",
    "list_recordings",
    "get_events",
    "render_overview",
    "read_window",
}

#: The revision the server implements (`shared/contract/mcp.ts`). A client that
#: negotiates something older still works -- the server serves both eras from
#: one endpoint -- so this is REPORTED rather than asserted, and only flagged.
EXPECTED_PROTOCOL = "2026-07-28"

#: The fields `provenanceEnvelopeSchema` makes REQUIRED. Spot-checking three of
#: them, as an earlier draft of this script did, lets a build that dropped the
#: other eleven pass clean, so the whole set is asserted. `sss`, `units_report`
#: and `note` are deliberately absent: the contract marks those optional.
ENVELOPE_REQUIRED = (
    "dataset_id",
    "doi",
    "license",
    "citation",
    "source_commit",
    "index_etag",
    "engine_version",
    "source_tree",
    "derived",
    "lossy",
    "dtype",
    "effective_rate_hz",
    "source_rate_hz",
    "zarr_verify_status",
)

#: Of those, the ones the contract does not allow to be null. The rest are
#: `.nullable()` -- a dataset with no DOI is a real, valid state -- so `None`
#: there must not fail.
ENVELOPE_NON_NULL = (
    "dataset_id",
    "source_commit",
    "engine_version",
    "source_tree",
    "derived",
    "lossy",
    "zarr_verify_status",
)

#: How many search hits to consider when hunting for a subject the v3-only tools
#: can actually be driven against.
CANDIDATE_LIMIT = 8

#: Caveats the server volunteered during the run. Printed again at the end.
NOTES: list[str] = []


class CheckFailed(Exception):
    """A verification check failed. Carries a caller-facing explanation."""


def ok(label: str, detail: str = "") -> None:
    print(f"PASS  {label}{f' -- {detail}' if detail else ''}")


def note(message: str) -> None:
    """Something an operator should see that is not a failure. Counted, and
    repeated in the closing line, so a run with notes cannot be mistaken for a
    clean one by someone who reads only the last line."""
    NOTES.append(message)
    print(f"NOTE  {message}")


def fail(label: str, detail: str) -> NoReturn:
    """`NoReturn` is load-bearing, not decoration: it is what lets a type
    checker narrow the value a caller just rejected (an envelope that failed
    `isinstance`, say) instead of carrying `| None` past the guard."""
    raise CheckFailed(f"{label}: {detail}")


def _leaves(err: BaseException) -> list[BaseException]:
    """Flatten a (possibly nested) ExceptionGroup into its non-group leaves.
    The nesting is real rather than defensive: the SDK wraps a client-body
    exception in a task group, and a transport failure arrives as a group
    inside a group."""
    if isinstance(err, BaseExceptionGroup):
        out: list[BaseException] = []
        for inner in err.exceptions:
            out.extend(_leaves(inner))
        return out
    return [err]


def error_text(result: CallToolResult) -> str:
    """Every text block joined, not just the last one. A multi-block refusal
    otherwise surfaces an arbitrary fragment of its own explanation."""
    parts = [text for text in (getattr(b, "text", "") for b in result.content) if text]
    return " ".join(parts)


def structured(result: CallToolResult, label: str) -> dict[str, Any]:
    """The tool's `structuredContent`, with a tool error turned into a failure
    that quotes the server's own message -- these are written to be read by a
    human and name the workaround, so echoing them beats paraphrasing.

    Any `note` the payload carries is surfaced here, once, for every tool.
    """
    if result.is_error:
        fail(label, f"tool returned isError with: {error_text(result)[:400]}")
    if result.structured_content is None:
        fail(label, "no structuredContent on a successful result")
    payload = dict(result.structured_content)
    if payload.get("note"):
        note(f"{label} reported: {payload['note']}")
    return payload


def check_envelope(payload: dict[str, Any], label: str, *, required: bool) -> None:
    """Assert the provenance envelope, whose absence is the failure mode this
    server exists to avoid.

    `required` mirrors the contract rather than being applied uniformly.
    `envelope` is `.optional()` on `list_recordings`, `get_events` and
    `render_overview`, because an index carrying no usable 40-hex
    `source_commit` cannot produce one and those tools return a `note` saying so
    instead (`backend/src/mcp/envelope.ts`). It is required on both
    `read_window` modes. Failing hard everywhere would report "provenance is
    missing" -- the most alarming message this server can emit -- against an old
    index behaving exactly as designed.
    """
    envelope = payload.get("envelope")
    if envelope is None:
        if required:
            fail(label, "no provenance envelope, which this tool's contract requires")
        note(
            f"{label} returned no envelope, expected when the index carries no usable "
            f"source_commit (payload note: {payload.get('note') or 'none'})"
        )
        return
    if not isinstance(envelope, dict):
        fail(label, f"envelope is {type(envelope).__name__}, not an object")
    missing = [field for field in ENVELOPE_REQUIRED if field not in envelope]
    if missing:
        fail(label, f"envelope is missing required field(s): {', '.join(missing)}")
    nulls = [field for field in ENVELOPE_NON_NULL if envelope.get(field) is None]
    if nulls:
        fail(label, f"envelope has null in non-nullable field(s): {', '.join(nulls)}")
    if envelope["source_tree"] != "raw":
        fail(label, f"envelope source_tree is {envelope['source_tree']!r}, must be 'raw'")
    if envelope["lossy"] is not True:
        # A constant fact about the serving copy, not a per-store measurement:
        # every level-0 array is int16-quantized and rate-capped. A False here
        # means the honesty flag has regressed, not that a store is lossless.
        fail(label, f"envelope lossy is {envelope['lossy']!r}, must be True")
    if envelope.get("derived") and "sss" not in envelope:
        fail(label, "envelope says derived=true but carries no sss provenance")


def usable_group(recording: dict[str, Any]) -> dict[str, Any] | None:
    """The first group every tool in the chain can actually be driven against.

    Two requirements, both taken from what the tools themselves demand rather
    than guessed. `render_overview` reads the `view/*` pyramid and NEVER level 0,
    so it declines a group with no pyramid in so many words
    (`backend/src/mcp/tools/render-overview.ts`) -- hence `n_view_levels`, which
    is null or 0 for a v1 group and for a v3 group converted before biosigio
    1.2.6. And a taste needs at least one channel to ask for.

    Note what is NOT required: sharding geometry. `recordingGroupSummarySchema`
    publishes no `chunk_samples`/`shard_samples` -- `read_window` reads the
    array metadata itself -- so screening on those would reject every group ever
    returned and fail the run for a reason that has nothing to do with the
    server.

    Scanning beats taking `groups[0]`, which fails against a perfectly valid
    recording whose first group happens to lack a pyramid.
    """
    for group in recording.get("groups") or []:
        if not group.get("name"):
            continue
        if not group.get("n_view_levels"):
            continue
        if not group.get("n_channels"):
            continue
        return group
    return None


async def pick_subject(
    client: Client, explicit: str | None
) -> tuple[str, dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Choose the dataset, recording and group the rest of the chain runs
    against, returning `(dataset_id, list_recordings payload, recording, group)`.

    Why this searches instead of taking the first hit: `has_zarr` means
    CONVERTED, explicitly not "index v3" (`shared/contract/mcp.ts`), so a
    legacy-index dataset is a legitimate hit that the v3-only tools would
    correctly decline while a naive gate called it a failure. `list_recordings`
    also defaults to `include_derived: false`, so an all-SSS MEG dataset returns
    an empty page with a non-zero `excluded_derived_count`: data deliberately
    excluded, not data missing.
    """
    if explicit:
        candidates = [explicit]
    else:
        search = structured(
            await client.call_tool(
                "search_datasets", {"has_zarr": True, "limit": CANDIDATE_LIMIT}
            ),
            "search_datasets",
        )
        # `results` is this tool's output field. `datasets` is catalog.json's,
        # and accepting either would silently bless a contract violation.
        if "results" not in search:
            fail("search_datasets", "payload has no 'results' key, which the contract requires")
        hits = search["results"]
        if not hits:
            fail(
                "search_datasets",
                "has_zarr=true matched nothing on this host. On staging the dev catalog is "
                "purged to a handful of exemplars, some deliberately without zarr stores, so "
                "pass --dataset naming one that has a v3 index",
            )
        ok("search_datasets", f"{len(hits)} hit(s), count={search.get('count')}")
        candidates = [hit["dataset_id"] for hit in hits if hit.get("dataset_id")]
        if not candidates:
            fail("search_datasets", "no hit carried a dataset_id")

    skipped: list[str] = []
    for dataset_id in candidates:
        payload = structured(
            await client.call_tool("list_recordings", {"dataset_id": dataset_id, "limit": 10}),
            "list_recordings",
        )
        version = payload.get("index_format_version")
        if version != 3:
            skipped.append(f"{dataset_id} (index v{version}, so the v3-only tools decline it)")
            continue
        recordings = payload.get("recordings") or []
        if not recordings:
            skipped.append(
                f"{dataset_id} (empty page, excluded_derived_count="
                f"{payload.get('excluded_derived_count')})"
            )
            continue
        for recording in recordings:
            group = usable_group(recording)
            if recording.get("zarr") and group:
                return dataset_id, payload, recording, group
        skipped.append(f"{dataset_id} (no group with a view/* pyramid)")

    fail(
        "subject selection",
        "no candidate offered a v3 index with a usable group. Tried: " + "; ".join(skipped),
    )


async def run(url: str, dataset: str | None, verbose: bool) -> None:
    print(f"url: {url}")

    async with Client(url) as client:
        # --- transport and handshake ------------------------------------
        info = client.server_info
        ok(
            "connected over Streamable HTTP",
            f"{getattr(info, 'name', '?')} {getattr(info, 'version', '?')}",
        )
        negotiated = client.protocol_version
        if negotiated == EXPECTED_PROTOCOL:
            ok("protocol revision", negotiated)
        else:
            # Not a failure: the server deliberately serves the 2025 era too.
            note(f"protocol revision is {negotiated}, expected {EXPECTED_PROTOCOL}")

        # --- tools/list, and its cache hint ----------------------------
        listed = await client.list_tools()
        names = {tool.name for tool in listed.tools}
        if names != EXPECTED_TOOLS:
            fail(
                "tools/list",
                f"missing={sorted(EXPECTED_TOOLS - names) or 'none'} "
                f"unexpected={sorted(names - EXPECTED_TOOLS) or 'none'}",
            )
        for tool in listed.tools:
            if not tool.input_schema:
                fail("tools/list", f"{tool.name} has no inputSchema")
        ok("tools/list", f"all {len(EXPECTED_TOOLS)} tools present, each with an inputSchema")
        if listed.ttl_ms:
            ok("tools/list cache hint", f"ttlMs={listed.ttl_ms} scope={listed.cache_scope}")
        else:
            # The server attaches this unconditionally, so absence is a
            # regression rather than a variation.
            note("tools/list carried no cacheHints, which this server always attaches")

        # --- the subject the rest of the chain runs against -------------
        dataset_id, recordings_payload, recording, group = await pick_subject(client, dataset)
        zarr = recording["zarr"]
        group_name = group["name"]
        check_envelope(recordings_payload, "list_recordings", required=False)
        ok(
            "list_recordings",
            f"{len(recordings_payload.get('recordings', []))} of "
            f"{recordings_payload.get('total_count')}, index v3",
        )
        print(f"subject: {dataset_id} {zarr} group={group_name}")

        # --- describe_dataset ------------------------------------------
        described = structured(
            await client.call_tool("describe_dataset", {"dataset_id": dataset_id}),
            "describe_dataset",
        )
        if described.get("dataset_id") != dataset_id:
            fail(
                "describe_dataset",
                f"echoed dataset_id {described.get('dataset_id')!r}, asked about {dataset_id!r}",
            )
        for field in ("cost_hint", "doi", "license", "citation"):
            if field not in described:
                fail("describe_dataset", f"payload is missing required field {field}")
        name = described.get("name")
        ok(
            "describe_dataset",
            f"{name[:60] if isinstance(name, str) else type(name).__name__}, "
            f"cost_hint present",
        )

        # --- get_events ------------------------------------------------
        events = structured(
            await client.call_tool(
                "get_events", {"dataset_id": dataset_id, "recording": zarr, "limit": 5}
            ),
            "get_events",
        )
        source = events.get("source")
        if source not in ("events_parquet", "events_tsv_fallback"):
            fail("get_events", f"source is {source!r}, not one of the contract's two values")
        if not isinstance(events.get("estimated"), bool):
            fail("get_events", f"estimated is {events.get('estimated')!r}, not a boolean")
        if source == "events_tsv_fallback":
            note("get_events fell back to events.tsv, so sample_index values are estimated")
        check_envelope(events, "get_events", required=False)
        ok(
            "get_events",
            f"{len(events.get('events', []))} row(s) of {events.get('total_count')}, "
            f"source={source} estimated={events.get('estimated')}",
        )

        # --- render_overview -------------------------------------------
        overview_result = await client.call_tool(
            "render_overview",
            {
                "dataset_id": dataset_id,
                "recording": zarr,
                "group": group_name,
                "width_px": 200,
            },
        )
        overview = structured(overview_result, "render_overview")
        if not [b for b in overview_result.content if getattr(b, "type", "") == "image"]:
            fail("render_overview", "no image content block on the result")
        check_envelope(overview, "render_overview", required=False)
        ok(
            "render_overview",
            f"level={overview.get('level')} chunks={overview.get('chunks_read')} "
            f"{overview.get('width_px')}x{overview.get('height_px')} png",
        )

        # --- read_window, recipe mode (the default, zero S3 reads) -----
        recipe_payload = structured(
            await client.call_tool(
                "read_window",
                {
                    "dataset_id": dataset_id,
                    "recording": zarr,
                    "group": group_name,
                    "duration_s": 2,
                },
            ),
            "read_window (recipe)",
        )
        if recipe_payload.get("mode") != "recipe":
            fail("read_window (recipe)", f"mode is {recipe_payload.get('mode')!r}")
        recipe = recipe_payload.get("recipe") or {}
        if not recipe.get("array_path"):
            fail("read_window (recipe)", "recipe carries no array_path")
        check_envelope(recipe_payload, "read_window (recipe)", required=True)
        ok("read_window (recipe)", recipe["array_path"])

        # --- read_window, taste mode (opt-in, capped) ------------------
        taste_payload = structured(
            await client.call_tool(
                "read_window",
                {
                    "dataset_id": dataset_id,
                    "recording": zarr,
                    "group": group_name,
                    "duration_s": 1,
                    "channels": [0],
                    "taste": True,
                },
            ),
            "read_window (taste)",
        )
        if taste_payload.get("mode") != "taste":
            fail("read_window (taste)", f"mode is {taste_payload.get('mode')!r}")
        values = taste_payload.get("values") or []
        if not values or not values[0]:
            fail("read_window (taste)", "no values returned")
        window_samples = len(values[0])
        for field in ("chunks_read", "bytes_read", "filled_ranges"):
            # Asserted present rather than read with a default. `filled_ranges`
            # in particular is required and always an array, precisely so a
            # caller never has to tell "no gaps" from "this build does not report
            # gaps" -- and a default here would erase that distinction again.
            if field not in taste_payload:
                fail("read_window (taste)", f"payload is missing required field {field}")
        filled = taste_payload["filled_ranges"]
        filled_samples = sum(
            max(0, span.get("end_sample", 0) - span.get("start_sample", 0)) for span in filled
        )
        if filled_samples >= window_samples:
            # Every sample substituted means the values are the channel baseline
            # rather than recorded signal, so this call proved nothing about the
            # decode path even though it returned an array of the right shape.
            note("read_window taste was entirely fill values, so the decode path went unexercised")
        check_envelope(taste_payload, "read_window (taste)", required=True)
        ok(
            "read_window (taste)",
            f"{len(values)}x{window_samples} samples, chunks={taste_payload.get('chunks_read')}, "
            f"{taste_payload.get('bytes_read')} upstream bytes, filled_ranges={len(filled)}",
        )

        # --- an over-cap taste must be REFUSED, not truncated ----------
        # `duration_s: 61` with ONE channel, which trips exactly one cap and
        # nothing else. Three details, each of which a plausible-looking probe
        # gets wrong:
        #   - Every cap compares with `>`, so `duration_s: 60` and 64 channels
        #     sits exactly AT the duration cap, AT the channel cap and AT the
        #     3840 channel-second product, and is ACCEPTED. A probe built that
        #     way asserts nothing it claims to.
        #   - One channel keeps the product at 61 channel-seconds, far under
        #     3840, so the refusal can only be the duration cap. Asking for 64
        #     channels would trip two caps at once and muddy which one answered.
        #   - Channel 0 exists in every group (`usable_group` screens for
        #     `n_channels`), so the channel-RANGE check -- which runs before any
        #     cap and refuses for an unrelated reason -- cannot fire here.
        # The duration cap lives in the input schema's `superRefine`, so this is
        # refused before the tool body runs and never reaches S3.
        over = await client.call_tool(
            "read_window",
            {
                "dataset_id": dataset_id,
                "recording": zarr,
                "group": group_name,
                "duration_s": 61,
                "channels": [0],
                "taste": True,
            },
        )
        # Deliberately NOT wrapped in `except Exception`. A tool error and an
        # input-schema rejection both arrive as `is_error`, so an exception here
        # is a TRANSPORT failure -- a 429 from a shared IP, a 502 mid-run -- and
        # catching it would report a refusal the server never made, then print
        # ALL CHECKS PASSED. Let it propagate and be reported as an error.
        if not over.is_error:
            fail(
                "read_window (over cap)",
                "an over-cap taste was ACCEPTED; the contract says it must be refused, "
                "never silently truncated or downgraded to a recipe",
            )
        message = error_text(over)
        if "cap" not in message.lower():
            fail("read_window (over cap)", f"refused, but not for the cap: {message[:200]}")
        ok("read_window (over cap)", f"refused naming the cap: {message[:120]}")

        if verbose:
            print("\n--- last taste payload ---")
            print(json.dumps(taste_payload, indent=2)[:2000])


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify a NEMAR MCP server end to end.")
    parser.add_argument(
        "--url",
        default=DEFAULT_URL,
        help=f"transport endpoint including the {TRANSPORT_PATH} path (default {DEFAULT_URL})",
    )
    parser.add_argument(
        "--dataset",
        default=None,
        help="pin the chain subject. Recommended for a release gate, so runs compare",
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    url = args.url.rstrip("/")
    if not urlparse(url).path.rstrip("/"):
        # A bare host is the obvious thing to type, and it would otherwise fail
        # with a bare `Not Found` that reads exactly like an unprovisioned
        # hostname during a cutover. Fix it, and say so rather than silently.
        url = f"{url}{TRANSPORT_PATH}"
        print(f"note: no path given, using the transport endpoint {url}")

    try:
        asyncio.run(run(url, args.dataset, args.verbose))
    except CheckFailed as err:
        print(f"FAIL  {err}", file=sys.stderr)
        return 1
    except BaseExceptionGroup as group:
        # The SDK's client runs inside an anyio task group, so ANY exception
        # raised in the `async with Client(...)` body comes back wrapped in an
        # ExceptionGroup. Without this unwrap the operator sees
        # "ERROR ExceptionGroup: unhandled errors in a TaskGroup (1
        # sub-exception)" and none of the check message that explains what
        # actually failed -- which was the first thing this script did when it
        # was pointed at a server whose response was missing a field.
        found = _leaves(group)
        for failure in [leaf for leaf in found if isinstance(leaf, CheckFailed)]:
            print(f"FAIL  {failure}", file=sys.stderr)
        # The other leaves are printed too, never dropped: a CheckFailed
        # alongside the transport error that caused it is the common case, and
        # showing only the former hides the root cause.
        for leaf in [leaf for leaf in found if not isinstance(leaf, CheckFailed)]:
            print(f"ERROR {type(leaf).__name__}: {leaf}", file=sys.stderr)
        return 1
    except Exception as err:  # noqa: BLE001 - a transport failure is a real result here
        print(f"ERROR {type(err).__name__}: {err}", file=sys.stderr)
        return 1

    if NOTES:
        print(f"\nALL CHECKS PASSED, with {len(NOTES)} note(s):")
        for message in NOTES:
            print(f"  - {message}")
    else:
        print("\nALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
