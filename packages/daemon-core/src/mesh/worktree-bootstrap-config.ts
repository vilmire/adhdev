import { existsSync, readFileSync } from 'fs';
import { join, resolve as pathResolve } from 'path';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import * as yaml from 'js-yaml';
import { resolveWin32Executable, buildWin32ExecFileSpawn } from '../cli-adapters/resolve-executable.js';
import {
    isMeshConfigRecord,
    normalizeMeshCommandConfig,
    type MeshRefineValidationCommandPlan,
    type RepoMeshRefineValidationCommandConfig,
} from './refine-config.js';
import type { MeshAsyncJobLifecycle } from '../repo-mesh-types.js';

// 'complete' is the terminal status the coordinator's markWorktreeBootstrapTerminalState
// (router.ts) stamps when the worktree_bootstrap_complete event fires — distinct from
// 'ready' (which carries a staleInputs digest from an in-process run). It is terminal and
// must be recognized as such by evaluateWorktreeBootstrapState so a later re-hydration never
// round-trips it back to 'stale'/'never_ran'.
export type WorktreeBootstrapStatus = 'ready' | 'complete' | 'running' | 'failed' | 'not_configured' | 'disabled' | 'stale';

export interface RepoMeshWorktreeBootstrapConfig {
    version: 1;
    enabled?: boolean;
    runOnClone?: boolean;
    required?: boolean;
    commands?: RepoMeshRefineValidationCommandConfig[];
    staleInputs?: string[];
}

export interface WorktreeBootstrapState extends MeshAsyncJobLifecycle {
    status: WorktreeBootstrapStatus;
    required: boolean;
    configSource?: string;
    configSourceType?: 'repo_file' | 'mesh_policy' | 'unavailable' | 'invalid';
    lastCommand?: string;
    exitCode?: number | null;
    commandsRun?: Array<Record<string, unknown>>;
    staleInputs?: string[];
    /**
     * M2-1: sha256 per staleInputs path recorded when the bootstrap reached
     * 'ready'. evaluateWorktreeBootstrapState compares current file hashes
     * against this to detect staleness (e.g. base merge changed a lockfile).
     * Missing files hash to the literal 'absent'.
     */
    staleInputsDigest?: Record<string, string>;
    /** M2-1: why an evaluated state resolved to stale (digest_mismatch | never_ran). */
    staleReason?: string;
}

// Fix (3) safety net: a worktree node whose bootstrap state is stuck 'running' far longer than
// any real bootstrap (observed ~2m8s) is almost certainly one whose terminal-state stamp never
// reached this daemon's mesh view — the claim/dispatch defer guards would otherwise gate it
// forever. This backstop lets a dispatch through ONLY when BOTH hold: the 'running' state is
// older than WORKTREE_BOOTSTRAP_STALE_RUNNING_MS AND the node's working tree is git-clean. The
// clean co-requirement is the real guard — a genuinely in-progress bootstrap (npm install /
// native-addon repair) leaves the tree mid-build, so a clean tree means the bootstrap work has
// settled. The threshold is floored well above the observed real bootstrap so a slow-but-live
// bootstrap is never downgraded. Conservative by design: when clean-ness cannot be verified (no
// local workspace on disk, or git errors) it returns false and the gate stays closed.
export const WORKTREE_BOOTSTRAP_STALE_RUNNING_MS = 10 * 60 * 1000;

/**
 * Enumerate registered submodule paths for a worktree, generically (no hardcoded
 * 'oss'/'adhdev-providers'). Reads `.gitmodules` via `git config --file .gitmodules
 * --get-regexp path`, whose lines are `submodule.<name>.path <relativePath>`. Paths
 * are returned normalized to forward slashes (git porcelain always emits '/'),
 * trailing slash stripped. Returns an empty set when there are no submodules or the
 * lookup fails — callers must then treat any change as dirty (conservative).
 */
function getRegisteredSubmodulePaths(workspace: string): Set<string> {
    const paths = new Set<string>();
    try {
        const out = execFileSync(
            resolveWin32Executable('git'),
            ['config', '--file', '.gitmodules', '--get-regexp', 'path'],
            { cwd: workspace, encoding: 'utf8', timeout: 10_000, windowsHide: true },
        );
        for (const line of String(out).split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            // `submodule.<name>.path <relativePath>` — value is everything after the first space.
            const spaceIdx = trimmed.indexOf(' ');
            if (spaceIdx < 0) continue;
            const value = trimmed.slice(spaceIdx + 1).trim().replace(/\\/g, '/').replace(/\/+$/, '');
            if (value) paths.add(value);
        }
    } catch {
        // No .gitmodules / not a submodule superproject / git error → no exemptions.
    }
    return paths;
}

