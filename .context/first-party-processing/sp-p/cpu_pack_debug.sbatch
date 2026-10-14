#!/usr/bin/env bash
#SBATCH --job-name=spps-cpackd
#SBATCH --account=<ACCOUNT>
#SBATCH --partition=debug
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=32
#SBATCH --mem=60G
#SBATCH --time=00:29:00
#SBATCH --constraint="lustre"
#SBATCH --no-requeue
#SBATCH --output=<SPIKE_ROOT>/logs/%x-%j.out
#SBATCH --error=<SPIKE_ROOT>/logs/%x-%j.out
# CPU packing: P independent single-thread fits on one node. Aggregate throughput shows where
# memory bandwidth saturates; this is the number that prices a CPU node in recording-hours.
set -uo pipefail
ROOT=<SPIKE_ROOT>
cd "$ROOT" || exit 1
module purge; module load cpu; module load slurm
hostname
source "$ROOT/native_setup.sh"
for be in native torch; do
  venvs/cpu/bin/python -I code/drive.py pack --python venvs/cpu/bin/python --backend $be --device cpu \
    --dtype f64 --counts 1,16,32 --channels 64 --samples 75000 --block-size 8192 --threads 1 \
    --iters-a 5 --iters-b 15 --budget-min 11 --out results/cpu_pack_${be}_${SLURM_JOB_ID}.jsonl
done
