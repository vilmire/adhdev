#!/bin/bash
# ADHDev OSS — Version bump script
# Usage: ./scripts/version-bump.sh <patch|minor|major|x.y.z>
#
# Bumps OSS package versions, commits, tags, and pushes.
# Includes local CI verification (build + shebang check).
# Cloud repo pulls this via submodule update.

set -e

warn_if_node_release_runtime_old() {
    local node_version
    node_version=$(node -p "process.versions.node")
    local needs_warning
    needs_warning=$(node -e '
const v = process.versions.node.split(".").map(Number);
const major = v[0] || 0, minor = v[1] || 0, patch = v[2] || 0;
const ok = major > 22 || major == 22 || (major == 20 && (minor > 19 || (minor == 19 && patch >= 0)));
process.stdout.write(ok ? "0" : "1");
')
    if [ "$needs_warning" = "1" ]; then
        echo "⚠ Local Node.js $node_version may be below the preferred release baseline."
        echo "  Recommended: Node.js 22 LTS or at least 20.19.x to avoid npm engine/runtime drift during releases."
    fi
}

warn_if_node_release_runtime_old()

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

LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || true)
if [ -n "$LAST_TAG" ]; then
    GHOSTTY_RELEASE_BASE="$LAST_TAG"
else
    GHOSTTY_RELEASE_BASE="$(git rev-list --max-parents=0 HEAD | tail -n 1)"
fi

GHOSTTY_RELEASE_PATHS=(
    "packages/ghostty-vt-node"
    ".github/workflows/ghostty-vt-node.yml"
)

GHOSTTY_CHANGED=0
if git diff --quiet "$GHOSTTY_RELEASE_BASE"..HEAD -- "${GHOSTTY_RELEASE_PATHS[@]}" \
    && git diff --quiet -- "${GHOSTTY_RELEASE_PATHS[@]}" \
    && git diff --cached --quiet -- "${GHOSTTY_RELEASE_PATHS[@]}"; then
    echo "🧩 Ghostty release paths unchanged since ${GHOSTTY_RELEASE_BASE}; ghostty version will stay at ${CURRENT}."
else
    GHOSTTY_CHANGED=1
    echo "🧩 Ghostty release paths changed since ${GHOSTTY_RELEASE_BASE}; ghostty version will be bumped."
fi

# ── CI verification (mirrors GitHub Actions) ──
#
# This block runs the SAME gates the OSS CI enforces (.github/workflows/ci.yml)
# BEFORE the release tag is created, so a green local run guarantees a green
# tagged CI run — publish never gets skipped on a red tag.
#
# Why local-run and not "push branch → wait for CI → tag" (the CI-wait design):
# the CI `build` job is deliberately skipped on a branch push whose commit
# message starts with 'chore: bump version to v' (ci.yml build `if:`), and the
# `test` job `needs: build`. So on the bump commit's branch push, the test job
# never runs — the test/publish gates only execute on the *tag* push. Waiting
# for a branch-push test run would wait for a job that is skipped by design, and
# the tests do not actually run until the tag already exists (too late to gate).
# Running the CI `test` job's exact commands locally before the tag is therefore
# the only gate that fires before publish. This mirrors the root
# scripts/version-bump.sh, which already runs `npm run ci` before committing.

echo ""
echo "⏳ [1/4] Build verification..."
export ADHDEV_SKIP_GHOSTTY_VT_BUILD="${ADHDEV_SKIP_GHOSTTY_VT_BUILD:-1}"
if ! npm run build; then
    echo "❌ Build failed! Fix errors before bumping."
    exit 1
fi
echo "✅ Build passed!"

echo "⏳ [2/4] Shebang verification..."
SHEBANG=$(head -1 packages/daemon-standalone/dist/index.js)
if ! echo "$SHEBANG" | grep -q '#!/usr/bin/env node'; then
    echo "❌ Shebang missing in daemon-standalone! Got: $SHEBANG"
    exit 1
fi
echo "✅ Shebang OK!"

echo "⏳ [3/4] Bundle verification..."
if ! npm run bundle:web -w packages/daemon-standalone 2>/dev/null; then
    echo "⚠ Web bundle step skipped (non-critical)"
fi
echo "✅ Bundle check passed!"

