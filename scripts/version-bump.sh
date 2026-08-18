#!/bin/bash
# ADHDev OSS — Version bump script
# Usage: ./scripts/version-bump.sh <patch|minor|major|x.y.z>
#
# Bumps OSS package versions, commits, tags, and pushes.
# Includes local CI verification (build + shebang check).
# Cloud repo pulls this via submodule update.

set -e

# BEGIN release CI watch helpers
run_gh_watch_with_timeout() {
    local run_id="$1"
    local repo="$2"
    local timeout_seconds="$3"
    local poll_seconds="${RELEASE_CI_WATCH_POLL_SECONDS:-2}"
    local watch_pid
    local started_at
    local now

    gh run watch "$run_id" --repo "$repo" --exit-status &
    watch_pid=$!
    started_at=$(date +%s)

    while kill -0 "$watch_pid" 2>/dev/null; do
        now=$(date +%s)
        if [ $((now - started_at)) -ge "$timeout_seconds" ]; then
            kill "$watch_pid" 2>/dev/null || true
            wait "$watch_pid" 2>/dev/null || true
            return 124
        fi
        sleep "$poll_seconds"
    done

    wait "$watch_pid"
}

watch_release_ci() {
    local release_tag="$1"
    local release_sha="$2"
    local repo="${RELEASE_CI_REPO:-vilmire/adhdev}"
    local workflow="${RELEASE_CI_WORKFLOW:-CI}"
    local lookup_attempts="${RELEASE_CI_LOOKUP_ATTEMPTS:-10}"
    local lookup_delay="${RELEASE_CI_LOOKUP_DELAY_SECONDS:-3}"
    local watch_timeout="${RELEASE_CI_WATCH_TIMEOUT_SECONDS:-1800}"
    local attempt=1
    local run_ids=""
    local run_id=""
    local watch_status
    local run_state
    local run_status
    local conclusion
    local failed_jobs
    local failed_steps
    local publish_conclusion

    if ! command -v gh >/dev/null 2>&1; then
        echo "⚠️  GitHub CLI (gh) is unavailable; skipping CI watch."
        echo "   Verify manually: gh run list --repo $repo --workflow $workflow"
        return 0
    fi

    if ! gh auth status >/dev/null 2>&1; then
        echo "⚠️  GitHub CLI is not authenticated; skipping CI watch."
        echo "   Authenticate with 'gh auth login', then verify the $release_tag run manually."
        return 0
    fi

    echo ""
    echo "🔎 Finding CI run for $release_tag at $release_sha..."
    while [ "$attempt" -le "$lookup_attempts" ]; do
        if run_ids=$(gh run list \
            --repo "$repo" \
            --workflow "$workflow" \
            --event push \
            --branch "$release_tag" \
            --limit 20 \
            --json databaseId,displayTitle,event,headBranch,headSha \
            --jq ".[] | select(.event == \"push\" and .headBranch == \"$release_tag\" and .headSha == \"$release_sha\") | .databaseId" \
            2>/dev/null); then
            run_id=$(printf '%s\n' "$run_ids" | head -n 1)
        fi

        if [[ "$run_id" =~ ^[0-9]+$ ]]; then
            break
        fi

        if [ "$attempt" -lt "$lookup_attempts" ]; then
            echo "   Run not visible yet (attempt $attempt/$lookup_attempts); retrying in ${lookup_delay}s..."
            sleep "$lookup_delay"
        fi
        attempt=$((attempt + 1))
    done

    if ! [[ "$run_id" =~ ^[0-9]+$ ]]; then
        echo "⚠️  No matching CI run appeared for tag $release_tag and commit $release_sha."
        echo "   Skipping CI watch; verify manually: gh run list --repo $repo --workflow $workflow"
        return 0
    fi

    echo "⏳ Watching CI run $run_id (timeout: ${watch_timeout}s)..."
    if run_gh_watch_with_timeout "$run_id" "$repo" "$watch_timeout"; then
        echo "✅ CI run $run_id is green; npm publish completed."
        return 0
    else
        watch_status=$?
    fi

    if [ "$watch_status" -eq 124 ]; then
        echo "⚠️  CI watch timed out after ${watch_timeout}s for run $run_id."
        echo "   The release remains pushed; verify manually: gh run view $run_id --repo $repo"
        return 0
    fi

    if ! run_state=$(gh run view "$run_id" --repo "$repo" --json status,conclusion \
        --jq '[.status, .conclusion] | @tsv' 2>/dev/null); then
        echo "⚠️  CI watch ended but the run conclusion could not be read."
        echo "   Verify manually: gh run view $run_id --repo $repo"
        return 0
    fi
    IFS=$'\t' read -r run_status conclusion <<< "$run_state"

    if [ "$conclusion" = "success" ]; then
        echo "✅ CI run $run_id is green; npm publish completed."
        return 0
    fi

    if [ "$run_status" != "completed" ] || [ -z "$conclusion" ] || [ "$conclusion" = "null" ]; then
        echo "⚠️  CI watch stopped before run $run_id reached a conclusion."
        echo "   The release remains pushed; verify manually: gh run view $run_id --repo $repo"
        return 0
    fi

    failed_jobs=$(gh run view "$run_id" --repo "$repo" --json jobs \
        --jq '.jobs[] | select(.conclusion == "failure") | .name' 2>/dev/null || true)
    failed_steps=$(gh run view "$run_id" --repo "$repo" --json jobs \
        --jq '.jobs[] | . as $job | .steps[] | select(.conclusion == "failure") | "\($job.name): \(.name)"' 2>/dev/null || true)
    publish_conclusion=$(gh run view "$run_id" --repo "$repo" --json jobs \
        --jq '.jobs[] | select(.name == "publish") | .conclusion' 2>/dev/null || true)

    echo ""
    echo "❌ CI run $run_id is red (conclusion: ${conclusion:-unknown})."
    if [ -n "$failed_jobs" ]; then
        echo "   Failed job(s):"
        while IFS= read -r failed_job; do
            [ -n "$failed_job" ] && echo "     • $failed_job"
        done <<< "$failed_jobs"
    fi
    if [ -n "$failed_steps" ]; then
        echo "   Failed step(s):"
        while IFS= read -r failed_step; do
            [ -n "$failed_step" ] && echo "     • $failed_step"
        done <<< "$failed_steps"
    fi

    if [ "$publish_conclusion" = "skipped" ]; then
        echo "❌ The publish job was skipped — this tag run published zero npm packages."
    elif [ "$publish_conclusion" = "failure" ]; then
        echo "❌ The publish job failed — npm publishing did not complete; check for partial publishes."
    else
        echo "❌ The publish job did not complete successfully (conclusion: ${publish_conclusion:-not found})."
        echo "   Do not assume npm packages were published."
    fi
    echo "   Inspect the failure: gh run view $run_id --repo $repo --log-failed"
    return 1
}
# END release CI watch helpers

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

