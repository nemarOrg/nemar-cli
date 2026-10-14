#!/usr/bin/env bash
#SBATCH --job-name=spps-nsmoke
#SBATCH --account=<ACCOUNT>
#SBATCH --partition=shared
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=12G
#SBATCH --time=00:20:00
#SBATCH --constraint="lustre"
#SBATCH --no-requeue
#SBATCH --output=<SPIKE_ROOT>/logs/%x-%j.out
#SBATCH --error=<SPIKE_ROOT>/logs/%x-%j.out
# Prove the containerized native Fortran binary runs on an Expanse CPU node (the release asset needs glibc 2.34+).
set -uo pipefail
ROOT=<SPIKE_ROOT>
cd "$ROOT" || exit 1
module purge; module load cpu; module load slurm
hostname
source "$ROOT/native_setup.sh"
which singularity || { echo "NO_SINGULARITY"; exit 2; }
venvs/cpu/bin/python -I code/probe.py --backend native --device cpu --channels 64 --samples 30000 \
  --threads 2 --iters-a 5 --iters-b 15 --tag native-smoke
