#!/usr/bin/env bash
#SBATCH --job-name=spps-gshared
#SBATCH --account=<ACCOUNT>
#SBATCH --partition=gpu-shared
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gpus=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --time=00:10:00
#SBATCH --constraint="lustre"
#SBATCH --no-requeue
#SBATCH --output=<SPIKE_ROOT>/logs/%x-%j.out
#SBATCH --error=<SPIKE_ROOT>/logs/%x-%j.out
# Queue-wait probe for gpu-shared (compare Submit to Start in sacct with the CPU shared jobs) that also repeats
# one reference point: 64 ch x 900k samples (one recording-hour at 250 Hz), float64, block 131072.
set -uo pipefail
ROOT=<SPIKE_ROOT>
cd "$ROOT" || exit 1
module purge; module load gpu; module load slurm
hostname; nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
venvs/gpu/bin/python -I code/probe.py --backend torch --device cuda --dtype f64 --channels 64 --samples 900000 \
  --block-size 131072 --threads 4 --iters-a 5 --iters-b 15 --tag gshared-wait | tee -a results/gpu_shared_wait_${SLURM_JOB_ID}.jsonl | cut -c1-400
