import { describe, expect, it } from 'vitest'
import { expandCompactDaemons, reconcileIdes, type CompactDaemonCompat } from '../../src/context/BaseDaemonContext'

describe('expandCompactDaemons', () => {
  it('expands compact daemon sessions and preserves summary metadata', () => {
    const result = expandCompactDaemons([
      {
        id: 'machine-1',
        type: 'adhdev-daemon',
        timestamp: 100,
        sessions: [
          {
            id: 'acp-1',
            parentId: null,
            providerType: 'claude-code',
            providerName: 'Claude Code',
            kind: 'agent',
            transport: 'acp',
            status: 'idle',
            title: 'Claude Code',
            workspace: '/repo',
            summaryMetadata: {
              items: [{ id: 'model', label: 'Model', value: 'Sonnet', order: 10 }],
            },
          },
        ],
      },
    ] as CompactDaemonCompat[])

    expect(result.entries).toEqual([
      expect.objectContaining({ id: 'machine-1', type: 'adhdev-daemon' }),
      expect.objectContaining({
        id: 'machine-1:acp:acp-1',
        sessionId: 'acp-1',
        summaryMetadata: {
          items: [{ id: 'model', label: 'Model', value: 'Sonnet', order: 10 }],
        },
      }),
    ])
  })

  it('preserves top-level cli and acp control metadata for standalone conversations', () => {
    const providerControls = [{ id: 'provider', type: 'select', label: 'Provider', placement: 'bar' }]
    const controlValues = { provider: 'auto' }
    const result = expandCompactDaemons([
      {
        id: 'machine-2',
        type: 'standalone',
        timestamp: 200,
        sessions: [
          {
            id: 'ide-1',
            parentId: null,
            providerType: 'antigravity',
            providerName: 'Antigravity',
            kind: 'workspace',
            transport: 'cdp-page',
            status: 'idle',
            title: 'Workspace',
            workspace: '/repo',
            activeChat: {
              id: 'active-session',
              title: 'Workspace',
              status: 'idle',
              messages: [],
              activeModal: null,
            },
            capabilities: ['read_chat', 'send_message'],
            providerControls,
            controlValues,
          },
          {
            id: 'cli-1',
            parentId: null,
            providerType: 'hermes-cli',
            providerName: 'Hermes Agent',
            kind: 'agent',
            transport: 'pty',
            status: 'idle',
            title: 'Hermes Agent',
            workspace: '/repo',
            activeChat: {
              id: 'chat-1',
              title: 'Hermes Agent',
              status: 'idle',
              messages: [],
              activeModal: null,
            },
            capabilities: ['read_chat', 'send_message'],
            providerControls,
            controlValues,
            providerSessionId: 'sess-1',
          },
          {
            id: 'acp-1',
            parentId: null,
            providerType: 'claude-code',
            providerName: 'Claude Code',
            kind: 'agent',
            transport: 'acp',
            status: 'idle',
            title: 'Claude Code',
            workspace: '/repo',
            capabilities: ['read_chat'],
            providerControls,
            controlValues,
          },
        ],
      },
    ] as CompactDaemonCompat[])

    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'machine-2:ide:ide-1',
        transport: 'cdp-page',
        providerControls,
        controlValues,
        sessionCapabilities: ['read_chat', 'send_message'],
      }),
      expect.objectContaining({
        id: 'machine-2:cli:cli-1',
        transport: 'pty',
        mode: 'chat',
        agentType: 'hermes-cli',
        providerSessionId: 'sess-1',
        providerControls,
        controlValues,
        sessionCapabilities: ['read_chat', 'send_message'],
        _isCli: true,
      }),
      expect.objectContaining({
        id: 'machine-2:acp:acp-1',
        transport: 'acp',
        mode: 'chat',
        agentType: 'claude-code',
        providerControls,
        controlValues,
        sessionCapabilities: ['read_chat'],
        _isAcp: true,
      }),
    ]))
  })

  it('preserves child providerName through sparse compact updates after reconcile', () => {
    const metadata = expandCompactDaemons([
      {
        id: 'machine-3',
        type: 'adhdev-daemon',
        timestamp: 300,
        sessions: [
          {
            id: 'ide-1',
            parentId: null,
            providerType: 'antigravity',
            providerName: 'Antigravity',
            kind: 'workspace',
            transport: 'cdp-page',
            status: 'idle',
            title: 'Workspace',
            activeChat: {
              id: 'chat-1',
              title: 'Workspace',
              status: 'idle',
              messages: [],
              activeModal: null,
            },
            cdpConnected: true,
          },
          {
            id: 'child-1',
            parentId: 'ide-1',
            providerType: 'claude-code-vscode',
            providerName: 'Claude Code (VS Code)',
            kind: 'agent',
            transport: 'cdp-webview',
            status: 'idle',
            title: 'Claude Code (VS Code)',
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries

    const sparse = expandCompactDaemons([
      {
        id: 'machine-3',
        type: 'adhdev-daemon',
        timestamp: 301,
        sessions: [
          {
            id: 'ide-1',
            parentId: null,
            providerType: 'antigravity',
            kind: 'workspace',
            transport: 'cdp-page',
            status: 'idle',
            title: 'Workspace',
            activeChat: {
              id: 'chat-1',
              title: 'Workspace',
              status: 'idle',
              messages: [],
              activeModal: null,
            },
            cdpConnected: true,
          },
          {
            id: 'child-1',
            parentId: 'ide-1',
            providerType: 'claude-code-vscode',
            kind: 'agent',
            transport: 'cdp-webview',
            status: 'idle',
            title: 'Claude Code (VS Code)',
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries

    const reconciled = reconcileIdes(sparse, metadata, { authoritativeDaemonIds: ['machine-3'] })
    const ideEntry = reconciled.find((entry) => entry.id === 'machine-3:ide:ide-1')

    expect(ideEntry?.childSessions?.[0]).toMatchObject({
      id: 'child-1',
      providerType: 'claude-code-vscode',
      providerName: 'Claude Code (VS Code)',
    })
  })

  it('preserves top-level cli activeChat when a compact reconcile update omits activeChat entirely', () => {
    const rich = expandCompactDaemons([
      {
        id: 'machine-4',
        type: 'adhdev-daemon',
        timestamp: 400,
        sessions: [
          {
            id: 'cli-1',
            parentId: null,
            providerType: 'hermes-cli',
            providerName: 'Hermes Agent',
            kind: 'agent',
            transport: 'pty',
            status: 'idle',
            title: 'Hermes Agent',
            workspace: '/repo',
            activeChat: {
              id: 'chat-1',
              title: 'Hermes Agent',
              status: 'idle',
              messages: [
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'world' },
              ],
              activeModal: null,
            },
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries

    const sparse = expandCompactDaemons([
      {
        id: 'machine-4',
        type: 'adhdev-daemon',
        timestamp: 401,
        sessions: [
          {
            id: 'cli-1',
            parentId: null,
            providerType: 'hermes-cli',
            providerName: 'Hermes Agent',
            kind: 'agent',
            transport: 'pty',
            status: 'idle',
            title: 'Hermes Agent',
            workspace: '/repo',
            lastMessagePreview: 'world',
            lastMessageRole: 'assistant',
            lastMessageAt: 401,
            lastMessageHash: 'hash-1',
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries

    const reconciled = reconcileIdes(sparse, rich, { authoritativeDaemonIds: ['machine-4'] })
    const cliEntry = reconciled.find((entry) => entry.id === 'machine-4:cli:cli-1')

    expect(cliEntry?.activeChat?.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ])
  })

  it('adopts compact summary metadata updates without discarding an existing top-level cli transcript', () => {
    const rich = expandCompactDaemons([
      {
        id: 'machine-5',
        type: 'adhdev-daemon',
        timestamp: 500,
        sessions: [
          {
            id: 'cli-1',
            parentId: null,
            providerType: 'hermes-cli',
            providerName: 'Hermes Agent',
            kind: 'agent',
            transport: 'pty',
            status: 'idle',
            title: 'Old Title',
            workspace: '/old-repo',
            activeChat: {
              id: 'chat-1',
              title: 'Old Title',
              status: 'idle',
              messages: [
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'world' },
              ],
              activeModal: null,
            },
            summaryMetadata: {
              items: [{ id: 'model', value: 'old-model' }],
            },
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries

    const sparse = expandCompactDaemons([
      {
        id: 'machine-5',
        type: 'adhdev-daemon',
        timestamp: 501,
        sessions: [
          {
            id: 'cli-1',
            parentId: null,
            providerType: 'hermes-cli',
            providerName: 'Hermes Agent',
            kind: 'agent',
            transport: 'pty',
            status: 'idle',
            title: 'New Title',
            workspace: '/new-repo',
            summaryMetadata: {
              items: [{ id: 'model', value: 'new-model' }],
            },
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries

    const reconciled = reconcileIdes(sparse, rich, { authoritativeDaemonIds: ['machine-5'] })
    const cliEntry = reconciled.find((entry) => entry.id === 'machine-5:cli:cli-1')

    expect(cliEntry?.activeChat?.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ])
    expect(cliEntry).toMatchObject({
      title: 'New Title',
      workspace: '/new-repo',
      summaryMetadata: {
        items: [{ id: 'model', value: 'new-model' }],
      },
    })
  })

  it('does not stale-delete live session entries when a cloud daemon_status update only includes daemon-level metadata', () => {
    const previous = expandCompactDaemons([
      {
        id: 'machine-6',
        type: 'adhdev-daemon',
        timestamp: 600,
        sessions: [
          {
            id: 'cli-1',
            parentId: null,
            providerType: 'hermes-cli',
            providerName: 'Hermes Agent',
            kind: 'agent',
            transport: 'pty',
            status: 'idle',
            title: 'Hermes Agent',
            workspace: '/repo',
            activeChat: {
              id: 'chat-1',
              title: 'Hermes Agent',
              status: 'idle',
              messages: [
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'world' },
              ],
              activeModal: null,
            },
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries.map((entry) => (
      entry.id === 'machine-6:cli:cli-1'
        ? { ...entry, _lastUpdate: 1 }
        : entry
    ))

    const daemonOnly = expandCompactDaemons([
      {
        id: 'machine-6',
        type: 'adhdev-daemon',
        timestamp: 601,
        p2p: {
          available: true,
          state: 'connected',
          peers: 2,
          screenshotActive: false,
        },
      },
    ] as CompactDaemonCompat[]).entries

    const reconciled = reconcileIdes(daemonOnly, previous)
    const cliEntry = reconciled.find((entry) => entry.id === 'machine-6:cli:cli-1')

    expect(cliEntry).toBeTruthy()
    expect(cliEntry?.activeChat?.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ])
  })
})
