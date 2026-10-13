#!/usr/bin/env bash
#SBATCH --job-name=spp-gsmoke
#SBATCH --account=<ACCOUNT>
#SBATCH --partition=gpu-debug
#SBATCH --qos=gpu-debug-normal
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gpus=1
#SBATCH --cpus-per-task=10
#SBATCH --mem=32G
#SBATCH --time=00:12:00
#SBATCH --constraint="lustre"
#SBATCH --no-requeue
#SBATCH --output=<SPIKE_ROOT>/logs/%x-%j.out
#SBATCH --error=<SPIKE_ROOT>/logs/%x-%j.out
# Prove the stack before spending queue slots: torch sees the V100, the wheel has sm_70, a
# kernel launches, and one tiny pamica fit runs on CUDA in float64 and float32.
set -uo pipefail
ROOT=<SPIKE_ROOT>
cd "$ROOT" || exit 1
module purge; module load gpu; module load slurm
hostname; nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
venvs/gpu/bin/python -I - <<'PY' || exit 1
import torch
print("torch", torch.__version__, "cuda", torch.version.cuda)
assert torch.cuda.is_available(), "no CUDA device"
maj, mnr = torch.cuda.get_device_capability(0)
print("device", torch.cuda.get_device_name(0), f"sm_{maj}{mnr}", torch.cuda.get_arch_list())
assert f"sm_{maj}{mnr}" in torch.cuda.get_arch_list(), "wheel has no kernel for this GPU"
a = torch.randn(2048, 2048, device="cuda", dtype=torch.float64)
print("fp64 matmul ok", float((a @ a).sum()) == float((a @ a).sum()))
PY
for dt in f64 f32; do
  venvs/gpu/bin/python -I code/probe.py --backend torch --device cuda --dtype $dt --channels 64 \
    --samples 75000 --block-size 8192 --threads 4 --iters-a 10 --iters-b 30 --tag smoke
done
