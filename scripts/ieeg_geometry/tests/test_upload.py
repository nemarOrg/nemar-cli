"""`upload-surfaces`: the plan (order, removals, prefix confinement) against a local S3 stand-in."""

import json
import shutil
from pathlib import Path

import pytest

from ieeg_geometry import upload
from ieeg_geometry.__main__ import main

from . import standins
from .remote import DATASET_ID, build_remote
from .test_pipeline import _run, source  # noqa: F401 - `source` is a fixture

BUCKET = "nemar"
PREFIX = f"{DATASET_ID}/zarr/geometry/"


@pytest.fixture(scope="module")
def surfaces_template(source, tmp_path_factory):  # noqa: F811
    """A real `geometry/` (index plus meshes) written by the pipeline's apply."""
    root = tmp_path_factory.mktemp("surf")
    remote = build_remote(source, root / "remote")
    out = root / "surfaces"
    _run(remote, root / "w", apply=True, surfaces_out=out)
    return out


@pytest.fixture
def surfaces(surfaces_template, tmp_path):
    out = tmp_path / "surfaces"
    shutil.copytree(surfaces_template, out)
    return out


@pytest.fixture
def s3(tmp_path, monkeypatch):
    log, root = standins.activate(monkeypatch, tmp_path / "standins")
    return log, root / BUCKET


def _calls(log: Path) -> list[dict]:
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


def _put(bucket: Path, key: str, data: bytes = b"x") -> None:
    target = bucket / key
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


def _keys(bucket: Path) -> list[str]:
    return sorted(p.relative_to(bucket).as_posix() for p in bucket.rglob("*") if p.is_file())


def _referenced(surfaces: Path) -> list[str]:
    index = json.loads((surfaces / "geometry" / "index.json").read_text())
    return sorted({PREFIX + m["path"] for e in index["entries"] for m in e["meshes"].values()})


def _writes(calls: list[dict]) -> list[tuple[str, str]]:
    """(verb, key) for every upload or removal, in order."""
    out = []
    for c in calls:
        a = c["args"]
        if a[:2] == ["s3", "cp"]:
            out.append(("put", a[3].removeprefix(f"s3://{BUCKET}/")))
        elif a[:2] == ["s3", "rm"]:
            out.append(("rm", a[2].removeprefix(f"s3://{BUCKET}/")))
    return out


def _upload(surfaces, *extra):
    return main(["upload-surfaces", DATASET_ID, "--surfaces", str(surfaces), *extra])


def test_the_fixture_surfaces_reference_meshes(surfaces):
    assert len(_referenced(surfaces)) >= 2


def test_meshes_are_uploaded_before_the_index_and_removals_come_last(surfaces, s3):
    log, bucket = s3
    _put(bucket, PREFIX + "meshes/old.mesh.bin")
    _put(bucket, PREFIX + "stale.json")
    assert _upload(surfaces) == 0
    writes = _writes(_calls(log))
    puts = [k for v, k in writes if v == "put"]
    refs = _referenced(surfaces)
    assert sorted(puts[:-1]) == refs and puts[-1] == PREFIX + "index.json"
    verbs = [v for v, _ in writes]
    assert verbs == ["put"] * len(puts) + ["rm", "rm"]  # the index precedes every removal
    assert sorted(k for v, k in writes if v == "rm") == [
        PREFIX + "meshes/old.mesh.bin",
        PREFIX + "stale.json",
    ]
    assert _keys(bucket) == sorted([*refs, PREFIX + "index.json"])
    assert (bucket / PREFIX / "index.json").read_bytes() == (
        surfaces / "geometry" / "index.json"
    ).read_bytes()


