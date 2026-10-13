#!/usr/bin/env bash
# Build pamica's native release recipe inside a container and report glibc floor + smoke + 100-iteration LL trace.
#   PLATFORM=linux/amd64|linux/arm64 build_variant.sh <v0-ubuntu-current|v2-rocky8> <worktree> <outdir>
set -uo pipefail
variant="$1"; wt="$2"; out="$3"
plat="${PLATFORM:-linux/amd64}"; tag="${plat#linux/}"
mkdir -p "$out"
case "$variant" in
  v0-ubuntu-current) image=ubuntu:24.04 ;;
  v2-rocky8) image=rockylinux:8 ;;
  *) echo "unknown variant"; exit 2 ;;
esac
docker run --rm --platform "$plat" -v "$wt":/src:ro -v "$out":/out "$image" bash -c '
set -uo pipefail
variant='"$variant"'; tag='"$tag"'
cp -r /src /work && cd /work
if [ "$variant" = v0-ubuntu-current ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq gfortran liblapack-dev libblas-dev python3 binutils file >/dev/null
  export LAPACK_LIBS="-l:liblapack.a -l:libblas.a" EXTRA_LDFLAGS="-static-libquadmath"
else
  dnf -y -q install dnf-plugins-core >/dev/null 2>&1
  dnf config-manager --set-enabled powertools >/dev/null 2>&1
  dnf -y -q install gcc-toolset-13-gcc-gfortran openblas-static python3 binutils file make 2>&1 | tail -3
  source /opt/rh/gcc-toolset-13/enable
  GOMP_A="$(gfortran -print-file-name=libgomp.a)"
  export LAPACK_LIBS="-l:libopenblas.a" EXTRA_LDFLAGS="-static-libquadmath $GOMP_A -ldl -Wl,--as-needed"
fi
gfortran --version | head -1; ldd --version | head -1
bash native/build.sh > /out/build-$variant-$tag.log 2>&1; rc=$?
tail -3 /out/build-$variant-$tag.log
[ $rc -eq 0 ] || { echo "BUILD_FAILED rc=$rc"; grep -iE "error|cannot find|undefined" /out/build-$variant-$tag.log | head -10; exit 1; }
bin=native/amica15_shim
cp $bin /out/amica15-$variant-$tag
echo "== file"; file $bin | cut -c1-160
echo "== NEEDED"; readelf -d $bin | grep NEEDED
echo "== glibc symbol floor (highest 3)"; objdump -T $bin | grep -o "GLIBC_[0-9.]*" | sort -uV | tail -3
run_fit() {  # $1 iterations, $2 threads
  d=$(mktemp -d); cd $d; cp /work/pamica/sample_data/eeglab_data.fdt .; mkdir -p out
  sed -e "s#^files .*#files ./eeglab_data.fdt#" -e "s#^outdir .*#outdir ./out/#" -e "s#^max_iter .*#max_iter $1#" -e "s#^writestep .*#writestep $1#" /work/pamica/sample_data/input.param > p.param
  OMP_NUM_THREADS=$2 /work/$bin p.param 2>&1
}
echo "== smoke (2 iterations, 2 threads)"; run_fit 2 2 | grep -oE "LL = *-?[0-9.]+" | tail -1
run_fit 100 1 | grep -oE "iter +[0-9]+ .*LL = *-?[0-9.]+" | sed -E "s/ lrate.*LL = */ /" > /out/ll100-$variant-$tag.txt
echo "== 100-iteration LL trace written: $(wc -l < /out/ll100-$variant-$tag.txt) lines; last: $(tail -1 /out/ll100-$variant-$tag.txt)"
' 2>&1 | tee "$out/run-$variant-$tag.log"
