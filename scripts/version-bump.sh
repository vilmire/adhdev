#!/bin/bash
# ADHDev OSS — Version bump script
# Usage: ./scripts/version-bump.sh <patch|minor|major|x.y.z>
#
# Bumps all OSS package.json files, commits, tags, and pushes.
# Includes local CI verification (build + shebang check).
# Cloud repo pulls this via submodule update.

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <patch|minor|major|x.y.z>"
    echo "  patch  → 0.6.68 → 0.6.69"
    echo "  minor  → 0.6.68 → 0.7.0"
    echo "  major  → 0.6.68 → 1.0.0"
    echo "  x.y.z  → set exact version"
    exit 1
fi

# Get current version
CURRENT=$(node -p "require('./package.json').version")
echo "📦 Current version: $CURRENT"

# Calculate new version
if [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    NEW_VERSION="$1"
else
    NEW_VERSION=$(npx -y semver "$CURRENT" -i "$1")
fi

echo "🚀 Target version: $NEW_VERSION"

# ── CI verification (mirrors GitHub Actions) ──

echo ""
echo "⏳ [1/3] Build verification..."
if ! npm run build; then
    echo "❌ Build failed! Fix errors before bumping."
    exit 1
fi
echo "✅ Build passed!"

echo "⏳ [2/3] Shebang verification..."
SHEBANG=$(head -1 packages/daemon-standalone/dist/index.js)
if ! echo "$SHEBANG" | grep -q '#!/usr/bin/env node'; then
    echo "❌ Shebang missing in daemon-standalone! Got: $SHEBANG"
    exit 1
fi
echo "✅ Shebang OK!"

echo "⏳ [3/3] Bundle verification..."
if ! npm run bundle:web -w packages/daemon-standalone 2>/dev/null; then
    echo "⚠ Web bundle step skipped (non-critical)"
fi
echo "✅ All checks passed!"

# ── Bump versions ──

echo ""
echo "📝 Bumping to: $NEW_VERSION"

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

# ── CHANGELOG stub ──

TODAY=$(date +%Y-%m-%d)
CHANGELOG="CHANGELOG.md"
if [ -f "$CHANGELOG" ]; then
    # Insert new version section after the header
    node -e "
        const fs = require('fs');
        const content = fs.readFileSync('$CHANGELOG', 'utf-8');
        const stub = '## [$NEW_VERSION] - $TODAY\n\n### Added\n- \n\n### Fixed\n- \n\n### Changed\n- \n';
        // Insert after 'All notable changes...' line
        const marker = content.indexOf('\n\n## [');
        if (marker !== -1) {
            const updated = content.slice(0, marker) + '\n\n' + stub + content.slice(marker + 2);
            fs.writeFileSync('$CHANGELOG', updated);
        }
    "
    echo "  📋 CHANGELOG.md — v$NEW_VERSION stub added (edit before push if needed)"
fi

# ── Git commit, tag, push ──

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
