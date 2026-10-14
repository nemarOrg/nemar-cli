#!/usr/bin/env bash
#SBATCH --job-name=spps-nbuild
#SBATCH --account=<ACCOUNT>
#SBATCH --partition=shared
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=16G
#SBATCH --time=00:30:00
#SBATCH --constraint="lustre"
#SBATCH --no-requeue
#SBATCH --output=<SPIKE_ROOT>/logs/%x-%j.out
#SBATCH --error=<SPIKE_ROOT>/logs/%x-%j.out
# Diagnostic + alternative to the container: (1) show why the release binary fails (glibc symbol floor vs the node),
# (2) build amica15 from source with Expanse's own modules (gfortran + OpenMPI + OpenBLAS), (3) smoke it through
# pamica's AMICANative adapter. The container stays the shipping path; this isolates the problem and gives a
# Zen2-tuned build to compare against.
set -uo pipefail
ROOT=<SPIKE_ROOT>
SRC=$ROOT/amica-src
OUT=$ROOT/native-modules
mkdir -p "$OUT"
cd "$ROOT" || exit 1
hostname
echo "== node glibc"; ldd --version 2>&1 | head -1
REL="$(cat $ROOT/native_binary.txt)"

# (1) glibc symbol floor of the release binary
module purge; module load cpu slurm gcc/10.2.0 2>&1 | tail -2
echo "== release binary glibc versions required (highest 5)"
objdump -T "$REL" 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -5
echo "== release binary file"; file "$REL" 2>&1 | cut -c1-200

# (2) build with module recipes, first that links wins
build() {  # $1 = recipe name, $2 = module line, $3 = lapack libs
  local name="$1" mods="$2" lib="$3"
  echo; echo "=== recipe $name: $mods"
  module purge
  # shellcheck disable=SC2086
  module load $mods 2>&1 | tail -3
  command -v mpif90 >/dev/null || { echo "RECIPE_FAIL no mpif90"; return 1; }
  mpif90 --version 2>&1 | head -1
  mkdir -p "$OUT/$name/mod"
  # shellcheck disable=SC2086
  for variant in generic znver2; do
    local flags="-O3 -fopenmp -cpp -ffree-line-length-none -std=legacy -fallow-argument-mismatch"
    local cflags="-O3"
    if [ "$variant" = znver2 ]; then flags="$flags -march=znver2 -mtune=znver2"; cflags="$cflags -march=znver2"; fi
    # shellcheck disable=SC2086
    gcc $cflags -c "$SRC/vmath_shim.c" -o "$OUT/$name/vmath_shim_$variant.o" || return 1
    # shellcheck disable=SC2086
    mpif90 $flags -J"$OUT/$name/mod" -I"$SRC" "$SRC/funmod2.f90" "$SRC/amica15.f90" \
      "$OUT/$name/vmath_shim_$variant.o" -o "$OUT/$name/amica15-$variant" $lib 2>&1 | grep -viE "warning|^ *[0-9]* *\||^ *\^|^$|Warning|-->|Fortran 2018" | head -20
    [ -x "$OUT/$name/amica15-$variant" ] || { echo "RECIPE_FAIL build $variant"; return 1; }
    echo "built $OUT/$name/amica15-$variant"
  done
  # wrapper pins the exact runtime environment of this recipe
  {
    echo '#!/usr/bin/env bash'
    echo "export PATH=\"$PATH\""
    echo "export LD_LIBRARY_PATH=\"$LD_LIBRARY_PATH\""
    echo "exec $OUT/$name/amica15-\${AMICA_VARIANT:-znver2} \"\$@\""
  } > "$OUT/$name/wrapper.sh"
  chmod +x "$OUT/$name/wrapper.sh"
  ldd "$OUT/$name/amica15-znver2" 2>&1 | grep -iE "not found|libopenblas|libmpi|libgomp|libc\.so" | head
  objdump -T "$OUT/$name/amica15-znver2" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1
  echo "$name" > "$OUT/RECIPE_OK"
  return 0
}

build gcc10-ompi413-openblas0318 "cpu/0.17.3b gcc/10.2.0 openmpi/4.1.3 openblas/0.3.18" "-lopenblas" \
  || build gcc10-default "cpu/0.17.3b gcc/10.2.0 openmpi openblas" "-lopenblas" \
  || build gcc10-ompi-netlib "cpu/0.17.3b gcc/10.2.0 openmpi netlib-lapack" "-llapack -lblas"

if [ ! -s "$OUT/RECIPE_OK" ]; then echo "NO_RECIPE_BUILT"; exit 3; fi
NAME="$(cat $OUT/RECIPE_OK)"
echo; echo "== smoke with recipe $NAME"
export PAMICA_NATIVE_BINARY="$OUT/$NAME/wrapper.sh"
module purge; module load cpu slurm
for v in generic znver2; do
  echo "-- variant $v"
  AMICA_VARIANT=$v venvs/cpu/bin/python -I code/probe.py --backend native --device cpu --channels 64 \
    --samples 30000 --threads 2 --iters-a 5 --iters-b 15 --tag native-modules-$v
done
