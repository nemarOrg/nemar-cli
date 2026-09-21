---
name: sweeps-fail-open-tri-state-fetch
description: every nemar-cli sweep or probe that stamps a verdict from remote fetches must distinguish absent from error (tri-state), stamp nothing on infra error, and cap fetches per invocation; reviews found this class of bug in three PRs on epic #1181
metadata:
  type: feedback
---

Pattern seen repeatedly on epic nemarOrg/nemar-cli#1181 (2026-09-02): code that fetches S3 objects or GitHub raw sidecars and then records a durable state (`sweep_stamps`, a catalog verdict, a negative cache entry) collapsed 5xx/429/network throws into "absent", so a transient outage produced a permanent false verdict (`unverifiable`, or even `verified` when the one store that mattered was the one that failed). A JSON-null commit stamp also fossilised rows because `NULL != x` is falsy in SQLite. Per-dataset fetch budgets multiplied by batch size exceeded the Workers subrequest limit with no aggregate cap.

**Why:** ADR 0005 says availability is reported, never faked; a stamped verdict that came from an infra error is exactly a faked report, and the re-arm predicate (commit unchanged) means it is never revisited.

**How to apply:** when briefing or reviewing any sweep, probe, or cache-priming code: require a tri-state fetch result (`content | absent | error`), treat every non-404 failure and budget exhaustion as an error that leaves the row a candidate and is counted in `errors` (never stamped), set "checked" only after a value was actually parsed, add a sweep-wide fetch budget below the platform limit with the batch stopping when it is spent, write NULL-safe re-arm SQL (`IS NULL OR !=`), exclude private/inactive rows the fetch cannot see, and make the admin route return non-2xx when every processed item errored. See [[bun-test-lenient-vs-workerd]] and [[verify-fix-against-known-broken]].
