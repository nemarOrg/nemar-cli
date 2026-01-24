/**
 * GitHub API service
 *
 * Handles GitHub operations: validating usernames, managing collaborators,
 * creating repositories, and applying branch protection.
 */

const GITHUB_API = "https://api.github.com";
const ORG_NAME = "nemarDatasets";

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
}

/**
 * Validate that a GitHub username exists
 */
export async function validateGitHubUsername(
  username: string,
  pat: string,
): Promise<GitHubUser | null> {
  const response = await fetch(`${GITHUB_API}/users/${username}`, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
    },
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
}

/**
 * List all repositories in the nemarDatasets org
 */
export async function listOrgRepos(pat: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  let page = 1;

  while (true) {
    const response = await fetch(`${GITHUB_API}/orgs/${ORG_NAME}/repos?per_page=100&page=${page}`, {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to list repos: ${response.status}`);
    }

    const pageRepos = await response.json<GitHubRepo[]>();
    if (pageRepos.length === 0) break;

    repos.push(...pageRepos);
    page++;
  }

  return repos;
}

/**
 * Add a user as collaborator to a repository
 */
export async function addCollaborator(
  repo: string,
  username: string,
  permission: "pull" | "push" | "maintain" | "admin",
  pat: string,
): Promise<boolean> {
  const response = await fetch(
    `${GITHUB_API}/repos/${ORG_NAME}/${repo}/collaborators/${username}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ permission }),
    },
  );

  return response.ok || response.status === 204;
}

/**
 * Remove a user as collaborator from a repository
 */
export async function removeCollaborator(
  repo: string,
  username: string,
  pat: string,
): Promise<boolean> {
  const response = await fetch(
    `${GITHUB_API}/repos/${ORG_NAME}/${repo}/collaborators/${username}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    },
  );

  return response.ok || response.status === 204;
}

/**
 * Add user as collaborator to ALL org repositories
 */
export async function addCollaboratorToAllRepos(
  username: string,
  pat: string,
): Promise<{ count: number; errors: string[] }> {
  const repos = await listOrgRepos(pat);
  const errors: string[] = [];
  let count = 0;

  for (const repo of repos) {
    // Skip special repos
    if (repo.name === ".github") continue;

    const success = await addCollaborator(repo.name, username, "push", pat);
    if (success) {
      count++;
    } else {
      errors.push(repo.name);
    }
  }

  return { count, errors };
}

/**
 * Remove user as collaborator from ALL org repositories
 */
export async function removeCollaboratorFromAllRepos(
  username: string,
  pat: string,
): Promise<{ count: number; errors: string[] }> {
  const repos = await listOrgRepos(pat);
  const errors: string[] = [];
  let count = 0;

  for (const repo of repos) {
    const success = await removeCollaborator(repo.name, username, pat);
    if (success) {
      count++;
    } else {
      errors.push(repo.name);
    }
  }

  return { count, errors };
}

/**
 * Create a new repository in the org
 */
export async function createRepository(
  name: string,
  description: string,
  isPrivate: boolean,
  pat: string,
): Promise<GitHubRepo> {
  const response = await fetch(`${GITHUB_API}/orgs/${ORG_NAME}/repos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      description,
      private: isPrivate,
      auto_init: false, // We push the first commit from CLI
      has_issues: true,
      has_projects: false,
      has_wiki: false,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create repo: ${error}`);
  }

  return response.json();
}

/**
 * Apply branch protection rules to main branch
 *
 * Configuration:
 * - Owner can self-merge (no external approval required)
 * - BIDS validation and version check must pass
 * - Admins can bypass if needed
 * - No force pushes or deletions
 */
export async function applyBranchProtection(repo: string, pat: string): Promise<boolean> {
  const response = await fetch(`${GITHUB_API}/repos/${ORG_NAME}/${repo}/branches/main/protection`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      required_pull_request_reviews: {
        required_approving_review_count: 0, // Owner can self-merge
        dismiss_stale_reviews: true,
      },
      enforce_admins: false, // Admins can bypass if needed
      required_status_checks: {
        strict: true,
        contexts: ["bids-validation", "version-check"],
      },
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    }),
  });

  return response.ok;
}

/**
 * Enable auto-merge for a repository
 */
export async function enableAutoMerge(repo: string, pat: string): Promise<boolean> {
  const response = await fetch(`${GITHUB_API}/repos/${ORG_NAME}/${repo}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      allow_auto_merge: true,
    }),
  });

  return response.ok;
}

/**
 * Create or update a file in a repository
 */
