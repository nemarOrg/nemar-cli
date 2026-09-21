---
name: osa-nemar-assistant-state
description: OSA's nemar assistant is the LEGACY one and its replacement was never built; where the chatbot actually stands versus ADR 0025 (checkout path, hosting, dead legacy API, no MCP runtime, no code exec)
metadata:
  type: project
---

OSA is OpenScience-Collective/osa, checked out at `~/Documents/git/osc/osa`.
As of 2026-09-08 its NEMAR assistant (`src/assistants/nemar/`) still calls the legacy PHP API
`nemar.org/api/dataexplorer/datapipeline` (404 now) and links `nemar.org/dataexplorer/detail` (301),
so the assistant is dead in production. It is deployed at `api.osc.earth` (Apache, `deploy/`),
not on nemarring.ucsd.edu as ADR 0025 assumes.

**Do not confuse the two hosts** (checked 2026-09-15): `https://api.osc.earth/osa/` is the Open
Science Assistant itself and answers 200 (`"Open Science Assistant" 0.8.8`, `nemar` among its
communities). `https://api.osc.earth/nemar` is the LEGACY NEMAR API path and now 404s; NEMAR's API
is `api.nemar.org`, which also answers on `/nemar` because the app is mounted twice
([[api-mounted-twice-full-path]]) -- a 200 there is NEMAR's own API, never OSA.

The config schema declares `mcp_servers` (remote `url`) but nothing in `src/` consumes it, and
there is no code-execution tool despite the README.

**`src/assistants/nemar/` is the OLD assistant, and its replacement was never built**
(Yahya, 2026-09-15). There is no "NEMAR 2" assistant anywhere; building one is part of an epic
tied to the new tool-use capabilities, not a repointing of the legacy one. So treat the findings
above as a description of a legacy artifact, not as a repair list: do not propose fixing its dead
`dataexplorer` calls as the path to an MCP-consuming assistant.

**Why:** ADR 0025 and #1065 treat "OSA NEMAR assistant consumes the MCP" as a given; none of the
three gaps (dead API, no MCP client, hosting) is visible from the nemar-cli repo, and the
assistant that would consume it does not exist yet.

**How to apply:** Scope MCP or chatbot work as the new-assistant epic (tool use first), not as
maintenance on `src/assistants/nemar/`. Probe a host before repeating any hosting claim,
including this file's.
Related: [[api-hosts-block-python-urllib-ua]].
