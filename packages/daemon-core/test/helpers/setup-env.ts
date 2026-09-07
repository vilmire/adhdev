import { afterAll } from 'vitest'

// Vitest global setup: shrink the production-sized mesh P2P probe windows for the
// test environment.
//
// The direct-peer git_status probe windows default to 25s (response) / 25s (retry)
// / 45s (cold-open warmup) so a real TURN-relayed cross-machine peer is not falsely
// marked unavailable (see commands/router.ts). In unit tests there is no real P2P
// transport — a probe to a missing/unreachable peer simply runs to its deadline —
// so any test that exercises a timeout path (unreachable peer, dead worktree,
// cold-open) would wait the full 25–45s, then false-time-out against the vitest
// deadline. That is a pure environment artifact: the code path, the null probe
// result, and the resulting node classification are identical whether the window
// is 1s or 25s — only the wall-clock wait differs.
//
// These constants are env-overridable and evaluated once at module import, and this
// setup file runs before the test modules are imported, so assigning here shrinks
// the windows to the clamp minimum (1s). We only set a default — an explicit value
// from CI/the developer still wins.
const TEST_PROBE_WINDOW_MS = '1000'
for (const key of [
  'MESH_DIRECT_PROBE_TIMEOUT_MS',
  'MESH_DIRECT_PROBE_RETRY_TIMEOUT_MS',
  // Unified cold-open connect budget (router probe + coordinator dispatch share it).
  'MESH_CONNECT_TIMEOUT_MS',
]) {
  if (!process.env[key]) process.env[key] = TEST_PROBE_WINDOW_MS
}

// Isolate the daemon config/state directory to a throwaway temp dir for the test
// process. getConfigDir() honours ADHDEV_CONFIG_DIR (config.ts), so pointing it at
// a per-run tmp dir keeps any test that reads or writes ~/.adhdev/state.json —
// e.g. the read_chat provider-session pin persistence
// (ANTIGRAVITY-FINAL-MESSAGE-TAIL-GAP) — from touching the developer's real state
// or cross-polluting sibling tests through the shared on-disk file.
//
// This override is UNCONDITIONAL: the dev environment itself can legitimately
// export ADHDEV_CONFIG_DIR — the session-host daemon pins it for every child it
// spawns (managed-host.ts), so shells/agents launched under a daemon inherit the
// REAL ~/.adhdev path. An `if (!set)` guard then silently disabled isolation and
// let tests write straight into the live ledger — observed 2026-08-05 as 870+
// synthetic mesh_turn_attempts rows (stage 'delivered', fixture node/session ids
// like node1/session1, node_worker/sess_worker, node-1/session-direct) plus
// queue/mission/ledger residue accumulating in the production mesh-runtime.db
// every time mesh test files ran. Tests that set their own ADHDEV_CONFIG_DIR (or
// mock getConfigDir) still win: they assign it after this setup file runs.
{
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  const fs = require('node:fs') as typeof import('node:fs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-daemon-core-test-config-'))
  process.env.ADHDEV_CONFIG_DIR = dir
  // This dir lives for the whole test file (every test in it reads/writes
  // through ADHDEV_CONFIG_DIR), so it can only be reclaimed once the file is
  // done — afterAll, not afterEach. Exact-path removal (not a tmpdir listing
  // diff): safe under Vitest's default concurrent file-parallel forks, which
  // all share the real OS tmpdir and would otherwise race a listing-based
  // sweep into deleting a sibling process's still-in-use directory.
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
}

// Make the verification path load the REPO's provider specs (the sibling
// `adhdev-providers` checkout) instead of whatever published bundle happens to be
// installed on the runner.
//
// Without this, `ProviderLoader` resolves channel='stable' (the production default,
// since neither Refinery nor ci.yml sets ADHDEV_PROVIDER_CHANNEL) and stable REFUSES
// every sibling checkout, falling back to `${getConfigDir()}/providers`. Combined
// with the ADHDEV_CONFIG_DIR isolation above, that fallback is an empty temp dir. So
// a provider spec fix — e.g. adhdev-providers/cli/claude-cli/specs/4.0.json — could
// go green in CI/Refinery without the gate ever loading the edited file. A broken
// spec was equally invisible.
//
// We deliberately do NOT set ADHDEV_PROVIDER_CHANNEL=preview here. The channel also
// governs verified-store activation, channel sync targets, the preview registry echo
// contract and the unverified-tarball fallback; flipping it would change behavior far
// beyond spec loading and would stop testing the stable code path that production
// actually runs. This narrower switch lifts only the sibling refusal.
//
// Only a default — a test that needs to observe the production refusal (see
// provider-loader channel-policy tests) deletes or overrides it locally.
if (!process.env.ADHDEV_ALLOW_SIBLING_PROVIDERS_ON_STABLE) {
  process.env.ADHDEV_ALLOW_SIBLING_PROVIDERS_ON_STABLE = '1'
}

// git 2.43+ spawns a background `gc --auto` child after receiving a push into a
// bare repo. Tests that call rmSync(root, {recursive, force}) in finally can race
// that gc process writing into objects/ — rmdir throws ENOTEMPTY because force:true
// only suppresses ENOENT, not ENOTEMPTY. Disable auto-gc globally for all git
// subprocesses spawned by the test suite via the GIT_CONFIG_COUNT env protocol.
if (!process.env.GIT_CONFIG_COUNT) {
  process.env.GIT_CONFIG_COUNT = '2'
  process.env.GIT_CONFIG_KEY_0 = 'gc.auto'
  process.env.GIT_CONFIG_VALUE_0 = '0'
  process.env.GIT_CONFIG_KEY_1 = 'receive.autogc'
  process.env.GIT_CONFIG_VALUE_1 = 'false'
} else {
  // Extend an existing GIT_CONFIG_COUNT set by the caller rather than overwriting.
  const base = parseInt(process.env.GIT_CONFIG_COUNT, 10)
  process.env.GIT_CONFIG_COUNT = String(base + 2)
  process.env[`GIT_CONFIG_KEY_${base}`] = 'gc.auto'
  process.env[`GIT_CONFIG_VALUE_${base}`] = '0'
  process.env[`GIT_CONFIG_KEY_${base + 1}`] = 'receive.autogc'
  process.env[`GIT_CONFIG_VALUE_${base + 1}`] = 'false'
}
