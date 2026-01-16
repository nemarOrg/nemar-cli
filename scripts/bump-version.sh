#!/bin/bash
# Version bump script for nemar-cli
#
# Usage:
#   ./scripts/bump-version.sh patch    # 0.2.2 -> 0.2.3
#   ./scripts/bump-version.sh minor    # 0.2.2 -> 0.3.0
#   ./scripts/bump-version.sh major    # 0.2.2 -> 1.0.0
#   ./scripts/bump-version.sh 1.0.0    # Set explicit version

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <patch|minor|major|version>"
  echo ""
  echo "Examples:"
  echo "  $0 patch    # Bump patch version"
  echo "  $0 minor    # Bump minor version"
  echo "  $0 major    # Bump major version"
  echo "  $0 1.0.0    # Set explicit version"
  exit 1
fi

VERSION_TYPE=$1

# Get current version
CURRENT_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
echo "Current version: $CURRENT_VERSION"

# Calculate new version
if [[ "$VERSION_TYPE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  # Explicit version provided
  NEW_VERSION=$VERSION_TYPE
elif [ "$VERSION_TYPE" = "patch" ] || [ "$VERSION_TYPE" = "minor" ] || [ "$VERSION_TYPE" = "major" ]; then
  # Use npm to calculate new version
  NEW_VERSION=$(npm version $VERSION_TYPE --no-git-tag-version | sed 's/v//')
  # npm already updated package.json, so we're good
else
  echo "Error: Invalid version type. Use patch, minor, major, or explicit version (e.g., 1.0.0)"
  exit 1
fi

echo "New version: $NEW_VERSION"

# If explicit version, update package.json
if [[ "$VERSION_TYPE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  npm version $NEW_VERSION --no-git-tag-version > /dev/null
fi

# Build to verify everything works
echo "Building..."
bun run build > /dev/null 2>&1

# Verify version is correct in build
BUILD_VERSION=$(./dist/index.js --version 2>/dev/null)
if [ "$BUILD_VERSION" != "$NEW_VERSION" ]; then
  echo "Error: Build version ($BUILD_VERSION) doesn't match expected version ($NEW_VERSION)"
  exit 1
fi

echo "Build verified: version $BUILD_VERSION"

# Stage and commit
git add package.json
git commit -m "chore: bump version to $NEW_VERSION"

echo ""
echo "Version bumped to $NEW_VERSION"
echo ""
echo "Next steps:"
echo "  1. Push: git push"
echo "  2. CI will automatically create a git tag v$NEW_VERSION"
echo "  3. Publish to npm: npm publish --access public --otp=<code>"
