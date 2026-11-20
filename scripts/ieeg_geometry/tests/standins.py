"""Local stand-ins for `gh` and `aws`: real executables on PATH, backed by files.

They are fixtures, not mocks: the code under test runs its real subprocess calls, and the
stand-ins only replace the two services (GitHub, S3) that tests must never reach. Each logs
every invocation as one JSON line so a test can assert order and confinement.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

GH = r"""#!/usr/bin/env python3
import json
import os
import sys

args = sys.argv[1:]
log = os.environ["STANDIN_LOG"]
body = ""
if "--body-file" in args:
    body = open(args[args.index("--body-file") + 1], encoding="utf-8").read()
with open(log, "a", encoding="utf-8") as fh:
    fh.write(json.dumps({"tool": "gh", "args": args, "body": body}) + "\n")
if os.environ.get("GH_STANDIN_FAIL"):
    sys.stderr.write("gh: HTTP 403\n")
    sys.exit(1)
print("Creating pull request")
print("https://github.com/nemarDatasets/standin/pull/7")
"""

AWS = r"""#!/usr/bin/env python3
import json
import os
import shutil
import sys

args = sys.argv[1:]
log = os.environ["STANDIN_LOG"]
root = os.environ["STANDIN_S3_ROOT"]
profile = None
if args[:1] == ["--profile"]:
    profile, args = args[1], args[2:]
with open(log, "a", encoding="utf-8") as fh:
    fh.write(json.dumps({"tool": "aws", "profile": profile, "args": args}) + "\n")


def split(url):
    bucket, _, key = url[len("s3://"):].partition("/")
    return bucket, key


def opt(name):
    return args[args.index(name) + 1] if name in args else None


if args[:2] == ["s3api", "list-objects-v2"]:
    base = os.path.join(root, opt("--bucket"))
    prefix = opt("--prefix") or ""
    keys = []
    for here, _dirs, files in os.walk(base):
        for name in files:
            keys.append(os.path.relpath(os.path.join(here, name), base))
    keys = sorted(k for k in keys if k.startswith(prefix))
    print(json.dumps(keys) if keys else "null")
elif args[:2] == ["s3", "cp"] and os.environ.get("STANDIN_FAIL_PUT", "\0") in args[3]:
    sys.stderr.write("An error occurred (InternalError) when calling PutObject\n")
    sys.exit(1)
elif args[:2] == ["s3", "cp"]:
    bucket, key = split(args[3])
    target = os.path.join(root, bucket, key)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    shutil.copyfile(args[2], target)
elif args[:2] == ["s3", "rm"]:
    bucket, key = split(args[2])
    os.remove(os.path.join(root, bucket, key))
else:
    sys.stderr.write("stand-in: unsupported aws call\n")
    sys.exit(2)
"""


def install(bin_dir: Path) -> None:
    bin_dir.mkdir(parents=True, exist_ok=True)
    for name, text in (("gh", GH), ("aws", AWS)):
        path = bin_dir / name
        path.write_text(text, encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def activate(monkeypatch, root: Path) -> tuple[Path, Path]:
    """Put the stand-ins first on PATH; returns (call log, S3 root)."""
    install(root / "bin")
    log, s3 = root / "calls.jsonl", root / "s3"
    s3.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("PATH", f"{root / 'bin'}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setenv("STANDIN_LOG", str(log))
    monkeypatch.setenv("STANDIN_S3_ROOT", str(s3))
    return log, s3
