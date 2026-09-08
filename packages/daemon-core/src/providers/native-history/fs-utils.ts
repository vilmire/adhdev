import * as fs from 'node:fs';

/**
 * Guard for a filename taken from a transcript directory listing before it is
 * joined onto a path: conservative character allow-list plus an explicit `..`
 * rejection so no entry can traverse out of the directory being scanned.
 */
export function isSafeFilename(name: string): boolean {
    return /^[A-Za-z0-9._:-]+$/.test(name) && !name.includes('..');
}

/** mtime in epoch ms, or `0` when the path cannot be stat'ed. */
export function statMtimeMs(filePath: string): number {
    try { return fs.statSync(filePath).mtimeMs; } catch { return 0; }
}
