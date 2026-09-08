/**
 * Containment for the `file_read` / `file_write` daemon commands.
 *
 * SECURITY: `file_read` / `file_write` are reachable from every command source
 * (ws / p2p / api / standalone — see `normalizeCommandSource` in commands/router.ts)
 * and, on the cloud daemon, straight off the P2P DataChannel file handler
 * (`packages/daemon-cloud/src/adhdev-daemon.ts` `p2p.onFileRequest`), where the
 * requested path is fully peer-controlled. Before this module the handlers used
 * `resolveSafePath()`, which — despite the name — only expanded `~`, normalized
 * Windows drive spellings and `path.resolve`d relatives. It performed no
 * containment at all, so `../../../tmp/evil` or a bare absolute path resolved
 * verbatim and `handleFileWrite` would `mkdirSync(recursive)` + `writeFileSync`
 * anywhere the daemon user can write.
 *
 * The confinement follows the pattern already established in this package:
 *   - `commands/handler.ts` "refusing to delete outside upstream root"
 *     (resolved-prefix + `path.sep` check), and
 *   - `commands/low-family/spec-providerdev.ts` (realpath the root and the
 *     target's parent, compare, then reject symlinked leaves).
 *
 * ## Allowed roots
 *
 * The roots are the user's own declared work areas, so legitimate use — reading
 * and writing files inside a workspace from the dashboard — keeps working:
 *   1. every saved workspace in `config.workspaces`,
 *   2. the configured default workspace, and
 *   3. `ADHDEV_FILE_ROOTS` (path-list, `path.delimiter`-separated) as an
 *      explicit operator escape hatch for setups whose work area is not a saved
 *      workspace.
 *
 * When no root is configured we fail CLOSED — an empty allow-list denies every
 * path rather than degrading to the old allow-everything behaviour.
 *
 * ## Not applied to `file_list` / `file_list_browse`
 *
 * Those two back the workspace *picker*, which is deliberately free-roaming: it
 * starts at `~` (or `C:\` on Windows), lets the user walk up to the filesystem
 * root and enumerates Windows drive letters, all so a workspace can be chosen
 * before it exists as a saved root. Confining them to the saved roots would make
 * adding the first workspace impossible. They expose directory metadata (names,
 * sizes) only — never file content and never a write — so they keep the previous
 * traversal behaviour by design.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../config/config.js';
import { expandPath, getDefaultWorkspacePath } from '../config/workspaces.js';

export type FileContainmentResult =
    | { ok: true; path: string }
    | { ok: false; error: string };

/** Env override: extra allowed roots, `path.delimiter`-separated. */
export const FILE_ROOTS_ENV = 'ADHDEV_FILE_ROOTS';

function realpathOrSelf(p: string): string {
    try {
        return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
    } catch {
        return p;
    }
}

/**
 * Path-segment containment, not a bare string prefix: `/home/user-evil` must not
 * count as inside `/home/user`. Case-insensitive on win32/darwin, where the
 * filesystem is case-insensitive and a cased spelling would otherwise bypass.
 */
function isWithinRoot(root: string, target: string): boolean {
    const rel = path.relative(root, target);
    if (rel === '') return true;
    if (path.isAbsolute(rel)) return false;
    if (rel === '..' || rel.startsWith(`..${path.sep}`)) return false;
    return true;
}

function normalizeForCompare(p: string): string {
    const resolved = path.resolve(p);
    return process.platform === 'win32' || process.platform === 'darwin'
        ? resolved.toLowerCase()
        : resolved;
}

/**
 * Collect the configured allow-list roots. Invalid/blank entries are dropped.
 * Returns resolved absolute paths (not realpath'd — that happens per-check so a
 * root that does not exist yet still participates once created).
 */
export function getAllowedFileRoots(): string[] {
    const roots: string[] = [];

    const fromEnv = process.env[FILE_ROOTS_ENV];
    if (typeof fromEnv === 'string' && fromEnv.trim()) {
        for (const raw of fromEnv.split(path.delimiter)) {
            const abs = expandPath(raw.trim());
            if (abs) roots.push(path.resolve(abs));
        }
    }

    try {
        const config = loadConfig();
        for (const w of config.workspaces || []) {
            const abs = expandPath(w?.path || '');
            if (abs) roots.push(path.resolve(abs));
        }
        const def = getDefaultWorkspacePath(config);
        if (def) roots.push(path.resolve(def));
    } catch {
        // Unreadable config → contribute no roots. Combined with the fail-closed
        // empty-list behaviour this denies rather than opens up.
    }

    // De-duplicate, preserving order.
    const seen = new Set<string>();
    return roots.filter((r) => {
        const key = normalizeForCompare(r);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Confine an already-resolved absolute path to the allowed roots.
 *
 * Checks the lexical path first, then re-checks after resolving symlinks on the
 * deepest existing ancestor, so a symlink planted inside a workspace cannot be
 * used to escape it. `extraRoots` lets a caller add a context root (e.g. the
 * active session's workspace) on top of the configured ones.
 */
export function confineToAllowedRoots(
    resolvedPath: string,
    extraRoots: string[] = [],
): FileContainmentResult {
    const roots = [
        ...extraRoots.map((r) => path.resolve(expandPath(r) || r)).filter(Boolean),
        ...getAllowedFileRoots(),
    ];

    if (roots.length === 0) {
        return {
            ok: false,
            error:
                'refusing file access: no allowed workspace root is configured. ' +
                `Add a workspace (workspace_add) or set ${FILE_ROOTS_ENV}.`,
        };
    }

    const target = path.resolve(resolvedPath);
    const lexicalOk = roots.some((root) =>
        isWithinRoot(normalizeForCompare(root), normalizeForCompare(target)),
    );
    if (!lexicalOk) {
        return { ok: false, error: `refusing file access outside allowed workspace roots: ${target}` };
    }

    // Symlink-aware re-check: resolve the deepest existing ancestor of the target
    // (the target itself may not exist yet, which is legal for file_write) and
    // require the real location to still be inside a real root.
    let existing = target;
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) break;
        existing = parent;
    }
    const realExisting = realpathOrSelf(existing);
    const realTarget = path.resolve(realExisting, path.relative(existing, target));
    const realOk = roots.some((root) =>
        isWithinRoot(normalizeForCompare(realpathOrSelf(root)), normalizeForCompare(realTarget)),
    );
    if (!realOk) {
        return {
            ok: false,
            error: `refusing file access outside allowed workspace roots (symlink target): ${target}`,
        };
    }

    return { ok: true, path: target };
}
