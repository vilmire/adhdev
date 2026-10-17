// @vitest-environment jsdom
//
// Owner Inbox one-tap: a live tool-permission request shows the provider's real
// buttons (narrowest one-time option first, declines styled as such, standing
// grants last with a warning). Tapping one sends its EXACT label + original
// index together with the episode's approvalTarget; requests without button
// data keep plain Approve/Reject.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import PendingApprovalsInbox, { type PendingApprovalItem } from '../../src/components/MeshGraph/PendingApprovalsInbox'
import { deriveProviderApprovalInbox } from '../../src/components/MeshGraph/providerApprovalInbox'
import { orderInboxProviderButtons } from '../../src/components/MeshGraph/providerApprovalButtons'

const BUTTONS = ["Yes, and don't ask again for npm test", 'Yes', 'No, and tell Claude what to do differently']
const permission = { source: 'provider_modal', type: 'tool_permission', evidence: 'live', lifecycle: 'pending', modalKey: 'modal:one', createdAt: 8000, resolvedAt: null, actionable: true, sessionId: 's', providerType: 'claude-cli', description: '', buttons: BUTTONS, attemptId: 'a', generation: 1 }
const worker = (approval: any = permission) => ({ id: 'd:s', daemonId: 'd', machineId: 'd', sessionId: 's', type: 'claude-cli', transport: 'pty', status: 'waiting_approval', activeChat: { id: 'c', status: 'waiting_approval', title: 'Worker', messages: [], activeModal: { message: 'Run npm test?', buttons: approval?.buttons ?? [] }, providerApproval: approval } }) as any
const target = { modalKey: 'modal:one', attemptId: 'a', generation: 1 }

describe('orderInboxProviderButtons', () => {
  it('orders one-time first, declines next, standing grants last and keeps original indices', () => {
    expect(orderInboxProviderButtons(BUTTONS)).toEqual([
      { label: 'Yes', index: 1, kind: 'once', action: 'approve' },
      { label: 'No, and tell Claude what to do differently', index: 2, kind: 'decline', action: 'reject' },
      { label: "Yes, and don't ask again for npm test", index: 0, kind: 'standing', action: 'approve' },
    ])
    expect(orderInboxProviderButtons(['Run (once)', 'Add Shell(git status) to allowlist?', 'Run Everything', 'Skip']).map(b => [b.label, b.kind]))
      .toEqual([['Run (once)', 'once'], ['Skip', 'decline'], ['Add Shell(git status) to allowlist?', 'standing'], ['Run Everything', 'standing']])
    expect(orderInboxProviderButtons(undefined)).toEqual([])
  })
})

describe('PendingApprovalsInbox provider buttons', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const render = (approvals: PendingApprovalItem[], onResolve: any) => act(() => { root.render(<PendingApprovalsInbox approvals={approvals} onResolve={onResolve} nowMs={9000} />) })
  const buttons = () => [...container.querySelectorAll('button')]

  it('renders the real buttons in safe order with a standing-grant warning', () => {
    render(deriveProviderApprovalInbox([worker()], { d: 'connected' }), vi.fn())
    expect(buttons().map(b => [b.textContent, b.dataset.approvalKind, b.dataset.buttonIndex])).toEqual([
      ['Yes', 'once', '1'],
      ['No, and tell Claude what to do differently', 'decline', '2'],
      ["Yes, and don't ask again for npm test", 'standing', '0'],
    ])
    expect(buttons()[1].className).toContain('bg-red-500/30')
    expect(container.textContent).toContain('Standing grant — keeps applying after this request')
    expect(container.textContent).not.toContain('Approve')
    expect(container.textContent).not.toContain('Run npm test?')
  })

  it('sends the exact label and index with the approvalTarget and matching action', async () => {
    const onResolve = vi.fn(async () => {})
    render(deriveProviderApprovalInbox([worker()], { d: 'connected' }), onResolve)
    await act(async () => { buttons()[2].click() })
    expect(onResolve).toHaveBeenCalledExactlyOnceWith('d', 's', 'approve', target, { button: "Yes, and don't ask again for npm test", buttonIndex: 0 })
    onResolve.mockClear()
    await act(async () => { buttons()[1].click() })
    expect(onResolve).toHaveBeenCalledExactlyOnceWith('d', 's', 'reject', target, { button: 'No, and tell Claude what to do differently', buttonIndex: 2 })
  })

  it('falls back to plain Approve/Reject without button data, sending no exact button', async () => {
    const onResolve = vi.fn(async () => {})
    const item: PendingApprovalItem = { nodeId: 'd', sessionId: 's', actionable: true, approvalTarget: target, approvalType: 'tool_permission', evidence: 'live' }
    render([item], onResolve)
    expect(buttons().map(b => b.textContent)).toEqual(['Approve', 'Reject'])
    await act(async () => { buttons()[0].click() })
    expect(onResolve).toHaveBeenCalledExactlyOnceWith('d', 's', 'approve', target)
  })

  it('offers no provider buttons for a non-actionable (cached) request', () => {
    render(deriveProviderApprovalInbox([worker({ ...permission, evidence: 'cached' })], { d: 'connected' }), vi.fn())
    expect(buttons()).toEqual([])
  })
})
