"""Rewrite the history of a FRESH LOCAL CLONE of a dataset repository for a privacy scrub.

Run it through uv so git-filter-repo is on the path:

    uv run --quiet --with git-filter-repo python rewrite_history.py \
        --repo CLONE --keymap keymap.json --plan git-plan.json [--refs REF ...]

What it does to EVERY commit reachable from the rewritten refs (no pruning, no commit is
dropped, so each ref keeps its commit count, and every tag keeps its name and message):

  a. An annex pointer file (mode 100644, or 100755) whose key is in the keymap, or a symlink
     (mode 120000) whose target names such a key, is replaced by the same shape pointing at
     the new key. A symlink target carries the key twice and a hash directory derived from
     the key's md5, so all three change.
  b. A path in `dropPaths` is deleted from the commit.
  c. For a path in `blankJsonKeys`, every key whose canonical spelling (lowercase, spaces,
     underscores and hyphens removed) is listed has its value replaced by an empty string,
     at any depth. The edit is made on the TEXT of the value, so key order, indentation,
     spacing and every other byte are untouched. Content that is not UTF-8 or not JSON is
     left alone and counted.
  c2. For a path in `jsonOps`, the listed structural edits are applied in order to the JSON
     object: `drop-array-entries` removes the entries of a top-level array whose field equals
     one of the values, `recount` sets a count key and a sum key from that array, `set` sets a
     top-level key to a constant string. This is a re-serialization (an edit that changes
     nothing leaves the file's bytes alone); the file's indentation, its trailing newline and
     its ASCII-or-not escaping are kept.
  d. Text in `appendText` (path -> text) is appended to that path, creating the file in a
     commit that does not have it, once: a file that already ends with the text is left
     as it is, so a second run changes nothing.

The `git-annex` branch is NOT rewritten (it is handled by `annex-registry`). Every other
local branch, every remote-tracking branch (except git-annex ones), and every tag is.

How the append works: filter-repo's `--file-info-callback` only sees the files a commit
CHANGES, so it cannot add a file to a commit that does not touch it. The append is therefore
done in the commit callback, which reads the file's content in the ORIGINAL commit
(`git cat-file`), applies the blank rule, appends, inserts the result as a new blob, and puts
one `M` file change for that path on the commit. No fast-export parser is hand-rolled.

Counts only are printed and written: a path or a key is never echoed, because a file name
can be the identifier. Exit codes: 0 done, 2 bad input, 3 refused (not a fresh clone, wrong
remote; nothing was changed), 1 anything else, including a failure AFTER the refs were rewritten
(the message says so and what to run).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import struct
import subprocess
import sys
from hashlib import md5
from typing import Any

try:
    import git_filter_repo as fr
except ImportError:  # pragma: no cover - exercised only without git-filter-repo
    sys.stderr.write(
        "refused: git-filter-repo is not importable; run through uv --with\n"
    )
    sys.exit(2)

ANNEX_KEY = re.compile(r"^SHA256E-s\d+--[0-9a-f]{64}(\.[A-Za-z0-9.+]*)?$")
KEY_IN_BYTES = re.compile(rb"SHA256E-s\d+--[0-9a-f]{64}(?:\.[A-Za-z0-9.+]*)?")
REGULAR_MODES = (b"100644", b"100755")
SYMLINK_MODE = b"120000"
# A pointer file or a symlink target is a line long; nothing bigger is looked at for keys.
POINTER_MAX_BYTES = 1024
POINTER_PREFIX = b"/annex/objects/"
SYMLINK_SHAPE = re.compile(
    rb"^(?P<prefix>.*/annex/objects/)(?P<h1>[^/]+)/(?P<h2>[^/]+)/"
    rb"(?P<k1>[^/]+)/(?P<k2>[^/]+)$"
)

JSON_WS = " \t\n\r"
JSON_SCALAR = re.compile(
    r"-?Infinity|NaN|true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?"
)
BOM = b"\xef\xbb\xbf"
_DECODER = json.JSONDecoder()


class Refused(Exception):
    """The repository is not in a state the rewrite may touch. Message is a fixed word."""


class BadInput(Exception):
    """The keymap or plan does not match the contract. Message is a fixed word."""


class AfterRewrite(Exception):
    """A step after the refs were rewritten failed: not a refusal, the repository has changed."""


# --------------------------------------------------------------------------------------
# Pure helpers
# --------------------------------------------------------------------------------------


# JavaScript's `\s`, spelled out: Python's `\s` adds U+001C to U+001F and U+0085 and lacks U+FEFF.
_JS_WHITESPACE = (
    "\t\n\x0b\x0c\r \xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)
_CANON_REMOVED = re.compile(f"[{_JS_WHITESPACE}_\\-]+")


def canon(name: str) -> str:
    """Canonical spelling of a JSON key: lowercase, with whitespace, underscores and hyphens
    removed. The same rule as `canonical` in shared/identifier-scan.ts, which names the keys a plan
    lists: a key spelled with a no-break space or a tab must match here exactly when the scanner
    flagged it, or the rewrite leaves its value in the history."""
    return _CANON_REMOVED.sub("", name.lower())


_DIR_CHARS = "0123456789zqjxkmvwgpfZQJXKMVWGPF"


def _display_32bits_as_dir(word: int) -> str:
    cs = [_DIR_CHARS[(word >> (6 * i)) & 31] for i in range(8)]
    swapped = "".join(cs[i + 1] + cs[i] for i in range(0, 8, 2))
    return swapped[:6]


def hash_dir_mixed(key: str) -> str:
    """git-annex's `hashdirmixed` for a key: the `xx/yy` in `.git/annex/objects/xx/yy/KEY/KEY`.

    Re-derived here so the rewrite needs no git-annex binary; the tests compare it with
    `git annex examinekey --format='${hashdirmixed}'`.
    """
    a, b, c, d = struct.unpack("<4I", md5(key.encode()).digest())
    four = "".join(_display_32bits_as_dir(w) for w in (a, b, c, d))[:4]
    return f"{four[:2]}/{four[2:]}"


def rewrite_pointer(content: bytes, keymap: dict[bytes, bytes]) -> bytes | None:
    """The new content of an annex pointer file, or None when it holds no keymapped key.

    A pointer file starts with `/annex/objects/<KEY>`; the rest of the first line and any
    later lines are kept exactly.
    """
    if not content.startswith(POINTER_PREFIX):
        return None
    m = KEY_IN_BYTES.match(content, len(POINTER_PREFIX))
    if m is None:
        return None
    new = keymap.get(m.group(0))
    if new is None:
        return None
    return content[: m.start()] + new + content[m.end() :]


def rewrite_symlink(
    content: bytes, keymap: dict[bytes, bytes]
) -> tuple[bytes | None, bool]:
    """The new target of an annex symlink, or None. The flag is True when the shape is odd.

    Standard shape: `<prefix>/annex/objects/<h1>/<h2>/<KEY>/<KEY>`. Both key occurrences and
    the hash directory change. Any other shape that names a keymapped key gets a textual
    replacement of every occurrence (flagged, so the report can say it happened).
    """
    shape = SYMLINK_SHAPE.match(content)
    if shape is not None:
        k1 = shape.group("k1")
        if k1 == shape.group("k2") and k1 in keymap:
            new = keymap[k1]
            return (
                shape.group("prefix")
                + hash_dir_mixed(new.decode()).encode()
                + b"/"
                + new
                + b"/"
                + new,
                False,
            )
    changed = False

    def swap(m: re.Match[bytes]) -> bytes:
        nonlocal changed
        new = keymap.get(m.group(0))
        if new is None:
            return m.group(0)
        changed = True
        return new

    out = KEY_IN_BYTES.sub(swap, content)
    return (out, True) if changed else (None, False)


class _JsonScan:
    """Find the value spans of target keys in JSON text, without re-serializing anything."""

    def __init__(self, text: str, targets: frozenset[str]) -> None:
        self.s = text
        self.targets = targets
        self.spans: list[tuple[int, int]] = []
        self.already_blank = 0

    def ws(self, i: int) -> int:
        s = self.s
        while i < len(s) and s[i] in JSON_WS:
            i += 1
        return i

    def value(self, i: int, record: bool) -> int:
        s = self.s
        c = s[i]
        if c == "{":
            return self.obj(i, record)
        if c == "[":
            return self.arr(i, record)
        if c == '"':
            return _DECODER.raw_decode(s, i)[1]
        m = JSON_SCALAR.match(s, i)
        if m is None:
            raise ValueError("scalar")
        return m.end()

    def arr(self, i: int, record: bool) -> int:
        i = self.ws(i + 1)
        if self.s[i] == "]":
            return i + 1
        while True:
            i = self.ws(self.value(i, record))
            if self.s[i] == ",":
                i = self.ws(i + 1)
                continue
            if self.s[i] == "]":
                return i + 1
            raise ValueError("array")

    def obj(self, i: int, record: bool) -> int:
        s = self.s
        i = self.ws(i + 1)
        if s[i] == "}":
            return i + 1
        while True:
            key, i = _DECODER.raw_decode(s, i)
            i = self.ws(i)
            if s[i] != ":":
                raise ValueError("colon")
            start = self.ws(i + 1)
            if record and canon(key) in self.targets:
                end = self.value(start, False)
                if s[start:end] == '""':
                    self.already_blank += 1
                else:
                    self.spans.append((start, end))
            else:
                end = self.value(start, record)
            i = self.ws(end)
            if s[i] == ",":
                i = self.ws(i + 1)
                continue
            if s[i] == "}":
                return i + 1
            raise ValueError("object")


def blank_json(content: bytes, targets: frozenset[str]) -> tuple[bytes | None, str]:
    """Blank the target keys of one JSON file's bytes.

    Returns (new bytes or None, status) with status one of "blanked", "already" (valid JSON
    with nothing to blank) or "untouched" (not UTF-8, not JSON, or too deep to parse).
    """
    bom = content.startswith(BOM)
    try:
        text = content[len(BOM) :].decode("utf-8") if bom else content.decode("utf-8")
        json.loads(text)
        scan = _JsonScan(text, targets)
        start = scan.ws(0)
        scan.value(start, True)
    except (UnicodeDecodeError, ValueError, RecursionError, IndexError):
        return None, "untouched"
    if not scan.spans:
        return None, "already"
    out = text
    for a, b in sorted(scan.spans, reverse=True):
        out = out[:a] + '""' + out[b:]
    return (BOM if bom else b"") + out.encode("utf-8"), "blanked"


def _is_number(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _apply_ops(obj: dict[str, Any], ops: list[dict[str, Any]]) -> None:
    """Apply plan ops to a parsed JSON object, in place. ValueError when a sum is impossible."""
    for op in ops:
        kind = op["op"]
        if kind == "set":
            obj[op["key"]] = op["value"]
            continue
        arr = obj.get(op["array"])
        if not isinstance(arr, list):
            continue
        if kind == "drop-array-entries":
            values = set(op["matchValues"])
            obj[op["array"]] = [
                e
                for e in arr
                if not (
                    isinstance(e, dict)
                    and isinstance(e.get(op["matchField"]), str)
                    and e[op["matchField"]] in values
                )
            ]
        elif kind == "recount":
            total = 0
            for e in arr:
                value = e.get(op["sumField"]) if isinstance(e, dict) else None
                if not _is_number(value):
                    raise ValueError("sum")
                total += value
            # Only keys the file already has are recomputed; the file's schema is not extended.
            if op["countKey"] in obj:
                obj[op["countKey"]] = len(arr)
            if op["sumKey"] in obj:
                obj[op["sumKey"]] = total


def apply_json_ops(
    content: bytes, ops: list[dict[str, Any]]
) -> tuple[bytes | None, str]:
    """Apply `jsonOps` to one JSON file's bytes: (new bytes or None, status).

    Status is "applied", "already" (valid, nothing to change; bytes untouched) or "untouched"
    (not UTF-8, not a JSON object, or a sum that cannot be computed).
    """
    bom = content.startswith(BOM)
    try:
        text = content[len(BOM) :].decode("utf-8") if bom else content.decode("utf-8")
        obj = json.loads(text)
        if not isinstance(obj, dict):
            raise TypeError("object")
        edited = json.loads(text)
        _apply_ops(edited, ops)
    except (UnicodeDecodeError, ValueError, TypeError, RecursionError):
        return None, "untouched"
    if edited == obj:
        return None, "already"
    indent_match = re.search(r"\n([ \t]+)\S", text)
    indent: str | None = None
    if indent_match:
        indent = indent_match.group(1)
    compact = indent is None and not re.search(r'"\s*:\s', text)
    dumped = json.dumps(
        edited,
        indent=indent,
        ensure_ascii=text.isascii(),
        separators=(",", ":") if compact else None,
    )
    if text.endswith("\n"):
        dumped += "\n"
    return (BOM if bom else b"") + dumped.encode("utf-8"), "applied"


def append_once(content: bytes, text: bytes) -> bytes:
    """`content` with `text` appended once: unchanged when it already ends with `text`."""
    if content.endswith(text):
        return content
    if content and not content.endswith(b"\n"):
        content += b"\n"
    return content + text


# --------------------------------------------------------------------------------------
# Contract guards (the TypeScript side runs the same shape checks first)
# --------------------------------------------------------------------------------------


def load_keymap(path: str) -> dict[bytes, bytes]:
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    if not isinstance(raw, dict):
        raise BadInput("keymap-not-object")
    out: dict[bytes, bytes] = {}
    for a, b in raw.items():
        if not (
            isinstance(b, str) and ANNEX_KEY.match(a) and ANNEX_KEY.match(b) and a != b
        ):
            raise BadInput("keymap-bad-pair")
        out[a.encode()] = b.encode()
    return out


def valid_op(op: Any) -> bool:
    """The shape of one `jsonOps` entry, per the contract; nothing else is accepted."""

    def strings(*names: str) -> bool:
        return all(isinstance(op.get(n), str) and op[n] for n in names)

    if not isinstance(op, dict):
        return False
    if op.get("op") == "drop-array-entries":
        values = op.get("matchValues")
        return (
            strings("array", "matchField")
            and isinstance(values, list)
            and all(isinstance(v, str) for v in values)
        )
    if op.get("op") == "recount":
        return strings("array", "countKey", "sumKey", "sumField")
    if op.get("op") == "set":
        return strings("key") and isinstance(op.get("value"), str)
    return False


class Plan:
    def __init__(self, raw: Any) -> None:
        if not (
            isinstance(raw, dict)
            and raw.get("version") == 1
            and isinstance(raw.get("dropPaths"), list)
            and isinstance(raw.get("blankJsonKeys"), dict)
            and isinstance(raw.get("appendText"), dict)
        ):
            raise BadInput("plan-shape")
        if not all(isinstance(p, str) and p for p in raw["dropPaths"]):
            raise BadInput("plan-drop-paths")
        for p, keys in raw["blankJsonKeys"].items():
            if not (
                p and isinstance(keys, list) and all(isinstance(k, str) for k in keys)
            ):
                raise BadInput("plan-blank-keys")
        for p, t in raw["appendText"].items():
            if not (p and isinstance(t, str) and t):
                raise BadInput("plan-append-text")
        self.drop: frozenset[bytes] = frozenset(p.encode() for p in raw["dropPaths"])
        self.blank: dict[bytes, frozenset[str]] = {
            p.encode(): frozenset(canon(k) for k in keys)
            for p, keys in raw["blankJsonKeys"].items()
        }
        self.append: dict[bytes, bytes] = {
            p.encode(): t.encode() for p, t in raw["appendText"].items()
        }
        self.ops: dict[bytes, list[dict[str, Any]]] = {}
        raw_ops = raw.get("jsonOps", {})
        if not isinstance(raw_ops, dict):
            raise BadInput("plan-json-ops")
        for p, ops in raw_ops.items():
            if not (p and isinstance(ops, list) and all(valid_op(o) for o in ops)):
                raise BadInput("plan-json-ops")
            self.ops[p.encode()] = ops
        if self.drop & (set(self.append) | set(self.ops)):
            raise BadInput("plan-drop-and-edit-overlap")


# --------------------------------------------------------------------------------------
# Git plumbing
# --------------------------------------------------------------------------------------


def git(*args: str, check: bool = True) -> bytes:
    proc = subprocess.run(["git", *args], capture_output=True, check=False)
    if check and proc.returncode != 0:
        raise Refused("git-command-failed")
    return proc.stdout


GITHUB_URL = re.compile(
    r"^(?:https?://(?:[^@/]+@)?|ssh://(?:[^@/]+@)?|[^@/:]+@)github\.com[/:]"
    r"([^/]+)/([^/]+?)(?:\.git)?/?$",
    re.IGNORECASE,
)


def repo_identity(url: str) -> str:
    """`owner/name`, lowercased, for a GitHub URL in https, ssh:// or scp form (a port of
    `githubRepoOf` in github/repo-url.ts); any other URL is compared as written, sans `.git`."""
    url = url.strip()
    m = GITHUB_URL.match(url)
    if m:
        return f"{m.group(1)}/{m.group(2)}".lower()
    return url.rstrip("/").removesuffix(".git")


#: git-annex's cache of the index tree its keys database last read; see run().
LAST_INDEX_REF = "refs/annex/last-index"


def is_annex_ref(ref: str) -> bool:
    return ref.rsplit("/", 1)[-1] == "git-annex"


def all_refs() -> dict[str, str]:
    out = git("for-each-ref", "--format=%(refname) %(objectname)").decode()
    refs = {}
    for line in out.splitlines():
        name, sha = line.rsplit(" ", 1)
        refs[name] = sha
    return refs


def default_refs(refs: dict[str, str]) -> list[str]:
    """Local heads, remote-tracking heads and tags, never a git-annex ref or a remote HEAD."""
    out = []
    for ref in sorted(refs):
        if is_annex_ref(ref):
            continue
        if (
            ref.startswith(("refs/heads/", "refs/tags/"))
            or ref.startswith("refs/remotes/")
            and ref.count("/") >= 3
            and not ref.endswith("/HEAD")
        ):
            out.append(ref)
    return out


def check_fresh(refs: dict[str, str], expect_remote: str | None) -> None:
    """Refuse anything that is not a clean clone whose branches all match origin.

    filter-repo has its own freshness test, but it rejects a clone where git-annex was
    initialized (extra reflog entries), which is the ordinary case here. This check asks
    for what actually matters: nothing local that the remote does not have, and the remote
    is the one the operator named.
    """
    is_bare = git("rev-parse", "--is-bare-repository").strip() == b"true"
    if not is_bare and git("status", "--porcelain", "--untracked-files=all").strip():
        raise Refused("working-tree-not-clean")
    remotes = git("remote").decode().split()
    if "origin" not in remotes:
        raise Refused("no-origin-remote")
    if expect_remote is not None:
        # Every URL a fetch or a push would use, so a push URL elsewhere does not slip past.
        urls = [
            u
            for key in ("remote.origin.url", "remote.origin.pushurl")
            for u in git("config", "--get-all", key, check=False).decode().splitlines()
            if u.strip()
        ]
        if not urls or any(
            repo_identity(u) != repo_identity(expect_remote) for u in urls
        ):
            raise Refused("remote-mismatch")
    if "refs/stash" in refs:
        raise Refused("has-stash")
    heads = [r for r in refs if r.startswith("refs/heads/") and not is_annex_ref(r)]
    if not heads:
        raise Refused("no-branch")
    for head in heads:
        upstream = "refs/remotes/origin/" + head[len("refs/heads/") :]
        if refs.get(upstream) != refs[head]:
            raise Refused("branch-not-matching-origin")


def keymap_keys_in_history(refs: list[str], keymap: dict[bytes, bytes]) -> set[bytes]:
    """The keymap keys, old or new, that a pointer-sized blob reachable from `refs` names.

    Pointer files and annex symlink targets are a line long, so only blobs up to
    POINTER_MAX_BYTES are read. Plain git, before anything is rewritten.
    """
    wanted = set(keymap) | set(keymap.values())
    listing = git("rev-list", "--objects", *refs)
    oids = [line.split(b" ", 1)[0] for line in listing.splitlines() if line]
    if not oids:
        return set()
    checked = subprocess.run(
        ["git", "cat-file", "--batch-check"],
        input=b"\n".join(oids) + b"\n",
        capture_output=True,
        check=True,
    ).stdout.splitlines()
    small = []
    for line in checked:
        parts = line.split()
        if len(parts) == 3 and parts[1] == b"blob" and int(parts[2]) <= POINTER_MAX_BYTES:
            small.append(parts[0])
    seen: set[bytes] = set()
    if not small:
        return seen
    out = subprocess.run(
        ["git", "cat-file", "--batch"],
        input=b"\n".join(small) + b"\n",
        capture_output=True,
        check=True,
    ).stdout
    at = 0
    for _ in small:
        nl = out.index(b"\n", at)
        size = int(out[at:nl].split()[2])
        body = out[nl + 1 : nl + 1 + size]
        seen.update(k for k in KEY_IN_BYTES.findall(body) if k in wanted)
        at = nl + 1 + size + 1
    return seen


class CatFile:
    """One persistent `git cat-file --batch` for the original objects."""

    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            ["git", "cat-file", "--batch"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        )
        self.cache: dict[bytes, bytes] = {}

    def blob(self, oid: bytes) -> bytes:
        if oid in self.cache:
            return self.cache[oid]
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.proc.stdin.write(oid + b"\n")
        self.proc.stdin.flush()
        header = self.proc.stdout.readline().split()
        if len(header) != 3 or header[1] != b"blob":
            raise RuntimeError("cat-file")
        data = self.proc.stdout.read(int(header[2]) + 1)[:-1]
        self.cache[oid] = data
        return data

    def close(self) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.close()
        self.proc.wait()


def tree_entry(commit: bytes, path: bytes) -> tuple[bytes, bytes, bytes] | None:
    """(mode, type, oid) of `path` in `commit`'s tree, or None."""
    out = subprocess.run(
        [b"git", b"ls-tree", b"-z", commit, b"--", path],
        capture_output=True,
        check=True,
    ).stdout
    if not out:
        return None
    meta = out.split(b"\0", 1)[0].split(b"\t", 1)[0].split()
    return meta[0], meta[1], meta[2]


