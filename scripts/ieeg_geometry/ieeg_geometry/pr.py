"""Open one reviewable pull request that adds the pipeline's outputs to a dataset repository.

`open_pr` runs on the owner's machine with the owner's own git identity and `gh` login. It
clones the dataset at its current `main` into a fresh directory, runs the pipeline with apply,
checks that the work tree differs from `main` in exactly the paths the report's `changes` list
names, commits those paths once on `nemar/ieeg-geometry-<pipeline version>`, pushes that branch
(never `main`, never forced) and runs `gh pr create` against `main`. It never merges. With
`dry_run` everything up to and including the commit happens, and the body is printed instead of
pushing and opening.

Refusals (`PrRefusal`, a clear message, nothing pushed): a protected or malformed id, an
existing work directory, no git identity, a clone not on `main`, a branch that already exists on
the remote, an errored track, an apply that changed nothing (not for `--from-ref`, below), any
difference outside `changes`,
a staged set that is not exactly `changes`, a staged blob that is not the work-tree bytes (a
git-annex filter must never turn a sidecar into a pointer), and, for a real run only, a
remote that is not `nemarDatasets/<id>`, a missing release tag, and an input that changed after
the release and could not be fetched. Small files are read from the fresh clone of `main`;
annexed files are downloaded from the data plane at the release version. A `main` ahead of the
release is otherwise recorded in the body (every changed path, at most 50 listed), not refused:
the files are computed from `main`.

An integration run (`--from-ref`) whose apply changes nothing is not refused: the collaborator's
branch may already hold what the pipeline would write. No geometry commit is made, no ownership
file is written, `--bump-version` still applies (its own "Set Version to X" commit, only when the
Version changes), and a branch with no new commit is not pushed. The pull request is opened or
updated all the same, and its body says the geometry adds no files, with the reasons per track.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from . import fetch, pipeline, versionbump
from .ownership import OwnedPath, read_ownership
from .version import pipeline_version

ORG = "nemarDatasets"
BASE = "main"
DOCS_URL = "https://docs.nemar.org/data/ieeg-geometry/"
BODY_LIMIT = 60_000  # GitHub refuses a pull request body over 65,536 characters
GITHUB_BODY_MAX = 65_536  # characters GitHub accepts in a pull request body
_TIMEOUT_S = 900
NEUTRAL_GIT_CONFIG = fetch.NEUTRAL_GIT_CONFIG  # one definition; every git call here uses it
UNRELEASED_DIRS = (".nemar/", ".github/")  # main may change these after a release
UNRELEASED_FILES = (".gitattributes",)  # exact names, not prefixes
DESCRIPTION = "dataset_description.json"


class PrRefusal(Exception):
    """The pull request cannot be opened; the message says why."""


@dataclass
class PrResult:
    branch: str
    commit: str
    title: str
    body: str
    url: str | None  # None for a dry run


def branch_name(version: str) -> str:
    return f"nemar/ieeg-geometry-{version}"


def title(version: str) -> str:
    return f"Add NEMAR-computed iEEG geometry (pipeline {version})"


def _run(
    cmd: list[str], cwd: Path | None, what: str, env_extra: dict[str, str] | None = None
) -> str:
    env = os.environ | {"GIT_TERMINAL_PROMPT": "0"} | (env_extra or {})
    try:
        done = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, check=True, timeout=_TIMEOUT_S, env=env
        )
    except FileNotFoundError as exc:
        raise PrRefusal(f"{what}: {cmd[0]} is not installed") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "").strip()[:400]
        raise PrRefusal(f"{what} failed: {detail}") from exc
    except subprocess.TimeoutExpired as exc:
        raise PrRefusal(f"{what} timed out") from exc
    return done.stdout


def _git(clone: Path, *args: str, what: str | None = None, neutral: bool = True) -> str:
    """Runs git with the git-annex filter and global attributes switched off (see `fetch`)."""
    config = [x for c in NEUTRAL_GIT_CONFIG for x in ("-c", c)] if neutral else []
    cmd = ["git", *config, "-C", str(clone), "--literal-pathspecs", *args]
    return _run(
        cmd, None, what or f"git {args[0]}", {"GIT_ATTR_NOSYSTEM": "1"} if neutral else None
    )


def _paths(clone: Path, *args: str, neutral: bool = False) -> set[str]:
    return {p for p in _git(clone, *args, "-z", neutral=neutral).split("\0") if p}


def check_staged(staged: set[str], expected: set[str]) -> None:
    """The staged set must be exactly the report's changes; the refusal names the difference."""
    missing, extra = sorted(expected - staged), sorted(staged - expected)
    if missing or extra:
        raise PrRefusal(
            "the staged paths are not exactly the reported changes: "
            f"missing {missing[:10] or 'none'}, extra {extra[:10] or 'none'}"
        )


