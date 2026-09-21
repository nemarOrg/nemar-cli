# Changelog

What each release actually changed, for someone deciding whether to upgrade or trying to
explain a behavior change after the fact.

**Why this file exists.** The GitHub Release for every tag is generated from merged pull
request titles (`--generate-notes`, in `.github/workflows/auto-tag.yml`), which is accurate
and routinely misleading. Work that lands as one epic merge collapses into a single bullet,
and that bullet carries the epic's name rather than the name of the thing that changed; a
security fix found mid-epic gets no bullet at all. So the generated list stays the index of
what merged, and this file says what it meant.

Newest first. Dates are the tag's publication date, UTC. Backfilled from 0.9.16 onward;
earlier releases are described only by their generated notes.

## 0.10.5 - 2026-09-21

### Added

- **The catalog's whole filter surface is available over the Model Context Protocol
  (MCP) (#1429).** `search_datasets` advertised six filters and accepted thirty-three;
  an assistant could only reach the six it was told about, and a name it invented for
  the rest was accepted and silently ignored, so an unfiltered answer came back looking
  filtered. The parameters are now generated from `shared/facets.ts`, the one place the
  facets are declared, so the tool description and the server cannot disagree. Range
  syntax (`10..20`, `64..`, `..128`) and `include_unknown` are documented per parameter,
  because several facet columns are only partly populated and low recall there is a
  property of the data rather than a bug (ADR 0032). A call is capped at twenty filters
  (#1442).

  The underlying trap is narrowed, not closed: the schema still accepts an argument it
  does not declare and drops it. What changed is that the declared set is now exhaustive
  and generated, so there is far less reason to invent one, and the tool description
  says plainly that an undeclared name is ignored.

- **The top hundred ids of every allocating prefix are reserved for standing test
  fixtures (ADR 0068).** `RESERVED_FIXTURE_FLOOR = 99900`, so `nm099900`-`nm099999` and
  `xx099900`-`xx099999` are never returned by the allocator. Real datasets still
  allocate upward from the start of the prefix; fixtures are assigned downward from the
  top, by name. Reserved means **not allocatable, not invalid**: `isValidDatasetId` still
  accepts a reserved id and every route still serves one.

- **A non-production fixture can be created at its reserved id** (#1437, #1445), behind a
  gate with four separate conditions: not production, an admin caller, an id inside the
  reserved band, and a name on the declared dev-owned list. Each refusal carries its own
  machine-readable `error` code rather than one generic failure, so a caller can tell
  which condition it missed.

- **The read recipe has a browser lane** (#1469, ADR 0070). `read_window`'s `how_to`
  block gained `python_browser`, which names `eegprep-lean` and calls its asynchronous
  interface against the recipe's `array_path`. The lane that was labeled ready-to-run
  Python could not run in a browser, which is where compute runs by default (ADR 0049):
  the synchronous Zarr entry point starts an input/output thread, which Pyodide's main
  thread cannot, and the resulting error names threads rather than Zarr. All three lanes
  now say where they run.

### Changed

- **The standing anonymous fixture moved from `xx099907` to `nm099998`, and the way it is
  protected changed with it.** `xx099907` was an exemplar-band row guarded by a
  per-fixture code gate that made it structurally unpublishable: `isExemplarPublishAllowed`
  refused it server-side, so approving it by mistake was not possible. `nm099998` is a
  reserved `nm` id created through the ordinary anonymous-deposit path, which is the point,
  because the fixture now exercises the mechanism real depositors use rather than an
  exception carved around it.

  The consequence is worth stating plainly for whoever operates this: **there is no longer
  a per-fixture code gate.** An admin approving `nm099998`'s publication request as an
  ordinary, non-anonymous release will de-anonymize it and destroy the fixture
  permanently, exactly as that action would for a real depositor's anonymous dataset.
  Creating it is still heavily gated, by four separate conditions including
  not-production and admin; publishing it is guarded by the same care any anonymous
  deposit gets, and no more. `xx099907` itself is fully retired: no row, no repository,
  and the fleet loader now refuses an `anonymous` key outright.

- **The OSC surfaces can read Zarr chunks cross-origin** (#1466). `*.osc.earth` joins the
  NEMAR web properties on the Zarr host's allow-list. This does not change who can read
  the data, which is anonymous: cross-origin resource sharing is a browser instruction
  about which page may see a response, and a request without it still succeeds for any
  non-browser client. What it changes is whether in-browser code on those surfaces can
  use what it fetched.

### Fixed

- **The manifest canary probed a private repository anonymously** (#1452), so every blob
  it checked read as gone. It now authenticates with the installation token and reports
  a tri-state verdict: `present`, `absent`, or `unchecked`. `unchecked` is logged as
  itself rather than folded into the healthy line, because a run that could not check
  anything still writes a manifest and an operator reading `canary OK` would believe it
  was verified (ADR 0053). An authenticated `absent` seen on a first attempt survives a
  later `unchecked`, so a transient failure on retry cannot erase a real absence. The
  private repository it could not read is an anonymous deposit, which is a public row
  over a private repository by design (ADR 0065).

- **The anonymous exemplar could not take its anonymous release** (#1428), and the
  version identifiers minted during a blind stayed reserved with nothing to complete
  them afterward.

- **Upload's two environment questions are no longer one predicate** (#1445). Allocation
  asks whether this is literally production, and the named-id gate asks whether this is
  not a known non-production environment; they fail in deliberately opposite directions,
  so an unset environment variable cannot cause a real `nm` id to be allocated where a
  sandbox `xx` id was meant.

- **A sweep's SQL and its bind parameters are exported together** (#1445), rather than
  the query being hand-retyped in a test where a transposed parameter could stay green.

### Migrations

None. `0086_publication_request_anonymous.sql` appears in the diff, but only its comment
changed: it had named `version_doi` among the steps an anonymous release skips, which
#1447 stopped being true. No schema statement was touched, and the migration has already
run.

### Deploy coupling

**The Open Science Assistant's NEMAR prompt must ship with this release**
(OpenScience-Collective/osa#425). That prompt told the model `search_datasets`'s filters
are *exactly* the six it listed, that there is no participant-count filter, and to pass
only those six names. All three statements become false the moment this release reaches
production, and the third is the one that does damage: it instructs the model not to use
filters that now work, so a question about channel counts or participant numbers takes a
worse route or is declined, and nothing looks broken.

## 0.10.4 - 2026-09-16

### Added

- **A dataset can be deposited for double-blind review: readable, and not attributed until
  you say so (epic #1406).** `nemar dataset publish request <id> --anonymous` releases the
  data exactly as any public dataset is released -- listed, browsable, downloadable, at the
  ordinary dataset URL a reviewer can be pointed at -- while nothing NEMAR publishes names
  the depositor. The repository stays private, `datasets.authors` carries a blinded label
  rather than real names, `.nemar/metadata.json` is committed with authors, contributors,
  funding, geo-locations and related identifiers stripped, the DOI stays `reserved` with no
  DataCurator and is never harvested, and the catalog projects no owner. When the paper is
  accepted, restore the real `Authors` in `dataset_description.json` and request publication
  again WITHOUT the flag; that is what ends anonymity and publishes the record for real.
  Blind your own files first: NEMAR cannot scrub what the depositor wrote, and the sweep
  below reports what is left rather than editing it.

  Two limits are deliberate and worth knowing before you plan around them. Anonymity is
  available only BEFORE a dataset has ever been published, and the database enforces it:
  migration 0085 adds `first_published_at` and `anonymous` to `datasets` with triggers that
  refuse any row which is both, so the guarantee survives a route that forgets to check.
  Retracting an attribution that is already public is theater -- DataCite is harvested, the
  landing page is indexed, the git history is in every clone -- so publication is a one-way
  door rather than a toggle. And anonymity is toward the public, never toward the archive:
  admin and service reads resolve identity on purpose. See ADR 0065.

  Identity is withheld by the WRITER, not filtered by the reader, which is why the blind
  holds at surfaces a read-time filter would have missed: `datasets.authors` reaches the
  full-text index through a trigger, so a projection filter would have hidden names from the
  API while leaving them searchable. Two leaks that survived the first draft are closed at
  their own sites because neither is reachable from a `SELECT` list -- `GET /datasets/:id`
  served the raw `owner_user_id` beside the nulled username (a stable handle linking one
  depositor's several anonymous deposits), and `?owner=<username>` filtered on the real
  username, confirming authorship without ever projecting it.

- **`nemar admin anonymity-sweep` re-checks every anonymous deposit daily, and reports two
  different kinds of finding without letting one stand in for the other (#1409).**
  `severity: "invariant"` is a NEMAR bug -- repository public, real names in `authors`,
  `first_published_at` stamped, an EZID record that is not `reserved`, an owner projected, a
  Zarr index carrying attribution. `severity: "deposit"` is what the depositor left in their
  own files, addressed to them. The file checks are deterministic on purpose: they do not
  ask whether a string is a person's name, they ask whether a file contains THE DEPOSITOR --
  the real name, username, GitHub handle, email and ORCID iD already in the `users` row
  NEMAR is concealing -- plus any ORCID iD and any email address. No classifier, no
  false-positive budget, and a finding a depositor can reproduce without arguing with it.
  It reports and never repairs, because a disclosure cannot be undone by flipping a flag and
  an automatic fix would destroy the evidence that the guarantee had failed; it writes only
  `sweep_stamps`, and it files no GitHub issue precisely because `nemarDatasets` is
  public-facing. A check that could not run is `unchecked`, never clean. See ADR 0067.

- **The data plane serves a dataset's git-tracked files itself, instead of redirecting to
  GitHub (#1403).** `data.nemar.org/<id>/<version>/<path>` used to 302 metadata files to
  `raw.githubusercontent.com`; it now returns the bytes. That is what makes an anonymous
  deposit readable at all -- its repository is private, so every raw URL 404s for a reviewer
  -- and it removes a third-party host from the critical path for every other dataset too.
  The capability rules are the interesting part: the manifest is the capability list, the
  repository comes from the dataset row and never from the request, the visibility gate runs
  BEFORE the installation token is spent, the cache is keyed by request URL and never by
  blob SHA (two datasets sharing an identical file share its SHA, so a SHA-keyed hit would
  serve a private dataset's bytes to whoever asked second), and a refusal is 404 rather than
  403 because "exists but forbidden" is itself the disclosure. Responses are `max-age=300`
  and deliberately not `immutable`: the bytes are immutable, the authorization is not, and
  nothing purges the edge. A 32 MB per-file ceiling guards against an annex-policy slip; the
  largest git-tracked file measured across the catalog is 283 KB. See ADR 0066.

- **`nemar dataset download` no longer needs git-annex.** A missing git-annex used to be a hard
  exit, which is a poor answer to "I just want the files" when the data plane already serves
  every byte over plain HTTPS. The command now falls back to an HTTP download, announced rather
  than silent, and `--http` asks for it outright. One request to
  `<api>/data/<id>/<version>/manifest.json` returns every file's path, size, checksum and byte
  URL; a bounded worker pool (`-j`, default 4) fetches the selection. A file already on disk at
  its declared size is skipped, so an interrupted transfer resumes by re-running the command,
  and widening `--subjects`/`--tasks`/`--datatypes` later only fetches what is new. The BIDS
  filters mean exactly what they mean on the git-annex path, because both are derived from one
  declaration in `src/lib/bids-filter.ts` rather than two matchers that could disagree; dataset
  metadata is never filtered out, so what lands is still a readable BIDS root. What you get is a
  file snapshot, not a repository: there is no `.git`, so `nemar dataset commit`/`push`/`update`
  do not operate on it, and the command says so. `--update` and `--prune` are refused on this
  path rather than silently doing nothing. Useful well beyond the missing-git-annex case:
  containers, HPC login nodes and CI runners where installing git-annex is impractical.
  Every write is checked against the manifest's declared size, so a truncated body or an
  intercepting proxy's login page is an error rather than a file that looks fine; throttled and
  transient responses are retried with backoff, since most manifest entries fetch from a host
  that rate-limits by address; a transport, authentication or disk fault exits non-zero even
  without `--require-complete`, while content genuinely absent upstream stays a reported state
  (ADR 0005); and the target directory is refused if it is a git repository, holds a different
  dataset, or holds a different version of the same one -- the last because
  `dataset_description.json` is the same length across a patch bump, so resuming across versions
  would skip it and leave a tree that misreports its own version.

- **`nemar admin fleet content-recovery` copies back annexed content the bucket never
  received, and proves every copy (#1396).** Sixteen datasets finalized an import with
  12,039 keys, about 620 GB, for which `s3://nemar` holds no object, so the registration
  sweep could only report them: there was nothing to register. Recovery copies the bytes
  server-side from OpenNeuro's bucket, which means hundreds of gigabytes never pass through
  the operator's machine. A copy is only allowed from a source git-annex itself pinned (the
  S3 version id in `<key>.log.rmet`) or from exactly one distinct upstream object carrying
  the key's size, deduplicated by ETag; a path alone is never a source, because upstream
  rewrites paths and these imports are months old. S3 is asked to compute the SHA-256 of
  what it wrote and it is compared to the key's own hash before anything is registered, and
  an object that does not match is deleted rather than left in the bucket looking like
  content. Recovery writes no location log: `nemar admin fleet key-registration` does that
  afterwards, so one piece of code writes presence claims and it is the one that reads the
  log back. See ADR 0063.

- **`nemar admin docs <path...>` reads documentation pages, including the gated ones, without
  a browser.** `nemarOrg/docs` is private at source and `docs.nemar.org` is the retrieval
  surface, so a checkout is no longer how anyone opens an operations runbook. The command
  trades the stored API key at `POST /auth/docs/cli-session` for a fifteen-minute, read-only,
  documentation-scoped session and sends only that onward, so the long-lived key never reaches
  the documentation host or its logs. Pages come back as Markdown on stdout and diagnostics on
  stderr, so `nemar admin docs cli/commands > page.md` yields the page. Pass several paths at
  once: they share one session, which matters because the mint sits in the strict per-address
  rate-limit bucket. There is deliberately no flag that prints the session value, since a
  credential on stdout is one in a shell history.

- **`nemar admin fleet key-registration`** repairs the datasets the bug above already
  published. A fleet sweep of all 802 dataset repositories found 528 of 600 imported
  datasets with zero keys recorded at `nemar-s3`: 720,896 keys sitting in the bucket that
  no clone is told about. Those datasets are not broken for a user -- an imported
  repository carries OpenNeuro's `s3-PUBLIC` remote with `autoenable=true`, so
  `git annex get` still works -- but every clone fetches from upstream, and NEMAR's
  independence from OpenNeuro is not real while its own copy goes unadvertised.
  Presence is established by ONE `list-objects-v2` per dataset with credentials the API
  mints for it, never a HEAD per key: `s3://nemar` denies anonymous ListBucket, so a
  missing key answers 403, and 403 is equally what a private dataset, an expired session
  or a signature with no session token returns. A dataset with any key the bucket cannot
  account for is reported and skipped by default, because that is content which was never
  transferred (#1396) rather than a registration that was lost, and writing the remaining
  registrations would make it look repaired. Both rules are ADR 0061.

- **`nemar download <id>` and `nemar upload <path>` work from the root**, alongside the
  existing `login`/`logout`/`whoami` shortcuts. They are the same commands as
  `nemar dataset download`/`nemar dataset upload`, built from one factory, so every flag and
  every default is shared and the canonical two-word spellings are unchanged.

### Changed

- **`nemar admin --help` and `nemar dataset --help` lead with the commands people actually
  type.** `admin` had grown to 43 subcommands and `dataset` to 21, most of them one-off
  backfills, sweeps run from cron, or git-level escape hatches, and a flat alphabetical list
  gave `nemar admin approve` exactly as much prominence as `nemar admin recording-stats-sweep`.
  Plain `--help` now describes nine admin commands and six dataset commands and folds the rest
  onto a single comma-separated line; `--help-all` still lists everything with descriptions.
  Nothing is hidden in any other sense: a folded command still runs, still completes on TAB,
  and still has its own `--help`. The two lists are declared in `src/lib/help-groups.ts`, and a
  command absent from that file is folded rather than dropped.

### Fixed

- **A brokered git-tracked file now carries a `Content-Length`, and its length is checked
  against the manifest for real (#1419).** The broker asks GitHub's raw host for
  `Accept-Encoding: identity` so that upstream's declared length means what the manifest
  means. The Workers runtime owns that header: it never reaches GitHub, raw gzips anyway,
  and workerd strips `Content-Length` when it decodes. So the deployed data plane served
  every git-tracked file with no length at all, and the documented check that a moved tag
  cannot serve the wrong bytes had never once run in production -- the guard was inert while
  looking present, which is the failure mode worth naming.

  A first attempt set the header by hand and still did not work, which is worth recording
  because it is the same lesson twice: workerd sends a streamed body chunked and drops the
  header, so a length that reaches a client has to belong to a body whose length the runtime
  already knows. A brokered file at or below 8 MB is therefore read, checked and answered as
  bytes, which also makes a mismatch a clean 502 before anything is sent rather than a
  transfer aborted mid-flight. The read is bounded by the manifest's size and cancels
  upstream the moment it is exceeded, because both size gates test the number the MANIFEST
  claims and nothing bounds what GitHub actually sends: draining first would let a retagged
  recording fill a 128 MB isolate. Above the ceiling it degrades to a stream with a counter
  that errors on a short or overrun body: no declared length there, but still no
  wrong-length file that finishes looking healthy. For scale, the per-file ceiling is 32 MB
  and the largest git-tracked file measured across the catalog is 283 KB, so the buffered
  branch is what every real dataset takes.

  One bound worth knowing before relying on it: `Content-Length` describes the ENCODED body,
  and Cloudflare compresses this response for any client that accepts compression. Measured
  on one worker within one second: a default `fetch` negotiated zstd and got no
  `Content-Length` at all, while `Accept-Encoding: identity` got 1414, the manifest's number.
  What changed is that the origin now emits an accurate length instead of none, and an
  honest absence instead of a wrong number when the edge re-encodes. The manifest stays the
  authority on a file's decoded size for every client, which is what `nemar dataset download`
  has always checked against.

- **A brokered file is now checked for being the right bytes, not just the right number of
  them (#1419).** The broker fetches by git REF, not by blob SHA, so a moved tag serves
  whatever is at that path now. A same-size edit -- a BIDS version string bumped, one
  participant ID swapped for another -- passed every length check and was served as a 200
  whose `ETag` named the OLD blob, cacheable for five minutes. Having the complete bytes in
  hand makes the real check affordable: the buffered branch hashes them as a git blob and
  compares to the object name the manifest already records, so `ETag` now means what it
  says. ADR 0066 carries both corrections.

- **The withdrawn-datasets list now records a measured reason per dataset, and six entries
  were wrong (#1396).** It carried one filed reason each, 9 `upstream_403` and 2
  `no_source`, none of it measured per dataset. Trying every key against both routes
  OpenNeuro publishes found that six of the eleven were fetchable by the advertised route
  the whole time they sat private with tombstoned DOIs: `on004148`, `on007816`, `on007987`,
  `on008065`, `on005516` and `on005279`, now `reason: recovered`. Five were reinstated;
  `on007816` had never been published, so it needs a publish rather than a restore. The five
  still-withdrawn entries carry `data_keys_missing` / `data_keys_total` / `data_available` so
  the claim is checkable, and the reinstated ones carry `data_available` alone. A
  `withdrawn: false` flag keeps `withdraw --all` from taking a reinstated one down again, and
  the explicit-id path refuses one too without `--force`. The parser rejects the
  contradictions the shape allowed: `recovered` while still withdrawn, key counts given
  singly, missing above total, and a `data_available` that disagrees with them. A test
  asserts the two halves agree: everything still down is under the 90% threshold, and
  everything reinstated is at or above it.

- **NEMAR lists a dataset only when at least 90% of its DISTINCT ANNEXED DATA KEYS are
  available (ADR 0064, partially superseding ADR 0005).** `dataAvailability` and
  `MIN_DATA_AVAILABILITY` put the rule in one place, next to the presence predicate its
  numerator is defined in terms of, and the import publish gate calls it rather than
  recomputing the ratio. Enforcement of the withdrawal itself is still the operator running
  `nemar admin withdraw`; what ships here is the measurement, the gate, and the list. The denominator is data, never `total_files`: metadata is never annexed
  (ADR 0015), so it arrives from GitHub whether or not one recording survived and pulls every
  ratio toward 100%. `on008017` is missing 4.7% of its tracked files and 21.6% of its data,
  and `on004917` 11.8% against 25.4%, so a threshold on tracked files clears both. A
  metadata-only dataset measures 1 rather than dividing by zero. The threshold is applied only
  after recovery has reported what it cannot get: on 2026-09-15 three datasets that were
  not already withdrawn were under the threshold that morning and whole by the afternoon,
  and six more came off the withdrawn list the same day. A verdict read from a stale
  column would have tombstoned content that exists.

- **A publish-gate shortfall now files a labeled tracking issue (#1396).** The gate
  refuses when the bucket cannot back the keys a dataset's tree names, but its message
  matched no rule in the failure classifier, so the issue on `nemarDatasets/.github` was
  filed with no label and no severity. The gate emits `[nemar-data-unavailable]` with the
  availability figure and the classifier maps it to `data-unavailable`. It deliberately
  does NOT reuse the upstream marker: at that point nothing has established the content
  is gone at source, and recording that unmeasured is what put nine datasets on the
  withdrawn list wrongly. Both copies of the literal are pinned against each other by a
  test, like the upstream marker.

- **`nemar admin fleet key-registration --retract-false-claims` withdraws a claim the
  bucket cannot back (#1396, #967).** The sweep could already see this state -- a key
  recorded at NEMAR's remote with no object behind it, which is what a failed copy leaves --
  but only ever reported the missing content and skipped the dataset, so the false claim
  outlived every run and clones kept being told to fetch bytes we do not hold. The scan now
  names it (`falselyClaimed`), the skip note says how many of the missing keys are advertised
  anyway, and the flag retracts them and pushes. Off by default and deliberately: while the
  content is still recoverable the honest repair is to fetch it, which makes the claim true.
  Used on the 230 keys across `on003574`, `on004475`, `on004917`, `on005571` and
  `on005279` whose anatomical images OpenNeuro removed, verified afterwards by re-reading
  each dataset's location log from a fresh clone of origin. It edits the log and leaves the
  zero-byte objects, which are inert once nothing claims them but still read as damage to a
  size audit.

- **A presence claim NEMAR cannot honor can now be withdrawn (#1396).** `batchSetKeysAbsent`
  is the counterpart to the registration path: a failed copy leaves a zero-byte object
  under the right key name, every check that asks only whether the key exists counts it as
  content (#967), and the registration then tells every clone to fetch bytes we do not
  hold. Where recovery proves the content unrecoverable upstream the claim cannot be made
  true, so the repair is to retract it. The read-back is inverted rather than reused:
  success is the key no longer being recorded at the remote, and the assert-side check
  would have reported every retraction as a failure.

- **Content recovery refuses a wrong-sized source, and can recover a zero-length key
  (#1396).** Finishing `on004624` and `on006136` turned up `.log.rmet` pins that are simply
  wrong about content: a key declaring 0 bytes pinned to 2,075 bytes of the dataset README
  across four separate pins, and a key declaring 6,488,064 bytes pinned to an object one
  32 KiB block longer. ADR 0063's SHA-256 comparison caught both and both copies were
  deleted, so nothing wrong reached the bucket -- but the probe had issued its HEAD and read
  only the exit code, so a readable wrong-sized object counted as recoverable content and
  every apply spent a whole copy to be told no. The source's length is now compared to the
  key's declared size before the copy, on the dry-run path as well as the apply path. In
  both datasets the only tree path referencing the key is an OpenNeuro upload temp file
  committed into the dataset, so this is upstream debris rather than scientific data.

- **A multipart copy runs its parts concurrently (#1396).** Parts are independent
  server-side copies but were issued one at a time, so one oversized key copied at about
  6 MiB/s, hours for a single key, while eight ordinary keys in flight sustain 30 MiB/s. Eight parts now
  run at once and the completed list is still assembled in part order. The byte-range
  arithmetic moved into an exported `multipartRanges`, because that is where this can
  corrupt silently: S3 stitches whatever ranges it is handed, so a gap or an overlap yields
  an object of plausible length holding the wrong bytes, and the multipart path has no
  SHA-256 to catch it.

- **A multipart copy is now proven against its source, not just measured (#1396).** Above
  CopyObject's 5 GB limit the copy carries no SHA-256 to compare with the key, because S3
  refuses `--checksum-type FULL_OBJECT` for sha256, so such a copy passed on its size and
  its pin alone. It offers that whole-object checksum for CRC64 instead, and the copy now
  ASKS for one (`--checksum-algorithm CRC64NVME --checksum-type FULL_OBJECT`) rather than
  hoping S3 attaches it; OpenNeuro's large objects already carry one, so the two can be
  compared directly: an
  equal full-object CRC64 means the copy is the pinned version's bytes rather than any
  object of the right length. Recorded as `crc64-of-source`. It stays a fidelity check
  rather than an identity one, so an unpinned oversized source is still refused. Costs one
  extra HEAD, and only where there was nothing stronger to check.

- **`nemar admin import verify` no longer reports "0/0 object(s) missing" (#1396).** The
  backend answers `complete: false` with an empty expected set when there is no published
  manifest to compare against, which is the right refusal, but the CLI rendered it as an
  incompleteness with a count of zero over a total of zero. `on008003` reported that with
  759 objects sitting in its prefix. It now says the dataset is not verifiable and why, so
  an absent expectation stops reading as a verdict on the data (ADR 0054). Same fix in
  `admin import recover`'s per-target line.

- **Content recovery reads the pins of any path containing a space (#1396).** git-annex
  base64-encodes a metadata value it cannot write literally and marks it with `!`, which is
  what happens to every `.log.rmet` value whose object path holds a space. The parser
  required a literal `#` in the raw token, found none inside the base64, and reported those
  keys as having no recorded source at all: 1,808 pins in `on004148` and 1,378 in `on008003`
  were invisible. It mattered most above CopyObject's 5 GB limit, where an unpinned source
  is refused because a multipart copy cannot carry a SHA-256 -- `on008003`'s two 5.8 GB
  objects read as unrecoverable while both were sitting upstream, readable, at the version
  their own pin named.

- **Content recovery no longer treats a retracted S3 version as a place to copy from (#1396).**
  A `<key>.log.rmet` line marks its value `+` for set and `-` for unset, and the parser read
  the marker as escaping, so a retracted version reached the AWS CLI with a literal leading
  minus. Every one of `ds006110`'s five retractions came back as a bare `InvalidRequest`,
  which read as an upstream defect rather than our own misparse; honoring the retraction
  turns those five into two recoveries and three honest verdicts. The log is now replayed in
  timestamp order, so a retraction written out of position still wins over the entry it
  cancels.

- **An import can no longer finalize with content it never transferred (#1396).** The publish
  gate verified the import MANIFEST against the bucket, and a manifest is what the copy phase
  believed it transferred, so a partial manifest verified cleanly while the tree still
  referenced keys nothing had moved. Sixteen datasets published that way, and the location log
  then told every clone NEMAR had those keys. Finalize now asks the question of the tree: every
  annexed key must have an object at its declared size, or it refuses to register and says how
  many are outstanding.

- **Registering annexed keys no longer reports writes it never made** (#1392).
  `batchSetKeysPresent` ran fifty `git annex setpresentkey` processes at once and counted
  every exit-0 as a registration. They all exit 0; their writes to the shared git-annex
  branch journal do not all survive. An `onboard-openneuro` finalize logged "Registered
  117 files in git-annex", the pushed location log recorded none of them, and the dataset
  was published with a permanent concept DOI. It is now one `setpresentkey --batch`
  process per chunk of 5,000, and the result is read back out of the location log rather
  than inferred from exit codes -- the callers already aborted on a non-zero failure
  count, so they now abort on the truth, and name the keys that are missing.

- **Colored `--help` no longer wraps descriptions about twenty columns early.** Commander
  measures wrap width with `String.length`, which counts the ANSI escapes around a colored
  command name as if they took up columns, so `nemar dataset --help` in a terminal broke every
  description onto two or three lines while the same output piped through `cat` was fine. The
  wrap now runs on the visible text and the color is applied afterwards.

- **Rate limits now apply to the `/nemar` spelling of every route.** The API is mounted twice,
  at `/` and at `/nemar`, and the limiter matched paths against the full request path, so the
  strict per-address floor on the authentication routes (`/auth/login`, `/auth/code/request`,
  `/auth/keys`, the device-flow routes) matched nothing when the prefix was used and those
  requests fell to the general bucket. Both spellings are bucketed alike now. Low impact in
  practice, since Cloudflare's own per-address ceilings and the per-email limit on code
  requests both still applied, and this API is read-only for anyone without a key; recorded
  because it is a real change in how those routes are throttled.

- **An OpenNeuro import no longer leaves motion recordings in the git repository, and
  NEMAR's annex policy now actually governs an imported dataset.** Two separate holes,
  both closed in the import's prepare phase (#1159, ADR 0060). First, a `_motion.tsv`
  under OpenNeuro's ~1 MB bar arrived as a plain git blob and stayed one -- 893 of them,
  675 MB, in `ds007788` alone; those files are now annexed and their content uploaded
  from the clone, and an import that cannot upload them fails instead of publishing a
  pointer with nothing behind it. Second, and previously unnoticed: upstream ships a
  `.gitattributes` whose `annex.largefiles` setting **outranks** the one
  `configureLargefiles` writes, so ADR 0031's policy had no effect on any imported
  repository -- the next motion file added to one would have repeated the original bug.
  The inherited attribute is now replaced by NEMAR's own expression, which the import
  writes and then reads back before continuing: stripping alone would have been worse
  than leaving it, because with `annex.largefiles` set nowhere git-annex annexes
  everything, including the metadata a clone has to be able to read. This is a forward
  fix, so an imported repository does not shrink -- upstream's blobs stay in the
  history it came with. The 600 imported datasets that still carry upstream's
  attributes are tracked in #1374, and `on007788`'s own data migration in #1159.
- **`nemar admin annex-normalize <id>` applies the same fix to a dataset that already
  exists**, which is how `on007788`'s 893 git-resident recordings and the imported
  fleet get migrated. It is a forward fix by construction: a published version
  manifest addresses a git-resident file by its tag-pinned `raw.githubusercontent.com`
  URL, so history is never rewritten and those URLs keep resolving. `--dry-run`
  reports the plan; a clone left dirty by an interrupted attempt is refused rather
  than mistaken for a dataset with nothing left to migrate.
- **A dataset content write now names the branch it means, and a repository pointed at
  the wrong branch is repaired instead of renamed** (#1386). `createOrUpdateFile` left
  `branch` optional and omitted it from the request, so the GitHub Contents API wrote
  to whatever GitHub calls the repository's default branch, while `getFileContent`
  read `main`. Sixteen imported repositories have `default_branch = git-annex` --
  `createRepository` uses `auto_init: false`, so GitHub adopted whichever branch their
  first push happened to carry -- and on fourteen of them the publication
  orchestrator's two DOI writes therefore read `main` and wrote `git-annex`: those
  datasets still advertise OpenNeuro's DOI on `main` while NEMAR's concept DOI and its
  README badge sit on a branch nothing reads. Writes now default to `main` like reads,
  and the two publication sites name it explicitly. `ensureMainBranch` also stops
  renaming in the one case where renaming is wrong: when `main` already exists the
  repository is merely pointed elsewhere, so the default moves to it; renaming stays
  for the case it was written for, a dataset branch actually called `master`.
  The fourteen datasets were then repaired with
  `scripts/repair-doi-metadata.ts`, which applies the same rule against main's
  current content rather than copying June's stranded blobs: `DatasetDOI` became the
  concept DOI, the OpenNeuro DOI moved to `SourceDatasets`, and the badge went to the
  top of `README.md`. Two of the sixteen are absent from the catalog and were skipped
  rather than guessed at. Each repair was confirmed by reading `main` back, and all
  fourteen BIDS validations passed afterwards. The script requires **two** witnesses
  to agree before it writes: NEMAR's catalog and the value publish actually wrote,
  which for these repositories is the copy stranded on `git-annex`. A dataset where
  they disagree is reported and skipped, because a re-minted or rolled-back DOI would
  otherwise be written confidently onto published metadata and the post-write check,
  comparing `main` against the same catalog value, would agree with itself. For the
  same reason `--apply` refuses `--scan`: discovery is a sweep, and writing to
  published metadata is done one named dataset at a time.
  `ensureMainBranch` now reports which of the two things it did -- `repointed` when it
  moved the default to an existing `main`, `renamed` only when it renamed -- because
  both spellings reach an operator-facing audit trail, and one that says a branch was
  renamed when none was is the same class of misdirection that made this bug hard to
  find.
- **A dataset migration no longer hands git-annex a temporary key without its session
  token** (#1380). `normalize-dataset.ts` enabled the S3 remote with credentials minted
  for the dataset and then let the transfer inherit the environment, where there were
  none: git-annex fell back to the key and secret `enableremote` had cached, signed
  without the session token that makes them valid, and S3 refused every request with a
  bare 403 -- which was mistaken for the API's S3 identity not reaching imported
  (`on######`) prefixes. It does reach them: the identity covers the bucket and the
  per-request session policy is what narrows it, verified by HEAD on the same object
  with the same credentials returning 200 with the token and 403 without. The
  credentials are now threaded to the transfer; the branch that obtains them is the
  branch that states how the bytes move, so there is no default left to forget; a
  temporary key with no session token is refused before any transfer is attempted; and
  the migration probes the prefix before annexing anything, so a refusal costs one HEAD
  rather than an hour. `nemar admin s3 credential-check <id>` reports the same probe on
  demand. A dataset with no data to move now needs no credentials at all, and a policy
  that changed only the git-annex branch is pushed rather than left local.
- **A migration is no longer declared done on a check that cannot fail meaningfully**
  (#1380, #1392). The step that confirmed the uploaded content was
  `git annex fsck --from nemar-s3`, which is the one question git-annex cannot answer
  here: `enableremote` caches the key and secret with nowhere to put the session token,
  so fsck signs without one and S3 returns 403 -- the same 403 it returns for an object
  that is not there. A red result therefore did not mean the content was missing, and a
  green one would not have meant it was present. `on006979`'s migration is what surfaced
  it: the PDF was in the bucket and the location log recorded it, and the run still
  reported `fsck: 1 failed`. The check is now a HEAD carrying the credentials that moved
  the bytes, `absent` and `unconfirmed` are kept apart rather than collapsed, and it runs
  **before** the push instead of after -- a tree naming keys whose content never arrived
  is what stranded `on003490` and `on005121` behind a permanent DOI, and the clone is
  still re-runnable right up until it is pushed. For a remote whose credentials git-annex
  does hold in full, the verifier reads the location log after fsck has pruned it, since
  fsck only checks claims that were already made and an upload that moved nothing makes
  none.
- **The per-user IAM provisioning that STS replaced is gone from the backend** rather
  than sitting there with no callers (#1380). `generateS3PolicyDocument`,
  `generateAdminS3PolicyDocument`, `createIamUser`, `createAccessKey`, `putUserPolicy`
  and `generateIamUsername` had no call site outside their own module; the two
  generators are why #1380 was first read as an identity-policy gap, since they look
  like the code that would write one and nothing runs them. Revocation stays: an
  account provisioned under the old scheme still carries an `aws_iam_username` in D1
  and an IAM user in the account, and deleting it has to take both away.
- **`nemar admin fleet annex-policy` reports, and fixes, the datasets NEMAR's annex
  policy does not actually govern** (#1374). The sweep reads two things per repository
  straight from GitHub, without cloning it: every tracked `.gitattributes`, and the
  `annex.largefiles` the git-annex branch configures. Measured across the fleet on
  2026-09-13: of 600 imported (`on######`) datasets, 599 configure **no** expression at
  all and carry upstream's attributes instead (693 files, 6,094 rules), and one --
  `on007788`, migrated in #1159 -- is compliant. The 198 uploaded (`nm######`) datasets
  all configure one, but 195 configure a version written before `*_motion.tsv` joined
  the policy, and 29 of those predate the metadata exclusions entirely. So a motion
  recording added to almost any dataset in the fleet today would still land in git,
  which is #1158 with a wider blast radius than #1159 closed. The fix per repository is
  the import's own: strip the inherited attributes, write NEMAR's expression, one
  commit, no data moved and no S3 traffic. Three datasets (`on006979`, `nm000180`,
  `nm000228`) also keep data in git and are reported and skipped rather than
  half-fixed: those need the upload leg, which is `nemar admin annex-normalize <id>`.
  Read-only by default, `--apply` in batches (ADR 0020: a push per repository starts
  that repository's BIDS validation), and every applied dataset is verified by reading
  GitHub back.

### Migrations

`0085_anonymous_deposit` adds `datasets.first_published_at` and `datasets.anonymous`, two
`BEFORE INSERT` / `BEFORE UPDATE` triggers that abort any row which is simultaneously
anonymous and published, a partial index on `anonymous = 1`, and one backfill that stamps
`first_published_at` for every dataset with evidence of publication (a version row, a
concept DOI, a `publish_date`, or `visibility = 'public'`), earliest evidence first.
`0086_publication_request_anonymous` adds `publication_requests.anonymous` and re-opens the
requests an earlier build had parked with `block_reason = 'anonymous_deposit'`. Both
additive. `0083_docs_sessions` carries a comment-only correction (the docs gate is not
ORCID-backed); the file is already applied everywhere and `wrangler d1 migrations apply`
tracks by name, so nothing replays.

### Deploy coupling

**`nemarOrg/website#334` depends on this release and must ship after it.** The website's
README panel now fetches `data.nemar.org/<id>/<version>/README.md` instead of
`raw.githubusercontent.com`, and it drops `raw.githubusercontent.com` from `connect-src` in
the same change. Before this release the data plane answers that URL with a 302 to the raw
host, and a CSP applies to a redirect target, so shipping the website first would break the
README panel on every dataset page in production.

## 0.10.3 - 2026-09-10

### Security

- **The admin documentation was publicly readable, and is now gated.** Every page under
  `docs.nemar.org/admin/*` answered 200 to an anonymous request, and all twelve were listed
  in the public sitemap. The Cloudflare Access application believed to be protecting them
  covers that Pages project's preview deployments only and never covered the production
  hostname. Those pages now sit behind NEMAR's own ORCID-backed session with an admin-role
  check, handed to the documentation host through a sixty-second one-time code, so
  `users.role` in D1 stays the single source of truth for who is an admin (ADR 0056,
  #1345, #1355). Nothing confidential was exposed: procedures and identifiers in a public
  repository, never credential values.

### Fixed

- **Web sessions authenticated past their expiry, by up to a day.**
  `web_sessions.expires_at` was written as a JavaScript ISO string while every reader
  compares it against SQLite's `datetime('now')`. SQLite compares them as text, and byte 11
  decides it, so an expiry bearing the same calendar date as the comparison always won.
  Writes are SQL-side now, and migration 0084 rewrites the rows already stored. **If you
  were signed in to nemar.org you may be signed out when this deploys**; sign in again.
- **Revoking or demoting an account did not reach its browser credentials.** The session row
  survived, inert while the account was revoked, and a later re-approval handed it back to
  whichever browser still held the cookie. A revoke now clears every session and grant; a
  demotion clears the documentation credential and deliberately leaves the ordinary
  dashboard session alone, since a demoted account is still a legitimate user.
- **A documentation session could authenticate the management API.** Both credential scopes
  live in one table, and one of the two readers of it lacked the scope predicate. Caught in
  review, never deployed.
- **The import workflow's failure reporters posted nothing at all when the log held no
  failure marker.** Actions runs a `run:` step under `bash -e`, and the reporters add
  `pipefail`, so a `grep` that found nothing killed the step before its named fallback: an
  out-of-memory kill, an evicted runner or a cancellation reported the stage roll-up that
  this work replaced. Fixed in both copies of the workflow (#1366,
  `nemarDatasets/.github#116`).
- **The reconcile reported "no import row" for datasets that had one.** Row existence was
  derived from the unresolved slice rather than from the table, so an issue whose import had
  since completed or rolled back was named as untracked, and the human remedy for that
  finding then suppresses the issue from the report permanently (#1363).

### Changed

- **Signing out of nemar.org also ends the account's documentation sessions**, on every
  device, and destroys any outstanding one-time grant, in a single transaction (#1361).
- **Every unrouted path on `api.nemar.org` now answers with the JSON 404 body**
  `{"error":"Not Found","message":"Route <METHOD> <path> not found"}` instead of plain text.
  Route-level 404s are unchanged. Hono's `route()` copies a sub-app's routes and not its
  notFound handler, so the JSON body had only ever been served by the `data.nemar.org` fork.
- The role-change audit record gains `docs_sessions_revoked`.

### Added

- **The import pipeline records the real failure instead of a stage roll-up**, and classifies
  it, so an expired token no longer reads the same as a diverged branch (#1351).
- **`nemar admin import-issue-triage` reconciles failures against their tracking issues** and
  reports disagreement in both directions. Report-only: it files nothing (ADR 0055, #1353).
- `nemar admin import-coverage` and `import-weekly` no longer suggest filing a bug when they
  exit non-zero. Those exit codes are the verdict, and they have not changed (#1358).

### Migrations

`0083_docs_sessions` (a metadata-only `ADD COLUMN` with a CHECK, a partial index, and the
`docs_grants` table) and `0084_web_session_expiry_format` (one idempotent in-place `UPDATE`
over `web_sessions`). Both additive.

### Deploy coupling

`nemarOrg/docs#32` and `nemarOrg/website#328` depend on this release and must ship after it.
Before it, the documentation middleware maps an unrouted `verify` to a 503 on every
`/admin/*` page, and the website's authorize page reads the unrouted 404 as "not an admin"
and sends a real admin to `/404`.

### Known limitation

This release fixes the JavaScript-timestamp-versus-SQL-datetime comparison for web sessions
only. The same pattern remains in `auth_codes` and `orcid_link_intents`, so an emailed
sign-in code's ten-minute window is currently longer in practice than advertised; the codes
are still single-use and attempt-capped. Tracked in #1359.

## 0.10.2 - 2026-09-10

**The import pipeline reports its own health** (epic #1337). Before this, a failed OpenNeuro
import was visible only to whoever went looking in D1.

### Added

- The real failure reason is captured and classified rather than recorded as the stage that
  was running (#1325).
- Recovered imports close their own tracking issues, issues whose cause has changed are
  relabeled, and a burst rolls up into one issue instead of flooding the tracker (#1328,
  ADR 0052).
- A coverage sweep, so the pipeline reports its own silence: nothing arriving is only good
  news if there was work to do (#1331, ADR 0053).
- A weekly summary issue that arrives whether or not anything is wrong (#1333, ADR 0054).

### Fixed

- **Tests could sign in to production.** The default test target was the production API, so a
  test run authenticated against real accounts. It is the dev worker now (#1343).
- `nemar auth login -k ""` no longer stores an empty key (#1343).
- The `iam-removal` suite skips instead of failing when it has no live target (#1348).
- Two false failures in the MCP verification script (#1335).

### Changed

- CORS accepts the website's Pages preview hostnames, so a preview deployment can call the
  API (#1347).

## 0.10.1 - 2026-09-09

**The NEMAR MCP server** (epic #1065): agents reach the catalog through a typed tool surface
at `mcp.nemar.org` rather than by scraping the API.

### Added

- Host fork and discovery tools: `search_datasets`, `describe_dataset` (#1323).
- Recording tools: `list_recordings`, `get_events`, `render_overview` (#1326).
- A `read_window` recipe with a capped taste of the data, so a client can sample a recording
  without downloading it (#1327).
- A Python client verification, so the contract is exercised by something that is not this
  repository (#1330, ADR 0050).

### Changed

- ADR 0049 supersedes 0025 on compute locality (#1292).

## 0.10.0 - 2026-09-08

**ORCID-first CLI sign-in and service accounts** (epic #1272). A terminal cannot receive an
OAuth redirect, so `nemar auth login` now uses the device authorization grant (RFC 8628),
the pattern `gh auth login` uses.

### Added

- The backend device authorization flow, with the key minted only when the CLI collects it,
  never when the browser confirms (#1287, ADR 0047).
- `nemar auth login` and `signup` on that flow, with `-k`/`--key` kept as the explicit
  paste-a-key fallback for a headless host (#1289).
- Named API keys, one row per machine, so a new sign-in never revokes another machine's key,
  and `nemar auth keys` to manage them (#1287).
- Account kinds: `person`, `service`, `test`, set only by an owner and never inferred
  (#1290, ADR 0048).

### Fixed

- Admin notifications are gated to production, so a non-production job cannot email real
  people (#1305).
- The dev worker's email allow-list holds exact addresses as a secret, with no domain
  wildcards (#1319).
- Three live-tier device-flow test failures (#1301), and stale premises in the passwordless
  live tests (#1317).

### Changed

- OpenNeuro auto-import re-enabled on production (#1308).

## 0.9.16 - 2026-09-07

**Account tiers, upload access, and identity parity** (epic #1250). `verified` becomes a real
tier that needs no administrator, and upload access becomes a thing you ask for once.

### Added

- `verified` is the base tier: browse, dashboard, settings and sandbox need no admin
  (#1262, ADR 0040).
- Upload access is requested once, by the person who wants it, and each missing field is
  named in a typed refusal (#1265, ADR 0042).
- CLI self-service for identity fields, and CLI/web parity for what an account is told about
  itself (#1269, #1270, ADR 0045).
- `nemar --debug` writes a diagnostic bundle (#1257).
- Real-name DOI attribution (#1260).

### Changed

- Approval grants upload access rather than acting as the gate on everything (#1258).
- Identity uniqueness: an ORCID iD, an email or a GitHub handle backs at most one live
  account (#1264, ADR 0043).
- An unverified ORCID blocks the upload-access request (#1273).