def test_nothing_outside_the_prefix_is_listed_written_or_removed(surfaces, s3):
    log, bucket = s3
    others = {
        f"{DATASET_ID}/zarr/sub-01/a.zarr/zarr.json": b"store",
        f"{DATASET_ID}/zarr/index.json": b"zarr index",
        f"{DATASET_ID}/zarr/geometry-extra/x": b"lookalike",
        f"{DATASET_ID}/zarr/geometry.txt": b"lookalike",
        f"{DATASET_ID}/objects/abc": b"annex",
        "on999999/zarr/geometry/index.json": b"another dataset",
    }
    for key, data in others.items():
        _put(bucket, key, data)
    _put(bucket, PREFIX + "meshes/old.mesh.bin")
    assert _upload(surfaces) == 0
    for key, data in others.items():
        assert (bucket / key).read_bytes() == data
    for c in _calls(log):
        a = c["args"]
        touched = [x for x in a if x.startswith(f"s3://{BUCKET}/")] + (
            [a[a.index("--prefix") + 1]] if "--prefix" in a else []
        )
        assert touched, c
        for t in touched:
            assert t.removeprefix(f"s3://{BUCKET}/").startswith(PREFIX), c


def test_a_mesh_already_on_the_bucket_is_not_uploaded_again(surfaces, s3):
    log, bucket = s3
    first = _referenced(surfaces)[0]
    _put(bucket, first, b"same content hash, same bytes")
    assert _upload(surfaces) == 0
    puts = [k for v, k in _writes(_calls(log)) if v == "put"]
    assert first not in puts and PREFIX + "index.json" in puts
    assert (bucket / first).read_bytes() == b"same content hash, same bytes"


def test_a_second_upload_changes_only_the_index(surfaces, s3):
    log, bucket = s3
    assert _upload(surfaces) == 0
    log.unlink()
    assert _upload(surfaces) == 0
    assert _writes(_calls(log)) == [("put", PREFIX + "index.json")]


def test_a_dry_run_lists_but_writes_nothing(surfaces, s3, capsys):
    log, bucket = s3
    _put(bucket, PREFIX + "stale.json")
    before = _keys(bucket)
    assert _upload(surfaces, "--dry-run") == 0
    out = capsys.readouterr().out
    assert "would upload" in out and f"remove {PREFIX}stale.json" in out
    assert _keys(bucket) == before and _writes(_calls(log)) == []
    assert [c["args"][1] for c in _calls(log)] == ["list-objects-v2"]


def test_the_profile_is_passed_to_every_aws_call(surfaces, s3):
    log, _bucket = s3
    assert _upload(surfaces, "--profile", "owner") == 0
    calls = _calls(log)
    assert calls and {c["profile"] for c in calls} == {"owner"}


@pytest.mark.parametrize("dataset_id", ["nm000103", "nm000104", "nm000106", "nm099998", "nope"])
def test_protected_and_malformed_ids_are_refused_without_any_aws_call(
    dataset_id, surfaces, s3, capsys
):
    log, bucket = s3
    assert main(["upload-surfaces", dataset_id, "--surfaces", str(surfaces)]) == 1
    assert "refused" in capsys.readouterr().err
    assert not _calls(log) and _keys(bucket) == []


def test_a_missing_mesh_refuses_before_any_write(surfaces, s3, capsys):
    log, bucket = s3
    victim = next((surfaces / "geometry" / "meshes").iterdir())
    victim.unlink()
    assert _upload(surfaces) == 1
    assert "not in" in capsys.readouterr().err
    assert _writes(_calls(log)) == [] and _keys(bucket) == []


@pytest.mark.parametrize("bad", ["../../other/x", "/abs/x", "meshes//x", ""])
def test_an_unsafe_mesh_path_in_the_index_is_refused(bad, surfaces, s3, capsys):
    log, bucket = s3
    path = surfaces / "geometry" / "index.json"
    index = json.loads(path.read_text())
    first = next(iter(index["entries"][0]["meshes"].values()))
    first["path"] = bad
    path.write_text(json.dumps(index))
    assert _upload(surfaces) == 1
    assert "refused" in capsys.readouterr().err
    assert _writes(_calls(log)) == [] and _keys(bucket) == []


