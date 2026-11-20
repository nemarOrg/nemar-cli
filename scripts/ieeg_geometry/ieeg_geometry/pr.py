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
the remote, an errored track, an apply that changed nothing, any difference outside `changes`.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from . import fetch, pipeline
from .ownership import OwnedPath, read_ownership
from .version import pipeline_version

ORG = "nemarDatasets"
BASE = "main"
DOCS_URL = "https://docs.nemar.org/data/ieeg-geometry/"
BODY_LIMIT = 60_000  # GitHub refuses a pull request body over 65,536 characters
_TIMEOUT_S = 900


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


def _run(cmd: list[str], cwd: Path | None, what: str) -> str:
    env = os.environ | {"GIT_TERMINAL_PROMPT": "0"}
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


def _git(clone: Path, *args: str, what: str | None = None) -> str:
    cmd = ["git", "-C", str(clone), "--literal-pathspecs", *args]
    return _run(cmd, None, what or f"git {args[0]}")


def _paths(clone: Path, *args: str) -> set[str]:
    return {p for p in _git(clone, *args, "-z").split("\0") if p}


def _status_entries(clone: Path) -> list[tuple[str, str]]:
    """(two-letter status, path) for every difference between the work tree and the index."""
    out = _git(clone, "status", "--porcelain=v1", "-z", "--untracked-files=all")
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


def _group_key(entry: OwnedPath | None) -> tuple[str, str, str]:
    v = entry.verification if entry else None
    return (
        entry.method if entry else "ownership record",
        v.grade if v else "not graded",
        v.reference if v else "-",
    )


def _section(
    label: str,
    paths: list[str],
    owned: dict[str, OwnedPath],
    detail: bool | None,
    budget: int,
) -> list[str] | None:
    """One group per (method, grade, reference). `detail` True: a line with numbers per file;
    False: paths only; None: counts only (the ownership record lists the files). None when
    the text does not fit `budget` and a shorter form exists."""
    groups: dict[tuple[str, str, str], list[str]] = {}
    for path in paths:
        groups.setdefault(_group_key(owned.get(path)), []).append(path)
    lines = [f"## {label} ({len(paths)})", ""]
    for (method, grade, reference), members in sorted(groups.items()):
        lines.append(f"### {method}, evidence {grade}, reference {reference} ({len(members)})")
        lines.append("")
        if label == "Removed":
            lines += ["No longer produced by the pipeline.", ""]
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


def build_body(
    report: dict,
    owned: dict[str, OwnedPath],
    *,
    n_surface_sets: int,
    limit: int = BODY_LIMIT,
) -> str:
    """The pull request description: every added, changed or removed file with its method and
    evidence grade, shortened in steps only when GitHub's size limit would refuse it."""
    changes = report["changes"]
    added, changed, removed = changes["add"], changes["change"], changes["remove"]
    lines = [
        "This pull request adds electrode positions and coordinate system files that NEMAR "
        "computed from this dataset's own files, with the verification each one passed.",
        "The authors' files are not changed.",
        "",
        f"- Dataset: `{report['dataset']}`, version `{report['dataset_version']}`, "
        f"source commit `{report['source_commit']}`",
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
    for label, paths in (("Added", added), ("Changed", changed), ("Removed", removed)):
        if not paths:
            continue
        used = len("\n".join(lines))
        for detail in (True, False, None):
            section = _section(label, paths, owned, detail, limit - used)
            if section is not None:
                lines += section
                break
    return "\n".join(lines).rstrip() + "\n"


# ---- the flow ---------------------------------------------------------------------------------


def open_pr(
    dataset_id: str,
    workdir: Path,
    *,
    version: str | None = None,
    dry_run: bool = False,
    surfaces_out: Path | None = None,
    urls: dict[str, str] | None = None,
    out=None,
) -> PrResult:
    out = out or sys.stdout
    pipeline.check_dataset_id(dataset_id)
    pv = pipeline_version()
    branch, ttl = branch_name(pv), title(pv)
    workdir = Path(workdir)
    if (workdir / dataset_id).exists():
        raise PrRefusal(
            f"{workdir / dataset_id} exists; the pull request starts from a fresh clone"
        )
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        _run(["git", "var", "GIT_AUTHOR_IDENT"], workdir, "git identity")
    except PrRefusal as exc:
        raise PrRefusal(
            "no git identity: set user.name and user.email (the commit is yours)"
        ) from exc
    urls = urls or {}
    got = fetch.fetch_files(
        dataset_id,
        workdir,
        version=version,
        repo_url=urls.get("repo_url") or fetch.REPO_URL,
        data_url=urls.get("data_url") or fetch.DATA_URL,
        api_url=urls.get("api_url") or fetch.API_URL,
    )
    clone = got.clone
    if _git(clone, "symbolic-ref", "--short", "HEAD").strip() != BASE:
        raise PrRefusal(f"the clone is not on {BASE}; the pull request is made against {BASE}")
    if _git(clone, "ls-remote", "--heads", "origin", f"refs/heads/{branch}").strip():
        raise PrRefusal(f"branch {branch} already exists on the remote; nothing was pushed")
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
    if not expected:
        raise PrRefusal("the apply produced no changes; there is nothing to propose")
    bad = _unexpected(_status_entries(clone), expected, never_checked_out)
    if bad:
        shown = "; ".join(bad[:10]) + (f"; and {len(bad) - 10} more" if len(bad) > 10 else "")
        raise PrRefusal(f"the work tree differs from main outside the reported changes: {shown}")

    for rel in sorted(set(changes["add"]) | set(changes["change"])):
        _git(clone, "add", "--", rel)
    for rel in sorted(changes["remove"]):
        _git(clone, "rm", "-q", "--cached", "--ignore-unmatch", "--", rel)
    staged = _paths(clone, "diff", "--cached", "--name-only")
    if not staged or not staged <= expected:
        odd = ", ".join(sorted(staged - expected)[:10]) or "none staged"
        raise PrRefusal(f"the staged paths do not match the reported changes ({odd})")
    _git(clone, "checkout", "-q", "-b", branch)
    _git(clone, "commit", "-q", "-m", ttl, what="git commit")
    commit = _git(clone, "rev-parse", "HEAD").strip()

    ownership = read_ownership(clone)
    owned = {e.path: e for e in ownership.entries} if ownership else {}
    body = build_body(report, owned, n_surface_sets=len(report.get("surface_entries", [])))
    if dry_run:
        out.write(f"branch {branch}, commit {commit}\ntitle: {ttl}\n\n{body}")
        return PrResult(branch, commit, ttl, body, None)

    _git(clone, "push", "origin", f"refs/heads/{branch}:refs/heads/{branch}", what="git push")
    with tempfile.TemporaryDirectory(dir=workdir, prefix=".pr-body-") as tmp:
        body_file = Path(tmp) / "body.md"
        body_file.write_text(body, encoding="utf-8")
        printed = _run(
            [
                "gh",
                "pr",
                "create",
                "--repo",
                f"{ORG}/{dataset_id}",
                "--base",
                BASE,
                "--head",
                branch,
                "--title",
                ttl,
                "--body-file",
                str(body_file),
            ],  # fmt: skip
            clone,
            "gh pr create",
        )
    lines = [ln.strip() for ln in printed.splitlines() if ln.strip()]
    url = lines[-1] if lines and lines[-1].startswith("http") else None
    if url is None:
        raise PrRefusal(
            f"branch {branch} was pushed but gh printed no pull request URL: {printed.strip()}"
        )
    out.write(url + "\n")
    return PrResult(branch, commit, ttl, body, url)