/**
 * True when `git status --porcelain` output represents a worktree that is clean
 * EXCEPT for submodule-gitlink-pointer moves. A worktree task that commits inside a
 * registered submodule (e.g. oss/) leaves the superproject's gitlink outOfSync — a
 * porcelain line of exactly " M <submodulePath>" (or "M  <submodulePath>") — which is
 * a NORMAL product of that task and must NOT disqualify the stale backstop. Any other
 * line (a real file edit, an untracked file, a staged add, an unmerged path) means the
 * tree is genuinely dirty → not clean. We filter gitlink lines explicitly rather than
 * using `git status --ignore-submodules=all`, which would also mask a submodule with
 * genuinely-uncommitted *content* (=dirty still surfaces pointer moves we want to ignore;
 * =all would over-suppress).
 */
function isCleanIgnoringSubmoduleGitlinks(porcelain: string, submodulePaths: Set<string>): boolean {
    const lines = porcelain.split(/\r?\n/).filter(line => line.length > 0);
    for (const line of lines) {
        // Porcelain v1 line: two status chars (XY) + space + path. A submodule gitlink
        // pointer move shows X or Y as 'M' with the other position a space, e.g.
        // " M oss" (worktree-modified) or "M  oss" (index-modified). Quoted paths
        // (core.quotePath) wrap in double-quotes — those never match a bare submodule path,
        // so they correctly fall through as dirty.
        const status = line.slice(0, 2);
        const path = line.slice(3).trim().replace(/\\/g, '/').replace(/\/+$/, '');
        const isGitlinkPointerMove = (status === ' M' || status === 'M ') && submodulePaths.has(path);
        if (!isGitlinkPointerMove) return false; // any non-gitlink change → dirty
    }
    return true;
}

export function isWorktreeBootstrapStaleRunning(
    node: { worktreeBootstrap?: { status?: string; startedAt?: string; updatedAt?: string; completedAt?: string }; workspace?: string } | undefined,
    nowMs: number = Date.now(),
): boolean {
    const wb = node?.worktreeBootstrap;
    if (!wb || wb.status !== 'running') return false;
    const startedRaw = wb.updatedAt || wb.startedAt;
    if (!startedRaw) return false;
    const startedMs = Date.parse(startedRaw);
    if (!Number.isFinite(startedMs)) return false;
    if (nowMs - startedMs <= WORKTREE_BOOTSTRAP_STALE_RUNNING_MS) return false;
    const workspace = typeof node?.workspace === 'string' ? node.workspace.trim() : '';
    if (!workspace || !existsSync(workspace)) return false; // only verifiable for a local workspace
    try {
        const out = execFileSync(resolveWin32Executable('git'), ['status', '--porcelain'], {
            cwd: workspace,
            encoding: 'utf8',
            timeout: 10_000,
            windowsHide: true,
        });
        const porcelain = String(out).replace(/\r?\n$/, '');
        if (porcelain.trim() === '') return true; // truly clean
        // A worktree task that committed inside a submodule leaves the superproject's
        // submodule-gitlink pointer outOfSync (" M oss"); that is the normal aftermath of the
        // task this backstop exists to unstick, not an in-progress bootstrap, so a tree dirty
        // ONLY by gitlink pointer moves still counts as clean here.
        const submodulePaths = getRegisteredSubmodulePaths(workspace);
        if (submodulePaths.size === 0) return false; // no submodules → no exemption, dirty
        return isCleanIgnoringSubmoduleGitlinks(porcelain, submodulePaths);
    } catch {
        return false; // cannot verify clean → stay conservative (gate remains closed)
    }
}

export interface WorktreeBootstrapConfigLoadResult {
    config?: RepoMeshWorktreeBootstrapConfig;
    source: string;
    sourceType: 'repo_file' | 'mesh_policy' | 'unavailable' | 'invalid';
    path?: string;
    error?: string;
}

export const MESH_WORKTREE_BOOTSTRAP_CONFIG_LOCATIONS = [
    '.adhdev/worktree_bootstrap.json',
    '.adhdev/worktree_bootstrap.yaml',
    '.adhdev/worktree_bootstrap.yml',
    '.adhdev/worktree-bootstrap.json',
    '.adhdev/worktree-bootstrap.yaml',
    '.adhdev/worktree-bootstrap.yml',
];

