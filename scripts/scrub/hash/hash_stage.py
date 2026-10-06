#!/usr/bin/env python3
"""Hash stage of the in-place header scrub (issue #1612, phase 2).

A scrubbed recording differs from the original only in its first 256 bytes (an EDF or BDF
header), but its git-annex key is ``SHA256E-s<size>--<sha256 of the content><ext>``, so the new
key needs the SHA-256 of the whole new content, and that needs one pass over the whole object.
That pass is too slow from a laptop, so this program runs on a host with fast reads from S3,
read-only AWS credentials and Python 3.12. It uses the standard library and the ``aws`` CLI,
nothing else. The file shapes are declared in ``scripts/scrub/contract.ts``.

Three modes:

``compute``
    For every plan key that needs a scrub and was read, stream ``<dataset>/objects/<oldKey>``
    once, in 8 MiB chunks, into TWO SHA-256 digests: one of the stream as stored, one of the
    stream with its first 256 bytes replaced by the patch. The stored digest must equal the hash
    inside the old key and the byte count must equal the size inside it; an object that does not
    is not what its key claims, so it is reported and never written to ``hashes.json``.
    ``hashes.json`` is rewritten atomically as keys finish, so a run can be stopped and resumed.

``verify-new``
    For every entry of ``assembled.json`` stream the NEW object AT THE VERSION assembly recorded
    (``newVersionId``) and require its SHA-256 and byte count to equal what the new key says. The
    version matters: delete-old trusts that exact version, and a later write to the key would
    otherwise be what this hashes. Only if all of them do, write ``new-hash-verified.json``, which
    names the exact bytes of ``assembled.json`` it vouches for. On any mismatch no such file exists
    afterwards: a proof left over from an earlier run is removed first.

``raw-hash``
    For every VERSION of every raw copy in the plan (``rawCopies``: an object under ``objects/``
    stored by its path, not by an annex key) stream ``<dataset>/objects/<name>`` AT that version
    id, and record in ``raw-hashes.json`` its SHA-256 and its git blob id: SHA-1 over
    ``b"blob <size>\\0"`` and the bytes, with the plan's size, computed in the same pass. A byte
    count other than the plan's size is recorded as ``size-differs`` and never with a digest. The
    file names the sha256 of plan.json, is resumed like ``hashes.json``, and is compared by
    ``s3-scrub raw-verify``. Raw names are file paths, so this mode prints counts and fixed words
    only, never a name, and never a read failure's own text (it quotes the key).

Privacy: no participant value is ever printed or written. Output holds annex keys, byte counts
and fixed phrases. The one text that is not ours is the tail of the source command's own
standard error when ``compute`` or ``verify-new`` fails (an ``aws`` error names a bucket and a
key); the stream itself is only ever hashed, never decoded, logged or put in an exception message.

Every file it writes is owner-only (the process umask is 077), as the working directory is.

Exit status: 0 everything done and verified; 1 an object failed (or an unexpected error);
2 usage (an argument the parser refused); 3 refused (an input file does not match the contract,
patches.json is not the one written with plan.json, or an existing output file is another run's);
4 ``--limit`` stopped the run with keys (raw versions) still to hash; 129, 130, 143 ended by
SIGHUP, SIGINT, SIGTERM (every running source command, its ``aws`` child included, is killed with
its process group; finished keys are saved).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass

CHUNK_SIZE = 8 * 1024 * 1024
HEADER_LEN = 256

# fullmatch only: Python's `$` also matches before a trailing newline, and a key reaches a shell.
# re.ASCII: without it `\d` matches any Unicode decimal digit (Arabic-Indic, fullwidth), and
# `int()` accepts them, so a key could carry a size no other reader of the key would parse.
ANNEX_KEY = re.compile(r"SHA256E-s(\d+)--([0-9a-f]{64})(\.[A-Za-z0-9.+]*)?", re.ASCII)
PATCH_HEX = re.compile(r"[0-9a-f]{512}")
SHA256_HEX = re.compile(r"[0-9a-f]{64}")
# A recording kept inline in git is keyed `git:<blob sha>`; the plan records it as unreadable.
GIT_KEY = re.compile(r"git:[0-9a-f]{40}(?:[0-9a-f]{24})?")
SAFE_NAME = re.compile(r"[A-Za-z0-9._-]+")

DEFAULT_BUCKET = "nemar"
DEFAULT_SOURCE_CMD = (
    "aws s3 cp s3://{bucket}/{dataset}/objects/{key} - --only-show-errors"
)
# verify-new reads one VERSION, which `aws s3 cp` cannot name. `get-object` writes the body to the
# file it is given and its JSON reply to standard output, so the body goes to a copy of the pipe on
# descriptor 3 and the reply to /dev/null.
DEFAULT_VERIFY_SOURCE_CMD = (
    "aws s3api get-object --bucket {bucket} --key {dataset}/objects/{key} "
    "--version-id {version} /dev/fd/3 3>&1 >/dev/null"
)
PLACEHOLDER = re.compile(r"\{(dataset|key|bucket|version)\}")

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_REFUSED = 3
EXIT_INCOMPLETE = 4
#: 128 + the signal number, as a shell reports a process a signal ended.
SIGNAL_EXIT = {signal.SIGINT: 130, signal.SIGTERM: 143, signal.SIGHUP: 129}


class InputError(Exception):
    """A file or argument is refused. The message is fixed words, never a value from a file."""


class ReadFailed(Exception):
    """The source did not deliver the object (spawn, exit status, timeout). Worth a retry."""


class ObjectFailure(Exception):
    """The object cannot be accepted. Not retried; the message is fixed words and counts.

    ``word`` is the fixed word ``raw-hash`` prints and records instead of the message, whose read
    failures quote the source command's standard error (which names the key, a file path there).
    """

    def __init__(self, message: str, word: str = "failed") -> None:
        super().__init__(message)
        self.word = word


class Overlong(Exception):
    """The stream went past the size its key declares; reading stopped there."""


@dataclass
class Digests:
    total: int
    original: str
    # None when no patch was asked for, or the stream ended before a whole header arrived.
    patched: str | None
    # The git blob id (SHA-1 of b"blob <expected size>\0" and the bytes), when one was asked for.
    # It names those bytes only when `total` is the expected size, which the caller checks.
    git_blob_sha1: str | None = None


@dataclass
class ParsedKey:
    size: int
    sha256: str
    ext: str


def parse_key(key: str) -> ParsedKey:
    m = ANNEX_KEY.fullmatch(key)
    if not m:
        raise InputError("a key is not a SHA256E annex key")
    return ParsedKey(size=int(m.group(1)), sha256=m.group(2), ext=m.group(3) or "")


def patch_digest(patch_hex: str) -> str:
    """The binding of a hashes entry to the patch it was computed for: the SHA-256 of the 512
    lowercase hex characters as they stand in patches.json (their ASCII bytes, not the 256 bytes
    they decode to). The assemble stage computes the same value and refuses a mismatch."""
    return hashlib.sha256(patch_hex.encode("ascii")).hexdigest()


def build_key(size: int, sha256: str, ext: str) -> str:
    return f"SHA256E-s{size}--{sha256}{ext}"


def digest_stream(
    stream, expected_size: int, patch: bytes | None = None, git_blob: bool = False
) -> Digests:
    """Read ``stream`` to its end in CHUNK_SIZE pieces; hash it as stored and, given a patch, as
    patched (the first HEADER_LEN bytes replaced by ``patch``) in the same pass. With ``git_blob``
    the same pass also computes the git blob id git gives those bytes, assuming ``expected_size``
    of them: SHA-1 over ``b"blob <expected_size>\\0"`` and the bytes.

    ``stream.read(n)`` may return fewer than n bytes before the end, so the header is collected
    across reads. Raises Overlong as soon as more than ``expected_size`` bytes have arrived.
    """
    original = hashlib.sha256()
    patched = hashlib.sha256() if patch is not None else None
    blob = hashlib.sha1(b"blob %d\0" % expected_size) if git_blob else None
    total = 0
    collecting: bytes | None = b"" if patch is not None else None
    while True:
        chunk = stream.read(CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > expected_size:
            raise Overlong
        original.update(chunk)
        if blob is not None:
            blob.update(chunk)
        if patched is None:
            continue
        if collecting is None:
            patched.update(chunk)
            continue
        collecting += chunk
        if len(collecting) >= HEADER_LEN:
            patched.update(patch)
            patched.update(memoryview(collecting)[HEADER_LEN:])
            collecting = None
    whole_header = patched is not None and collecting is None
    return Digests(
        total=total,
        original=original.hexdigest(),
        patched=patched.hexdigest() if whole_header and patched is not None else None,
        git_blob_sha1=blob.hexdigest() if blob is not None else None,
    )


# --- the source command -------------------------------------------------------------------------

_ACTIVE: set = set()
_ACTIVE_LOCK = threading.Lock()
_ABORT = threading.Event()


def build_source_command(
    template: str, dataset: str, bucket: str, key: str, version: str = ""
) -> str:
    """Fill the template's ``{dataset}``, ``{key}``, ``{bucket}`` and ``{version}``, each value
    shell-quoted.

    Done in one pass so a value is never itself scanned for placeholders, and without
    ``str.format`` so a template may carry other braces (an ``awk`` program, say).
    """
    values = {"dataset": dataset, "bucket": bucket, "key": key, "version": version}
    return PLACEHOLDER.sub(lambda m: shlex.quote(values[m.group(1)]), template)


def _kill_group(proc: subprocess.Popen) -> None:
    # The source runs in its own session, so its group is exactly the shell and its children.
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def kill_active() -> None:
    """Stop every running source command and refuse to start another (interrupt or SIGTERM)."""
    with _ACTIVE_LOCK:
        _ABORT.set()
        for proc in list(_ACTIVE):
            _kill_group(proc)


class _Deadline:
    """Kills the source's process group when the per-attempt timeout passes."""

    def __init__(self, proc: subprocess.Popen, seconds: float) -> None:
        self._proc = proc
        self._lock = threading.Lock()
        self._closed = False
        self.expired = False
        self._timer = threading.Timer(seconds, self._fire)
        self._timer.daemon = True
        self._timer.start()

    def _fire(self) -> None:
        with self._lock:
            if self._closed:
                return
            self.expired = True
            _kill_group(self._proc)

    def close(self) -> None:
        with self._lock:
            self._closed = True
        self._timer.cancel()


