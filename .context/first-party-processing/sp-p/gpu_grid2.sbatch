#!/usr/bin/env bash
#SBATCH --job-name=spp-ggrid2
#SBATCH --account=<ACCOUNT>
#SBATCH --partition=gpu-debug
#SBATCH --qos=gpu-debug-normal
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gpus=1
#SBATCH --cpus-per-task=10
#SBATCH --mem=96G
#SBATCH --time=00:29:00
#SBATCH --constraint="lustre"
#SBATCH --no-requeue
#SBATCH --output=<SPIKE_ROOT>/logs/%x-%j.out
#SBATCH --error=<SPIKE_ROOT>/logs/%x-%j.out
set -uo pipefail
ROOT=<SPIKE_ROOT>
cd "$ROOT" || exit 1
module purge; module load gpu; module load slurm
hostname; nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
venvs/gpu/bin/python -I code/drive.py grid --plan gpu2 --python venvs/gpu/bin/python --budget-min 24 \
  --data data/ds002718_sub-002_eeg70_full.npy --out results/gpu_grid2_${SLURM_JOB_ID}.jsonl
