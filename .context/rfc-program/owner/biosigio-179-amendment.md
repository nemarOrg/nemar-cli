Amendment, 2026-11-20: the specification repository is created now, not at beta.

nemarOrg/biosig-zarr is created now for the whole format, so the format can go out for community comment as NEMAR RFC 0001 (in nemarOrg/rfcs), with `.bzx` as its single-file form. None of the three recorded beta triggers has fired; the reason for moving early is the comment process, which needs a canonical text and a stable place to point at. The license decided on 2026-11-18 stands: the W3C Software and Document License for the text, and Apache License 2.0 for schemas, test vectors and code.

The pre-beta page at docs.nemar.org/formats/biosig-zarr/ moves into the repository unchanged and is tagged 2.0.0; the docs page then renders the text from that tag. The beta criteria in this issue are unchanged. The names `biosig-zarr` and `.bzx` are put up for comment in RFC 0001 rather than frozen first. OME-Zarr RFC-9 stays prior art: NEMAR's packing rules are its own and will not track later changes to RFC-9.