def _widen_pipe(handle) -> None:
    """Ask Linux for a 1 MiB pipe so a fast `aws s3 cp` is not stalled by the 64 KiB default."""
    try:
        import fcntl

        fcntl.fcntl(handle.fileno(), 1031, 1 << 20)  # F_SETPIPE_SZ
    except (ImportError, AttributeError, OSError):
        pass


def _stderr_tail(handle) -> str:
    """The last of the source's own standard error, as one printable-ASCII line."""
    try:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        handle.seek(max(0, size - 400))
        text = handle.read().decode("ascii", "replace")
    except OSError:
        return "no diagnostic"
    printable = "".join(c if 32 <= ord(c) < 127 else " " for c in text)
    return " ".join(printable.split())[-200:] or "no diagnostic"


def fetch_digests(
    command: str,
    timeout: float,
    expected_size: int,
    patch: bytes | None,
    git_blob: bool = False,
) -> Digests:
    """One attempt: run the source command and digest what it writes.

    Raises ReadFailed when the source itself fails, ObjectFailure when it delivers more bytes
    than the key declares.
    """
    with tempfile.TemporaryFile() as err:
        with _ACTIVE_LOCK:
            if _ABORT.is_set():
                raise ReadFailed("aborted")
            try:
                proc = subprocess.Popen(
                    command,
                    shell=True,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=err,
                    bufsize=CHUNK_SIZE,
                    start_new_session=True,
                )
            except OSError as exc:
                raise ReadFailed(
                    f"cannot start the source command ({type(exc).__name__})"
                ) from None
            _ACTIVE.add(proc)
        _widen_pipe(proc.stdout)
        deadline = _Deadline(proc, timeout)
        digests = None
        overlong = False
        try:
            digests = digest_stream(proc.stdout, expected_size, patch, git_blob)
        except Overlong:
            overlong = True
        finally:
            if digests is None:
                _kill_group(proc)  # overlong, or an error of ours: stop the source
            status = proc.wait()
            deadline.close()
            proc.stdout.close()
            with _ACTIVE_LOCK:
                _ACTIVE.discard(proc)
        if deadline.expired:
            raise ReadFailed(f"no complete read within {timeout:g} seconds")
        if overlong:
            raise ObjectFailure(
                "object is longer than its key says", word="size-differs"
            )
        if status != 0:
            raise ReadFailed(f"source exited with status {status}: {_stderr_tail(err)}")
        return digests


