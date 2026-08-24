import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import PendingApprovalsInbox, {
  derivePendingApprovals,
  deriveApprovalsFromConversations,
  formatApprovalWait,
  type ApprovalConversationSource,
} from '../../src/components/MeshGraph/PendingApprovalsInbox'
import type { RepoMeshNodeStatus } from '@adhdev/daemon-core'

function node(overrides: Partial<RepoMeshNodeStatus> = {}): RepoMeshNodeStatus {
  return {
    nodeId: overrides.nodeId ?? 'node-1',
    machineLabel: overrides.machineLabel ?? 'MacBook · adhdev',
    workspace: overrides.workspace ?? '/tmp/ws',
    health: overrides.health ?? 'online',
    providers: overrides.providers ?? ['codex-cli'],
    activeSessions: overrides.activeSessions ?? [],
    activeSessionDetails: overrides.activeSessionDetails,
  } as RepoMeshNodeStatus
}

describe('derivePendingApprovals', () => {
  it('extracts sessions whose status text indicates an approval is blocking', () => {
    const items = derivePendingApprovals([
      node({
        nodeId: 'node-a',
        machineLabel: 'Node A',
        activeSessionDetails: [
          { sessionId: 'sess-approval', providerType: 'claude-cli', state: 'awaiting_approval', statusNote: 'Run rm -rf?' },
          { sessionId: 'sess-generating', providerType: 'claude-cli', state: 'generating' },
        ],
      }),
      node({ nodeId: 'node-b', activeSessionDetails: [{ sessionId: 'sess-idle', state: 'idle' }] }),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      nodeId: 'node-a',
      sessionId: 'sess-approval',
      providerType: 'claude-cli',
      // Both axes since the 2026-08-24 label separation: an approval must name
      // WHICH checkout is asking, not just the machine ("ws" = the fixture
      // node's workspace basename).
      machineLabel: 'ws · Node A',
      detail: 'Run rm -rf?',
    })
  })

  it('detects approval via chatStatus too, and skips sessions without a sessionId', () => {
    const items = derivePendingApprovals([
      node({
        activeSessionDetails: [
          { sessionId: 'sess-chat', chatStatus: 'waiting_approval' } as any,
          { sessionId: '', state: 'awaiting_approval' } as any,
        ],
      }),
    ])
    expect(items.map(i => i.sessionId)).toEqual(['sess-chat'])
  })

  it('returns empty for no nodes / no approvals', () => {
    expect(derivePendingApprovals(undefined)).toEqual([])
    expect(derivePendingApprovals([node({ activeSessionDetails: [{ sessionId: 's', state: 'idle' }] })])).toEqual([])
  })
})

describe('deriveApprovalsFromConversations (cross-machine)', () => {
  const conv = (o: Partial<ApprovalConversationSource>): ApprovalConversationSource => ({
    sessionId: 'sess', daemonId: 'daemon-1', status: 'waiting_approval', ...o,
  })

  it('collects waiting_approval sessions from every machine, with modal detail and options', () => {
    const items = deriveApprovalsFromConversations([
      conv({
        sessionId: 's1', daemonId: 'daemon-mac', machineName: 'MacBook', agentType: 'claude-cli',
        modalMessage: 'Run rm -rf /tmp?', modalButtons: ['Yes', 'No'], lastUpdated: 1_000,
      }),
      conv({
        sessionId: 's2', daemonId: 'daemon-win', machineName: 'WinBox', status: 'generating',
      }),
      conv({ sessionId: 's3', daemonId: 'daemon-linux', machineName: 'Linux', lastUpdated: 2_000 }),
    ])
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      nodeId: 'daemon-mac', sessionId: 's1', machineLabel: 'MacBook',
      providerType: 'claude-cli', detail: 'Run rm -rf /tmp?', options: ['Yes', 'No'], waitingSince: 1_000,
    })
    // Spans machines — two different daemons in one list.
    expect(items.map(i => i.nodeId)).toEqual(['daemon-mac', 'daemon-linux'])
  })

  it('sorts longest-waiting first', () => {
    const items = deriveApprovalsFromConversations([
      conv({ sessionId: 'recent', daemonId: 'd1', lastUpdated: 9_000 }),
      conv({ sessionId: 'oldest', daemonId: 'd2', lastUpdated: 1_000 }),
      conv({ sessionId: 'middle', daemonId: 'd3', lastUpdated: 5_000 }),
    ])
    expect(items.map(i => i.sessionId)).toEqual(['oldest', 'middle', 'recent'])
  })

  it('falls back to title when the modal detail has not been hydrated', () => {
    // The live P2P status profile strips activeModal, so an unopened session has no
    // modalMessage — it must still list, identified by its title.
    const items = deriveApprovalsFromConversations([
      conv({ sessionId: 's', daemonId: 'd', title: 'refactor auth', modalMessage: undefined }),
    ])
    expect(items[0].detail).toBe('refactor auth')
    expect(items[0].options).toBeUndefined()
  })

  it('dedupes repeated node+session pairs and skips unroutable rows', () => {
    const items = deriveApprovalsFromConversations([
      conv({ sessionId: 'dup', daemonId: 'd1' }),
      conv({ sessionId: 'dup', daemonId: 'd1' }),
      { status: 'waiting_approval' },
    ])
    expect(items).toHaveLength(1)
  })

  it('returns empty for nullish or non-approval input', () => {
    expect(deriveApprovalsFromConversations(undefined)).toEqual([])
    expect(deriveApprovalsFromConversations([conv({ status: 'idle' })])).toEqual([])
  })
})

