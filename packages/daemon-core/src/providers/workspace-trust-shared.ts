/**
 * Primitives every CLI workspace-trust writer shares (claude / codex / grok / kimi):
 * the workspace realpath the CLIs key their trust stores by, the over-broad-root
 * guard, and the TOML table-key helpers codex and grok stores need. Each
 * provider module keeps only what is genuinely provider-specific — its config
 * root, store path, and entry serialization.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Resolve the canonical, real (symlink-followed) absolute form of the workspace
 * path. Every CLI canonicalizes before keying its trust store — the entry written
 * on macOS for `/tmp/x` reads `/private/tmp/x` — so matching has to use the same
 * normalization. Falls back to the resolved path if the directory can't be stat'd
 * (e.g. it does not exist yet).
 */
export function realWorkspacePath(workingDir: string): string {
    try {
        return fs.realpathSync(workingDir);
    } catch {
        return path.resolve(workingDir);
    }
}

/**
 * Never record an over-broad root: a non-absolute path, the filesystem root, the
 * user's home, or (when given) the CLI's own config root — a grant there would
 * trust far more than the one directory being launched into. Mirrors grok's own
 * refusal of "an over-broad root (home, filesystem root, or non-absolute path)".
 */
export function isOverBroadTrustRoot(real: string, configRoot?: string): boolean {
    if (!path.isAbsolute(real)) return true;
    const normalized = real.replace(/\/+$/, '') || '/';
    if (normalized === '/' || path.dirname(normalized) === normalized) return true;
    const home = (() => {
        try {
            return fs.realpathSync(os.homedir());
        } catch {
            return os.homedir();
        }
    })();
    if (normalized === home.replace(/\/+$/, '')) return true;
    if (configRoot !== undefined && normalized === configRoot.replace(/\/+$/, '')) return true;
    return false;
}

/** TOML basic-string escaping for a path used as a `[table."…"]` key. */
export function escapeTomlKey(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Does the store already carry a `[<table>."<real>"]` table? Matches the header
 * line only — enough to stay idempotent without pulling in a TOML parser, and a
 * false negative merely rewrites an equivalent entry.
 *
 * ★Matching the HEADER rather than the trust value is deliberate: an existing
 * entry is never rewritten, which preserves a user's explicit non-trusted
 * decision instead of silently flipping it to trusted.
 */
export function hasTomlTrustTable(contents: string, table: string, real: string): boolean {
    const needle = `[${table}."${escapeTomlKey(real)}"]`;
    return contents.split(/\r?\n/).some((line) => line.trim() === needle);
}
