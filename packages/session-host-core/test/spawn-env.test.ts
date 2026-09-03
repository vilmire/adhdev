import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeSpawnEnv } from '../src/spawn-env.js'

/** Runs `fn` with `process.platform` overridden, always restoring it after. */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

const PARENT_CLAUDE_ENV = {
  HOME: '/tmp/home',
  CLAUDECODE: '1',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_SESSION_ID: 'parent-session-uuid',
  CLAUDE_CODE_EXECPATH: '/path/to/claude',
  CLAUDE_CODE_BRIDGE_SESSION_ID: 'parent-bridge-session-uuid',
  CLAUDE_CONFIG_DIR: '/tmp/home/.claude',
}

test('sanitizeSpawnEnv removes parent Codex session controls from child CLIs', () => {
  const env = sanitizeSpawnEnv({
    HOME: '/tmp/home',
    CODEX_THREAD_ID: 'parent-thread',
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'parent-origin',
    CODEX_SANDBOX_NETWORK_DISABLED: '1',
    NO_COLOR: '1',
    COLOR: '0',
  })

  assert.equal(env.HOME, '/tmp/home')
  assert.equal(env.CODEX_THREAD_ID, undefined)
  assert.equal(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined)
  assert.equal(env.CODEX_SANDBOX_NETWORK_DISABLED, undefined)
  assert.equal(env.NO_COLOR, undefined)
  assert.equal(env.COLOR, undefined)
  assert.equal(env.TERM, 'xterm-256color')
  assert.equal(env.COLORTERM, 'truecolor')
})

test('sanitizeSpawnEnv also removes parent Codex session controls from overrides', () => {
  const env = sanitizeSpawnEnv(
    { HOME: '/tmp/home' },
    { CODEX_SANDBOX_NETWORK_DISABLED: '1', NO_COLOR: '1' },
  )

  assert.equal(env.CODEX_SANDBOX_NETWORK_DISABLED, undefined)
  assert.equal(env.NO_COLOR, undefined)
})

// ★THE core contract this task fixes: the strip is unconditional, not gated to
// win32. A daemon launched from inside a Claude Code session inherits these
// markers; forwarding CLAUDE_CODE_CHILD_SESSION to a spawned claude-cli makes
// it run as a nested child that never persists its ~/.claude/projects
// transcript, so the native-source history read finds nothing and the live
// dashboard is empty — reproduced live on darwin, not just win32.
for (const platform of ['darwin', 'linux', 'win32'] as const) {
  test(`sanitizeSpawnEnv strips parent Claude Code session markers on ${platform}`, () => {
    const env = withPlatform(platform, () => sanitizeSpawnEnv(PARENT_CLAUDE_ENV))

    assert.equal(env.CLAUDECODE, undefined)
    assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined)
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined)
    assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined)
    assert.equal(env.CLAUDE_CODE_EXECPATH, undefined)
    // CLAUDE_CODE_BRIDGE_SESSION_ID: the parent's remote bridge/reattach
    // session id — left in place, a spawned child could try to reattach to the
    // PARENT's remote session instead of starting fresh.
    assert.equal(env.CLAUDE_CODE_BRIDGE_SESSION_ID, undefined)
    // User-facing config dir must always be preserved (not a session marker).
    assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/home/.claude')
    assert.equal(env.HOME, '/tmp/home')
  })
}

// ★Parent-env-untouched contract: sanitizeSpawnEnv builds a CHILD env for the
// spawned process; it must never mutate the coordinator's own process.env (or
// any other object the caller still holds a reference to). Deleting a key on
// the returned object must be invisible to the caller's original input.
test('sanitizeSpawnEnv never mutates the base env object it is given', () => {
  const baseEnv = { ...PARENT_CLAUDE_ENV }
  const baseEnvSnapshotBefore = { ...baseEnv }

  withPlatform('darwin', () => sanitizeSpawnEnv(baseEnv))

  assert.deepEqual(baseEnv, baseEnvSnapshotBefore)
  assert.equal(baseEnv.CLAUDE_CODE_CHILD_SESSION, '1')
  assert.equal(baseEnv.CLAUDE_CODE_BRIDGE_SESSION_ID, 'parent-bridge-session-uuid')
})

test('sanitizeSpawnEnv never mutates process.env itself', () => {
  // process.env is compared via a plain-object snapshot on BOTH sides — comparing
  // the live process.env object directly against a plain-object snapshot trips
  // assert.deepEqual on prototype/exotic-object differences unrelated to content.
  const before = { ...process.env }

  withPlatform('darwin', () => sanitizeSpawnEnv({ ...PARENT_CLAUDE_ENV, ...process.env }))

  assert.deepEqual({ ...process.env }, before)
})

// ★Terminal geometry must never be inherited. COLUMNS/LINES are advisory
// overrides a TUI trusts in preference to the real TTY size, but the PTY is
// sized from the adapter's own geometry — so an inherited value describes some
// unrelated terminal. When they disagree the child lays out for the phantom
// width while the VT renders at the real one, and in-place repaints land on the
// wrong row: content fragments across the buffer with a blank gap between the
// stale head and the live tail (observed on antigravity-cli as a "Running
// command" spinner split into body/footer 28 blank rows apart).
test('sanitizeSpawnEnv strips inherited terminal geometry (COLUMNS/LINES)', () => {
  const env = sanitizeSpawnEnv({
    HOME: '/tmp/home',
    COLUMNS: '17',
    LINES: '30',
  })

  assert.equal(env.COLUMNS, undefined)
  assert.equal(env.LINES, undefined)
  // Unrelated vars are untouched — this strip is narrow.
  assert.equal(env.HOME, '/tmp/home')
})

// Explicit overrides are stripped too, exactly like NO_COLOR/CODEX_* above. No
// provider spec sets these (all shipped specs verified), and letting one pin a
// geometry that contradicts the PTY would reintroduce the same split.
test('sanitizeSpawnEnv strips terminal geometry supplied via overrides', () => {
  const env = sanitizeSpawnEnv(
    { HOME: '/tmp/home' },
    { COLUMNS: '17', LINES: '30' },
  )

  assert.equal(env.COLUMNS, undefined)
  assert.equal(env.LINES, undefined)
})
