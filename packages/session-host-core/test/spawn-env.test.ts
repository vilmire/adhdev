import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeSpawnEnv } from '../src/spawn-env.js'

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

test('sanitizeSpawnEnv strips parent Claude Code session markers on win32', () => {
  // A daemon launched from inside a Claude Code session inherits these markers;
  // forwarding CLAUDE_CODE_CHILD_SESSION to a spawned claude-cli makes it run as
  // a nested child that never persists its ~/.claude/projects transcript, so the
  // native-source history read finds nothing and the live dashboard is empty.
  const env = sanitizeSpawnEnv({
    HOME: '/tmp/home',
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: 'parent-session-uuid',
    CLAUDE_CODE_EXECPATH: '/path/to/claude',
    CLAUDE_CONFIG_DIR: '/tmp/home/.claude',
  })

  // Scoped to win32 for now; on other platforms the markers pass through.
  if (process.platform === 'win32') {
    assert.equal(env.CLAUDECODE, undefined)
    assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined)
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined)
    assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined)
    assert.equal(env.CLAUDE_CODE_EXECPATH, undefined)
  } else {
    assert.equal(env.CLAUDE_CODE_CHILD_SESSION, '1')
  }
  // User-facing config dir must always be preserved (not a session marker).
  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/home/.claude')
  assert.equal(env.HOME, '/tmp/home')
})
