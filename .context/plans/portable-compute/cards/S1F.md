# Card S1F: Build the staging compute fixture `nm099996`

Status: ready (dispatch only when every Depends item holds)
Tier: worker
Timebox: M, 3 hours of work; escalate at 5 hours
Needs: network
Depends: S1a merged into `dev` AND released to `main` with its production deploy green (production must short-circuit `nemarDatasets/nm099996`); owner question OQ1 of `cp2-note-S.md` answered yes (the operator may create the fixture on staging with the staging administrator key)
Branch: none (no repository change)
Worktree: $WT/nemar-cli-pc-s1f (base origin/dev, read-only use, to run the CLI from source)
Plan: .context/plans/portable-compute/plan.md, section 4 (S1); ADR 0068; `.rules/datasets-and-fixtures.md`; `.rules/environments.md` ("Authenticating against staging")

## Goal

Staging holds `nm099996`: a public, named, first-published copy of the demo dataset `nm000274` at `v1.0.5`, created by naming its id, published with a sandbox DOI only, so that the staging Zarr conversion produces its serving copy and runner jobs can run on it outside production.

## Context

- Live facts from the manager: `$STAGING_API` (the staging API base) and `$STAGING_ZARR` (the staging Zarr host's base address), and two mode-0600 files `$STG_ADMIN_KEY_FILE` and `$STG_OWNER_KEY_FILE` holding the staging `test-admin` and `test-owner` keys from the owner's answer. Never print a key; use an isolated `NEMAR_CONFIG_DIR` under `<operator scratch>/s1f/`.
- Production is read only for the public download of `nm000274` (`env -u TEST_API_URL`); nothing is written anywhere but staging.
- `nm000274` `v1.0.5` has four EEG recordings (32 channels, 200 Hz in the serving copy); it was the demo's dataset (DM-02).
- Creation by naming the id is gated on four terms (non-production, an administrator, the reserved band, declared dev-owned); every other upload gate still applies.
- A staging publication must mint only on the EZID sandbox shoulder (`10.5072`); a DOI on the production shoulder cannot be withdrawn and must never be minted for a fixture.
- The staging Zarr copy is made by the existing nightly staging conversion run; no card touches the conversion host.

## Scope

- Staging: the dataset `nm099996` (its catalog row, its `nemarDatasets/nm099996` repository through the normal upload, its staging data), through the CLI only. The operator's machine: `<operator scratch>/s1f/`.

## Decided design

Settled, in order:
1. Preconditions, each printed: `git -C "$NEMAR_CLI" fetch origin && git -C "$NEMAR_CLI" grep -c '"nm099996"' origin/main -- backend/src/services/datasetId.ts` prints at least 1; `gh run list -R nemarOrg/nemar-cli --workflow deploy-backend.yml --branch main --limit 3 --json conclusion,headSha` shows `success` on a commit that contains it (`git merge-base --is-ancestor`); `gh repo view nemarDatasets/nm099996` fails (absent); `env -u TEST_API_URL bun run src/index.ts dataset status nm099996` and the same with `TEST_API_URL=$STAGING_API` both say not found. Any other result: stop.
2. Download the source, read only: `env -u TEST_API_URL bun run src/index.ts dataset download nm000274 -o <operator scratch>/s1f/src`, then check that its newest tag is `v1.0.5` (`git -C <operator scratch>/s1f/src tag --list 'v*' | sort -V | tail -1`).
3. Make the upload copy without repository or NEMAR metadata: `rsync -a --exclude .git --exclude .datalad --exclude .nemar --exclude .gitattributes <operator scratch>/s1f/src/ <operator scratch>/s1f/up/`; no file inside the BIDS tree is edited.
4. Log in as the staging administrator in `NEMAR_CONFIG_DIR=<operator scratch>/s1f/cfg-admin` with `TEST_API_URL=$STAGING_API` (the key login of `bun run src/index.ts auth login --help`; the key comes from `$STG_ADMIN_KEY_FILE`).
5. Upload by naming the id: `bun run src/index.ts dataset upload <operator scratch>/s1f/up --dataset-id nm099996` with only attestations that are true (the copy is of NEMAR's own published, de-identified dataset `nm000274`); answer the redistribution question as NEMAR's own copy, and if the CLI demands an affirmation that is false for a copy (for example "not already archived"), stop and report the exact prompt.
6. Publish with a sandbox DOI only: `bun run src/index.ts dataset publish request nm099996`, then `bun run src/index.ts admin publish approve nm099996 --sandbox`. Before approving, `bun run src/index.ts admin publish approve --help` must show that `--sandbox` selects the EZID sandbox; if it does not, stop.
7. Check the result: `bun run src/index.ts dataset status nm099996 --json` (or the catalog read the CLI offers) shows public visibility, a version, and a concept DOI starting `10.5072/`; any DOI on another shoulder: stop at once and report (the owner decides; never retry).
8. Write `<operator scratch>/s1f/README.txt`: the times, the source tag and commit, the staging tag and its commit, the DOIs, and the line "the staging Zarr copy comes from the nightly staging conversion; check with `curl -s -o /dev/null -w '%{http_code}' $STAGING_ZARR/nm099996/zarr/index.json`".
The implementer may choose: nothing else.

## Acceptance

- Step 7 shows `nm099996` public, published, named (not anonymous), with a `10.5072/` DOI, on staging only; step 1's production check still says not found afterwards.

## Gates

- `env -u TEST_API_URL bun run src/index.ts dataset status nm099996` says not found (production untouched) and `TEST_API_URL=$STAGING_API bun run src/index.ts dataset status nm099996` shows it published.

## Stop conditions

- The publication review or the identifier screen does not pass on staging: stop with its verdict; the manager asks the owner whether to approve with `--force` and a recorded reason.
- Any step would touch production, `nm000103`-`nm000107`, another fixture id, or the conversion host: stop.
- A DOI outside the sandbox shoulder appears: stop at once (see step 7).

## Report

At most 25 lines: each step's last line, the staging tag commit, the DOIs, and the Zarr check line for the manager to run once a day (risk proposal K21 in `cp2-note-S.md`).