def verify_staged_bytes(clone: Path, paths: set[str]) -> None:
    """Every staged file is a regular file holding the work-tree bytes, never an annex pointer."""
    wanted = set(paths)
    out = _git(clone, "ls-files", "-s", "-z", neutral=True)
    for record in out.split("\0"):
        if not record:
            continue
        meta, _, path = record.partition("\t")
        mode, sha, _stage = meta.split(" ")
        if path not in wanted:
            continue
        wanted.discard(path)
        if mode != "100644":
            raise PrRefusal(f"{path} is staged with mode {mode}; only regular files are proposed")
        blob = _git(clone, "cat-file", "blob", sha, neutral=True)
        if blob.startswith(("/annex/objects/", "version https://git-annex")):
            raise PrRefusal(f"{path} would be committed as a git-annex pointer, not its bytes")
        disk = _git(clone, "hash-object", "--no-filters", "--", path, neutral=True).strip()
        if disk != sha:
            raise PrRefusal(f"the staged blob of {path} is not the file in the work tree")
    if wanted:
        raise PrRefusal(f"not staged: {sorted(wanted)[:10]}")


def _status_entries(clone: Path) -> list[tuple[str, str]]:
    """(two-letter status, path) for every difference between the work tree and the index."""
    out = _git(clone, "status", "--porcelain=v1", "-z", "--untracked-files=all", neutral=True)
    return [(r[:2], r[3:]) for r in out.split("\0") if r]


def _unexpected(
    entries: list[tuple[str, str]], expected: set[str], never_checked_out: set[str]
) -> list[str]:
    """Differences that are neither a reported change nor a path the fetch never checked out."""
    bad = []
    for state, path in entries:
        if path in expected:
            continue
        if state == " D" and path in never_checked_out:
            continue  # tracked at main but not fetched: absent from the work tree by design
        bad.append(f"{state.strip() or '?'} {path}")
    return sorted(bad)


# ---- the pull request body --------------------------------------------------------------------


def _evidence(entry: OwnedPath | None) -> str:
    v = entry.verification if entry else None
    if v is None:
        return "not graded"
    median = "no median" if v.median_mm is None else f"median {v.median_mm:g} mm"
    return f"{v.grade} ({median} against {v.reference}, {v.n_used} of {v.n_total} contacts)"


def _group_key(path: str, entry: OwnedPath | None) -> tuple[str, str, str]:
    if entry is None:
        method = (
            "ownership record" if path == pipeline.OWNERSHIP_REL else "not in the ownership record"
        )
        return (method, "not graded", "-")
    v = entry.verification
    return (entry.method, v.grade if v else "not graded", v.reference if v else "-")


def _section(
    label: str,
    paths: list[str],
    owned: dict[str, OwnedPath],
    detail: bool | None,
    budget: int,
) -> list[str] | None:
    """One group per (method, grade, reference). `detail` True: a line with numbers per file;
    False: paths only; None: counts only (the ownership record lists the added and changed
    files). None when the text does not fit `budget` and a shorter form exists."""
    groups: dict[tuple[str, str, str], list[str]] = {}
    for path in paths:
        groups.setdefault(_group_key(path, owned.get(path)), []).append(path)
    lines = [f"## {label} ({len(paths)})", ""]
    for (method, grade, reference), members in sorted(groups.items()):
        lines.append(f"### {method}, evidence {grade}, reference {reference} ({len(members)})")
        lines.append("")
        if detail is None:
            lines += ["The files are listed in `.nemar/ieeg-geometry.json`.", ""]
            continue
        lines += ["<details><summary>Files</summary>", ""]
        for path in members:
            suffix = f": {_evidence(owned.get(path))}" if detail else ""
            lines.append(f"- `{path}`{suffix}")
        lines += ["", "</details>", ""]
    fits = len("\n".join(lines)) <= budget
    return lines if fits or detail is None else None


def _removed_section(paths: list[str]) -> list[str]:
    """Removed files are always listed in short form: they are no longer in the ownership
    record, so the record cannot stand in for the list."""
    lines = [f"## Removed ({len(paths)}): no longer produced by the pipeline", ""]
    lines += [f"- `{p}`" for p in paths]
    return [*lines, ""]


def _is_mirror(dataset_id: str) -> bool:
    """A mirror (`on` id): its geometry is part of the N.0.1 integration pull request, which
    must carry the final Version (`--bump-version`), because merging it tags the release."""
    return dataset_id.startswith("on")