# --------------------------------------------------------------------------------------
# The rewrite
# --------------------------------------------------------------------------------------


class Rewriter:
    def __init__(self, keymap: dict[bytes, bytes], plan: Plan) -> None:
        self.keymap = keymap
        self.plan = plan
        self.cat = CatFile()
        self.rf: Any = None
        self.blob_memo: dict[tuple[bytes, bytes, bytes], bytes | None] = {}
        self.json_memo: dict[tuple[bytes, bytes], bytes | None] = {}
        self.append_blob_memo: dict[tuple[bytes, bytes], bytes] = {}
        self.dropped_seen: set[bytes] = set()
        self.counts = {
            "blobsRewritten": 0,
            "symlinkNonStandardShape": 0,
            "filesDropped": 0,
            "jsonBlanked": 0,
            "jsonAlreadyBlank": 0,
            "jsonUntouched": 0,
            "jsonOpsApplied": 0,
            "jsonOpsAlready": 0,
            "jsonOpsUntouched": 0,
            "commitsSeen": 0,
            "appended": 0,
            "appendAlreadyPresent": 0,
        }

    # -- file_info_callback ---------------------------------------------------------

    def _edit_json(self, path: bytes, oid: bytes) -> bytes | None:
        """The new bytes of a plan JSON file (blank keys, then ops), or None when unchanged."""
        memo_key = (oid, path)
        if memo_key in self.json_memo:
            return self.json_memo[memo_key]
        content = self.cat.blob(oid)
        changed = False
        if path in self.plan.blank:
            new, status = blank_json(content, self.plan.blank[path])
            self.counts[
                {
                    "blanked": "jsonBlanked",
                    "already": "jsonAlreadyBlank",
                    "untouched": "jsonUntouched",
                }[status]
            ] += 1
            if new is not None:
                content, changed = new, True
        if path in self.plan.ops:
            new, status = apply_json_ops(content, self.plan.ops[path])
            self.counts[
                {
                    "applied": "jsonOpsApplied",
                    "already": "jsonOpsAlready",
                    "untouched": "jsonOpsUntouched",
                }[status]
            ] += 1
            if new is not None:
                content, changed = new, True
        self.json_memo[memo_key] = content if changed else None
        return self.json_memo[memo_key]

    def file_info(self, filename: bytes, mode: bytes, blob_id: bytes, value: Any):
        if filename in self.plan.drop:
            self.counts["filesDropped"] += 1
            self.dropped_seen.add(filename)
            return (None, mode, blob_id)
        if mode == b"160000":
            return (filename, mode, blob_id)

        edited = filename in self.plan.blank or filename in self.plan.ops
        memo_key = (blob_id, mode, filename if edited else b"")
        if memo_key in self.blob_memo:
            new_id = self.blob_memo[memo_key]
            return (filename, mode, new_id if new_id is not None else blob_id)

        new_content: bytes | None = None
        if mode in REGULAR_MODES and edited:
            new_content = self._edit_json(filename, blob_id)
        if (
            new_content is None
            and value.get_size_by_identifier(blob_id) <= POINTER_MAX_BYTES
        ):
            content = value.get_contents_by_identifier(blob_id)
            if mode in REGULAR_MODES:
                new_content = rewrite_pointer(content, self.keymap)
            elif mode == SYMLINK_MODE:
                new_content, odd = rewrite_symlink(content, self.keymap)
                if odd:
                    self.counts["symlinkNonStandardShape"] += 1
            if new_content is not None:
                self.counts["blobsRewritten"] += 1

        new_id = (
            value.insert_file_with_contents(new_content)
            if new_content is not None
            else None
        )
        self.blob_memo[memo_key] = new_id
        return (filename, mode, new_id if new_id is not None else blob_id)

    # -- commit_callback ------------------------------------------------------------

    def _appended_blob(
        self, commit: bytes, path: bytes, text: bytes
    ) -> tuple[bytes, bytes]:
        """(mode, blob id) of `path` in this commit with the text appended once."""
        entry = tree_entry(commit, path)
        if entry is None:
            mode, content = b"100644", b""
        else:
            mode, kind, oid = entry
            if kind != b"blob" or mode not in REGULAR_MODES:
                raise RuntimeError("append-target-not-a-regular-file")
            content = self.cat.blob(oid)
            if path in self.plan.blank or path in self.plan.ops:
                edited = self._edit_json(path, oid)
                if edited is not None:
                    content = edited
        new = append_once(content, text)
        if new == content and entry is not None:
            self.counts["appendAlreadyPresent"] += 1
        else:
            self.counts["appended"] += 1
        memo_key = (path, new)
        if memo_key not in self.append_blob_memo:
            blob = fr.Blob(new)
            self.rf.insert(blob)
            self.append_blob_memo[memo_key] = blob.id
        return mode, self.append_blob_memo[memo_key]

    def on_commit(self, commit: Any, _metadata: Any) -> None:
        self.counts["commitsSeen"] += 1
        # A deletion of a dropped path is moot: the path was never added.
        changes = [
            c
            for c in commit.file_changes
            if not (c.type == b"D" and c.filename in self.plan.drop)
        ]
        for path, text in self.plan.append.items():
            changes = [c for c in changes if c.filename != path]
            mode, blob_id = self._appended_blob(commit.original_id, path, text)
            changes.append(fr.FileChange(b"M", path, blob_id, mode))
        commit.file_changes = changes


