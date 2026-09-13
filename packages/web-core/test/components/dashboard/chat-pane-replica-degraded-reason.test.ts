import { describe, expect, it } from 'vitest'
import { buildReplicaDegradedReasonSuffix } from '../../../src/components/dashboard/ChatPane'

/**
 * The degraded-replica banner may append the controller's
 * `transcriptFallbackReason` (a closed-union label such as `no_node`) ONLY on
 * dev/preview surfaces. The production wording is frozen: whatever reason the
 * controller reports, production users must see exactly the translated banner
 * text and nothing else. These cases pin that suppression rule on the pure
 * helper, so the JSX can stay a single expression.
 */
describe('ChatPane degraded-replica reason suffix', () => {
  it('appends the reason on a dev/preview surface', () => {
    expect(buildReplicaDegradedReasonSuffix('no_node', true)).toBe(' (no_node)')
  })

  it('★ never leaks the reason into the production wording', () => {
    expect(buildReplicaDegradedReasonSuffix('no_node', false)).toBe('')
  })

  it('is empty when the controller has no reason, even on dev/preview', () => {
    expect(buildReplicaDegradedReasonSuffix(undefined, true)).toBe('')
    expect(buildReplicaDegradedReasonSuffix('', true)).toBe('')
  })
})
