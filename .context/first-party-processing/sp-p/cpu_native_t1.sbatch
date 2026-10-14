#!/usr/bin/env bash
#SBATCH --job-name=spps-cnat1
#SBATCH --account=<ACCOUNT>
#SBATCH --partition=debug
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=12G
#SBATCH --time=00:28:00
#SBATCH --constraint="lustre"
#SBATCH --no-requeue
#SBATCH --output=<SPIKE_ROOT>/logs/%x-%j.out
#SBATCH --error=<SPIKE_ROOT>/logs/%x-%j.out
# Why did the 1-thread native row time out? Time 1 and 2 threads with few iterations and a long limit.
set -uo pipefail
ROOT=<SPIKE_ROOT>
cd "$ROOT" || exit 1
module purge; module load cpu; module load slurm
hostname
source "$ROOT/native_setup.sh"
export OMP_PROC_BIND=false
for thr in 2 1; do
  echo "== threads $thr"
  s=$(date +%s)
  timeout 780 venvs/cpu/bin/python -I code/probe.py --backend native --device cpu --dtype f64 --channels 64 \
    --samples 75000 --block-size 8192 --threads $thr --iters-a 3 --iters-b 8 --tag native-t1 | tee -a results/cpu_native_t1_${SLURM_JOB_ID}.jsonl | cut -c1-300
  echo "wall $(( $(date +%s) - s )) s, exit ${PIPESTATUS[0]}"
done
