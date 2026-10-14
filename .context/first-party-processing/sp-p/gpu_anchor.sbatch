#!/usr/bin/env bash
#SBATCH --job-name=spp-ganchor
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
# Full 2000-iteration fits on the real recording (V100). Priority order; a guard stops launching when time is short.
set -uo pipefail
ROOT=<SPIKE_ROOT>
cd "$ROOT" || exit 1
module purge; module load gpu; module load slurm
hostname; nvidia-smi --query-gpu=name --format=csv,noheader
mkdir -p results/anchors; START=$(date +%s)
run() { # name, then anchor args; skip if less than $NEED seconds remain of the 26-minute budget
  local need=$1 name=$2; shift 2
  local left=$(( 1560 - ($(date +%s) - START) ))
  if [ "$left" -lt "$need" ]; then echo "SKIP $name (left ${left}s < need ${need}s)"; return; fi
  venvs/gpu/bin/python -I code/anchor.py --data data/ds002718_sub-002_eeg70_full.npy --out results/anchors/${name}.npz "$@" 2>>logs/anchor-${SLURM_JOB_ID}.err
}
run 500 v100_f64_full_s42  --backend torch --device cuda --dtype f64 --block-size 131072 --seed 42
run 330 v100_f32_full_s42  --backend torch --device cuda --dtype f32 --block-size 131072 --seed 42
run 260 v100_f64_win20_s42 --backend torch --device cuda --dtype f64 --block-size 131072 --seed 42 --offset 200000 --samples 300000
run 200 v100_f64_win10_s42 --backend torch --device cuda --dtype f64 --block-size 131072 --seed 42 --offset 200000 --samples 150000
run 500 v100_f64_full_s43  --backend torch --device cuda --dtype f64 --block-size 131072 --seed 43