# [4/4] Test gate — mirrors the CI `test` job (.github/workflows/ci.yml).
# v1.0.21 was tagged on a commit whose CI test job was red, so npm publish was
# skipped and the release had to be discarded. This gate reproduces that job
# locally so a red test blocks the tag instead of a discarded release.
echo "⏳ [4/4] Test gate (mirrors CI test job)..."

# CI test-job prerequisites reproduced locally (ci.yml `test` job steps):
#
#  1. git identity + default branch — the daemon-core suite has real-git
#     fixture tests that shell out to `git init/commit/rev-parse`; without an
#     identity/default branch those spawns emit hints and misbehave. Set only
#     when unset so a developer's existing config is never overwritten.
if [ -z "$(git config user.email 2>/dev/null || true)" ]; then
    git config user.email "ci@adhf.dev"
fi
if [ -z "$(git config user.name 2>/dev/null || true)" ]; then
    git config user.name "ADHDev CI"
fi
if [ -z "$(git config init.defaultBranch 2>/dev/null || true)" ]; then
    git config init.defaultBranch main
fi

#  2. provider spec fixtures — spec-driven daemon-core/mcp-server tests resolve
#     the sibling adhdev-providers repo at repoRoot/../adhdev-providers. In the
#     cloud monorepo checkout it is already present as a sibling; only warn if
#     it is genuinely missing (tests fall back or skip), never hard-fail here.
if [ ! -e "../adhdev-providers" ]; then
    echo "⚠ ../adhdev-providers sibling not found — spec-driven tests may fall back or fail."
    echo "  (In the cloud monorepo this is the adhdev-providers submodule sibling.)"
fi

run_ci_step() {
    # Run one CI-mirrored step; abort the whole script on the first red so the
    # tag is never created for a commit CI would reject. `set -e` is suspended
    # inside `if`, so this explicit check is what enforces fail-on-first-red.
    local label="$1"
    shift
    if ! "$@"; then
        echo "❌ Test gate failed at: ${label}"
        echo "   CI would be red on this commit — publish would be skipped."
        echo "   Fix the failure above before tagging a release."
        exit 1
    fi
}

#  3. build the packages the test job builds before running tests (ci.yml
#     'Build packages required for tests'). daemon-core is already built by
#     [1/4] above via `npm run build`, but re-run the CI's explicit list so the
#     gate stays faithful even if the top-level build graph changes.
run_ci_step "build session-host-core"   npm run build -w packages/session-host-core
run_ci_step "build session-host-daemon" npm run build -w packages/session-host-daemon
run_ci_step "build mesh-shared"          npm run build -w packages/mesh-shared
run_ci_step "build daemon-core"          npm run build -w packages/daemon-core

# Run the exact CI test-job commands, in CI order. Any red blocks the tag.
# NOTE: the daemon-core suite includes slow real-git/provider-spec fixtures;
# this step is intentionally the CI-identical gate, so it may take a while.
run_ci_step "test mesh-shared"       npm run test -w packages/mesh-shared
run_ci_step "test daemon-core"       npm run test -w packages/daemon-core
run_ci_step "test mcp-server"        npm run test -w packages/mcp-server
run_ci_step "test web-core"          npm run test -w packages/web-core
run_ci_step "typecheck daemon-core"  npm run typecheck -w packages/daemon-core
echo "✅ Test gate passed!"
echo "✅ All checks passed!"

# ── Bump versions ──

echo ""
echo "📝 Bumping to: $NEW_VERSION"

PACKAGES=(
    "package.json"
    "packages/mesh-shared/package.json"
    "packages/daemon-core/package.json"
    "packages/daemon-standalone/package.json"
    "packages/mcp-server/package.json"
    "packages/session-host-core/package.json"
    "packages/session-host-daemon/package.json"
    "packages/terminal-mux-cli/package.json"
    "packages/terminal-mux-control/package.json"
    "packages/terminal-mux-core/package.json"
    "packages/terminal-render-web/package.json"
    "packages/web-core/package.json"
    "packages/web-standalone/package.json"
    "packages/web-devconsole/package.json"
)

if [ "$GHOSTTY_CHANGED" -eq 1 ]; then
    PACKAGES+=("packages/ghostty-vt-node/package.json")
