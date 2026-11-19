"""Label inference over every electrodes file of two verified track-C datasets.

Marked `network`: files are downloaded once into the cache outside the repository
(`$IEEG_GEOMETRY_CACHE`, default `~/.cache/ieeg_geometry_tests`); CI skips the marker.
Run with `uv run pytest -q -m network tests/test_labels_network.py`.
"""

import json
import os
import urllib.request
from pathlib import Path

import pytest

from ieeg_geometry import labels

pytestmark = pytest.mark.network

CACHE = Path(os.environ.get("IEEG_GEOMETRY_CACHE", Path.home() / ".cache" / "ieeg_geometry_tests"))
RAW = "https://raw.githubusercontent.com/nemarDatasets"
API = "https://api.github.com/repos/nemarDatasets"


def _get(url: str) -> bytes:
    request = urllib.request.Request(url)
    if token := os.environ.get("GITHUB_TOKEN"):
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=120) as resp:  # noqa: S310 - fixed https URLs
        return resp.read()


def _dataset(dataset: str) -> Path:
    """Every electrodes file, channels file and the README of a dataset, cached."""
    root = CACHE / "labels" / dataset
    done = root / ".complete"
    if not done.exists():
        tree = json.loads(_get(f"{API}/{dataset}/git/trees/HEAD?recursive=1"))["tree"]
        wanted = [
            t["path"]
            for t in tree
            if t["path"].endswith(("_electrodes.tsv", "_channels.tsv", "_coordsystem.json"))
            or t["path"] == "README.md"
        ]
        for rel in wanted:
            target = root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(_get(f"{RAW}/{dataset}/HEAD/{rel}"))
        done.write_text("\n".join(wanted))
    return root


@pytest.mark.parametrize(("dataset", "n_files"), [("on005007", 42), ("on004370", 7)])
def test_every_electrodes_file_is_labeled_fsaverage(dataset, n_files):
    plan = labels.plan_dataset(_dataset(dataset))
    outcome = [(p.electrodes, p.status, p.label) for p in plan.proposals]
    assert len(outcome) == n_files, outcome
    bad = [o for o in outcome if o[1:] != (labels.ACCEPTED, "fsaverage")]
    assert not bad, bad
    for p in plan.proposals:
        assert p.attempts[-1].fit is not None and p.attempts[-1].fit.median_mm <= 1.0
