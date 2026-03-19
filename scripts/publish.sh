#!/usr/bin/env bash
set -euo pipefail

REPO="capwages/goal-analysis"
REPLAY_ASSET="goal-replay-archive.tar.gz"
CLASSIFICATION_ASSET="goal-classification-by-team.tar.gz"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$PROJECT_ROOT/data"
ARCHIVE_DIR="$DATA_DIR/goal-replay-archive"
CLASSIFICATION_DIR="$DATA_DIR/goal-classification-by-team"

if [ ! -d "$ARCHIVE_DIR" ] || [ -z "$(ls -A "$ARCHIVE_DIR" 2>/dev/null)" ]; then
  echo "No archive to publish at $ARCHIVE_DIR"
  exit 1
fi

GAME_COUNT=$(ls -1d "$ARCHIVE_DIR"/[0-9]* 2>/dev/null | wc -l | tr -d ' ')
TAG="v1.0.0-$(date +%Y%m%d%H%M%S)"

echo "Compressing $GAME_COUNT games..."
COPYFILE_DISABLE=1 tar -czf "$DATA_DIR/$REPLAY_ASSET" -C "$DATA_DIR" goal-replay-archive

echo "Compressing classifications..."
COPYFILE_DISABLE=1 tar -czf "$DATA_DIR/$CLASSIFICATION_ASSET" -C "$DATA_DIR" --exclude='unknown-goal-*' goal-classification-by-team

echo "Creating release $TAG..."
gh release create "$TAG" \
  --repo "$REPO" \
  --title "$TAG" \
  --notes "$GAME_COUNT games" \
  "$DATA_DIR/$REPLAY_ASSET" \
  "$DATA_DIR/$CLASSIFICATION_ASSET"

rm -f "$DATA_DIR/$REPLAY_ASSET" "$DATA_DIR/$CLASSIFICATION_ASSET"
echo "Done. Release $TAG published."