def _not_fetched(failed: dict[str, str]) -> list[str]:
    """Input files that could not be downloaded: the tracks that need one skip it, and the
    reviewer must see which (the report keeps them as `not fetched:` warnings)."""
    if not failed:
        return []
    items = [f"`{p}`: {r[:MAX_REASON_CHARS]}" for p, r in sorted(failed.items())]
    return [
        f"- Not fetched: {len(failed)} input file(s) could not be downloaded, so what depends "
        "on them was skipped or left as it was:",
        _bullets(items),
    ]


def _ref_lines(ref: tuple[str, list[str]] | None, *, geometry: bool = True) -> list[str]:
    if not ref:
        return []
    name, commits = ref
    tail = "; the geometry is one commit on top:" if geometry else ":"
    return [
        f"- Integration branch `{name}`: {len(commits)} commit(s) not on `main`, kept as "
        f"they are (authorship included){tail}",
        _bullets(commits),
    ]


MAX_REASONS = 6  # distinct reasons listed per track before a count stands for the rest
_ABS_PATH = re.compile(r"(?<![\w.~>/])/(?!/)(?:[\w.@+=-]+/)*[\w.@+=-]+")


def redact_paths(text: str, roots: list[Path]) -> str:
    """No absolute path of the owner's machine in a public body: the clone or work directory
    becomes `<dataset>`, any other absolute path is cut to its basename."""
    names = {str(r) for r in roots} | {str(r.resolve()) for r in roots}
    for name in sorted(names, key=len, reverse=True):
        text = text.replace(name, "<dataset>")
    return _ABS_PATH.sub(lambda m: m.group(0).rsplit("/", 1)[1], text)


def _cut(text: str) -> str:
    return text if len(text) <= MAX_REASON_CHARS else text[: MAX_REASON_CHARS - 3] + "..."


def _track_reasons(report: dict, roots: list[Path]) -> list[str]:
    """What each track decided: per track, its distinct `status: reason` lines with the number
    of electrodes files each covers, most common first, capped like other lists."""
    lines = []
    for track in pipeline.TRACKS:
        tally: dict[str, int] = {}
        for row in report["files"]:
            d = row["decisions"].get(track) or {}
            key = f"{d.get('status', 'skipped')}: {d.get('reason') or 'no reason given'}"
            key = _cut(redact_paths(key, roots))
            tally[key] = tally.get(key, 0) + 1
        ranked = sorted(tally.items(), key=lambda kv: (-kv[1], kv[0]))
        items = [f"{n} file(s), {k}" for k, n in ranked[:MAX_REASONS]]
        if len(ranked) > MAX_REASONS:
            more = sum(n for _, n in ranked[MAX_REASONS:])
            items.append(f"and {more} more file(s) with other reasons")
        lines.append(f"- {track}: " + ("no electrodes files" if not items else "; ".join(items)))
    return lines


def orphans(report: dict, ownership) -> list[str]:
    """Paths the ownership record lists that no track reported this run: recorded, but not
    produced by this run. An electrodes table is reported when a track named it (as its input or
    an output); a coordsystem file also when the electrodes table it sits beside
    (`<prefix>_coordsystem.json` next to `<prefix>_electrodes.tsv`) was reported (a label kept or
    already present writes no file, so it lists none)."""
    if ownership is None:
        return []
    reported = {p for k in ("add", "change", "remove", "kept") for p in report["changes"][k]}
    for row in report["files"]:
        reported.add(row["electrodes"])
        for d in row["decisions"].values():
            reported.update(d.get("outputs") or [])
    missing = []
    for e in ownership.entries:
        if e.path in reported:
            continue
        coord = "_coordsystem.json"
        if e.path.endswith(coord) and e.path[: -len(coord)] + "_electrodes.tsv" in reported:
            continue
        missing.append(e.path)
    return sorted(missing)


def _version_lines(plan: versionbump.Plan | None) -> list[str]:
    if not plan:
        return []
    if plan.kept:
        line = (
            f"- Version: `{DESCRIPTION}` `Version` is already `{plan.new}` on the branch (above "
            f"`main` and every tag), so it is kept; merging this pull request tags `v{plan.new}`"
        )
    else:
        line = (
            f"- Version: `{DESCRIPTION}` `Version` goes from `{plan.current}` to `{plan.new}` "
            f"in this pull request, so the version check passes and merging it tags `v{plan.new}`"
        )
    return [
        line,
        *([f"  - {plan.changes_note} (normal for a mirror)"] if plan.changes_note else []),
    ]


MAX_CLEANING_LINE = 400  # characters per file in the Table cleaning section


def _clip(text: str) -> str:
    return text if len(text) <= MAX_CLEANING_LINE else text[: MAX_CLEANING_LINE - 3] + "..."


