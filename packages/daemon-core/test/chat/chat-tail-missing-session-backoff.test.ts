import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHAT_TAIL_MISSING_SESSION_POLICY,
  decideMissingSessionAttempt,
  isMissingLiveSessionResult,
  recordMissingSessionAttempt,
  resolveBackoffMs,
  shouldWarnForMissingSession,
  type ChatTailMissingSessionState,
} from '../../src/chat/chat-tail-missing-session-backoff.js'

const POLICY = DEFAULT_CHAT_TAIL_MISSING_SESSION_POLICY

describe('isMissingLiveSessionResult', () => {
  it('matches the command handler live-session rejection', () => {
    expect(isMissingLiveSessionResult({
      success: false,
      error: 'Live session not found for targetSessionId: 66795a71-7f3e-41aa-b1a5-cc497e1dc516',
    })).toBe(true)
  })

  it('ignores unrelated failures so they keep their own handling', () => {
    // A provider/transport failure is NOT the "session is gone" case — pacing it
    // with this policy would silently slow a recoverable error path.
    expect(isMissingLiveSessionResult({ success: false, error: 'PTY write failed' })).toBe(false)
    expect(isMissingLiveSessionResult({
      success: false,
      error: 'No targetSessionId specified — cannot route command',
    })).toBe(false)
    expect(isMissingLiveSessionResult({ success: true, messages: [] })).toBe(false)
    expect(isMissingLiveSessionResult(null)).toBe(false)
    expect(isMissingLiveSessionResult(undefined)).toBe(false)
    expect(isMissingLiveSessionResult('nope')).toBe(false)
  })
})

describe('decideMissingSessionAttempt', () => {
  it('always attempts the first miss so a streak can start', () => {
    expect(decideMissingSessionAttempt(undefined, 1_000_000, POLICY).action).toBe('attempt')
  })

  it('keeps retrying every flush inside the grace window', () => {
    // Regression guard for the correctness constraint: a session that has not yet
    // attached to the registry must NOT be paced, or a live session's chat pane
    // would attach late (or never).
    const t0 = 1_000_000
    let state: ChatTailMissingSessionState | undefined
    for (let elapsed = 0; elapsed < POLICY.graceMs; elapsed += 250) {
      expect(decideMissingSessionAttempt(state, t0 + elapsed, POLICY).action).toBe('attempt')
      state = recordMissingSessionAttempt(state, t0 + elapsed)
    }
  })

  it('skips a flush that lands inside a backoff window', () => {
    // The actual storm suppression: the live daemon logged 95 reads for one
    // session in ~40s because every flush re-read it.
    const t0 = 1_000_000
    const state: ChatTailMissingSessionState = {
      firstMissingAt: t0,
      lastAttemptAt: t0 + POLICY.graceMs,
      consecutiveMisses: 5,
      warned: true,
    }
    expect(decideMissingSessionAttempt(state, t0 + POLICY.graceMs + 10, POLICY).action).toBe('skip')
    expect(decideMissingSessionAttempt(
      state,
      t0 + POLICY.graceMs + resolveBackoffMs(state, POLICY),
      POLICY,
    ).action).toBe('attempt')
  })

  it('drops a subscription whose session stayed missing past the horizon', () => {
    const t0 = 1_000_000
    const state: ChatTailMissingSessionState = {
      firstMissingAt: t0,
      lastAttemptAt: t0 + 1000,
      consecutiveMisses: 40,
      warned: true,
    }
    expect(decideMissingSessionAttempt(state, t0 + POLICY.giveUpAfterMs, POLICY).action).toBe('drop')
    expect(decideMissingSessionAttempt(state, t0 + POLICY.giveUpAfterMs + 60_000, POLICY).action).toBe('drop')
  })
})

describe('resolveBackoffMs', () => {
  it('doubles per miss and saturates at the ceiling', () => {
    const t0 = 1_000_000
    let state = recordMissingSessionAttempt(undefined, t0)
    expect(resolveBackoffMs(state, POLICY)).toBe(POLICY.initialBackoffMs)

    state = recordMissingSessionAttempt(state, t0 + 1)
    expect(resolveBackoffMs(state, POLICY)).toBe(POLICY.initialBackoffMs * 2)

    state = recordMissingSessionAttempt(state, t0 + 2)
    expect(resolveBackoffMs(state, POLICY)).toBe(POLICY.initialBackoffMs * 4)

    let saturated = state
    for (let i = 0; i < 200; i++) saturated = recordMissingSessionAttempt(saturated, t0 + 10 + i)
    const capped = resolveBackoffMs(saturated, POLICY)
    expect(capped).toBe(POLICY.maxBackoffMs)
    expect(Number.isFinite(capped)).toBe(true)
  })
})

describe('shouldWarnForMissingSession', () => {
  it('warns once per streak and stays quiet afterwards', () => {
    const t0 = 1_000_000
    let state = recordMissingSessionAttempt(undefined, t0)
    expect(shouldWarnForMissingSession(state)).toBe(true)
    state.warned = true
    for (let i = 0; i < 50; i++) {
      state = recordMissingSessionAttempt(state, t0 + i)
      expect(shouldWarnForMissingSession(state)).toBe(false)
    }
  })
})
