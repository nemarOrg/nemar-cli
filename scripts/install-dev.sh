#!/bin/bash
# Development installation script
# Rebuilds and forcibly updates the global installation

set -e

echo "Building CLI..."
bun run build

echo "Uninstalling old version..."
npm uninstall -g nemar-cli 2>/dev/null || true

echo "Installing new version..."
npm install -g .

echo "Manually updating global file (npm install doesn't update it)..."
GLOBAL_PATH="$HOME/.bun/install/global/node_modules/nemar-cli/dist/index.js"
cp -f dist/index.js "$GLOBAL_PATH"

echo "Verifying installation..."
if [ -f "$GLOBAL_PATH" ]; then
  echo "✓ Installation successful"
  ls -lh "$GLOBAL_PATH"
else
  echo "✗ Installation failed - file not found"
  exit 1
fi
