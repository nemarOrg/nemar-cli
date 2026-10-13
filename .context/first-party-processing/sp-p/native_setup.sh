# Source from an sbatch script. Picks the route for pamica's native Fortran binary on Expanse (glibc 2.28):
#  1. direct: $ROOT/native-ci/amica15-linux-x64, built by pamica's release workflow in a Rocky Linux 8 container
#     (sccn/pAMICA#370), runs on the node as is.
#  2. container: the v0.4.0 release asset (needs glibc 2.38) inside an Ubuntu 22.04 image via singularity.
# NATIVE_MODE=container forces route 2. The first container caller pulls the image (flock).
ROOT=<SPIKE_ROOT>
CI_BIN="$ROOT/native-ci/amica15-linux-x64"
if [ "${NATIVE_MODE:-auto}" != container ] && [ -x "$CI_BIN" ]; then
  module load singularitypro 2>&1 | tail -1   # unused here; already-queued scripts still check for it
  export PAMICA_NATIVE_BINARY="$CI_BIN"
  echo "native binary (direct, CI-built): $PAMICA_NATIVE_BINARY"
  echo "node glibc: $(ldd --version 2>&1 | head -1)"
else
  module load singularitypro 2>&1 | tail -1
  SIF=$ROOT/ubuntu2204.sif
  export SINGULARITY_CACHEDIR=$ROOT/.singularity-cache SINGULARITY_TMPDIR=$ROOT/.singularity-tmp
  mkdir -p "$SINGULARITY_CACHEDIR" "$SINGULARITY_TMPDIR"
  (
    flock 9
    if [ ! -s "$SIF" ]; then singularity pull "$SIF" docker://ubuntu:22.04 2>&1 | tail -3; fi
  ) 9>"$ROOT/.sif.lock"
  REAL_BIN="$(cat $ROOT/native_binary.txt)"
  cat > "$ROOT/native_wrapper.sh" <<WRAP
#!/usr/bin/env bash
exec singularity exec --bind /tmp,/scratch,$ROOT "$SIF" "$REAL_BIN" "\$@"
WRAP
  chmod +x "$ROOT/native_wrapper.sh"
  export PAMICA_NATIVE_BINARY="$ROOT/native_wrapper.sh"
  echo "native binary via container: $PAMICA_NATIVE_BINARY"
  singularity exec "$SIF" ldd --version 2>&1 | head -1
fi
