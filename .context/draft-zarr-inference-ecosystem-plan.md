# Draft: Zarr-for-inference ecosystem plan (MCP re-scope + EEGDash issues)

Status: draft for review, 2026-08-16.
Scope: evaluates the unposted EEGDash issue drafts
(recovered from `~/Downloads/zarr-issues.sh` on mcm, now captured as `.context/draft-eegdash-zarr-issues.sh`; E1-E4)
against the posted N-set (#1058-#1065) and the enlarged MCP vision,
before anything is filed outside the nemarOrg ecosystem.

## 1. Where things stand

- N1-N8 were posted 2026-08-10 as nemarOrg/nemar-cli #1058-#1065. All still open, none started.
- The same script drafts **four** EEGDash issues (E1-E4), not two. None were ever posted;
  `sccn/EEGDash` has zero zarr-related issues.
- **The EEGDash repo moved orgs: `sccn/EEGDash` now redirects to `eegdash/EEGDash`** (default branch `develop`).
  File against `eegdash/EEGDash`.
- Our GitHub account has read-only access there: we can open issues but cannot create labels.
  Draft labels `hpc`, `performance`, `reproducibility` do not exist; map to existing
  `bug` / `enhancement` / `features` / `documentation`.
- Zarr fidelity epic (#1068) is closed and deployed; conversion correctness is settled.

## 2. The vision, decomposed into three lanes

The unifying principle: **NEMAR serves bytes and understanding; computation happens on the user's device.**
The MCP's job is to know *what* to deliver or pull (which store, which group, which level,
which chunk range, from `index.json`), never to run the science.

| Lane | Surface | Data path | Compute |
|---|---|---|---|
| Agent | MCP server (`mcp.nemar.org`) | metadata + recipes; bulk bytes 302 to S3 | agent's machine (eegprep / MNE) |
| Desktop / HPC | EEGDash (`EEGDashZarrRaw`) + eegprep | range-reads direct from S3 | user's machine |
| Browser | OSA-style chatbot + JupyterLite | zarrita fetches chunks from S3/CDN | Pyodide (WASM) in the tab |

Two constraints discovered during verification that shape the lanes:

1. **eegprep cannot run in the browser.** It depends on `oct2py`, i.e. it shells out to Octave.
   So eegprep is the desktop/HPC lane's processing engine (which we control),
   and the browser lane must use MNE + numpy/scipy under Pyodide, which are all WASM-clean.
   If we want one engine across lanes long-term, eegprep needs a pure-Python core; that is an eegprep issue, not a NEMAR one.
2. **OSA already exists and already has a NEMAR assistant** (`osc/osa`: LangGraph + FastAPI,
   YAML community registry, embeddable widget, code-execution tools).
   The first-party chatbot should be an OSA assistant upgrade, not a new product.

## 3. Hosting: the persistent-server question

Evaluated three options for the MCP host:

**Cloudflare Worker (recommended).**
The cost fear ("too costly if requests are frequent") applies only if the Worker carries signal bytes.
Design that out: MCP tool calls are conversation-paced JSON (~1-10 kB each).
Even 1M tool calls/month is under a dollar of request fees on the paid plan we already have.
The bulk data plane is already leaving the Worker anyway (N4/#1061 redirects bytes to S3 with a 302).
A recipe-first MCP makes the 128 MB isolate ceiling irrelevant too.
Reuses the existing deploy path, D1, Vectorize, Analytics Engine, and the `MCP_HOSTNAME` fork pattern.

**nemarring.ucsd.edu (persistent).**
Not needed for the MCP: the MCP is stateless by design.
Where it *does* fit: hosting the OSA NEMAR assistant (LangGraph sessions are stateful, FastAPI wants a persistent host)
alongside Infisical. That keeps chatbot session state off Cloudflare and costs nothing new.

**Local via `uvx` (no server).**
Keep as a later distribution channel (`uvx nemar-mcp`), not the primary: zero telemetry, and every user
gets a different version. #1065 already records this as the fallback.

Decision to record (ADR candidate, expensive to reverse):
**MCP = stateless broker on Workers; chatbot = OSA on nemarring; compute = on device.**

## 4. MCP re-scope: what changes in #1065

#1065 is mostly aligned already (cost ladder, provenance envelope, recipes past a cap).
The vision shifts one default and clarifies the boundary:

1. **Recipe-first, not read-first.** `read_window` currently decodes level-0 chunks in-Worker below a cap.
   Invert it: the primary contract is a *recipe* (s3 URI, region, anonymous flag, group, level,
   chunk/sample slice, scale/offset) computed from `index.json`.
   Keep at most a tiny "taste" read (a few seconds, few channels) for agents that genuinely need raw numbers inline.
   This removes the memory constraint, the cost exposure, and the temptation to become a compute service.
2. **`render_overview` stays server-side.** `view/*` min-max reads are kilobytes; that is the one
   pixel-producing tool worth keeping in the Worker.
3. **Processing guidance is part of the tool surface.** Errors and recipes should name the client-side path:
   "read this with `zarr` + `boto3` anonymous, then preprocess with eegprep/MNE".
   The MCP teaches the on-device workflow instead of substituting for it.
4. **Downstream surfaces are separate issues** (browser compute, OSA integration), not scope creep on the server.

Action: comment on / edit #1065 with this amendment rather than opening a replacement.

## 5. EEGDash drafts E1-E4: verdicts against current upstream

Verified against `eegdash/EEGDash` `develop` (last push 2026-07-01; drafts written 2026-08-10, so they
were drafted against current code).

| Draft | Verdict | Notes |
|---|---|---|
| E1 cache-dir footgun | **Post, with one correction** | `EEGDASH_CACHE_DIR` env override already exists as step 1 upstream (`paths.py`); the draft's proposal lists it as if new. The real ask is `$SCRATCH` / `$TMPDIR` / `platformdirs` before cwd. Reword. |
| E2 stream Zarr (`EEGDashZarrRaw`) | **Post as-is** | The keystone of the on-device lane; perfectly aligned with recipe-first MCP. `downloader.py` boto3/aiobotocore rationale confirmed upstream (now cites their #397). Cross-ref N2 → nemarOrg/nemar-cli#1059. |
| E3 shard-aware IterableDataset | **Post as-is** | Pure client-side efficiency; aligned. Cross-refs E2 + N3 → #1060. |
| E4 provenance on Zarr-backed datasets | **Post as-is** | The lossy-serving-copy honesty layer; aligned. Cross-ref E2. |

All four survive the MCP re-scope untouched: they are the "pull and process on device" half,
the MCP is the "understand what to pull" half. Mechanical edits before posting:
replace `N2`/`N3` placeholders with real `nemarOrg/nemar-cli#1059` / `#1060` references,
retarget `eegdash/EEGDash`, and map labels to the repo's existing set.

## 6. Gaps: issues to open in our ecosystem first

1. **Amend #1065** with the recipe-first re-scope and the hosting decision (section 4).
2. **ADR in nemar-cli:** compute-locality and hosting — **done, ADR 0024**
   (`decisions/0024-inference-compute-runs-on-device-mcp-is-a-stateless-broker.md`).
3. **Browser compute surface** (nemarOrg/website or new repo): JupyterLite + Pyodide kernel,
   zarrita chunk reads (already proven by the viewer), MNE-in-WASM feasibility spike,
   a small `nemar` py helper that opens a store from a recipe. Chatbot can hand sessions into it.
4. **OSA NEMAR assistant upgrade** (osc/osa): connect the MCP tools as a LangChain toolset;
   add the "process in browser vs. hand out a recipe" decision to the assistant's prompt/tools;
   host on nemarring.ucsd.edu.
5. **eegprep** (sccn/eegprep): a `from_zarr` / recipe entry point so an agent's recipe pipes straight in;
   longer-term, a pure-Python core if the browser lane should ever share the engine.

## 7. Sequencing

1. Amend #1065 + write the ADR (in-ecosystem, settles the architecture).
2. Post E1-E4 to `eegdash/EEGDash` with the mechanical edits (external, but now grounded in a settled plan).
3. Open the browser-compute and OSA issues (3, 4) once the ADR names the lanes.
4. eegprep issue (5) when the E2 reader exists to feed it.

N-set implementation order is unchanged: N2 (#1059) unblocks the most (E2, MCP provenance, recipes),
then N3 (#1060), then N5 (#1062) for discovery.
