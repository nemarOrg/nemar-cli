# CP-2 note, track S (lead, 2026-11-14)

CP-2 brought forward by the owner. Z paused: no Z card. C1 dropped (DM-10 built Docker and F1 proved it). Every card passes `mb card` and the leak check.

## Proposed board rows

| ID | Title | Tier | Needs | Slot | Depends | Timebox | Review |
|---|---|---|---|---|---|---|---|
| S1a | Declare nm099996 dev-owned (PR into `dev`) | worker | | claude-sonnet | | 1h | |
| S1R | Recipe allowlist staging pair; runner epic takes `dev` | worker-hard | network | claude-sonnet | | 3h | Opus, isolation |
| S1 | Fixture eligible outside production; Zarr base per environment | worker-hard | | claude-sonnet | DM-07 | 4h | Opus, isolation |
| C2W | Declare `image_unverified` | worker | | claude-sonnet | | 1h | |
| S3a | What the compute switches open (input to Q6) | lead | | claude-opus | | 4h | Opus, completeness |
| L1 | Launcher deadline and parent-death signal | worker-hard | | claude-sonnet | DM-10,DM-11 | 4h | Opus, isolation |
| S6 | Runner reporting (next free migration from 0141) | worker-hard | | claude-sonnet | DM-07 | 5h | Opus, accounting |
| W2 | Gated runner runbook and inventory | worker | network | claude-sonnet | DM-19 | 3h | |
| C2 | Runner verifies cosign before pull or run | worker-hard | network | claude-sonnet | C2W,S1R | 6h | Opus, supply chain |
| S4 | Runner user service from a signed release | worker-hard | network | claude-sonnet | S1R | 8h | Opus, supply chain |
| C4 | Rootless Podman inspected, refusal lifted (CI host) | worker-hard | network | claude-sonnet | DM-10,L1 | 6h | Opus, isolation |
| S2 | nemar-cli epic: green PR into `dev` | worker-hard | network | claude-sonnet | S1,C2W | 4h | integration Sonnet |
| S2P | nemar-process runner epic: green PR into `dev` | worker | network | claude-sonnet | S1R (round 2: C2,L1,S4) | 2h | |
| S1F | Build staging fixture nm099996 | worker | network | claude-sonnet | S1a in `main`; OQ1 | 3h | |
| S3b | Staging fail-closed probes | worker | network | claude-sonnet | S3a, S2 in `dev`, dev switches, OQ1 | 2h | |
| S0 | Demo teardown | worker | ssh:ws-b,network | operator | DM-15,DM-19; after 2026-11-15T12:00 | 1h | |
| S2S | First staging runner job | worker | ssh:ws-b,network | operator | S0,S1F,S2,S2P,S3a; owner secrets; OQ1 | 3h | |
| S2D | Staging drills with the signed runner service | worker | ssh:ws-b,network | operator | S2S,C2,L1,S4; S2P round 2 released; runner tag; OQ3 | 4h | |
| W1 | Public page (platform/portable-processing) | worker | network | claude-sonnet | S2 merged | 2h | |
| S3 | Production runbook; the owner flips | worker | network | claude-sonnet | S3a,S3b,S2D; epic in `main`; Q6; OQ2 | 2h | Opus, evidence |
| S5 | Converge admission paths | worker-hard | | claude-sonnet | #2121 P3; S2 | 6h | Opus, concurrency |

S3 and S5 are seeded `blocked`; the rest `todo`.

## Dispatch order

