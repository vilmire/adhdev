/**
 * Session credentials survive a daemon restart as a SHA-256 binding.
 * Same-session ensure adopts that hash and does not mint. A replaced,
 * revoked, or other session's token does not verify.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
import { FileMcpSessionCredentialStore } from '../../src/commands/mcp-session-credential-store.js';

const roots: string[] = [];

function tempStore(): FileMcpSessionCredentialStore {
    const dir = mkdtempSync(join(tmpdir(), 'adhdev-mcp-cred-'));
    roots.push(dir);
    const store = new FileMcpSessionCredentialStore(join(dir, 'mcp-session-credentials.json'));
    __setMcpSessionCredentialPersistenceForTest(store);
    return store;
}

afterEach(() => {
    __resetMcpSessionCredentialsForTest();
    __setMcpSessionCredentialPersistenceForTest(null);
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('MCP session credential hash binding', () => {
    it('persists only the SHA-256 and adopts it across a memory restart', () => {
        const store = tempStore();
        const token = mintMcpSessionCredential({ sessionId: 'assistant-1', isCoordinator: false });
        const file = readFileSync(join(roots[0]!, 'mcp-session-credentials.json'), 'utf8');
        expect(file).not.toContain(token);
        expect(file).not.toContain('mcp_sess_');
        expect(file).toContain(hashMcpSessionCredential(token));
        expect(store.getBySession('assistant-1')?.tokenHash).toBe(hashMcpSessionCredential(token));

        __forgetMcpSessionCredentialMemoryForTest();
        expect(ensureMcpSessionCredential({ sessionId: 'assistant-1', isCoordinator: false })).toBeNull();
        expect(store.getBySession('assistant-1')?.tokenHash).toBe(hashMcpSessionCredential(token));
        expect(verifyMcpSessionCredential(token)).toEqual({ sessionId: 'assistant-1', isCoordinator: false });
        expect(ensureMcpSessionCredential({ sessionId: 'assistant-1', isCoordinator: false })).toBe(token);
    });

    it('refuses a replaced, revoked, or different session token', () => {
        tempStore();
        const first = mintMcpSessionCredential({ sessionId: 'assistant-1', isCoordinator: false });
        const other = mintMcpSessionCredential({ sessionId: 'assistant-2', isCoordinator: false });
        const replaced = mintMcpSessionCredential({ sessionId: 'assistant-1', isCoordinator: false });
        expect(verifyMcpSessionCredential(first)).toBeNull();
        expect(verifyMcpSessionCredential(replaced)?.sessionId).toBe('assistant-1');
        expect(verifyMcpSessionCredential(other)?.sessionId).toBe('assistant-2');
        expect(verifyMcpSessionCredential(replaced)?.sessionId).not.toBe('assistant-2');

        __forgetMcpSessionCredentialMemoryForTest();
        expect(verifyMcpSessionCredential(first)).toBeNull();
        expect(verifyMcpSessionCredential(replaced)?.sessionId).toBe('assistant-1');
        revokeMcpSessionCredential('assistant-1');
        expect(verifyMcpSessionCredential(replaced)).toBeNull();
        expect(verifyMcpSessionCredential(other)?.sessionId).toBe('assistant-2');
    });
});
