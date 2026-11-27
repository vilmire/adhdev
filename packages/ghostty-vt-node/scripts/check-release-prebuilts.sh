#!/usr/bin/env bash
set -euo pipefail

package=packages/ghostty-vt-node
# Include ignored files because extra ABI directories can otherwise take
# precedence in the loader and end up in the npm tarball.
changes=$(git status --porcelain --untracked-files=all --ignored -- "$package/prebuilt")
if [[ -n "$changes" ]]; then
  echo "Release prebuilts must match the checkout without extra files:" >&2
  printf '%s\n' "$changes" >&2
  exit 1
fi

if [[ "$(uname -s)-$(uname -m)" != Linux-x86_64 ]] || ! awk '
  /^flags[[:space:]]*:/ {
    seen = 1
    for (i = 2; i <= NF; i++) if ($i ~ /^avx512/) avx512 = 1
  }
  END { exit !(seen && !avx512) }
' /proc/cpuinfo; then
  echo "Release load verification requires a Linux x64 runner without AVX-512." >&2
  exit 1
fi
echo "Linux x64 runner without AVX-512 at $(git rev-parse HEAD)"

# Validate all committed bytes before executing any of them.
node "$package/scripts/prebuilt-manifest.mjs" check --all-present
node "$package/scripts/ensure-prebuilt-sonames.mjs" --check --load
node "$package/scripts/check-prebuilts.mjs" --all-present
