/**
 * LIGHT-TASK: `.adhdev/light-workspace.json` loader + validator.
 *
 * Strict by design: unknown keys are rejected so a typo never silently disables a
 * safety setting, and an invalid file refuses light tasks (LIGHT_REJECT.NOT_CONFIGURED).
 * A MISSING file is not a refusal (owner 2026-11-05: coordinators should not stop on
 * setup nobody performs): the repository's own declarations give the default — its
 * root `node_modules` and each `package.json` workspace's `node_modules` are linked,
 * nothing is copied. A repo that needs more writes the file.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const LIGHT_WORKSPACE_CONFIG_REL = path.join('.adhdev', 'light-workspace.json');
export const DEFAULT_LIGHT_MIN_FREE_BYTES = 2 * 1024 ** 3;

export interface LightWorkspaceConfig {
    version: 1;
    /** Override of the scratch base directory (absolute, or `~/`-prefixed). */
    baseDir?: string;
    /** Directories (repo-relative, one `*` segment allowed) whose node_modules entries are link-farmed. */
    linkNodeModules: string[];
    /** Directories (repo-relative, one `*` segment allowed) cloned (COW when possible) into the workspace. */
    copyDirs: string[];
    /** Directories excluded from `copyDirs` expansion (same pattern syntax). */
    copyExclude: string[];
    /** Directories created empty in the workspace. */
    freshDirs: string[];
    minFreeBytes: number;
}

export type LightWorkspaceConfigResult =
    | { ok: true; config: LightWorkspaceConfig; path: string; source: 'file' | 'default' }
    | { ok: false; reason: 'missing' | 'invalid'; message: string; path: string };

const KNOWN_KEYS = new Set(['version', 'baseDir', 'linkNodeModules', 'copyDirs', 'copyExclude', 'freshDirs', 'minFreeBytes']);

function relPatternList(raw: unknown, key: string, errors: string[]): string[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) { errors.push(`${key} must be an array`); return []; }
    const out: string[] = [];
    for (const item of raw) {
        if (typeof item !== 'string' || !item.trim()) { errors.push(`${key} entries must be non-empty strings`); continue; }
        const norm = item.trim().replace(/\\/g, '/').replace(/\/+$/, '');
        if (path.isAbsolute(norm) || norm.split('/').includes('..') || norm.startsWith('/')) {
            errors.push(`${key} entry must be repo-relative without '..': ${item}`);
            continue;
        }
        if ((norm.match(/\*/g) || []).length > 1 || norm.split('/').some(s => s.includes('*') && s !== '*')) {
            errors.push(`${key} entry allows at most one whole-segment '*': ${item}`);
            continue;
        }
        out.push(norm);
    }
    return out;
}

export function validateLightWorkspaceConfig(raw: unknown): { ok: true; config: LightWorkspaceConfig } | { ok: false; message: string } {
    const errors: string[] = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: 'light-workspace.json must be a JSON object' };
    const obj = raw as Record<string, unknown>;
    for (const key of Object.keys(obj)) if (!KNOWN_KEYS.has(key)) errors.push(`unknown key: ${key}`);
    if (obj.version !== 1) errors.push('version must be 1');
    let baseDir: string | undefined;
    if (obj.baseDir !== undefined) {
        if (typeof obj.baseDir !== 'string' || !obj.baseDir.trim()) errors.push('baseDir must be a non-empty string');
        else {
            const b = obj.baseDir.trim();
            baseDir = b === '~' ? os.homedir() : b.startsWith('~/') ? path.join(os.homedir(), b.slice(2)) : b;
            if (!path.isAbsolute(baseDir)) errors.push('baseDir must be absolute (or ~/-prefixed)');
        }
    }
    let minFreeBytes = DEFAULT_LIGHT_MIN_FREE_BYTES;
    if (obj.minFreeBytes !== undefined) {
        if (typeof obj.minFreeBytes !== 'number' || !Number.isFinite(obj.minFreeBytes) || obj.minFreeBytes < 0) errors.push('minFreeBytes must be a non-negative number');
        else minFreeBytes = obj.minFreeBytes;
    }
    const linkNodeModules = relPatternList(obj.linkNodeModules, 'linkNodeModules', errors);
    // An empty list is valid: a repo without node_modules (or any dependency dir) needs no link farm.
    const config: LightWorkspaceConfig = {
        version: 1,
        ...(baseDir ? { baseDir } : {}),
        linkNodeModules,
        copyDirs: relPatternList(obj.copyDirs, 'copyDirs', errors),
        copyExclude: relPatternList(obj.copyExclude, 'copyExclude', errors),
        freshDirs: relPatternList(obj.freshDirs, 'freshDirs', errors),
        minFreeBytes,
    };
    return errors.length ? { ok: false, message: errors.join('; ') } : { ok: true, config };
}

