// Owner-attention park — hop 2: CLI provider state -> session entry (the
// daemon.metadata dashboard lane, P2P / standalone), and the cloud boundary.
//
// `ownerAttention.message` is provider-authored text, so it may ride the rich
// P2P / standalone snapshot but must NEVER reach the server: the cloud status
// payload is an allow-list over RoutingSessionEntry, which does not declare it.
import { describe, expect, it } from 'vitest'
import { buildOwnerAttentionField, buildSessionEntries } from '../../src/status/builders.js'
import { buildCloudStatusReportPayload } from '../../src/status/reporter.js'
import { buildStatusSnapshot } from '../../src/status/snapshot.js'

const MARKER = { stateId: 'consent_banner', message: 'Owner attention: Grok data-retention consent' }

function cli(instanceId: string, status: string, ownerAttention: unknown) {
  return {
    category: 'cli', type: 'grok-cli', name: 'Grok', instanceId, mode: 'terminal', settings: {},
    status, workspace: '/tmp/ws', activeChat: null, lastUpdated: 1, pendingEvents: [],
    ownerAttention,
  } as any
}

describe('buildOwnerAttentionField', () => {
  it('projects the marker only for waiting_choice', () => {
    expect(buildOwnerAttentionField(MARKER, 'waiting_choice')).toEqual({ ownerAttention: MARKER })
    expect(buildOwnerAttentionField(MARKER, 'idle')).toEqual({})
    expect(buildOwnerAttentionField(null, 'waiting_choice')).toEqual({})
    expect(buildOwnerAttentionField({ stateId: '', message: 'x' }, 'waiting_choice')).toEqual({})
  })
})

describe('buildSessionEntries — owner attention', () => {
  for (const profile of ['full', 'live', 'metadata'] as const) {
    it(`carries the park on the ${profile} profile and omits it when cleared`, () => {
      const sessions = buildSessionEntries([
        cli('parked', 'waiting_choice', MARKER),
        cli('clear', 'idle', null),
      ], new Map(), { profile })
      const byId = new Map(sessions.map((s) => [s.id, s]))
      expect(byId.get('parked')).toMatchObject({ status: 'waiting_choice', ownerAttention: MARKER })
      // Absent (not null) so a non-parked row is byte-identical to before; the
      // keyed delta's unsetFields clears it downstream.
      expect(byId.get('clear')).not.toHaveProperty('ownerAttention')
    })
  }

  it('survives the live-profile snapshot projection', () => {
    const snapshot = buildStatusSnapshot({
      allStates: [cli('parked', 'waiting_choice', MARKER)],
      cdpManagers: new Map(),
      instanceId: 'daemon-1',
      version: '0.0.0',
      daemonMode: true,
      timestamp: 1,
      p2p: { available: false, state: 'unavailable', peers: 0, screenshotActive: false },
      profile: 'live',
    } as any)
    const session = snapshot.sessions.find((s: any) => s.id === 'parked')
    expect(session?.ownerAttention).toEqual(MARKER)
  })

  it('never forwards the marker (or its text) on the cloud status path', () => {
    const sessions = buildSessionEntries([cli('parked', 'waiting_choice', MARKER)], new Map(), { profile: 'metadata' })
    const payload = buildCloudStatusReportPayload(sessions, undefined, 1)
    for (const session of payload.sessions) expect(session).not.toHaveProperty('ownerAttention')
    const wire = JSON.stringify(payload)
    expect(wire).not.toContain('ownerAttention')
    expect(wire).not.toContain('data-retention consent')
    expect(wire).not.toContain('consent_banner')
  })
})
