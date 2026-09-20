---
name: sonnet-unavailable-on-bedrock
description: Sonnet review subagents 404'd on this Bedrock deployment in Sept 2026 but work again as of 2026-09-17; try Sonnet first
metadata:
  node_type: memory
  type: reference
---

**Resolved as of 2026-09-17.** A `model: sonnet` review subagent launched and completed normally
(a full PR review of osa#380, 37 tool calls). Launch review agents on Sonnet as the global
instruction says.

History, kept because it may recur: on 2026-09-09, `model: sonnet` failed immediately with
`us.anthropic.claude-sonnet-4-5-20250929-v1:0 is not available on your bedrock deployment`
(`model_not_found`, HTTP 404), in more than one session. Bedrock model enablement changes without
notice, so this is a property of the deployment on a given day, not a standing fact.

**Why:** I had written the earlier failure up as permanent and was routing review agents to Opus
by default, which is both more expensive and contrary to the standing instruction.

**How to apply:** try Sonnet; if it 404s with `model_not_found`, fall back to Opus for that
session and say so rather than silently upgrading. Do not re-record either state as permanent.
Related: [[release-pr-needs-own-review]], [[cite-adr-by-content-not-plan-numbers]].
