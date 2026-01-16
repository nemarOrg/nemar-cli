#!/bin/bash
# Version bump script for nemar-cli
#
# Usage:
#   ./scripts/bump-version.sh patch    # 0.2.2 -> 0.2.3
#   ./scripts/bump-version.sh minor    # 0.2.2 -> 0.3.0
#   ./scripts/bump-version.sh major    # 0.2.2 -> 1.0.0
#   ./scripts/bump-version.sh 1.0.0    # Set explicit version

set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <patch|minor|major|version>"
  echo ""
  echo "Examples:"
  echo "  $0 patch    # Bump patch version"
  echo "  $0 minor    # Bump minor version"
  echo "  $0 major    # Bump major version"
  echo "  $0 1.0.0    # Set explicit version"
  exit 1
fi

VERSION_TYPE="$1"

# Validate we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Error: Not in a git repository"
  exit 1
fi

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

# Calculate new version
if [[ "$VERSION_TYPE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  # Explicit version provided
  NEW_VERSION="$VERSION_TYPE"
elif [ "$VERSION_TYPE" = "patch" ] || [ "$VERSION_TYPE" = "minor" ] || [ "$VERSION_TYPE" = "major" ]; then
  # Parse current version and calculate new one
  IFS='.' read -r major minor patch <<< "$CURRENT_VERSION"
  case "$VERSION_TYPE" in
    patch) NEW_VERSION="$major.$minor.$((patch + 1))" ;;
    minor) NEW_VERSION="$major.$((minor + 1)).0" ;;
    major) NEW_VERSION="$((major + 1)).0.0" ;;
  esac
else
  echo "Error: Invalid version type. Use patch, minor, major, or explicit version (e.g., 1.0.0)"
  exit 1
fi

echo "New version: $NEW_VERSION"

# Update package.json using jq
jq --arg v "$NEW_VERSION" '.version = $v' package.json > package.json.tmp && mv package.json.tmp package.json

# Build to verify everything works (show errors if build fails)
echo "Building..."
if ! bun run build > /dev/null; then
  echo "Error: Build failed. See errors above."
  exit 1
fi

# Verify version is correct in build (show errors if CLI fails to run)
if ! BUILD_VERSION=$(./dist/index.js --version 2>&1); then
  echo "Error: Failed to run built CLI. Output:"
  echo "$BUILD_VERSION"
  exit 1
fi

if [ "$BUILD_VERSION" != "$NEW_VERSION" ]; then
  echo "Error: Build version ($BUILD_VERSION) doesn't match expected version ($NEW_VERSION)"
  exit 1
fi

echo "Build verified: version $BUILD_VERSION"

# Check for other staged changes
if ! git diff --cached --quiet -- ':!package.json' 2>/dev/null; then
  echo "Warning: Other files are staged. Only package.json will be committed."
fi

# Stage and commit
git add package.json
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
echo "  1. Push: git push"
echo "  2. CI will automatically create a git tag v$NEW_VERSION"
echo "  3. Publish to npm: npm publish --access public --otp=<code>"
