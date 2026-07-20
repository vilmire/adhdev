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
// or cross-polluting sibling tests through the shared on-disk file. Only a default;
// a test that sets its own ADHDEV_CONFIG_DIR (or mocks getConfigDir) still wins.
if (!process.env.ADHDEV_CONFIG_DIR) {
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  const fs = require('node:fs') as typeof import('node:fs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-daemon-core-test-config-'))
  process.env.ADHDEV_CONFIG_DIR = dir
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
