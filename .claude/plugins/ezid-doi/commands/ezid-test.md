---
name: ezid-test
description: Test EZID API connectivity and mint a test DOI
---

Run the EZID connectivity test script to verify the API is accessible and working.

Execute the test script:
```bash
bash ${CLAUDE_PLUGIN_ROOT}/skills/ezid-api/scripts/test-connectivity.sh
```

After running, report the results to the user. If any step fails, help diagnose the issue.
