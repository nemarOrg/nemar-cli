# ADR 0024: Inference compute runs on the user's device; the MCP is a stateless broker

**Status:** accepted
**Date:** 2026-08-16
**Owner:** Yahya

## Context

Zarr serving copies are becoming the format machines read NEMAR through
(streaming training, agents, in-browser viewing),
and #1065 proposes an MCP server as the agent-facing front door.
The open question was how much the platform should compute for its clients,
and where the MCP should live:
a persistent server (nemarring.ucsd.edu already runs Infisical),
Cloudflare Workers (cost fears if requests are frequent, 128 MB isolate ceiling),
or a local `uvx` process with no server at all.
Meanwhile eegprep depends on `oct2py` (Octave), so it cannot run in a browser,
and `osc/osa` already ships a persistent LangGraph/FastAPI assistant platform with a NEMAR assistant.

## Decision

NEMAR serves bytes and understanding; it does not run the science.
The MCP server is a **stateless, recipe-first broker on Cloudflare Workers**:
its tools search, describe, and return read recipes
(S3 URI, region, anonymous flag, group, level, chunk/sample slice, scale/offset, provenance)
computed from `index.json`; bulk signal bytes never pass through it.
Processing happens on the user's device:
eegprep or MNE on desktop/HPC (eegprep preferred where we control the pipeline),
and MNE/numpy under Pyodide for the browser lane.
Stateful conversational surfaces (the first-party chatbot) are OSA assistants
hosted on nemarring.ucsd.edu, not Workers and not new products.

## Consequences

- The Worker cost and memory concerns dissolve by construction:
  conversation-paced JSON tool calls are negligible on the existing paid plan,
  and no level-0 decode has to fit in a 128 MB isolate.
  `render_overview` (kilobyte-scale `view/*` reads) is the one pixel-producing exception kept server-side.
- #1065's `read_window` inverts from read-first to recipe-first;
  any inline read is a capped "taste", never the contract.
- The data plane stays direct-to-S3 (ADR-relevant prior art: #1061 redirects bytes),
  so client libraries (EEGDash E2-E4) own the pull-and-process half.
- The browser lane cannot share eegprep until eegprep grows a pure-Python core;
  until then the two on-device lanes use different engines, which is accepted drift.
- Anything needing session state must justify itself on nemarring, not creep into the Worker.

## Alternatives considered

- **Persistent MCP on nemarring.ucsd.edu:** unnecessary for stateless tools;
  adds an ops surface and loses the Workers deploy/telemetry path we already have.
  nemarring stays reserved for genuinely stateful services (Infisical, OSA).
- **In-Worker compute (read_window decoding level-0):** couples platform cost to client workloads,
  fights the 128 MB ceiling, and quietly turns NEMAR into a compute service. Lost.
- **Local-only `uvx` MCP, no server:** zero telemetry, version skew per user,
  no enforcement of the raw-versus-derived filter. Kept only as a possible later distribution channel.

## Receipts

- Plan and evaluation: `.context/draft-zarr-inference-ecosystem-plan.md`
- MCP proposal being amended: nemarOrg/nemar-cli#1065; data-plane redirect: #1061
- Unposted EEGDash drafts (E1-E4): `.context/draft-eegdash-zarr-issues.sh`
- eegprep Octave dependency: `oct2py` in sccn/eegprep `pyproject.toml`
- OSA platform: https://github.com/OpenScience-Collective/osa
