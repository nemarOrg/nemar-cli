#!/usr/bin/env bash
#SBATCH --job-name=spp-canchor
#SBATCH --account=<ACCOUNT>
#SBATCH --partition=shared
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=64
#SBATCH --mem=120G
#SBATCH --time=01:30:00
#SBATCH --constraint="lustre"
#SBATCH --no-requeue
#SBATCH --output=<SPIKE_ROOT>/logs/%x-%j.out
#SBATCH --error=<SPIKE_ROOT>/logs/%x-%j.out
# Native Fortran (pamica release asset) on the same real recording, same seed, at two thread counts.
set -uo pipefail
ROOT=<SPIKE_ROOT>
cd "$ROOT" || exit 1
module purge; module load cpu; module load slurm
hostname; lscpu | egrep "Model name|^CPU\(s\)"
source "$ROOT/native_setup.sh"
mkdir -p results/anchors
for thr in 16 64; do
  venvs/cpu/bin/python -I code/anchor.py --backend native --threads $thr --block-size 131072 --seed 42 \
    --data data/ds002718_sub-002_eeg70_full.npy --out results/anchors/fortran_t${thr}_full_s42.npz 2>>logs/canchor-${SLURM_JOB_ID}.err
done
