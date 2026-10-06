import { describe, expect, it } from 'vitest'

import { detectAuthFailureOnlyReply, detectProviderFailure } from '../../../src/providers/spec/provider-failure-classifier.js'

// Live incident 2026-10-06 (preview mesh): three delegated claude-cli workers
// (MainPC win32, MoltBook darwin, Jupiter linux) answered a task with ONLY
//   "Login expired · Please run /login"
// and the MainPC task was then committed `task_completed` (weak_end_confirmed).
// The turn's final reply is the verdict input here, so the bar is stricter than
// detectProviderFailure: the WHOLE reply must be auth-failure wording. A
// completed turn whose summary merely mentions the banner must never be failed.

describe('detectAuthFailureOnlyReply', () => {
  it('classifies the exact live claude-cli reply as auth_failed', () => {
    expect(detectAuthFailureOnlyReply('Login expired · Please run /login'))
      .toMatchObject({ errorReason: 'auth_failed', failureKind: 'auth' })
  })

  it('tolerates ANSI, surrounding whitespace and a trailing newline', () => {
    expect(detectAuthFailureOnlyReply('\x1B[31m  Login expired · Please run /login\x1B[0m\r\n'))
      .toMatchObject({ errorReason: 'auth_failed' })
  })

  it('classifies the sibling Claude Code banners', () => {
    for (const reply of [
      'Invalid API key · Please run /login',
      'Not logged in · Please run /login',
      'OAuth token has expired · Please run /login',
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login',
    ]) {
      expect(detectAuthFailureOnlyReply(reply), reply).toMatchObject({ errorReason: 'auth_failed' })
    }
  })

  it('does NOT classify a real reply that merely mentions the banner', () => {
    const replies = [
      'Done. Login expired banner now renders.',
      'Login expired banner now renders correctly; tests pass.',
      'I will add a test for the login expired banner rendering',
      'Fixed the classifier so "Login expired · Please run /login" is caught. All 12 tests pass and the branch is pushed.',
      '',
      '   ',
    ]
    for (const reply of replies) {
      expect(detectAuthFailureOnlyReply(reply), JSON.stringify(reply)).toBeNull()
    }
    // The broad classifier is deliberately looser (live suspicion only) — this
    // is why the turn verdict needs its own whole-reply rule.
    expect(detectProviderFailure('Done. Login expired banner now renders.')).not.toBeNull()
  })

  it('does not classify billing/quota wording (auth axis only)', () => {
    expect(detectAuthFailureOnlyReply('[provider.auth_error] 403 You\'ve reached your 5-hour usage limit')).toBeNull()
  })
})
