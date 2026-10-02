#!/usr/bin/env bash
#
# build-index.sh: write index.json for a directory of artifacts, in the interface nb-load reads.
#
# This is the executable form of the "Artifact store interface" in README.md, for tests, for
# trials, and as a reference for whatever produces the real store. It looks for, per dataset id:
#   <id>.jsonld                          (required: kind jsonld)
#   <id>_annotated.json                  (optional: kind dictionary)
#   <id>_dataset_description.json        (optional: kind description)
# The fingerprint is the sha256 of the artifacts' own hashes, so it changes exactly when any
# artifact does. Everything else in the directory is ignored.
#
# Usage: tools/build-index.sh DIR [GENERATED_AT]
#   GENERATED_AT  timestamp to record (default: the current UTC time)
set -euo pipefail

dir="${1:?usage: build-index.sh DIR [GENERATED_AT]}"
generated="${2:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
bytes() { wc -c <"$1" | tr -d ' '; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
for f in "$dir"/*.jsonld; do
  [ -e "$f" ] || continue
  id="$(basename "$f" .jsonld)"
  arts=""
  hashes=""
  for spec in "$id.jsonld:jsonld" "${id}_annotated.json:dictionary" "${id}_dataset_description.json:description"; do
    name="${spec%%:*}"
    kind="${spec##*:}"
    [ -f "$dir/$name" ] || continue
    h="$(sha "$dir/$name")"
    hashes="$hashes$h"
    arts="$arts$(jq -cn --arg n "$name" --arg k "$kind" --arg h "$h" --argjson b "$(bytes "$dir/$name")" \
      '{name:$n, kind:$k, sha256:$h, bytes:$b}')"$'\n'
  done
  fp="$(printf '%s' "$hashes" | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; } | cut -d' ' -f1)"
  printf '%s' "$arts" | jq -cs --arg id "$id" --arg fp "sha256:$fp" '{id:$id, fingerprint:$fp, artifacts:.}' >>"$tmp"
done
jq -s --arg g "$generated" '{schema:"nemar-neurobagel-artifact-index/1", generated_at:$g, datasets:(sort_by(.id))}' "$tmp" >"$dir/index.json"
echo "wrote $dir/index.json with $(jq '.datasets | length' "$dir/index.json") dataset(s)"
