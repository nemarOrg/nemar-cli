#!/usr/bin/env bash
# usage: seeded.sh <binary> <image> <platform> <SP> <label> ; fixed seed 42, 1 thread, 100 iterations, Newton on (sample defaults); saves LL trace
bin="$1"; img="$2"; plat="$3"; SP="$4"; label="$5"
docker run --rm --platform "$plat" -v "$SP/third-party/pamica-glibc/pamica/sample_data:/s:ro" -v "$bin":/amica15:ro -v "$SP/docker-out":/out "$img" bash -c '
if command -v apt-get >/dev/null; then apt-get update -qq >/dev/null; apt-get install -y -qq libgomp1 >/dev/null 2>&1; fi
for r in 1 2; do
  d=$(mktemp -d); cd $d; cp /s/eeglab_data.fdt .; mkdir out
  sed -e "s#^files .*#files ./eeglab_data.fdt#" -e "s#^outdir .*#outdir ./out/#" -e "s#^max_iter .*#max_iter 100#" -e "s#^writestep .*#writestep 100#" /s/input.param > p.param
  echo "seed 42" >> p.param
  OMP_NUM_THREADS=1 /amica15 p.param 2>&1 | grep -oE "iter +[0-9]+ .*LL = *-?[0-9.]+" | sed -E "s/ lrate.*LL = */ /" > /out/seeded-'"$label"'-$r.txt
  echo "run $r: $(wc -l < /out/seeded-'"$label"'-$r.txt) lines, last: $(tail -1 /out/seeded-'"$label"'-$r.txt)"
done'