describe('formatApprovalWait', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatApprovalWait(10_000, 55_000)).toBe('45s')
    expect(formatApprovalWait(0, 12 * 60_000)).toBe('12m')
    expect(formatApprovalWait(0, (3 * 60 + 4) * 60_000)).toBe('3h 04m')
  })

  it('returns null when there is no usable timestamp', () => {
    expect(formatApprovalWait(null, 1_000)).toBeNull()
    expect(formatApprovalWait(undefined, 1_000)).toBeNull()
    // A clock skew must not render a negative age.
    expect(formatApprovalWait(5_000, 1_000)).toBeNull()
  })
})

describe('PendingApprovalsInbox render', () => {
  it('renders nothing when empty and hideWhenEmpty (default)', () => {
    const html = renderToStaticMarkup(
      createElement(PendingApprovalsInbox, { approvals: [], onResolve: () => {} }),
    )
    expect(html).toBe('')
  })

  it('renders a row with Approve/Reject per pending approval', () => {
    const html = renderToStaticMarkup(
      createElement(PendingApprovalsInbox, {
        approvals: [{ nodeId: 'node-1', sessionId: 'sess-1', providerType: 'codex-cli', machineLabel: 'Box One', detail: 'Approve write?' }],
        onResolve: () => {},
      }),
    )
    expect(html).toContain('PENDING APPROVALS')
    expect(html).toContain('Box One')
    expect(html).toContain('Approve')
    expect(html).toContain('Reject')
    expect(html).toContain('Approve write?')
  })

  it('renders the wait age and the modal button labels when present', () => {
    const html = renderToStaticMarkup(
      createElement(PendingApprovalsInbox, {
        approvals: [{
          nodeId: 'node-1', sessionId: 'sess-1', machineLabel: 'Box One',
          detail: 'Approve write?', waitingSince: 1_000, options: ['Yes, run it', 'No'],
        }],
        onResolve: () => {},
        nowMs: 1_000 + 5 * 60_000,
      }),
    )
    expect(html).toContain('5m')
    expect(html).toContain('Yes, run it')
    expect(html).toContain('No')
  })

  it('renders the empty state when hideWhenEmpty is off (the page surface)', () => {
    const html = renderToStaticMarkup(
      createElement(PendingApprovalsInbox, { approvals: [], onResolve: () => {}, hideWhenEmpty: false }),
    )
    expect(html).toContain('PENDING APPROVALS')
    expect(html).toContain('No sessions are awaiting an approval decision.')
  })

  it('derives from nodes when approvals prop is omitted', () => {
    const html = renderToStaticMarkup(
      createElement(PendingApprovalsInbox, {
        nodes: [node({ machineLabel: 'Derived Node', activeSessionDetails: [{ sessionId: 's', state: 'awaiting_approval' }] })],
        onResolve: () => {},
      }),
    )
    expect(html).toContain('Derived Node')
    expect(html).toContain('(1)')
  })
})