def fetch_with_retry(
    command: str,
    timeout: float,
    retries: int,
    backoff: float,
    expected_size: int,
    patch: bytes | None,
    git_blob: bool = False,
) -> Digests:
    attempt = 0
    while True:
        try:
            return fetch_digests(command, timeout, expected_size, patch, git_blob)
        except ReadFailed as exc:
            if attempt >= retries or _ABORT.is_set():
                raise ObjectFailure(
                    f"read failed after {attempt + 1} attempts: {exc}",
                    word="read-failed",
                ) from None
            attempt += 1
            _ABORT.wait(backoff * 2 ** (attempt - 1))


@dataclass
class Fetch:
    """How to read objects: the source command and the retry policy."""

    template: str
    dataset: str
    bucket: str
    timeout: float
    retries: int
    backoff: float

    def digests(
        self,
        key: str,
        expected_size: int,
        patch: bytes | None,
        version: str = "",
        git_blob: bool = False,
    ) -> Digests:
        command = build_source_command(
            self.template, self.dataset, self.bucket, key, version
        )
        return fetch_with_retry(
            command,
            self.timeout,
            self.retries,
            self.backoff,
            expected_size,
            patch,
            git_blob,
        )


# --- the two verdicts ---------------------------------------------------------------------------


def hash_object(fetch: Fetch, old_key: str, patch: bytes) -> str:
    """Stream the original once and return the key its patched content gets, or raise
    ObjectFailure. The original must be what its own key says it is."""
    parsed = parse_key(old_key)
    d = fetch.digests(old_key, parsed.size, patch)
    if d.total != parsed.size:
        raise ObjectFailure(f"read {d.total} bytes but the key says {parsed.size}")
    if d.original != parsed.sha256:
        raise ObjectFailure("the object does not hash to its key")
    if d.patched is None:
        raise ObjectFailure(f"object is shorter than the {HEADER_LEN}-byte header")
    if d.patched == d.original:
        raise ObjectFailure("the patch leaves the object unchanged")
    return build_key(parsed.size, d.patched, parsed.ext)


def check_new_object(fetch: Fetch, new_key: str, version: str) -> None:
    """Stream one version of a new object and require its size and SHA-256 to be what its key
    says."""
    parsed = parse_key(new_key)
    d = fetch.digests(new_key, parsed.size, None, version)
    if d.total != parsed.size:
        raise ObjectFailure(f"read {d.total} bytes but the key says {parsed.size}")
    if d.original != parsed.sha256:
        raise ObjectFailure("the object does not hash to its key")


# --- files --------------------------------------------------------------------------------------


def _is_version_1(value) -> bool:
    return type(value) is int and value == 1


def _read_bytes(path: str, what: str) -> bytes:
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except OSError as exc:
        raise InputError(
            f"cannot read {what}: {exc.strerror or type(exc).__name__}"
        ) from None


def _load_json(raw: bytes, what: str):
    try:
        return json.loads(raw)
    except (ValueError, RecursionError):
        raise InputError(f"{what} is not valid JSON") from None


def _is_count(value) -> bool:
    return type(value) is int and value >= 0


def _is_name(value) -> bool:
    return isinstance(value, str) and value != ""


def parse_plan(raw: bytes) -> dict:
    """plan.json, checked as ``parsePlan`` in contract.ts checks it: every field this program or a
    later stage trusts, and totals that agree with the keys they summarize. A plan edited to hide
    an unreadable key (``unreadable: 0`` over an unreadable entry) is refused, not acted on."""
    x = _load_json(raw, "plan.json")
    bad = InputError("plan.json does not match the contract")
    if (
        not isinstance(x, dict)
        or not _is_version_1(x.get("version"))
        or not _is_name(x.get("dataset"))
        or not _is_name(x.get("bucket"))
        or not isinstance(x.get("keys"), list)
    ):
        raise bad
    if "partial" in x and type(x["partial"]) is not bool:
        raise bad
    if "patchesSha256" in x and not (
        isinstance(x["patchesSha256"], str) and SHA256_HEX.fullmatch(x["patchesSha256"])
    ):
        raise bad
    seen: set[str] = set()
    need = unreadable = bytes_to_hash = 0
    for k in x["keys"]:
        old_key = k.get("oldKey") if isinstance(k, dict) else None
        if not isinstance(old_key, str):
            raise InputError("plan.json holds a key that is not a SHA256E annex key")
        annex = ANNEX_KEY.fullmatch(old_key)
        inline = k.get("status") == "unreadable" and GIT_KEY.fullmatch(old_key)
        if not annex and not inline:
            raise InputError("plan.json holds a key that is not a SHA256E annex key")
        status, needs, size = k.get("status"), k.get("needsScrub"), k.get("size")
        if status not in ("read", "unreadable") or type(needs) is not bool:
            raise bad
        if not _is_count(size) or (annex and size != parse_key(old_key).size):
            raise bad
        for field in ("versionIds", "reasons"):
            value = k.get(field)
            if not isinstance(value, list) or not all(
                isinstance(v, str) for v in value
            ):
                raise bad
        # A key that was not read cannot be said to need a scrub.
        if needs and status != "read":
            raise bad
        if old_key in seen:
            raise bad
        seen.add(old_key)
        if needs:
            need += 1
            bytes_to_hash += size
        if status == "unreadable":
            unreadable += 1
    t = x.get("totals")
    if (
        not isinstance(t, dict)
        or not all(
            _is_count(t.get(f))
            for f in ("keys", "needScrub", "bytesToHash", "unreadable")
        )
        or t["keys"] != len(x["keys"])
        or t["needScrub"] != need
        or t["unreadable"] != unreadable
        or t["bytesToHash"] != bytes_to_hash
    ):
        raise bad
    raw_totals = ("rawCopyNames", "rawCopyVersions", "rawCopyMarkers")
    if "rawCopies" not in x:
        # No raw copies, no raw counts: the plan is the file a plan without them always was.
        if any(f in t for f in raw_totals):
            raise bad
    else:
        counts = _check_raw_copies(x["rawCopies"])
        if any(
            not _is_count(t.get(f)) or t[f] != n for f, n in zip(raw_totals, counts)
        ):
            raise bad
    return x


