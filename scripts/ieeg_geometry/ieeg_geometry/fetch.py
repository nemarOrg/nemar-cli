"""Fetch exactly the files a dataset's geometry needs into a git work tree.

The tree is a `git clone --no-checkout --filter=blob:none` of the dataset repository; only the
paths the tracks read are checked out. Annexed files stay git-annex symbolic links, and their
content is downloaded from the data plane into the clone's own annex object path, so the links
resolve, a blob id of an input is the blob id git stores, and `git status` shows no type change.
Recordings are never fetched. One file that cannot be downloaded is reported in
`FetchResult.failed`; a tree or version failure raises `FetchError`.
"""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

REPO_URL = "https://github.com/nemarDatasets/{id}"
DATA_URL = "https://data.nemar.org/{id}/{version}/{path}"
API_URL = "https://api.nemar.org/datasets/{id}"
MAX_BYTES = 2 * 1024**3  # the card's stop condition: one dataset's fetch stays under 2 GB
_TIMEOUT_S = 120
_ATTEMPTS = 3
_BACKOFF_S = 1.0  # doubled after each failed attempt
_API_MAX_BYTES = 1024**2
_GIT_TIMEOUT_S = 900

# paths whose absence changes what a track decides: the run fails when one cannot be fetched
DATASET_LEVEL = re.compile(
    r"^(README(\.\w+)?|dataset_description\.json|\.nemar/ieeg-geometry\.json)$"
)
_SUBJECT_FILE = re.compile(r"(_electrodes\.tsv|_coordsystem\.json|_channels\.tsv)$")
_ANY_COORDSYSTEM = re.compile(r"_coordsystem\.json$")
_SURFACE_FILE = re.compile(
    r"(^|/)(?:[lr]h\.pial(?:\.T1)?|[lr]h\.sphere\.reg|y_[^/]*\.nii(?:\.gz)?|[^/]*\.gii|[^/]*\.mat)$",
    re.I,
)
_KEY = re.compile(r"^([A-Z0-9]+)-s(\d+)--([0-9a-f]+)")


class FetchError(Exception):
    """The run cannot proceed (tree, version or a dataset-level file); the message says why."""


@dataclass(frozen=True)
class TreeEntry:
    path: str
    mode: str  # "100644" regular file, "120000" symbolic link (an annexed file)


@dataclass
class FetchResult:
    clone: Path
    commit: str
    version: str
    fetched: list[str] = field(default_factory=list)  # annexed files downloaded or already there
    failed: dict[str, str] = field(default_factory=dict)  # path -> reason
    bytes_downloaded: int = 0
    electrodes_in_tree: list[str] = field(default_factory=list)
    excluded: dict[str, str] = field(default_factory=dict)  # electrodes path -> reason


def _entity(path: str, key: str) -> str | None:
    """The `<key>-<value>` entity anywhere in a path (a directory or a file name)."""
    m = re.search(rf"(?:^|[/_]){key}-([A-Za-z0-9]+)", path)
    return m.group(1) if m else None


# ---- selection (pure) -------------------------------------------------------------------------


def _surface_wanted(path: str) -> bool:
    parts = path.split("/")
    if not any(p.startswith("sub-") for p in parts[:-1]) or not _SURFACE_FILE.search(path):
        return False
    name = parts[-1].lower()
    if name.startswith(("lh.", "rh.")):
        return True
    if name.startswith("y_"):
        return True
    if name.endswith(".gii"):
        return "pial" in name
    return name.endswith(".mat") and any(t in name for t in ("cortex", "pial", "surf"))


def select_paths(entries: list[TreeEntry]) -> list[str]:
    """The paths the tracks read: electrodes, coordsystem and channels files, the README,
    `dataset_description.json`, the ownership file, and subject surfaces, `sphere.reg` and SPM
    `y_` fields. Everything else, recordings included, is left alone."""
    wanted = []
    for e in entries:
        p = e.path
        if (
            DATASET_LEVEL.match(p)
            or _SUBJECT_FILE.search(p)
            or _ANY_COORDSYSTEM.search(p)
            or _surface_wanted(p)
        ):
            wanted.append(p)
    return sorted(wanted)


# ---- network ----------------------------------------------------------------------------------


