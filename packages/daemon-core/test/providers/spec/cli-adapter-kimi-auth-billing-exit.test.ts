import { describe, expect, it, vi } from 'vitest'
import { SpecCliAdapter, detectKimiAuthBillingFailure } from '../../../src/providers/spec/cli-adapter.js'

describe('SpecCliAdapter — Kimi live auth/billing failure detection', () => {
  it('classifies strong authentication and billing markers but not an ambiguous bare 403', () => {
    expect(detectKimiAuthBillingFailure('Authentication failed: access token has expired. Please run kimi login.'))
      .toMatchObject({ errorReason: 'auth_failed', failureKind: 'auth' })
    expect(detectKimiAuthBillingFailure('\u001b[31mYour Kimi Code subscription has expired. Renew in Billing.\u001b[0m', 1))
      .toMatchObject({ errorReason: 'billing_failed', failureKind: 'billing' })
    expect(detectKimiAuthBillingFailure('Request failed: HTTP 403 Forbidden', 1)).toBeNull()
    expect(detectKimiAuthBillingFailure('Process exited before the response was rendered', 1)).toBeNull()
  })

  // The literal line observed on the live incident night. It is the message the
  // defense exists for, so it is asserted verbatim rather than paraphrased.
  it('classifies the live "[provider.auth_error] 403 ... 5-hour usage limit" line as a billing/entitlement stop', () => {
    const live = "[provider.auth_error] 403 You've reached your 5-hour usage limit"
    expect(detectKimiAuthBillingFailure(live)).toMatchObject({
      errorReason: 'billing_failed',
      failureKind: 'billing',
    })
    // The per-cycle variant of the same verdict, as Kimi words it — carried by a
    // 403 envelope, which is what makes the limit wording trustworthy here.
    expect(detectKimiAuthBillingFailure("403: You've reached your usage limit for this billing cycle."))
      .toMatchObject({ errorReason: 'billing_failed' })
    expect(detectKimiAuthBillingFailure('Error: HTTP 403 - weekly usage limit reached'))
      .toMatchObject({ errorReason: 'billing_failed' })
    // Same sentence with no failure envelope: not a verdict, because this is the
    // shape an agent produces when it is merely quoting the provider's docs.
    expect(detectKimiAuthBillingFailure("You've reached your usage limit for this billing cycle."))
      .toBeNull()
    // provider.auth_error must not become a blanket auth marker: a 403 carrying
    // no entitlement wording stays unclassified, matching the fetcher's rule that
    // an unrelated 403 (region block, allowlist) is never a billing verdict.
    expect(detectKimiAuthBillingFailure('[provider.auth_error] 403 request rejected')).toBeNull()
  })

  // The tail is merged PTY output from a coding agent, which routinely *discusses*
  // quota code — unlike the quota fetcher, whose identical wording is safe only
  // because it matches an HTTP body already known to be a 403. Without a failure
  // envelope, limit wording alone must never suppress recovery: a worker reading
  // quota/fetchers/kimi.ts would otherwise be declared billing-failed.
  it('does not classify agent prose that merely mentions limits, quota or billing', () => {
    const benign = [
      'Reading src/quota/fetchers/kimi.ts to understand the usage limit pattern',
      'The test asserts a usage limit error is handled correctly',
      'Added a comment about the billing cycle logic in plan-limits.ts',
      'I will now edit the subscription plan documentation',
      'npm run build completed successfully',
      'Applied patch to mesh-work-queue.ts; all tests pass',
    ]
    for (const line of benign) {
      expect({ line, verdict: detectKimiAuthBillingFailure(line) })
        .toEqual({ line, verdict: null })
    }
  })

  it('promotes a split live PTY auth marker to adapter error before exit, preserving a clear non-retry reason', () => {
    const adapter = Object.create(SpecCliAdapter.prototype) as any
    adapter.cliType = 'kimi'
    adapter.cliName = 'Kimi Code'
    adapter.spawned = true
    adapter.exited = false
    adapter.activeInteractivePrompt = null
    adapter.providerSessionId = undefined
    adapter.spec = { id: 'kimi', name: 'Kimi Code' }
    adapter.kimiFailureOutputTail = ''
    adapter.kimiAuthBillingFailure = null
    adapter.statusCallback = vi.fn()
    adapter.ptyDataCallback = null
    adapter.detectInteractivePromptFromPtyChunk = vi.fn()
    adapter.maybeClearResolvedClaudeTuiPrompt = vi.fn()
    adapter.maybeCaptureClaudeTuiPrompt = vi.fn()
    adapter.maybeUpgradeClaudeTuiMultiSelect = vi.fn()

    adapter.handleEvent({ kind: 'pty_data', chunk: 'Authentica' })
    expect(adapter.getStatus().status).not.toBe('error')
    adapter.handleEvent({ kind: 'pty_data', chunk: 'tion failed: access token has expired. Please run kimi login.\r\n' })

    expect(adapter.getStatus()).toMatchObject({
      status: 'error',
      errorReason: 'auth_failed',
    })
    expect(adapter.getStatus().errorMessage).toMatch(/Kimi authentication failed/i)
    expect(adapter.statusCallback).toHaveBeenCalledTimes(1)
  })

  it('uses a non-zero exit to surface a buffered Kimi billing marker and leaves other providers unchanged', () => {
    const make = (cliType: string) => {
      const adapter = Object.create(SpecCliAdapter.prototype) as any
      adapter.cliType = cliType
      adapter.cliName = cliType
      adapter.spawned = true
      adapter.exited = false
      adapter.activeInteractivePrompt = null
      adapter.providerSessionId = undefined
      adapter.spec = { id: cliType, name: cliType }
      adapter.kimiFailureOutputTail = 'Your membership is inactive. Payment required.'
      adapter.kimiAuthBillingFailure = null
      adapter.statusCallback = vi.fn()
      return adapter
    }

    const kimi = make('kimi')
    kimi.handleEvent({ kind: 'exit', exit_code: 1 })
    expect(kimi.getStatus()).toMatchObject({ status: 'error', errorReason: 'billing_failed' })

    const claude = make('claude-cli')
    claude.handleEvent({ kind: 'exit', exit_code: 1 })
    expect(claude.getStatus()).toMatchObject({ status: 'stopped' })
  })
})
