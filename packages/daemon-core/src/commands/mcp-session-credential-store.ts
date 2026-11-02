/**
 * Durable MCP session-credential bindings.
 *
 * Only SHA-256(token) is stored — never the `mcp_sess_` secret. A restarted
 * daemon adopts the hash for the same session instead of minting a new token
 * the already-running MCP child cannot learn. Presentation of the original
 * token reattaches the raw secret in memory only.
 *
 * Local file, mode 0600. Not a seqscribe topic and not a cloud status field.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface PersistedMcpSessionCredential {
    tokenHash: string;
    sessionId: string;
    meshId?: string;
    isCoordinator: boolean;
    mintedAtMs: number;
}

export interface McpSessionCredentialPersistence {
    put(row: PersistedMcpSessionCredential): void;
    getByHash(tokenHash: string): PersistedMcpSessionCredential | null;
    getBySession(sessionId: string): PersistedMcpSessionCredential | null;
    deleteBySession(sessionId: string): void;
    list(): PersistedMcpSessionCredential[];
    deleteAll(): void;
}

const HASH_RE = /^[a-f0-9]{64}$/;

function isRow(value: unknown): value is PersistedMcpSessionCredential {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    if (typeof row.tokenHash !== 'string' || !HASH_RE.test(row.tokenHash)) return false;
    if (typeof row.sessionId !== 'string' || row.sessionId.trim().length === 0) return false;
    if (typeof row.isCoordinator !== 'boolean') return false;
    if (typeof row.mintedAtMs !== 'number' || !Number.isFinite(row.mintedAtMs)) return false;
    if (row.meshId !== undefined && typeof row.meshId !== 'string') return false;
    // A raw session credential must never land in the file, even under another key.
    if (JSON.stringify(row).includes('mcp_sess_')) return false;
    return true;
}

export class FileMcpSessionCredentialStore implements McpSessionCredentialPersistence {
    constructor(private readonly filePath: string) {}

    put(row: PersistedMcpSessionCredential): void {
        if (!isRow(row)) throw new Error('refusing to persist an MCP session credential that is not a hash binding');
        const next = this.read().filter((entry) => entry.sessionId !== row.sessionId && entry.tokenHash !== row.tokenHash);
        next.push({
            tokenHash: row.tokenHash,
            sessionId: row.sessionId,
            ...(row.meshId ? { meshId: row.meshId } : {}),
            isCoordinator: row.isCoordinator,
            mintedAtMs: row.mintedAtMs,
        });
        this.write(next);
    }

    getByHash(tokenHash: string): PersistedMcpSessionCredential | null {
        return this.read().find((entry) => entry.tokenHash === tokenHash) ?? null;
    }

    getBySession(sessionId: string): PersistedMcpSessionCredential | null {
        return this.read().find((entry) => entry.sessionId === sessionId) ?? null;
    }

    deleteBySession(sessionId: string): void {
        this.write(this.read().filter((entry) => entry.sessionId !== sessionId));
    }

    list(): PersistedMcpSessionCredential[] {
        return this.read();
    }

    deleteAll(): void {
        this.write([]);
    }

    private read(): PersistedMcpSessionCredential[] {
        try {
            const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as { version?: unknown; entries?: unknown };
            if (raw?.version !== 1 || !Array.isArray(raw.entries)) return [];
            return raw.entries.filter(isRow);
        } catch {
            return [];
        }
    }

    private write(entries: PersistedMcpSessionCredential[]): void {
        const body = JSON.stringify({ version: 1, entries });
        if (body.includes('mcp_sess_')) throw new Error('refusing to persist a raw MCP session credential');
        mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
        const tmp = `${this.filePath}.${process.pid}.tmp`;
        writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, this.filePath);
        chmodSync(this.filePath, 0o600);
    }
}
