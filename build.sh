#!/bin/bash
# build.sh — Build SDK i commituj dist/

set -e

echo "🔨 Building lunor-sdk..."
npm run build

echo "📦 Staging dist/..."
git add dist/

# Sprawdź czy są zmiany
if git diff --cached --quiet; then
  echo "✅ No changes in dist/"
else
  VERSION=$(node -p "require('./package.json').version")
  git commit -m "build: v${VERSION}"
  git tag "v${VERSION}"
  echo "✅ Committed and tagged v${VERSION}"
  echo "Run: git push && git push --tags"
fi