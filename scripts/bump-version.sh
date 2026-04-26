#!/bin/bash
# Version bump script for nemar-cli
#
# Supports semver with pre-release suffixes (dev, alpha, beta, rc)
#
# Usage:
#   ./scripts/bump-version.sh patch         # 0.2.7-dev -> 0.2.8, 0.2.7 -> 0.2.8
#   ./scripts/bump-version.sh minor         # 0.2.7 -> 0.3.0
#   ./scripts/bump-version.sh major         # 0.2.7 -> 1.0.0
#   ./scripts/bump-version.sh dev           # 0.2.7 -> 0.2.8-dev, 0.2.7-dev -> 0.2.8-dev
#   ./scripts/bump-version.sh alpha         # 0.2.7 -> 0.2.8-alpha
#   ./scripts/bump-version.sh beta          # 0.2.7-alpha -> 0.2.7-beta
#   ./scripts/bump-version.sh rc            # 0.2.7-beta -> 0.2.7-rc
#   ./scripts/bump-version.sh 1.0.0         # Set explicit version
#   ./scripts/bump-version.sh 1.0.0-dev     # Set explicit version with suffix

set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <patch|minor|major|dev|alpha|beta|rc|version>"
  echo ""
  echo "Semver bumps (strips pre-release suffix):"
  echo "  $0 patch    # 0.2.7-dev -> 0.2.8"
  echo "  $0 minor    # 0.2.7 -> 0.3.0"
  echo "  $0 major    # 0.2.7 -> 1.0.0"
  echo ""
  echo "Pre-release bumps (adds/changes suffix, bumps patch if needed):"
  echo "  $0 dev      # 0.2.7 -> 0.2.8-dev, 0.2.7-dev -> 0.2.8-dev"
  echo "  $0 alpha    # 0.2.7 -> 0.2.8-alpha"
  echo "  $0 beta     # 0.2.7-alpha -> 0.2.7-beta (same base if pre-release)"
  echo "  $0 rc       # 0.2.7-beta -> 0.2.7-rc"
  echo ""
  echo "Explicit version:"
  echo "  $0 1.0.0        # Set to 1.0.0"
  echo "  $0 1.0.0-dev    # Set to 1.0.0-dev"
  exit 1
fi

VERSION_TYPE="$1"

# Validate we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Error: Not in a git repository"
  exit 1
fi

