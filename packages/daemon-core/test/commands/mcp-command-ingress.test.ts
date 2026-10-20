import { describe, expect, it } from 'vitest';
import { attachAuthenticatedMcpCommand, bindAuthenticatedMcpWorkspace, preserveAuthenticatedMcpCommand, readAuthenticatedMcpCommand } from '../../src/commands/mcp-command-ingress.js';
import { isTrustedOwnerIngress, preserveTrustedOwnerIngress, preserveTrustedOwnerTransportProof } from '../../src/commands/command-args.js';

describe('authenticated MCP command capability (independent of owner authority)', () => {
    it('retains one command and exact argument scope through host/router copies, never JSON or spread', () => {
        const raw = attachAuthenticatedMcpCommand({ sessionId: 'registered', limit: 5 }, 'artifact_list', () => true);
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
        const raw = attachAuthenticatedMcpCommand({ sessionId: 'registered', path: 'doc.md' }, 'artifact_register', () => live);
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
        const invalid = attachAuthenticatedMcpCommand({}, 'artifact_list', () => false);
        expect(readAuthenticatedMcpCommand(invalid, 'artifact_list')).toEqual({ present: true, valid: false });
        const unrelated = attachAuthenticatedMcpCommand({}, 'get_command_history', () => true);
        expect(readAuthenticatedMcpCommand(unrelated, 'get_command_history').present).toBe(false);
    });
});