1. Now, in this order: S1a (unblocks the longest chain: fixture, then the nightly staging conversion), S1R (unblocks the nemar-process release and the staging image), S1, C2W (both gate S2), S3a (opus slot; gates Q6 and the staging switches), L1, S6, W2.
2. As soon as their Depends merge: C2 and S4 (after S1R; both edit `docs/runner.md`: second takes the base in), C4 (after L1, `run.py`), S2 (after S1 and C2W), S2P round 1 (after S1R; merge S1R with `--merge`, never squash).
3. Owner-gated: S1F (S1a released to `main`), S3b and S2S (S2 and S2P merged, image published, dev secrets), S0, S2S and S2D only after 2026-11-15T12:00 (workstation B frozen until then).
4. Round 2: S2P again after C2, L1, S4 (and C4); S2 again after S6 (S6 rides round 2 so round 1's CI is not restarted). Then S2D, a staging soak, the epic's release to `main`, S3.

Collisions with track Q: S1R goes before Q0 (S1R's merge of `dev` into the runner epic is Q0's entry condition; both touch the Zarr recipe); S1 and Q0b share `shared/compute-recipes.ts`; S6, Q0b and V1b each take the lowest free migration from 0141; Q0 and Q0b must land in the same round on both repositories (image and Worker carry one recipe registry), so round 1 is S1R, S1, C2W only unless both Q cards merge before S2 and S2P open.

Owner steps: merge S1a and release; answer OQ1 to OQ3 and Q6; merge S2 (merge commit) and S2P (code-owner review), release nemar-process and dispatch the image; set the three dev secrets after S3a's registration-block finding is resolved; round 2 merges, release and runner tag; enable lingering; two nemar-cli releases carrying the epic; S3's five steps; merge W1 and W2 (docs deploy needs Q21's token).

## Proposed plan and risk changes (the manager and the owner decide)

- Plan section 4: S1 becomes S1a, S1, S1F; new S1R, S2P, S2S, S2D, S3b, S0, C2W; C1 dropped; W1 at `platform/portable-processing` (no `compute/` section exists); C4 uses CI's hosted rootless Podman, no owner host needed.
- D12: the allowlist becomes per-environment host pairs fixed in code (staging pair added); no host from data.
- 2.8: S6, Q0b and V1b take the lowest free migration from 0141; #2116 and P3 renumber above 0149 when they land after this epic (Q5).
- A staging soak of at least 72 hours between S2D and S3's switch, zero `runner_lost` (proposal; the owner sets it).
- `test.yml` runs Tests on `feature/issue-*-epic-*` only, so this epic's phase merges never ran the suite: a one-line pattern change into `dev`.
- New risks: K20 first full CI only at S2 (read at S2: two fix rounds, then advisor); K21 the fixture's Zarr depends on the nightly staging conversion (read daily after S1F; absent after two nights: owner; no card touches that host); K22 ADR 0118 A1c item 8 forbids `COMPUTE_ENABLED` "anywhere" until Tapis owner items settle (read at S3a; owner amends ADR 0121 or settles them, before dev switches too); K23 `policy.runners` rollback hazard (read at S3; OQ2); K24 rootful Docker on the production runner host (read at W2 and S3: single-tenant confirmed or Apptainer); K25 a fixture DOI on the production shoulder is irrevocable (S1F, S2S stop at once); K26 a succeeded stamp blocks re-dispatch (S2S step 9 makes version 1.0.1 for S2D).
- H1 is written at CP-3 at the earliest, after S3's first production jobs, the lead's ruling on D2's open point (a queued `runner/slurm` job's lease), and a site that allows a polling agent with outbound HTTPS (plan 5 item 13); H2 after H1 merges and a SLURM host exists.

## Owner questions

- **OQ1 staging.** May the operator build `nm099996` on staging (a copy of public `nm000274`, sandbox DOI only) and run staging probes and runner jobs with the staging `test-admin` and `test-owner` keys you provide, and will you set `COMPUTE_ENABLED`, `COMPUTE_RUNNERS_ENABLED` and `COMPUTE_RUNTIME_IMAGE` on the dev Worker once S3a clears ADR 0118's registration block? A yes (Recommended) / B yes, but you run S1F's commands yourself / C no staging runner jobs.
- **OQ2 first production cap.** A lower `RUNNERS_POLICY_DEFAULT` to cpu 2, gpu 0 in code, so no `policy.runners` key is stored and the rollback hazard never arises (Recommended) / B keep 64 and 8, and store `{cpu 2, gpu 0}` only after a second release with the epic is deployed.
- **OQ3 runner host.** A on workstation B the runner account holds a user-local, checksum-verified, pinned cosign and runs as a systemd user service with lingering (you enable lingering if it needs root) (Recommended) / B cosign, no lingering (no automatic restart; the bar stays unmet) / C neither (C2 and S4 cannot be exercised; production waits).
- **Q6 (already asked).** S3 depends on it; recommended default A: decide after S3a, with the bar; do not wait for Tapis.
