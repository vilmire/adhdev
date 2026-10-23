import { afterEach, describe, expect, it } from 'vitest';
import {
    __resetMcpSessionCredentialsForTest,
    attachAuthenticatedMcpCommand,
    bindAuthenticatedMcpWorkspace,
    mintMcpSessionCredential,
    preserveAuthenticatedMcpCommand,
    readAuthenticatedMcpCommand,
    readAuthenticatedMcpScope,
    revokeMcpSessionCredential,
    verifyMcpSessionCredential,
} from '../../src/commands/mcp-command-ingress.js';
import { registerMeshCoordinator, unregisterMeshCoordinator } from '../../src/mesh/coordinator-registry.js';
import { isTrustedOwnerIngress, preserveTrustedOwnerIngress, preserveTrustedOwnerTransportProof } from '../../src/commands/command-args.js';

afterEach(() => {
    unregisterMeshCoordinator('coord-r3-1');
    __resetMcpSessionCredentialsForTest();
});

describe('authenticated MCP command capability (independent of owner authority)', () => {
    it('retains one command and exact argument scope through host/router copies, never JSON or spread', () => {
        const raw = attachAuthenticatedMcpCommand(
            { sessionId: 'registered', limit: 5 },
            'artifact_list',
            () => true,
            { sessionId: 'registered', isCoordinator: false },
        );
        const host = preserveTrustedOwnerTransportProof(raw, { ...raw, _interactionId: 'itx' });
        const router = preserveTrustedOwnerIngress(host, { ...host, targetSessionId: 'registered' });
        expect(readAuthenticatedMcpCommand(router, 'artifact_list')).toEqual({ present: true, valid: true });
        expect(isTrustedOwnerIngress(router)).toBe(false);
        for (const clone of [{ ...router }, JSON.parse(JSON.stringify(router)), { ...router, mcpVerified: true }]) {
            expect(readAuthenticatedMcpCommand(clone, 'artifact_list')).toEqual({ present: false, valid: false });
        }
        expect(readAuthenticatedMcpCommand(router, 'session_artifact_list').valid).toBe(false);
        for (const fields of [{ sessionId: 'foreign' }, { targetSessionId: 'foreign' }, { limit: 50 }, { meshId: 'foreign' }, { workspaceRoot: '/foreign' }]) {
            const modified = preserveAuthenticatedMcpCommand(router, { ...router, ...fields });
            expect(readAuthenticatedMcpCommand(modified, 'artifact_list')).toEqual({ present: true, valid: false });
        }
    });

    it('pins the authorized workspace and retains revocation on every supported copy path', () => {
        let live = true;
        const raw = attachAuthenticatedMcpCommand(
            { sessionId: 'registered', path: 'doc.md' },
            'artifact_register',
            () => live,
            { sessionId: 'registered', isCoordinator: false },
        );
        expect(bindAuthenticatedMcpWorkspace(raw, '/registered')).toBe(true);
        expect(bindAuthenticatedMcpWorkspace(raw, '/foreign')).toBe(false);
        const copy = preserveTrustedOwnerIngress(raw, { ...raw });
        expect(bindAuthenticatedMcpWorkspace(copy, '/registered')).toBe(true);
        live = false;
        const afterRevocation = preserveTrustedOwnerTransportProof(copy, { ...copy });
        expect(readAuthenticatedMcpCommand(afterRevocation, 'artifact_register')).toEqual({ present: true, valid: false });
        expect(bindAuthenticatedMcpWorkspace(afterRevocation, '/registered')).toBe(false);
        live = true;
        expect(readAuthenticatedMcpCommand(afterRevocation, 'artifact_register').valid).toBe(false);
        const invalid = attachAuthenticatedMcpCommand({}, 'artifact_list', () => false, { sessionId: 'registered' });
        expect(readAuthenticatedMcpCommand(invalid, 'artifact_list')).toEqual({ present: true, valid: false });
        const unrelated = attachAuthenticatedMcpCommand({}, 'get_command_history', () => true, { sessionId: 'registered' });
        expect(readAuthenticatedMcpCommand(unrelated, 'get_command_history').present).toBe(false);
    });

    it('rejects forged payload sessionId/callerSessionId when bound to a session and never stamps owner-only fetch aliases', () => {
        for (const cmd of ['artifact_fetch', 'session_artifact_fetch'] as const) {
            const rawFetch = attachAuthenticatedMcpCommand(
                { sessionId: 'registered', artifactId: 'art_0123456789abcdef' },
                cmd,
                () => true,
                { sessionId: 'registered' },
            );
            expect(readAuthenticatedMcpCommand(rawFetch, cmd)).toEqual({ present: false, valid: false });
        }

        const forgedRead = attachAuthenticatedMcpCommand(
            { sessionId: 'victim', artifactId: 'art_0123456789abcdef' },
            'artifact_read',
            () => true,
            { sessionId: 'registered' },
        );
        expect(readAuthenticatedMcpCommand(forgedRead, 'artifact_read')).toEqual({ present: true, valid: false });

        const forgedCaller = attachAuthenticatedMcpCommand(
            { sessionId: 'registered', callerSessionId: 'coord-forged' },
            'artifact_list',
            () => true,
            { sessionId: 'registered' },
        );
        expect(readAuthenticatedMcpCommand(forgedCaller, 'artifact_list')).toEqual({ present: true, valid: false });

        const forgedWorkerMeshRead = attachAuthenticatedMcpCommand(
            { sessionId: 'worker-unregistered-coord', meshId: 'mesh-1', artifactId: 'art_0123456789abcdef' },
            'artifact_read',
            () => true,
            { sessionId: 'worker-unregistered-coord', isCoordinator: false },
        );
        expect(readAuthenticatedMcpCommand(forgedWorkerMeshRead, 'artifact_read')).toEqual({ present: true, valid: false });

        const missingBoundScope = attachAuthenticatedMcpCommand(
            { sessionId: 'registered', limit: 5 },
            'artifact_list',
            () => true,
            null,
        );
        expect(readAuthenticatedMcpCommand(missingBoundScope, 'artifact_list')).toEqual({ present: true, valid: false });
    });

    it('Round 3 Finding 2: mints/verifies session-bound credentials, refuses payload sessionId mismatch and mesh-only coordinator escalation, and allows genuine coordinator/session scopes', () => {
        registerMeshCoordinator({
            meshId: 'mesh-r3-1',
            sessionId: 'coord-r3-1',
            workspace: '/coord/ws',
            startedAt: Date.now(),
        });

        const coordCred = mintMcpSessionCredential({
            sessionId: 'coord-r3-1',
            meshId: 'mesh-r3-1',
            isCoordinator: true,
        });
        const nonCoordCred = mintMcpSessionCredential({
            sessionId: 'plain-sess-1',
            isCoordinator: false,
        });

        const verifiedCoord = verifyMcpSessionCredential(coordCred);
        expect(verifiedCoord).toEqual({
            sessionId: 'coord-r3-1',
            meshId: 'mesh-r3-1',
            isCoordinator: true,
        });
        const verifiedPlain = verifyMcpSessionCredential(nonCoordCred);
        expect(verifiedPlain).toEqual({
            sessionId: 'plain-sess-1',
            isCoordinator: false,
        });

        // 1. Session-bound credential + a different payload sessionId is refused
        const crossSessionRead = attachAuthenticatedMcpCommand(
            { sessionId: 'other-sess-2', artifactId: 'art_0123456789abcdef' },
            'artifact_read',
            () => true,
            verifiedPlain,
        );
        expect(readAuthenticatedMcpCommand(crossSessionRead, 'artifact_read')).toEqual({
            present: true,
            valid: false,
        });

        // 2. A mesh-only payload never grants coordinator status without a coordinator-bound credential
        const meshOnlyNoScope = attachAuthenticatedMcpCommand(
            { meshId: 'mesh-r3-1' },
            'artifact_list',
            () => true,
            null,
        );
        expect(readAuthenticatedMcpCommand(meshOnlyNoScope, 'artifact_list')).toEqual({
            present: true,
            valid: false,
        });
        expect(readAuthenticatedMcpScope(meshOnlyNoScope, 'artifact_list')).toBeNull();

        const meshOnlyPlainCred = attachAuthenticatedMcpCommand(
            { meshId: 'mesh-r3-1' },
            'artifact_list',
            () => true,
            verifiedPlain,
        );
        expect(readAuthenticatedMcpCommand(meshOnlyPlainCred, 'artifact_list')).toEqual({
            present: true,
            valid: false,
        });
        expect(readAuthenticatedMcpScope(meshOnlyPlainCred, 'artifact_list')).toBeNull();

        // 3. Genuine coordinator credential works for its mesh and revokes on unregister
        const genuineCoordList = attachAuthenticatedMcpCommand(
            { sessionId: 'worker-in-mesh', callerSessionId: 'coord-r3-1', meshId: 'mesh-r3-1' },
            'artifact_list',
            () => verifyMcpSessionCredential(coordCred) !== null,
            verifiedCoord,
        );
        expect(readAuthenticatedMcpCommand(genuineCoordList, 'artifact_list')).toEqual({
            present: true,
            valid: true,
        });
        expect(readAuthenticatedMcpScope(genuineCoordList, 'artifact_list')).toEqual({
            sessionId: 'coord-r3-1',
            meshId: 'mesh-r3-1',
            isCoordinator: true,
        });

        revokeMcpSessionCredential('coord-r3-1');
        expect(verifyMcpSessionCredential(coordCred)).toBeNull();
        expect(readAuthenticatedMcpCommand(genuineCoordList, 'artifact_list')).toEqual({
            present: true,
            valid: false,
        });
    });
});
