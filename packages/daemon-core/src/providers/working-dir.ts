/**
 * working-dir — shared helpers for deriving display names from a session's
 * working directory. Used by CLI/ACP provider instances to build session/tab
 * titles.
 */

/**
 * OS-aware basename of a working directory path.
 *
 * Splits on BOTH POSIX (`/`) and Windows (`\`) separators so a win32 path like
 * `D:\gh\adhdev-cloud` resolves to `adhdev-cloud` even when the daemon's own
 * `path.basename` is POSIX-only — and a path that mixes separators still works.
 * Trailing separators and root-only paths fall back to `'session'`, matching
 * the historical `.split('/').filter(Boolean).pop() || 'session'` behavior.
 *
 * Mirrors the web dashboard's `getWorkspaceName` (`ws.split(/[/\\]/)`).
 */
export function workingDirBasename(p: string): string {
    return (p || '')
        .split(/[\\/]/)
        .filter(Boolean)
        .pop() || 'session';
}