def _cleaning_item(entry: dict) -> str:
    parts = []
    if entry.get("dropped_columns"):
        names = ", ".join(f"`{c}`" for c in entry["dropped_columns"])
        parts.append(f"dropped columns: {names}")
    if entry.get("added_columns"):
        names = ", ".join(f"`{c}`" for c in entry["added_columns"])
        parts.append(f"added column: {names}")
    if entry.get("coerced_cells"):
        cells = ", ".join(f"`{c}` ({n})" for c, n in sorted(entry["coerced_cells"].items()))
        parts.append(f"cells set to n/a: {cells}")
    if entry.get("hemisphere_rewritten"):
        parts.append(f"hemisphere values rewritten: {entry['hemisphere_rewritten']}")
    return _clip(f"`{entry['path']}`: " + "; ".join(parts))


def _cleaning_section(entries: list[dict], written: set[str]) -> list[str]:
    """What NEMAR changed in each electrodes table this pull request writes besides the
    coordinates, so the reviewer sees what was not carried over from the source tables. Only
    paths in `written` (the added and changed paths) are listed; empty when nothing is left.
    Long lists are cut by `_bullets` (50 entries, 8,000 characters, then a count)."""
    entries = [
        e for e in entries if e["path"] in written and _cleaning_item(e).partition(": ")[2]
    ]  # something to say
    if not entries:
        return []
    return [
        f"## Table cleaning ({len(entries)})",
        "",
        "NEMAR's electrodes tables below differ from the source tables they were computed from "
        "beyond the coordinates; the source tables are unchanged and keep everything listed.",
        "",
        _bullets([_cleaning_item(e) for e in entries]).replace("  - ", "- "),
        "",
    ]


def build_body(
    report: dict,
    owned: dict[str, OwnedPath],
    *,
    n_surface_sets: int,
    release_note: str | None = None,
    fetch_failed: dict[str, str] | None = None,
    version_bump: versionbump.Plan | None = None,
    ref: tuple[str, list[str]] | None = None,
    ownership_exists: bool = False,
    orphaned: list[str] | None = None,
    roots: list[Path] | None = None,
    limit: int = BODY_LIMIT,
) -> str:
    """The pull request description: every added, changed or removed file with its method and
    evidence grade, shortened in steps only when GitHub's size limit would refuse it. An
    integration run with no files to add gets a short body with the reasons per track."""
    changes = report["changes"]
    added, changed, removed = changes["add"], changes["change"], changes["remove"]
    if ref and not (added or changed or removed):
        return _no_geometry_body(
            report,
            release_note=release_note,
            fetch_failed=fetch_failed,
            version_bump=version_bump,
            ref=ref,
            ownership_exists=ownership_exists,
            orphaned=orphaned or [],
            roots=roots or [],
            n_surface_sets=n_surface_sets,
        )
    lines = [
        "This pull request adds electrode positions and coordinate system files that NEMAR "
        "computed from this dataset's own files, with the verification each one passed.",
        "The authors' files are not changed.",
        "",
        f"- Dataset: `{report['dataset']}`, version `{report['dataset_version']}`, "
        f"source commit `{report['source_commit']}`",
        *([f"- Source: {release_note}"] if release_note else []),
        *_not_fetched(fetch_failed or {}),
        *_ref_lines(ref),
        *_version_lines(version_bump),
        f"- Pipeline: `{report['pipeline_version']}`",
        f"- Files: {len(added)} added, {len(changed)} changed, {len(removed)} removed",
        f"- Subject surface sets for the website's Brain panel: {n_surface_sets} "
        "(display data, uploaded separately; not part of this pull request)",
        f"- Method, evidence grades and how to read them: {DOCS_URL}",
        "- `.nemar/ieeg-geometry.json` lists every pipeline-owned path with the git blob id of "
        "each input file and the verification result",
        "",
        "Each sidecar's `iEEGCoordinateProcessingDescription` starts with "
        '"Computed by NEMAR" and names its source file and method.',
        "",
    ]
    lines += _cleaning_section(report.get("electrodes_cleaning") or [], {*added, *changed})
    reserved = len("\n".join(_removed_section(removed))) if removed else 0
    for label, paths in (("Added", added), ("Changed", changed)):
        if not paths:
            continue
        used = len("\n".join(lines)) + reserved
        for detail in (True, False, None):
            section = _section(label, paths, owned, detail, limit - used)
            if section is not None:
                lines += section
                break
    if removed:
        lines += _removed_section(removed)
    if _is_mirror(report["dataset"]) and version_bump:
        lines += [
            "",
            f"Merging this pull request cuts `v{version_bump.new}` (the release workflow tags the "
            "Version on `main`); do not also run `nemar dataset release`, which would cut a "
            "further patch.",
        ]
    return "\n".join(lines).rstrip() + "\n"


