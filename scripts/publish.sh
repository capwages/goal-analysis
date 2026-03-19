#!/usr/bin/env bash
set -euo pipefail

REPO="capwages/goal-analysis"
ASSET="goal-replay-archive.tar.gz"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$PROJECT_ROOT/data"
ARCHIVE_DIR="$DATA_DIR/goal-replay-archive"

if [ ! -d "$ARCHIVE_DIR" ] || [ -z "$(ls -A "$ARCHIVE_DIR" 2>/dev/null)" ]; then
  echo "No archive to publish at $ARCHIVE_DIR"
  exit 1
fi

GAME_COUNT=$(ls -1d "$ARCHIVE_DIR"/[0-9]* 2>/dev/null | wc -l | tr -d ' ')
TAG="v1.0.0-$(date +%Y%m%d%H%M%S)"

echo "Compressing $GAME_COUNT games..."
tar -czf "$DATA_DIR/$ASSET" -C "$DATA_DIR" goal-replay-archive

SIZE=$(ls -lh "$DATA_DIR/$ASSET" | awk '{print $5}')
echo "Archive: $SIZE"

echo "Creating release $TAG..."
gh release create "$TAG" \
  --repo "$REPO" \
  --title "$TAG" \
  --notes "$GAME_COUNT games" \
  "$DATA_DIR/$ASSET"

rm -f "$DATA_DIR/$ASSET"
echo "Done. Release $TAG published."
