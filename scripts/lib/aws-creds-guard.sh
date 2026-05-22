# shellcheck shell=bash
#
# AWS credentials guard for nemar-cli admin scripts.
#
# Enforces the access-policies rules documented at
# docs/operations/access-policies.md (principles 5 and 6):
#
# - Long-lived `AKIA*` keys must never live in process environment
#   variables. They belong in `~/.aws/credentials` (mode 0600) where the
#   AWS CLI picks them up automatically.
# - Short-lived `ASIA*` STS session tokens in env vars are allowed (they
#   expire on their own) but not preferred.
# - The script's caller must be able to authenticate against AWS before
#   any S3 operation runs. We probe with `aws sts get-caller-identity`
#   and fail fast with a structured error if no credentials resolve.
#
# Usage in a script:
#
#   . "$(dirname "${BASH_SOURCE[0]}")/lib/aws-creds-guard.sh"
#   nemar_guard_aws_credentials
#
# The function exits the script with code 2 on credential policy
# violations (long-lived AKIA in env, or no resolvable identity).

nemar_guard_aws_credentials() {
  local key="${AWS_ACCESS_KEY_ID:-}"

  if [[ -n "$key" ]]; then
    case "$key" in
      AKIA*)
        cat >&2 <<'EOF'
ERROR: AWS_ACCESS_KEY_ID env var contains a long-lived key (AKIA*).

Long-lived keys must NOT live in process environment variables. Reasons:
  - Env vars leak to every child process this script spawns.
  - Env vars appear in /proc/<pid>/environ to anyone with read access.
  - Env vars may be captured by debug logging, shell history, or
    process-monitoring tools without your knowledge.

Use one of these instead:
  1. Put the key in ~/.aws/credentials (mode 0600). The AWS CLI picks
     it up automatically via the default credential chain. Unset
     AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY before re-running.
  2. Mint short-lived STS credentials (ASIA*) via `aws sso login` or
     `aws-vault exec`. Those expire on their own.

Reference: docs/operations/access-policies.md (principles 5 + 6).
EOF
        return 2
        ;;
      ASIA*)
        echo "WARN: AWS_ACCESS_KEY_ID is a short-lived STS key (ASIA*) in env." >&2
        echo "       Acceptable, but ~/.aws/credentials is preferred for repeatable runs." >&2
        ;;
      *)
        echo "ERROR: AWS_ACCESS_KEY_ID env var has unrecognized prefix." >&2
        echo "       Expected AKIA* (long-lived, REJECTED) or ASIA* (short-lived)." >&2
        return 2
        ;;
    esac
  fi

  # Confirm an identity actually resolves. This catches:
  # - No env vars AND no ~/.aws/credentials configured
  # - Stale SSO sessions
  # - Wrong region or expired ASIA* token
  local identity
  if ! identity=$(aws sts get-caller-identity --output text --query Arn 2>&1); then
    cat >&2 <<EOF
ERROR: No AWS credentials available to this script.

  aws sts get-caller-identity returned:
    $identity

Set up one of:
  - ~/.aws/credentials (mode 0600) with a long-lived AKIA key. Used
    by service-account runtimes (cron, headless). See
    docs/operations/access-policies.md principle 6.
  - aws sso login (short-lived, preferred for interactive admin use).

This script will not proceed without a verified identity.
EOF
    return 2
  fi

  echo "[aws-creds-guard] authenticated as $identity" >&2
  return 0
}
