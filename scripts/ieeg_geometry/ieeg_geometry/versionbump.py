"""The dataset version bump of a geometry pull request (`pr --bump-version`).

The central release workflow tags `v<Version>` from `dataset_description.json` on `main` when a
pull request merges (and skips a tag that exists), and the central `version-check` passes a pull
request only when its `Version` differs from `main`'s. So the geometry pull request carries the
next patch of the Version `main` holds, and merging it cuts that release; no `nemar dataset
release` follows (it would cut a further patch). The rule refuses what would tag the wrong
version: a `main` Version that is not a release (no tag), a tag or a `CHANGES` entry ahead of it.
The edit is byte-preserving: only the characters of the value change.
"""

from __future__ import annotations

import re

_SEMVER = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")
_CHANGES_HEADING = re.compile(r"^[ \t]*v?(\d+\.\d+\.\d+)\b")
CHANGES_NAMES = ("CHANGES", "CHANGES.md", "CHANGES.txt", "CHANGES.rst")


class BumpRefusal(Exception):
    """The version cannot be bumped safely; the message says why."""


def parse(version: str) -> tuple[int, int, int] | None:
    m = _SEMVER.match(version.strip())
    return (int(m[1]), int(m[2]), int(m[3])) if m else None


def _fmt(v: tuple[int, int, int]) -> str:
    return ".".join(str(x) for x in v)


def version_span(text: str) -> tuple[int, int]:
    """(start, end) of the characters inside the quotes of the top-level `Version` string."""
    depth, i, n = 0, 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            token = text[i + 1 : j]
            k = j + 1
            while k < n and text[k] in " \t\r\n":
                k += 1
            if depth == 1 and token == "Version" and k < n and text[k] == ":":
                k += 1
                while k < n and text[k] in " \t\r\n":
                    k += 1
                if k < n and text[k] == '"':
                    end = k + 1
                    while end < n and text[end] != '"':
                        end += 2 if text[end] == "\\" else 1
                    return k + 1, end
                raise BumpRefusal("the top-level `Version` is not a string")
            i = j + 1
            continue
        if c in "{[":
            depth += 1
        elif c in "}]":
            depth -= 1
        i += 1
    raise BumpRefusal("dataset_description.json has no top-level `Version` string to bump")


def current_version(description: str) -> str:
    start, end = version_span(description)
    return description[start:end]


def newest_in_changes(changes: str | None) -> str | None:
    found = [m[1] for ln in (changes or "").splitlines() if (m := _CHANGES_HEADING.match(ln))]
    versions = [(parse(v), v) for v in found]
    return max(((p, v) for p, v in versions if p), default=(None, None))[1]


def plan(description: str, tags: list[str], changes: str | None) -> tuple[str, str]:
    """(current, next) for `main`'s Version; raises `BumpRefusal` when no safe bump exists."""
    cur_text = current_version(description)
    cur = parse(cur_text)
    if cur is None:
        raise BumpRefusal(f"Version {cur_text!r} on main is not of the form X.Y.Z; bump it by hand")
    released = {p for t in tags if (p := parse(t))}
    if cur not in released:
        raise BumpRefusal(
            f"main's Version {cur_text} has no release tag (v{cur_text}), so it is not yet a "
            "release: the release workflow has not tagged it; resolve that first, because a "
            "further bump would skip it"
        )
    if (top := max(released)) > cur:
        raise BumpRefusal(
            f"release tag v{_fmt(top)} is ahead of main's Version {cur_text}; "
            "main's dataset_description.json is inconsistent with the releases"
        )
    listed = newest_in_changes(changes)
    if listed and (parse(listed) or (0, 0, 0)) > cur:
        raise BumpRefusal(
            f"CHANGES lists {listed}, ahead of main's Version {cur_text}; "
            "CHANGES and dataset_description.json are inconsistent"
        )
    return cur_text, _fmt((cur[0], cur[1], cur[2] + 1))


def apply(description: str, new: str) -> str:
    """The description with only the Version value replaced."""
    start, end = version_span(description)
    return description[:start] + new + description[end:]
