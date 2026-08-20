/**
 * Health of an absolute path ADHDev embedded in someone ELSE's config file.
 *
 * ── The failure class this exists to name ──
 * Several features work by writing an absolute path to one of our own scripts
 * into a config file owned by a third party or the user: the Claude Code
 * statusline wrapper in `~/.claude/settings.json`, the `adhdev-mesh` MCP server
 * entry in `.mcp.json` / `.cursor/mcp.json` / `~/.codex/config.toml`. Those
 * files outlive the path they point at — a worktree is deleted, a temp dir is
 * reaped, an npm install dir is replaced on upgrade — and the config keeps
 * naming a file that is no longer there. The reference is *dangling*.
 *
 * A dangling reference is NOT the same as "not configured", and code that
 * cannot tell them apart reports confidently wrong things. Measured on
 * 2026-08-20: `statusLine.command` pointed at a deleted worktree scratchpad, so
 * the wrapper exited `MODULE_NOT_FOUND` on every invocation; because the
 * install check matched on the command STRING only and never asked the
 * filesystem, `readStatuslineStatus()` answered `installed: true` and the CLI
 * told the user to "open a Claude Code session to record one" — while four
 * sessions were already running. The same blindness made `claude:install` print
 * "You had no statusline configured" about a statusLine that plainly existed.
 * Two messages, mutually contradictory, both wrong, from one missing
 * `existsSync`.
 *
 * So: three states, never two. `ok` / `missing` / `absent` are distinct
 * answers, and callers must render them distinctly.
 *
 * ── Why one module rather than an existsSync at each site ──
 * The check is one line; the *vocabulary* is the point. Every consumer that
 * reads back an embedded path should produce the same three states and the same
 * volatility judgement, so a fix to one does not leave the others reporting the
 * old two-state lie.
 */
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * - `ok`      — a path is recorded and the file is there.
 * - `missing` — a path is recorded and the file is NOT there (dangling).
 * - `absent`  — nothing is recorded at all.
 */
export type EmbeddedPathState = 'ok' | 'missing' | 'absent';

export interface EmbeddedPathHealth {
    state: EmbeddedPathState;
    /** The path examined, or null when nothing was recorded. */
    referencedPath: string | null;
    /**
     * True when the recorded path lives somewhere the OS or a tool is entitled
     * to delete underneath us. Meaningful for `ok` too — that is a reference
     * that works *today* and is expected to dangle later.
     */
    volatile: boolean;
    /** Why `volatile` is true, for a message the user can act on. */
    volatileReason: string | null;
}

/**
 * Roots whose contents are disposable by design.
 *
 * `/private/tmp` is listed alongside `/tmp` because macOS resolves one to the
 * other, and the recorded string may be either depending on whether it was
 * realpath'd before being written.
 *
 * Worktree scratchpads are called out separately from the generic temp roots
 * because they are the case that actually bit us and because the reason text
 * ("the worktree is deleted when the task ends") is specific enough to be
 * actionable, where "it is under /tmp" is not.
 */
const VOLATILE_ROOT_PATTERNS: ReadonlyArray<{ test: (p: string) => boolean; reason: string }> = [
    {
        // `.../worktrees/<name>/.../scratchpad/...` — an agent worktree's
        // scratchpad, deleted with the worktree.
        test: (p) => /[/\\]worktrees[/\\][^/\\]+[/\\].*[/\\]scratchpad[/\\]/.test(p),
        reason: 'a worktree scratchpad, which is deleted when that worktree goes away',
    },
    {
        test: (p) => /^[/\\]private[/\\]tmp[/\\]|^[/\\]tmp[/\\]/.test(p),
        reason: 'a system temp directory, whose contents are reaped by the OS',
    },
    {
        test: (p) => /^[a-z]:\\+(users\\[^\\]+\\appdata\\local\\temp|windows\\temp)\\/i.test(p),
        reason: 'a system temp directory, whose contents are reaped by the OS',
    },
];

/** Normalize for comparison without resolving symlinks (the file may be gone). */
function normalize(candidate: string): string {
    return path.resolve(candidate);
}

/**
 * Is this path somewhere disposable?
 *
 * `$TMPDIR` is consulted in addition to the static patterns because on macOS it
 * points at a per-user `/var/folders/...` dir that matches none of them.
 */
export function classifyVolatilePath(
    candidate: string,
    env: NodeJS.ProcessEnv = process.env,
): { volatile: boolean; reason: string | null } {
    const resolved = normalize(candidate);
    for (const pattern of VOLATILE_ROOT_PATTERNS) {
        if (pattern.test(resolved)) {
            return { volatile: true, reason: pattern.reason };
        }
    }
    const tmpRoots = [env.TMPDIR, env.TEMP, env.TMP, os.tmpdir()];
    for (const root of tmpRoots) {
        const trimmed = root?.trim();
        if (!trimmed) continue;
        const normalizedRoot = normalize(trimmed);
        // Path-segment containment, not a bare prefix: `/tmpfoo` must not
        // count as being inside `/tmp`.
        if (resolved === normalizedRoot || resolved.startsWith(normalizedRoot + path.sep)) {
            return {
                volatile: true,
                reason: 'a system temp directory, whose contents are reaped by the OS',
            };
        }
    }
    return { volatile: false, reason: null };
}

/**
 * Inspect a path we previously embedded in a config file.
 *
 * `referencedPath` of null/empty means nothing was recorded → `absent`. A
 * recorded path that `stat` cannot reach → `missing`, including the case where
 * the entry names a directory where a file is expected: something is there, but
 * it is not the script we wrote, which is the same practical breakage.
 *
 * Never throws: an unreadable parent (EACCES) reports `missing` rather than
 * propagating, because a reference we cannot verify is one we must not claim is
 * healthy.
 */
export function inspectEmbeddedPath(
    referencedPath: string | null | undefined,
    env: NodeJS.ProcessEnv = process.env,
): EmbeddedPathHealth {
    const trimmed = typeof referencedPath === 'string' ? referencedPath.trim() : '';
    if (trimmed === '') {
        return { state: 'absent', referencedPath: null, volatile: false, volatileReason: null };
    }
    const { volatile, reason } = classifyVolatilePath(trimmed, env);
    let exists = false;
    try {
        exists = fs.statSync(trimmed).isFile();
    } catch {
        exists = false;
    }
    return {
        state: exists ? 'ok' : 'missing',
        referencedPath: trimmed,
        volatile,
        volatileReason: reason,
    };
}

/**
 * Pull the script path out of a shell command we generated.
 *
 * Our own writers emit `node "<abs path>"` (`buildWrapperCommand`), so the
 * quoted argument is recovered exactly, spaces and all. An unquoted trailing
 * token is accepted too, for a command a user hand-edited. Returns null when
 * the command is not of a shape we can read a path out of — the caller must
 * then treat the reference as unverifiable rather than as broken, since a
 * foreign command is none of our business.
 */
export function extractScriptPathFromCommand(command: string): string | null {
    const quoted = command.match(/"([^"]+)"|'([^']+)'/);
    if (quoted) {
        return (quoted[1] ?? quoted[2] ?? '').trim() || null;
    }
    // `node /abs/path/x.mjs` — take the last token that looks like a path.
    const tokens = command.trim().split(/\s+/);
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
        const token = tokens[i];
        if (token.includes('/') || token.includes('\\')) {
            return token;
        }
    }
    return null;
}