def test_a_directory_without_an_index_or_with_another_document_is_refused(tmp_path, s3, capsys):
    log, _bucket = s3
    assert _upload(tmp_path) == 1
    (tmp_path / "geometry").mkdir()
    (tmp_path / "geometry" / "index.json").write_text('{"schema": "something-else"}')
    assert _upload(tmp_path) == 1
    err = capsys.readouterr().err
    assert "does not exist" in err and "is not a nemar-ieeg-geometry-index document" in err
    assert _writes(_calls(log)) == []


@pytest.mark.parametrize("failing", ["meshes/", "index.json"])
def test_an_upload_failure_stops_before_the_index_or_any_removal(
    failing, surfaces, s3, monkeypatch, capsys
):
    log, bucket = s3
    _put(bucket, PREFIX + "index.json", b"old index")
    _put(bucket, PREFIX + "meshes/old.mesh.bin")
    monkeypatch.setenv("STANDIN_FAIL_PUT", PREFIX + failing)
    assert _upload(surfaces) == 1
    assert "failed" in capsys.readouterr().err
    assert all(v == "put" for v, _ in _writes(_calls(log)))  # nothing was removed
    assert (bucket / PREFIX / "meshes" / "old.mesh.bin").exists()
    if failing == "meshes/":
        assert (bucket / PREFIX / "index.json").read_bytes() == b"old index"


def test_plan_is_pure_and_confined(surfaces):
    existing = {PREFIX + "index.json", PREFIX + "gone.bin"}
    p = upload.plan(DATASET_ID, surfaces, existing)
    assert p.removals == [PREFIX + "gone.bin"]
    assert all(k.startswith(PREFIX) for k in p.all_keys())
    assert p.index_key == PREFIX + "index.json"


def _edit_index(surfaces, edit):
    path = surfaces / "geometry" / "index.json"
    index = json.loads(path.read_text())
    edit(index)
    path.write_text(json.dumps(index))


@pytest.mark.parametrize(
    ("edit", "message"),
    [
        (lambda i: i.update(entries="nope"), "no entries list"),
        (lambda i: i.update(entries=["x"]), "no meshes object"),
        (lambda i: i["entries"][0].update(meshes=[1]), "no meshes object"),
        (lambda i: i["entries"][0].update(meshes={"lh": "path"}), "no path string"),
        (lambda i: i["entries"][0].update(meshes={"lh": {"path": 7}}), "no path string"),
        (lambda i: i["entries"][0].update(meshes={"lh": {}}), "no path string"),
        (lambda i: i["entries"][0].update(meshes={"lh": {"path": "index.json"}}), "index.json"),
    ],
)
def test_a_malformed_index_is_a_refusal_not_a_traceback(edit, message, surfaces, s3, capsys):
    log, bucket = s3
    _edit_index(surfaces, edit)
    assert _upload(surfaces) == 1
    assert message in capsys.readouterr().err
    assert _writes(_calls(log)) == [] and _keys(bucket) == []


def test_a_symlinked_mesh_is_refused(surfaces, s3, capsys, tmp_path):
    log, bucket = s3
    victim = next((surfaces / "geometry" / "meshes").iterdir())
    outside = tmp_path / "outside.bin"
    outside.write_bytes(victim.read_bytes())
    victim.unlink()
    victim.symlink_to(outside)
    assert _upload(surfaces) == 1
    assert "symbolic link" in capsys.readouterr().err
    assert _writes(_calls(log)) == [] and _keys(bucket) == []


def test_a_symlinked_index_is_refused(surfaces, s3, capsys, tmp_path):
    log, bucket = s3
    index = surfaces / "geometry" / "index.json"
    real = tmp_path / "real-index.json"
    real.write_bytes(index.read_bytes())
    index.unlink()
    index.symlink_to(real)
    assert _upload(surfaces) == 1
    assert "does not exist" in capsys.readouterr().err
    assert _writes(_calls(log)) == []
