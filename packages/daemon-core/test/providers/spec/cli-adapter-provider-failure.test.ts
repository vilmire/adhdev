import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpecCliAdapter, detectProviderFailure } from '../../../src/providers/spec/cli-adapter.js'

/**
 * Collect signals in the shape the deleted provider-signal sink delivered: the
 * CLI instance forwards the adapter's report to `port.signal(instanceId, …)`,
 * and the adapter's owning session id IS that instance id.
 */
function captureSignals(adapter: any, signals: any[]): void {
  adapter.setOnSignal((r: any) => {
    signals.push({ sessionId: adapter.owningSessionId, providerType: r.providerType, workspace: r.workspace, runtimeSettings: r.runtimeSettings, ...r.signal })
  })
}

describe('SpecCliAdapter — Kimi live auth/billing failure detection', () => {
  it('classifies strong authentication and billing markers but not an ambiguous bare 403', () => {
    expect(detectProviderFailure('Authentication failed: access token has expired. Please run kimi login.'))
      .toMatchObject({ errorReason: 'auth_failed', failureKind: 'auth' })
    expect(detectProviderFailure('\u001b[31mYour Kimi Code subscription has expired. Renew in Billing.\u001b[0m', 1))
      .toMatchObject({ errorReason: 'billing_failed', failureKind: 'billing' })
    expect(detectProviderFailure('Request failed: HTTP 403 Forbidden', 1)).toBeNull()
    expect(detectProviderFailure('Process exited before the response was rendered', 1)).toBeNull()
  })

  // The literal line observed on the live incident night (2026-08-29 quota-vs-
  // billing misclassification). It is the message the defense exists for, so it
  // is asserted verbatim rather than paraphrased. It MUST classify as quota
  // exhaustion, not billing: the Kimi account/payment is fine here, only the
  // usage window is spent, and prior to the fix this line was folded into
  // 'billing_failed', which told the operator to "renew the subscription" and
  // permanently suppressed automatic recovery for a condition that heals on
  // its own once the window resets.
  it('classifies the live "[provider.auth_error] 403 ... 5-hour usage limit" line as quota exhaustion, not billing', () => {
    const live = "[provider.auth_error] 403 You've reached your 5-hour usage limit"
    expect(detectProviderFailure(live)).toMatchObject({
      errorReason: 'quota_exceeded',
      failureKind: 'quota',
    })
    // The per-cycle variant of the same verdict, as Kimi words it — carried by a
    // 403 envelope, which is what makes the limit wording trustworthy here.
    expect(detectProviderFailure("403: You've reached your usage limit for this billing cycle."))
      .toMatchObject({ errorReason: 'quota_exceeded', failureKind: 'quota' })
    expect(detectProviderFailure('Error: HTTP 403 - weekly usage limit reached'))
      .toMatchObject({ errorReason: 'quota_exceeded', failureKind: 'quota' })
    // Same sentence with no failure envelope: not a verdict, because this is the
    // shape an agent produces when it is merely quoting the provider's docs.
    expect(detectProviderFailure("You've reached your usage limit for this billing cycle."))
      .toBeNull()
    // provider.auth_error must not become a blanket auth marker: a 403 carrying
    // no entitlement wording stays unclassified, matching the fetcher's rule that
    // an unrelated 403 (region block, allowlist) is never a billing verdict.
    expect(detectProviderFailure('[provider.auth_error] 403 request rejected')).toBeNull()
  })

  // Genuine billing/subscription wording — the account itself is the problem,
  // not a spent usage window — must stay in the non-retryable 'billing_failed'
  // bucket even when it arrives inside a strong failure envelope.
  it('still classifies genuine account-entitlement wording as non-retryable billing, never quota', () => {
    expect(detectProviderFailure('[provider.auth_error] 402 Payment required to continue'))
      .toMatchObject({ errorReason: 'billing_failed', failureKind: 'billing' })
    expect(detectProviderFailure('HTTP 403 - Your Kimi Code subscription has expired.'))
      .toMatchObject({ errorReason: 'billing_failed', failureKind: 'billing' })
    expect(detectProviderFailure('status: 403 insufficient credits on this account'))
      .toMatchObject({ errorReason: 'billing_failed', failureKind: 'billing' })
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
      expect({ line, verdict: detectProviderFailure(line) })
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
    adapter.failureOutputTail = ''
    adapter.providerFailure = null
    adapter.statusCallback = vi.fn()
    adapter.ptyDataCallback = null
    adapter.detectInteractivePromptFromPtyChunk = vi.fn()
    adapter.maybeClearResolvedClaudeTuiPrompt = vi.fn()
    adapter.maybeCaptureClaudeTuiPrompt = vi.fn()
    adapter.maybeUpgradeClaudeTuiMultiSelect = vi.fn()

    adapter.handleEvent({ kind: 'pty_data', chunk: 'Authentica' })
    expect(adapter.getStatus().status).not.toBe('error')
    adapter.handleEvent({ kind: 'pty_data', chunk: 'tion failed: access token has expired. Please run kimi login.\r\n' })
    // AUTH-LIVE-CONFIRM: a live match settles for 5s before the screen is trusted.
    adapter.liveAuth.suspect.suspectedAtMs = Date.now() - 6_000

    expect(adapter.getStatus()).toMatchObject({
      status: 'error',
      errorReason: 'auth_failed',
    })
    // D4: the auth message is provider-neutral now that the AUTH axis serves every
    // spec-backed CLI (billing/quota stay Kimi-scoped and keep their branded copy).
    expect(adapter.getStatus().errorMessage).toMatch(/re-authenticate/i)
    expect(adapter.getStatus().errorMessage).not.toMatch(/kimi/i)
    expect(adapter.statusCallback).toHaveBeenCalledTimes(1)
  })

  // AUTH-LIVE-CONFIRM regression suite — 2026-09-21 preview incident: the
  // chunk-latched live verdict killed every coordinator (and plain sessions
  // discussing the incident) because the 16KB tail is conversation content.
  describe('AUTH-LIVE-CONFIRM — live matches are suspicions until confirmed on screen', () => {
    const BANNER = 'Login expired · Please run /login\r\n'
    const make = (overrides: Record<string, unknown> = {}) => {
      const adapter = Object.create(SpecCliAdapter.prototype) as any
      adapter.cliType = 'claude-cli'
      adapter.cliName = 'Claude Code'
      adapter.spawned = true
      adapter.exited = false
      adapter.activeInteractivePrompt = null
      adapter.providerSessionId = undefined
      adapter.spec = { id: 'claude-cli', name: 'Claude Code' }
      adapter.failureOutputTail = ''
      adapter.providerFailure = null
      adapter.liveAuth = undefined
      adapter.owningSessionId = 'sess_live'
      adapter.workingDir = '/repo'
      adapter.runtimeSettings = {}
      adapter.statusCallback = vi.fn()
      adapter.ptyDataCallback = null
      adapter.detectInteractivePromptFromPtyChunk = vi.fn()
      adapter.maybeClearResolvedClaudeTuiPrompt = vi.fn()
      adapter.maybeCaptureClaudeTuiPrompt = vi.fn()
      adapter.maybeUpgradeClaudeTuiMultiSelect = vi.fn()
      Object.assign(adapter, overrides)
      return adapter
    }

    it('every canonical failure message is itself unclassifiable (self-poisoning guard)', () => {
      const samples = [
        'Login expired · Please run /login',
        "[provider.auth_error] 403 You've reached your 5-hour usage limit",
        'Your Kimi Code subscription has expired.',
      ]
      for (const sample of samples) {
        const verdict = detectProviderFailure(sample)
        expect(verdict).not.toBeNull()
        expect({ sample, echoed: detectProviderFailure(verdict!.message) })
          .toEqual({ sample, echoed: null })
      }
    })

    it('never takes a live-text verdict on a coordinator session, but still classifies its exit', () => {
      const adapter = make({ runtimeSettings: { meshCoordinatorFor: 'mesh_x' } })
      adapter.handleEvent({ kind: 'pty_data', chunk: BANNER })
      expect(adapter.getStatus().status).not.toBe('error')
      expect(adapter.liveAuth?.suspect ?? null).toBeNull()
      expect(adapter.statusCallback).not.toHaveBeenCalled()

      adapter.handleEvent({ kind: 'exit', exit_code: 1 })
      expect(adapter.getStatus()).toMatchObject({ status: 'error', errorReason: 'auth_failed' })
    })

    it('dismisses a marker that is no longer on the visible screen at the turn boundary (quoted content)', () => {
      const adapter = make({
        driver: { snapshot: () => '> summarize the dead worker\n\nDone. The worker was restarted.\n' },
        latestState: { id: 'idle', label: 'Ready', title: null, status: 'idle' },
      })
      adapter.handleEvent({ kind: 'pty_data', chunk: BANNER })
      expect(adapter.liveAuth.suspect).not.toBeNull()
      // Fresh suspicion: the just-submitted prompt may still sit in the composer.
      adapter.getStatus()
      expect(adapter.liveAuth.suspect).not.toBeNull()
      adapter.liveAuth.suspect.suspectedAtMs = Date.now() - 6_000
      expect(adapter.getStatus().status).not.toBe('error')
      expect(adapter.liveAuth?.suspect ?? null).toBeNull()
      expect(adapter.statusCallback).not.toHaveBeenCalled()
    })

    // Owner decision 2026-09-21: a live match NEVER terminates a non-kimi
    // session — status 'error' is auto-cleaned by cli-manager within seconds.
    // The daemon logs and pages the coordinator; stopping is the coordinator's call.
    it('non-kimi: an on-screen banner at the turn boundary pages the coordinator and leaves the session running', () => {
      const signals: any[] = []
      const adapter = make({
        driver: { snapshot: () => 'Login expired · Please run /login\n\n> \n' },
        latestState: { id: 'busy', label: 'Generating', title: null, status: 'generating' },
      })
      captureSignals(adapter, signals)
      adapter.handleEvent({ kind: 'pty_data', chunk: BANNER })
      adapter.getStatus()
      expect(signals).toHaveLength(0) // mid-turn: deferred

      adapter.latestState = { id: 'idle', label: 'Ready', title: null, status: 'idle' }
      adapter.getStatus()
      expect(signals).toHaveLength(0) // idle but younger than the settle window
      adapter.liveAuth.suspect.suspectedAtMs = Date.now() - 6_000
      const status = adapter.getStatus()
      expect(status.status).not.toBe('error')
      expect(status.errorReason).toBeUndefined()
      expect(adapter.providerFailure).toBeNull()
      expect(adapter.statusCallback).not.toHaveBeenCalled()
      expect(signals).toHaveLength(1)
      expect(signals[0]).toMatchObject({
        sessionId: 'sess_live',
        providerType: 'claude-cli',
        ruleId: 'builtin.live_auth_marker',
        kind: 'auth_error',
        params: { reason: 'auth_failed', action: 'advisory_session_not_stopped' },
      })
      // The page is injected into a coordinator PTY — it must carry no screen
      // text and must not itself classify.
      expect(detectProviderFailure(JSON.stringify(signals[0].params))).toBeNull()

      // A TUI repaints its banner: no second page inside the cooldown.
      adapter.handleEvent({ kind: 'pty_data', chunk: BANNER })
      adapter.getStatus()
      expect(signals).toHaveLength(1)
    })

    // Standalone live check 2026-09-22: the advisory fired 12s AFTER stop_cli —
    // teardown takes seconds and the status poll keeps running, so the coordinator
    // would be told a session it just stopped is "left running".
    it('after the daemon requests shutdown nothing is paged or classified, even without a requestedStop tombstone', () => {
      const signals: any[] = []
      const adapter = make({
        driver: { snapshot: () => 'Login expired · Please run /login\n', dispatch: vi.fn() },
        latestState: { id: 'idle', label: 'Ready', title: null, status: 'idle' },
      })
      captureSignals(adapter, signals)
      adapter.handleEvent({ kind: 'pty_data', chunk: BANNER })
      adapter.liveAuth.suspect.suspectedAtMs = Date.now() - 6_000

      adapter.shutdown()
      adapter.getStatus()
      adapter.handleEvent({ kind: 'pty_data', chunk: BANNER }) // teardown repaint
      adapter.getStatus()
      expect(signals).toHaveLength(0)

      // The session host delivered no tombstone: the exit is still explained.
      adapter.handleEvent({ kind: 'exit', exit_code: 129 })
      expect(adapter.getStatus()).toMatchObject({ status: 'stopped' })
      expect(adapter.getStatus().errorReason).toBeUndefined()
    })

    it('kimi keeps its latch, now behind on-screen confirmation (stuck-busy escape included)', () => {
      const adapter = make({
        cliType: 'kimi',
        driver: { snapshot: () => 'Authentication failed: access token has expired.\n' },
        latestState: { id: 'busy', label: 'Generating', title: null, status: 'generating' },
      })
      adapter.handleEvent({ kind: 'pty_data', chunk: 'Authentication failed: access token has expired.\r\n' })
      expect(adapter.getStatus().status).not.toBe('error')
      adapter.liveAuth.suspect.suspectedAtMs = Date.now() - 61_000
      expect(adapter.getStatus()).toMatchObject({ status: 'error', errorReason: 'auth_failed' })
      expect(adapter.statusCallback).toHaveBeenCalledTimes(1)
    })
  })

  it('promotes the live incident quota-exhaustion line to adapter error with a retryable reason, not a billing stop', () => {
    const adapter = Object.create(SpecCliAdapter.prototype) as any
    adapter.cliType = 'kimi'
    adapter.cliName = 'Kimi Code'
    adapter.spawned = true
    adapter.exited = false
    adapter.activeInteractivePrompt = null
    adapter.providerSessionId = undefined
    adapter.spec = { id: 'kimi', name: 'Kimi Code' }
    adapter.failureOutputTail = ''
    adapter.providerFailure = null
    adapter.statusCallback = vi.fn()
    adapter.ptyDataCallback = null
    adapter.detectInteractivePromptFromPtyChunk = vi.fn()
    adapter.maybeClearResolvedClaudeTuiPrompt = vi.fn()
    adapter.maybeCaptureClaudeTuiPrompt = vi.fn()
    adapter.maybeUpgradeClaudeTuiMultiSelect = vi.fn()

    adapter.handleEvent({ kind: 'pty_data', chunk: "[provider.auth_error] 403 You've reached your 5-hour usage limit\r\n" })
    // AUTH-LIVE-CONFIRM: a live match settles for 5s before the screen is trusted.
    adapter.liveAuth.suspect.suspectedAtMs = Date.now() - 6_000

    expect(adapter.getStatus()).toMatchObject({
      status: 'error',
      errorReason: 'quota_exceeded',
    })
    expect(adapter.getStatus().errorMessage).toMatch(/quota/i)
    expect(adapter.getStatus().errorMessage).not.toMatch(/renew|subscription|payment/i)
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
      adapter.failureOutputTail = 'Your membership is inactive. Payment required.'
      adapter.providerFailure = null
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
