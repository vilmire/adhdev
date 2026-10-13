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

  it('a long single line preserves a separately labelled own banner', () => {
    const filler = 'x'.repeat(600)
    const line = `codex said 401 Unauthorized ${filler}; Antigravity: Authentication required.`
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

const FOREIGN_BLOCKS = [
  'API Error: 401 Unauthorized\nCodex collector returned the error',
  'Codex collector returned:\n\n```text\nresponse header\n\n401 Unauthorized\n```',
  'Codex collector returned:\n\n> response header\n>\n> 401 Unauthorized',
  'Codex collector returned:\nresponse header\nresponse detail\n401 Unauthorized',
  `Codex collector returned: ${'response detail '.repeat(60)}401 Unauthorized`,
  'API Error: 401 {"provider":"codex","url":"https://chatgpt.com/backend-api/wham/usage","error":"token_revoked"}',
  'Codex collector returned:\n```text\nresponse header\n\nresponse detail\n401 Unauthorized\n```',
  'Codex collector returned:\n> response header\n>\n> response detail\n> 401 Unauthorized',
  'Codex collector returned:\n{"message":"Antigravity: Authentication required. Not signed in."}',
  "Codex collector returned: 'the error is Antigravity: Authentication required. Not signed in.'",
]
const OWN_BANNER = 'Antigravity: Authentication required. Not signed in.'
const MIXED_BANNERS = [
  `Codex collector failed: 401 Unauthorized\n${OWN_BANNER}`,
  `Codex collector failed: 401 Unauthorized; ${OWN_BANNER}`,
  `Codex collector failed: 401 Unauthorized ${OWN_BANNER}`,
  `${OWN_BANNER}\nInvestigating Codex quota.`,
  `${OWN_BANNER}; Codex collector failed: 401 Unauthorized`,
]

describe('logical error block attribution through live and unexpected-exit consumers', () => {
  it.each(FOREIGN_BLOCKS)('foreign block cannot create live suspicion or an exit latch: %s', tail => {
    expect(classifyAuthBillingOutput('antigravity-cli', tail)).toBeNull()
    const agy = make('antigravity-cli', tail)
    agy.observeProviderFailureOutput('', undefined)
    expect(agy.liveAuth?.suspect ?? null).toBeNull()
    agy.handleEvent({ kind: 'exit', exit_code: 1 })
    expect(agy.getStatus().errorReason).toBeUndefined()
    expect(agy.getStatus().status).toBe('stopped')
  })

  it.each(MIXED_BANNERS)('explicit own auth survives adjacent foreign evidence: %s', tail => {
    expect(classifyAuthBillingOutput('antigravity-cli', tail)).toMatchObject({ failureKind: 'auth' })
    const agy = make('antigravity-cli', tail)
    agy.observeProviderFailureOutput('', undefined)
    expect(agy.liveAuth?.suspect?.failure.failureKind).toBe('auth')
    agy.handleEvent({ kind: 'exit', exit_code: 1 })
    expect(agy.getStatus()).toMatchObject({ status: 'error', errorReason: 'auth_failed' })
  })

  it('quote end bounds foreign evidence and preserves an unlabelled own banner afterwards', () => {
    for (const quote of FOREIGN_BLOCKS.filter(block => block.includes('```') || block.includes('>'))) {
      const tail = `${quote}\nAuthentication required. Not signed in.`
      expect(classifyAuthBillingOutput('antigravity-cli', tail)).toMatchObject({ failureKind: 'auth' })
    }
  })

  it('attribution remains unknown if a foreign error and an unlabelled banner share one block', () => {
    expect(classifyAuthBillingOutput('antigravity-cli', 'Codex said 401 Unauthorized\nAuthentication required.')).toBeNull()
  })
})
