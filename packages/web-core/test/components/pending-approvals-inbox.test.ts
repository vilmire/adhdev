import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import PendingApprovalsInbox, { derivePendingApprovals } from '../../src/components/MeshGraph/PendingApprovalsInbox'
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
      machineLabel: 'Node A',
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
