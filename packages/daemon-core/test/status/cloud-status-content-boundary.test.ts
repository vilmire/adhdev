import { describe, expect, it } from 'vitest';
import { buildCloudStatusReportPayload } from '../../src/status/reporter.js';

/**
 * The server WS control plane must never carry user chat content.
 *
 * ADHDev is P2P-first: chat, commands, screenshots and file ops travel over the
 * WebRTC DataChannel; the server sees auth, signaling and lightweight routing
 * metadata only. `buildCloudStatusReportPayload` IS that boundary for the status
 * path, so these tests are the regression guard for it.
 */

/** A session carrying every content-bearing field a real snapshot can hold. */
function sessionWithContent(overrides: Record<string, unknown> = {}) {
    return {
        id: 'sess-1',
        parentId: null,
        providerType: 'claude-cli',
        providerName: 'Claude Code',
        kind: 'agent',
        transport: 'pty',
        status: 'generating',
        workspace: '/Users/someone/projects/my-app',
        cdpConnected: false,
        surfaceHidden: false,
        muted: false,

        // ── content — none of this may cross to the server ──
        title: 'why is my auth token expiring early',
        lastMessagePreview: 'The bug is in refreshToken() — it compares seconds to ms',
        lastMessageRole: 'assistant',
        lastMessageAt: 1_700_000_000_000,
        lastMessageHash: 'deadbeef',
        summaryMetadata: { items: [{ id: 'branch', value: 'fix/auth-token-ttl' }] },
        runtimeDisplayName: 'my-app — auth refactor',
        runtimeWorkspaceLabel: 'my-app (auth)',
        activeChat: { messages: [{ role: 'user', content: 'secret prompt text' }] },
        settings: { executablePath: '/opt/homebrew/bin/claude' },
        git: { branch: 'fix/auth-token-ttl', dirty: true },
        controlValues: { model: 'opus' },
        providerControls: [{ id: 'model', label: 'Model' }],
        meshQueueStats: {
            pending: 1,
            assigned: 0,
            completed: 0,
            failed: 0,
            activeAssignments: [{ id: 'a1', message: 'investigate the token TTL bug' }],
        },
        ...overrides,
    };
}

const CONTENT_FIELDS = [
    'title',
    'lastMessagePreview',
    'lastMessageRole',
    'lastMessageAt',
    'lastMessageHash',
    'summaryMetadata',
    'runtimeDisplayName',
    'runtimeWorkspaceLabel',
    'activeChat',
    'settings',
    'git',
    'controlValues',
    'providerControls',
    'meshQueueStats',
];

describe('buildCloudStatusReportPayload — server WS content boundary', () => {
    it('omits every content-bearing field from the server payload', () => {
        const [session] = buildCloudStatusReportPayload([sessionWithContent()], undefined, 1).sessions;

        for (const field of CONTENT_FIELDS) {
            expect(session, `"${field}" must not be sent to the server`).not.toHaveProperty(field);
        }
    });

    it('never serializes chat text anywhere in the payload', () => {
        // Belt-and-braces: no nesting, rename, or stray passthrough can smuggle it.
        const payload = buildCloudStatusReportPayload([sessionWithContent()], undefined, 1);
        const wire = JSON.stringify(payload);

        for (const secret of [
            'why is my auth token expiring early',
            'The bug is in refreshToken()',
            'secret prompt text',
            'investigate the token TTL bug',
            'my-app — auth refactor',
            'fix/auth-token-ttl',
        ]) {
            expect(wire, `payload leaked: ${secret}`).not.toContain(secret);
        }
    });

    it('keeps the routing metadata the server needs', () => {
        const [session] = buildCloudStatusReportPayload([sessionWithContent()], undefined, 1).sessions;

        expect(session).toEqual({
            id: 'sess-1',
            parentId: null,
            providerType: 'claude-cli',
            providerName: 'Claude Code',
            kind: 'agent',
            transport: 'pty',
            status: 'generating',
            workspace: '/Users/someone/projects/my-app',
            cdpConnected: false,
            surfaceHidden: false,
            muted: false,
        });
    });

    it('forwards surfaceHidden and muted so the server can gate push notifications', () => {
        const [session] = buildCloudStatusReportPayload(
            [sessionWithContent({ surfaceHidden: true, muted: true })],
            undefined,
            1,
        ).sessions;

        expect(session.surfaceHidden).toBe(true);
        expect(session.muted).toBe(true);
    });

    it('is an allow-list — an unknown future field is dropped, not forwarded', () => {
        // The regression this guards: a deny-list would forward anything new.
        const [session] = buildCloudStatusReportPayload(
            [sessionWithContent({ someFutureContentField: 'a brand new leak' })],
            undefined,
            1,
        ).sessions;

        expect(session).not.toHaveProperty('someFutureContentField');
        expect(JSON.stringify(session)).not.toContain('a brand new leak');
    });

    it('falls back to providerType when providerName is absent', () => {
        const [session] = buildCloudStatusReportPayload(
            [sessionWithContent({ providerName: undefined })],
            undefined,
            1,
        ).sessions;

        expect(session.providerName).toBe('claude-cli');
    });

    it('normalizes missing parentId/workspace to null', () => {
        const [session] = buildCloudStatusReportPayload(
            [sessionWithContent({ parentId: undefined, workspace: undefined })],
            undefined,
            1,
        ).sessions;

        expect(session.parentId).toBeNull();
        expect(session.workspace).toBeNull();
    });

    it('passes through p2p state and timestamp untouched', () => {
        const p2p = { available: true, state: 'connected', peers: 2, screenshotActive: false } as const;
        const payload = buildCloudStatusReportPayload([], p2p, 4242);

        expect(payload.p2p).toEqual(p2p);
        expect(payload.timestamp).toBe(4242);
    });

    it('tolerates a non-array or malformed session list', () => {
        expect(buildCloudStatusReportPayload(undefined, undefined, 1).sessions).toEqual([]);
        expect(buildCloudStatusReportPayload(null, undefined, 1).sessions).toEqual([]);
        expect(() => buildCloudStatusReportPayload([null, undefined], undefined, 1)).not.toThrow();
    });
});