def _no_geometry_body(
    report: dict,
    *,
    release_note: str | None,
    fetch_failed: dict[str, str] | None,
    version_bump: versionbump.Plan | None,
    ref: tuple[str, list[str]],
    ownership_exists: bool,
    orphaned: list[str],
    roots: list[Path],
    n_surface_sets: int,
) -> str:
    lines = [
        "This pull request integrates the collaborator changes on this branch into `main`.",
        "NEMAR's geometry adds no files on this branch: the pipeline found nothing to write, "
        "so there is no geometry commit.",
        *(
            [
                "",
                f"Warning: {len(orphaned)} path(s) in `{pipeline.OWNERSHIP_REL}` are recorded but "
                "not produced by this run; they would block other tracks (listed below).",
            ]
            if orphaned
            else []
        ),
        "",
        f"- Dataset: `{report['dataset']}`, version `{report['dataset_version']}`, "
        f"source commit `{report['source_commit']}`",
        *([f"- Source: {release_note}"] if release_note else []),
        *_not_fetched(fetch_failed or {}),
        *_ref_lines(ref, geometry=False),
        *_version_lines(version_bump),
        f"- Pipeline: `{report['pipeline_version']}`",
        f"- Subject surface sets for the website's Brain panel: {n_surface_sets} "
        "(display data, uploaded separately; not part of this pull request)",
        *(
            [f"- `{pipeline.OWNERSHIP_REL}` is already on the branch and is left exactly as it is"]
            if ownership_exists
            else []
        ),
        f"- Method, evidence grades and how to read them: {DOCS_URL}",
        "",
        "What each track decided, as electrodes files per decision (none of it adds a file "
        "to this pull request):",
        "",
        *_track_reasons(report, roots),
        "",
        *(
            [
                f"## Recorded but not produced by this run ({len(orphaned)})",
                "",
                f"These paths are in `{pipeline.OWNERSHIP_REL}` but no track reported them this "
                "run, so they are recorded as NEMAR's and would block other tracks:",
                _path_list(orphaned),
                "",
            ]
            if orphaned
            else []
        ),
    ]
    if _is_mirror(report["dataset"]) and version_bump:
        lines += [
            f"Merging this pull request cuts `v{version_bump.new}` (the release workflow tags the "
            "Version on `main`); do not also run `nemar dataset release`, which would cut a "
            "further patch.",
        ]
    return "\n".join(lines).rstrip() + "\n"


def check_body_size(body: str) -> None:
    if len(body) > GITHUB_BODY_MAX:
        raise PrRefusal(
            f"the pull request body is {len(body)} characters; GitHub accepts {GITHUB_BODY_MAX}"
        )


# ---- the release ------------------------------------------------------------------------------


MAX_LISTED_PATHS = 50  # paths named in the Source section before a count stands for the rest
MAX_LISTED_CHARS = 8_000  # and a character budget, so long names cannot crowd out the body
MAX_REASON_CHARS = 100


def _bullets(items: list[str]) -> str:
    """Sub-bullets: at most 50 and 8,000 characters, then a count of the rest."""
    shown: list[str] = []
    used = 0
    for item in items[:MAX_LISTED_PATHS]:
        used += len(item) + 8
        if used > MAX_LISTED_CHARS:
            break
        shown.append(f"  - {item}")
    rest = len(items) - len(shown)
    if rest:
        shown.append(f"  - and {rest} more")
    return "\n".join(shown)


def _path_list(paths: list[str]) -> str:
    return _bullets([f"`{p}`" for p in paths])


