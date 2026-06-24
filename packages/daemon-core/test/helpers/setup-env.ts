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
  'MESH_DIRECT_PROBE_CONNECT_TIMEOUT_MS',
]) {
  if (!process.env[key]) process.env[key] = TEST_PROBE_WINDOW_MS
}
