import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearQuotaCache, refreshQuotaCacheOnce, readQuotaCache } from '../../src/quota/refresh.js'
import { overlayMeshNodeGitObservations } from '../../src/commands/high-family/mesh-status-node-state.js'
import { evaluateProviderQuotaGate } from '../../src/mesh/mesh-quota-routing.js'
import { liveLocalQuotaForRouting } from '../../src/mesh/mesh-quota-sources.js'

const NOW = 1_800_000_000_000
const quota = (usedPercent: number, updatedAt: number) => ({
  provider: 'grok-cli' as const, status: 'ok' as const, session: null,
  weekly: { usedPercent, windowMinutes: 10080, resetsAt: NOW + 86_400_000 },
  updatedAt, error: null,
})

afterEach(() => { clearQuotaCache(); vi.useRealTimers() })

describe('local quota presentation on cached aggregate serves', () => {
  it('replaces stale 76% remaining with live 3% on self/worktree nodes and agrees with the weekly gate', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW)
    const fetch = vi.fn(async () => quota(97, NOW))
    await refreshQuotaCacheOnce([{ provider: 'grok-cli', fetch }])
    const oldFacts = { schemaVersion: 1, reportedAt: NOW - 3_663_172,
      quota: { 'grok-cli': quota(24, NOW - 3_663_172) } }
    const self = { nodeId: 'self', daemonId: 'owner', connection: { state: 'self' }, nodeFacts: oldFacts }
    const clone = { nodeId: 'clone', daemonId: 'owner', nodeFacts: oldFacts }
    // Another daemon may have a workspace on the same machine. Ownership of
    // its account is still foreign; never overlay this daemon's quota onto it.
    const foreign = { nodeId: 'foreign', daemonId: 'other', workspace: process.cwd(), nodeFacts: oldFacts }
    const snapshot = { nodes: [self, clone, foreign] }
    const store = { get: vi.fn(() => undefined) }
    const refresher = { isRuntimeRefreshing: vi.fn(() => false), isRefreshing: vi.fn(() => false) }
    overlayMeshNodeGitObservations(snapshot, { meshId: 'mesh', store: store as never,
      refresher: refresher as never, locality: { localDaemonId: 'owner' } })
    for (const node of [self, clone]) {
      expect(node.nodeFacts.quota['grok-cli'].weekly.usedPercent).toBe(97)
      expect(node.nodeFacts.quota['grok-cli'].updatedAt).toBe(NOW)
      expect(node.nodeFacts.reportedAt).toBe(oldFacts.reportedAt)
      expect(node.nodeFacts.quota).toEqual(readQuotaCache())
      const block = evaluateProviderQuotaGate(node, 'grok-cli', { weeklyMinRemainingPercent: 15 }, NOW,
        { liveLocalQuota: liveLocalQuotaForRouting(n => n.daemonId === 'owner') })
      expect(block).toMatchObject({ reason: 'provider_quota_weekly_low', remainingPercent: 3, window: 'weekly' })
    }
    expect(foreign.nodeFacts.quota['grok-cli'].weekly.usedPercent).toBe(24)
    expect(oldFacts.quota['grok-cli'].weekly.usedPercent).toBe(24)
    expect(fetch).toHaveBeenCalledTimes(1) // presentation and gate never fetch
  })
})
