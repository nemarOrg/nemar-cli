#!/usr/bin/env bash
#
# build-index.sh: write index.json for a directory of artifacts, in the format defined by
# index.schema.json (the single source of truth: the artifact name suffixes, the schema string and
# the fingerprint form all come from there). It is the executable form of the "Artifact store
# interface" in README.md, for tests, for trials, and as a reference for whatever produces the real
# store. It looks for, per dataset id:
#   <id>.jsonld                          (required)
#   <id>_annotated.json                  (optional)
#   <id>_dataset_description.json        (optional)
# The fingerprint is "sha256:" plus the sha256 of the artifacts' own hashes, so it changes exactly
# when any artifact does. Everything else in the directory is ignored.
#
# Usage: tools/build-index.sh DIR [GENERATED_AT]
#   GENERATED_AT  timestamp to record (default: the current UTC time)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
schema_file="$here/../index.schema.json"
dir="${1:?usage: build-index.sh DIR [GENERATED_AT]}"
generated="${2:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

sha_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi
}
sha() { sha_stdin <"$1"; }
bytes() { wc -c <"$1" | tr -d ' '; }

schema_string="$(jq -r '.properties.schema.const' "$schema_file")"
# kind<TAB>suffix for each kind in x-rules.artifactSuffix, jsonld first.
kinds="$(jq -r '."x-rules".artifactSuffix | to_entries | sort_by(.key != "jsonld") | .[] | [.key, .value] | @tsv' "$schema_file")"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
for f in "$dir"/*.jsonld; do
  [ -e "$f" ] || continue
  id="$(basename "$f" .jsonld)"
  arts=""
  hashes=""
  while IFS=$'\t' read -r kind suffix; do
    name="$id$suffix"
    [ -f "$dir/$name" ] || continue
    h="$(sha "$dir/$name")"
    hashes="$hashes$h"
    arts="$arts$(jq -cn --arg n "$name" --arg k "$kind" --arg h "$h" --argjson b "$(bytes "$dir/$name")" \
      '{name:$n, kind:$k, sha256:$h, bytes:$b}')"$'\n'
  done <<<"$kinds"
  fp="$(printf '%s' "$hashes" | sha_stdin)"
  printf '%s' "$arts" | jq -cs --arg id "$id" --arg fp "sha256:$fp" '{id:$id, fingerprint:$fp, artifacts:.}' >>"$tmp"
done
jq -s --arg s "$schema_string" --arg g "$generated" \
  '{schema:$s, generated_at:$g, datasets:(sort_by(.id))}' "$tmp" >"$dir/index.json"
echo "wrote $dir/index.json with $(jq '.datasets | length' "$dir/index.json") dataset(s)"
