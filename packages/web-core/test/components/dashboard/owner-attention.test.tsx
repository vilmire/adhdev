// @vitest-environment jsdom
//
// Owner-attention park — dashboard hops. The daemon parks a CLI session on a
// prompt only the owner may answer (grok's "Help improve Grok" consent banner,
// a persistent workspace-trust prompt) as a buttonless `waiting_choice` with
// `ownerAttention: { stateId, message }` on the session row. These tests pin
// every web-core hop: status-transform -> reconcile -> conversation -> notice,
// including that the notice clears when the park does and never offers an
// answer button.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionEntry, StatusReportPayload } from '@adhdev/daemon-core'
import { statusPayloadToEntries } from '../../../src/utils/status-transform'
import { reconcileIdes } from '../../../src/context/BaseDaemonContext'
import { buildScopedIdeConversations } from '../../../src/components/dashboard/buildConversations'
import OwnerAttentionNotice from '../../../src/components/dashboard/OwnerAttentionNotice'
import ApprovalBanner from '../../../src/components/dashboard/ApprovalBanner'
import { BaseDaemonProvider } from '../../../src/context/BaseDaemonContext'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import type { DaemonData } from '../../../src/types'

const MARKER = { stateId: 'consent_banner', message: 'Owner attention: Grok data-retention consent' }

function cliSession(overrides: Record<string, unknown> = {}): SessionEntry {
  return {
    id: 'grok-1',
    parentId: null,
    providerType: 'grok-cli',
    providerName: 'Grok',
    kind: 'agent',
    transport: 'pty',
    status: 'waiting_choice',
    title: 'Grok',
    workspace: '/repo',
    activeChat: { id: 'grok-1', title: 'Grok', status: 'waiting_choice', messages: [], activeModal: null },
    activeInteractivePrompt: null,
    capabilities: [],
    ...overrides,
  } as unknown as SessionEntry
}

function payload(sessions: SessionEntry[], timestamp: number): StatusReportPayload {
  return {
    instanceId: 'daemon-1',
    version: '0.0.0',
    daemonMode: true,
    machine: { hostname: 'h', platform: 'darwin', arch: 'arm64', cpus: 1, totalMem: 1, freeMem: 1, loadavg: [0, 0, 0], uptime: 1, release: '1' },
    timestamp,
    detectedIdes: [],
    sessions,
  } as unknown as StatusReportPayload
}

function cliEntry(entries: DaemonData[]): DaemonData {
  const entry = entries.find((e) => e.id === 'daemon-1:cli:grok-1')
  if (!entry) throw new Error('cli entry missing')
  return entry
}

describe('status-transform — owner attention', () => {
  it('projects the park onto the CLI entry', () => {
    const entry = cliEntry(statusPayloadToEntries(payload([cliSession({ ownerAttention: MARKER })], 1), { daemonId: 'daemon-1' }))
    expect(entry.ownerAttention).toEqual(MARKER)
  })

  it('writes an explicit null when the row has no park (so merges clear it)', () => {
    const entry = cliEntry(statusPayloadToEntries(payload([cliSession({ status: 'idle' })], 1), { daemonId: 'daemon-1' }))
    expect(entry).toHaveProperty('ownerAttention', null)
  })
})

describe('reconcileIdes — owner attention clears', () => {
  it('a later rich snapshot without the park clears it', () => {
    const parked = statusPayloadToEntries(payload([cliSession({ ownerAttention: MARKER })], 1), { daemonId: 'daemon-1' })
    const cleared = statusPayloadToEntries(payload([cliSession({ status: 'idle' })], 2), { daemonId: 'daemon-1' })
    const prev = reconcileIdes(parked, [])
    expect(cliEntry(prev).ownerAttention).toEqual(MARKER)
    const next = reconcileIdes(cleared, prev)
    expect(cliEntry(next).ownerAttention).toBeNull()
  })

  it('a weak (compact) update with null clears it; one without the field keeps it', () => {
    const prev = reconcileIdes(statusPayloadToEntries(payload([cliSession({ ownerAttention: MARKER })], 1), { daemonId: 'daemon-1' }), [])
    const weakBase = { id: 'daemon-1:cli:grok-1', daemonId: 'daemon-1', type: 'grok-cli', status: 'waiting_choice', timestamp: 3 } as DaemonData
    const kept = reconcileIdes([weakBase], prev)
    expect(cliEntry(kept).ownerAttention).toEqual(MARKER)
    const cleared = reconcileIdes([{ ...weakBase, status: 'idle', ownerAttention: null }], prev)
    expect(cliEntry(cleared).ownerAttention).toBeNull()
  })
})