export async function createOrUpdateFile(
  repo: string,
  path: string,
  content: string,
  message: string,
  pat: string,
): Promise<boolean> {
  // First, try to get the file to see if it exists (need SHA for update)
  let sha: string | undefined;
  const getResponse = await fetch(`${GITHUB_API}/repos/${ORG_NAME}/${repo}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
    },
  });

  if (getResponse.ok) {
    const existing = await getResponse.json<{ sha: string }>();
    sha = existing.sha;
  }

  // Create or update the file
  const response = await fetch(`${GITHUB_API}/repos/${ORG_NAME}/${repo}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      content: btoa(
        Array.from(new TextEncoder().encode(content), (b) => String.fromCharCode(b)).join(""),
      ),
      ...(sha ? { sha } : {}),
    }),
  });

  return response.ok || response.status === 201;
}

/**
 * Set repository visibility (public or private)
 */
export async function setRepoVisibility(
  repo: string,
  isPrivate: boolean,
  pat: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}/repos/${ORG_NAME}/${repo}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ private: isPrivate }),
    });
  } catch (fetchError) {
    const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
    return { ok: false, status: 0, error: `Network error: ${msg}` };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { ok: false, status: response.status, error: body || `HTTP ${response.status}` };
  }
  return { ok: true, status: response.status };
}

interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url: string;
}

/**
 * Check if a workflow file exists in a repository.
 * Returns true if file exists, false if 404, throws on other errors.
 */
export async function checkWorkflowExists(
  repo: string,
  workflowPath: string,
  pat: string,
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}/repos/${ORG_NAME}/${repo}/contents/${workflowPath}`, {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    });
  } catch (fetchError) {
    const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
    throw new Error(`Network error checking workflow: ${msg}`);
  }

  if (response.ok) return true;
  if (response.status === 404) return false;
  throw new Error(`GitHub API error (${response.status}) checking workflow: ${workflowPath}`);
}

/**
 * Get the latest workflow runs for a specific workflow file.
 * Throws on API errors; returns empty array only when no runs exist.
 */
export async function getWorkflowRuns(
  repo: string,
  workflowFile: string,
  pat: string,
): Promise<WorkflowRun[]> {
  let response: Response;
  try {
    response = await fetch(
      `${GITHUB_API}/repos/${ORG_NAME}/${repo}/actions/workflows/${workflowFile}/runs?per_page=5`,
      {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "NEMAR-API",
        },
      },
    );
  } catch (fetchError) {
    const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
    throw new Error(`Network error fetching workflow runs: ${msg}`);
  }

  if (!response.ok) {
    throw new Error(`GitHub API error (${response.status}) fetching runs for ${workflowFile}`);
  }

  const data = await response.json<{ workflow_runs: WorkflowRun[] }>();
  return data.workflow_runs ?? [];
}

/**
 * Deploy GitHub Actions workflow files to a dataset repository
 */
export async function deployWorkflows(
  repo: string,
  pat: string,
): Promise<{ success: boolean; errors: string[] }> {
  const errors: string[] = [];

  // BIDS Validation workflow
  const bidsValidation = `name: BIDS Validation

on:
  pull_request:
    branches: [main]

jobs:
  validate:
    name: bids-validation
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Deno
        uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x

      - name: Run BIDS validator
        run: |
          deno run -A jsr:@bids/validator . --json > validation.json
          cat validation.json

      - name: Check validation result
        run: |
          if jq -e '.valid == false' validation.json > /dev/null; then
            echo "::error::BIDS validation failed"
            jq '.issues[] | select(.severity == "error")' validation.json
            exit 1
          fi
          echo "BIDS validation passed"
`;

  // Version Check workflow
  const versionCheck = `name: Version Check

on:
  pull_request:
    branches: [main]

jobs:
  check-version:
    name: version-check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Check version bump
        run: |
          # Get version from PR branch
          PR_VERSION=$(jq -r '.Version // "0.0.0"' dataset_description.json)

          # Get version from main branch
          git fetch origin main
          git checkout origin/main -- dataset_description.json 2>/dev/null || echo '{}' > dataset_description.json
          MAIN_VERSION=$(jq -r '.Version // "0.0.0"' dataset_description.json)

          # Restore PR version
          git checkout HEAD -- dataset_description.json

          echo "Main version: $MAIN_VERSION"
          echo "PR version: $PR_VERSION"

          if [ "$PR_VERSION" == "$MAIN_VERSION" ]; then
            echo "::error::Version not bumped. Update 'Version' field in dataset_description.json"
            exit 1
          fi

          echo "Version check passed: $MAIN_VERSION -> $PR_VERSION"
`;

  // PR Merge Handler workflow
  const prMerge = `name: PR Merge Handler

on:
  pull_request:
    types: [closed]
    branches: [main]

