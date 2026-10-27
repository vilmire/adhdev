/**
 * MCP authority over the cloud daemon's local-IPC envelope (`mcpAuth`).
 * The IPC transport must grant exactly what the standalone HTTP gate grants for
 * the same credential — through the same primitives — and nothing more.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
    __resetMcpSessionCredentialsForTest,
    mintMcpSessionCredential,
    readAuthenticatedMcpCommand,
    readAuthenticatedMcpScope,
    revokeMcpSessionCredential,
} from '../../src/commands/mcp-command-ingress.js';
import { attachIpcMcpAuthority, readIpcMcpAuthEnvelope } from '../../src/commands/mcp-authority-attach.js';
import { registerMeshCoordinator, unregisterMeshCoordinator } from '../../src/mesh/coordinator-registry.js';
import { preserveTrustedOwnerTransportProof } from '../../src/commands/command-args.js';
import {
    __resetWorkerSessionBindsForTest,
    mintWorkerSessionBind,
} from '../../src/worker-session-bind-registry.js';

afterEach(() => {
    unregisterMeshCoordinator('coord-ipc-1');
    __resetMcpSessionCredentialsForTest();
    __resetWorkerSessionBindsForTest();
});

function frame(auth: unknown) { return { command: 'x', args: {}, mcpAuth: auth }; }
function env(auth: unknown) { return readIpcMcpAuthEnvelope(frame(auth)); }
/** What host.execute does to the args before the router/handlers read them. */
function viaHost<T extends Record<string, unknown>>(args: T): Record<string, unknown> {
    return preserveTrustedOwnerTransportProof(args, { ...args, _interactionId: 'i-1' });
}
function coordCred() {
    registerMeshCoordinator({ meshId: 'mesh-ipc-1', sessionId: 'coord-ipc-1', workspace: '/w', startedAt: Date.now() });
    return mintMcpSessionCredential({ sessionId: 'coord-ipc-1', meshId: 'mesh-ipc-1', isCoordinator: true });
}

describe('readIpcMcpAuthEnvelope', () => {
    it('ignores missing, malformed and non-string envelopes', () => {
        expect(readIpcMcpAuthEnvelope({ command: 'x' })).toBeNull();
        expect(env(null)).toBeNull();
        expect(env([])).toBeNull();
        expect(env('tok')).toBeNull();
        expect(env({ sessionCredential: 42 })).toBeNull();
        expect(env({ sessionCredential: '   ' })).toBeNull();
        expect(env({ sessionCredential: 'x'.repeat(5000) })).toBeNull();
        expect(env({ sessionCredential: ' mcp_sess_a ' })).toEqual({ sessionCredential: 'mcp_sess_a' });
    });
    it('a credential smuggled inside args is not read as an envelope', () => {
        expect(readIpcMcpAuthEnvelope({ command: 'artifact_list', args: { mcpAuth: { sessionCredential: 'mcp_sess_a' } } })).toBeNull();
    });
});