describe('buildConversations — owner attention', () => {
  it('carries the park onto the CLI conversation while waiting_choice, and null otherwise', () => {
    const parked = buildScopedIdeConversations(cliEntry(statusPayloadToEntries(payload([cliSession({ ownerAttention: MARKER })], 1), { daemonId: 'daemon-1' })))
    expect(parked[0].ownerAttention).toEqual(MARKER)
    expect(parked[0].modalButtons).toBeUndefined()

    const idle = buildScopedIdeConversations(cliEntry(statusPayloadToEntries(payload([cliSession({
      status: 'idle',
      activeChat: { id: 'grok-1', title: 'Grok', status: 'idle', messages: [], activeModal: null },
      ownerAttention: MARKER, // stale marker on a non-parked row must not surface
    })], 1), { daemonId: 'daemon-1' })))
    expect(idle[0].ownerAttention).toBeNull()
  })
})

function conv(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
  return {
    routeId: 'daemon-1:cli:grok-1',
    sessionId: 'grok-1',
    agentName: 'Grok',
    agentType: 'grok-cli',
    transport: 'pty',
    status: 'waiting_choice',
    title: 'Grok',
    messages: [],
    workspaceName: 'repo',
    displayPrimary: 'repo',
    displaySecondary: '',
    streamSource: 'native',
    tabKey: 'daemon-1:cli:grok-1',
    ownerAttention: MARKER,
    ...overrides,
  } as ActiveConversation
}

describe('OwnerAttentionNotice — render and clear', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const buttons = () => Array.from(container.querySelectorAll('button')).map((b) => b.textContent || '')

  it('shows the CLI message and the terminal guidance, with only an open-terminal button', () => {
    let opened = 0
    act(() => root.render(<OwnerAttentionNotice activeConv={conv()} onOpenTerminal={() => { opened += 1 }} />))
    const notice = container.querySelector('[data-testid="owner-attention-notice"]')
    expect(notice).not.toBeNull()
    expect(notice?.getAttribute('data-owner-attention-state')).toBe('consent_banner')
    expect(container.textContent).toContain(MARKER.message)
    expect(container.textContent).toContain('NEEDS YOUR ATTENTION')
    expect(container.textContent).toContain('respond in the terminal')
    expect(buttons()).toEqual(['Open terminal'])
    act(() => { (container.querySelector('button') as HTMLButtonElement).click() })
    expect(opened).toBe(1)
  })

  it('has no button at all without a terminal affordance or when already in the terminal view', () => {
    act(() => root.render(<OwnerAttentionNotice activeConv={conv()} />))
    expect(container.textContent).toContain(MARKER.message)
    expect(buttons()).toEqual([])
    act(() => root.render(<OwnerAttentionNotice activeConv={conv()} onOpenTerminal={() => {}} isTerminalView />))
    expect(buttons()).toEqual([])
  })

  it('renders nothing once the park clears', () => {
    act(() => root.render(<OwnerAttentionNotice activeConv={conv()} />))
    expect(container.textContent).not.toBe('')
    act(() => root.render(<OwnerAttentionNotice activeConv={conv({ ownerAttention: null, status: 'idle' })} />))
    expect(container.innerHTML).toBe('')
  })

  it('the approval banner offers nothing for the park (no approve/reject buttons)', () => {
    act(() => root.render(
      <BaseDaemonProvider>
        <ApprovalBanner activeConv={conv()} onModalButton={() => { throw new Error('must not be pressed') }} />
      </BaseDaemonProvider>,
    ))
    expect(buttons()).toEqual([])
  })
})