jobs:
  create-release:
    name: Create Release
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    outputs:
      version: \${{ steps.version.outputs.version }}
      release_created: \${{ steps.create_release.outputs.created }}
    steps:
      - uses: actions/checkout@v4

      - name: Get version
        id: version
        run: |
          VERSION=$(jq -r '.Version // "1.0.0"' dataset_description.json)
          echo "version=$VERSION" >> $GITHUB_OUTPUT
          echo "Version: $VERSION"

      - name: Check if tag exists
        id: check_tag
        run: |
          if git rev-parse "v\${{ steps.version.outputs.version }}" >/dev/null 2>&1; then
            echo "exists=true" >> $GITHUB_OUTPUT
          else
            echo "exists=false" >> $GITHUB_OUTPUT
          fi

      - name: Create tag and release
        id: create_release
        if: steps.check_tag.outputs.exists == 'false'
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"
          git tag -a "v\${{ steps.version.outputs.version }}" -m "Release v\${{ steps.version.outputs.version }}"
          git push origin "v\${{ steps.version.outputs.version }}"
          gh release create "v\${{ steps.version.outputs.version }}" \\
            --title "v\${{ steps.version.outputs.version }}" \\
            --notes "Release from PR #\${{ github.event.pull_request.number }}

Changes in this release:
\${{ github.event.pull_request.body }}"
          echo "created=true" >> $GITHUB_OUTPUT

  publish-zenodo:
    name: Publish Zenodo DOI
    needs: create-release
    if: needs.create-release.outputs.release_created == 'true'
    runs-on: ubuntu-latest
    steps:
      - name: Publish version DOI
        env:
          NEMAR_WEBHOOK_TOKEN: \${{ secrets.NEMAR_WEBHOOK_TOKEN }}
        run: |
          # Extract dataset ID from repo name (e.g., nm000104)
          DATASET_ID="\${{ github.event.repository.name }}"
          VERSION="\${{ needs.create-release.outputs.version }}"
          RELEASE_URL="https://github.com/\${{ github.repository }}/releases/tag/v$VERSION"

          echo "Publishing DOI for $DATASET_ID version $VERSION"

          # Skip if webhook token not configured
          if [ -z "$NEMAR_WEBHOOK_TOKEN" ]; then
            echo "NEMAR_WEBHOOK_TOKEN not configured, skipping DOI publish"
            exit 0
          fi

          # Call NEMAR API to publish version DOI
          RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST \\
            "https://nemar-api.shirazi-10f.workers.dev/webhooks/publish-version-doi" \\
            -H "Content-Type: application/json" \\
            -H "X-Webhook-Token: $NEMAR_WEBHOOK_TOKEN" \\
            -d "{
              \\"dataset_id\\": \\"$DATASET_ID\\",
              \\"version\\": \\"$VERSION\\",
              \\"release_url\\": \\"$RELEASE_URL\\"
            }")

          HTTP_CODE=$(echo "$RESPONSE" | tail -1)
          BODY=$(echo "$RESPONSE" | head -n -1)

          echo "Response: $BODY"

          if [ "$HTTP_CODE" -ge 400 ]; then
            # Check if it was skipped (no concept DOI)
            if echo "$BODY" | jq -e '.skipped == true' > /dev/null 2>&1; then
              echo "Skipped: No concept DOI exists for this dataset"
              exit 0
            fi
            echo "::error::Failed to publish DOI (HTTP $HTTP_CODE)"
            exit 1
          fi

          # Show DOI info
          DOI=$(echo "$BODY" | jq -r '.version_doi // empty')
          if [ -n "$DOI" ]; then
            echo "Version DOI published: $DOI"
          fi

  cleanup-staging:
    name: Cleanup Staging
    if: github.event.pull_request.merged == false
    runs-on: ubuntu-latest
    steps:
      - name: Cleanup staging on PR close
        env:
          AWS_ACCESS_KEY_ID: \${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
        run: |
          STAGING_PREFIX="staging/pr-\${{ github.event.pull_request.number }}/"
          echo "Cleaning up staging: s3://nemar/$STAGING_PREFIX"
          aws s3 rm --recursive "s3://nemar/$STAGING_PREFIX" 2>/dev/null || true
`;

  // Deploy each workflow
  const workflows = [
    { path: ".github/workflows/bids-validation.yml", content: bidsValidation },
    { path: ".github/workflows/version-check.yml", content: versionCheck },
    { path: ".github/workflows/pr-merge.yml", content: prMerge },
  ];

  for (const workflow of workflows) {
    const success = await createOrUpdateFile(
      repo,
      workflow.path,
      workflow.content,
      `Add ${workflow.path.split("/").pop()} workflow`,
      pat,
    );
    if (!success) {
      errors.push(workflow.path);
    }
  }

  return { success: errors.length === 0, errors };
}