def release_status(
    clone: Path,
    version: str,
    failed: dict[str, str] | None = None,
    label: str = BASE,
    adds_files: bool = True,
) -> tuple[str, bool]:
    """(note for the body or the refusal, whether a real run may proceed).

    Small files are read from the fresh clone of `main`; annexed files are downloaded from the
    data plane at the release `version`. So a real run needs the release tag, and refuses when an
    input that could not be fetched is one that changed after the release (its bytes are not at
    the release). A `main` ahead of the release otherwise is recorded in the body, not refused:
    the mirror's patch release publishes `main`."""
    failed = failed or {}
    head = _git(clone, "rev-parse", "HEAD").strip()
    try:
        tag = _git(clone, "rev-parse", "--verify", "-q", f"refs/tags/{version}^{{commit}}").strip()
    except PrRefusal:
        return (
            f"no tag {version} exists, so `{label}` ({head[:12]}) cannot be compared to the "
            "release that serves the annexed inputs; a real run needs the release tag",
            False,
        )
    if tag == head:
        return f"`{label}` is the release {version} ({head[:12]})", True
    moved = _paths(clone, "diff", "--name-only", "--no-renames", tag, head)
    stale = sorted(set(failed) & moved)
    if stale:
        return (
            f"{len(stale)} input file(s) changed after release {version} and could not be "
            "fetched, because annexed bytes are downloaded at the release: "
            + ", ".join(f"`{p}`" for p in stale[:10])
            + (f" and {len(stale) - 10} more" if len(stale) > 10 else ""),
            False,
        )
    other = sorted(p for p in moved if not (p.startswith(UNRELEASED_DIRS) or p in UNRELEASED_FILES))
    if other:
        return (
            f"`{label}` ({head[:12]}) is ahead of release {version} ({tag[:12]}). "
            + (
                f"The geometry files in this pull request were computed from `{label}`, which the "
                "patch release will publish together with these changes"
                if adds_files
                else f"The pipeline ran on `{label}` and adds no files; the patch release will "
                f"publish `{label}` as it is"
            )
            + f" (annexed inputs are unchanged since the release). {len(other)} path(s) outside "
            "`.nemar/`, `.github/` and "
            f"`.gitattributes` changed since the release; every changed path, sorted:\n"
            f"{_path_list(sorted(moved))}",
            True,
        )
    return (
        f"`{label}` ({head[:12]}) is ahead of release {version} ({tag[:12]}) only under "
        "`.nemar/`, `.github/` and `.gitattributes`",
        True,
    )


# ---- the flow ---------------------------------------------------------------------------------


def _default_remote(dataset_id: str) -> str:
    return fetch.REPO_URL.format(id=dataset_id)


def _same_remote(a: str, b: str) -> bool:
    return a.removesuffix("/").removesuffix(".git") == b.removesuffix("/").removesuffix(".git")


