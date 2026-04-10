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
            daemonMode: true,
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
            ideType: 'cursor',
            status: 'online',
            workspace: '/repo',
            cdpConnected: true,
            unread: true,
            lastSeenAt: 42,
            inboxBucket: 'inbox',
            surfaceHidden: true,
        });
        expect(ideEntry.childSessions).toEqual([ideChild]);
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
        expect(cliEntry.runtimeAttachedClients).toEqual([{ clientId: 'web', label: 'Browser' }]);

        const acpEntry = entries[3];
        expect(acpEntry).toMatchObject({
            id: 'machine-1:acp:acp-1',
            type: 'claude-code',
            agentType: 'claude-code',
            mode: 'chat',
            _isAcp: true,
        });
        expect(acpEntry.acpModes).toEqual([{ id: 'plan', name: 'Plan' }]);
        expect(acpEntry.acpConfigOptions).toEqual([
            { category: 'model', configId: 'model', options: [{ value: 'sonnet', name: 'Sonnet' }] },
        ]);
    });

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
            runtimeWriteOwner: null,
            runtimeAttachedClients: [],
        });
        expect(entries[3]).toMatchObject({
            id: 'machine-2:acp:acp-2',
            status: 'running',
            workspace: '',
            runtimeWriteOwner: null,
            runtimeAttachedClients: [],
        });
    });
});