# --------------------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------------------


def count_commit_map(path: str) -> tuple[int, int]:
    """(entries, entries whose new id differs from the old one) in filter-repo's commit map."""
    seen = changed = 0
    with open(path, encoding="ascii") as f:
        next(f, None)  # header
        for line in f:
            parts = line.split()
            if len(parts) == 2:
                seen += 1
                if parts[0] != parts[1]:
                    changed += 1
    return seen, changed


def run(args: argparse.Namespace) -> dict[str, Any]:
    keymap = load_keymap(args.keymap)
    with open(args.plan, encoding="utf-8") as f:
        plan = Plan(json.load(f))
    # A relative --report names a file where the operator stands, not inside the clone.
    report_arg = os.path.abspath(args.report) if args.report else None
    os.chdir(args.repo)
    if git("rev-parse", "--git-dir", check=False) == b"":
        raise Refused("not-a-git-repository")

    before = all_refs()
    check_fresh(before, args.expect_remote)
    refs = list(args.refs) if args.refs else default_refs(before)
    if not refs or any(is_annex_ref(r) or r not in before for r in refs):
        raise BadInput("refs-empty-or-unknown-or-annex")

    # A keymap that this history does not hold (another dataset's) must not rewrite anything.
    # An old key that is gone but whose new key stands is a run already done, which stays a no-op.
    in_history = keymap_keys_in_history(refs, keymap)
    if any(old not in in_history and new not in in_history for old, new in keymap.items()):
        raise Refused("keymap-key-never-seen")

    git_dir = git("rev-parse", "--absolute-git-dir").decode().strip()
    work = os.path.join(git_dir, "filter-repo")
    os.makedirs(work, exist_ok=True)
    # A previous run's marker makes filter-repo ask a question after a day; this run has
    # done its own freshness check. Keep the earlier commit map beside the new one.
    marker = os.path.join(work, "already_ran")
    if os.path.exists(marker):
        os.remove(marker)
    commit_map = os.path.join(work, "commit-map")
    if os.path.exists(commit_map):
        n = 1
        while os.path.exists(f"{commit_map}.prev{n}"):
            n += 1
        os.replace(commit_map, f"{commit_map}.prev{n}")

    report_path = report_arg or os.path.join(work, "rewrite-report.json")
    if os.path.exists(report_path):
        n = 1
        while os.path.exists(f"{report_path}.prev{n}"):
            n += 1
        os.replace(report_path, f"{report_path}.prev{n}")
        os.chmod(f"{report_path}.prev{n}", 0o600)

    rewriter = Rewriter(keymap, plan)
    fr_args = fr.FilteringOptions.parse_args(
        [
            "--force",
            "--quiet",
            "--prune-empty",
            "never",
            "--prune-degenerate",
            "never",
            "--refs",
            *refs,
        ],
        error_on_empty=False,
    )
    rf = fr.RepoFilter(
        fr_args,
        file_info_callback=rewriter.file_info,
        commit_callback=rewriter.on_commit,
    )
    rewriter.rf = rf
    try:
        rf.run()
    finally:
        rewriter.cat.close()

    # From here on the refs ARE rewritten: a failure is a failure, never a refusal, and it says so.
    try:
        # git-annex records the tree of the index its keys database last read as
        # `refs/annex/last-index` (10.20240129, Ubuntu 24.04's, does; 10.20260901 does not). The
        # freshness check's `git status` runs the annex filter, so the ref names the PRE-rewrite
        # index and keeps every old pointer blob reachable through the gc below. It is a cache
        # git-annex rebuilds from the index, so it goes with the old history.
        if LAST_INDEX_REF in all_refs():
            git("update-ref", "-d", LAST_INDEX_REF)

        # The rewritten history is the only copy that should stay in the object store.
        git("reflog", "expire", "--expire=now", "--all")
        git("gc", "--prune=now", "--quiet")
    except Refused as e:
        raise AfterRewrite("cleanup-after-rewrite") from e

    after = all_refs()
    seen, changed = count_commit_map(commit_map)
    counts = dict(rewriter.counts)
    counts.update(
        {
            "commitsRewritten": changed,
            "commitMapEntries": seen,
            "refsSeen": len(refs),
            "refsRewritten": sum(1 for r in refs if before.get(r) != after.get(r)),
            "dropPathsNeverSeen": len(plan.drop - rewriter.dropped_seen),
        }
    )
    report = {"version": 1, "counts": counts, "commitMap": commit_map}
    # Owner-only from creation, whatever the umask: the report sits in a working directory beside
    # files whose names can be the identifier. An earlier report was moved aside above, so this
    # is always a new file and no mode of an old one carries over.
    fd = os.open(report_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, sort_keys=True)
        f.write("\n")
    report["reportPath"] = report_path
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    ap.add_argument("--repo", required=True)
    ap.add_argument("--keymap", required=True)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--refs", nargs="+")
    ap.add_argument("--expect-remote")
    ap.add_argument("--report")
    args = ap.parse_args(argv)
    # Keep filter-repo's own chatter off stdout: stdout carries one JSON line of counts.
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        report = run(args)
    except BadInput as e:
        sys.stdout = real_stdout
        print(f"bad-input: {e}")
        return 2
    except Refused as e:
        sys.stdout = real_stdout
        print(f"refused: {e}")
        return 3
    except AfterRewrite as e:
        sys.stdout = real_stdout
        # The refs were rewritten; the old objects may still be in the store. Fixed words only.
        print(
            f"failed: {e}: the refs WERE rewritten; old objects may remain in the object store. "
            "In the clone run `git update-ref -d refs/annex/last-index; git reflog expire "
            "--expire=now --all && git gc --prune=now`, then verify."
        )
        return 1
    except SystemExit:
        # filter-repo ends a failed run with SystemExit; its message may name a file.
        sys.stdout = real_stdout
        print("failed: filter-repo-exit")
        return 1
    except Exception as e:  # noqa: BLE001 - the message is a fixed word or a type name
        sys.stdout = real_stdout
        print(f"failed: {type(e).__name__}")
        return 1
    sys.stdout = real_stdout
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