# Branch guard: release versions only allowed on dev or main.
# Pre-release bumps (dev/alpha/beta/rc) and explicit pre-release versions
# are allowed on any branch.
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
is_release_on_wrong_branch() {
  [ "$CURRENT_BRANCH" != "dev" ] && [ "$CURRENT_BRANCH" != "main" ]
}
case "$VERSION_TYPE" in
  patch|minor|major)
    if is_release_on_wrong_branch; then
      echo "Error: Release bumps ($VERSION_TYPE) only allowed on dev or main branch."
      echo "Current branch: $CURRENT_BRANCH"
      echo "Use a pre-release bump (dev/alpha/beta/rc) on feature branches."
      exit 1
    fi
    ;;
  dev|alpha|beta|rc)
    ;; # Pre-release keywords allowed on any branch
  *)
    # Explicit versions: block release versions (no pre-release suffix) on feature branches
    if [[ "$VERSION_TYPE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && is_release_on_wrong_branch; then
      echo "Error: Release versions ($VERSION_TYPE) only allowed on dev or main branch."
      echo "Current branch: $CURRENT_BRANCH"
      echo "Use a pre-release version (e.g., ${VERSION_TYPE}-dev) on feature branches."
      exit 1
    fi
    ;;
esac

# Validate package.json exists
if [ ! -f package.json ]; then
  echo "Error: package.json not found. Are you in the project root?"
  exit 1
fi

# Get current version using jq for reliable JSON parsing
CURRENT_VERSION=$(jq -r '.version' package.json)
if [ -z "$CURRENT_VERSION" ] || [ "$CURRENT_VERSION" = "null" ]; then
  echo "Error: Could not extract version from package.json"
  exit 1
fi
echo "Current version: $CURRENT_VERSION"

# Parse current version into components
# Handles: 0.2.7, 0.2.7-dev, 0.2.7-alpha.1, etc.
BASE_VERSION="${CURRENT_VERSION%%-*}"  # Strip everything after first -
PRERELEASE=""
if [[ "$CURRENT_VERSION" == *-* ]]; then
  PRERELEASE="${CURRENT_VERSION#*-}"   # Get everything after first -
fi

IFS='.' read -r MAJOR MINOR PATCH <<< "$BASE_VERSION"

# Calculate new version based on type
calculate_new_version() {
  local type="$1"

  case "$type" in
    patch)
      # Bump patch, strip pre-release
      if [ -n "$PRERELEASE" ]; then
        # If pre-release, just release current base version
        echo "$MAJOR.$MINOR.$PATCH"
      else
        echo "$MAJOR.$MINOR.$((PATCH + 1))"
      fi
      ;;
    minor)
      # Bump minor, reset patch, strip pre-release
      echo "$MAJOR.$((MINOR + 1)).0"
      ;;
    major)
      # Bump major, reset minor/patch, strip pre-release
      echo "$((MAJOR + 1)).0.0"
      ;;
    dev|alpha|beta|rc)
      # Pre-release: bump patch if releasing from stable, keep base if already pre-release
      if [ -n "$PRERELEASE" ]; then
        # Already a pre-release - change suffix, bump patch for dev
        if [ "$type" = "dev" ]; then
          echo "$MAJOR.$MINOR.$((PATCH + 1))-$type"
        else
          # For alpha/beta/rc progression, keep same base version
          echo "$MAJOR.$MINOR.$PATCH-$type"
        fi
      else
        # From stable - bump patch and add suffix
        echo "$MAJOR.$MINOR.$((PATCH + 1))-$type"
      fi
      ;;
    *)
      # Check if it's an explicit version (with or without pre-release)
      if [[ "$type" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
        echo "$type"
      else
        echo ""
      fi
      ;;
  esac
}

NEW_VERSION=$(calculate_new_version "$VERSION_TYPE")

if [ -z "$NEW_VERSION" ]; then
  echo "Error: Invalid version type '$VERSION_TYPE'"
  echo "Use: patch, minor, major, dev, alpha, beta, rc, or explicit version (e.g., 1.0.0 or 1.0.0-dev)"
  exit 1
fi

if [ "$NEW_VERSION" = "$CURRENT_VERSION" ]; then
  echo "Warning: Version unchanged ($NEW_VERSION)"
  exit 0
fi

echo "New version: $NEW_VERSION"

# Update package.json using jq
jq --arg v "$NEW_VERSION" '.version = $v' package.json > package.json.tmp && mv package.json.tmp package.json

# Keep backend/package.json in sync (powers the version reported by /health
# and / on api.nemar.org). CLI and backend ship together; single version.
if [ -f backend/package.json ]; then
  jq --arg v "$NEW_VERSION" '.version = $v' backend/package.json > backend/package.json.tmp \
    && mv backend/package.json.tmp backend/package.json
fi

# Restore both files to their pre-bump version (called from each failure path
# so an aborted bump never leaves the working tree half-modified).
restore_versions() {
  jq --arg v "$CURRENT_VERSION" '.version = $v' package.json > package.json.tmp \
    && mv package.json.tmp package.json
  if [ -f backend/package.json ]; then
    jq --arg v "$CURRENT_VERSION" '.version = $v' backend/package.json > backend/package.json.tmp \
      && mv backend/package.json.tmp backend/package.json
  fi
}

# Build to verify everything works
echo "Building..."
if ! bun run build > /dev/null 2>&1; then
  echo "Error: Build failed"
  restore_versions
  exit 1
fi

# Ensure built file is executable
chmod +x dist/index.js

# Verify version is correct in build
if ! BUILD_VERSION=$(./dist/index.js --version 2>&1); then
  echo "Error: Failed to run built CLI"
  restore_versions
  exit 1
fi

if [ "$BUILD_VERSION" != "$NEW_VERSION" ]; then
  echo "Error: Build version ($BUILD_VERSION) doesn't match expected ($NEW_VERSION)"
  restore_versions
  exit 1
fi

# Sanity check: root package.json is the runtime source of truth (backend
# imports it via ../../package.json). backend/package.json is kept synced for
# tooling. If they drift, bail with a loud error rather than shipping a
# package whose two manifests disagree.
if [ -f backend/package.json ]; then
  BACKEND_VERSION=$(jq -r '.version' backend/package.json)
  if [ "$BACKEND_VERSION" != "$NEW_VERSION" ]; then
    echo "Error: backend/package.json version ($BACKEND_VERSION) does not match root ($NEW_VERSION)"
    restore_versions
    exit 1
  fi
fi

echo "Build verified: $BUILD_VERSION"

# Stage and commit
git add package.json
if [ -f backend/package.json ]; then
  git add backend/package.json
fi
if ! git diff --cached --quiet; then
  git commit -m "chore: bump version to $NEW_VERSION"
else
  echo "Warning: package.json unchanged, skipping commit"
  exit 0
fi

echo ""
echo "Version bumped to $NEW_VERSION"
echo ""
echo "Next steps:"
echo "  1. Push to trigger CI: git push"
echo "  2. Merge to main - CI will auto-tag and publish to npm"
echo ""
echo "Or publish manually:"
if [[ "$NEW_VERSION" == *-* ]]; then
  echo "  npm publish --tag dev --otp=<code>"
else
  echo "  npm publish --otp=<code>"
fi
