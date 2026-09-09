#!/usr/bin/env -S uv run --quiet --with mcp>=2.2 python3
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

WHAT IT CHECKS. The negotiated protocol revision, the tool list (all six, with
the `tools/list` cache hint the server attaches), and then a CHAIN: search for a
public dataset, describe it, list its recordings, and drive the three
recording-level tools plus both `read_window` modes against a real recording
discovered from that list. Nothing is hardcoded to a store path that a
re-conversion could move.

It asserts the provenance envelope is present wherever the contract promises
one, because an answer without provenance is the failure mode this server exists
to avoid.

USAGE (from the repo root):
  scripts/mcp/verify_streamable_http.py
  scripts/mcp/verify_streamable_http.py --host https://mcp.nemar.org
  scripts/mcp/verify_streamable_http.py --dataset nm000329 --verbose

Exits non-zero on the first failed check, so it can gate a cutover.

NOT CI-GATED, on purpose and worth knowing. `scripts/mcp/` matches no path
filter in `.github/workflows/test.yml`, so nothing here is linted or executed by
CI -- the same footing as `backend/scripts/mcp-smoke.sh` and
`backend/scripts/read-window-memory.ts`. It is an operational script whose whole
job is to talk to a live host, which CI has none of. Its SDK usage was validated
against a local `MCPServer` harness before first use rather than discovered
during a cutover.

SDK NOTE. This uses `mcp` 2.x's high-level `Client`, which takes a URL string
and speaks Streamable HTTP. It is deliberately NOT `langchain-mcp-adapters`:
that package pins `mcp<2.0.0` and so cannot negotiate the 2026-07-28 revision
this server implements (design doc section 11). In 2.x the server-side class was
renamed from `FastMCP` to `MCPServer`, and result fields are snake_case on the
Python side (`structured_content`) while the wire keeps `structuredContent`.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any, NoReturn

from mcp import Client
from mcp.types import CallToolResult

DEFAULT_HOST = "https://mcp-test.nemar.org"

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


class CheckFailed(Exception):
    """A verification check failed. Carries a caller-facing explanation."""


def ok(label: str, detail: str = "") -> None:
    print(f"PASS  {label}{f' -- {detail}' if detail else ''}")


def fail(label: str, detail: str) -> NoReturn:
    """`NoReturn` is load-bearing, not decoration: it is what lets a type
    checker narrow the value a caller just rejected (an envelope that failed
    `isinstance`, say) instead of carrying `| None` past the guard."""
    raise CheckFailed(f"{label}: {detail}")


def _leaves(err: BaseException) -> list[BaseException]:
    """Flatten a (possibly nested) ExceptionGroup into its non-group leaves."""
    if isinstance(err, BaseExceptionGroup):
        out: list[BaseException] = []
        for inner in err.exceptions:
            out.extend(_leaves(inner))
        return out
    return [err]


def structured(result: CallToolResult, label: str) -> dict[str, Any]:
    """The tool's `structuredContent`, with a tool error turned into a failure
    that quotes the server's own message -- these are written to be read by a
    human, so echoing them beats paraphrasing."""
    if result.is_error:
        text = ""
        for block in result.content:
            text = getattr(block, "text", "") or text
        fail(label, f"tool returned isError with: {text[:400]}")
    if result.structured_content is None:
        fail(label, "no structuredContent on a successful result")
    return dict(result.structured_content)


def require_envelope(payload: dict[str, Any], label: str) -> None:
    """Every recording-level tool promises a provenance envelope. An answer
    without one is the exact failure this server exists to avoid, so it is a
    hard check rather than a warning."""
    envelope = payload.get("envelope")
    if not isinstance(envelope, dict):
        fail(label, "no provenance envelope on the payload")
    for field in ("dataset_id", "source_commit", "engine_version"):
        if field not in envelope:
            fail(label, f"envelope is missing {field}")


