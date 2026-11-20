"""The version bump rule: a byte-preserving edit of the top-level Version, and what it refuses."""

import pytest

from ieeg_geometry import versionbump as vb

DESC = (
    '{\r\n  "Name": "x",\r\n  "GeneratedBy": [{"Name": "a", "Version": "9.9"}],\r\n'
    '    "Version" :   "1.0.0",\r\n  "Z": "\\"Version\\": \\"3\\""\r\n}'
)


def test_only_the_top_level_version_characters_change():
    out = vb.apply(DESC, "1.0.1")
    assert out == DESC.replace('"Version" :   "1.0.0"', '"Version" :   "1.0.1"')
    assert vb.current_version(DESC) == "1.0.0"


def test_a_description_without_a_top_level_version_is_refused():
    with pytest.raises(vb.BumpRefusal, match="no top-level"):
        vb.apply('{"GeneratedBy": [{"Version": "1"}]}', "1.0.1")
    with pytest.raises(vb.BumpRefusal, match="not a string"):
        vb.apply('{"Version": 1}', "1.0.1")


def _plan(branch: str, main: str, tags: list[str], changes: str | None = None):
    return vb.plan(f'{{"Version": "{branch}"}}', f'{{"Version": "{main}"}}', tags, changes)


def test_a_branch_version_above_main_and_every_tag_is_kept():
    got = _plan("1.0.4", "1.0.0", ["v1.0.0"])
    assert (got.current, got.new, got.kept) == ("1.0.4", "1.0.4", True)


def test_a_version_equal_to_main_is_bumped_above_main_and_the_newest_tag():
    assert _plan("1.0.0", "1.0.0", ["v1.0.0"]).new == "1.0.1"
    assert _plan("1.0.2", "1.0.2", ["v1.0.0"]).new == "1.0.3"  # main ahead of the tags
    assert _plan("1.0.0", "1.0.0", ["v1.0.0", "v1.0.5"]).new == "1.0.6"


def test_a_branch_version_that_is_a_tag_or_below_is_not_kept():
    got = _plan("1.0.3", "1.0.0", ["v1.0.0", "v1.0.3"])
    assert (got.new, got.kept) == ("1.0.4", False)


def test_changes_ahead_is_reported_not_refused():
    got = _plan("1.0.0", "1.0.0", ["v1.0.0"], "2.0.0 2024-01-01\n - upstream\n")
    assert got.new == "1.0.1" and "CHANGES lists 2.0.0" in (got.changes_note or "")


def test_a_malformed_version_is_refused():
    with pytest.raises(vb.BumpRefusal, match="not of the form"):
        _plan("1.0", "1.0.0", ["v1.0.0"])
