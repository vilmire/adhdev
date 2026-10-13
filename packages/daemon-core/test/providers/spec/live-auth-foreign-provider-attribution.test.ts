/**
 * PROVIDER ATTRIBUTION — a quoted auth error from ANOTHER provider must not
 * classify the owning CLI.
 *
 * rc12 finding 2026-10-13: an antigravity-cli worker investigating a codex
 * quota bug printed codex's own `wham/usage failed: 401 Unauthorized …
 * token_revoked` text. The provider-agnostic `unauthorized` rule matched and
 * the antigravity session received an auth advisory for a credential it does
 * not use; an unexpected exit would have latched it auth_failed. All content
 * here is synthetic — no credential or live session is involved.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  classifyAuthBillingOutput,
  createLiveAuthState,
  maskForeignProviderText,
  resolveLiveAuthSuspect,
} from '../../../src/providers/spec/live-auth-advisory.js'
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js'

const QUOTED_CODEX_401 = [
  'Investigating the quota collector. The codex app-server answered:',
  '  GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized;',
  '  body={"error":{"message":"Encountered invalidated oauth token for user, failing request","code":"token_revoked"},"status":401}',
  '',
  'Next I will read refresh.ts and add a regression test.',
].join('\n')

const make = (cliType: string, tail: string) => {
  const adapter = Object.create(SpecCliAdapter.prototype) as any
  adapter.cliType = cliType
  adapter.cliName = cliType
  adapter.spawned = true
  adapter.exited = false
  adapter.activeInteractivePrompt = null
  adapter.providerSessionId = undefined
  adapter.spec = { id: cliType, name: cliType }
  adapter.rawTail.append(tail)
  adapter.providerFailure = null
  adapter.statusCallback = vi.fn()
  return adapter
}

describe('classifyAuthBillingOutput — provider attribution', () => {
  it('a quoted codex 401 does NOT classify an antigravity-cli session', () => {
    expect(classifyAuthBillingOutput('antigravity-cli', QUOTED_CODEX_401)).toBeNull()
  })

  it('the same text still classifies codex-cli itself (own provider)', () => {
    expect(classifyAuthBillingOutput('codex-cli', QUOTED_CODEX_401))
      .toMatchObject({ errorReason: 'auth_failed', failureKind: 'auth' })
  })

  it('a wrapped error whose 401 lands on the line after the foreign URL is still attributed', () => {
    const wrapped = 'unexpected status from https://chatgpt.com/backend-api/codex/responses\n401 Unauthorized'
    expect(classifyAuthBillingOutput('antigravity-cli', wrapped)).toBeNull()
  })

  it('a genuine own-provider banner next to an unrelated foreign quote is still recognised', () => {
    const tail = `${QUOTED_CODEX_401}\n\nAuthentication required. Not signed in.`
    expect(classifyAuthBillingOutput('antigravity-cli', tail))
      .toMatchObject({ errorReason: 'auth_failed', failureKind: 'auth' })
  })

  it('an unknown cliType keeps the previous provider-agnostic behaviour', () => {
    expect(classifyAuthBillingOutput('some-new-cli', QUOTED_CODEX_401))
      .toMatchObject({ failureKind: 'auth' })
  })

  it('unknown stays unknown: masked-away evidence yields null, never a different verdict', () => {
    const masked = maskForeignProviderText('antigravity-cli', QUOTED_CODEX_401)
    expect(masked).not.toMatch(/unauthorized|chatgpt|codex/i)
    expect(masked).toContain('Next I will read refresh.ts')
  })

  it('a long single line masks only the neighbourhood of the foreign marker', () => {
    const filler = 'x'.repeat(600)
    const line = `codex said 401 Unauthorized ${filler} Authentication required.`
    const masked = maskForeignProviderText('antigravity-cli', line)
    expect(masked).not.toMatch(/codex|unauthorized/i)
    expect(masked).toContain('Authentication required.')
  })
})

describe('antigravity-cli consumer paths with a quoted codex 401', () => {
  it('live path: no suspicion raised and no advisory paged', () => {
    const agy = make('antigravity-cli', QUOTED_CODEX_401)
    const reportSignal = vi.spyOn(agy, 'reportSignal').mockImplementation(() => {})
    agy.observeProviderFailureOutput('', undefined)
    expect(agy.liveAuth?.suspect ?? null).toBeNull()
    expect(reportSignal).not.toHaveBeenCalled()
  })

  it('turn-boundary confirmation: an on-screen foreign quote is dismissed, not paged', () => {
    const state = createLiveAuthState()
    state.suspect = { failure: { failureKind: 'auth', errorReason: 'auth_failed', message: '' } as any, suspectedAtMs: 0 }
    const out = resolveLiveAuthSuspect(state, { cliType: 'antigravity-cli', sessionLabel: 's', isCoordinator: false }, {
      midTurn: false, tail: '', now: 120_000, readScreen: () => QUOTED_CODEX_401,
    })
    expect(out.advisory).toBeUndefined()
    expect(out.latch).toBeUndefined()
    expect(out.clearTail).toBe(true)
  })

  it('exit path: an unexpected exit does NOT latch auth_failed from the foreign quote', () => {
    const agy = make('antigravity-cli', QUOTED_CODEX_401)
    agy.handleEvent({ kind: 'exit', exit_code: 1 })
    expect(agy.getStatus().status).not.toBe('error')
    expect(agy.getStatus().errorReason).toBeUndefined()
  })

  it('exit path control: a genuine antigravity auth banner still latches', () => {
    const agy = make('antigravity-cli', 'Authentication required. Not signed in.')
    agy.handleEvent({ kind: 'exit', exit_code: 1 })
    expect(agy.getStatus()).toMatchObject({ status: 'error', errorReason: 'auth_failed' })
  })
})
