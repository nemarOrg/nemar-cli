---
name: prove-the-inverse-path-too
description: "A read-back that proves a write does not prove its inverse; retract/absent/cannot-read paths need their own proof and their own test"
metadata:
  node_type: memory
  type: feedback
---

When code proves an assertion by reading state back, the INVERSE operation needs its own proof and its own test. Reusing the assert-side check silently inverts its meaning.

Measured in PR #1405: `batchSetKeyPresence(path, keys, uuid, present)` shared one filter, `recorded.has(key) !== present`. With the oracle returning an empty set on failure, `present: true` sent every key to a per-key probe (fail-closed), while `present: false` made zero keys unconfirmed, probed nothing, and reported every retraction successful. The same shape appeared four times in one PR: registration re-read the log but retraction took the return value; `pushToGitHub`'s `success: true` + warning was checked by the publish path and not by the retraction path; "can this be read" returned a bare boolean so a network failure became a verdict about the source; and a dataset that could not be examined returned `missing: 0`.

**Why:** the assert path is the one that gets written first, reviewed hardest, and tested. The inverse gets the same helper and none of the scrutiny, and its failure direction is the dangerous one -- it reports work as done that was never done.

**How to apply:** for every "verify it landed" check, ask what the same code says when the operation is the opposite one, and when the oracle itself fails. Write the negative test as a pair with the positive one. Then mutate the fix and confirm the test fails: my first attempt at the retraction test passed against the original bug, because the retraction really had happened and both versions agreed. The discriminating case needed the write to have FAILED (a malformed key aborting the batch) while the oracle was blind. See [[verify-fix-against-known-broken]] and [[git-annex-flag-and-log-truths]].