describe('cloud IPC session credential', () => {
    it('valid coordinator credential: artifact_list gets the coordinator scope', () => {
        const cred = coordCred();
        const args = { callerSessionId: 'coord-ipc-1', meshId: 'mesh-ipc-1' };
        expect(attachIpcMcpAuthority(args, 'artifact_list', env({ sessionCredential: cred }))).toEqual({ ok: true });
        const seen = viaHost(args);
        expect(readAuthenticatedMcpCommand(seen, 'artifact_list')).toEqual({ present: true, valid: true });
        expect(readAuthenticatedMcpScope(seen, 'artifact_list')).toMatchObject({
            sessionId: 'coord-ipc-1', meshId: 'mesh-ipc-1', isCoordinator: true,
        });
    });

    it('forged / unknown credential on an artifact verb is a denied capability', () => {
        const args = { callerSessionId: 'coord-ipc-1', meshId: 'mesh-ipc-1' };
        attachIpcMcpAuthority(args, 'artifact_list', env({ sessionCredential: 'mcp_sess_forged' }));
        expect(readAuthenticatedMcpCommand(viaHost(args), 'artifact_list')).toEqual({ present: true, valid: false });
        expect(readAuthenticatedMcpScope(viaHost(args), 'artifact_list')).toBeNull();
    });

    it('credential invalidates after unregister (revocation) even mid-flight', () => {
        const cred = coordCred();
        const args = { callerSessionId: 'coord-ipc-1', meshId: 'mesh-ipc-1' };
        attachIpcMcpAuthority(args, 'artifact_list', env({ sessionCredential: cred }));
        const seen = viaHost(args);
        expect(readAuthenticatedMcpCommand(seen, 'artifact_list').valid).toBe(true);
        unregisterMeshCoordinator('coord-ipc-1');
        revokeMcpSessionCredential('coord-ipc-1');
        expect(readAuthenticatedMcpCommand(seen, 'artifact_list').valid).toBe(false);
        // and a fresh frame with the same (now dead) credential is denied
        const again = { callerSessionId: 'coord-ipc-1', meshId: 'mesh-ipc-1' };
        attachIpcMcpAuthority(again, 'artifact_list', env({ sessionCredential: cred }));
        expect(readAuthenticatedMcpCommand(viaHost(again), 'artifact_list').valid).toBe(false);
    });

    it('credential for session A cannot act as session B', () => {
        const credA = mintMcpSessionCredential({ sessionId: 'sess-a', isCoordinator: false });
        mintMcpSessionCredential({ sessionId: 'sess-b', isCoordinator: false });
        const asB = { callerSessionId: 'sess-b', sessionId: 'sess-b', artifactId: 'art_0123456789abcdef' };
        attachIpcMcpAuthority(asB, 'artifact_read', env({ sessionCredential: credA }));
        expect(readAuthenticatedMcpCommand(viaHost(asB), 'artifact_read').valid).toBe(false);
        const asA = { callerSessionId: 'sess-a', artifactId: 'art_0123456789abcdef' };
        attachIpcMcpAuthority(asA, 'artifact_read', env({ sessionCredential: credA }));
        expect(readAuthenticatedMcpScope(viaHost(asA), 'artifact_read')).toMatchObject({ sessionId: 'sess-a', isCoordinator: false });
    });

    it('a non-coordinator credential never becomes coordinator via payload meshId', () => {
        const cred = mintMcpSessionCredential({ sessionId: 'plain-1', isCoordinator: false });
        const args = { meshId: 'mesh-ipc-1' };
        attachIpcMcpAuthority(args, 'artifact_list', env({ sessionCredential: cred }));
        expect(readAuthenticatedMcpCommand(viaHost(args), 'artifact_list').valid).toBe(false);
    });

    it('no credential / non-artifact verb: nothing attached (today\'s behaviour)', () => {
        const a = { callerSessionId: 'coord-ipc-1' };
        attachIpcMcpAuthority(a, 'artifact_list', null);
        expect(readAuthenticatedMcpCommand(viaHost(a), 'artifact_list')).toEqual({ present: false, valid: false });
        const cred = mintMcpSessionCredential({ sessionId: 'plain-2', isCoordinator: false });
        const b = { sessionId: 'plain-2' };
        attachIpcMcpAuthority(b, 'read_chat', env({ sessionCredential: cred }));
        expect(readAuthenticatedMcpCommand(viaHost(b), 'read_chat')).toEqual({ present: false, valid: false });
    });

    it('a closed connection revokes the capability', () => {
        const cred = mintMcpSessionCredential({ sessionId: 'plain-3', isCoordinator: false });
        let open = true;
        const args = { callerSessionId: 'plain-3' };
        attachIpcMcpAuthority(args, 'artifact_list', env({ sessionCredential: cred }), () => open);
        const seen = viaHost(args);
        expect(readAuthenticatedMcpCommand(seen, 'artifact_list').valid).toBe(true);
        open = false;
        expect(readAuthenticatedMcpCommand(seen, 'artifact_list').valid).toBe(false);
    });

    it('presenting both a session and a worker credential grants nothing', () => {
        const cred = mintMcpSessionCredential({ sessionId: 'plain-4', isCoordinator: false });
        const bind = mintWorkerSessionBind({ meshId: 'm1', sessionId: 'w-1' }).bind;
        const args = { callerSessionId: 'plain-4', bind };
        attachIpcMcpAuthority(args, 'artifact_list', env({ sessionCredential: cred, workerCredential: bind }));
        expect(readAuthenticatedMcpCommand(viaHost(args), 'artifact_list').valid).toBe(false);
    });
});

