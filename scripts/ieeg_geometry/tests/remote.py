"""A local stand-in for the data plane: a git repository, an annex-style data tree and an API file.

`build_remote` turns a directory of dataset files into what `fetch` reads: a git repository
whose large files (surfaces, spheres, SPM fields) are git-annex symbolic links with MD5E keys,
the annexed bytes under `data/<id>/<version>/<path>`, and `api/<id>.json` holding the release
version. Everything is addressed with `file://` URLs, so the fetch code runs unchanged.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

ANNEXED = re.compile(
    r"(^|/)(?:[lr]h\.pial|[lr]h\.sphere\.reg|[^/]*\.gii|y_[^/]*\.nii(?:\.gz)?)$", re.I
)
VERSION = "v1.0.0"
DATASET_ID = "on000001"


@dataclass(frozen=True)
class Remote:
    repo_url: str
    data_url: str
    api_url: str
    data_root: Path
    commit: str
    annexed: tuple[str, ...]

    def urls(self) -> dict[str, str]:
        return {"repo_url": self.repo_url, "data_url": self.data_url, "api_url": self.api_url}


def _git(cwd: Path, *args: str) -> str:
    env = os.environ | {
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@example.org",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@example.org",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_SYSTEM": os.devnull,
    }
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True, env=env
    ).stdout


def build_remote(
    source: Path,
    root: Path,
    *,
    dataset_id: str = DATASET_ID,
    extra_annexed: tuple[str, ...] = (),
    missing_data: tuple[str, ...] = (),
    corrupt_data: tuple[str, ...] = (),
) -> Remote:
    """`source` is copied to a repository under `root`; annexed files keep only a link in git."""
    repo = root / "repos" / dataset_id
    data = root / "data" / dataset_id / VERSION
    api = root / "api"
    repo.mkdir(parents=True)
    api.mkdir(parents=True)
    annexed: list[str] = []
    for path in sorted(p for p in source.rglob("*") if p.is_file()):
        rel = path.relative_to(source).as_posix()
        target = repo / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if ANNEXED.search(rel) or rel in extra_annexed:
            content = path.read_bytes()
            key = f"MD5E-s{len(content)}--{hashlib.md5(content).hexdigest()}{Path(rel).suffix}"  # noqa: S324
            depth = rel.count("/")
            link = "../" * depth + f".git/annex/objects/ab/cd/{key}/{key}"
            os.symlink(link, target)
            annexed.append(rel)
            if rel in missing_data:
                continue
            served = data / rel
            served.parent.mkdir(parents=True, exist_ok=True)
            served.write_bytes(content[:-1] + b"X" if rel in corrupt_data else content)
        else:
            shutil.copyfile(path, target)
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "uploadpack.allowFilter", "true")
    _git(repo, "config", "uploadpack.allowAnySHA1InWant", "true")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "dataset")
    commit = _git(repo, "rev-parse", "HEAD").strip()
    (api / f"{dataset_id}.json").write_text(
        json.dumps({"dataset": {"dataset_id": dataset_id, "latest_version": VERSION}})
    )
    return Remote(
        repo_url=f"file://{root / 'repos'}/{{id}}",
        data_url=f"file://{root / 'data'}/{{id}}/{{version}}/{{path}}",
        api_url=f"file://{api}/{{id}}.json",
        data_root=root / "data",
        commit=commit,
        annexed=tuple(annexed),
    )
