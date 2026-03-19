#!/usr/bin/env bash
set -euo pipefail

REPO="capwages/goal-analysis"
ASSET="goal-replay-archive.tar.gz"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$PROJECT_ROOT/data"
ARCHIVE_DIR="$DATA_DIR/goal-replay-archive"

if [ -d "$ARCHIVE_DIR" ] && [ "$(ls -A "$ARCHIVE_DIR" 2>/dev/null)" ]; then
  exit 0
fi

mkdir -p "$DATA_DIR"

TAG=$(gh release list --repo "$REPO" --limit 1 --json tagName --jq '.[0].tagName')
if [ -z "$TAG" ]; then
  echo "No releases found for $REPO."
  exit 1
fi

echo "Downloading $ASSET from release $TAG..."
gh release download "$TAG" --repo "$REPO" --pattern "$ASSET" --dir "$DATA_DIR"

echo "Extracting..."
tar -xzf "$DATA_DIR/$ASSET" -C "$DATA_DIR"
rm -f "$DATA_DIR/$ASSET"
echo "Done."
