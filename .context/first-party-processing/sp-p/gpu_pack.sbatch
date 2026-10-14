#!/usr/bin/env bash
#SBATCH --job-name=spp-gpack
#SBATCH --account=<ACCOUNT>
#SBATCH --partition=gpu-debug
#SBATCH --qos=gpu-debug-normal
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gpus=1
#SBATCH --cpus-per-task=10
#SBATCH --mem=64G
#SBATCH --time=00:29:00
#SBATCH --constraint="lustre"
#SBATCH --no-requeue
#SBATCH --output=<SPIKE_ROOT>/logs/%x-%j.out
#SBATCH --error=<SPIKE_ROOT>/logs/%x-%j.out
# Concurrent fits on one GPU: does packing N processes raise aggregate iterations per second?
set -uo pipefail
ROOT=<SPIKE_ROOT>
cd "$ROOT" || exit 1
module purge; module load gpu; module load slurm
hostname; nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
for dt in f64 f32; do
  venvs/gpu/bin/python -I code/drive.py pack --python venvs/gpu/bin/python --backend torch --device cuda \
    --dtype $dt --counts 1,2,3,4,6 --channels 64 --samples 300000 --block-size 8192 --threads 1 \
    --iters-a 10 --iters-b 40 --budget-min 11 --out results/gpu_pack_${dt}_${SLURM_JOB_ID}.jsonl
done
