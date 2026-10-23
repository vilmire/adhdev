import { describe, expect, it } from 'vitest'
import {
  evaluateProviderQuotaGate,
  rankProvidersByQuotaGate,
  expiryRiskForRanking,
  PROVIDER_QUOTA_GROUP_EXHAUSTED_SKIP_REASON,
} from '../../src/mesh/mesh-quota-routing.js'
import {
  quotaSpreadBonusByProvider,
  quotaTargetsFromSlots,
  resolveRecoveryRelaunchProvider,
} from '../../src/mesh/mesh-quota-ranking-records.js'
import { selectProviderWithDiagnostics } from '../../src/mesh/mesh-routing-decision.js'

// Review REJECT follow-up (fix/agy-quota-model-groups): the per-group gate only
// applied to 'ok' snapshots with an explicit target. Every other path that read
// the blended worst-pool headline is pinned here with the owner's exact shape:
// Gemini weekly 0% left (5h window disabled), Claude/GPT weekly 55.65% left
// with the 5h window at 100% left.

const MINUTE = 60_000
const NOW = 1_800_000_000_000
const WEEK = 10080
const FIVE_H = 300
const GEMINI = 'Gemini 4 Argon (Medium)'
const CLAUDE = 'Claude Opus 4.6 (Thinking)'

const b = (group: string, name: string, usedPercent: number, windowMinutes: number) => ({
  name, group, usedPercent, windowMinutes, resetsAt: NOW + (windowMinutes === WEEK ? 2000 : 60) * MINUTE,
})

const EXHAUSTED_BUCKETS = [
  b('gemini', 'Gemini Models · Weekly Limit Remaining', 100, WEEK),
  b('claude-gpt', 'Claude and GPT models · Weekly Limit Remaining', 44.35, WEEK),
  b('claude-gpt', 'Claude and GPT models · Five Hour Limit Remaining', 0, FIVE_H),
]

function node(over: Record<string, any> = {}, extraQuota: Record<string, any> = {}, buckets: any[] = EXHAUSTED_BUCKETS) {
  return {
    id: 'node_a',
    nodeFacts: {
      reportedAt: NOW,
      quota: {
        'antigravity-cli': {
          provider: 'antigravity-cli',
          status: 'ok',
          // Blended headline = WORST pool: weekly reads 100% used.
          session: { usedPercent: 0, windowMinutes: FIVE_H, resetsAt: NOW + 60 * MINUTE },
          weekly: { usedPercent: 100, windowMinutes: WEEK, resetsAt: NOW + 2000 * MINUTE },
          buckets,
          updatedAt: NOW - MINUTE,
          error: null,
          ...over,
        },
        ...extraQuota,
      },
    },
  }
}

const gate = (n: any, model: string) =>
  evaluateProviderQuotaGate(n, 'antigravity-cli', null, NOW, null, { model })

describe('finding 1 — lastGoodWindows carry-forward is projected per group', () => {
  const carried = () => node({
    status: 'error',
    error: 'token expired',
    metadata: { failureKind: 'expired-token', lastGoodWindows: true },
  })

  it('gates the Gemini slot by its own exhausted pool', () => {
    const block = gate(carried(), GEMINI)
    expect(block?.reason).toBe(PROVIDER_QUOTA_GROUP_EXHAUSTED_SKIP_REASON)
    expect(block?.group).toBe('gemini')
  })

  it('keeps the Claude/GPT slot clear instead of using the blended 100%-used weekly', () => {
    expect(gate(carried(), CLAUDE)).toBeNull()
  })

  it('still respects reset times: a carried group window past its resetsAt does not block', () => {
    const expired = node({
      status: 'error',
      metadata: { failureKind: 'expired-token', lastGoodWindows: true },
    }, {}, EXHAUSTED_BUCKETS.map(x => ({ ...x, resetsAt: NOW - MINUTE })))
    expect(gate(expired, GEMINI)).toBeNull()
  })

  it('a non-carried error snapshot still fails open', () => {
    expect(gate(node({ status: 'error', metadata: { failureKind: 'network' } }), GEMINI)).toBeNull()
  })
})

describe('finding 8 — an unrecognised bucket group does not disable per-group gating', () => {
  it('ignores the unknown bucket and still gates Gemini / clears Claude', () => {
    const n = node({}, {}, [...EXHAUSTED_BUCKETS, b('mystery', 'Some New Pool · Weekly', 100, WEEK)])
    expect(gate(n, GEMINI)?.reason).toBe(PROVIDER_QUOTA_GROUP_EXHAUSTED_SKIP_REASON)
    expect(gate(n, CLAUDE)).toBeNull()
  })
})

