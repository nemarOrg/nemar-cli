#!/bin/sh
# usage: q.sh name "SQL"  -> writes evidence/v1/<name>.json (read-only SELECT via cfman wrangler)
set -e
case "$2" in SELECT*|select*|WITH*|with*) ;; *) echo "not a SELECT" >&2; exit 2;; esac
cd /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/rfc-V1/backend
bunx cfman wrangler --account sccn d1 execute nemar-db --remote --json --command "$2" -c wrangler-sccn.toml > ../.context/rfc-program/evidence/v1/$1.raw 2>&1
sed -n '/^\[/,/^\]/p' ../.context/rfc-program/evidence/v1/$1.raw | bun -e 'const t=await Bun.stdin.text();const j=JSON.parse(t);console.log(JSON.stringify(j[0].results))'
