// 2026-10-02: a manual-approval claude-cli session sat on waiting_approval and
// the dashboard showed "Waiting for approval" with no approval card. The
// daemon.metadata lane — the only lane carrying session state to dashboards —
// is built with the `metadata` profile, which stripped activeChat.activeModal.
import { describe, expect, it } from 'vitest'
import { buildSessionEntries } from '../../src/status/builders.js'

const MODAL = { message: 'Bash command', buttons: ['Yes', "Yes, and don't ask again", 'No'] }
const state = {
  category: 'cli', type: 'claude-cli', name: 'Claude', instanceId: 'cli-1', mode: 'chat',
  status: 'waiting_approval', workspace: '/repo', settings: {}, lastUpdated: 1, pendingEvents: [],
  activeChat: { id: 'c1', title: 'repo', status: 'waiting_approval', messages: [], activeModal: MODAL },
} as any

describe('activeModal per status profile', () => {
  it('the metadata profile (dashboard lane) carries the approval modal', () => {
    const [entry] = buildSessionEntries([state], new Map(), { profile: 'metadata' })
    expect(entry.activeChat?.activeModal).toEqual(MODAL)
  })

  it('the live profile (server status report) still strips it', () => {
    const [entry] = buildSessionEntries([state], new Map(), { profile: 'live' })
    expect(entry.activeChat?.activeModal).toBeNull()
  })
})