RAW_COPY_FIELDS = {"name", "kind", "versions", "markers"}
#: The special remote's marker under objects/: never a raw copy (contract.ts ANNEX_UUID_OBJECT).
ANNEX_UUID_OBJECT = "annex-uuid"


def is_edf_or_bdf(name: str) -> bool:
    return name.lower().endswith((".edf", ".bdf"))


#: Control characters, and U+FFFE and U+FFFF: no DeleteObjects body can name a key holding one
#: (contract.ts hasControlCharacter).
CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f-\x9f\ufffe\uffff]")


def has_control_character(name: str) -> bool:
    """As ``hasControlCharacter`` in contract.ts."""
    return CONTROL_CHARACTER.search(name) is not None


def is_raw_copy_name(name) -> bool:
    """As ``isRawCopyName`` in contract.ts: a name the plan stage lists as a raw copy, with no
    control character (NUL among them). Also one UTF-8 can carry: a lone surrogate cannot reach a
    shell or S3, so it is refused here."""
    if (
        not isinstance(name, str)
        or name in ("", ANNEX_UUID_OBJECT)
        or name.startswith("SHA256E-")
        or has_control_character(name)
    ):
        return False
    try:
        name.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _check_raw_copies(raw) -> tuple[int, int, int]:
    """The ``rawCopies`` of a plan, checked as ``checkRawCopies`` in contract.ts checks them:
    exactly the contract's members, a raw name, the kind its name gives, at least one version or
    marker, ids that are names and never repeat within a name, sizes that are counts, and no name
    twice. The order is the TypeScript reader's to check (Python and JavaScript order strings
    differently outside the Basic Multilingual Plane). Returns (names, versions, markers)."""
    bad = InputError("plan.json holds a raw copy that does not match the contract")
    if not isinstance(raw, list):
        raise bad
    names: set[str] = set()
    versions = markers = 0
    for r in raw:
        if not isinstance(r, dict) or set(r) != RAW_COPY_FIELDS:
            raise bad
        name = r["name"]
        if not is_raw_copy_name(name) or name in names:
            raise bad
        names.add(name)
        if r["kind"] != ("recording" if is_edf_or_bdf(name) else "other"):
            raise bad
        vs, ms = r["versions"], r["markers"]
        if (
            not isinstance(vs, list)
            or not isinstance(ms, list)
            or len(vs) + len(ms) == 0
        ):
            raise bad
        ids: set[str] = set()
        for v in vs:
            if (
                not isinstance(v, dict)
                or set(v) != {"id", "size"}
                or not _is_name(v["id"])
                or not _is_count(v["size"])
                or v["id"] in ids
            ):
                raise bad
            ids.add(v["id"])
        for m in ms:
            if not _is_name(m) or m in ids:
                raise bad
            ids.add(m)
        versions += len(vs)
        markers += len(ms)
    return len(raw), versions, markers


def parse_patches(raw: bytes) -> dict:
    x = _load_json(raw, "patches.json")
    if not isinstance(x, dict):
        raise InputError("patches.json is not an object")
    for key, hex_ in x.items():
        if not ANNEX_KEY.fullmatch(key):
            raise InputError("patches.json holds a bad key")
        if not isinstance(hex_, str) or not PATCH_HEX.fullmatch(hex_):
            raise InputError("patches.json holds a header that is not 256 bytes of hex")
    return x


def parse_assembled(raw: bytes) -> dict:
    x = _load_json(raw, "assembled.json")
    if (
        not isinstance(x, dict)
        or not _is_version_1(x.get("version"))
        or not isinstance(x.get("dataset"), str)
        or not isinstance(x.get("entries"), dict)
    ):
        raise InputError("assembled.json does not match the contract")
    for old_key, e in x["entries"].items():
        new_key = e.get("newKey") if isinstance(e, dict) else None
        if (
            not ANNEX_KEY.fullmatch(old_key)
            or not isinstance(new_key, str)
            or not ANNEX_KEY.fullmatch(new_key)
            # The version assembly made, which is the one this program must hash.
            or not _is_name(e.get("newVersionId"))
        ):
            raise InputError("assembled.json holds a bad entry")
    return x


