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
import { execFileSync } from 'node:child_process';

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
 * Grok keys linked-worktree trust by the main repository, not the worktree.
 * Git discovery is only a candidate: an exact owner-registered root must
 * independently authorize it. A worktree/.git file is never authorization.
 */
export function registeredGrokRepoRoot(workingDir: string, registeredRoots: readonly string[]): string | null {
    if (!registeredRoots.length) return null;
    try {
        const gitPath = (flag: string) => execFileSync('git', ['-C', workingDir, 'rev-parse', flag], {
            encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const top = realWorkspacePath(gitPath('--show-toplevel'));
        const common = realWorkspacePath(path.resolve(workingDir, gitPath('--git-common-dir')));
        const candidates = [top];
        // Standard main/linked worktrees share <main>/.git. Other layouts
        // (bare repos, submodules, --separate-git-dir) need explicit evidence;
        // never assume the metadata directory's parent is a repository root.
        if (path.basename(common) === '.git') candidates.push(realWorkspacePath(path.dirname(common)));
        const registered = new Set(registeredRoots.filter(path.isAbsolute).map(realWorkspacePath));
        return candidates.reverse().find(candidate => registered.has(candidate) && !isOverBroadTrustRoot(candidate)) || null;
    } catch {
        return null;
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
    const trimSlashes = (p: string) => p.replace(/\/+$/, '') || '/';
    const canonicalForms = (p: string): string[] => {
        const raw = trimSlashes(p);
        try {
            const resolved = trimSlashes(fs.realpathSync(raw));
            return resolved === raw ? [raw] : [raw, resolved];
        } catch {
            return [raw];
        }
    };
    const candidateForms = canonicalForms(real);
    if (candidateForms.some((c) => c === '/' || path.dirname(c) === c)) return true;
    const homeForms = canonicalForms(os.homedir());
    if (candidateForms.some((c) => homeForms.includes(c))) return true;
    if (configRoot !== undefined) {
        const configForms = canonicalForms(configRoot);
        if (candidateForms.some((c) => configForms.includes(c))) return true;
    }
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
