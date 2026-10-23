import { describe, expect, it } from 'vitest'
import {
  evaluateProviderQuotaGate,
  rankProvidersByQuotaGate,
  PROVIDER_QUOTA_GROUP_EXHAUSTED_SKIP_REASON,
} from '../../src/mesh/mesh-quota-routing.js'

// Owner screen 2026-10-23: Gemini group weekly 0% left (5h disabled), Claude/GPT
// group weekly 55.65% left, 5h 100%. A Gemini slot must be gated by ITS group,
// not cleared by the healthy Claude/GPT headline.

const MINUTE = 60_000
const NOW = 1_800_000_000_000
const WEEK = 10080
const FIVE_H = 300

function node(buckets: any[], headline: { session: number; weekly: number }) {
  return {
    id: 'node_a',
    nodeFacts: {
      reportedAt: NOW,
      quota: {
        'antigravity-cli': {
          provider: 'antigravity-cli',
          status: 'ok',
          session: { usedPercent: headline.session, windowMinutes: FIVE_H, resetsAt: NOW + 60 * MINUTE },
          weekly: { usedPercent: headline.weekly, windowMinutes: WEEK, resetsAt: NOW + 2000 * MINUTE },
          buckets,
          updatedAt: NOW - MINUTE,
          error: null,
        },
      },
    },
  }
}

const b = (group: string, name: string, usedPercent: number, windowMinutes: number) => ({
  name, group, usedPercent, windowMinutes, resetsAt: NOW + (windowMinutes === WEEK ? 2000 : 60) * MINUTE,
})

// What the fetcher yields for the owner's screen: Gemini 5h is disabled (no bucket).
const GEMINI_EXHAUSTED = [
  b('gemini', 'Gemini Models · Weekly Limit Remaining', 100, WEEK),
  b('claude-gpt', 'Claude and GPT models · Weekly Limit Remaining', 44.35, WEEK),
  b('claude-gpt', 'Claude and GPT models · Five Hour Limit Remaining', 0, FIVE_H),
]
const exhaustedNode = () => node(GEMINI_EXHAUSTED, { session: 0, weekly: 100 })

const run = (n: any, model: string) =>
  evaluateProviderQuotaGate(n, 'antigravity-cli', null, NOW, null, { model })

describe('antigravity quota is gated per model group', () => {
  it('gates Gemini slots when the Gemini group is exhausted, naming the group', () => {
    for (const model of ['Gemini 4 Argon (Medium)', 'Gemini 4 Argon (High)', 'Gemini 3.8 Flash (Low)']) {
      const block = run(exhaustedNode(), model)
      expect(block?.reason).toBe(PROVIDER_QUOTA_GROUP_EXHAUSTED_SKIP_REASON)
      expect(block?.group).toBe('gemini')
      expect(block?.window).toBe('weekly')
      expect(block?.remainingPercent).toBe(0)
    }
  })

  it('keeps Claude/GPT slots clear — judged by their own 55.65% weekly / 100% 5h, not the blended headline', () => {
    for (const model of ['Claude Opus 4.6 (Thinking)', 'Claude Sonnet 4.6 (Thinking)', 'GPT-OSS 120B (Medium)']) {
      expect(run(exhaustedNode(), model)).toBeNull()
    }
  })

  it('ranking excludes the exhausted-group slot only', () => {
    const targets = new Map([['antigravity-cli', { model: 'Gemini 4 Argon (Medium)' }]])
    const ranked = rankProvidersByQuotaGate(exhaustedNode(), ['antigravity-cli'], null, NOW, null, targets)
    expect(ranked.clear).toEqual([])
    expect(ranked.gated[0].block.reason).toBe(PROVIDER_QUOTA_GROUP_EXHAUSTED_SKIP_REASON)
  })

  it('both groups healthy: every slot is clear', () => {
    const healthy = node([
      b('gemini', 'Gemini Models · Weekly Limit Remaining', 5, WEEK),
      b('gemini', 'Gemini Models · Five Hour Limit Remaining', 10, FIVE_H),
      b('claude-gpt', 'Claude and GPT models · Weekly Limit Remaining', 44.35, WEEK),
      b('claude-gpt', 'Claude and GPT models · Five Hour Limit Remaining', 0, FIVE_H),
    ], { session: 10, weekly: 44.35 })
    for (const model of ['Gemini 4 Argon (Medium)', 'Claude Opus 4.6 (Thinking)']) {
      expect(run(healthy, model)).toBeNull()
    }
  })
})
