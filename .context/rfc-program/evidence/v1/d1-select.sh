#!/bin/sh
# usage: d1-select.sh NAME "SQL"  -> writes evidence/v1/NAME.raw (unedited wrangler output), prints the rows as JSON.
# Read-only: one SELECT or WITH statement through cfman wrangler; anything else is refused before wrangler runs.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
case "$2" in SELECT*|select*|WITH*|with*) ;; *) echo "not a SELECT" >&2; exit 2;; esac
# A semicolon followed by more text would allow a second statement.
case "$2" in *\;*[![:space:]]*) echo "refused: text after a semicolon" >&2; exit 2;; esac
cd "$root/backend"
bunx cfman wrangler --account sccn d1 execute nemar-db --remote --json --command "$2" -c wrangler-sccn.toml > "$here/$1.raw" 2>&1
sed -n '/^\[/,/^\]/p' "$here/$1.raw" | bun -e 'const t=await Bun.stdin.text();const j=JSON.parse(t);console.log(JSON.stringify(j[0].results))'
