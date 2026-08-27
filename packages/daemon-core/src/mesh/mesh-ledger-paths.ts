/**
 * Mesh ledger path helpers.
 *
 * Pure move out of mesh-ledger.ts (file-size gate) so that mesh-ledger.ts and
 * mesh-ledger-read-cache.ts can both resolve ledger file paths without either
 * importing the other. Behaviour is unchanged — every function is byte-identical
 * to its previous definition, including the path-traversal sanitizer.
 */
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getConfigDir } from '../config/config.js';

const LEDGER_DIR_NAME = 'mesh-ledger';

/** Sanitize a meshId for use as a filename component (path-traversal guard). */
function safeMeshId(meshId: string): string {
    return meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function getLedgerDir(): string {
    const dir = join(getConfigDir(), LEDGER_DIR_NAME);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return dir;
}

export function getLedgerPath(meshId: string): string {
    return join(getLedgerDir(), `${safeMeshId(meshId)}.jsonl`);
}

export function getRotatedPath(meshId: string, index: number): string {
    return join(getLedgerDir(), `${safeMeshId(meshId)}.${index}.jsonl`);
}

export function getArchivePath(meshId: string): string {
    return join(getLedgerDir(), `${safeMeshId(meshId)}.archive.jsonl`);
}

export function getRotatedArchivePath(meshId: string, index: number): string {
    return join(getLedgerDir(), `${safeMeshId(meshId)}.archive.${index}.jsonl`);
}

export function getArchivedTerminalKeysPath(meshId: string): string {
    return join(getLedgerDir(), `${safeMeshId(meshId)}.archived-terminal-keys.json`);
}
