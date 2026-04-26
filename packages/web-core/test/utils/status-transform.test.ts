import { describe, expect, it } from 'vitest';
import type { SessionEntry, StatusReportPayload } from '@adhdev/daemon-core';
import { statusPayloadToEntries } from '../../src/utils/status-transform';

function createSession(overrides: Partial<SessionEntry>): SessionEntry {
    return {
        id: 'session-1',
        parentId: null,
        providerType: 'codex',
        providerName: 'Codex',
        kind: 'agent',
        transport: 'pty',
        status: 'running',
        title: 'Session',
        workspace: '/workspace',
        activeChat: null,
        capabilities: [],
        ...overrides,
    };
}

function createPayload(overrides: Partial<StatusReportPayload> = {}): StatusReportPayload {
    return {
        instanceId: 'daemon-1',
        version: '0.8.30',
        daemonMode: true,
        machine: {
            hostname: 'mbp',
            platform: 'darwin',
            arch: 'arm64',
            cpus: 8,
            totalMem: 16,
            freeMem: 8,
            loadavg: [1, 0.5, 0.25],
            uptime: 123,
            release: '15.0',
        },
        timestamp: 111,
        detectedIdes: [],
        sessions: [],
        ...overrides,
    };
}

describe('statusPayloadToEntries', () => {
    it('builds daemon, IDE, CLI, and ACP entries from top-level sessions', () => {
        const ideChild = createSession({
            id: 'agent-child',
            parentId: 'ide-1',
            kind: 'agent',
            transport: 'pty',
            providerType: 'codex',
            providerName: 'Codex',
            status: 'running',
            title: 'Child agent',
        });
        const ideSession = createSession({
            id: 'ide-1',
            kind: 'workspace',
            transport: 'cdp-page',
            providerType: 'cursor',
            providerName: 'Cursor',
            status: 'idle',
            title: 'Cursor',
            workspace: '/repo',
            cdpConnected: true,
            activeChat: { status: 'ready', messages: [] },
            unread: true,
            lastSeenAt: 42,
            inboxBucket: 'inbox',
            surfaceHidden: true,
            currentAutoApprove: 'auto',
            controlValues: { autoApprove: true },
            providerControls: [{ id: 'autoApprove', type: 'toggle', label: 'Auto approve', placement: 'bar' }],
        });
        const cliSession = createSession({
            id: 'cli-1',
            providerType: 'codex',
            providerName: 'Codex CLI',
            runtimeKey: 'runtime-1',
            runtimeDisplayName: 'Terminal',
            runtimeWorkspaceLabel: 'repo',
            runtimeAttachedClients: [{ clientId: 'web', label: 'Browser' }],
        });
        const acpSession = createSession({
            id: 'acp-1',
            transport: 'acp',
            providerType: 'claude-code',
            providerName: 'Claude Code',
            acpModes: [{ id: 'plan', name: 'Plan' }],
            acpConfigOptions: [{ category: 'model', configId: 'model', options: [{ value: 'sonnet', name: 'Sonnet' }] }],
            summaryMetadata: {
                items: [
                    { id: 'model', label: 'Model', value: 'sonnet', order: 20 },
                    { id: 'profile', label: 'Profile', value: 'reasoning', order: 10 },
                ],
            },
        });

        const entries = statusPayloadToEntries(createPayload({
            machineNickname: 'Studio',
            p2p: { available: true, state: 'connected', peers: 2, screenshotActive: true },
            availableProviders: [{ type: 'codex', name: 'Codex', category: 'cli', displayName: 'Codex', icon: 'codex' }],
            sessions: [ideSession, ideChild, cliSession, acpSession],
        }), {
            daemonId: 'machine-1',
            timestamp: 999,
            existingDaemon: { id: 'stale', type: 'adhdev-daemon', status: 'offline', nickname: 'keep-me' },
        });

        expect(entries).toHaveLength(4);

        const daemonEntry = entries[0];
        expect(daemonEntry).toMatchObject({
            id: 'machine-1',
            type: 'adhdev-daemon',
            status: 'online',
            timestamp: 999,
            machineNickname: 'Studio',
            cdpConnected: true,
            nickname: 'keep-me',
        });
        expect(daemonEntry.p2p).toEqual({ available: true, state: 'connected', peers: 2, screenshotActive: true });
        expect(daemonEntry.availableProviders).toHaveLength(1);

        const ideEntry = entries[1];
        expect(ideEntry).toMatchObject({
            id: 'machine-1:ide:ide-1',
            sessionId: 'ide-1',
            type: 'cursor',
            status: 'online',
            workspace: '/repo',
            cdpConnected: true,
            unread: true,
            lastSeenAt: 42,
            inboxBucket: 'inbox',
            surfaceHidden: true,
        });
        expect(ideEntry).not.toHaveProperty('currentAutoApprove')
        expect(ideEntry).not.toHaveProperty('currentPlan')
        expect(ideEntry).not.toHaveProperty('currentModel')
        expect(ideEntry.childSessions).toHaveLength(1)
        expect(ideEntry.childSessions[0]).toMatchObject({
            id: 'agent-child',
            parentId: 'ide-1',
            providerType: 'codex',
            providerName: 'Codex',
            kind: 'agent',
            transport: 'pty',
            status: 'running',
            title: 'Child agent',
        })
        expect(ideEntry.agents).toEqual([{ id: 'agent-child', name: 'Codex', type: 'codex', status: 'running' }]);
        expect(ideEntry.providerControls).toEqual([{ id: 'autoApprove', type: 'toggle', label: 'Auto approve', placement: 'bar' }]);

        const cliEntry = entries[2];
        expect(cliEntry).toMatchObject({
            id: 'machine-1:cli:cli-1',
            type: 'codex',
            agentType: 'codex',
            mode: 'terminal',
            runtimeKey: 'runtime-1',
            runtimeDisplayName: 'Terminal',
            runtimeWorkspaceLabel: 'repo',
            _isCli: true,
        });
        expect(cliEntry).not.toHaveProperty('currentModel')
        expect(cliEntry).not.toHaveProperty('currentPlan')
        expect(cliEntry.runtimeAttachedClients).toEqual([{ clientId: 'web', label: 'Browser' }]);

        const acpEntry = entries[3];
        expect(acpEntry).toMatchObject({
            id: 'machine-1:acp:acp-1',
            type: 'claude-code',
            agentType: 'claude-code',
            mode: 'chat',
            _isAcp: true,
        });
        expect(acpEntry).not.toHaveProperty('currentModel')
        expect(acpEntry).not.toHaveProperty('currentPlan')
        expect(acpEntry).not.toHaveProperty('acpModes')
        expect(acpEntry).not.toHaveProperty('acpConfigOptions')
        expect(acpEntry.summaryMetadata).toEqual({
            items: [
                { id: 'model', label: 'Model', value: 'sonnet', order: 20 },
                { id: 'profile', label: 'Profile', value: 'reasoning', order: 10 },
            ],
        })
    });

    it('marks only explicit session arrays as authoritative for session deletion', () => {
        const withSessions = statusPayloadToEntries(createPayload({ sessions: [] }), {
            daemonId: 'machine-authority',
        })
        expect(withSessions[0]._sessionListAuthoritative).toBe(true)

        const sparse = statusPayloadToEntries({
            ...createPayload({ sessions: undefined as any }),
            detectedIdes: [],
        }, {
            daemonId: 'machine-authority',
            existingDaemon: withSessions[0],
            existingEntries: withSessions,
        })
        expect(sparse[0]._sessionListAuthoritative).toBe(false)
    })

    it('preserves daemon completion markers through status transform for auto-read consumers', () => {
    const cliSession = createSession({
      id: 'cli-marker',
      providerType: 'hermes-cli',
      providerName: 'Hermes Agent',
      transport: 'pty',
      unread: true,
      inboxBucket: 'task_complete',
      completionMarker: 'id:msg_7',
      seenCompletionMarker: 'id:msg_1',
    })

    const entries = statusPayloadToEntries(createPayload({
      sessions: [cliSession],
    }), {
      daemonId: 'machine-1',
      timestamp: 999,
    })

    expect(entries[1]).toMatchObject({
      id: 'machine-1:cli:cli-marker',
      completionMarker: 'id:msg_7',
      seenCompletionMarker: 'id:msg_1',
      unread: true,
      inboxBucket: 'task_complete',
    })
  })

  it('keeps defaults stable for disconnected or sparse sessions', () => {
        const ideSession = createSession({
            id: 'ide-2',
            kind: 'workspace',
            transport: 'cdp-page',
            providerType: 'vscode',
            providerName: 'VS Code',
            status: 'idle',
            title: 'VS Code',
            workspace: null,
            cdpConnected: false,
        });
        const cliSession = createSession({
            id: 'cli-2',
            status: '',
            workspace: null,
            runtimeWriteOwner: undefined,
            runtimeAttachedClients: undefined,
        });
        const acpSession = createSession({
            id: 'acp-2',
            transport: 'acp',
            status: '',
            workspace: null,
            runtimeWriteOwner: undefined,
            runtimeAttachedClients: undefined,
        });

        const entries = statusPayloadToEntries(createPayload({
            timestamp: 222,
            sessions: [ideSession, cliSession, acpSession],
        }), { daemonId: 'machine-2' });

        expect(entries[0]).toMatchObject({ id: 'machine-2', timestamp: 222, cdpConnected: false });
        expect(entries[1]).toMatchObject({ id: 'machine-2:ide:ide-2', status: 'detected', workspace: null });
        expect(entries[2]).toMatchObject({
            id: 'machine-2:cli:cli-2',
            status: 'running',
            workspace: '',
        });
        expect(entries[2].runtimeWriteOwner ?? null).toBe(null);
        expect(entries[2].runtimeAttachedClients ?? []).toEqual([]);
        expect(entries[3]).toMatchObject({
            id: 'machine-2:acp:acp-2',
            status: 'running',
            workspace: '',
        });
        expect(entries[3].runtimeWriteOwner ?? null).toBe(null);
        expect(entries[3].runtimeAttachedClients ?? []).toEqual([]);
    });

    it('preserves existing active chat messages and approval buttons when live snapshots omit transcript bodies', () => {
        const entries = statusPayloadToEntries(createPayload({
            sessions: [createSession({
                id: 'cli-keep-chat',
                providerType: 'hermes-cli',
                providerName: 'Hermes Agent',
                status: 'waiting_approval',
                activeChat: {
                    id: 'chat-1',
                    title: 'Hermes Agent',
                    status: 'waiting_approval',
                    activeModal: null,
                } as any,
            })],
        }), {
            daemonId: 'machine-4',
            existingEntries: [{
                id: 'machine-4:cli:cli-keep-chat',
                daemonId: 'machine-4',
                sessionId: 'cli-keep-chat',
                type: 'hermes-cli',
                status: 'waiting_approval',
                activeChat: {
                    id: 'chat-1',
                    title: 'Hermes Agent',
                    status: 'waiting_approval',
                    messages: [
                        { role: 'user', content: 'full prompt', kind: 'standard' },
                        { role: 'assistant', content: 'full reply', kind: 'standard' },
                    ],
                    activeModal: {
                        message: '⚠️ Dangerous Command',
                        buttons: ['Allow once', 'Deny'],
                    },
                },
            } as any],
        })

        expect(entries[1]?.activeChat?.messages).toEqual([
            { role: 'user', content: 'full prompt', kind: 'standard' },
            { role: 'assistant', content: 'full reply', kind: 'standard' },
        ])
        expect(entries[1]?.activeChat?.activeModal).toEqual({
            message: '⚠️ Dangerous Command',
            buttons: ['Allow once', 'Deny'],
        })
    })

    it('preserves an existing chat mode when a sparse live CLI snapshot omits mode', () => {
        const entries = statusPayloadToEntries(createPayload({
            sessions: [createSession({
                id: 'cli-mode',
                providerType: 'hermes-cli',
                providerName: 'Hermes Agent',
                status: 'idle',
                activeChat: {
                    id: 'chat-1',
                    title: 'Hermes Agent',
                    status: 'idle',
                    messages: [],
                    activeModal: null,
                } as any,
            })],
        }), {
            daemonId: 'machine-5',
            existingEntries: [{
                id: 'machine-5:cli:cli-mode',
                daemonId: 'machine-5',
                sessionId: 'cli-mode',
                type: 'hermes-cli',
                transport: 'pty',
                mode: 'chat',
                status: 'idle',
                activeChat: {
                    id: 'chat-1',
                    title: 'Hermes Agent',
                    status: 'idle',
                    messages: [],
                    activeModal: null,
                },
            } as any],
        })

        expect(entries[1]).toMatchObject({
            id: 'machine-5:cli:cli-mode',
            mode: 'chat',
        })
    })

    it('preserves an existing child providerName when sparse live snapshots omit session metadata', () => {
        const metadataEntries = statusPayloadToEntries(createPayload({
            sessions: [
                createSession({
                    id: 'ide-parent',
                    kind: 'workspace',
                    transport: 'cdp-page',
                    providerType: 'antigravity',
                    providerName: 'Antigravity',
                    status: 'idle',
                    title: 'Workspace',
                    cdpConnected: true,
                    activeChat: { status: 'idle', messages: [] } as any,
                }),
                createSession({
                    id: 'child-claude',
                    parentId: 'ide-parent',
                    kind: 'agent',
                    transport: 'cdp-webview',
                    providerType: 'claude-code-vscode',
                    providerName: 'Claude Code (VS Code)',
                    status: 'idle',
                    title: 'Claude Code (VS Code)',
                    activeChat: { status: 'idle', messages: [] } as any,
                }),
            ],
        }), {
            daemonId: 'machine-6',
        })

        const entries = statusPayloadToEntries(createPayload({
            timestamp: 333,
            sessions: [
                createSession({
                    id: 'ide-parent',
                    kind: 'workspace',
                    transport: 'cdp-page',
                    providerType: 'antigravity',
                    providerName: undefined,
                    status: 'idle',
                    title: 'Workspace',
                    cdpConnected: true,
                    activeChat: { status: 'idle', messages: [] } as any,
                }),
                createSession({
                    id: 'child-claude',
                    parentId: 'ide-parent',
                    kind: 'agent',
                    transport: 'cdp-webview',
                    providerType: 'claude-code-vscode',
                    providerName: undefined,
                    status: 'idle',
                    title: 'Claude Code (VS Code)',
                    activeChat: { status: 'idle', messages: [] } as any,
                }),
            ],
        }), {
            daemonId: 'machine-6',
            existingEntries: metadataEntries,
        })

        expect(entries[1].childSessions?.[0]).toMatchObject({
            id: 'child-claude',
            providerType: 'claude-code-vscode',
            providerName: 'Claude Code (VS Code)',
        })
    })

    it('preserves an existing child title when sparse live snapshots omit it', () => {
        const metadataEntries = statusPayloadToEntries(createPayload({
            sessions: [
                createSession({
                    id: 'ide-parent',
                    kind: 'workspace',
                    transport: 'cdp-page',
                    providerType: 'antigravity',
                    providerName: 'Antigravity',
                    status: 'idle',
                    title: 'Workspace',
                    cdpConnected: true,
                    activeChat: { status: 'idle', messages: [] } as any,
                }),
                createSession({
                    id: 'child-claude',
                    parentId: 'ide-parent',
                    kind: 'agent',
                    transport: 'cdp-webview',
                    providerType: 'claude-code-vscode',
                    providerName: 'Claude Code (VS Code)',
                    status: 'idle',
                    title: 'Meaningful Conversation Title',
                    activeChat: { status: 'idle', messages: [] } as any,
                }),
            ],
        }), {
            daemonId: 'machine-7',
        })

        const entries = statusPayloadToEntries(createPayload({
            timestamp: 444,
            sessions: [
                createSession({
                    id: 'ide-parent',
                    kind: 'workspace',
                    transport: 'cdp-page',
                    providerType: 'antigravity',
                    providerName: undefined,
                    status: 'idle',
                    title: 'Workspace',
                    cdpConnected: true,
                    activeChat: { status: 'idle', messages: [] } as any,
                }),
                createSession({
                    id: 'child-claude',
                    parentId: 'ide-parent',
                    kind: 'agent',
                    transport: 'cdp-webview',
                    providerType: 'claude-code-vscode',
                    providerName: undefined,
                    status: 'idle',
                    title: undefined,
                    activeChat: { status: 'idle', messages: [] } as any,
                }),
            ],
        }), {
            daemonId: 'machine-7',
            existingEntries: metadataEntries,
        })

        expect(entries[1].childSessions?.[0]).toMatchObject({
            id: 'child-claude',
            title: 'Meaningful Conversation Title',
        })
    })
});