export const MESH_WORKTREE_BOOTSTRAP_CONFIG_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'ADHDev Repo Mesh Worktree Bootstrap Config',
    type: 'object',
    additionalProperties: false,
    required: ['version'],
    properties: {
        version: { const: 1 },
        enabled: { type: 'boolean', default: true },
        runOnClone: { type: 'boolean', default: true },
        required: { type: 'boolean', default: true },
        staleInputs: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1 } },
        commands: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['command'],
                properties: {
                    command: { type: 'string', minLength: 1 },
                    args: { type: 'array', items: { type: 'string' } },
                    category: { enum: ['typecheck', 'test', 'lint', 'build', 'custom'] },
                    cwd: { type: 'string' },
                    timeoutMs: { type: 'number', minimum: 1000, maximum: 600000 },
                    outputLimitBytes: { type: 'number', minimum: 1024, maximum: 1048576 },
                    env: { type: 'object', additionalProperties: { type: 'string' } },
                },
            },
        },
    },
} as const;

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 128 * 1024;
const OUTPUT_SUMMARY_CHARS = 2_000;

function parseConfigText(path: string, text: string): unknown {
    if (/\.json$/i.test(path)) return JSON.parse(text);
    return yaml.load(text);
}

function truncateOutput(value: unknown): string {
    const text = typeof value === 'string' ? value : value == null ? '' : String(value);
    if (text.length <= OUTPUT_SUMMARY_CHARS) return text;
    return `${text.slice(0, OUTPUT_SUMMARY_CHARS)}\n[truncated ${text.length - OUTPUT_SUMMARY_CHARS} chars]`;
}

export function validateMeshWorktreeBootstrapConfig(config: unknown, source = 'inline'): {
    valid: boolean;
    errors: string[];
    commands: MeshRefineValidationCommandPlan[];
    rejectedCommands: Array<Record<string, unknown>>;
} {
    const errors: string[] = [];
    const commands: MeshRefineValidationCommandPlan[] = [];
    const rejectedCommands: Array<Record<string, unknown>> = [];
    if (!isMeshConfigRecord(config)) return { valid: false, errors: ['config must be an object'], commands, rejectedCommands };
    if (config.version !== 1) errors.push('version must be 1');
    if (config.enabled !== undefined && typeof config.enabled !== 'boolean') errors.push('enabled must be a boolean when provided');
    if (config.runOnClone !== undefined && typeof config.runOnClone !== 'boolean') errors.push('runOnClone must be a boolean when provided');
    if (config.required !== undefined && typeof config.required !== 'boolean') errors.push('required must be a boolean when provided');
    if (config.staleInputs !== undefined && (!Array.isArray(config.staleInputs) || !config.staleInputs.every(input => typeof input === 'string' && input.trim()))) {
        errors.push('staleInputs must be an array of non-empty strings when provided');
    }
    if (config.commands !== undefined && !Array.isArray(config.commands)) errors.push('commands must be an array');
    if (Array.isArray(config.commands)) {
        config.commands.forEach((entry, index) => {
            const normalized = normalizeMeshCommandConfig(entry, `${source}:commands[${index}]`);
            if (normalized.command) commands.push(normalized.command);
            if (normalized.rejected) rejectedCommands.push(normalized.rejected);
        });
    }
    if (config.enabled !== false && config.runOnClone !== false && commands.length === 0) errors.push('commands must contain at least one command when bootstrap is enabled');
    if (rejectedCommands.length) errors.push('one or more bootstrap commands are invalid');
    return { valid: errors.length === 0, errors, commands, rejectedCommands };
}

export function loadMeshWorktreeBootstrapConfig(mesh: any, workspace: string): WorktreeBootstrapConfigLoadResult {
    const inline = mesh?.worktreeBootstrapConfig || mesh?.policy?.worktreeBootstrapConfig || mesh?.policy?.worktreeBootstrap;
    if (inline !== undefined) {
        const validation = validateMeshWorktreeBootstrapConfig(inline, 'mesh.policy.worktreeBootstrapConfig');
        if (!validation.valid) return { source: 'mesh.policy.worktreeBootstrapConfig', sourceType: 'invalid', error: String(validation.rejectedCommands[0]?.reason || validation.errors.join('; ')) };
        return { config: inline as RepoMeshWorktreeBootstrapConfig, source: 'mesh.policy.worktreeBootstrapConfig', sourceType: 'mesh_policy' };
    }
    for (const relative of MESH_WORKTREE_BOOTSTRAP_CONFIG_LOCATIONS) {
        const configPath = join(workspace, relative);
        if (!existsSync(configPath)) continue;
        try {
            const parsed = parseConfigText(configPath, readFileSync(configPath, 'utf-8'));
            const validation = validateMeshWorktreeBootstrapConfig(parsed, relative);
            if (!validation.valid) return { source: relative, sourceType: 'invalid', path: configPath, error: String(validation.rejectedCommands[0]?.reason || validation.errors.join('; ')) };
            return { config: parsed as RepoMeshWorktreeBootstrapConfig, source: relative, sourceType: 'repo_file', path: configPath };
        } catch (error: any) {
            return { source: relative, sourceType: 'invalid', path: configPath, error: error?.message || String(error) };
        }
    }
    return { source: 'unavailable', sourceType: 'unavailable', error: `No worktree bootstrap config found. Checked: ${MESH_WORKTREE_BOOTSTRAP_CONFIG_LOCATIONS.join(', ')}` };
}