export function loadLightWorkspaceConfig(repoRoot: string): LightWorkspaceConfigResult {
    const file = path.join(repoRoot, LIGHT_WORKSPACE_CONFIG_REL);
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e: any) {
        if (e?.code !== 'ENOENT') return { ok: false, reason: 'invalid', message: `unreadable: ${e?.message || e}`, path: file };
        const derived = validateLightWorkspaceConfig(defaultLightWorkspaceConfig(repoRoot));
        return derived.ok
            ? { ok: true, config: derived.config, path: file, source: 'default' }
            : { ok: false, reason: 'missing', message: `${LIGHT_WORKSPACE_CONFIG_REL} not found and no default could be derived (${derived.message})`, path: file };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (e: any) { return { ok: false, reason: 'invalid', message: `invalid JSON: ${e?.message || e}`, path: file }; }
    const res = validateLightWorkspaceConfig(parsed);
    return res.ok ? { ok: true, config: res.config, path: file, source: 'file' } : { ok: false, reason: 'invalid', message: res.message, path: file };
}

/**
 * The config a repository without `.adhdev/light-workspace.json` gets: link the root
 * `node_modules` and `<workspace>/node_modules` for every `package.json` workspace
 * pattern that the loader accepts (repo-relative, at most one whole `*` segment).
 * Only what the repository itself declares; no guessing at build outputs.
 */
export function defaultLightWorkspaceConfig(repoRoot: string): Record<string, unknown> {
    const link: string[] = [];
    try { if (fs.statSync(path.join(repoRoot, 'node_modules')).isDirectory()) link.push('node_modules'); } catch { /* none */ }
    let workspaces: unknown;
    try { workspaces = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))?.workspaces; } catch { /* no manifest */ }
    const patterns = Array.isArray(workspaces) ? workspaces
        : workspaces && typeof workspaces === 'object' && Array.isArray((workspaces as { packages?: unknown }).packages) ? (workspaces as { packages: unknown[] }).packages : [];
    for (const raw of patterns) {
        if (typeof raw !== 'string') continue;
        const pattern = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
        if (!pattern || pattern.startsWith('!') || pattern.includes('**')) continue;
        const candidate = `${pattern}/node_modules`;
        const check: string[] = [];
        relPatternList([candidate], 'linkNodeModules', check);
        if (!check.length && !link.includes(candidate)) link.push(candidate);
    }
    return { version: 1, linkNodeModules: link };
}

/** Expand a repo-relative pattern with at most one `*` segment against the filesystem (directories only). */
export function expandRepoPattern(root: string, pattern: string): string[] {
    const segs = pattern.split('/');
    const star = segs.indexOf('*');
    if (star < 0) return [pattern];
    const parent = path.join(root, ...segs.slice(0, star));
    let names: string[];
    try { names = fs.readdirSync(parent, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch { return []; }
    return names.map(n => [...segs.slice(0, star), n, ...segs.slice(star + 1)].join('/'));
}