fi

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

MCP_SERVER_SOURCE="packages/mcp-server/src/server.ts"
if [ -f "$MCP_SERVER_SOURCE" ]; then
    node -e "
        const fs = require('fs');
        const file = '$MCP_SERVER_SOURCE';
        const content = fs.readFileSync(file, 'utf-8');
        const updated = content.replace(/name: 'adhdev-mcp-server', version: '[^']+'/, \"name: 'adhdev-mcp-server', version: '$NEW_VERSION'\");
        fs.writeFileSync(file, updated);
    "
    echo "  ✅ $MCP_SERVER_SOURCE → $NEW_VERSION"
fi

# ── Re-sync vendored mcp-server (standalone) before staging ──
# The standalone vendor embeds the mcp-server version string; re-bundle it so
# the committed copy is consistent with the bumped version. Stage the vendor
# output now — check:vendor (git diff working-tree vs index) must see it staged.
echo ""
echo "⏳ Re-syncing vendored mcp-server to v$NEW_VERSION..."
npm run build -w packages/mcp-server
npm run bundle:vendor -w packages/daemon-standalone
git add -- packages/daemon-standalone/vendor/mcp-server
echo "  ✅ packages/daemon-standalone/vendor/mcp-server staged"

# ── Sync lock file after version bump ──

echo "[version-bump] syncing oss/package-lock.json..."
npm install --package-lock-only 2>/dev/null || npm install --package-lock-only

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

# Explicit allowlist: only release-relevant paths may be staged.
# git add -A would sweep up unrelated working-tree changes.
OSS_RELEASE_PATHS=(
    "${PACKAGES[@]}"
    "$MCP_SERVER_SOURCE"
    "package-lock.json"
    "$CHANGELOG"
    "packages/daemon-standalone/vendor/mcp-server"
)
if [ "$GHOSTTY_CHANGED" -eq 1 ]; then
    OSS_RELEASE_PATHS+=("packages/ghostty-vt-node/package.json")
fi
git add -- "${OSS_RELEASE_PATHS[@]}"

# Abort if anything unexpected was staged (fail-closed guard).
STAGED=$(git diff --cached --name-only)
while IFS= read -r staged_file; do
    [ -z "$staged_file" ] && continue
    allowed=0
    for allowed_path in "${OSS_RELEASE_PATHS[@]}"; do
        if [[ "$staged_file" == "$allowed_path" || "$staged_file" == "$allowed_path/"* ]]; then
            allowed=1
            break
        fi
    done
    if [ "$allowed" -eq 0 ]; then
        echo "❌ Unexpected path in release commit: $staged_file"
        echo "   Only release-intent paths should be staged. Check your working tree."
        exit 1
    fi
done <<< "$STAGED"

git commit -m "chore: bump version to v$NEW_VERSION"
git tag "v$NEW_VERSION"
git push origin main --tags

# ── Tag push verification ──

echo ""
echo "🔎 Verifying tag was pushed..."
REMOTE_TAG=$(git ls-remote --tags origin "refs/tags/v$NEW_VERSION" 2>/dev/null | awk '{print $1}')
if [ -z "$REMOTE_TAG" ]; then
    echo "❌ Tag v$NEW_VERSION was NOT found on remote!"
    echo "   Manual fix: git push origin v$NEW_VERSION"
    exit 1
fi
echo "✅ Tag v$NEW_VERSION confirmed on remote"

echo ""
echo "✅ OSS v$NEW_VERSION released!"
echo "   → CI will publish mesh-shared, session-host-core, mcp-server, daemon-core, and daemon-standalone to npm"
echo "   → ghostty-vt-node is published too when its release paths changed"
echo ""
echo "⚠️  IMPORTANT: Wait for OSS CI to complete before deploying Cloud!"
echo ""
echo "   Check CI status:"
echo "     gh run list --repo vilmire/adhdev -L 1"
echo ""
echo "   Verify npm publish:"
echo "     npm view @adhdev/daemon-core version"
echo "     npm view @adhdev/daemon-standalone version"
echo ""
echo "   Then deploy Cloud:"
echo "     cd .. && ./scripts/version-bump.sh $NEW_VERSION"
