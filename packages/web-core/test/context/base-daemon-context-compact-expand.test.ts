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

  it('preserves active interactive prompts from compact daemon sessions', () => {
    const prompt = {
      promptId: 'prompt-1',
      origin: 'cli' as const,
      providerType: 'claude-cli',
      createdAt: 123,
      questions: [{
        questionId: 'q1',
        question: 'Approve?',
        multiSelect: false,
        options: [{ label: 'Yes' }],
      }],
    }
    const result = expandCompactDaemons([
      {
        id: 'machine-prompt',
        type: 'adhdev-daemon',
        timestamp: 100,
        sessions: [
          {
            id: 'cli-1',
            parentId: null,
            providerType: 'claude-cli',
            providerName: 'Claude',
            kind: 'agent',
            transport: 'pty',
            status: 'waiting_approval',
            title: 'Claude',
            workspace: '/repo',
            activeInteractivePrompt: prompt,
          },
        ],
      },
    ] as CompactDaemonCompat[])

    expect(result.entries.find(entry => entry.id === 'machine-prompt:cli:cli-1')).toMatchObject({
      activeInteractivePrompt: prompt,
    })
  })

  it('clones active chat message arrays from compact payloads so appended transcript tails force a reconcile', () => {
    const sharedMessages = [
      { role: 'assistant' as const, content: 'older reply', id: 'msg-1', receivedAt: 1 },
    ]
    const buildPayload = (timestamp: number) => ([
      {
        id: 'machine-chat',
        type: 'adhdev-daemon',
        timestamp,
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
              messages: sharedMessages,
              activeModal: null,
            },
          },
        ],
      },
    ] as CompactDaemonCompat[])

    const previous = expandCompactDaemons(buildPayload(100)).entries
    const previousEntry = previous.find(entry => entry.id === 'machine-chat:cli:cli-1')
    expect(previousEntry?.activeChat?.messages).toHaveLength(1)
    expect(previousEntry?.activeChat?.messages).not.toBe(sharedMessages)

    sharedMessages.push({ role: 'assistant', content: 'latest reply', id: 'msg-2', receivedAt: 2 })

    expect(previousEntry?.activeChat?.messages).toHaveLength(1)

    const incoming = expandCompactDaemons(buildPayload(101)).entries
    const reconciled = reconcileIdes(incoming, previous)
    const nextEntry = reconciled.find(entry => entry.id === 'machine-chat:cli:cli-1')

    expect(nextEntry).toBeTruthy()
    expect(nextEntry).not.toBe(previousEntry)
    expect(nextEntry?.activeChat?.messages.map(message => message.id)).toEqual(['msg-1', 'msg-2'])
  })

  it('preserves preview update policy fields from cloud compact daemon payloads', () => {
    const result = expandCompactDaemons([
      {
        id: 'machine-preview',
        type: 'adhdev-daemon',
        version: '0.9.75',
        serverVersion: '0.9.76-rc.4',
        versionMismatch: true,
        versionUpdateRequired: false,
        versionUpdateReason: 'patch_mismatch',
        releaseChannel: 'preview',
        updateChannel: 'preview',
        updatePolicy: {
          channel: 'preview',
          npmTag: 'next',
          targetVersion: '0.9.76-rc.4',
          updateCommand: 'adhdev update --channel preview',
        },
        updateCommand: 'adhdev update --channel preview',
        timestamp: 123,
      },
    ] as CompactDaemonCompat[])

    expect(result.entries[0]).toMatchObject({
      id: 'machine-preview',
      type: 'adhdev-daemon',
      version: '0.9.75',
      serverVersion: '0.9.76-rc.4',
      versionMismatch: true,
      versionUpdateReason: 'patch_mismatch',
      releaseChannel: 'preview',
      updateChannel: 'preview',
      updatePolicy: {
        channel: 'preview',
        npmTag: 'next',
        targetVersion: '0.9.76-rc.4',
        updateCommand: 'adhdev update --channel preview',
      },
      updateCommand: 'adhdev update --channel preview',
    })
  })

  it('keeps preview update policy when daemon-only WS metadata refreshes a richer P2P entry', () => {
    const previous = expandCompactDaemons([
      {
        id: 'machine-preview',
        type: 'adhdev-daemon',
        version: '0.9.75',
        serverVersion: '0.9.76-rc.4',
        versionMismatch: true,
        releaseChannel: 'preview',
        updateChannel: 'preview',
        updatePolicy: {
          channel: 'preview',
          npmTag: 'next',
          targetVersion: '0.9.76-rc.4',
          updateCommand: 'adhdev update --channel preview',
        },
        timestamp: 123,
        sessions: [
          {
            id: 'cli-1',
            parentId: null,
            providerType: 'hermes-cli',
            providerName: 'Hermes Agent',
            kind: 'agent',
            transport: 'pty',
            status: 'running',
            title: 'Hermes Agent',
            workspace: '/repo',
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries
    const incoming = expandCompactDaemons([
      {
        id: 'machine-preview',
        type: 'adhdev-daemon',
        version: '0.9.75',
        serverVersion: '0.9.76-rc.4',
        versionMismatch: true,
        releaseChannel: 'preview',
        updateChannel: 'preview',
        updatePolicy: {
          channel: 'preview',
          npmTag: 'next',
          targetVersion: '0.9.76-rc.4',
          updateCommand: 'adhdev update --channel preview',
        },
        timestamp: 124,
      },
    ] as CompactDaemonCompat[], { daemonOnlyId: () => true }).entries

    const reconciled = reconcileIdes(incoming, previous)
    expect(reconciled.find(entry => entry.id === 'machine-preview')).toMatchObject({
      updateChannel: 'preview',
      updatePolicy: {
        channel: 'preview',
        npmTag: 'next',
        targetVersion: '0.9.76-rc.4',
      },
      versionMismatch: true,
    })
    expect(reconciled.find(entry => entry.id === 'machine-preview:cli:cli-1')).toBeTruthy()
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

  it('does not prune a missing sibling session from a non-authoritative partial update', () => {
    const previous = expandCompactDaemons([
      {
        id: 'machine-7',
        type: 'adhdev-daemon',
        timestamp: 700,
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
            workspace: '/repo-a',
            activeChat: {
              id: 'chat-1',
              title: 'Hermes Agent',
              status: 'idle',
              messages: [{ role: 'assistant', content: 'kept-a' }],
              activeModal: null,
            },
          },
          {
            id: 'cli-2',
            parentId: null,
            providerType: 'codex-cli',
            providerName: 'Codex CLI',
            kind: 'agent',
            transport: 'pty',
            status: 'idle',
            title: 'Codex CLI',
            workspace: '/repo-b',
            activeChat: {
              id: 'chat-2',
              title: 'Codex CLI',
              status: 'idle',
              messages: [{ role: 'assistant', content: 'kept-b' }],
              activeModal: null,
            },
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries.map((entry) => (
      entry.type === 'adhdev-daemon'
        ? { ...entry, _lastUpdate: Date.now() - 5_000 }
        : { ...entry, _lastUpdate: Date.now() - 1_000 }
    ))

    const partial = expandCompactDaemons([
      {
        id: 'machine-7',
        type: 'adhdev-daemon',
        timestamp: Date.now(),
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
            workspace: '/repo-a',
            activeChat: {
              id: 'chat-1',
              title: 'Hermes Agent',
              status: 'idle',
              messages: [{ role: 'assistant', content: 'fresh-a' }],
              activeModal: null,
            },
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries

    const reconciled = reconcileIdes(partial, previous)

    expect(reconciled.find((entry) => entry.id === 'machine-7:cli:cli-1')?.activeChat?.messages).toEqual([
      { role: 'assistant', content: 'fresh-a' },
    ])
    expect(reconciled.find((entry) => entry.id === 'machine-7:cli:cli-2')).toBeTruthy()
    expect(reconciled.find((entry) => entry.id === 'machine-7:cli:cli-2')?.activeChat?.messages).toEqual([
      { role: 'assistant', content: 'kept-b' },
    ])
  })

  it('preserves existing IDE child sessions when an incoming update only includes a subset', () => {
    const previous = expandCompactDaemons([
      {
        id: 'machine-8',
        type: 'adhdev-daemon',
        timestamp: 800,
        sessions: [
          {
            id: 'ide-1',
            parentId: null,
            providerType: 'cursor',
            providerName: 'Cursor',
            kind: 'workspace',
            transport: 'cdp-page',
            status: 'idle',
            title: 'Workspace',
            activeChat: {
              id: 'native-chat',
              title: 'Workspace',
              status: 'idle',
              messages: [],
              activeModal: null,
            },
          },
          {
            id: 'child-1',
            parentId: 'ide-1',
            providerType: 'claude-code-vscode',
            providerName: 'Claude Code',
            kind: 'agent',
            transport: 'cdp-webview',
            status: 'running',
            title: 'Claude Code',
            activeChat: {
              id: 'child-chat-1',
              title: 'Claude Code',
              status: 'running',
              messages: [{ role: 'assistant', content: 'child-one' }],
              activeModal: null,
            },
          },
          {
            id: 'child-2',
            parentId: 'ide-1',
            providerType: 'roo-code',
            providerName: 'Roo Code',
            kind: 'agent',
            transport: 'cdp-webview',
            status: 'idle',
            title: 'Roo Code',
            activeChat: {
              id: 'child-chat-2',
              title: 'Roo Code',
              status: 'idle',
              messages: [{ role: 'assistant', content: 'child-two' }],
              activeModal: null,
            },
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries

    const partial = expandCompactDaemons([
      {
        id: 'machine-8',
        type: 'adhdev-daemon',
        timestamp: 801,
        sessions: [
          {
            id: 'ide-1',
            parentId: null,
            providerType: 'cursor',
            providerName: 'Cursor',
            kind: 'workspace',
            transport: 'cdp-page',
            status: 'idle',
            title: 'Workspace',
            activeChat: {
              id: 'native-chat',
              title: 'Workspace',
              status: 'idle',
              messages: [],
              activeModal: null,
            },
          },
          {
            id: 'child-1',
            parentId: 'ide-1',
            providerType: 'claude-code-vscode',
            providerName: 'Claude Code',
            kind: 'agent',
            transport: 'cdp-webview',
            status: 'idle',
            title: 'Claude Code',
            activeChat: {
              id: 'child-chat-1',
              title: 'Claude Code',
              status: 'idle',
              messages: [{ role: 'assistant', content: 'child-one-fresh' }],
              activeModal: null,
            },
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries

    const reconciled = reconcileIdes(partial, previous)
    const ideEntry = reconciled.find((entry) => entry.id === 'machine-8:ide:ide-1')

    expect(ideEntry?.childSessions?.map((child) => child.id)).toEqual(['child-1', 'child-2'])
    expect(ideEntry?.childSessions?.find((child) => child.id === 'child-1')).toMatchObject({
      id: 'child-1',
      providerName: 'Claude Code',
      status: 'idle',
    })
    expect(ideEntry?.childSessions?.find((child) => child.id === 'child-2')).toMatchObject({
      id: 'child-2',
      providerName: 'Roo Code',
      status: 'idle',
    })
  })

  it('allows authoritative updates to remove missing IDE child sessions', () => {
    const previous = expandCompactDaemons([
      {
        id: 'machine-9',
        type: 'adhdev-daemon',
        timestamp: 900,
        sessions: [
          {
            id: 'ide-1',
            parentId: null,
            providerType: 'cursor',
            providerName: 'Cursor',
            kind: 'workspace',
            transport: 'cdp-page',
            status: 'idle',
            title: 'Workspace',
            activeChat: {
              id: 'native-chat',
              title: 'Workspace',
              status: 'idle',
              messages: [],
              activeModal: null,
            },
          },
          {
            id: 'child-1',
            parentId: 'ide-1',
            providerType: 'claude-code-vscode',
            providerName: 'Claude Code',
            kind: 'agent',
            transport: 'cdp-webview',
            status: 'idle',
            title: 'Claude Code',
          },
          {
            id: 'child-2',
            parentId: 'ide-1',
            providerType: 'roo-code',
            providerName: 'Roo Code',
            kind: 'agent',
            transport: 'cdp-webview',
            status: 'idle',
            title: 'Roo Code',
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries

    const authoritative = expandCompactDaemons([
      {
        id: 'machine-9',
        type: 'adhdev-daemon',
        timestamp: 901,
        sessions: [
          {
            id: 'ide-1',
            parentId: null,
            providerType: 'cursor',
            providerName: 'Cursor',
            kind: 'workspace',
            transport: 'cdp-page',
            status: 'idle',
            title: 'Workspace',
            activeChat: {
              id: 'native-chat',
              title: 'Workspace',
              status: 'idle',
              messages: [],
              activeModal: null,
            },
          },
          {
            id: 'child-1',
            parentId: 'ide-1',
            providerType: 'claude-code-vscode',
            providerName: 'Claude Code',
            kind: 'agent',
            transport: 'cdp-webview',
            status: 'idle',
            title: 'Claude Code',
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries

    const reconciled = reconcileIdes(authoritative, previous, { authoritativeDaemonIds: ['machine-9'] })
    const ideEntry = reconciled.find((entry) => entry.id === 'machine-9:ide:ide-1')

    expect(ideEntry?.childSessions?.map((child) => child.id)).toEqual(['child-1'])
  })

  it('preserves entry reference when only timestamps change on large chat payloads', () => {
    const previous = expandCompactDaemons([
      {
        id: 'machine-11',
        type: 'adhdev-daemon',
        timestamp: 920,
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
            workspace: '/repo-a',
            activeChat: {
              id: 'chat-1',
              title: 'Hermes Agent',
              status: 'idle',
              messages: Array.from({ length: 120 }, (_, index) => ({
                id: `msg-${index}`,
                role: index % 2 === 0 ? 'user' : 'assistant',
                content: `long message ${index} ${'x'.repeat(200)}`,
                timestamp: 1_000 + index,
              })),
              activeModal: null,
            },
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries

    const previousCliEntry = previous.find((entry) => entry.id === 'machine-11:cli:cli-1')

    const next = expandCompactDaemons([
      {
        id: 'machine-11',
        type: 'adhdev-daemon',
        timestamp: 921,
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
            workspace: '/repo-a',
            activeChat: {
              id: 'chat-1',
              title: 'Hermes Agent',
              status: 'idle',
              messages: Array.from({ length: 120 }, (_, index) => ({
                id: `msg-${index}`,
                role: index % 2 === 0 ? 'user' : 'assistant',
                content: `long message ${index} ${'x'.repeat(200)}`,
                timestamp: 1_000 + index,
              })),
              activeModal: null,
            },
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries

    const reconciled = reconcileIdes(next, previous)
    const reconciledCliEntry = reconciled.find((entry) => entry.id === 'machine-11:cli:cli-1')

    expect(reconciledCliEntry).toBe(previousCliEntry)
    expect(reconciledCliEntry?.timestamp).toBe(921)
  })

  it('preserves loaded chat reference for metadata-only live updates without reading message bodies', () => {
    const messageWithExpensiveBody: { id: string; role: string; timestamp: number; content?: string } = {
      id: 'msg-1',
      role: 'assistant',
      timestamp: 10,
    }
    Object.defineProperty(messageWithExpensiveBody, 'content', {
      enumerable: true,
      get() {
        throw new Error('message content should not be read for metadata-only status equivalence')
      },
    })

    const previous = expandCompactDaemons([
      {
        id: 'machine-12-fast',
        type: 'adhdev-daemon',
        timestamp: 930,
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
            workspace: '/repo-a',
            activeChat: {
              id: 'chat-1',
              title: 'Hermes Agent',
              status: 'idle',
              messages: [messageWithExpensiveBody as any],
              activeModal: null,
            },
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries

    const previousCliEntry = previous.find((entry) => entry.id === 'machine-12-fast:cli:cli-1')

    const next = expandCompactDaemons([
      {
        id: 'machine-12-fast',
        type: 'adhdev-daemon',
        timestamp: 931,
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
            workspace: '/repo-a',
            activeChat: {
              id: 'chat-1',
              title: 'Hermes Agent',
              status: 'idle',
              activeModal: null,
            },
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries

    const reconciled = reconcileIdes(next, previous)
    const reconciledCliEntry = reconciled.find((entry) => entry.id === 'machine-12-fast:cli:cli-1')

    expect(reconciledCliEntry).toBe(previousCliEntry)
    expect(reconciledCliEntry?.timestamp).toBe(931)
  })

  it('replaces entry reference when chat message content changes', () => {
    const previous = expandCompactDaemons([
      {
        id: 'machine-12',
        type: 'adhdev-daemon',
        timestamp: 930,
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
            workspace: '/repo-a',
            activeChat: {
              id: 'chat-1',
              title: 'Hermes Agent',
              status: 'idle',
              messages: [{ id: 'msg-1', role: 'assistant', content: 'before', timestamp: 10 }],
              activeModal: null,
            },
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries

    const previousCliEntry = previous.find((entry) => entry.id === 'machine-12:cli:cli-1')

    const next = expandCompactDaemons([
      {
        id: 'machine-12',
        type: 'adhdev-daemon',
        timestamp: 931,
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
            workspace: '/repo-a',
            activeChat: {
              id: 'chat-1',
              title: 'Hermes Agent',
              status: 'idle',
              messages: [{ id: 'msg-1', role: 'assistant', content: 'after', timestamp: 11 }],
              activeModal: null,
            },
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries

    const reconciled = reconcileIdes(next, previous)
    const reconciledCliEntry = reconciled.find((entry) => entry.id === 'machine-12:cli:cli-1')

    expect(reconciledCliEntry).not.toBe(previousCliEntry)
    expect(reconciledCliEntry?.activeChat?.messages).toEqual([
      { id: 'msg-1', role: 'assistant', content: 'after', timestamp: 11 },
    ])
  })

  it('keeps an idle transport session when its parent daemon still exists during unrelated reconciles', () => {
    const now = Date.now()
    const previous = expandCompactDaemons([
      {
        id: 'machine-keep',
        type: 'adhdev-daemon',
        timestamp: now - 1_000,
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
            workspace: '/repo-a',
            activeChat: {
              id: 'chat-1',
              title: 'Hermes Agent',
              status: 'idle',
              messages: [{ role: 'assistant', content: 'still alive' }],
              activeModal: null,
            },
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries.map((entry) => (
      entry.id === 'machine-keep'
        ? { ...entry, _lastUpdate: now - 1_000 }
        : { ...entry, _lastUpdate: now - 301_000 }
    ))

    const incoming = expandCompactDaemons([
      {
        id: 'machine-other',
        type: 'adhdev-daemon',
        timestamp: now,
      },
    ] as CompactDaemonCompat[]).entries

    const reconciled = reconcileIdes(incoming, previous)
    expect(reconciled.find((entry) => entry.id === 'machine-keep:cli:cli-1')).toBeTruthy()
  })

  it('still prunes an old idle transport session when its parent daemon is gone', () => {
    const now = Date.now()
    const previous = expandCompactDaemons([
      {
        id: 'machine-gone',
        type: 'adhdev-daemon',
        timestamp: now - 301_000,
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
            workspace: '/repo-a',
            activeChat: {
              id: 'chat-1',
              title: 'Hermes Agent',
              status: 'idle',
              messages: [{ role: 'assistant', content: 'stale' }],
              activeModal: null,
            },
          },
        ],
      },
    ] as CompactDaemonCompat[]).entries
      .filter((entry) => entry.id !== 'machine-gone')
      .map((entry) => ({ ...entry, _lastUpdate: now - 301_000 }))

    const reconciled = reconcileIdes([], previous)
    expect(reconciled.find((entry) => entry.id === 'machine-gone:cli:cli-1')).toBeFalsy()
  })
})