def load_existing_hashes(path: str, dataset: str, needed: list[str]) -> dict:
    """The entries of an earlier run's hashes.json, or {} when there is none.

    A file that is not this run's (another dataset, a key this plan does not need, a shape that
    could not have been written by us) is refused: resuming from it would mix two runs.
    """
    if not os.path.exists(path):
        return {}
    x = _load_json(
        _read_bytes(path, "the existing hashes file"), "the existing hashes file"
    )
    if (
        not isinstance(x, dict)
        or not _is_version_1(x.get("version"))
        or x.get("dataset") != dataset
        or not isinstance(x.get("entries"), dict)
    ):
        raise InputError(
            "the existing hashes file is not this dataset's; move it aside to restart"
        )
    wanted = set(needed)
    for old_key, e in x["entries"].items():
        if not ANNEX_KEY.fullmatch(old_key) or not isinstance(e, dict):
            raise InputError("the existing hashes file holds a bad entry")
        new_key = e.get("newKey")
        if not isinstance(new_key, str) or not ANNEX_KEY.fullmatch(new_key):
            raise InputError("the existing hashes file holds a bad entry")
        # Absent in a file from before entries were bound to a patch: stale, recomputed later.
        bound = e.get("patchSha256")
        if bound is not None and not (
            isinstance(bound, str) and SHA256_HEX.fullmatch(bound)
        ):
            raise InputError("the existing hashes file holds a bad entry")
        old, new = parse_key(old_key), parse_key(new_key)
        if (
            new.size != old.size
            or new.ext != old.ext
            or new.sha256 == old.sha256
            or e.get("size") != old.size
            or e.get("sourceSha256Verified") is not True
        ):
            raise InputError(
                "the existing hashes file holds an entry this program would not write"
            )
        if old_key not in wanted:
            raise InputError(
                "the existing hashes file holds keys this plan does not need"
            )
    return dict(x["entries"])