/** M2-1: hash staleInputs files so 'ready' can be invalidated when they change. */
export function computeStaleInputsDigest(workspace: string, staleInputs: string[] | undefined): Record<string, string> {
    const digest: Record<string, string> = {};
    for (const relative of staleInputs ?? []) {
        const filePath = join(workspace, relative);
        try {
            digest[relative] = createHash('sha256').update(readFileSync(filePath)).digest('hex');
        } catch {
            digest[relative] = 'absent';
        }
    }
    return digest;
}

/**
 * M2-1: the official bootstrap state contract. Resolves the effective state
 * for a node workspace from config presence + the persisted last-run state +
 * a staleInputs digest comparison. Read-only — never runs commands.
 *
 *   ready          — last run succeeded and staleInputs are unchanged
 *   stale          — never ran, or a staleInputs file changed since 'ready'
 *   running/failed — persisted lifecycle state passes through
 *   not_configured / disabled / (invalid → failed) — from config resolution
 */
export function evaluateWorktreeBootstrapState(mesh: any, workspace: string, persisted?: WorktreeBootstrapState | null): WorktreeBootstrapState {
    const loaded = loadMeshWorktreeBootstrapConfig(mesh, workspace);
    if (!loaded.config) {
        return { status: 'not_configured', required: false, configSource: loaded.source, configSourceType: loaded.sourceType, error: loaded.error };
    }
    const required = loaded.config.required !== false;
    if (loaded.config.enabled === false || loaded.config.runOnClone === false) {
        return { status: 'disabled', required, configSource: loaded.path || loaded.source, configSourceType: loaded.sourceType };
    }
    if (loaded.sourceType === 'invalid') {
        return { status: 'failed', required, configSource: loaded.path || loaded.source, configSourceType: 'invalid', error: loaded.error };
    }
    if (persisted?.status === 'running') return { ...persisted, required };
    if (persisted?.status === 'failed') return { ...persisted, required };
    // 'complete' is the terminal stamp written by markWorktreeBootstrapTerminalState
    // (router.ts) on the worktree_bootstrap_complete event. Pass it through unchanged so a
    // later getMeshWithCache re-hydration never re-derives it back to 'stale'/'never_ran' —
    // doing so would reopen the dispatch/claim gate against a node whose bootstrap is done.
    if (persisted?.status === 'complete') return { ...persisted, required };
    if (persisted?.status === 'ready') {
        const staleInputs = loaded.config.staleInputs ?? persisted.staleInputs ?? [];
        if (staleInputs.length > 0 && persisted.staleInputsDigest) {
            const current = computeStaleInputsDigest(workspace, staleInputs);
            const changed = staleInputs.filter(p => current[p] !== persisted.staleInputsDigest![p]);
            if (changed.length > 0) {
                return {
                    ...persisted,
                    status: 'stale',
                    required,
                    staleReason: `digest_mismatch: ${changed.join(', ')}`,
                };
            }
        }
        return { ...persisted, required };
    }
    return {
        status: 'stale',
        required,
        configSource: loaded.path || loaded.source,
        configSourceType: loaded.sourceType,
        staleInputs: loaded.config.staleInputs,
        staleReason: 'never_ran',
    };
}

