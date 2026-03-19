#!/usr/bin/env bash
set -euo pipefail

REPO="OWNER/goal-analysis"  # TODO: update with actual GitHub owner/repo
TAG="v1.0.0"
ASSET="goal-replay-archive.tar.gz"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$PROJECT_ROOT/data"
ARCHIVE_DIR="$DATA_DIR/goal-replay-archive"

if [ -d "$ARCHIVE_DIR" ] && [ "$(ls -A "$ARCHIVE_DIR" 2>/dev/null)" ]; then
  echo "goal-replay-archive already exists at $ARCHIVE_DIR — skipping download."
  exit 0
fi

mkdir -p "$DATA_DIR"

echo "Downloading $ASSET from GitHub release $TAG..."
gh release download "$TAG" --repo "$REPO" --pattern "$ASSET" --dir "$DATA_DIR"

echo "Extracting to $ARCHIVE_DIR..."
mkdir -p "$ARCHIVE_DIR"
tar -xzf "$DATA_DIR/$ASSET" -C "$DATA_DIR"

rm -f "$DATA_DIR/$ASSET"
echo "Done. Archive extracted to $ARCHIVE_DIR"
