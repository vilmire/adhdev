/**
 * Mission 96f9ff0a — the bound assistant keeps its write capability
 * (decision_answer, project_send) across a daemon restart and a session
 * replacement, and nothing else gains it.
 *
 * "Restart" = the in-memory credential store is dropped while the persisted
 * SHA-256 binding stays (the MCP child keeps the original token in its env).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testConfigDir = join(tmpdir(), `adhdev-cred-restart-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));
const bound = { sid: 'assistant-session-A' };
vi.mock('../../src/assistant/assistant-registry.js', () => ({
    getAssistantRegistry: () => ({ read: () => ({ sessionId: bound.sid }), reload: () => ({ sessionId: bound.sid }) }),
}));

import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { authorizeAssistantDecisionCaller } from '../../src/commands/high-family/assistant-decisions.js';
import { assistantProjectHandlers } from '../../src/commands/high-family/assistant.js';
import {
    __forgetMcpSessionCredentialMemoryForTest,
    __resetMcpSessionCredentialsForTest,
    __setMcpSessionCredentialPersistenceForTest,
    ensureMcpSessionCredential,
    hashMcpSessionCredential,
    mintMcpSessionCredential,
    revokeMcpSessionCredential,
    verifyMcpSessionCredential,
} from '../../src/commands/mcp-command-ingress.js';
import { FileMcpSessionCredentialStore, type McpSessionCredentialPersistence } from '../../src/commands/mcp-session-credential-store.js';
import { setAssistantProjectPortsForTests, type AssistantProjectPorts } from '../../src/assistant/assistant-project-ports.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { loadMeshConfig, saveMeshConfig } from '../../src/config/mesh-config-store.js';
import type { LocalMeshEntry } from '../../src/repo-mesh-types.js';

const SELF = 'daemon_mach_assistant00001';
const MESH = 'mesh_cred_a';
const roots: string[] = [];
let sent: Array<Record<string, any>>;

function useFileStore(): FileMcpSessionCredentialStore {
    const dir = mkdtempSync(join(tmpdir(), 'adhdev-cred-restart-store-'));
    roots.push(dir);
    const store = new FileMcpSessionCredentialStore(join(dir, 'mcp-session-credentials.json'));
    __setMcpSessionCredentialPersistenceForTest(store);
    return store;
}
const decisionAuth = (args: Record<string, unknown>) => authorizeAssistantDecisionCaller(args, { requireOwnerUtterance: false });
const asArgs = (sid: string, token: string | undefined, extra: Record<string, unknown> = {}) => ({
    assistantSessionId: sid,
    ...(token ? { mcpSessionCredential: token } : {}),
    ...extra,
});
const send = (args: Record<string, unknown>) => assistantProjectHandlers[ASSISTANT_VERB.projectSend]({} as any, args) as Promise<any>;

function meshEntry(): LocalMeshEntry {
    return {
        id: MESH, name: 'Blog', repoIdentity: 'github.com/acme/blog',
        nodes: [{ id: 'n-host', workspace: '/w', daemonId: SELF, role: 'host' }],
    } as unknown as LocalMeshEntry;
}

beforeEach(() => {
    sent = [];
    bound.sid = 'assistant-session-A';
    saveMeshConfig({ ...loadMeshConfig(), meshes: [meshEntry()] as any });
    setAssistantServicesForTests(createAssistantServices({ configDir: testConfigDir, listMeshes: () => [meshEntry()] }));
    const ports = {
        selfDaemonId: () => SELF, listMeshes: () => [meshEntry()], isHostedHere: () => true, aliases: () => ({}),
        coordinators: () => [{ sessionId: 'coord-1', idle: true, modalParked: false, managedByAssistant: true }],
        lastCoordinatorSessionId: () => 'coord-1', queueCounts: () => ({ pending: 0, assigned: 0, failed: 0 }),
        activeMissionCount: () => 0, pendingApprovals: () => 0,
        relay: { openThread: vi.fn(), isThreadOpen: () => false, lastRelayAt: () => 0, remoteSent: vi.fn(), assistantSessionId: () => bound.sid },
        execute: vi.fn(async (cmd: string, a: any) => { if (cmd === 'send_chat') sent.push(a); return { success: true }; }) as any,
        remoteHost: () => null, callHost: vi.fn(), coordinatorTurns: () => ({ open: false, committed: [] }), meshStatusLine: () => null,
    };
    setAssistantProjectPortsForTests(() => ports as unknown as AssistantProjectPorts);
});

afterEach(() => {
    setAssistantProjectPortsForTests(null);
    setAssistantServicesForTests(null);
    __resetMcpSessionCredentialsForTest();
    __setMcpSessionCredentialPersistenceForTest(null);
    MeshRuntimeStore.resetForTests();
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
    try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('bound assistant capability across a daemon restart', () => {
    it('decision verbs accept the original token after restart; no token, another session, and a coordinator scope are refused', () => {
        useFileStore();
        const token = mintMcpSessionCredential({ sessionId: 'assistant-session-A', isCoordinator: false });
        const otherToken = mintMcpSessionCredential({ sessionId: 'assistant-session-B', isCoordinator: false });
        __forgetMcpSessionCredentialMemoryForTest();
        // The restored boot adopts the stored hash; it must not rotate the token the child holds.
        expect(ensureMcpSessionCredential({ sessionId: 'assistant-session-A', isCoordinator: false })).toBeNull();

        expect(decisionAuth(asArgs('assistant-session-A', token))).toBeNull();
        expect(decisionAuth(asArgs('assistant-session-A', undefined))).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
        // Another live session's valid token never authorizes the bound assistant.
        expect(decisionAuth(asArgs('assistant-session-A', otherToken))).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
        // The bound assistant's id with a token minted for someone else's id.
        expect(decisionAuth(asArgs('assistant-session-B', token))).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
        expect(decisionAuth(asArgs('assistant-session-A', 'mcp_sess_forged'))).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
    });

    it('project_send: text (even with an empty attachment list) needs no credential; attachments need the bound token, before and after restart', async () => {
        useFileStore();
        const token = mintMcpSessionCredential({ sessionId: 'assistant-session-A', isCoordinator: false });
        const base = { assistantSessionId: 'assistant-session-A', project: MESH, message: 'hello' };
        expect(await send({ ...base, attachments: [] })).toMatchObject({ success: true });
        expect(await send({ ...base })).toMatchObject({ success: true });
        expect(sent).toHaveLength(2);

        const withFiles = { ...base, messageId: 'm1', attachments: ['art_x'] };
        expect(await send(withFiles)).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
        for (const phase of ['before restart', 'after restart']) {
            if (phase === 'after restart') __forgetMcpSessionCredentialMemoryForTest();
            const r = await send({ ...withFiles, mcpSessionCredential: token });
            // Authorized: it fails later, on the unknown artifact, not on credentials.
            expect(r.code, phase).not.toBe('COMMAND_SOURCE_REJECTED');
        }
        const otherToken = mintMcpSessionCredential({ sessionId: 'assistant-session-B', isCoordinator: false });
        expect(await send({ ...withFiles, mcpSessionCredential: otherToken })).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
    });
});

describe('session replacement and revocation', () => {
    it('the replaced session\'s token stops working at once and after restart; the new one works', () => {
        useFileStore();
        const oldToken = mintMcpSessionCredential({ sessionId: 'assistant-session-A', isCoordinator: false });
        // registry.bindSession: revoke previous, bind (and ensure) the replacement.
        revokeMcpSessionCredential('assistant-session-A');
        const newToken = mintMcpSessionCredential({ sessionId: 'assistant-session-B', isCoordinator: false });
        bound.sid = 'assistant-session-B';
        for (const restart of [false, true]) {
            if (restart) __forgetMcpSessionCredentialMemoryForTest();
            expect(decisionAuth(asArgs('assistant-session-A', oldToken))).toMatchObject({ code: 'COMMAND_SOURCE_REJECTED' });
            expect(decisionAuth(asArgs('assistant-session-B', oldToken))).toMatchObject({ code: 'COMMAND_SOURCE_REJECTED' });
            expect(decisionAuth(asArgs('assistant-session-B', newToken))).toBeNull();
        }
    });

    it('a re-issue for the same session invalidates the previous token even after restart', () => {
        useFileStore();
        const first = mintMcpSessionCredential({ sessionId: 'assistant-session-A', isCoordinator: false });
        const second = mintMcpSessionCredential({ sessionId: 'assistant-session-A', isCoordinator: false });
        __forgetMcpSessionCredentialMemoryForTest();
        expect(verifyMcpSessionCredential(first)).toBeNull();
        expect(verifyMcpSessionCredential(second)?.sessionId).toBe('assistant-session-A');
    });

    it('a revocation whose file delete fails does not let the token come back, now or on the next revoke', () => {
        const real = useFileStore();
        let failDeletes = true;
        const flaky: McpSessionCredentialPersistence = {
            put: (row) => real.put(row),
            getByHash: (h) => real.getByHash(h),
            getBySession: (s) => real.getBySession(s),
            deleteBySession: (s) => { if (failDeletes) throw new Error('ENOSPC'); real.deleteBySession(s); },
            list: () => real.list(),
            deleteAll: () => real.deleteAll(),
        };
        __setMcpSessionCredentialPersistenceForTest(flaky);
        const token = mintMcpSessionCredential({ sessionId: 'assistant-session-A', isCoordinator: false });
        revokeMcpSessionCredential('assistant-session-A');
        // The hash is still on disk, but this process must treat it as revoked.
        expect(real.getBySession('assistant-session-A')).not.toBeNull();
        expect(verifyMcpSessionCredential(token)).toBeNull();
        expect(ensureMcpSessionCredential({ sessionId: 'assistant-session-A', isCoordinator: false })).not.toBe(token);
        // Once the disk recovers, the next revoke also retires the stale row.
        failDeletes = false;
        revokeMcpSessionCredential('assistant-session-Z');
        expect(real.list().some((row) => row.tokenHash === hashMcpSessionCredential(token))).toBe(false);
    });
});
