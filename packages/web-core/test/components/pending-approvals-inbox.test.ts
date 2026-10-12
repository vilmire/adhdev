import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import PendingApprovalsInbox, { derivePendingApprovals, deriveApprovalsFromConversations, formatApprovalWait } from '../../src/components/MeshGraph/PendingApprovalsInbox'
import { deriveProviderApprovalInbox } from '../../src/components/MeshGraph/providerApprovalInbox'
import { buildConversations } from '../../src/components/dashboard/buildConversations'

const permission = { source: 'provider_modal', type: 'tool_permission', evidence: 'live', lifecycle: 'pending', modalKey: 'modal:one', createdAt: 8000, resolvedAt: null, actionable: true, sessionId: 's', providerType: 'grok-cli', description: '', buttons: ['Yes, proceed', 'No'], attemptId: 'a', generation: 1 } as const
const worker = (approval: any = permission) => ({ id: 'd:s', daemonId: 'd', machineId: 'd', sessionId: 's', type: 'grok-cli', transport: 'pty', status: 'waiting_approval', surfaceHidden: true, muted: true, activeChat: { id: 'c', status: 'waiting_approval', title: 'Worker', messages: [], activeModal: { message: 'always-approve', buttons: ['Yes, proceed', 'No'] }, providerApproval: approval } }) as any

describe('approvals-only provider Inbox', () => {
  it('includes hidden/muted worker real modal while ordinary chat stays hidden', () => {
    const ide = worker()
    expect(buildConversations([ide], [ide], { d: 'connected' })).toEqual([])
    const items = deriveProviderApprovalInbox([ide], { d: 'connected' })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ nodeId: 'd', sessionId: 's', actionable: true, waitingSince: 8000, approvalTarget: { modalKey: 'modal:one', attemptId: 'a', generation: 1 } })
    const html = renderToStaticMarkup(createElement(PendingApprovalsInbox, { approvals: items, onResolve: () => {} }))
    expect(html).toContain('Provider tool permission')
    expect(html).toContain('Approve')
    expect(html).not.toContain('always-approve')
    expect(html).toContain('/dashboard?activeTab=session%3As')
  })
  it('status-only waiting has no approval row or count in any derivation', () => {
    expect(deriveProviderApprovalInbox([worker(null)], { d: 'connected' })).toEqual([])
    expect(derivePendingApprovals([{ nodeId: 'n', activeSessionDetails: [{ sessionId: 's', state: 'awaiting_approval' }] }] as any)).toEqual([])
    expect(deriveApprovalsFromConversations([{ sessionId: 's', daemonId: 'd', status: 'waiting_approval' }])).toEqual([])
  })
  it('cached/disconnected evidence is explicit and offers no blind buttons', () => {
    for (const [approval, connections] of [[permission, {}], [{ ...permission, evidence: 'cached' }, { d: 'connected' }], [{ ...permission, evidence: 'unavailable' }, { d: 'connected' }], [{ ...permission, buttons: [] }, { d: 'connected' }]] as any) {
      const items = deriveProviderApprovalInbox([worker(approval)], connections)
      expect(items[0].actionable).toBe(false)
      expect(items[0].approvalTarget).toBeUndefined()
      const html = renderToStaticMarkup(createElement(PendingApprovalsInbox, { approvals: items, onResolve: () => {} }))
      expect(html).not.toContain('<button')
      expect(html).toContain('(0)')
    }
  })
  it('pre-claim trust remains visible as setup with no tool action or fabricated task', () => {
    const items = deriveProviderApprovalInbox([worker({ ...permission, type: 'provider_setup', actionable: false, attemptId: null, generation: null, taskId: null, runtimeDirectory: '/tmp/worktree', displayedDirectory: '/tmp/project' })], { d: 'connected' })
    expect(items[0]).toMatchObject({ approvalType: 'provider_setup', actionable: false })
    const html = renderToStaticMarkup(createElement(PendingApprovalsInbox, { approvals: items, onResolve: () => {} }))
    expect(html).toContain('Provider setup decision')
    expect(html).toContain('/tmp/worktree')
    expect(html).toContain('/tmp/project')
    expect(html).not.toContain('<button')
  })
  it('clears resolved modals and excludes question/proposal types', () => {
    expect(deriveProviderApprovalInbox([worker({ ...permission, source: 'owner_staged_proposal' })], { d: 'connected' })).toEqual([])
    expect(deriveProviderApprovalInbox([worker({ ...permission, lifecycle: 'resolved', resolvedAt: 9000 })], { d: 'connected' })).toEqual([])
    expect(deriveProviderApprovalInbox([{ ...worker(null), status: 'waiting_choice', activeInteractivePrompt: { promptId: 'q' } }, { ...worker(null), stagedProposal: { ownerOnly: true } }], { d: 'connected' })).toEqual([])
  })
  it('dedupes exact daemon/session and keeps independently actionable identities', () => {
    const items = deriveProviderApprovalInbox([worker({ ...permission, evidence: 'cached' }), worker()], { d: 'connected' })
    expect(items).toHaveLength(1)
    expect(items[0].approvalTarget?.modalKey).toBe('modal:one')
  })
})

describe('formatApprovalWait', () => {
  it('formats true suspension durations and omits unknown clocks', () => {
    expect(formatApprovalWait(10000, 55000)).toBe('45s')
    expect(formatApprovalWait(0, 720000)).toBe('12m')
    expect(formatApprovalWait(null, 1000)).toBeNull()
    expect(formatApprovalWait(5000, 1000)).toBeNull()
  })
})
