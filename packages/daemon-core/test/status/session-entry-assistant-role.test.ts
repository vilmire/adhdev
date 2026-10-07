import { describe, expect, it } from 'vitest'
import { buildAssistantRoleFields, buildSessionEntries } from '../../src/status/builders.js'
import { buildCloudStatusReportPayload } from '../../src/status/reporter.js'

// Assistant layer (design 2026-10-07-assistant-layer.md §4.6): the dashboard
// lane (daemon.metadata, built with profile 'metadata') carries `assistant` /
// `managedByAssistant` so the session list can pin and mark the assistant. The
// flags are P2P / local only — the cloud status payload never carries them.

const base = { status: 'idle', workspace: '/home/u/.adhdev/assistant', activeChat: null, lastUpdated: 1, pendingEvents: [] }

function cli(instanceId: string, settings: Record<string, unknown>) {
  return { ...base, category: 'cli', type: 'claude-cli', name: 'Claude', instanceId, mode: 'chat', settings } as any
}

describe('buildAssistantRoleFields', () => {
  it('projects only true flags', () => {
    expect(buildAssistantRoleFields({ assistant: true })).toEqual({ assistant: true })
    expect(buildAssistantRoleFields({ managedByAssistant: true })).toEqual({ managedByAssistant: true })
    expect(buildAssistantRoleFields({ assistant: 'yes', managedByAssistant: 1 })).toEqual({})
    expect(buildAssistantRoleFields(undefined)).toEqual({})
  })
})

describe('buildSessionEntries — assistant role on the metadata profile', () => {
  const sessions = buildSessionEntries([
    cli('asst-1', { assistant: true }),
    cli('coord-1', { meshCoordinatorFor: 'mesh-a', managedByAssistant: true }),
    cli('plain-1', {}),
  ], new Map(), { profile: 'metadata' })
  const byId = new Map(sessions.map((s) => [s.id, s]))

  it('marks the assistant and assistant-managed coordinators', () => {
    expect(byId.get('asst-1')).toMatchObject({ assistant: true })
    expect(byId.get('asst-1')).not.toHaveProperty('managedByAssistant')
    expect(byId.get('coord-1')).toMatchObject({ managedByAssistant: true, coordinator: { meshId: 'mesh-a' } })
    expect(byId.get('coord-1')).not.toHaveProperty('assistant')
  })

  it('leaves ordinary sessions without the fields', () => {
    expect(byId.get('plain-1')).not.toHaveProperty('assistant')
    expect(byId.get('plain-1')).not.toHaveProperty('managedByAssistant')
  })

  it('never forwards the flags on the cloud status path', () => {
    const payload = buildCloudStatusReportPayload(sessions, undefined, 1)
    for (const session of payload.sessions) {
      expect(session).not.toHaveProperty('assistant')
      expect(session).not.toHaveProperty('managedByAssistant')
    }
    expect(JSON.stringify(payload)).not.toContain('managedByAssistant')
  })
})
