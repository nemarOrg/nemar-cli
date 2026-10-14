#!/usr/bin/env bash
# usage: determinism.sh <binary> <image> <platform>; runs the same binary 3x for 20 iterations, 1 thread, prints final LL each run
bin="$1"; img="$2"; plat="$3"; SP="$4"
docker run --rm --platform "$plat" -v "$SP/third-party/pamica-glibc/pamica/sample_data:/s:ro" -v "$bin":/amica15:ro "$img" bash -c '
for r in 1 2 3; do
  d=$(mktemp -d); cd $d; cp /s/eeglab_data.fdt .; mkdir out
  sed -e "s#^files .*#files ./eeglab_data.fdt#" -e "s#^outdir .*#outdir ./out/#" -e "s#^max_iter .*#max_iter 20#" -e "s#^writestep .*#writestep 20#" /s/input.param > p.param
  OMP_NUM_THREADS=1 /amica15 p.param 2>&1 | grep -oE "LL = *-?[0-9.]+" | tail -1
done'