# NOTE: packages/mcp-server/src/server.ts used to have its MCP serverInfo version
# rewritten here. That is deliberately gone. The version is now a fixed constant
# (MCP_SERVER_VERSION = '0.0.0-vendored') because the built mcp-server is vendored
# into committed bundles that a drift gate compares against HEAD — a per-release
# version string there made every bump rewrite the vendor bundles, which the bump
# script cannot commit before `npm run ci` runs the gate. That deadlock blocked
# the 1.0.42 release twice. Do not reintroduce a rewrite here; it would overwrite
# the constant and bring the deadlock back. (The old regex also only ever matched
# the first of the two call sites, leaving the second stale at 0.9.66 for ~50
# releases — further evidence the value is unused.)

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

# ── Push: branch FIRST, then the tag ──
#
# DETACHED-HEAD RELEASE PUSH. This repo is normally consumed as the `oss/`
# submodule of the private root repo, and a submodule is checked out at a
# DETACHED HEAD. In that state the local `main` ref does not move with the bump
# commit, so the historical `git push origin main --tags` pushed a stale `main`
# and was rejected non-fast-forward -- while `--tags` had already succeeded.
# That left the tag on the remote pointing at a commit absent from origin/main,
# and GitHub Actions starts CI/publish from the TAG, so a release could publish
# from a commit no branch contained. Push HEAD explicitly instead.
#
# Order matters: branch first, tag second. The tag is the CI/publish trigger, so
# it must be the LAST thing that lands. If the branch push fails we abort before
# creating the remote tag, and the failure is inert -- a local commit + local tag,
# both re-runnable. The old combined `main --tags` could not offer that because a
# single command cannot order its two ref updates.
if BRANCH_REF=$(git symbolic-ref -q HEAD); then
    PUSH_BRANCH="${BRANCH_REF#refs/heads/}"
else
    # Detached (the normal submodule case): push this exact commit to main.
    PUSH_BRANCH="main"
fi
HEAD_SHA=$(git rev-parse HEAD)

echo "  ⬆ Pushing branch ($PUSH_BRANCH) before the tag..."
if ! git push origin "HEAD:refs/heads/$PUSH_BRANCH"; then
    echo ""
    echo "❌ Branch push FAILED — aborting before the tag is pushed."
    echo "   Nothing was published: the remote tag does not exist yet, so no CI/publish ran."
    echo ""
    echo "   Local state (both re-runnable, nothing to undo on the remote):"
    echo "     • commit v$NEW_VERSION  $HEAD_SHA"
    echo "     • tag    v$NEW_VERSION  (local only)"
    echo ""
    echo "   Most likely cause: origin/$PUSH_BRANCH has commits you do not have."
    echo "   Recover with:"
    echo "     git fetch origin && git rebase origin/$PUSH_BRANCH"
    echo "     git tag -f v$NEW_VERSION && git push origin HEAD:refs/heads/$PUSH_BRANCH"
    echo "     git push origin refs/tags/v$NEW_VERSION"
    exit 1
fi

echo "  ⬆ Branch pushed — now pushing tag v$NEW_VERSION (this triggers CI/publish)..."
if ! git push origin "refs/tags/v$NEW_VERSION"; then
    echo ""
    echo "❌ Tag push FAILED (the branch push already SUCCEEDED)."
    echo "   origin/$PUSH_BRANCH now contains $HEAD_SHA, but no tag exists, so"
    echo "   CI/publish has NOT started. Finish the release with:"
    echo "     git push origin refs/tags/v$NEW_VERSION"
    exit 1
fi

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

# Watch the tag-triggered run that already exists. This only reads Actions
# state; it never dispatches or reruns a workflow.
watch_release_ci "v$NEW_VERSION" "$HEAD_SHA"

echo ""
echo "✅ OSS v$NEW_VERSION released!"
echo "   → CI will publish mesh-shared, session-host-core, mcp-server, daemon-core, and daemon-standalone to npm"
echo "   → ghostty-vt-node is published too when its release paths changed"
echo ""
echo "⚠️  IMPORTANT: Wait for OSS CI to complete before deploying Cloud!"
echo ""
echo "   Check CI status:"
echo "     gh run list --repo vilmire/adhdev --workflow CI --branch v$NEW_VERSION"
echo ""
echo "   Verify npm publish:"
echo "     npm view @adhdev/daemon-core version"
echo "     npm view @adhdev/daemon-standalone version"
echo ""
echo "   Then deploy Cloud:"
echo "     cd .. && ./scripts/version-bump.sh $NEW_VERSION"
