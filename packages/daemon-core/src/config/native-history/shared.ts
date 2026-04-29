import * as fs from 'fs';
import * as path from 'path';

export function normalizeHistorySessionId(sessionId: string | undefined): string {
    return String(sessionId || '').trim();
}

export function isSafeNativeHistorySessionId(sessionId: string | undefined): boolean {
    const normalized = normalizeHistorySessionId(sessionId);
    if (!normalized) return false;
    if (normalized.includes('\0')) return false;
    if (normalized.includes('/') || normalized.includes('\\')) return false;
    if (normalized === '.' || normalized === '..') return false;
    if (normalized.includes('..')) return false;
    return path.basename(normalized) === normalized;
}

export function isPathInside(root: string, candidatePath: string): boolean {
    const resolvedRoot = path.resolve(root);
    const resolvedPath = path.resolve(candidatePath);
    return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`);
}

export function resolvePathInside(root: string, ...segments: string[]): string | null {
    const resolvedRoot = path.resolve(root);
    const resolvedPath = path.resolve(resolvedRoot, ...segments);
    if (resolvedPath === resolvedRoot) return resolvedPath;
    return resolvedPath.startsWith(`${resolvedRoot}${path.sep}`) ? resolvedPath : null;
}

export function extractTimestampValue(value: unknown): number {
    const numericTimestamp = Number(value || 0);
    if (Number.isFinite(numericTimestamp) && numericTimestamp > 0) return numericTimestamp;
    const stringTimestamp = typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isFinite(stringTimestamp) && stringTimestamp > 0) return stringTimestamp;
    return 0;
}

export function statMtimeMs(filePath: string): number {
    try { return fs.statSync(filePath).mtimeMs; } catch { return 0; }
}

export function listFilesRecursive(root: string, predicate: (entryPath: string, entry: fs.Dirent) => boolean): string[] {
    if (!fs.existsSync(root)) return [];
    const results: string[] = [];
    const stack = [root];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) continue;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(entryPath);
                continue;
            }
            if (predicate(entryPath, entry)) results.push(entryPath);
        }
    }
    return results;
}