describe('cloud IPC worker credential', () => {
    it('live worker bind: worker artifact verb gets the worker scope; args must carry the same bind', () => {
        const bind = mintWorkerSessionBind({ meshId: 'm1', sessionId: 'w-1' }).bind;
        const ok = { bind, path: 'a.md' };
        expect(attachIpcMcpAuthority(ok, 'artifact_register', env({ workerCredential: bind }))).toEqual({ ok: true });
        expect(readAuthenticatedMcpScope(viaHost(ok), 'artifact_register')).toMatchObject({
            sessionId: 'w-1', meshId: 'm1', isCoordinator: false,
        });
        const noBind = { path: 'a.md' };
        attachIpcMcpAuthority(noBind, 'artifact_register', env({ workerCredential: bind }));
        expect(readAuthenticatedMcpCommand(viaHost(noBind), 'artifact_register').valid).toBe(false);
        const otherBind = mintWorkerSessionBind({ meshId: 'm1', sessionId: 'w-2' }).bind;
        const mixed = { bind: otherBind, path: 'a.md' };
        attachIpcMcpAuthority(mixed, 'artifact_register', env({ workerCredential: bind }));
        expect(readAuthenticatedMcpCommand(viaHost(mixed), 'artifact_register').valid).toBe(false);
    });

    it('live worker credential is refused for non-worker verbs', () => {
        const bind = mintWorkerSessionBind({ meshId: 'm1', sessionId: 'w-1' }).bind;
        for (const verb of ['assistant_artifact_list', 'launch_cli', 'mesh_status', 'artifact_fetch']) {
            const r = attachIpcMcpAuthority({ bind }, verb, env({ workerCredential: bind }));
            expect(r).toMatchObject({ ok: false, code: 'worker_scope_forbidden' });
        }
        expect(attachIpcMcpAuthority({ bind }, 'worker_progress_update', env({ workerCredential: bind }))).toEqual({ ok: true });
    });

    it('dead worker bind is a denied capability on artifact verbs', () => {
        const args = { bind: 'wsb_not_real' };
        expect(attachIpcMcpAuthority(args, 'artifact_register', env({ workerCredential: 'wsb_not_real' }))).toEqual({ ok: true });
        expect(readAuthenticatedMcpCommand(viaHost(args), 'artifact_register').valid).toBe(false);
    });

    it('a session credential cannot be used as a worker credential and vice versa', () => {
        const cred = mintMcpSessionCredential({ sessionId: 'plain-5', isCoordinator: false });
        const asWorker = { bind: cred, callerSessionId: 'plain-5' };
        attachIpcMcpAuthority(asWorker, 'artifact_register', env({ workerCredential: cred }));
        expect(readAuthenticatedMcpCommand(viaHost(asWorker), 'artifact_register').valid).toBe(false);
        const bind = mintWorkerSessionBind({ meshId: 'm1', sessionId: 'w-3' }).bind;
        const asSession = { callerSessionId: 'w-3' };
        attachIpcMcpAuthority(asSession, 'artifact_list', env({ sessionCredential: bind }));
        expect(readAuthenticatedMcpCommand(viaHost(asSession), 'artifact_list').valid).toBe(false);
    });
});
