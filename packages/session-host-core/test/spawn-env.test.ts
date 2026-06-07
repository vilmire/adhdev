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
