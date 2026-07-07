import { describe, expect, it } from 'vitest'
import {
  buildConversationIdentity,
  buildConversationLookupKeys,
  buildConversationTargetKey,
  conversationMatchesTarget,
  getConversationHistorySessionId,
  getConversationHistorySessionIdForRead,
  getConversationHistoryLookupIds,
  getDaemonEntrySessionSuffix,
  isMeshOwnedSessionCopy,
  getIdeChatDedupeKey,
  getMachineSessionDedupeKey,
  getConversationTabKey,
  resolveOwnerMachineName,
} from '../../../src/components/dashboard/conversation-identity'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import type { DaemonData } from '../../../src/types'

function createConversation(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
  return {
    routeId: 'machine-1:ide:cursor-1',
    sessionId: 'runtime-1',
    providerSessionId: 'provider-1',
    nativeSessionId: 'runtime-1',
    transport: 'cdp-page',
    daemonId: 'machine-1',
    agentName: 'Codex',
    agentType: 'codex',
    status: 'idle',
    title: '',
    messages: [],
    hostIdeType: 'cursor',
    workspaceName: 'repo',
    displayPrimary: 'repo',
    displaySecondary: 'Cursor · Codex',
    streamSource: 'native',
    tabKey: 'tab-1',
    machineName: 'Studio Mac',
    connectionState: 'connected',
    ...overrides,
  }
}

describe('conversation identity contract sketch', () => {
  it('prefers provider session ids for canonical and history identity', () => {
    const identity = buildConversationIdentity(createConversation())

    expect(identity.canonicalKey).toBe('provider:provider-1')
    expect(identity.historySessionId).toBe('provider-1')
    expect(identity.runtimeSessionId).toBe('runtime-1')
    expect(identity.targetKey).toBe('provider:provider-1')
    expect(identity.allKeys).toEqual([
      'provider:provider-1',
      'session:runtime-1',
      'tab:tab-1',
      'route:machine-1:ide:cursor-1',
    ])
  })

  it('falls back from provider session to runtime session to tab key to route id', () => {
    expect(buildConversationIdentity(createConversation({ providerSessionId: undefined })).canonicalKey).toBe('session:runtime-1')
    expect(buildConversationIdentity(createConversation({ providerSessionId: undefined, sessionId: undefined })).canonicalKey).toBe('tab:tab-1')
    expect(buildConversationIdentity(createConversation({ providerSessionId: undefined, sessionId: undefined, tabKey: '' })).canonicalKey).toBe('route:machine-1:ide:cursor-1')
  })

  it('builds stable target keys from notification/open-target payloads', () => {
    expect(buildConversationTargetKey({ providerSessionId: 'provider-1', sessionId: 'runtime-1', tabKey: 'tab-1' })).toBe('provider:provider-1')
    expect(buildConversationTargetKey({ sessionId: 'runtime-1', tabKey: 'tab-1' })).toBe('session:runtime-1')
    expect(buildConversationTargetKey({ tabKey: 'tab-1' })).toBe('tab:tab-1')
  })

  it('matches resumed conversations by provider session id even when runtime ids change', () => {
    const resumed = createConversation({ sessionId: 'runtime-2', providerSessionId: 'provider-1', tabKey: 'tab-2' })

    expect(conversationMatchesTarget(resumed, { providerSessionId: 'provider-1' })).toBe(true)
    expect(conversationMatchesTarget(resumed, { sessionId: 'runtime-1' })).toBe(false)
    expect(conversationMatchesTarget(resumed, { tabKey: 'tab-2' })).toBe(true)
  })

  it('reuses the same history session rule directly', () => {
    expect(getConversationHistorySessionId(createConversation())).toBe('provider-1')
    expect(getConversationHistorySessionId(createConversation({ providerSessionId: undefined }))).toBe('runtime-1')
  })

  it('read-safe history id SENDS a real distinct provider id but OMITS the runtime sessionId fallback (agy-coordinator poison)', () => {
    // A real, distinct provider conv id is sent as-is (legitimate exact-bind).
    expect(getConversationHistorySessionIdForRead(createConversation())).toBe('provider-1')
    // An explicit historySessionId distinct from the sessionId is sent as-is.
    expect(getConversationHistorySessionIdForRead(createConversation({
      providerSessionId: undefined,
      historySessionId: 'conv-uuid-xyz',
    }))).toBe('conv-uuid-xyz')
    // Agy coordinator: no providerSessionId surfaced → the ONLY candidate is the
    // runtime sessionId. getConversationHistorySessionId falls back to it (the
    // poison the browser used to send); the read-safe variant OMITS it (undefined)
    // so the daemon read runs its owner-confirmed native resolution instead.
    expect(getConversationHistorySessionId(createConversation({ providerSessionId: undefined }))).toBe('runtime-1')
    expect(getConversationHistorySessionIdForRead(createConversation({ providerSessionId: undefined }))).toBeUndefined()
    // Explicit historySessionId that merely echoes the runtime sessionId is also
    // the poison → omitted.
    expect(getConversationHistorySessionIdForRead(createConversation({
      providerSessionId: undefined,
      historySessionId: 'runtime-1',
    }))).toBeUndefined()
  })

  it('builds raw and prefixed lookup aliases for conversation targeting', () => {
    expect(buildConversationLookupKeys(createConversation())).toEqual([
      'provider:provider-1',
      'provider-1',
      'session:runtime-1',
      'runtime-1',
      'tab:tab-1',
      'tab-1',
      'route:machine-1:ide:cursor-1',
      'machine-1:ide:cursor-1',
    ])
  })

  it('keeps both provider and runtime ids for history-style matching', () => {
    expect(getConversationHistoryLookupIds(createConversation())).toEqual(['provider-1', 'runtime-1'])
    expect(getConversationHistoryLookupIds(createConversation({ providerSessionId: undefined }))).toEqual(['runtime-1'])
  })

  it('matches raw route id targets through the same helper contract', () => {
    expect(conversationMatchesTarget(createConversation(), { routeId: 'machine-1:ide:cursor-1' })).toBe(true)
  })
})