def _get(url: str, max_bytes: int) -> bytes:
    """The body at `url`, never more than `max_bytes` (an overshoot is an error, not a buffer).

    Transient failures are retried with exponential backoff; a missing file is not.
    """
    last: Exception | None = None
    for attempt in range(_ATTEMPTS):
        if attempt:
            time.sleep(_BACKOFF_S * 2 ** (attempt - 1))
        try:
            with urllib.request.urlopen(url, timeout=_TIMEOUT_S) as resp:  # noqa: S310
                data = resp.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise OSError(f"the body is larger than the {max_bytes} bytes expected")
            return data
        except urllib.error.HTTPError as exc:
            if exc.code in (400, 401, 403, 404, 410):
                raise
            last = exc
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, FileNotFoundError):
                raise
            last = exc
        except (http.client.HTTPException, TimeoutError, ConnectionError) as exc:
            last = exc  # includes IncompleteRead (a truncated body)
        except OSError as exc:
            if "larger than" in str(exc):
                raise
            last = exc
        except ValueError as exc:  # a malformed URL never gets better
            raise OSError(f"bad URL {url!r}: {exc}") from exc
    assert last is not None
    raise last


def fetch_version(dataset_id: str, api_url: str = API_URL) -> str:
    """The latest released version of a dataset, from the NEMAR API."""
    url = api_url.format(id=dataset_id)
    try:
        doc = json.loads(_get(url, _API_MAX_BYTES))
        version = doc["dataset"]["latest_version"]
    except (OSError, http.client.HTTPException, ValueError, KeyError, TypeError) as exc:
        raise FetchError(f"cannot read the version of {dataset_id} from {url}: {exc}") from exc
    if not isinstance(version, str) or not version:
        raise FetchError(f"{dataset_id} has no released version; pass --version")
    return version


# A dataset repository's attributes may name the git-annex filter, and the machine's global git
# configuration may set it (even to a command that is not installed, or `required`). Every git
# call here and in `pr` runs with the filter turned into `cat`, so nothing is annexed or
# initialized and the bytes git stores are the bytes on disk. Annexed files are symbolic links,
# which no filter touches.
NEUTRAL_GIT_CONFIG = (
    "filter.annex.process=",
    "filter.annex.required=false",  # git-annex sets it true; a failing neutral clean must not abort
    "filter.annex.clean=cat",
    "filter.annex.smudge=cat",
    "annex.largefiles=nothing",
    "core.attributesFile=/dev/null",
)


def _git(clone: Path | None, *args: str, stdin: bytes | None = None, attempts: int = 1) -> str:
    config = [x for c in NEUTRAL_GIT_CONFIG for x in ("-c", c)]
    cmd = ["git", *config, *(["-C", str(clone)] if clone else []), "--literal-pathspecs", *args]
    env = os.environ | {"GIT_TERMINAL_PROMPT": "0", "GIT_ATTR_NOSYSTEM": "1"}
    for attempt in range(1, attempts + 1):
        try:
            done = subprocess.run(
                cmd,
                input=stdin,
                capture_output=True,
                check=True,
                timeout=_GIT_TIMEOUT_S,
                env=env,
            )
            break
        except (OSError, subprocess.SubprocessError) as exc:
            if attempt < attempts:
                continue
            detail = getattr(exc, "stderr", b"") or b""
            raise FetchError(
                f"git {args[0]} failed: {exc.__class__.__name__} "
                f"{detail.decode(errors='replace')[:300]}"
            ) from exc
    return done.stdout.decode("utf-8", errors="replace")


def clone_tree(dataset_id: str, workdir: Path, repo_url: str = REPO_URL) -> Path:
    """`<workdir>/<id>`: a blobless, not checked out clone (reused when it already exists)."""
    clone = Path(workdir) / dataset_id
    if (clone / ".git").exists():
        return clone
    if clone.exists() and any(clone.iterdir()):
        raise FetchError(f"{clone} exists and is not a git checkout; pass an empty --workdir")
    clone.parent.mkdir(parents=True, exist_ok=True)
    _git(
        None,
        "clone",
        "--no-checkout",
        "--filter=blob:none",
        repo_url.format(id=dataset_id),
        str(clone),
        attempts=_ATTEMPTS,
    )
    return clone


def list_tree(clone: Path) -> list[TreeEntry]:
    out = _git(clone, "ls-tree", "-r", "-z", "--full-tree", "HEAD")
    entries = []
    for record in out.split("\0"):
        if not record:
            continue
        meta, _, path = record.partition("\t")
        mode, _kind, _sha = meta.split(" ")
        entries.append(TreeEntry(path, mode))
    return sorted(entries, key=lambda e: e.path)


def head_commit(clone: Path) -> str:
    return _git(clone, "rev-parse", "HEAD").strip()


