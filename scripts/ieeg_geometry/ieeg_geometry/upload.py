"""Put a dataset's subject surfaces on the data plane at `s3://<bucket>/<id>/zarr/geometry/`.

The owner runs this with their own AWS profile; it uses the `aws` command line tool, the same
way `scripts/zarr/generate_zarr.py` talks to S3 (no boto3 dependency). Order matters:

1. list the keys already under the prefix;
2. upload the meshes the new index references (a mesh key is its content hash, so one that is
   already there is skipped);
3. upload `index.json`, so a reader never sees an index that names a missing mesh;
4. remove keys under the prefix that the new index no longer references.

Every key written or removed is checked to sit under `<id>/zarr/geometry/` before the first
call, and nothing else in the bucket is listed, written or removed. Protected ids are refused.
`plan` is pure; `upload` runs it.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from . import pipeline

BUCKET = "nemar"
INDEX_SCHEMA = "nemar-ieeg-geometry-index"
_TIMEOUT_S = 1800


class UploadRefusal(Exception):
    """The upload cannot proceed; the message says why. Nothing was written."""


def prefix_for(dataset_id: str) -> str:
    return f"{dataset_id}/zarr/geometry/"


@dataclass
class Plan:
    prefix: str
    meshes: dict[str, Path] = field(default_factory=dict)  # key -> local file, to upload
    skipped: list[str] = field(default_factory=list)  # mesh keys already on the bucket
    index_key: str = ""
    index_file: Path | None = None
    removals: list[str] = field(default_factory=list)

    def all_keys(self) -> list[str]:
        return [*self.meshes, *self.skipped, self.index_key, *self.removals]


def _referenced_meshes(index: dict) -> list[str]:
    rels: set[str] = set()
    for entry in index.get("entries", []):
        for mesh in entry.get("meshes", {}).values():
            rels.add(mesh["path"])
    return sorted(rels)


def _safe_relative(rel: str) -> str:
    p = PurePosixPath(rel)
    if p.is_absolute() or ".." in p.parts or not p.parts or "" in rel.split("/"):
        raise UploadRefusal(f"the index names an unsafe mesh path {rel!r}")
    return p.as_posix()


def plan(dataset_id: str, surfaces: Path, existing: set[str]) -> Plan:
    """What an upload would do, from the local `geometry/` directory and the keys already there."""
    pipeline.check_dataset_id(dataset_id)
    geometry = Path(surfaces) / "geometry"
    index_file = geometry / "index.json"
    if not index_file.is_file():
        raise UploadRefusal(f"{index_file} does not exist; run the pipeline with --surfaces-out")
    try:
        index = json.loads(index_file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise UploadRefusal(f"{index_file} is not readable JSON: {exc}") from exc
    if not isinstance(index, dict) or index.get("schema") != INDEX_SCHEMA:
        raise UploadRefusal(f"{index_file} is not a {INDEX_SCHEMA} document")
    prefix = prefix_for(dataset_id)
    out = Plan(prefix, index_key=prefix + "index.json", index_file=index_file)
    referenced: set[str] = {out.index_key}
    for rel in _referenced_meshes(index):
        rel = _safe_relative(rel)
        local = geometry / rel
        if not local.is_file():
            raise UploadRefusal(f"the index names {rel}, which is not in {geometry}")
        key = prefix + rel
        referenced.add(key)
        if key in existing:
            out.skipped.append(key)  # content-addressed: the same key is the same bytes
        else:
            out.meshes[key] = local
    out.removals = sorted(k for k in existing if k not in referenced)
    outside = [k for k in out.all_keys() if not k.startswith(prefix)]
    if outside:
        raise UploadRefusal(f"keys outside {prefix} would be touched: {outside[:5]}")
    return out


class Aws:
    """The three calls the upload makes, through the `aws` command line tool."""

    def __init__(self, bucket: str, profile: str | None = None) -> None:
        self.bucket = bucket
        self.base = ["aws", *(["--profile", profile] if profile else [])]

    def _run(self, args: list[str], what: str) -> str:
        try:
            done = subprocess.run(
                [*self.base, *args],
                capture_output=True,
                text=True,
                check=True,
                timeout=_TIMEOUT_S,
                env=os.environ | {"AWS_MAX_ATTEMPTS": os.environ.get("AWS_MAX_ATTEMPTS", "10")},
            )
        except FileNotFoundError as exc:
            raise UploadRefusal("the aws command line tool is not installed") from exc
        except subprocess.CalledProcessError as exc:
            raise UploadRefusal(f"{what} failed: {(exc.stderr or '').strip()[:400]}") from exc
        except subprocess.TimeoutExpired as exc:
            raise UploadRefusal(f"{what} timed out") from exc
        return done.stdout

    def keys(self, prefix: str) -> set[str]:
        out = self._run(
            [
                "s3api",
                "list-objects-v2",
                "--bucket",
                self.bucket,
                "--prefix",
                prefix,
                "--query",
                "Contents[].Key",
                "--output",
                "json",
            ],  # fmt: skip
            f"listing s3://{self.bucket}/{prefix}",
        )
        keys = json.loads(out) if out.strip() else None
        return set(keys or [])

    def put(self, local: Path, key: str) -> None:
        self._run(
            ["s3", "cp", str(local), f"s3://{self.bucket}/{key}", "--only-show-errors"],
            f"uploading {key}",
        )

    def remove(self, key: str) -> None:
        self._run(
            ["s3", "rm", f"s3://{self.bucket}/{key}", "--only-show-errors"], f"removing {key}"
        )


def upload(
    dataset_id: str,
    surfaces: Path,
    *,
    bucket: str = BUCKET,
    profile: str | None = None,
    dry_run: bool = False,
    out=None,
) -> Plan:
    out = out or sys.stdout
    pipeline.check_dataset_id(dataset_id)
    aws = Aws(bucket, profile)
    prefix = prefix_for(dataset_id)
    todo = plan(dataset_id, surfaces, aws.keys(prefix))
    verb = "would" if dry_run else "will"
    out.write(
        f"s3://{bucket}/{prefix}: {verb} upload {len(todo.meshes)} mesh(es) "
        f"({len(todo.skipped)} already there), then the index, then remove "
        f"{len(todo.removals)} unreferenced key(s)\n"
    )
    for key in todo.removals:
        out.write(f"  remove {key}\n")
    if dry_run:
        return todo
    for key, local in sorted(todo.meshes.items()):
        aws.put(local, key)
    assert todo.index_file is not None
    aws.put(todo.index_file, todo.index_key)
    for key in todo.removals:
        aws.remove(key)
    out.write("done\n")
    return todo