export async function runMeshWorktreeBootstrap(mesh: any, workspace: string): Promise<WorktreeBootstrapState> {
    const loaded = loadMeshWorktreeBootstrapConfig(mesh, workspace);
    if (!loaded.config) {
        return { status: 'not_configured', required: false, configSource: loaded.source, configSourceType: loaded.sourceType, error: loaded.error };
    }
    const required = loaded.config.required !== false;
    if (loaded.config.enabled === false || loaded.config.runOnClone === false) {
        return { status: 'disabled', required, configSource: loaded.path || loaded.source, configSourceType: loaded.sourceType };
    }
    const validation = validateMeshWorktreeBootstrapConfig(loaded.config, loaded.source);
    if (!validation.valid) {
        return { status: 'failed', required, configSource: loaded.path || loaded.source, configSourceType: 'invalid', error: String(validation.rejectedCommands[0]?.reason || validation.errors.join('; ')), commandsRun: [] };
    }

    const execFileAsync = promisify(execFile);
    const state: WorktreeBootstrapState = {
        status: 'running',
        required,
        configSource: loaded.path || loaded.source,
        configSourceType: loaded.sourceType,
        startedAt: new Date().toISOString(),
        commandsRun: [],
        staleInputs: loaded.config.staleInputs,
    };
    const staleInputPaths = loaded.config.staleInputs ?? [];
    // Snapshot which staleInputs files are absent at bootstrap start.
    // Files already present before we start are not interference signals.
    const initiallyAbsent = staleInputPaths.filter(p => !existsSync(join(workspace, p)));
    for (const command of validation.commands) {
        // Check if any initially-absent staleInputs files appeared since bootstrap started
        // (indicates another process modified the environment mid-run).
        if (initiallyAbsent.length > 0) {
            const appearedNow = initiallyAbsent.filter(p => existsSync(join(workspace, p)));
            if (appearedNow.length > 0) {
                state.status = 'stale';
                state.completedAt = new Date().toISOString();
                state.error = `Bootstrap interrupted: staleInputs files appeared during run: ${appearedNow.join(', ')}`;
                return state;
            }
        }
        const cwd = command.cwd ? pathResolve(workspace, command.cwd) : workspace;
        const startedAt = Date.now();
        state.lastCommand = command.displayCommand;
        // On win32 a bare npm/npx/tsc is a .cmd shim that libuv's spawn search
        // (which appends only .com/.exe) cannot resolve → spawn ENOENT. Resolve
        // to an absolute path first (no-op on non-win32 / already-absolute).
        const resolvedCommand = resolveWin32Executable(command.command);
        // A win32 .cmd/.bat shim (npm/npx/tsc) cannot be exec'd directly — wrap
        // it in cmd.exe /c (no-op off win32 / for a real .exe).
        const spawn = buildWin32ExecFileSpawn(resolvedCommand, command.args);
        try {
            const result = await execFileAsync(spawn.file, spawn.args, {
                cwd,
                encoding: 'utf8',
                timeout: command.timeoutMs || DEFAULT_TIMEOUT_MS,
                maxBuffer: command.outputLimitBytes || DEFAULT_OUTPUT_LIMIT_BYTES,
                env: { ...process.env, CI: process.env.CI || '1', ...(command.env || {}) },
                windowsHide: true,
                ...(spawn.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
            });
            state.commandsRun?.push({
                command: command.command,
                args: command.args,
                displayCommand: command.displayCommand,
                category: command.category,
                source: command.source,
                cwd,
                passed: true,
                durationMs: Date.now() - startedAt,
                exitCode: 0,
                stdout: truncateOutput(result.stdout),
                stderr: truncateOutput(result.stderr),
            });
        } catch (error: any) {
            const exitCode = typeof error?.code === 'number' ? error.code : null;
            state.status = 'failed';
            state.exitCode = exitCode;
            state.error = error?.message || String(error);
            state.completedAt = new Date().toISOString();
            state.commandsRun?.push({
                command: command.command,
                args: command.args,
                displayCommand: command.displayCommand,
                category: command.category,
                source: command.source,
                cwd,
                passed: false,
                durationMs: Date.now() - startedAt,
                exitCode,
                signal: typeof error?.signal === 'string' ? error.signal : null,
                timedOut: error?.killed === true || /timed out/i.test(String(error?.message || '')),
                stdout: truncateOutput(error?.stdout),
                stderr: truncateOutput(error?.stderr || error?.message),
            });
            return state;
        }
    }
    state.status = 'ready';
    state.exitCode = 0;
    state.completedAt = new Date().toISOString();
    // M2-1: record staleInputs hashes so evaluateWorktreeBootstrapState can
    // invalidate this 'ready' when an input (e.g. lockfile) changes later.
    if (staleInputPaths.length > 0) {
        state.staleInputsDigest = computeStaleInputsDigest(workspace, staleInputPaths);
    }
    return state;
}