def _annex_object(clone: Path, rel: str) -> tuple[Path, int, str, str] | None:
    """(object path, size, hash algorithm or "", hex digest or "") of an annexed file's link.

    None for a regular file. A link that is not a git-annex link, or whose key carries no
    size, raises `OSError` so the caller reports the file as not fetched (never silently).
    """
    link = clone / rel
    if not link.is_symlink():
        return None
    target = os.readlink(link)
    key = Path(target).name
    m = _KEY.match(key)
    if os.path.isabs(target) or ".git/annex/objects/" not in target or m is None:
        raise OSError(f"symbolic link {target!r} is not a relative git-annex key with a size")
    objects = (clone / ".git" / "annex" / "objects").resolve()
    # the link resolves from its physical directory: a symlinked parent counts as where it leads
    obj = Path(os.path.normpath(link.parent.resolve() / target))
    if not link.parent.resolve().is_relative_to(
        clone.resolve()
    ) or not obj.resolve().is_relative_to(objects):
        raise OSError(f"symbolic link {target!r} points outside the clone's annex objects")
    backend = m.group(1).removesuffix("E")
    algo = backend.lower() if backend.lower() in hashlib.algorithms_available else ""
    return obj, int(m.group(2)), algo, m.group(3) if algo else ""


def _download(url: str, dest: Path, size: int, algo: str, digest: str) -> None:
    data = _get(url, size)
    if len(data) != size or (algo and hashlib.new(algo, data).hexdigest() != digest):
        raise OSError(f"downloaded {len(data)} bytes that do not match the annex key")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    tmp.write_bytes(data)
    os.replace(tmp, dest)
    dest.chmod(0o444)


def fetch_files(
    dataset_id: str,
    workdir: Path,
    *,
    version: str | None = None,
    repo_url: str = REPO_URL,
    data_url: str = DATA_URL,
    api_url: str = API_URL,
    max_bytes: int = MAX_BYTES,
) -> FetchResult:
    """Clone, check out the selected paths and download their annexed content."""
    version = version or fetch_version(dataset_id, api_url)
    clone = clone_tree(dataset_id, workdir, repo_url)
    entries = list_tree(clone)
    wanted = select_paths(entries)
    todo = [p for p in wanted if not os.path.lexists(clone / p)]
    if todo:
        _git(
            clone,
            "checkout",
            "HEAD",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
            stdin="\0".join(todo).encode() + b"\0",
            attempts=_ATTEMPTS,
        )
    result = FetchResult(
        clone,
        head_commit(clone),
        version,
        electrodes_in_tree=sorted(e.path for e in entries if e.path.endswith("_electrodes.tsv")),
    )
    annexed: dict[str, tuple[Path, int, str, str]] = {}
    for path in wanted:
        try:
            found = _annex_object(clone, path)
        except OSError as exc:
            result.failed[path] = str(exc)
            continue
        if found is not None:
            annexed[path] = found
    total = sum(o[1] for o in annexed.values() if not o[0].exists())
    if total > max_bytes:
        raise FetchError(
            f"{dataset_id}: the files to fetch total {total / 1024**3:.2f} GB, over the "
            f"{max_bytes / 1024**3:.0f} GB limit"
        )
    for path, (obj, size, algo, digest) in sorted(annexed.items()):
        if obj.exists():
            result.fetched.append(path)
            continue
        try:
            url = data_url.format(
                id=dataset_id,
                version=urllib.parse.quote(version, safe=""),
                path=urllib.parse.quote(path, safe="/"),
            )
            _download(url, obj, size, algo, digest)
        except (OSError, http.client.HTTPException) as exc:
            result.failed[path] = f"{exc.__class__.__name__}: {exc}"
            continue
        result.fetched.append(path)
        result.bytes_downloaded += size
    _apply_failures(result)
    return result


def _apply_failures(result: FetchResult) -> None:
    """A file that could not be fetched must not be half-seen by the tracks.

    A dataset-level file (README, description, ownership record) fails the run. A failed
    electrodes, coordsystem or channels file removes every electrodes file of that subject
    from the work tree, so the tracks never decide on a file whose sidecar is missing; those
    files are reported as skipped with the reason. A failed surface or field is left as the
    dangling link it is: the tracks report no surface.
    """
    clone = result.clone
    for path, reason in result.failed.items():
        if DATASET_LEVEL.match(path):
            raise FetchError(f"cannot fetch {path}: {reason}")
    subjects: dict[str, str] = {}
    for path, reason in result.failed.items():
        sub = _entity(path, "sub")
        if _SUBJECT_FILE.search(path) and sub:
            subjects[sub] = f"{path} was not fetched ({reason})"
    for path in result.electrodes_in_tree:
        sub = _entity(path, "sub")
        if sub in subjects:
            result.excluded[path] = subjects[sub]
            (clone / path).unlink(missing_ok=True)
    # a coordsystem that failed above the subject level (inherited) affects every subject
    for path, reason in result.failed.items():
        if _ANY_COORDSYSTEM.search(path) and not _entity(path, "sub"):
            for e in result.electrodes_in_tree:
                result.excluded.setdefault(e, f"{path} was not fetched ({reason})")
                (clone / e).unlink(missing_ok=True)
