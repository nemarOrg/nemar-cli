#!/usr/bin/env bash
#SBATCH --job-name=spps-cnat
#SBATCH --account=<ACCOUNT>
#SBATCH --partition=debug
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=32
#SBATCH --mem=60G
#SBATCH --time=00:28:00
#SBATCH --constraint="lustre"
#SBATCH --no-requeue
#SBATCH --output=<SPIKE_ROOT>/logs/%x-%j.out
#SBATCH --error=<SPIKE_ROOT>/logs/%x-%j.out
# Native Fortran binary built by pamica's release workflow in a Rocky Linux 8 container (sccn/pAMICA#370),
# run directly on an Expanse node: does it load, and how does it scale with threads (64 ch x 75k samples)?
set -uo pipefail
ROOT=<SPIKE_ROOT>
cd "$ROOT" || exit 1
module purge; module load cpu; module load slurm
hostname; lscpu | egrep "Model name|^CPU\(s\)|Thread|NUMA node\(s\)"
source "$ROOT/native_setup.sh"
echo "== binary: glibc symbol floor / needed libs"
module load gcc/10.2.0 2>&1 | tail -1
objdump -T "$PAMICA_NATIVE_BINARY" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1
readelf -d "$PAMICA_NATIVE_BINARY" | grep NEEDED
export OMP_PROC_BIND=false
venvs/cpu/bin/python -I code/drive.py grid --plan cpunat --python venvs/cpu/bin/python --budget-min 22 \
  --out results/cpu_native_${SLURM_JOB_ID}.jsonl
