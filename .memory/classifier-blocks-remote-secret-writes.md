---
name: classifier-blocks-remote-secret-writes
description: the auto-mode classifier refuses commands that pipe a freshly minted secret into a remote credentials file; hand Yahya a one-liner that never prints the secret instead
metadata:
  type: feedback
---

On 2026-09-02 the auto-mode classifier blocked `aws iam create-access-key ... | ssh hallu 'printf ... >> ~/.aws/credentials'` (writing a secret to a remote host), and an earlier variant that passed the classifier failed silently because `aws configure` was not on PATH in Hallu's non-login shell, so the minted key was lost and had to be revoked. Creating the IAM user and policy was fine.

**Why:** the classifier treats remote credential writes as high risk regardless of scope; retrying variants wastes keys.

**How to apply:** do the IAM side (user, policy, revocations, verification) yourself, and give Yahya one paste-able command that mints the key and writes it remotely without echoing the secret (print only the key id prefix). On Hallu, `aws` lives at `$HOME/.local/homebrew/bin/aws` and non-login ssh shells need `export PATH="$HOME/.local/homebrew/bin:$HOME/.local/bin:$PATH"`. Verify afterwards from Hallu with `sts get-caller-identity` plus a denied prod write.
