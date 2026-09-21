import { describe, expect, it, vi } from 'vitest'

import { detectKimiAuthBillingFailure } from '../../../src/providers/spec/kimi-auth-billing.js'
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js'

// D4 — AUTH-EXPIRY-GENERALIZATION.
//
// Live incident: claude-cli session b23d10ee (Jupiter) answered
// "Login expired · Please run /login" in 34s with finalContentLength 0 on
// 2026-09-20, then stayed dispatch-eligible and swallowed task 1c225a59 on
// 09-21 with the identical empty fingerprint.
//
// Root cause was NOT the dispatch filter's criteria. `observeKimiAuthBillingOutput`
// returned early for every non-kimi provider, so no classification was produced at
// all: completionDiagnostic.reason was never set, and because the session stayed
// alive and idle (no agent:stopped) nonRetryableProviderFailureReason never ran
// either. chooseDispatchableSession correctly saw a healthy idle session — it had
// no signal to filter on. A session answering instantly with empty content looks
// maximally idle.

describe('D4: auth-expiry fingerprints are classified for every spec-backed CLI', () => {
  // The two live claude-cli banners. Both previously produced NO classification.
  it('classifies the live "Login expired · Please run /login" banner as auth_failed', () => {
    const failure = detectKimiAuthBillingFailure('Login expired · Please run /login')
    expect(failure).toMatchObject({ errorReason: 'auth_failed', failureKind: 'auth' })
  })

  it('classifies a bare "credentials expired" statement as auth_failed', () => {
    expect(detectKimiAuthBillingFailure('Error: credentials expired'))
      .toMatchObject({ errorReason: 'auth_failed' })
  })

  it('keeps the pre-existing Kimi auth wording working (no regression)', () => {
    expect(detectKimiAuthBillingFailure('Authentication failed: access token has expired.'))
      .toMatchObject({ errorReason: 'auth_failed' })
  })

  it('emits provider-neutral auth copy so a non-kimi operator is not misdirected', () => {
    const failure = detectKimiAuthBillingFailure('Login expired · Please run /login')
    expect(failure?.message).not.toMatch(/kimi/i)
  })

  // ── OVERCORRECTION GUARD: prose must not be classified ────────────────────
  // A coding agent routinely NARRATES these words while reading source. None of
  // these may produce a verdict, or every agent discussing auth code would strand
  // its own session.
  it('does not classify an agent narrating auth code as a failure', () => {
    // Every one of these embeds the trigger wording MID-SENTENCE. The statement
    // anchor is what rejects them. The unanchored draft of this rule classified
    // the second line as auth_failed — it would have stranded the very session
    // writing this test.
    const prose = [
      'Reading src/auth/login.ts to understand how expired tokens are handled',
      'I will add a test for the login expired banner rendering',
      'The docs mention you should run /login when the session lapses, per the README',
      'handling the login expired case in the parser',
    ]
    for (const line of prose) {
      expect(detectKimiAuthBillingFailure(line), line).toBeNull()
    }
  })

  it('still classifies a real banner that follows sentence punctuation', () => {
    // The anchor must not be so strict that it only matches at offset 0 — a PTY
    // tail routinely carries preceding output.
    expect(detectKimiAuthBillingFailure('Done. Your session has expired.'))
      .toMatchObject({ errorReason: 'auth_failed' })
  })

  it('returns null for ordinary output', () => {
    expect(detectKimiAuthBillingFailure('Running tests... 42 passed')).toBeNull()
    expect(detectKimiAuthBillingFailure('')).toBeNull()
  })
})

describe('D4: adapter admits AUTH for any provider, BILLING/QUOTA for kimi only', () => {
  const make = (cliType: string, tail: string) => {
    const adapter = Object.create(SpecCliAdapter.prototype) as any
    adapter.cliType = cliType
    adapter.cliName = cliType
    adapter.spawned = true
    adapter.exited = false
    adapter.activeInteractivePrompt = null
    adapter.providerSessionId = undefined
    adapter.spec = { id: cliType, name: cliType }
    adapter.kimiFailureOutputTail = tail
    adapter.kimiAuthBillingFailure = null
    adapter.statusCallback = vi.fn()
    return adapter
  }

  it('promotes a claude-cli auth-expiry banner to adapter error (the incident)', () => {
    const claude = make('claude-cli', 'Login expired · Please run /login')
    claude.handleEvent({ kind: 'exit', exit_code: 1 })
    expect(claude.getStatus()).toMatchObject({ status: 'error', errorReason: 'auth_failed' })
  })

  // CONTROL GROUP — the prior decision that non-kimi providers do not adopt Kimi's
  // entitlement vocabulary must survive. Billing wording is Kimi's model, and the
  // quota axis is already covered mesh-wide by mesh-quota-routing.ts.
  it('still leaves a non-kimi provider unchanged for BILLING wording', () => {
    const claude = make('claude-cli', 'Your membership is inactive. Payment required.')
    claude.handleEvent({ kind: 'exit', exit_code: 1 })
    expect(claude.getStatus()).toMatchObject({ status: 'stopped' })
    expect(claude.getStatus().errorReason).toBeUndefined()
  })

  it('still classifies BILLING for kimi itself', () => {
    const kimi = make('kimi', 'Your membership is inactive. Payment required.')
    kimi.handleEvent({ kind: 'exit', exit_code: 1 })
    expect(kimi.getStatus()).toMatchObject({ status: 'error', errorReason: 'billing_failed' })
  })

  // OVERCORRECTION GUARD: a healthy provider is untouched. This is the "normal
  // session stays dispatchable" control — a session that never printed an auth
  // banner must not acquire an error status.
  it('leaves a healthy provider fully untouched', () => {
    const claude = make('claude-cli', 'All tests passed. Done.')
    expect(claude.getStatus().status).not.toBe('error')
    expect(claude.getStatus().errorReason).toBeUndefined()
  })
})
