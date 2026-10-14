#!/usr/bin/env bash
#SBATCH --job-name=spps-cscale
#SBATCH --account=<ACCOUNT>
#SBATCH --partition=shared
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=120
#SBATCH --mem=230G
#SBATCH --time=00:45:00
#SBATCH --constraint="lustre"
#SBATCH --no-requeue
#SBATCH --output=<SPIKE_ROOT>/logs/%x-%j.out
#SBATCH --error=<SPIKE_ROOT>/logs/%x-%j.out
# CPU arm: pamica torch-CPU vs the native Fortran binary, thread scaling on one EPYC 7742 node.
set -uo pipefail
ROOT=<SPIKE_ROOT>
cd "$ROOT" || exit 1
module purge; module load cpu; module load slurm
hostname; lscpu | egrep "Model name|^CPU\(s\)|Thread|NUMA node\(s\)"
source "$ROOT/native_setup.sh"
export OMP_PROC_BIND=false
venvs/cpu/bin/python -I code/drive.py grid --plan cpu --python venvs/cpu/bin/python --budget-min 26 \
  --out results/cpu_scale_${SLURM_JOB_ID}.jsonl
