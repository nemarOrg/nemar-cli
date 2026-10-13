#!/usr/bin/env bash
#SBATCH --job-name=spp-gpack2
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
# Small-recording regime: does packing help when one fit does not saturate the GPU?
set -uo pipefail
ROOT=<SPIKE_ROOT>
cd "$ROOT" || exit 1
module purge; module load gpu; module load slurm
hostname
for dt in f64 f32; do
  venvs/gpu/bin/python -I code/drive.py pack --python venvs/gpu/bin/python --backend torch --device cuda \
    --dtype $dt --counts 1,2,4,8 --channels 64 --samples 75000 --block-size 32768 --threads 1 \
    --iters-a 20 --iters-b 80 --budget-min 10 --out results/gpu_pack2_${dt}_${SLURM_JOB_ID}.jsonl
done
