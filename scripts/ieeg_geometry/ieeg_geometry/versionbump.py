"""The dataset version bump of a geometry pull request (`pr --bump-version`).

The central release workflow tags `v<Version>` from `dataset_description.json` on `main` when a
pull request merges (and skips a tag that exists), and the central `version-check` passes a pull
request only when its `Version` differs from `main`'s. So the geometry pull request carries a
Version above `main`'s and every tag (a collaborator's bump on the integration branch is kept),
and merging it cuts that release; no `nemar dataset release` follows (it would cut a further
patch). The edit is byte-preserving: only the characters of the value change.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

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


@dataclass(frozen=True)
class Plan:
    current: str  # the Version on the branch the geometry goes on
    new: str  # the Version the pull request carries
    kept: bool  # the branch already carries a Version the release can tag
    changes_note: str | None  # CHANGES names a later version (normal for a mirror)


def plan(description: str, main_description: str, tags: list[str], changes: str | None) -> Plan:
    """The Version the pull request carries; raises `BumpRefusal` when none can be chosen.

    The version check passes only when the pull request's Version differs from `main`'s. A branch
    Version that differs from `main`'s, is `X.Y.Z` and is above every tag is kept (a collaborator's
    bump); otherwise it is the next patch above the larger of `main`'s Version and the newest tag.
    A `CHANGES` entry above the result is reported, not refused: a mirror's CHANGES lists upstream
    versions.
    """
    cur_text = current_version(description)
    cur = parse(cur_text)
    if cur is None or cur_text != _fmt(cur):
        raise BumpRefusal(f"Version {cur_text!r} is not of the form X.Y.Z; bump it by hand")
    try:
        main_text = current_version(main_description)
    except BumpRefusal:
        main_text = ""
    released = {p for t in tags if (p := parse(t))}
    top = max(released, default=(0, 0, 0))
    if cur_text != main_text and cur > top and cur > (parse(main_text) or (0, 0, 0)):
        new, kept = cur, True
    else:
        base = max(top, parse(main_text) or (0, 0, 0), cur)
        new, kept = (base[0], base[1], base[2] + 1), False
    if new in released:
        raise BumpRefusal(f"v{_fmt(new)} already exists as a tag")
    listed = newest_in_changes(changes)
    note = None
    if listed and (parse(listed) or (0, 0, 0)) > new:
        note = f"CHANGES lists {listed}, ahead of Version {_fmt(new)}"
    return Plan(cur_text, _fmt(new), kept, note)


def apply(description: str, new: str) -> str:
    """The description with only the Version value replaced."""
    start, end = version_span(description)
    return description[:start] + new + description[end:]