async def run(host: str, dataset: str | None, verbose: bool) -> None:
    url = host.rstrip("/")
    print(f"host: {url}")

    async with Client(url) as client:
        # --- transport and handshake ------------------------------------
        negotiated = client.protocol_version
        info = client.server_info
        server_name = getattr(info, "name", "?")
        server_version = getattr(info, "version", "?")
        ok("connected over Streamable HTTP", f"{server_name} {server_version}")
        if negotiated == EXPECTED_PROTOCOL:
            ok("protocol revision", negotiated)
        else:
            # Not a failure: the server deliberately serves the 2025 era too.
            print(f"NOTE  protocol revision is {negotiated}, expected {EXPECTED_PROTOCOL}")

        # --- tools/list, and its cache hint ----------------------------
        listed = await client.list_tools()
        names = {tool.name for tool in listed.tools}
        if names != EXPECTED_TOOLS:
            missing = sorted(EXPECTED_TOOLS - names)
            extra = sorted(names - EXPECTED_TOOLS)
            fail(
                "tools/list",
                f"missing={missing or 'none'} unexpected={extra or 'none'}",
            )
        ok("tools/list", f"all {len(EXPECTED_TOOLS)} tools present")
        if listed.ttl_ms:
            ok("tools/list cache hint", f"ttlMs={listed.ttl_ms} scope={listed.cache_scope}")
        else:
            print("NOTE  tools/list carried no cacheHints")
        for tool in listed.tools:
            if not tool.input_schema:
                fail("tools/list", f"{tool.name} has no inputSchema")

        # --- search_datasets, which also picks the subject for the chain ---
        search = structured(
            await client.call_tool("search_datasets", {"has_zarr": True, "limit": 5}),
            "search_datasets",
        )
        results = search.get("datasets") or search.get("results") or []
        if not results:
            fail("search_datasets", "no datasets returned for has_zarr=true")
        ok("search_datasets", f"{len(results)} result(s), count={search.get('count')}")

        dataset_id = dataset or results[0].get("dataset_id")
        if not dataset_id:
            fail("search_datasets", "first result carries no dataset_id")
        print(f"chain dataset: {dataset_id}")

        # --- describe_dataset ------------------------------------------
        described = structured(
            await client.call_tool("describe_dataset", {"dataset_id": dataset_id}),
            "describe_dataset",
        )
        ok("describe_dataset", f"{described.get('name', '?')[:60]}")

        # --- list_recordings, which supplies the recording for the rest ---
        recordings_payload = structured(
            await client.call_tool(
                "list_recordings", {"dataset_id": dataset_id, "limit": 5}
            ),
            "list_recordings",
        )
        recordings = recordings_payload.get("recordings") or []
        if not recordings:
            fail("list_recordings", f"{dataset_id} reported no recordings")
        require_envelope(recordings_payload, "list_recordings")
        ok(
            "list_recordings",
            f"{len(recordings)} of {recordings_payload.get('total_count', '?')}, "
            f"index v{recordings_payload.get('index_format_version')}",
        )

        recording = recordings[0]
        zarr = recording.get("zarr")
        groups = recording.get("groups") or []
        group = groups[0].get("name") if groups else None
        if not zarr or not group:
            fail("list_recordings", "first recording carries no zarr path or group")
        print(f"chain recording: {zarr} group={group}")

        # --- get_events ------------------------------------------------
        events = structured(
            await client.call_tool(
                "get_events", {"dataset_id": dataset_id, "recording": zarr, "limit": 5}
            ),
            "get_events",
        )
        require_envelope(events, "get_events")
        ok(
            "get_events",
            f"{len(events.get('events', []))} row(s) of "
            f"{events.get('total_count')}, source={events.get('source')}",
        )

        # --- render_overview -------------------------------------------
        overview_result = await client.call_tool(
            "render_overview",
            {"dataset_id": dataset_id, "recording": zarr, "group": group, "width_px": 200},
        )
        overview = structured(overview_result, "render_overview")
        image_blocks = [b for b in overview_result.content if getattr(b, "type", "") == "image"]
        if not image_blocks:
            fail("render_overview", "no image content block on the result")
        require_envelope(overview, "render_overview")
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
                    "group": group,
                    "duration_s": 2,
                },
            ),
            "read_window (recipe)",
        )
        if recipe_payload.get("mode") != "recipe":
            fail("read_window (recipe)", f"mode is {recipe_payload.get('mode')}")
        recipe = recipe_payload.get("recipe") or {}
        if not recipe.get("array_path"):
            fail("read_window (recipe)", "recipe carries no array_path")
        require_envelope(recipe_payload, "read_window (recipe)")
        ok("read_window (recipe)", recipe["array_path"])

        # --- read_window, taste mode (opt-in, capped) ------------------
        taste_payload = structured(
            await client.call_tool(
                "read_window",
                {
                    "dataset_id": dataset_id,
                    "recording": zarr,
                    "group": group,
                    "duration_s": 1,
                    "channels": [0],
                    "taste": True,
                },
            ),
            "read_window (taste)",
        )
        if taste_payload.get("mode") != "taste":
            fail("read_window (taste)", f"mode is {taste_payload.get('mode')}")
        values = taste_payload.get("values") or []
        if not values or not values[0]:
            fail("read_window (taste)", "no values returned")
        require_envelope(taste_payload, "read_window (taste)")
        ok(
            "read_window (taste)",
            f"{len(values)}x{len(values[0])} samples, "
            f"{taste_payload.get('bytes_read')} upstream bytes, "
            f"filled_ranges={len(taste_payload.get('filled_ranges', []))}",
        )

        # --- an over-cap taste must be REFUSED, not truncated ----------
        # Two shapes count as a refusal and the client cannot know which to
        # expect: a TOOL error comes back as `is_error` on a normal result,
        # while an INPUT-SCHEMA rejection is a protocol-level error the SDK may
        # raise instead. Both mean the server refused, which is the property
        # under test, so accept either rather than asserting one and reporting a
        # false failure against the other.
        over_args = {
            "dataset_id": dataset_id,
            "recording": zarr,
            "group": group,
            "duration_s": 60,
            "channels": list(range(64)),
            "taste": True,
        }
        try:
            over = await client.call_tool("read_window", over_args)
        except Exception as err:  # noqa: BLE001 - a raised refusal is still a refusal
            ok("read_window (over cap)", f"refused at the protocol layer ({type(err).__name__})")
        else:
            if not over.is_error:
                fail(
                    "read_window (over cap)",
                    "an over-cap taste was ACCEPTED; the contract says it must be refused, "
                    "never silently truncated or downgraded to a recipe",
                )
            ok("read_window (over cap)", "refused as a tool error, as the contract promises")

        if verbose:
            print("\n--- last taste payload ---")
            print(json.dumps(taste_payload, indent=2)[:2000])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"default {DEFAULT_HOST}")
    parser.add_argument(
        "--dataset",
        default=None,
        help="drive the chain against this dataset instead of the first search result",
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    try:
        asyncio.run(run(args.host, args.dataset, args.verbose))
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
        failures = [leaf for leaf in _leaves(group) if isinstance(leaf, CheckFailed)]
        if failures:
            for failure in failures:
                print(f"FAIL  {failure}", file=sys.stderr)
            return 1
        for leaf in _leaves(group):
            print(f"ERROR {type(leaf).__name__}: {leaf}", file=sys.stderr)
        return 1
    except Exception as err:  # noqa: BLE001 - a transport failure is a real result here
        print(f"ERROR {type(err).__name__}: {err}", file=sys.stderr)
        return 1
    print("\nALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