describe('DaemonData-level session identity SSOT (RF-CONVID)', () => {
  const ide = (partial: Partial<DaemonData>): DaemonData => partial as DaemonData

  describe('getDaemonEntrySessionSuffix', () => {
    it('strips the reporting-daemon prefix', () => {
      expect(getDaemonEntrySessionSuffix(ide({ daemonId: 'workerD', id: 'workerD:cli:s1' }))).toBe('cli:s1')
    })
    it('returns the id unchanged when it has no daemon prefix', () => {
      expect(getDaemonEntrySessionSuffix(ide({ daemonId: 'workerD', id: 'unprefixed' }))).toBe('unprefixed')
    })
  })

  describe('isMeshOwnedSessionCopy', () => {
    it('is true for any of the five mesh markers', () => {
      expect(isMeshOwnedSessionCopy(ide({ ownerDaemonId: 'workerD' }))).toBe(true)
      expect(isMeshOwnedSessionCopy(ide({ settings: { meshNodeFor: 'm1' } }))).toBe(true)
      expect(isMeshOwnedSessionCopy(ide({ settings: { meshNodeId: 'n1' } }))).toBe(true)
      expect(isMeshOwnedSessionCopy(ide({ settings: { launchedByCoordinator: true } }))).toBe(true)
      expect(isMeshOwnedSessionCopy(ide({ settings: { _remoteOwnedSession: true } }))).toBe(true)
    })
    it('is false for a marker-less worker copy', () => {
      expect(isMeshOwnedSessionCopy(ide({ daemonId: 'workerD', id: 'workerD:cli:s1' }))).toBe(false)
    })
  })

  describe('getIdeChatDedupeKey — ghost-tab collapse (Key 1)', () => {
    it('collapses the coordinator mirror and the marker-less worker copy of one mesh session into a single key', () => {
      const coordinatorCopy = ide({ id: 'coordD:cli:s1', daemonId: 'coordD', ownerDaemonId: 'workerD' })
      const workerCopy = ide({ id: 'workerD:cli:s1', daemonId: 'workerD' })
      // mesh suffixes are collected from mesh-owned copies, mirroring dedupeChatIdes
      const meshSuffixes = new Set<string>()
      for (const e of [coordinatorCopy, workerCopy]) {
        if (isMeshOwnedSessionCopy(e)) meshSuffixes.add(getDaemonEntrySessionSuffix(e))
      }
      const k1 = getIdeChatDedupeKey(coordinatorCopy, meshSuffixes)
      const k2 = getIdeChatDedupeKey(workerCopy, meshSuffixes)
      expect(k1).toBe('mesh:cli:s1')
      expect(k2).toBe('mesh:cli:s1')
      expect(k1).toBe(k2) // single tab, no ghost
    })
    it('keeps two unrelated non-mesh sessions on different daemons that share a raw session id distinct', () => {
      const a = ide({ id: 'd1:cli:x', daemonId: 'd1' })
      const b = ide({ id: 'd2:cli:x', daemonId: 'd2' })
      const empty = new Set<string>()
      expect(getIdeChatDedupeKey(a, empty)).toBe('d1:cli:x')
      expect(getIdeChatDedupeKey(b, empty)).toBe('d2:cli:x')
      expect(getIdeChatDedupeKey(a, empty)).not.toBe(getIdeChatDedupeKey(b, empty))
    })
  })

  describe('getMachineSessionDedupeKey — machine-card collapse (Key 2)', () => {
    it('collapses two reports of one session by raw sessionId regardless of reporting-daemon prefix', () => {
      expect(getMachineSessionDedupeKey({ sessionId: 's1', id: 'coordD:cli:s1' }))
        .toBe(getMachineSessionDedupeKey({ sessionId: 's1', id: 'workerD:cli:s1' }))
    })
    it('keeps different sessionIds distinct and falls back to id when sessionId is absent', () => {
      expect(getMachineSessionDedupeKey({ sessionId: 's1', id: 'a' })).not.toBe(getMachineSessionDedupeKey({ sessionId: 's2', id: 'a' }))
      expect(getMachineSessionDedupeKey({ id: 'only-id' })).toBe('only-id')
    })
  })

  describe('getConversationTabKey — dockview panel key (Key 3)', () => {
    it('prefers the route fallback key, then sessionId, then unknown', () => {
      expect(getConversationTabKey('s1', 'route-1')).toBe('route-1')
      expect(getConversationTabKey('s1', '')).toBe('s1')
      expect(getConversationTabKey(undefined, '')).toBe('unknown')
    })
  })

  describe('resolveOwnerMachineName — owner-machine fallback chain', () => {
    const names = { workerD: 'Worker Mac', coordD: 'Coordinator Mac' }
    it('prefers the resolved owning (worker) daemon machine name over the coordinator snapshot daemon', () => {
      expect(resolveOwnerMachineName(ide({ ownerDaemonId: 'workerD', daemonId: 'coordD' }), names)).toBe('Worker Mac')
    })
    it('falls back to an explicit ownerMachineName when the owner daemon is not in the map', () => {
      expect(resolveOwnerMachineName(ide({ ownerDaemonId: 'unknownD', ownerMachineName: 'Explicit', daemonId: 'coordD' }), names)).toBe('Explicit')
    })
    it('falls back to the snapshot daemon machine for an ordinary local session', () => {
      expect(resolveOwnerMachineName(ide({ daemonId: 'coordD' }), names)).toBe('Coordinator Mac')
    })
    it('returns undefined when nothing resolves', () => {
      expect(resolveOwnerMachineName(ide({ daemonId: 'ghost' }), names)).toBeUndefined()
    })
  })
})
