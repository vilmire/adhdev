#!/bin/bash
# ADHDev OSS — Version bump script
# Usage: ./scripts/version-bump.sh <patch|minor|major|x.y.z>
#
# Bumps all OSS package.json files, commits, tags, and pushes.
# Cloud repo pulls this via submodule update.

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <patch|minor|major|x.y.z>"
    echo "  patch  → 0.6.67 → 0.6.68"
    echo "  minor  → 0.6.67 → 0.7.0"
    echo "  major  → 0.6.67 → 1.0.0"
    echo "  x.y.z  → set exact version"
    exit 1
fi

# Get current version
CURRENT=$(node -p "require('./package.json').version")
echo "📦 Current version: $CURRENT"

# Build verification
echo "⏳ Running build verification..."
if ! npm run build; then
    echo "❌ Build failed! Fix errors before bumping."
    exit 1
fi
echo "✅ Build passed!"

# Calculate new version
if [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    NEW_VERSION="$1"
else
    NEW_VERSION=$(npx -y semver "$CURRENT" -i "$1")
fi

echo "🚀 Bumping to: $NEW_VERSION"

# All OSS package.json files
PACKAGES=(
    "package.json"
    "packages/daemon-core/package.json"
    "packages/daemon-standalone/package.json"
    "packages/web-core/package.json"
    "packages/web-standalone/package.json"
    "packages/web-devconsole/package.json"
)

for pkg in "${PACKAGES[@]}"; do
    if [ -f "$pkg" ]; then
        node -e "
            const fs = require('fs');
            const content = fs.readFileSync('$pkg', 'utf-8');
            const updated = content.replace(/\"version\": \"[^\"]+\"/, '\"version\": \"$NEW_VERSION\"');
            fs.writeFileSync('$pkg', updated);
        "
        echo "  ✅ $pkg → $NEW_VERSION"
    fi
done

# Git commit, tag, push
echo ""
echo "📝 Committing and tagging..."
git add -A
git commit -m "chore: bump version to v$NEW_VERSION"
git tag "v$NEW_VERSION"
git push origin main --tags

echo ""
echo "✅ OSS v$NEW_VERSION released!"
echo "   → CI will publish daemon-core + daemon-standalone to npm"
echo ""
echo "Next: update cloud repo"
echo "  cd .. && ./scripts/version-bump.sh $NEW_VERSION"
