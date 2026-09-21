import { describe, expect, it } from 'vitest'
import { buildMeshSystemMessage } from '../../src/mesh/mesh-events-utils.js'
import { buildProviderSignalNotice } from '../../src/mesh/mesh-signal-bridge.js'
import { detectProviderFailure } from '../../src/providers/spec/provider-failure-classifier.js'
import { LIVE_AUTH_ADVISORY_RULE_ID } from '../../src/providers/spec/live-auth-advisory.js'

// SELF-POISONING CLASS GUARD.
//
// The daemon WRITES text into agent PTYs (coordinator pages, mesh events) and the
// daemon also READS those same PTYs with screen classifiers. Any daemon-authored
// template that matches a daemon classifier is a feedback loop: delivering the
// notice about failure N manufactures failure N+1 in whoever receives it.
//
// Live incident 2026-09-21 (preview): the canonical auth message ("Provider
// authentication failed …") matched the classifier's bare `authentication failed`
// rule, so every relaunched coordinator was re-poisoned by the pending
// auth-failure events and auto-cleaned again — three coordinators, one worker and
// two plain sessions in a row.
//
// 2e3e5b25 pinned the ONE message that bit. This pins the CLASS: every
// daemon-authored template that reports a provider failure, rendered with the
// classifier's own canonical detail text, must be unclassifiable. Adding a new
// failure notice means adding it here.
describe('daemon-authored PTY text never matches the daemon\'s own failure classifier', () => {
  const canonical = (sample: string) => {
    const verdict = detectProviderFailure(sample)
    if (!verdict) throw new Error(`fixture no longer classifies: ${sample}`)
    return verdict
  }
  const FAILURES = [
    canonical('Login expired · Please run /login'),
    canonical('Your Kimi Code subscription has expired.'),
    canonical("[provider.auth_error] 403 You've reached your 5-hour usage limit"),
  ]

  it('covers all three failure kinds', () => {
    expect(FAILURES.map(f => f.errorReason).sort()).toEqual(['auth_failed', 'billing_failed', 'quota_exceeded'])
  })

  it('agent:stopped coordinator messages are inert for every failure kind', () => {
    for (const failure of FAILURES) {
      for (const metadataEvent of [
        { errorReason: failure.errorReason, completionDiagnostic: { reason: failure.errorReason, errorMessage: failure.message } },
        { errorReason: failure.errorReason },
      ]) {
        const message = buildMeshSystemMessage({ event: 'agent:stopped', nodeLabel: 'node_worker', metadataEvent })
        expect(message).toContain('node_worker')
        expect({ reason: failure.errorReason, echoed: detectProviderFailure(message) })
          .toEqual({ reason: failure.errorReason, echoed: null })
      }
    }
  })

  it('the live auth advisory page is inert', () => {
    for (const failure of FAILURES) {
      const notice = buildProviderSignalNotice({
        ruleId: LIVE_AUTH_ADVISORY_RULE_ID,
        kind: 'auth_error',
        nodeLabel: 'node_worker',
        providerType: 'claude-cli',
        params: { reason: failure.errorReason, action: 'advisory_session_not_stopped' },
      })
      expect({ reason: failure.errorReason, echoed: detectProviderFailure(notice) })
        .toEqual({ reason: failure.errorReason, echoed: null })
    }
  })

  it('failure notices are provider-neutral (the AUTH axis serves every spec CLI)', () => {
    const message = buildMeshSystemMessage({
      event: 'agent:stopped', nodeLabel: 'node_worker', metadataEvent: { errorReason: 'auth_failed' },
    })
    expect(message).not.toMatch(/kimi/i)
  })
})