def write_atomic(path: str, text: str) -> None:
    """Write ``text`` to ``path`` so a reader sees the old file or the new one, never half."""
    tmp = f"{path}.tmp"
    # Owner-only whatever the umask: a file the working directory's other files are not.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with open(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    try:
        dir_fd = os.open(os.path.dirname(os.path.abspath(path)), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(dir_fd)
    except OSError:
        pass
    finally:
        os.close(dir_fd)


def _check_name(value: str, what: str) -> str:
    if not SAFE_NAME.fullmatch(value):
        raise InputError(f"{what} has characters a name never has")
    return value


def _check_out_dir(path: str) -> None:
    if not os.path.isdir(os.path.dirname(os.path.abspath(path))):
        raise InputError("the directory for --out does not exist")


def _say(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def run_jobs(jobs: list, work, workers: int, on_result) -> None:
    """Run ``work(job)`` over ``jobs`` on a thread pool; ``on_result(job, result)`` runs in the
    calling thread as each one finishes. An interrupt stops the running source commands."""
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(work, job): job for job in jobs}
        try:
            for future in as_completed(futures):
                on_result(futures[future], future.result())
        except BaseException:
            for future in futures:
                future.cancel()
            kill_active()
            raise


# --- compute ------------------------------------------------------------------------------------


def _plan_keys(plan: dict) -> tuple[list[str], int]:
    """(keys to hash in plan order, keys that need no scrub). The plan is complete: see
    ``_require_complete``."""
    needed: list[str] = []
    clean = 0
    for k in plan["keys"]:
        if k["needsScrub"]:
            needed.append(k["oldKey"])
        else:
            clean += 1
    return needed, clean


def _require_complete(plan: dict) -> None:
    """Only a complete plan is hashed, as only a complete one is assembled: one made over every
    manifest, whose every key was read. A key nobody read is a header nobody checked."""
    if plan.get("partial") is True:
        raise InputError(
            "plan.json is partial (made with --tags); make a complete plan"
        )
    if plan["totals"]["unreadable"] > 0:
        raise InputError("plan.json has keys it could not read; the plan is incomplete")


def _hashes_text(dataset: str, entries: dict) -> str:
    body = {"version": 1, "dataset": dataset, "entries": dict(sorted(entries.items()))}
    return json.dumps(body, indent=2) + "\n"


def cmd_compute(args: argparse.Namespace) -> int:
    plan = parse_plan(_read_bytes(args.plan, "plan.json"))
    _require_complete(plan)
    patches_raw = _read_bytes(args.patches, "patches.json")
    # The plan names the exact bytes of the patches.json written with it: a patches.json from
    # another plan would make keys for bytes the assembly will not produce.
    if plan.get("patchesSha256") != hashlib.sha256(patches_raw).hexdigest():
        raise InputError(
            "patches.json is not the one written with plan.json (patches-stale)"
        )
    patches = parse_patches(patches_raw)
    _check_out_dir(args.out)
    dataset = _check_name(plan["dataset"], "the dataset name")
    bucket = _check_name(args.dataset_bucket or plan["bucket"], "the bucket name")
    fetch = Fetch(
        args.source_cmd or DEFAULT_SOURCE_CMD,
        dataset,
        bucket,
        args.timeout,
        args.retries,
        args.retry_backoff,
    )

    needed, clean = _plan_keys(plan)
    existing = load_existing_hashes(args.out, dataset, needed)
    # An entry is reused only for the patch it was computed for. A patch that changed since (or an
    # entry from before entries named their patch) means the new key is for other bytes: drop the
    # entry and read the object again.
    entries = {
        old_key: e
        for old_key, e in existing.items()
        if old_key in patches and e.get("patchSha256") == patch_digest(patches[old_key])
    }
    stale = len(existing) - len(entries)
    resumed = len(entries)
    failures: dict[str, str] = {}
    todo = []
    for old_key in needed:
        if old_key in entries:
            continue
        if old_key not in patches:
            failures[old_key] = "no patch for this key"
        else:
            todo.append(old_key)
    if args.limit is not None:
        todo = todo[: args.limit]

    _say(
        f"hash compute {dataset} from bucket {bucket}: {len(needed)} keys to hash, "
        f"{resumed} already done, {len(todo)} to read now, {clean} need no scrub"
    )
    if stale:
        _say(
            f"hash compute {dataset}: {stale} entries were made for another patch; recomputing"
        )

    done = 0
    unsaved = 0

    def work(old_key: str):
        try:
            return hash_object(fetch, old_key, bytes.fromhex(patches[old_key])), None
        except ObjectFailure as exc:
            return None, str(exc)

    def on_result(old_key: str, result) -> None:
        nonlocal done, unsaved
        new_key, reason = result
        done += 1
        if new_key is None:
            failures[old_key] = reason
            _say(f"[{done}/{len(todo)}] FAILED {old_key}: {reason}")
            return
        entries[old_key] = {
            "newKey": new_key,
            "size": parse_key(old_key).size,
            "sourceSha256Verified": True,
            "patchSha256": patch_digest(patches[old_key]),
        }
        unsaved += 1
        _say(f"[{done}/{len(todo)}] hashed {old_key}")
        if unsaved >= args.checkpoint_every:
            write_atomic(args.out, _hashes_text(dataset, entries))
            unsaved = 0

    try:
        run_jobs(todo, work, args.workers, on_result)
    finally:
        write_atomic(args.out, _hashes_text(dataset, entries))

    remaining = len(needed) - len(entries) - len(failures)
    _say(
        f"hash compute {dataset}: {len(entries)}/{len(needed)} hashed and verified, "
        f"{len(failures)} failed, {remaining} not attempted"
    )
    if failures:
        for old_key in sorted(failures):
            _say(f"FAIL {old_key}: {failures[old_key]}")
        return EXIT_FAILED
    return EXIT_INCOMPLETE if remaining else EXIT_OK


# --- verify-new ---------------------------------------------------------------------------------


def cmd_verify_new(args: argparse.Namespace) -> int:
    raw = _read_bytes(args.assembled, "assembled.json")
    assembled = parse_assembled(raw)
    _check_out_dir(args.out)
    dataset = _check_name(assembled["dataset"], "the dataset name")
    file_bucket = (
        assembled.get("bucket") if isinstance(assembled.get("bucket"), str) else None
    )
    bucket = _check_name(
        args.dataset_bucket or file_bucket or DEFAULT_BUCKET, "the bucket name"
    )
    template = args.source_cmd or DEFAULT_VERIFY_SOURCE_CMD
    # A source that does not name the version would hash whatever is current at the key.
    if "{version}" not in template:
        raise InputError("verify-new needs a --source-cmd that names {version}")
    fetch = Fetch(
        template,
        dataset,
        bucket,
        args.timeout,
        args.retries,
        args.retry_backoff,
    )

    # A proof from an earlier run must not outlive this one: it is valid only once this run ends.
    try:
        os.unlink(args.out)
    except FileNotFoundError:
        pass

    entries = assembled["entries"]
    # Each new object at the version assembly recorded for it.
    jobs = list(
        dict.fromkeys((e["newKey"], e["newVersionId"]) for e in entries.values())
    )
    _say(f"hash verify-new {dataset} from bucket {bucket}: {len(jobs)} objects to read")

    failures: dict[str, str] = {}
    done = 0

    def work(job: tuple[str, str]):
        try:
            check_new_object(fetch, job[0], job[1])
            return None
        except ObjectFailure as exc:
            return str(exc)

    def on_result(job: tuple[str, str], reason) -> None:
        nonlocal done
        done += 1
        if reason is None:
            _say(f"[{done}/{len(jobs)}] verified {job[0]}")
        else:
            failures[job[0]] = reason
            _say(f"[{done}/{len(jobs)}] FAILED {job[0]}: {reason}")

    run_jobs(jobs, work, args.workers, on_result)

    if failures:
        for new_key in sorted(failures):
            _say(f"FAIL {new_key}: {failures[new_key]}")
        _say(f"hash verify-new {dataset}: {len(failures)} failed, no proof written")
        return EXIT_FAILED
    proof = {
        "version": 1,
        "dataset": dataset,
        "assembledSha256": hashlib.sha256(raw).hexdigest(),
        "count": len(entries),
    }
    write_atomic(args.out, json.dumps(proof, indent=2) + "\n")
    _say(f"hash verify-new {dataset}: {len(entries)} entries verified")
    return EXIT_OK


# --- raw-hash -----------------------------------------------------------------------------------

RAW_DIGEST_FIELDS = {"name", "versionId", "size", "sha256", "gitBlobSha1"}
RAW_FAILURE_FIELDS = {"name", "versionId", "failure"}
SHA1_HEX = re.compile(r"[0-9a-f]{40}")
#: The one failure raw-hashes.json records: the bytes read were not the plan's size.
SIZE_DIFFERS = "size-differs"


def _utf16(text: str) -> bytes:
    """A sort key that orders strings as JavaScript does (by UTF-16 code unit), so the file reads
    in the order the TypeScript stages list names."""
    return text.encode("utf-16-be", "surrogatepass")


def _raw_jobs(plan: dict) -> list[tuple[str, str, int]]:
    """(name, version id, plan size) of every raw VERSION of the plan; delete markers hold no
    bytes, so none is read."""
    return [
        (r["name"], v["id"], v["size"])
        for r in plan.get("rawCopies", [])
        for v in r["versions"]
    ]


def load_existing_raw_hashes(
    path: str, dataset: str, plan_sha: str, sizes: dict
) -> dict:
    """The digest entries of an earlier run's raw-hashes.json to keep, or {} when there is none.

    A file that is not this run's (another dataset, another plan.json, a version this plan does
    not record, a shape this program would not write) is refused: resuming from it would mix two
    runs. A recorded ``size-differs`` is not kept: that version is read again.
    """
    if not os.path.exists(path):
        return {}
    what = "the existing raw-hashes file"
    x = _load_json(_read_bytes(path, what), what)
    if (
        not isinstance(x, dict)
        or set(x) != {"version", "dataset", "planSha256", "entries"}
        or not _is_version_1(x["version"])
        or x["dataset"] != dataset
        or not isinstance(x["entries"], list)
    ):
        raise InputError(f"{what} is not this dataset's; move it aside to restart")
    if x["planSha256"] != plan_sha:
        raise InputError(
            f"{what} was made for another plan.json; move it aside to restart"
        )
    kept: dict = {}
    seen: set = set()
    for e in x["entries"]:
        if (
            not isinstance(e, dict)
            or not isinstance(e.get("name"), str)
            or not isinstance(e.get("versionId"), str)
        ):
            raise InputError(f"{what} holds an entry this program would not write")
        at = (e["name"], e["versionId"])
        if at not in sizes:
            raise InputError(f"{what} holds versions this plan does not record")
        if at in seen:
            raise InputError(f"{what} holds an entry this program would not write")
        seen.add(at)
        if set(e) == RAW_FAILURE_FIELDS and e["failure"] == SIZE_DIFFERS:
            continue
        if (
            set(e) != RAW_DIGEST_FIELDS
            or e["size"] != sizes[at]
            or not isinstance(e["sha256"], str)
            or not SHA256_HEX.fullmatch(e["sha256"])
            or not isinstance(e["gitBlobSha1"], str)
            or not SHA1_HEX.fullmatch(e["gitBlobSha1"])
        ):
            raise InputError(f"{what} holds an entry this program would not write")
        kept[at] = e
    return kept


def _raw_hashes_text(dataset: str, plan_sha: str, entries: dict) -> str:
    rows = [
        entries[at]
        for at in sorted(entries, key=lambda at: (_utf16(at[0]), _utf16(at[1])))
    ]
    body = {"version": 1, "dataset": dataset, "planSha256": plan_sha, "entries": rows}
    return json.dumps(body, indent=2) + "\n"


def _word_counts(words) -> str:
    counts: dict[str, int] = {}
    for w in words:
        counts[w] = counts.get(w, 0) + 1
    return ", ".join(f"{w}={n}" for w, n in sorted(counts.items()))


def cmd_raw_hash(args: argparse.Namespace) -> int:
    raw = _read_bytes(args.plan, "plan.json")
    plan = parse_plan(raw)
    _require_complete(plan)
    plan_sha = hashlib.sha256(raw).hexdigest()
    _check_out_dir(args.out)
    dataset = _check_name(plan["dataset"], "the dataset name")
    bucket = _check_name(args.dataset_bucket or plan["bucket"], "the bucket name")
    template = args.source_cmd or DEFAULT_VERIFY_SOURCE_CMD
    # A source that does not name the version would hash whatever is current, and the current
    # entry of a raw recording is a delete marker.
    if "{version}" not in template:
        raise InputError("raw-hash needs a --source-cmd that names {version}")
    fetch = Fetch(
        template,
        dataset,
        bucket,
        args.timeout,
        args.retries,
        args.retry_backoff,
    )

    jobs = _raw_jobs(plan)
    sizes = {(name, vid): size for name, vid, size in jobs}
    entries = load_existing_raw_hashes(args.out, dataset, plan_sha, sizes)
    resumed = len(entries)
    todo = [j for j in jobs if (j[0], j[1]) not in entries]
    if args.limit is not None:
        todo = todo[: args.limit]
    # Counts only: a raw name is a file path, and a read failure's own text names it.
    _say(
        f"hash raw-hash {dataset} from bucket {bucket}: {len(jobs)} raw versions, "
        f"{resumed} already done, {len(todo)} to read now"
    )

    failures: dict = {}
    done = 0
    unsaved = 0

    def work(job: tuple[str, str, int]):
        name, version, size = job
        try:
            d = fetch.digests(name, size, None, version, git_blob=True)
        except ObjectFailure as exc:
            return None, exc.word
        if d.total != size:
            return None, SIZE_DIFFERS
        return d, None

    def written() -> dict:
        out = dict(entries)
        for (name, version), word in failures.items():
            if word == SIZE_DIFFERS:
                out[(name, version)] = {
                    "name": name,
                    "versionId": version,
                    "failure": word,
                }
        return out

    def on_result(job: tuple[str, str, int], result) -> None:
        nonlocal done, unsaved
        name, version, size = job
        d, word = result
        done += 1
        if d is None:
            failures[(name, version)] = word
            _say(f"[{done}/{len(todo)}] FAILED {word}")
            return
        entries[(name, version)] = {
            "name": name,
            "versionId": version,
            "size": size,
            "sha256": d.original,
            "gitBlobSha1": d.git_blob_sha1,
        }
        unsaved += 1
        _say(f"[{done}/{len(todo)}] hashed")
        if unsaved >= args.checkpoint_every:
            write_atomic(args.out, _raw_hashes_text(dataset, plan_sha, written()))
            unsaved = 0

    try:
        run_jobs(todo, work, args.workers, on_result)
    finally:
        write_atomic(args.out, _raw_hashes_text(dataset, plan_sha, written()))

    remaining = len(jobs) - len(entries) - len(failures)
    _say(
        f"hash raw-hash {dataset}: {len(entries)}/{len(jobs)} raw versions hashed, "
        f"{len(failures)} failed, {remaining} not attempted"
    )
    if failures:
        _say(
            f"hash raw-hash {dataset}: failed by reason: {_word_counts(failures.values())}"
        )
        return EXIT_FAILED
    return EXIT_INCOMPLETE if remaining else EXIT_OK


# --- command line -------------------------------------------------------------------------------


def _positive_int(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError("must be a whole number") from None
    if value < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return value


def _non_negative_int(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError("must be a whole number") from None
    if value < 0:
        raise argparse.ArgumentTypeError("must not be negative")
    return value


def _positive_float(text: str) -> float:
    try:
        value = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError("must be a number") from None
    if not value > 0:
        raise argparse.ArgumentTypeError("must be greater than 0")
    return value


def _non_negative_float(text: str) -> float:
    try:
        value = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError("must be a number") from None
    if not value >= 0:
        raise argparse.ArgumentTypeError("must not be negative")
    return value


def _add_read_options(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--workers", type=_positive_int, default=8, help="objects read in parallel (8)"
    )
    p.add_argument(
        "--source-cmd",
        metavar="TEMPLATE",
        help="shell command that writes one object to standard output; {dataset}, {key}, "
        "{bucket} and (verify-new and raw-hash, where it is required) {version} are filled in, "
        "shell-quoted for the shell that runs the template, once. A template that hands them "
        "to another shell (ssh, sh -c) must quote them again for that one: a raw copy's {key} "
        "is a file path and may hold a quote, a space, $ or a backtick. Default: "
        + DEFAULT_SOURCE_CMD
        + "; for verify-new and raw-hash: "
        + DEFAULT_VERIFY_SOURCE_CMD,
    )
    p.add_argument(
        "--dataset-bucket",
        metavar="BUCKET",
        help=f"bucket the objects live in (default: the bucket the input file names, else "
        f"{DEFAULT_BUCKET})",
    )
    p.add_argument(
        "--timeout",
        type=_positive_float,
        default=3600.0,
        metavar="SECONDS",
        help="per attempt at one object; the source command is killed after it (3600)",
    )
    p.add_argument(
        "--retries",
        type=_non_negative_int,
        default=3,
        help="retries after a failed read, so 4 attempts in all (3)",
    )
    p.add_argument(
        "--retry-backoff",
        type=_non_negative_float,
        default=2.0,
        metavar="SECONDS",
        help="wait before the first retry, doubled for each one after (2)",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hash_stage.py",
        description="Hash stage of the in-place header scrub: new annex keys for patched "
        "objects, and a proof that assembled objects hash to their keys. See the module "
        "docstring.",
        allow_abbrev=False,
    )
    modes = parser.add_subparsers(dest="mode", required=True, metavar="MODE")

    compute = modes.add_parser(
        "compute",
        help="stream each original once and write hashes.json",
        description="Stream every plan key that needs a scrub once, hash it as stored and as "
        "patched, and write hashes.json. A key whose stored bytes do not hash to the key (or "
        "whose size differs) is reported, left out of hashes.json, and makes the exit status "
        "non-zero. An existing hashes.json is resumed: keys already in it are not read again.",
        allow_abbrev=False,
    )
    compute.add_argument("--plan", required=True, help="plan.json")
    compute.add_argument("--patches", required=True, help="patches.json")
    compute.add_argument(
        "--out", required=True, help="hashes.json, rewritten atomically"
    )
    compute.add_argument(
        "--limit",
        type=_positive_int,
        help="read at most this many keys, then exit with status 4 if keys remain",
    )
    compute.add_argument(
        "--checkpoint-every",
        type=_positive_int,
        default=5,
        metavar="N",
        help="rewrite hashes.json after every N newly hashed keys (5)",
    )
    _add_read_options(compute)
    compute.set_defaults(func=cmd_compute)

    verify = modes.add_parser(
        "verify-new",
        help="stream each assembled object and write new-hash-verified.json",
        description="Stream every new object named by assembled.json and require its SHA-256 "
        "and byte count to equal what its key says. Writes the proof file only if all do; on "
        "any mismatch it prints the failing keys, writes nothing, and removes a proof left by "
        "an earlier run.",
        allow_abbrev=False,
    )
    verify.add_argument("--assembled", required=True, help="assembled.json")
    verify.add_argument("--out", required=True, help="new-hash-verified.json")
    _add_read_options(verify)
    verify.set_defaults(func=cmd_verify_new)

    raw_hash = modes.add_parser(
        "raw-hash",
        help="stream each raw version the plan records and write raw-hashes.json",
        description="Stream every VERSION of every raw copy plan.json records (an object under "
        "objects/ stored by its path, not by an annex key) at its version id, and record its "
        "sha256 and its git blob id (SHA-1 of 'blob <size>\\0' and the bytes, with the plan's "
        "size) in raw-hashes.json, which names the sha256 of plan.json. A version whose byte "
        "count is not the plan's size is recorded as size-differs, never with a digest. Prints "
        "counts and fixed words only, never a name. An existing raw-hashes.json for the same "
        "plan.json is resumed. s3-scrub raw-verify then compares the digests.",
        allow_abbrev=False,
    )
    raw_hash.add_argument("--plan", required=True, help="plan.json")
    raw_hash.add_argument(
        "--out", required=True, help="raw-hashes.json, rewritten atomically"
    )
    raw_hash.add_argument(
        "--limit",
        type=_positive_int,
        help="read at most this many versions, then exit with status 4 if versions remain",
    )
    raw_hash.add_argument(
        "--checkpoint-every",
        type=_positive_int,
        default=5,
        metavar="N",
        help="rewrite raw-hashes.json after every N newly hashed versions (5)",
    )
    _add_read_options(raw_hash)
    raw_hash.set_defaults(func=cmd_raw_hash)
    return parser


class Interrupted(KeyboardInterrupt):
    """A signal ended the run; ``signum`` says which."""

    def __init__(self, signum: int) -> None:
        super().__init__()
        self.signum = signum


def _on_signal(signum, frame) -> None:
    raise Interrupted(signum)


def main(argv: list[str] | None = None) -> int:
    # Owner-only for every file this process and its source commands create.
    os.umask(0o077)
    args = build_parser().parse_args(argv)
    if threading.current_thread() is threading.main_thread():
        # SIGINT, SIGTERM and SIGHUP (a dropped terminal) all stop the run the same way: every
        # source command's process group is killed, so no `aws` child outlives this process.
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(sig, _on_signal)
    try:
        return args.func(args)
    except InputError as exc:
        _say(f"hash_stage: {exc}")
        return EXIT_REFUSED
    except KeyboardInterrupt as exc:
        kill_active()
        signum = exc.signum if isinstance(exc, Interrupted) else signal.SIGINT
        name = signal.Signals(signum).name
        _say(f"hash_stage: interrupted by {name}; finished keys were saved")
        return SIGNAL_EXIT.get(signum, 130)
    except Exception as exc:  # noqa: BLE001 - last resort, and it must not echo a message
        frames = ", ".join(
            f"{os.path.basename(f.filename)}:{f.lineno} {f.name}"
            for f in traceback.extract_tb(exc.__traceback__)
        )
        _say(f"hash_stage: unexpected {type(exc).__name__} at {frames}")
        return EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main())
