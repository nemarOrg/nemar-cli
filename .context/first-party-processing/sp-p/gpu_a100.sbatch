#!/usr/bin/env bash
#SBATCH --job-name=spp-a100
#SBATCH --account=<ACCOUNT>
#SBATCH --partition=gpu-shared
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gres=gpu:a100:1
#SBATCH --cpus-per-task=10
#SBATCH --mem=80G
#SBATCH --time=00:40:00
#SBATCH --constraint="lustre"
#SBATCH --no-requeue
#SBATCH --output=<SPIKE_ROOT>/logs/%x-%j.out
#SBATCH --error=<SPIKE_ROOT>/logs/%x-%j.out
# A100 arm (gpu-shared): same key points as the V100 runs, then one full real-data anchor.
set -uo pipefail
ROOT=<SPIKE_ROOT>
cd "$ROOT" || exit 1
module purge; module load gpu; module load slurm
hostname; nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
venvs/gpu/bin/python -I code/drive.py grid --plan key --python venvs/gpu/bin/python --budget-min 18 \
  --data data/ds002718_sub-002_eeg70_full.npy --out results/a100_key_${SLURM_JOB_ID}.jsonl
mkdir -p results/anchors
venvs/gpu/bin/python -I code/anchor.py --data data/ds002718_sub-002_eeg70_full.npy --backend torch --device cuda \
  --dtype f64 --block-size 131072 --seed 42 --out results/anchors/a100_f64_full_s42.npz 2>>logs/a100anchor-${SLURM_JOB_ID}.err
