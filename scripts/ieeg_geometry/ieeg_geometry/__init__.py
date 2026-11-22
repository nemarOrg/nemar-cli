"""Readers, reference surfaces and a geometric verifier for iEEG electrode positions."""

from .bids import Contact, ContactType, ElectrodeSet, GeometryRefusal, discover, read_electrode_set
from .ownership import (
    OwnedPath,
    Ownership,
    Verification,
    blob_id,
    read_ownership,
    write_ownership,
)
from .reference import REFERENCE_NAMES, load_reference, read_brain_mesh
from .surfaces import Surface, read_surface
from .verify import Fit, OffsetFit, fit, fit_with_offset

__all__ = [
    "REFERENCE_NAMES",
    "Contact",
    "ContactType",
    "ElectrodeSet",
    "Fit",
    "GeometryRefusal",
    "OffsetFit",
    "OwnedPath",
    "Ownership",
    "Surface",
    "Verification",
    "blob_id",
    "discover",
    "fit",
    "fit_with_offset",
    "load_reference",
    "read_brain_mesh",
    "read_electrode_set",
    "read_ownership",
    "read_surface",
    "write_ownership",
]