describe('finding 4 — ranking and spread bonus read the target group, not the blended weekly', () => {
  const healthyClaudeCode = {
    'claude-cli': {
      provider: 'claude-cli',
      status: 'ok',
      session: { usedPercent: 10, windowMinutes: FIVE_H, resetsAt: NOW + 60 * MINUTE },
      weekly: { usedPercent: 20, windowMinutes: WEEK, resetsAt: NOW + 2000 * MINUTE },
      updatedAt: NOW - MINUTE,
      error: null,
    },
  }

  it('a 0%-remaining Gemini pool does not poison the session axis for a Claude/GPT slot', () => {
    const n = node({}, healthyClaudeCode)
    const targets = new Map([['antigravity-cli', { model: CLAUDE }]])
    const ranked = rankProvidersByQuotaGate(n, ['antigravity-cli', 'claude-cli'], null, NOW, null, targets)
    expect(ranked.clear).toContain('antigravity-cli')
    // weekly-readable candidates: AGY Claude/GPT 55.65% and claude-cli 80% are both > 40% headroom.
    expect(ranked.sessionAxisActive).toBe(true)
  })

  it('expiryRiskForRanking reads the target pool windows', () => {
    const n = node()
    const claude = expiryRiskForRanking(n, 'antigravity-cli', 'weekly', null, NOW, null, { model: CLAUDE })
    expect(claude?.remainingPercent).toBeCloseTo(55.65, 2)
    const blended = expiryRiskForRanking(n, 'antigravity-cli', 'weekly', null, NOW, null)
    expect(blended?.remainingPercent).toBe(0)
  })

  it('quotaSpreadBonusByProvider uses the slot pool for the bonus', () => {
    const n = node()
    const claudeBonus = quotaSpreadBonusByProvider(n, null, NOW, null, new Map([['antigravity-cli', { model: CLAUDE }]]))
    const geminiBonus = quotaSpreadBonusByProvider(n, null, NOW, null, new Map([['antigravity-cli', { model: GEMINI }]]))
    expect(claudeBonus['antigravity-cli']).toBeGreaterThan(0)
    expect(geminiBonus['antigravity-cli']).toBe(0)
  })

  it('quotaTargetsFromSlots targets a provider only when its slots agree on one pool', () => {
    const single = quotaTargetsFromSlots([{ provider: 'antigravity-cli', model: CLAUDE }])
    expect(single.get('antigravity-cli')).toEqual({ model: CLAUDE })
    const mixed = quotaTargetsFromSlots([
      { provider: 'antigravity-cli', model: CLAUDE },
      { provider: 'antigravity-cli', model: GEMINI },
    ])
    expect(mixed.has('antigravity-cli')).toBe(false)
  })
})

describe('finding 5 — candidate dedupe happens after per-slot gating', () => {
  const slot = (model: string) => ({ providerType: 'antigravity-cli', slot: { provider: 'antigravity-cli', model } as any })

  it('a healthy Claude/GPT sibling slot survives an exhausted Gemini slot listed first', () => {
    const result = selectProviderWithDiagnostics({
      node: node(),
      nodeId: 'node_a',
      task: { difficulty: 'medium', taskMode: 'code_change' } as any,
      quotaRouting: null,
      difficultyFloorRequired: false,
      usableSlots: [slot(GEMINI), slot(CLAUDE)],
      now: NOW,
    } as any)
    expect(result.winner?.slot.model).toBe(CLAUDE)
    expect(result.ranked.clear).toEqual(['antigravity-cli'])
  })

  it('when every sibling is exhausted the provider stays visible as gated', () => {
    const result = selectProviderWithDiagnostics({
      node: node(),
      nodeId: 'node_a',
      task: { difficulty: 'medium', taskMode: 'code_change' } as any,
      quotaRouting: null,
      difficultyFloorRequired: false,
      usableSlots: [slot(GEMINI)],
      now: NOW,
    } as any)
    expect(result.winner).toBeUndefined()
    expect(result.ranked.gated[0]?.block.reason).toBe(PROVIDER_QUOTA_GROUP_EXHAUSTED_SKIP_REASON)
  })
})

describe('finding 6 — recovery relaunch carries the target model', () => {
  it('keeps a failed Claude/GPT slot when only the Gemini pool is exhausted', () => {
    const decision = resolveRecoveryRelaunchProvider(
      node(), 'antigravity-cli', [], null, NOW, null, { model: CLAUDE },
    )
    expect(decision.action).toBe('keep')
  })

  it('blocks a failed Gemini slot with no alternative', () => {
    const decision = resolveRecoveryRelaunchProvider(
      node(), 'antigravity-cli', [], null, NOW, null, { model: GEMINI },
    )
    expect(decision.action).toBe('block')
  })
})