def _plan_bump(clone: Path) -> versionbump.Plan:
    """The Version the pull request carries (see `versionbump.plan`), from the branch's
    description, `main`'s, the release tags and `CHANGES`; a `PrRefusal` when none can be chosen."""
    try:
        description = (clone / DESCRIPTION).read_bytes().decode("utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise PrRefusal(f"cannot read {DESCRIPTION} to bump the version: {exc}") from exc
    names = set(_paths(clone, "ls-tree", "--name-only", "HEAD"))
    changes = next(
        (
            _git(clone, "show", f"HEAD:{n}", neutral=True)
            for n in versionbump.CHANGES_NAMES
            if n in names
        ),
        None,
    )
    main_description = _git(clone, "show", f"origin/{BASE}:{DESCRIPTION}", neutral=True)
    tags = _git(clone, "tag", "--list").split()
    try:
        return versionbump.plan(description, main_description, tags, changes)
    except versionbump.BumpRefusal as exc:
        raise PrRefusal(f"--bump-version: {exc}") from exc


_PLAIN_BRANCH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")


def check_from_ref(name: str) -> None:
    """Only a plain branch name other than `main`: the push must never reach `main` or a ref."""
    if (
        name == BASE
        or name.startswith("refs/")
        or ".." in name
        or name.endswith((".lock", "/", "."))
        or not _PLAIN_BRANCH.match(name)
    ):
        raise PrRefusal(
            f"--from-ref {name!r} must be a plain branch name other than {BASE!r} "
            "(the geometry is pushed to that branch)"
        )


def _ref_commits(clone: Path) -> list[str]:
    """Commits on the branch that are not on `main`: short sha, author, subject."""
    out = _git(clone, "log", "-z", "--format=%h%x1f%an%x1f%s", f"origin/{BASE}..HEAD", neutral=True)
    rows = [r.split("\x1f") for r in out.split("\0") if r.strip()]
    # code spans, so a collaborator's `@name` in a subject or author does not notify anyone
    return [f"`{h}` `{(a + ': ' + subj).replace(chr(96), chr(39))}`" for h, a, subj in rows]


def open_pr(
    dataset_id: str,
    workdir: Path,
    *,
    version: str | None = None,
    bump_version: bool = False,
    from_ref: str | None = None,
    dry_run: bool = False,
    surfaces_out: Path | None = None,
    urls: dict[str, str] | None = None,
    expect_remote: str | None = None,
    out=None,
) -> PrResult:
    """`expect_remote` is the repository URL a real run may push to (default: the dataset's
    own `nemarDatasets/<id>`); the command line never changes it, tests do."""
    out = out or sys.stdout
    pipeline.check_dataset_id(dataset_id)
    if from_ref is not None:
        check_from_ref(from_ref)
    pv = pipeline_version()
    ttl = title(pv)
    branch = from_ref or branch_name(pv)
    pr_title = (
        f"Integrate collaborator changes and add NEMAR-computed iEEG geometry (pipeline {pv})"
        if from_ref
        else ttl
    )
    no_geometry_title = (
        f"Integrate collaborator changes (NEMAR geometry adds no files, pipeline {pv})"
    )
    if _is_mirror(dataset_id) and not bump_version:
        raise PrRefusal(
            f"{dataset_id} is a mirror: its geometry goes in the one integration pull request "
            "that carries the final Version, because merging it tags the release and mints the "
            "version DOI. Run `pr <id> --from-ref <branch> --bump-version` (see "
            ".rules/release-and-repull.md)"
        )
    workdir = Path(workdir)
    if (workdir / dataset_id).exists():
        raise PrRefusal(
            f"{workdir / dataset_id} exists; the pull request starts from a fresh clone"
        )
    urls = urls or {}
    repo_url = (urls.get("repo_url") or fetch.REPO_URL).format(id=dataset_id)
    allowed = (expect_remote or _default_remote(dataset_id)).format(id=dataset_id)
    if not dry_run and not _same_remote(repo_url, allowed):
        raise PrRefusal(
            f"{repo_url} is not {allowed}; a real run pushes only to the dataset's own repository"
        )
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        _run(["git", "var", "GIT_AUTHOR_IDENT"], workdir, "git identity")
    except PrRefusal as exc:
        raise PrRefusal(
            "no git identity: set user.name and user.email (the commit is yours)"
        ) from exc
    got = fetch.fetch_files(
        dataset_id,
        workdir,
        version=version,
        repo_url=urls.get("repo_url") or fetch.REPO_URL,
        data_url=urls.get("data_url") or fetch.DATA_URL,
        api_url=urls.get("api_url") or fetch.API_URL,
        ref=from_ref,
    )
    clone = got.clone
    on = from_ref or BASE
    if _git(clone, "symbolic-ref", "--short", "HEAD").strip() != on:
        raise PrRefusal(f"the clone is not on {on}; the pull request is made against {BASE}")
    release_note, release_ok = release_status(clone, got.version, got.failed, label=on)
    if not release_ok and not dry_run:
        raise PrRefusal(release_note)
    if not release_ok:
        out.write(f"warning: {release_note} (a real run refuses)\n")
    if (
        not from_ref
        and _git(clone, "ls-remote", "--heads", "origin", f"refs/heads/{branch}").strip()
    ):
        raise PrRefusal(f"branch {branch} already exists on the remote; nothing was pushed")
    bump = _plan_bump(clone) if bump_version else None
    checked_out = _paths(clone, "ls-files")
    _git(clone, "read-tree", "HEAD")  # the index is main's whole tree; only changes will differ
    never_checked_out = _paths(clone, "ls-files") - checked_out

    analysis, _written = pipeline.run_dataset(
        dataset_id,
        workdir,
        version=got.version,
        do_apply=True,
        surfaces_out=surfaces_out,
        repo_url=urls.get("repo_url"),
        data_url=urls.get("data_url"),
        api_url=urls.get("api_url"),
    )
    if analysis.errors:
        tracks = "; ".join(f"{t}: {m}" for t, m in sorted(analysis.errors.items()))
        raise PrRefusal(f"a track errored, so nothing was applied ({tracks})")
    report = analysis.report
    changes = report["changes"]
    expected = set(changes["add"]) | set(changes["change"]) | set(changes["remove"])
    no_geometry = not expected
    if no_geometry and not from_ref:
        raise PrRefusal("the apply produced no changes; there is nothing to propose")
    if no_geometry:
        pr_title = no_geometry_title
        release_note, _ = release_status(clone, got.version, got.failed, label=on, adds_files=False)
    bad = _unexpected(_status_entries(clone), expected, never_checked_out)
    if bad:
        shown = "; ".join(bad[:10]) + (f"; and {len(bad) - 10} more" if len(bad) > 10 else "")
        raise PrRefusal(f"the work tree differs from main outside the reported changes: {shown}")

    to_stage = set(changes["add"]) | set(changes["change"])
    if bump and not bump.kept:
        target = clone / DESCRIPTION
        text = versionbump.apply(target.read_bytes().decode("utf-8"), bump.new)
        target.write_bytes(text.encode("utf-8"))  # only the version's characters differ
        to_stage.add(DESCRIPTION)
        expected = expected | {DESCRIPTION}
    for rel in sorted(to_stage):
        _git(clone, "add", "--", rel, neutral=True)
    for rel in sorted(changes["remove"]):
        _git(clone, "rm", "-q", "--cached", "--ignore-unmatch", "--", rel, neutral=True)
    check_staged(_paths(clone, "diff", "--cached", "--name-only", "--no-renames"), expected)
    verify_staged_bytes(clone, to_stage)
    ownership = read_ownership(clone)  # None when there is none
    owned = {e.path: e for e in ownership.entries} if ownership else {}
    body = build_body(
        report,
        owned,
        n_surface_sets=len(report.get("surface_entries", [])),
        release_note=release_note,
        fetch_failed=got.failed,
        version_bump=bump,
        ref=(from_ref, _ref_commits(clone)) if from_ref else None,
        ownership_exists=ownership is not None,
        orphaned=orphans(report, ownership) if no_geometry else [],
        roots=[clone, workdir],
    )
    check_body_size(body)
    if not from_ref:
        _git(clone, "checkout", "-q", "-b", branch)
    staged_now = _paths(clone, "diff", "--cached", "--name-only", "--no-renames")
    if staged_now:
        message = f"Set Version to {bump.new}" if no_geometry and bump else ttl
        _git(clone, "commit", "-q", "-m", message, what="git commit", neutral=True)
    commit = _git(clone, "rev-parse", "HEAD").strip()
    new_commit = commit != got.commit
    if dry_run:
        out.write(f"branch {branch}, commit {commit}\ntitle: {pr_title}\n\n{body}")
        return PrResult(branch, commit, pr_title, body, None)

    body_file = workdir / f"{dataset_id}.pr-body.md"
    body_file.write_text(body, encoding="utf-8")
    if from_ref:
        now = _git(clone, "ls-remote", "--heads", "origin", f"refs/heads/{branch}").split()[:1]
        if now != [got.commit]:
            raise PrRefusal(
                f"branch {branch} moved on the remote since the clone ({got.commit[:12]} -> "
                f"{(now or ['gone'])[0][:12]}); nothing was pushed, rerun"
            )
    pushed_note = (
        f"branch {branch} was pushed"
        if new_commit or not from_ref
        else f"nothing was pushed (branch {branch} already holds everything)"
    )
    lease = [f"--force-with-lease=refs/heads/{branch}:{got.commit}"] if from_ref else []
    if new_commit:  # a branch with nothing new on it is not pushed
        _git(
            clone,
            "push",
            *lease,
            "origin",
            f"refs/heads/{branch}:refs/heads/{branch}",
            what="git push",
        )
    if from_ref:
        try:
            listed = _run(
                ["gh", "pr", "list", "--repo", f"{ORG}/{dataset_id}", "--head", branch,
                 "--state", "open", "--json", "number,url,headRepositoryOwner,baseRefName"],
                clone, "gh pr list",
            )  # fmt: skip
        except PrRefusal as exc:
            raise PrRefusal(
                f"{exc}; {pushed_note}; rerun to open or update the pull request"
            ) from exc
        open_prs = [  # a fork's PR with the same branch name is not this branch's PR
            p
            for p in json.loads(listed or "[]")
            if (p.get("headRepositoryOwner") or {}).get("login") == ORG
            and p.get("baseRefName") == BASE
        ]
        if len(open_prs) > 1:
            raise PrRefusal(
                f"branch {branch} has {len(open_prs)} open pull requests into {BASE}; "
                f"{pushed_note}, edit the right one by hand"
            )
        if open_prs:
            edit = [
                "gh", "pr", "edit", str(open_prs[0]["number"]),
                "--repo", f"{ORG}/{dataset_id}",
                "--title", pr_title,
                "--body-file", str(body_file),
            ]  # fmt: skip
            _run(edit, clone, "gh pr edit")
            out.write(open_prs[0]["url"] + "\n")
            return PrResult(branch, commit, pr_title, body, open_prs[0]["url"])
    create = [
        "gh", "pr", "create",
        "--repo", f"{ORG}/{dataset_id}",
        "--base", BASE,
        "--head", branch,
        "--title", pr_title,
        "--body-file", str(body_file),
    ]  # fmt: skip
    # an integration branch carries the collaborator's merge and fixes: never suggest deleting it
    undo = (
        f"; or delete the pushed branch: git -C {clone} push origin --delete {branch}"
        if not from_ref
        else ""
    )
    try:
        printed = _run(create, clone, "gh pr create")
    except PrRefusal as exc:
        raise PrRefusal(
            f"{pushed_note}, but the pull request was not opened ({exc}). "
            f"Open it by hand: {shlex.join(create)} (run in {clone}){undo}"
        ) from exc
    lines = [ln.strip() for ln in printed.splitlines() if ln.strip()]
    url = lines[-1] if lines and lines[-1].startswith("http") else None
    if url is None:
        raise PrRefusal(
            f"{pushed_note}, but gh printed no pull request URL ({printed.strip()}). "
            f"Open it by hand: {shlex.join(create)} (run in {clone}){undo}"
        )
    out.write(url + "\n")
    return PrResult(branch, commit, pr_title, body, url)
