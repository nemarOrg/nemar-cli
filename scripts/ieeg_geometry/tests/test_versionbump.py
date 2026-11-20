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


def test_the_next_patch_follows_main_not_the_oldest_tag():
    desc = '{"Version": "1.0.2"}'
    assert vb.plan(desc, ["v1.0.0", "v1.0.1", "v1.0.2"], "1.0.2 2024\n - x\n") == ("1.0.2", "1.0.3")
    assert vb.plan('{"Version": "1.0.0"}', ["v1.0.0"], None) == ("1.0.0", "1.0.1")


@pytest.mark.parametrize(
    ("desc", "tags", "changes", "message"),
    [
        ('{"Version": "1.0.2"}', ["v1.0.0"], None, "no release tag"),
        ('{"Version": "1.0.0"}', ["v1.0.0", "v1.0.1"], None, "ahead of main"),
        ('{"Version": "1.0.0"}', ["v1.0.0"], "1.0.3 2024-01-01\n - x\n", "CHANGES lists 1.0.3"),
        ('{"Version": "1.0"}', ["v1.0.0"], None, "not of the form"),
    ],
)
def test_an_inconsistent_state_is_refused(desc, tags, changes, message):
    with pytest.raises(vb.BumpRefusal, match=message):
        vb.plan(desc, tags, changes)
