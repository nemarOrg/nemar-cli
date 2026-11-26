"""The one pipeline version every output of the package names."""

from __future__ import annotations

from importlib import metadata


def pipeline_version() -> str:
    """The installed package version.

    Strict: when the package is not installed this raises `importlib.metadata.PackageNotFoundError`
    and the run fails, so no output ever names a made-up version.
    """
    return metadata.version("ieeg-geometry")
